// Regenerates the index fixtures used by upgrade tests: one index written by each historical
// on-disk format, by that commit's own code. Run from the repo root: node src/__fixtures__/generate-indexes.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');

// The commits where the stored shape or meaning of an index changed, before SCHEMA_VERSION existed.
const COMMITS = ['5f6b3df', '3ec15b9', 'ea600a3', 'c04d81d', 'f1504ea'];

const GUIDE = [
  '---',
  'title: Payments guide',
  'description: Retries and refunds',
  '---',
  'Intro before any heading.',
  '',
  '# Payments',
  '',
  '## Retries',
  '',
  'Payouts retry with exponential backoff.',
  '',
  '```ts',
  'retry({ attempts: 3 });',
  '```',
  '',
  '## Refunds',
  '',
  'Refunds go through the ledger.',
].join('\n');

for (const commit of COMMITS) {
  const out = join(import.meta.dirname, `index-${commit}.db`);
  rmSync(out, { force: true });
  const wt = mkdtempSync(join(tmpdir(), `askdocs-wt-${commit}-`));
  execFileSync('git', ['worktree', 'add', '--detach', wt, commit], { cwd: repo, stdio: 'pipe' });

  try {
    symlinkSync(join(repo, 'node_modules'), join(wt, 'node_modules'));
    execFileSync(join(repo, 'node_modules/.bin/tsdown'), [], { cwd: wt, stdio: 'pipe' });

    const script = `
      const m = await import(${JSON.stringify(join(wt, 'dist/index.js'))});
      const db = m.openStore(${JSON.stringify(out)});
      m.indexLibrary(db, { id: 'acme/docs', source: '/src/acme', sha: 'abc123' }, [{ path: 'guide.md', text: ${JSON.stringify(GUIDE)} }]);
      // One logged question, in whichever log table this version had: \`queries\` (first commit) or \`audit\`.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
      if (tables.includes('audit')) {
        const row = { at: '2026-09-28T10:00:00.000Z', principal: 'bob@acme.com', agent: 'claude-code', tool: 'search_docs', query: 'refund policy', library: null, allowed: '"all"', returned: '[]', results: 0, ms: 1, answered: 0 };
        const cols = db.prepare("SELECT name FROM pragma_table_info('audit')").all().map((c) => c.name);
        db.prepare('INSERT INTO audit (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...cols.map((c) => row[c]));
      } else {
        m.search(db, { text: 'refund policy' });
      }
      db.close();`;

    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
    console.log(`wrote ${out}`);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo, stdio: 'pipe' });
  }
}

for (const commit of COMMITS)
  if (!existsSync(join(import.meta.dirname, `index-${commit}.db`))) process.exit(1);
