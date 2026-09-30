import { copyFileSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  indexLibrary,
  listLibraries,
  openStore,
  queryStats,
  readDoc,
  removeLibrary,
  SCHEMA_VERSION,
  search,
} from './store';

/** Indexes written by each earlier on-disk format, by that version's own code (see generate-indexes.mjs). */
const FIXTURES = ['5f6b3df', '3ec15b9', 'ea600a3', 'c04d81d', 'f1504ea'];

function copyOf(commit: string) {
  const file = join(mkdtempSync(join(tmpdir(), `askdocs-upgrade-${commit}-`)), 'docs.db');
  copyFileSync(join(import.meta.dirname, '__fixtures__', `index-${commit}.db`), file);

  return file;
}

describe.each(FIXTURES)('an index written by %s', (commit) => {
  it('upgrades in place to the current format, keeping libraries, documents and question history', () => {
    const file = copyOf(commit);
    const db = openStore(file);

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });

    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((t) => t.name);

    expect(tables).not.toContain('sections');
    expect(tables).not.toContain('queries');

    expect(listLibraries(db, 'all')).toMatchObject([
      { id: 'acme/docs', sha: 'abc123', files: 1, sections: 3 }, // the intro, Retries, Refunds: `# Payments` has no text of its own
    ]);
    // Sections are rebuilt with today's parser: line addresses, cleaned text, languages, frontmatter summary.
    const [retries] = search(db, { text: 'exponential backoff', language: 'ts' }, 'all').hits;
    expect(retries).toMatchObject({
      path: 'guide.md',
      heading: 'Retries',
      line: 9,
      breadcrumb: 'Payments guide > Payments > Retries',
    });
    expect(search(db, { text: 'intro before any heading' }, 'all').hits[0]).toMatchObject({ line: 0 });
    expect(readDoc(db, { library: 'acme/docs', path: 'guide.md' }, 'all')?.title).toBe('Payments guide');
    expect(queryStats(db).top).toMatchObject([{ query: 'refund policy', asks: 1 }]);
    db.close();

    // Opening again is a no-op, not a second migration.
    const again = openStore(file);
    expect(queryStats(again).top).toHaveLength(1);
    expect(listLibraries(again, 'all')[0]!.fts).toBe(listLibraries(openStore(file), 'all')[0]!.fts);
  });
});

it('refuses an index written by a newer version, rather than misreading it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'askdocs-future-')), 'docs.db');
  const future = new DatabaseSync(file);
  future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  future.close();
  expect(() => openStore(file)).toThrow(/newer askdocs/);
});

it('upgrades a format-5 index without leaving the replaced search tables behind', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'askdocs-v5-')), 'docs.db');
  const v5 = openStore(file);
  indexLibrary(v5, { id: 'secret', source: 'test' }, [{ path: 'a.md', text: '# A\n\nLaunch codes.\n' }]);
  // Format 5 as written by that version: no `docs.rev` or `docs.url`.
  v5.exec('ALTER TABLE docs DROP COLUMN rev; ALTER TABLE docs DROP COLUMN url; PRAGMA user_version = 5');
  v5.close();

  const db = openStore(file);

  const ftsTables = () =>
    z
      .array(z.object({ name: z.string() }))
      .parse(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'fts_*'`).all())
      .map((t) => t.name)
      .filter((name) => /^fts_\d+$/.test(name));

  expect(ftsTables()).toEqual([`fts_${listLibraries(db, 'all')[0]!.fts}`]);
  expect(search(db, { text: 'launch codes' }, 'all').hits).toHaveLength(1);

  removeLibrary(db, 'secret');
  expect(ftsTables()).toEqual([]);
});

it('repairs an already-upgraded index that still holds search tables no library uses', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'askdocs-orphan-')), 'docs.db');
  const before = openStore(file);
  indexLibrary(before, { id: 'docs', source: 'test' }, [{ path: 'a.md', text: '# A\n\nKept.\n' }]);
  // What an earlier build of the format-5 upgrade left behind: a replaced table, still full of text.
  before.exec(`CREATE VIRTUAL TABLE fts_99 USING fts5(content); INSERT INTO fts_99 VALUES ('launch codes')`);
  before.close();

  const db = openStore(file);

  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(db.prepare(`SELECT name FROM sqlite_master WHERE name GLOB 'fts_99*'`).all());

  expect(tables).toEqual([]);
  expect(search(db, { text: 'kept' }, 'all').hits).toHaveLength(1);
});
