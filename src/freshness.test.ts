import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { loadSource, syncLibrary } from './sources';
import { indexLibrary, listLibraries, openStore, readDoc, search } from './store';

// A file URL: on Windows the ESM loader refuses a bare absolute path.
const DIST = pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href;

const version = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `${tag}-${i}.md`,
    text: `# ${tag} ${i}\n\nmarker text for ${tag}.\n`,
  }));

describe('re-indexing is atomic', () => {
  it('a reader on another connection never sees half a re-index, a mix of versions, or a dropped table', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'askdocs-atomic-')), 'docs.db');
    indexLibrary(openStore(file), { id: 'lib', source: 'test' }, version('v1', 10));

    // The writer runs on its own thread and connection, flipping between a 10-doc and a 20-doc version.
    const writer = new Worker(
      `const { indexLibrary, openStore } = await import(${JSON.stringify(DIST)});
       const { workerData } = await import('node:worker_threads');
       const db = openStore(workerData.file);
       const version = (tag, n) => Array.from({ length: n }, (_, i) => ({ path: tag + '-' + i + '.md', text: '# ' + tag + ' ' + i + '\\n\\nmarker text for ' + tag + '.\\n' }));
       for (let i = 0; i < 150; i++) indexLibrary(db, { id: 'lib', source: 'test' }, i % 2 ? version('v1', 10) : version('v2', 20));`,
      { eval: true, workerData: { file } },
    );

    let done = false;
    writer.on('exit', () => (done = true));
    writer.on('error', (e) => {
      throw e;
    });

    const reader = openStore(file);
    const seen = new Set<string>();
    const problems: string[] = [];
    let round = 0;

    // oxlint-disable-next-line no-unmodified-loop-condition -- set by the worker's exit event between iterations
    while (!done) {
      try {
        // Alternate: a bare search must be consistent on its own; a search and the read that follows
        // it inside one snapshot must agree with each other.
        const composed = ++round % 2 === 0;

        if (composed) reader.exec('BEGIN');
        const { hits } = search(reader, { text: 'marker', limit: 25 }, 'all');
        const tags = new Set(hits.map((h) => h.path.split('-')[0]));
        const [tag] = tags;
        const expected = tag === 'v1' ? 10 : 20;

        if (tags.size !== 1 || hits.length !== expected)
          problems.push(`${hits.length} hits from ${[...tags].join('+') || 'nothing'}`);
        seen.add(tag!);

        if (composed && !readDoc(reader, { library: 'lib', path: `${tag}-0.md` }, 'all')) {
          problems.push(`read of ${tag}-0.md found nothing`);
        }
      } catch (error) {
        problems.push(String(error));
      } finally {
        if (reader.isTransaction) reader.exec('COMMIT');
      }

      await new Promise((r) => setImmediate(r));
    }

    expect(problems.slice(0, 5)).toEqual([]);
    expect(seen).toEqual(new Set(['v1', 'v2'])); // it really did race the writer
  }, 20_000);
});

async function folder(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'askdocs-fresh-'));

  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }

  return dir;
}

const paths = (db: ReturnType<typeof openStore>, q: string) =>
  search(db, { text: q, limit: 25 }, 'all')
    .hits.map((h) => h.path)
    .toSorted();

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

describe('sync follows the source', () => {
  it('drops deleted files and follows renames', async () => {
    const dir = await folder({
      'a.md': '# A\n\nwidget alpha\n',
      'b.md': '# B\n\nwidget beta\n',
      'c.md': '# C\n\nwidget gamma\n',
    });

    const db = openStore();
    const { library, files } = await loadSource(dir, { name: 'lib' });
    indexLibrary(db, library, files);
    await rm(join(dir, 'a.md'));
    await rename(join(dir, 'b.md'), join(dir, 'renamed.md'));
    await syncLibrary(db, listLibraries(db, 'all')[0]!);
    expect(paths(db, 'widget')).toEqual(['c.md', 'renamed.md']);
    expect(readDoc(db, { library: 'lib', path: 'b.md' }, 'all')).toBeUndefined();
  });

  it('uses the new include glob after the library is re-added with one', async () => {
    const dir = await folder({ 'docs/a.md': '# A\n\nwidget\n', 'notes/b.md': '# B\n\nwidget\n' });
    const db = openStore();

    for (const include of ['docs/**/*.md', 'notes/**/*.md']) {
      const { library, files } = await loadSource(dir, { name: 'lib', include });
      indexLibrary(db, library, files);
    }

    await syncLibrary(db, listLibraries(db, 'all')[0]!);
    expect(paths(db, 'widget')).toEqual(['notes/b.md']);
  });

  it('follows a force-pushed git source to its new history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'askdocs-remote-'));
    const remote = join(root, 'docs.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', remote);
    git(root, 'init', '-q', work);
    git(work, 'config', 'user.email', 't@t');
    git(work, 'config', 'user.name', 't');
    await writeFile(join(work, 'guide.md'), '# Guide\n\noriginal wording\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'one');
    git(work, 'push', '-q', remote, 'HEAD:main');
    git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

    const db = openStore();
    const { library, files } = await loadSource(remote, { name: 'lib' });
    indexLibrary(db, library, files);
    const firstSha = listLibraries(db, 'all')[0]!.sha;

    await writeFile(join(work, 'guide.md'), '# Guide\n\nrewritten history\n');
    git(work, 'commit', '-q', '--amend', '-am', 'rewritten');
    git(work, 'push', '-q', '--force', remote, 'HEAD:main');
    await syncLibrary(db, listLibraries(db, 'all')[0]!);

    expect(paths(db, 'rewritten')).toEqual(['guide.md']);
    expect(paths(db, 'original')).toEqual([]);
    expect(listLibraries(db, 'all')[0]!.sha).not.toBe(firstSha);
  });

  // chmod cannot make a file unreadable on Windows.
  it.skipIf(process.platform === 'win32')(
    'keeps the old index intact when a sync fails partway through reading',
    async () => {
      const dir = await folder({ 'a.md': '# A\n\nwidget one\n', 'b.md': '# B\n\nwidget two\n' });
      const db = openStore();
      const { library, files } = await loadSource(dir, { name: 'lib' });
      indexLibrary(db, library, files);
      await writeFile(join(dir, 'c.md'), '# C\n\nwidget three\n');
      await chmod(join(dir, 'b.md'), 0o000); // unreadable: the sync fails after reading a.md

      try {
        await expect(syncLibrary(db, listLibraries(db, 'all')[0]!)).rejects.toThrow(/EACCES|permission/i);
      } finally {
        await chmod(join(dir, 'b.md'), 0o644);
      }

      expect(paths(db, 'widget')).toEqual(['a.md', 'b.md']);
    },
  );

  it('keeps the old index intact when the git remote is gone', async () => {
    const db = openStore();
    indexLibrary(db, { id: 'lib', source: '/nonexistent/remote.git', include: '**/*.md' }, version('v1', 3));
    await expect(syncLibrary(db, listLibraries(db, 'all')[0]!)).rejects.toThrow(
      /git clone|does not exist|not found/i,
    );
    expect(paths(db, 'marker')).toHaveLength(3);
  });
});
