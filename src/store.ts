import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import { normaliseLanguage, parseMarkdown, type ParsedDoc } from './markdown';

export type Library = {
  id: string;
  source: string;
  sha?: string;
  /** GitHub `owner/name`, when the docs live in a GitHub repo. Lets access follow GitHub's own permissions. */
  repo?: string;
  /** The glob the library was added with, so `sync` and `--watch` re-index exactly the same files. */
  include?: string;
  /** Prefix that turns a doc path into a link a human can open, e.g. a GitHub blob URL. */
  urlBase?: string;
};

export type SearchHit = {
  library: string;
  path: string;
  title: string;
  breadcrumb: string;
  heading: string;
  line: number;
  snippet: string;
  /** The git commit the library was indexed at, for a citation that still resolves after the docs change. */
  commit?: string;
  /** The document's content at search time. read_doc refuses a line from an older revision. */
  revision: string;
  url?: string;
  score: number;
  /** Fraction of the question's terms this section contains, 0–1. */
  coverage: number;
};

/**
 * Which libraries a caller may see. Every read takes one, so there is no way to
 * query the index without saying who for. `'all'` is for stdio, where the OS
 * account is already the boundary, and for the admin CLI.
 *
 * An entry with `repo` also pins the repo the caller was checked against: if the library is
 * re-indexed from another repo after that check, it drops out of scope instead of inheriting it.
 * Without `repo`, the id alone decides.
 */
export type Scope = readonly { id: string; repo?: string | null }[] | 'all';

/** SQL fragment + params restricting the library `id`/`repo` columns (qualified: json_each has an `id` of its own) to the scope, applied inside the query, before ranking. */
const inScope = (id: string, repo: string, scope: Scope) =>
  [
    `(? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) s WHERE s.value ->> 'id' = ${id}
       AND (json_type(s.value, '$.repo') IS NULL OR s.value ->> 'repo' IS ${repo})))`,
    ...scopeParams(scope),
  ] as const;

const scopeParams = (scope: Scope) => {
  const json = scope === 'all' ? null : JSON.stringify(scope);

  return [json, json] as const;
};

export type AuditEvent = {
  principal: string;
  agent?: string;
  tool: string;
  query: string;
  library?: string;
  /** The library ids in the caller's scope. */
  allowed: readonly string[] | 'all';
  returned: string[];
  /** search_docs only: did any hit cover most of the question? */
  answered?: boolean;
  ms: number;
};

/**
 * The index format. Bump it with a step in `migrate` whenever stored data changes shape or meaning;
 * an index from any earlier version is upgraded when opened, one from a later version is refused.
 *
 *   0  before versioning (four table layouts, 2026-09): one shared `sections` table
 *   5  one FTS table per library (`fts_<n>`), so a library's statistics and size never touch another's
 *   6  `docs.rev` (content hash, so a stale line is refused) and `docs.url` (a page's own address)
 */
export const SCHEMA_VERSION = 6;

export type StoreOptions = {
  /**
   * Delete audit entries older than this many days. Queries can contain whatever people paste
   * (tokens, customer names), so keep them no longer than you need them. `0` records no audit at all.
   * Omit to keep everything.
   */
  auditRetentionDays?: number;
  /**
   * Record audit entries here instead of in the index: a runtime whose disk doesn't outlive it
   * (Lambda) sends them to its logs. Retention is then the log's; `auditRetentionDays: 0` still records none.
   */
  auditSink?: (entry: AuditEvent & { at: string }) => void;
};

/** Turn "no such module: fts5" into what to do about it; anything else passes through. */
export function explainSqliteError<E>(cause: E): E | Error {
  if (!/no such module: fts5/i.test(String(cause))) return cause;

  return new Error(
    'This build of Node has SQLite without FTS5, which askdocs needs. Install the official Node.js 24 or newer from https://nodejs.org (not a distro build linked against a system SQLite).',
    { cause },
  );
}

/**
 * The SQLite connection askdocs reads and writes through: node:sqlite's DatabaseSync, or anything
 * with the same members, such as a Durable Object's SQL storage (see askdocs/cloudflare).
 */
export type Database = Pick<DatabaseSync, 'exec' | 'isTransaction'> & {
  prepare: (sql: string) => Statement;
};

/** What askdocs binds (text, numbers, null and bytes) and what it reads back. */
type SqlParam = string | number | null | Uint8Array;

type Statement = {
  all: (...params: SqlParam[]) => Record<string, SQLOutputValue>[];
  get: (...params: SqlParam[]) => Record<string, SQLOutputValue> | undefined;
  run: (...params: SqlParam[]) => { changes: number | bigint };
};

const settings = new WeakMap<Database, StoreOptions>();

/** Every table an index at SCHEMA_VERSION has, besides one FTS table per library. */
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, sha TEXT, repo TEXT, url_base TEXT, include TEXT,
      files INTEGER NOT NULL, sections INTEGER NOT NULL, indexed_at TEXT NOT NULL, fts INTEGER
    );
    CREATE TABLE IF NOT EXISTS docs (
      library TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, rev TEXT, url TEXT,
      PRIMARY KEY (library, path)
    );
    CREATE TABLE IF NOT EXISTS audit (
      at TEXT NOT NULL, principal TEXT NOT NULL, agent TEXT, tool TEXT NOT NULL, query TEXT NOT NULL,
      library TEXT, allowed TEXT NOT NULL, returned TEXT NOT NULL, results INTEGER NOT NULL, ms REAL NOT NULL,
      answered INTEGER
    );
    CREATE TABLE IF NOT EXISTS vectors (
      library TEXT NOT NULL, fts INTEGER NOT NULL, section INTEGER NOT NULL, piece INTEGER NOT NULL,
      path TEXT NOT NULL, line INTEGER NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY (library, model, fts, section, piece)
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
`;

export function openStore(file = ':memory:', options: StoreOptions = {}): DatabaseSync {
  let db: DatabaseSync;

  try {
    // Loaded here, not imported: runtimes without node:sqlite (Cloudflare Workers) can still use
    // everything else in this module over their own SQLite.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);
    db.exec(`CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;`);
  } catch (error) {
    throw explainSqliteError(error);
  }

  db.exec(SCHEMA);
  migrate(db);
  dropUnusedSectionsTables(db);
  settings.set(db, options);
  pruneAudit(db);

  return db;
}

/**
 * Use a connection opened elsewhere, such as a Durable Object's SQL storage, as an index. Its
 * contents are expected at SCHEMA_VERSION, as `importIndex` writes them: there is no migration.
 */
export function attachStore(db: Database, options: StoreOptions = {}): Database {
  db.exec(SCHEMA);
  settings.set(db, options);
  pruneAudit(db);

  return db;
}

/** A value as JSON carries it: blobs (vectors) as base64, decoded back to bytes on parsing. */
const Cell = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.object({ base64: z.string() }).transform((blob) => Buffer.from(blob.base64, 'base64')),
]);

const IndexDumpSchema = z.object({
  format: z.number(),
  tables: z.array(
    z.object({
      table: z.string(),
      create: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(Cell)),
    }),
  ),
});

/** An index as rows, to be loaded elsewhere with `importIndex`. The audit log stays behind. */
export type IndexDump = z.input<typeof IndexDumpSchema>;

/** A dump as received (usually over the network), checked and with its blobs decoded. */
export const parseIndexDump = (json: string) => IndexDumpSchema.parse(JSON.parse(json));

const toCell = (value: SQLOutputValue | undefined) =>
  value instanceof Uint8Array
    ? { base64: Buffer.from(value).toString('base64') }
    : z.union([z.string(), z.number(), z.null()]).parse(value ?? null);

/**
 * The index as plain rows: its tables as they are, and each library's FTS table from its content,
 * with rowids kept (vectors refer to sections by rowid). FTS5 rebuilds its own index on import.
 */
export function exportIndex(db: Database): IndexDump {
  // SAFETY: sqlite_master's name and sql are TEXT; `sql IS NOT NULL` excludes internal tables.
  const tables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL
       AND (name IN ('libraries', 'docs', 'vectors') OR (name GLOB 'fts_[0-9]*' AND name NOT GLOB 'fts_*_*'))`,
    )
    .all() as { name: string; sql: string }[];

  return {
    format: SCHEMA_VERSION,
    tables: tables.map(({ name, sql }) => {
      // SAFETY: pragma_table_info's name is TEXT.
      const declared = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[];
      const columns = [...(/VIRTUAL TABLE/i.test(sql) ? ['rowid'] : []), ...declared.map((c) => c.name)];

      const rows = db
        .prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${name}"`)
        .all()
        .map((row) => columns.map((c) => toCell(row[c])));

      return { table: name, create: sql, columns, rows };
    }),
  };
}

/**
 * Replace this index's libraries with a dump's, in one transaction: readers see the old index or
 * the new one, never a mix. The audit log is kept, and so are vectors for reuse (see below). `transaction` defaults to BEGIN/COMMIT; pass the
 * host's own where it forbids those (a Durable Object's `transactionSync`).
 */
export function importIndex(
  db: Database,
  dump: ReturnType<typeof parseIndexDump>,
  transaction: (write: () => void) => void = (write) => {
    db.exec('BEGIN IMMEDIATE');

    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
) {
  if (dump.format !== SCHEMA_VERSION) {
    throw new Error(
      `This index was exported in format ${dump.format}; this askdocs reads format ${SCHEMA_VERSION}. Publish it with the same askdocs version that serves it.`,
    );
  }

  transaction(() => {
    // SAFETY: sqlite_master's name is TEXT.
    const current = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND (name IN ('libraries', 'docs') OR (name GLOB 'fts_[0-9]*' AND name NOT GLOB 'fts_*_*'))`,
      )
      .all() as { name: string }[];

    for (const { name } of current) db.exec(`DROP TABLE "${name}"`);

    const insertAll = ({ table, columns, rows }: (typeof dump.tables)[number]) => {
      const insert = db.prepare(
        `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );

      for (const row of rows) insert.run(...row);
    };

    for (const table of dump.tables.filter((d) => d.table !== 'vectors')) {
      db.exec(table.create);
      insertAll(table);
    }

    // Vectors are kept for reuse: embedding the new index reuses every one whose section text is
    // unchanged. They move to generation -1, which no index has, because a new index numbers its
    // FTS tables afresh and would otherwise match the old vectors to its own sections. The dump's
    // own vectors, if it has any, are added.
    db.exec(SCHEMA);
    db.exec('DELETE FROM vectors WHERE fts = -1');
    db.exec('UPDATE OR REPLACE vectors SET fts = -1');

    for (const table of dump.tables.filter((d) => d.table === 'vectors')) insertAll(table);

    db.exec('DELETE FROM vectors WHERE library NOT IN (SELECT id FROM libraries)');
  });

  const libs = listLibraries(db, 'all');

  return { libraries: libs.length, sections: libs.reduce((sum, l) => sum + l.sections, 0) };
}

function migrate(db: Database) {
  // SAFETY: PRAGMA user_version always returns exactly one row with one integer column of that name.
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };

  if (version === SCHEMA_VERSION) return;

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `This index was written by a newer askdocs (format ${version}; this one reads up to ${SCHEMA_VERSION}). Upgrade askdocs, or rebuild the index.`,
    );
  }

  db.exec('BEGIN IMMEDIATE');

  try {
    // 0 → 6. Every earlier shape differs only additively in `libraries` and `audit`; sections are
    // derived from `docs`, which has always kept every body, so they are rebuilt, not converted.
    for (const [table, column, type] of [
      ['libraries', 'repo', 'TEXT'],
      ['libraries', 'include', 'TEXT'],
      ['libraries', 'fts', 'INTEGER'],
      ['audit', 'answered', 'INTEGER'],
      ['docs', 'rev', 'TEXT'],
      ['docs', 'url', 'TEXT'],
    ] as const) {
      addMissingColumn(db, table, column, type);
    }

    const setRev = db.prepare('UPDATE docs SET rev = ? WHERE library = ? AND path = ?');

    // SAFETY: `docs` declares library, path and body TEXT NOT NULL.
    for (const d of db.prepare('SELECT library, path, body FROM docs WHERE rev IS NULL').all() as {
      library: string;
      path: string;
      body: string;
    }[])
      setRev.run(revisionOf(d.body), d.library, d.path);
    // SAFETY: `libraries.id` is the TEXT primary key.
    const libs = db.prepare('SELECT id FROM libraries').all() as { id: string }[];

    for (const { id } of libs) {
      // SAFETY: `docs` declares path and body TEXT NOT NULL.
      const docs = db.prepare('SELECT path, body FROM docs WHERE library = ?').all(id) as {
        path: string;
        body: string;
      }[];

      const slot = createSectionsTable(db);
      let count = 0;

      for (const d of docs)
        count += insertSections(db, slot, d.path, parseMarkdown(d.body, titleFrom(d.path)));
      db.prepare('UPDATE libraries SET fts = ?, sections = ? WHERE id = ?').run(slot, count, id);
    }

    db.exec('DROP TABLE IF EXISTS sections');

    // The first version logged searches in `queries`, with no caller: keep them as anonymous history.
    const hasQueries = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queries'`)
      .get();

    if (hasQueries) {
      db.exec(`INSERT INTO audit (at, principal, tool, query, library, allowed, returned, results, ms, answered)
               SELECT at, '(unknown)', 'search_docs', query, library, '"all"', '[]', results, ms, results > 0 FROM queries;
               DROP TABLE queries;`);
    }

    db.exec('CREATE INDEX IF NOT EXISTS audit_at ON audit (at)');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const SECTIONS_COLUMNS = `
  title, summary, breadcrumb, content,
  path UNINDEXED, heading UNINDEXED, line UNINDEXED, languages UNINDEXED,
  tokenize = 'porter unicode61'`;

/**
 * A new, empty FTS table for one library, named by a number never used before in this index.
 * Each library gets its own so that ranking statistics, match work and query time depend only
 * on libraries the caller can see.
 */
function createSectionsTable(db: Database): number {
  // SAFETY: sqlite_master.name is TEXT and never NULL for a table.
  const used = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'fts_[0-9]*'`)
    .all() as { name: string }[];

  // SAFETY: an aggregate returns one row, and coalesce makes `max` an integer even over no rows.
  const { max } = db.prepare('SELECT coalesce(max(fts), 0) AS max FROM libraries').get() as { max: number };
  const slot = Math.max(max, ...used.map((t) => Number(/^fts_(\d+)/.exec(t.name)?.[1] ?? 0))) + 1;
  db.exec(`CREATE VIRTUAL TABLE fts_${slot} USING fts5(${SECTIONS_COLUMNS})`);

  return slot;
}

/**
 * Drop every per-library FTS table no library points at. Their text would otherwise stay readable
 * in the file after the library that owned it is removed. Runs on every open, not as a format
 * step, so it also repairs an index upgraded by a build that left the rebuilt tables behind.
 * Takes the write lock only when there is something to drop.
 */
function dropUnusedSectionsTables(db: Database) {
  const unused = () => {
    // SAFETY: sqlite_master.name is TEXT and never NULL for a table.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'fts_[0-9]*'`)
      .all() as { name: string }[];

    // SAFETY: `libraries.fts` is an INTEGER column; NULL rows are excluded.
    const inUse = db.prepare('SELECT fts FROM libraries WHERE fts IS NOT NULL').all() as { fts: number }[];
    const keep = new Set(inUse.map((l) => `fts_${l.fts}`));

    // `fts_3_data` and the other shadow tables go with their `fts_3`.
    return tables.flatMap(({ name }) => (/^fts_\d+$/.test(name) && !keep.has(name) ? [name] : []));
  };

  if (!unused().length) return;

  db.exec('BEGIN IMMEDIATE');

  try {
    // Checked again under the lock: another connection may have re-indexed since.
    for (const name of unused()) db.exec(`DROP TABLE ${name}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const titleFrom = (path: string) => path.replace(/\.mdx?$/, '');

const revisionOf = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 12);

/**
 * A link to a line of a document: the page's own URL when the source recorded one (a site, whose
 * paths may carry encoded characters or a query), else the library's base plus the path, encoded,
 * so a `#` or `?` in a file name stays part of the name.
 */
export function citationUrl(
  doc: { url: string | null; urlBase: string | null; path: string },
  line: number,
): string | undefined {
  const page =
    doc.url ?? (doc.urlBase && doc.urlBase + doc.path.split('/').map(encodeURIComponent).join('/'));

  return page ? `${page}#L${Math.max(line, 1)}` : undefined;
}

function insertSections(db: Database, slot: number, path: string, doc: ParsedDoc): number {
  const insert = db.prepare(
    `INSERT INTO fts_${slot} (title, summary, breadcrumb, content, path, heading, line, languages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // The author's own one-line summary, worth ranking on for every section. Starlight and Docusaurus call it
  // `description`; autocatalog and others call it `summary`.
  const summary = doc.frontmatter.description ?? doc.frontmatter.summary ?? '';

  for (const s of doc.sections) {
    insert.run(
      segmentCjk(doc.title),
      segmentCjk(summary),
      segmentCjk(s.breadcrumb.join(' > ')),
      segmentCjk(s.content),
      path,
      s.heading,
      s.line,
      s.languages.join(' '),
    );
  }

  return doc.sections.length;
}

function addMissingColumn(db: Database, table: string, column: string, type: string) {
  // SAFETY: pragma_table_info's `name` column is the column name, TEXT and never NULL.
  const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];

  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Replaces everything previously indexed under this library id, atomically: the new sections go
 * into a fresh table, and one transaction repoints the library at it and drops the old one. A
 * reader on another connection sees the old library or the new one, never a mix or a gap.
 */
export function indexLibrary(
  db: Database,
  library: Library,
  files: { path: string; text: string; url?: string }[],
) {
  let sections = 0;
  db.exec('BEGIN IMMEDIATE');

  try {
    // SAFETY: `fts` is a nullable INTEGER, and get() gives undefined when no library has this id.
    const old = db.prepare('SELECT fts FROM libraries WHERE id = ?').get(library.id) as
      { fts: number | null } | undefined;

    const slot = createSectionsTable(db);
    db.prepare('DELETE FROM docs WHERE library = ?').run(library.id);

    const insertDoc = db.prepare(
      'INSERT INTO docs (library, path, title, body, rev, url) VALUES (?, ?, ?, ?, ?, ?)',
    );

    for (const file of files) {
      const doc = parseMarkdown(file.text, titleFrom(file.path));
      insertDoc.run(library.id, file.path, doc.title, file.text, revisionOf(file.text), file.url ?? null);
      sections += insertSections(db, slot, file.path, doc);
    }

    db.prepare(
      `INSERT OR REPLACE INTO libraries (id, source, sha, repo, url_base, include, files, sections, indexed_at, fts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      library.id,
      library.source,
      library.sha ?? null,
      library.repo ?? null,
      library.urlBase ?? null,
      library.include ?? null,
      files.length,
      sections,
      new Date().toISOString(),
      slot,
    );

    if (old?.fts) db.exec(`DROP TABLE IF EXISTS fts_${old.fts}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { files: files.length, sections };
}

export function removeLibrary(db: Database, id: string): void {
  db.exec('BEGIN IMMEDIATE');

  try {
    // SAFETY: `fts` is a nullable INTEGER, and get() gives undefined when no library has this id.
    const old = db.prepare('SELECT fts FROM libraries WHERE id = ?').get(id) as
      { fts: number | null } | undefined;

    db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
    db.prepare('DELETE FROM docs WHERE library = ?').run(id);
    db.prepare('DELETE FROM vectors WHERE library = ?').run(id);

    if (old?.fts) db.exec(`DROP TABLE IF EXISTS fts_${old.fts}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listLibraries(db: Database, scope: Scope) {
  const [where, ...params] = inScope('libraries.id', 'libraries.repo', scope);

  // SAFETY: each column's type and nullability is the `libraries` schema's; `fts` is set by every write since format 5.
  return db
    .prepare(
      `SELECT id, source, sha, repo, include, url_base AS urlBase, fts, files, sections, indexed_at AS indexedAt
       FROM libraries WHERE ${where} ORDER BY id`,
    )
    .all(...params) as {
    id: string;
    source: string;
    sha: string | null;
    repo: string | null;
    include: string | null;
    urlBase: string | null;
    fts: number;
    files: number;
    sections: number;
    indexedAt: string;
  }[];
}

export type SearchResult = {
  hits: SearchHit[];
  /** Whether results continue past this page (pass `offset: offset + limit` for them). */
  more?: boolean;
  /**
   * Whether any hit covers most of the question's terms. OR-matching almost never
   * returns nothing, so "zero results" is a useless gap signal: "disaster recovery RTO"
   * happily returns sections that only mention "recovery". This is the honest one.
   */
  answered: boolean;
};

/**
 * The seam where hybrid/vector retrieval slots in later. Callers only see SearchResult,
 * so swapping FTS for something smarter changes nothing above here.
 *
 * Only the FTS tables of libraries in scope are queried at all: sections the caller may not
 * see are never matched, ranked, counted or snippeted, and their volume costs no time. Each
 * library ranks by its own statistics, so a hidden library cannot shift what a caller sees.
 */
export function search(
  db: Database,
  query: {
    text: string;
    library?: string;
    language?: string;
    limit?: number;
    /** Skip this many ranked results, for paging. */
    offset?: number;
    /** Coverage a hit needs for the search to count as answered. For tuning; defaults to ANSWERED_AT. */
    minCoverage?: number;
  },
  scope: Scope,
): SearchResult {
  return snapshot(db, () => searchSnapshot(db, query, scope));
}

/** A library as search sees it. */
export type SearchLibrary = ReturnType<typeof listLibraries>[number];

/**
 * The other half of a hybrid search: sections ranked by similarity to the question, best first,
 * from these libraries only (the caller's scope, already applied). Where the vectors live is up
 * to whoever supplies it.
 */
export type VectorLeg = {
  mode: 'vector' | 'hybrid';
  /**
   * When the best similarity stands this far above the 10th best, the question counts as answered
   * even if keywords can't vouch for it: a paraphrase shares few of the question's words.
   */
  answeredGap?: number | undefined;
  rank: (
    libs: SearchLibrary[],
    options: { pool: number; language?: string },
  ) => { id: number; lib: SearchLibrary; path: string; line: number; score: number }[];
};

/**
 * `search`, with a vector ranking alongside or instead of the keyword one. Fused by reciprocal
 * rank, which needs no score calibration between the two. Whether the search counts as answered
 * is judged exactly as in `search`, on the top three hits.
 */
export function searchWithVectors(
  db: Database,
  query: Parameters<typeof search>[1],
  scope: Scope,
  vectors: VectorLeg,
): SearchResult {
  return snapshot(db, () => searchSnapshot(db, query, scope, vectors));
}

/**
 * Run several reads against one consistent state of the index. A search reads the library list
 * and then each library's table; a re-index committing in between would otherwise drop the table
 * it is about to read. In WAL mode a read transaction pins its snapshot without blocking writers.
 */
function snapshot<T>(db: Database, read: () => T): T {
  if (db.isTransaction) return read();
  db.exec('BEGIN');

  try {
    return read();
  } finally {
    db.exec('COMMIT');
  }
}

function searchSnapshot(
  db: Database,
  query: Parameters<typeof search>[1],
  scope: Scope,
  vectors?: VectorLeg,
): SearchResult {
  const terms = queryTerms(query.text);
  const libs = listLibraries(db, scope).filter((l) => !query.library || l.id === query.library);

  if (!terms.length || !libs.length) return { hits: [], answered: false };
  const limit = query.limit ?? 8;
  const offset = query.offset ?? 0;
  const language = query.language ? normaliseLanguage(query.language) : undefined;
  // The top three always, to judge `answered` the same whatever page is asked for; one extra to know if more remain.
  const wanted = Math.max(offset + limit, 3) + 1;
  const { weights, common, present, rescale } = termWeights(db, terms, libs);
  // Words in over half the visible sections say almost nothing (their weight is near zero) and
  // matching them means scoring most of the index. Leave them out of matching when the question
  // has anything rarer; they still count towards whether it is answered.
  const matchTerms = terms.filter((_, t) => !common[t]);
  const rarerMatch = terms.some((_, t) => !common[t] && present[t]);
  const match = (rarerMatch ? matchTerms : terms).map(quote).join(' OR ');

  // Ranked by bm25 alone. Re-ranking by term coverage looked right on hand-made examples and lost
  // 8 points of recall@3 on the eval (eval/): coverage decides only whether the search is answered.
  //
  // Each library's table scores with its own statistics, so raw scores from two libraries do not
  // compare: a word rare in one library and common in another weighs more in the first. Each
  // library puts forward a fixed pool of its best sections; with more than one library, each is
  // re-scored term by term with the statistics of everything visible, then all are ranked together.
  // The pool does not depend on the page asked for, so pages never overlap or skip.
  // A page past the pool (100 per library) grows it.
  const pool = libs.length > 1 || vectors ? Math.max(POOL, wanted) : wanted;
  const scored = terms.flatMap((term, t) => (rarerMatch && common[t] ? [] : [{ term, t }]));

  const keyword =
    vectors?.mode === 'vector'
      ? []
      : libs.flatMap((lib, l) => {
          // SAFETY: rowid and line are integers, path is stored TEXT, and bm25() returns a real.
          const rows = db
            .prepare(
              `SELECT rowid AS id, path, line, bm25(fts_${lib.fts}, 4.0, 2.0, 2.0, 1.0) AS score
         FROM fts_${lib.fts}
         WHERE fts_${lib.fts} MATCH ? AND (? IS NULL OR ' ' || languages || ' ' LIKE ?)
         ORDER BY score, path, line LIMIT ?`,
            )
            .all(match, language ?? null, `% ${language} %`, pool) as {
            id: number;
            path: string;
            line: number;
            score: number;
          }[];

          // One library: its own statistics are the shared ones, and its order stands.
          if (libs.length === 1 || !rows.length) return rows.map((row) => ({ ...row, lib }));

          const perTerm = db.prepare(
            `SELECT rowid AS id, bm25(fts_${lib.fts}, 4.0, 2.0, 2.0, 1.0) AS score FROM fts_${lib.fts}
       WHERE fts_${lib.fts} MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
          );

          const ids = JSON.stringify(rows.map((r) => r.id));
          const shared = new Map<number, number>();

          for (const { term, t } of scored) {
            // SAFETY: the statement selects rowid, an integer, and bm25(), a real.
            for (const row of perTerm.all(quote(term), ids) as { id: number; score: number }[])
              shared.set(row.id, (shared.get(row.id) ?? 0) + row.score * rescale[t]![l]!);
          }

          return rows.map((row) => ({ ...row, score: shared.get(row.id) ?? 0, lib }));
        });

  const byKeyword = vectors?.mode === 'vector' ? [] : inOrder(keyword);

  // Similarity is higher-is-better: negated, it sorts like bm25. Fused, each list contributes
  // 1 / (60 + rank) per section, the usual constant, which rewards agreement between the two.
  const similar = vectors
    ? inOrder(vectors.rank(libs, { pool, language }).map((row) => ({ ...row, score: -row.score })))
    : [];

  const fused = new Map<string, (typeof keyword)[number]>();

  if (vectors?.mode === 'hybrid') {
    for (const list of [byKeyword, similar])
      list.forEach((row, rank) => {
        const key = `${row.lib.fts}:${row.id}`;
        const seen = fused.get(key);
        fused.set(key, { ...row, score: (seen?.score ?? 0) - 1 / (60 + rank + 1) });
      });
  }

  const candidates =
    vectors?.mode === 'hybrid' ? inOrder([...fused.values()]) : vectors ? similar : byKeyword;

  const top = candidates.slice(0, wanted);

  // A clear match by meaning vouches for the search only if it is among the three hits returned:
  // a match fusion ranked below them answers nothing the caller was shown. The gap is measured at
  // the 10th best (see `answeredGap`), so with fewer than ten sections in view there is no
  // calibrated signal, and keyword coverage alone decides.
  const best = similar[0];

  const standsOut =
    vectors?.answeredGap !== undefined &&
    similar.length >= 10 &&
    similar[9]!.score - best!.score >= vectors.answeredGap &&
    top.slice(0, 3).some((h) => h.lib.fts === best!.lib.fts && h.id === best!.id);

  // Titles and snippets only for what is returned: a snippet is the costly part of a row.
  const details = new Map<string, { title: string; breadcrumb: string; heading: string; snippet: string }>();

  for (const [slot, rows] of Map.groupBy(top, (c) => c.lib.fts)) {
    // SAFETY: rowid is an integer and the FTS columns are stored TEXT; snippet() returns TEXT.
    const found = db
      .prepare(
        `SELECT rowid AS id, title, breadcrumb, heading, snippet(fts_${slot}, 3, '**', '**', ' … ', 32) AS snippet
         FROM fts_${slot} WHERE fts_${slot} MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
      )
      .all(match, JSON.stringify(rows.map((r) => r.id))) as {
      id: number;
      title: string;
      breadcrumb: string;
      heading: string;
      snippet: string;
    }[];

    for (const { id, ...row } of found) details.set(`${slot}:${id}`, row);

    // Found by similarity alone: no query term to highlight, so the section's opening stands in.
    const missing = rows.filter((r) => !details.has(`${slot}:${r.id}`));

    if (!missing.length) continue;

    // SAFETY: rowid is an integer and the FTS columns are stored TEXT; substr() returns TEXT.
    const opening = db
      .prepare(
        `SELECT rowid AS id, title, breadcrumb, heading, substr(content, 1, 240) AS snippet
         FROM fts_${slot} WHERE rowid IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(missing.map((r) => r.id))) as typeof found;

    for (const { id, ...row } of opening) details.set(`${slot}:${id}`, row);
  }

  const total = weights.reduce((a, b) => a + b, 0);
  const covered = termsMatched(db, top, terms);
  const docOf = db.prepare('SELECT rev, url FROM docs WHERE library = ? AND path = ?');

  const ranked = top.map(({ id, lib, ...hit }) => {
    // SAFETY: every row in `top` was matched by the same query in the same snapshot.
    const shown = details.get(`${lib.fts}:${id}`)!;
    // SAFETY: the hit came from this library's table in the same snapshot, so its doc row exists; `rev` is set by every write since format 6.
    const doc = docOf.get(lib.id, hit.path) as { rev: string; url: string | null };
    const url = citationUrl({ url: doc.url, urlBase: lib.urlBase, path: hit.path }, hit.line);

    const result: SearchHit = {
      ...hit,
      heading: shown.heading,
      library: lib.id,
      title: joinCjk(shown.title),
      breadcrumb: joinCjk(shown.breadcrumb),
      snippet: joinCjk(shown.snippet),
      score: -hit.score,
      coverage: (covered.get(`${lib.fts}:${id}`) ?? []).reduce((sum, t) => sum + weights[t]!, 0) / total,
      revision: doc.rev,
    };

    if (lib.sha) result.commit = lib.sha;

    if (url) result.url = url;

    return result;
  });

  return {
    hits: ranked.slice(offset, offset + limit),
    more: ranked.length > offset + limit,
    // Judged on the top three, so the page or limit asked for never changes the verdict.
    answered: ranked.slice(0, 3).some((h) => h.coverage >= (query.minCoverage ?? ANSWERED_AT)) || standsOut,
  };
}

/**
 * The IDF-weighted share of the question one of the top three hits must contain for the search
 * to count as answered. Chosen by `pnpm eval --sweep` on the eval's answerable and no-answer
 * questions (maximising caught no-answers minus wrongly flagged answers): 0.45 catches 76% of
 * unanswerable questions and wrongly flags 24% of answerable ones. Lexical search cannot see a
 * paraphrase ("caret" for "cursor"), which is what the remaining false flags mostly are.
 */
const ANSWERED_AT = 0.45;

/** Sections each library puts forward for ranking together. */
const POOL = 100;

/**
 * A total order, the same one each table's SQL uses (BINARY collation: UTF-8 bytes, not locale),
 * so pages never overlap or skip tied rows. Lower scores rank first, as bm25() gives them.
 */
const inOrder = <T extends { score: number; lib: { id: string }; path: string; line: number }>(rows: T[]) =>
  rows.toSorted(
    (a, b) =>
      a.score - b.score ||
      binaryCompare(a.lib.id, b.lib.id) ||
      binaryCompare(a.path, b.path) ||
      a.line - b.line,
  );

/** For each candidate section (keyed `slot:rowid`), which query terms it contains, stemmed like the search. */
function termsMatched(
  db: Database,
  candidates: { id: number; lib: { fts: number } }[],
  terms: string[],
): Map<string, number[]> {
  const matched = new Map<string, number[]>();
  const bySlot = Map.groupBy(candidates, (c) => c.lib.fts);

  for (const [slot, rows] of bySlot) {
    const stmt = db.prepare(
      `SELECT rowid AS id FROM fts_${slot} WHERE fts_${slot} MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
    );

    const ids = JSON.stringify(rows.map((r) => r.id));
    terms.forEach((term, t) => {
      // SAFETY: the statement selects only rowid, an integer.
      for (const row of stmt.all(quote(term), ids) as { id: number }[]) {
        const key = `${slot}:${row.id}`;
        matched.set(key, [...(matched.get(key) ?? []), t]);
      }
    });
  }

  return matched;
}

/**
 * How much each query term tells us: its inverse document frequency among the sections the
 * caller can see (the same BM25 IDF, always positive). "prettier" in the Prettier docs is in
 * nearly every section and weighs almost nothing; `--cache` is in two and carries the question.
 * Counted over the visible libraries only, so documents the caller cannot see shape nothing.
 */
function termWeights(db: Database, terms: string[], libs: { fts: number; sections: number }[]) {
  // The section count is stored when a library is indexed; counting the table would scan it on every search.
  const n = libs.reduce((sum, l) => sum + l.sections, 0);

  const perLibrary = terms.map((term) =>
    libs.map(
      (l) =>
        // SAFETY: count(*) returns one row with an integer.
        (
          db
            .prepare(`SELECT count(*) AS n FROM fts_${l.fts} WHERE fts_${l.fts} MATCH ?`)
            .get(quote(term)) as { n: number }
        ).n,
    ),
  );

  const counts = perLibrary.map((d) => d.reduce((a, b) => a + b, 0));

  return {
    /**
     * For each term and library, how much more the term weighs among everything visible than in
     * that library alone: FTS5's own IDF over the union, divided by its IDF over the library.
     * Multiplying a term's bm25 in a library by this rescales it to the shared statistics.
     */
    rescale: perLibrary.map((d, t) =>
      d.map((dl, i) => fts5Idf(n, counts[t]!) / fts5Idf(libs[i]!.sections, dl)),
    ),
    weights: counts.map((d) => Math.log(1 + (n - d + 0.5) / (d + 0.5))),
    // Only worth it where scoring a common word costs something; in a small library every word is "common".
    common: counts.map((d) => n >= 100 && d > n / 2),
    present: counts.map((d) => d > 0),
  };
}

/** FTS5's BM25 IDF (sqlite fts5_aux.c), floored the same way. */
const fts5Idf = (rows: number, withTerm: number) => {
  const idf = Math.log((rows - withTerm + 0.5) / (withTerm + 0.5));

  return idf > 0 ? idf : 1e-6;
};

/**
 * Agents ask questions ("how do payout retries avoid duplicates?"), not FTS syntax.
 * Every word is quoted, so nothing in the question is parsed as an operator.
 */
function queryTerms(text: string): string[] {
  // A fully quoted query is an exact phrase, for error messages and identifiers: "ECONNRESET on retry".
  const phrase = /^\s*"([^"]+)"\s*$/.exec(text)?.[1]?.trim();

  if (phrase) return [phrase];
  // A CJK word becomes a phrase of its characters ("连接池" → "连 接 池"), matching how it was indexed.
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => segmentCjk(w).trim());
  // Question words match everywhere and drown short sections; keep them only if nothing else is left.
  const terms = words.filter((w) => !STOPWORDS.has(w));

  return [...new Set(terms.length ? terms : words)];
}

const binaryCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const quote = (term: string) => `"${term}"`;

/**
 * Chinese and Japanese are written without spaces, and FTS5's unicode61 tokenizer splits only
 * on spaces and punctuation, so a whole CJK sentence would be one token and a word inside it
 * unfindable. Indexing each CJK character as its own token, and searching for a CJK word as a
 * phrase of its characters, finds words anywhere without a dictionary or language detection.
 * Porter stemming does nothing to these tokens, and ranking treats a CJK word as one term.
 */
const CJK = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

const segmentCjk = (text: string) => text.replace(CJK, ' $1 ');

/** Undo segmentCjk for display, including highlight markers FTS put around each character. */
export function joinCjk(text: string): string {
  const cjk = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';

  return text
    .replace(new RegExp(`(${cjk})\\*\\*\\s*\\*\\*(?=${cjk})`, 'gu'), '$1')
    .replace(new RegExp(`(${cjk}\\**)\\s+(?=\\**${cjk})`, 'gu'), '$1');
}

const STOPWORDS = new Set(
  (
    'a about an and any are as at be been but by can could do does for from happen happens has have ' +
    'how i if in into is it its me my no not of on or our should so than that the their then there ' +
    'this to us was we were what when where which who why will with would you your'
  ).split(' '),
);

export function readDoc(db: Database, doc: { library: string; path: string }, scope: Scope) {
  const [where, ...params] = inScope('d.library', 'l.repo', scope);

  // SAFETY: the columns' types and nullability are the `docs` and `libraries` schemas'; get() gives undefined for no row.
  return db
    .prepare(
      `SELECT d.title, d.body, d.rev AS revision, d.url, l.sha AS "commit", l.url_base AS urlBase
       FROM docs d JOIN libraries l ON l.id = d.library
       WHERE d.library = ? AND d.path = ? AND ${where}`,
    )
    .get(doc.library, doc.path, ...params) as
    | {
        title: string;
        body: string;
        revision: string;
        url: string | null;
        commit: string | null;
        urlBase: string | null;
      }
    | undefined;
}

export function recordAudit(db: Database, event: AuditEvent): void {
  const options = settings.get(db);

  if (options?.auditRetentionDays === 0) return;

  if (options?.auditSink) return options.auditSink({ at: new Date().toISOString(), ...event });
  db.prepare(
    'INSERT INTO audit (at, principal, agent, tool, query, library, allowed, returned, results, answered, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    event.principal,
    event.agent ?? null,
    event.tool,
    event.query,
    event.library ?? null,
    JSON.stringify(event.allowed),
    JSON.stringify(event.returned),
    event.returned.length,
    event.answered === undefined ? null : Number(event.answered),
    event.ms,
  );
  pruneAudit(db);
}

/** Enforce the retention window. Cheap: `at` is indexed and ISO timestamps sort as strings. */
function pruneAudit(db: Database) {
  const days = settings.get(db)?.auditRetentionDays;

  if (days === undefined) return;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  db.prepare('DELETE FROM audit WHERE at < ?').run(cutoff);
}

export type Gap = {
  query: string;
  library: string | null;
  asks: number;
  people: number;
  /**
   * `missing`: nothing in the whole index covers the question — write the doc.
   * `restricted`: something does, but not in anything the askers could see — an access question, not a docs one.
   */
  kind: 'missing' | 'restricted';
};

/** What agents ask most, and what went unanswered — split by whether the doc is missing or just out of reach. */
export function queryStats(db: Database, limit = 20) {
  // SAFETY: `query` is TEXT NOT NULL, `library` nullable TEXT, and the counts integers.
  const top = db
    .prepare(
      `SELECT query, library, COUNT(*) AS asks, COUNT(DISTINCT principal) AS people FROM audit
       WHERE tool = 'search_docs' GROUP BY query, library ORDER BY asks DESC LIMIT ?`,
    )
    .all(limit) as { query: string; library: string | null; asks: number; people: number }[];

  // SAFETY: the same columns as `top`, which are Gap without its computed `kind`.
  const empty = db
    .prepare(
      `SELECT query, library, COUNT(*) AS asks, COUNT(DISTINCT principal) AS people FROM audit
       WHERE tool = 'search_docs' AND COALESCE(answered, results > 0) = 0
       GROUP BY query, library ORDER BY people DESC, asks DESC LIMIT ?`,
    )
    .all(limit) as Omit<Gap, 'kind'>[];

  const gaps: Gap[] = empty.map((g) => ({
    ...g,
    kind: search(db, { text: g.query, library: g.library ?? undefined }, 'all').answered
      ? 'restricted'
      : 'missing',
  }));

  return { top, gaps };
}

/** The most recent tool calls, newest first: who asked what, through which agent, and what they got. */
export function recentAudit(db: Database, limit = 50) {
  // SAFETY: `agent` is the one nullable column selected; the rest are TEXT NOT NULL.
  return db
    .prepare(
      'SELECT at, principal, agent, tool, query, allowed, returned FROM audit ORDER BY rowid DESC LIMIT ?',
    )
    .all(limit) as {
    at: string;
    principal: string;
    agent: string | null;
    tool: string;
    query: string;
    allowed: string;
    returned: string;
  }[];
}
