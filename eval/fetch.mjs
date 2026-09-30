// Fetch each eval corpus at its pinned commit: a sparse, shallow checkout of just its docs folder.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE = join(import.meta.dirname, '.cache');

export const corpora = JSON.parse(readFileSync(join(import.meta.dirname, 'corpora.json'), 'utf8'));

export function fetchCorpus(corpus) {
  const dir = join(CACHE, `${corpus.id}-${corpus.commit.slice(0, 12)}`);

  if (existsSync(join(dir, corpus.path))) return join(dir, corpus.path);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('remote', 'add', 'origin', corpus.repo);
  git('sparse-checkout', 'set', '--no-cone', `/${corpus.path}/`);
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', corpus.commit);
  git('checkout', '-q', 'FETCH_HEAD');

  return join(dir, corpus.path);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const c of corpora) console.log(`${c.id}: ${fetchCorpus(c)}`);
}
