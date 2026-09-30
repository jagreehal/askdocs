import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  citationUrl,
  explainSqliteError,
  indexLibrary,
  openStore,
  queryStats,
  readDoc,
  recentAudit,
  recordAudit,
  search,
  searchWithVectors,
  listLibraries,
  type VectorLeg,
} from './store';

function store() {
  const db = openStore();
  indexLibrary(db, { id: 'ops', source: 'test' }, [
    {
      path: 'events.md',
      text: '# Events\n\n## Recovering missed events\n\nRecovery replays the outbox. Recovery is idempotent. Recovery recovery recovery.\n',
    },
    {
      path: 'payouts.md',
      text: '# Payouts\n\n## Retries\n\nA failed payout is retried, and the reconciliation job replays it.\n',
    },
  ]);

  return db;
}

describe('search', () => {
  it('weighs terms by rarity: a word in every section cannot make a question look answered', () => {
    const db = openStore();
    indexLibrary(
      db,
      { id: 'pay', source: 'test' },
      Array.from({ length: 8 }, (_, i) => ({
        path: `p${i}.md`,
        text: `# Payments ${i}\n\nPayments topic ${i}.\n`,
      })),
    );
    // Half the words match, but only the one that says nothing: "payments" is everywhere, "chargeback" nowhere.
    const { hits, answered } = search(db, { text: 'payments chargeback' }, 'all');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.coverage).toBeLessThan(0.1);
    expect(answered).toBe(false);
  });

  it('calls a question unanswered when hits only brush one of its terms', () => {
    const { hits, answered } = search(store(), { text: 'disaster recovery RTO' }, 'all');
    expect(hits.length).toBeGreaterThan(0);
    expect(answered).toBe(false);
    expect(hits[0]!.coverage).toBeLessThan(1 / 3); // "disaster" and "RTO" appear nowhere, so they outweigh "recovery"
  });

  it('counts a weak-match question as a gap, not as answered', () => {
    const db = store();
    const { hits, answered } = search(db, { text: 'disaster recovery RTO' }, 'all');
    recordAudit(db, {
      principal: 'bob',
      tool: 'search_docs',
      query: 'disaster recovery RTO',
      allowed: 'all',
      returned: hits.map((h) => h.path),
      answered,
      ms: 1,
    });
    expect(queryStats(db).gaps).toEqual([
      { query: 'disaster recovery RTO', library: null, asks: 1, people: 1, kind: 'missing' },
    ]);
  });
});

describe('openStore', () => {
  it('upgrades an index built by the previous version in place, keeping its audit trail', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'askdocs-old-')), 'docs.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE libraries (id TEXT PRIMARY KEY, source TEXT NOT NULL, sha TEXT, url_base TEXT,
        files INTEGER NOT NULL, sections INTEGER NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE audit (at TEXT NOT NULL, principal TEXT NOT NULL, agent TEXT, tool TEXT NOT NULL, query TEXT NOT NULL,
        library TEXT, allowed TEXT NOT NULL, returned TEXT NOT NULL, results INTEGER NOT NULL, ms REAL NOT NULL);
      INSERT INTO audit VALUES ('2026-09-01', 'bob', NULL, 'search_docs', 'what is our SLO', NULL, '"all"', '[]', 0, 1);
    `);
    old.close();

    const db = openStore(file);
    indexLibrary(db, { id: 'acme/docs', source: 'x', repo: 'acme/docs' }, [
      { path: 'a.md', text: '# A\n\nbody\n' },
    ]);
    expect(queryStats(db).gaps.map((g) => g.query)).toEqual(['what is our SLO']);
  });
});

function docs() {
  const db = openStore();
  indexLibrary(db, { id: 'sdk', source: 'test' }, [
    {
      path: 'client.md',
      text: '---\ndescription: Talking to the ledger over gRPC\n---\n# Client\n\n## Connect\n\nOpen a connection.\n\n```ts\nconnect()\n```\n\n## Errors\n\nSometimes you see ECONNRESET on retry after a timeout.\n',
    },
    { path: 'cli.md', text: '# CLI\n\n## Connect\n\nOpen a connection.\n\n```bash\nsdk connect\n```\n' },
    { path: 'faq.md', text: '# FAQ\n\n## Retry\n\nretry happens, then ECONNRESET, on and on.\n' },
  ]);

  return db;
}

describe('section filters, phrases, frontmatter, and migrations', () => {
  it('filters to sections with a code example in the language, aliases included', () => {
    const hits = search(docs(), { text: 'open a connection', language: 'ts' }, 'all').hits;
    expect(hits.map((h) => h.path)).toEqual(['client.md']);
  });

  it('matches a fully quoted query as an exact phrase', () => {
    const { hits, answered } = search(docs(), { text: '"ECONNRESET on retry"' }, 'all');
    expect(hits.map((h) => h.path)).toEqual(['client.md']);
    expect(answered).toBe(true);
  });

  it('makes the frontmatter description searchable', () => {
    expect(search(docs(), { text: 'grpc ledger' }, 'all').hits[0]?.path).toBe('client.md');
  });

  it('rebuilds the sections of an index from before these columns, from the stored bodies', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'askdocs-v1-')), 'docs.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE libraries (id TEXT PRIMARY KEY, source TEXT NOT NULL, sha TEXT, url_base TEXT,
        files INTEGER NOT NULL, sections INTEGER NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE docs (library TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (library, path));
      CREATE VIRTUAL TABLE sections USING fts5(title, breadcrumb, content,
        library UNINDEXED, path UNINDEXED, heading UNINDEXED, line UNINDEXED, tokenize = 'porter unicode61');
      INSERT INTO libraries VALUES ('sdk', 'x', NULL, NULL, 1, 1, '2026-09-01');
      INSERT INTO docs VALUES ('sdk', 'client.md', 'Client', '# Client' || char(10) || char(10) || '## Connect' || char(10) || char(10) || '\`\`\`ts' || char(10) || 'connect()' || char(10) || '\`\`\`');
    `);
    old.close();
    const hits = search(openStore(file), { text: 'connect', language: 'typescript' }, 'all').hits;
    expect(hits.map((h) => h.heading)).toEqual(['Connect']);
  });
});

function lib(text: string) {
  const db = openStore();
  indexLibrary(db, { id: 'x', source: 'test' }, [
    { path: 'doc.md', text },
    { path: 'other.md', text: '# Other\n\nUnrelated body text.\n' },
  ]);

  return db;
}

describe('frontmatter conventions', () => {
  it('ranks on `description`, or on `summary` when there is no description', () => {
    for (const key of ['description', 'summary']) {
      const db = lib(`---\n${key}: Reconciling ledger balances nightly\n---\n# Doc\n\nBody.\n`);
      expect({ key, top: search(db, { text: 'ledger reconciling' }, 'all').hits[0]?.path }).toEqual({
        key,
        top: 'doc.md',
      });
    }
  });

  it('prefers `description` when both are present', () => {
    const db = lib('---\ndescription: about payouts\nsummary: about invoices\n---\n# Doc\n\nBody.\n');
    expect(search(db, { text: 'payouts' }, 'all').hits).toHaveLength(1);
    expect(search(db, { text: 'invoices' }, 'all').hits).toHaveLength(0);
  });

  it('titles a doc from frontmatter `title` before its first H1', () => {
    const db = lib('---\ntitle: Payments Guide\n---\n# Getting started\n\nOnboarding steps.\n');
    expect(search(db, { text: 'onboarding' }, 'all').hits[0]).toMatchObject({
      title: 'Payments Guide',
      breadcrumb: 'Payments Guide > Getting started',
    });
  });
});

describe('non-ASCII text', () => {
  it('finds CJK words inside unspaced sentences, and accented Latin text', () => {
    const db = openStore();
    indexLibrary(db, { id: 'i18n', source: 'test' }, [
      { path: 'zh.md', text: '# 数据库\n\n如何配置数据库连接池的大小。\n' },
      { path: 'ja.md', text: '# 設定\n\nキャッシュの有効期限を変更する方法。\n' },
      { path: 'fr.md', text: '# Déploiement\n\nLe déploiement échoue sans clé.\n' },
      { path: 'en.md', text: '# Pool\n\nConnection pool sizing.\n' },
    ]);
    const top = (text: string) => search(db, { text }, 'all').hits[0]?.path;
    expect(top('连接池')).toBe('zh.md');
    expect(top('有効期限')).toBe('ja.md');
    expect(top('déploiement échoue')).toBe('fr.md');
    const zh = search(db, { text: '连接池' }, 'all');
    expect(zh.answered).toBe(true);
    expect(zh.hits[0]!.snippet).toContain('连接池'); // shown as written, not character by character
  });
});

describe('audit retention', () => {
  const event = {
    principal: 'bob',
    tool: 'search_docs',
    query: 'my token is ghp_secret',
    allowed: 'all' as const,
    returned: [],
    ms: 1,
  };

  it('deletes entries older than the retention window, on open and as it writes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'askdocs-audit-')), 'docs.db');
    const keepAll = openStore(file);
    recordAudit(keepAll, event);
    keepAll.prepare("UPDATE audit SET at = '2020-01-01T00:00:00.000Z'").run();
    recordAudit(keepAll, event);
    expect(recentAudit(keepAll)).toHaveLength(2);
    keepAll.close();

    const db = openStore(file, { auditRetentionDays: 30 });
    expect(recentAudit(db)).toHaveLength(1); // the 2020 entry went on open
    recordAudit(db, event);
    expect(recentAudit(db)).toHaveLength(2);
  });

  it('records nothing with a retention of 0', () => {
    const db = openStore(':memory:', { auditRetentionDays: 0 });
    recordAudit(db, event);
    expect(recentAudit(db)).toHaveLength(0);
  });
});

describe('opening the index', () => {
  it('names the fix when SQLite has no FTS5', () => {
    const explained = explainSqliteError(new Error('no such module: fts5'));
    expect(explained).toBeInstanceOf(Error);
    expect(explained).toMatchObject({ message: expect.stringMatching(/official Node\.js 24.*nodejs\.org/) });
    const other = new Error('disk I/O error');
    expect(explainSqliteError(other)).toBe(other);
  });
});

describe('scope', () => {
  it('pins the repo a caller was checked against: re-indexed from another repo, the library is out of scope', () => {
    const db = openStore();
    const doc = [{ path: 'a.md', text: '# A\n\nPangolin notes.\n' }];
    indexLibrary(db, { id: 'docs', source: 'test', repo: 'org/public' }, doc);
    const scope = [{ id: 'docs', repo: 'org/public' }];
    expect(readDoc(db, { library: 'docs', path: 'a.md' }, scope)).toBeDefined();
    indexLibrary(db, { id: 'docs', source: 'test', repo: 'org/private' }, doc);
    expect(readDoc(db, { library: 'docs', path: 'a.md' }, scope)).toBeUndefined();
    expect(search(db, { text: 'pangolin' }, scope).hits).toEqual([]);
  });
});

describe('paging', () => {
  it('returns every tied result exactly once, whatever the case of their paths', () => {
    const db = openStore();
    const names = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'a1', 'a2', 'a3', 'a4', 'a5'];
    indexLibrary(
      db,
      { id: 'lib', source: 'test' },
      names.map((n) => ({ path: `${n}.md`, text: '# Same\n\nIdentical wombat.\n' })),
    );
    const seen: string[] = [];

    for (let offset = 0; offset < names.length; offset += 2) {
      seen.push(...search(db, { text: 'wombat', limit: 2, offset }, 'all').hits.map((h) => h.path));
    }

    expect(seen).toEqual(names.map((n) => `${n}.md`));
  });
});

describe('citation links', () => {
  it('encode a file name, so # and ? stay part of it', () => {
    const urlBase = 'https://github.com/acme/docs/blob/abc123/';
    expect(citationUrl({ url: null, urlBase, path: 'guides/C#.md' }, 3)).toBe(`${urlBase}guides/C%23.md#L3`);
    expect(citationUrl({ url: null, urlBase, path: 'why?.md' }, 0)).toBe(`${urlBase}why%3F.md#L1`);
  });
});

// A vector ranking with fixed similarities by path, so the scenario is exact.
const fixedSimilarity = (
  db: DatabaseSync,
  mode: VectorLeg['mode'],
  similarity: Record<string, number>,
): VectorLeg => ({
  mode,
  answeredGap: 0.3,
  rank: (libs) =>
    libs.flatMap((library) =>
      z
        .array(z.object({ id: z.number(), path: z.string(), line: z.number() }))
        .parse(db.prepare(`SELECT rowid AS id, path, line FROM fts_${library.fts}`).all())
        .map((row) => ({ ...row, lib: library, score: similarity[row.path] ?? 0.1 })),
    ),
});

const standoutDocs = (fillers: number) => [
  { path: 'standout.md', text: '# Standout\n\n## Scaling\n\nOnly one instance runs.\n' },
  { path: 'a.md', text: '# A\n\n## Alpha\n\nAbout alpha.\n' },
  { path: 'b.md', text: '# B\n\n## Beta\n\nAbout beta.\n' },
  { path: 'c.md', text: '# C\n\n## Gamma\n\nAbout gamma.\n' },
  ...Array.from({ length: fillers }, (_, i) => ({
    path: `f${i}.md`,
    text: `# F${i}\n\n## Filler ${i}\n\nNothing.\n`,
  })),
];

describe('a clear match by meaning', () => {
  const similarity = { 'standout.md': 0.9, 'a.md': 0.5, 'b.md': 0.49, 'c.md': 0.48 };
  // Each keyword hit covers a quarter of the question: too little for keywords to vouch.
  const question = { text: 'alpha beta gamma delta', limit: 3 };

  it('vouches for a search only when that match is among the hits returned', () => {
    const db = openStore();
    indexLibrary(db, { id: 'docs', source: 'test' }, standoutDocs(8));

    // Fusion ranks the three keyword matches (also close by meaning) above it.
    const hybrid = searchWithVectors(db, question, 'all', fixedSimilarity(db, 'hybrid', similarity));
    expect(hybrid.hits.map((h) => h.path)).not.toContain('standout.md');
    expect(hybrid.answered).toBe(false);

    const byMeaning = searchWithVectors(db, question, 'all', fixedSimilarity(db, 'vector', similarity));
    expect(byMeaning.hits[0]?.path).toBe('standout.md');
    expect(byMeaning.answered).toBe(true);
  });

  it('is not a signal with fewer than ten sections in view', () => {
    const db = openStore();
    indexLibrary(db, { id: 'docs', source: 'test' }, standoutDocs(2));
    expect(listLibraries(db, 'all')[0]!.sections).toBeLessThan(10);

    const byMeaning = searchWithVectors(db, question, 'all', fixedSimilarity(db, 'vector', similarity));
    expect(byMeaning.hits[0]?.path).toBe('standout.md');
    expect(byMeaning.answered).toBe(false);
  });
});
