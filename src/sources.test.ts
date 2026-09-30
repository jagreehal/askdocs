import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSource, syncLibrary, toPosixPath, watchLibraries, withoutCredentials } from './sources';
import { indexLibrary, listLibraries, openStore, search } from './store';

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'askdocs-src-'));
  await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'docs', 'a.md'), '# A\n\nOriginal text.\n');
  await writeFile(join(dir, 'NOTES.md'), '# Notes\n\nNot part of the library.\n');
  const db = openStore();
  const { library, files } = await loadSource(dir, { name: 'acme', include: 'docs/**/*.md' });
  indexLibrary(db, library, files);

  return { dir, db };
}

describe('keeping the index fresh', () => {
  it('sync re-reads the source with the glob it was added with', async () => {
    const { dir, db } = await folder();
    await writeFile(join(dir, 'docs', 'a.md'), '# A\n\nRewritten about idempotency.\n');
    await writeFile(join(dir, 'NOTES.md'), '# Notes\n\nidempotency, but out of scope.\n');
    await syncLibrary(db, listLibraries(db, 'all')[0]!);
    expect(search(db, { text: 'idempotency' }, 'all').hits.map((h) => h.path)).toEqual(['docs/a.md']);
  });

  it('refuses to guess the glob for a library indexed before globs were recorded', async () => {
    const { db } = await folder();
    const lib = { ...listLibraries(db, 'all')[0]!, include: null };
    await expect(syncLibrary(db, lib)).rejects.toThrow(/Re-add it once/);
    expect(search(db, { text: 'original' }, 'all').hits).toHaveLength(1);
  });

  it('--watch re-indexes a local folder after an edit, without anyone running a command', async () => {
    const { dir, db } = await folder();
    const synced: string[] = [];
    const stop = await watchLibraries(db, { debounceMs: 20, onSync: (id) => synced.push(id) });

    try {
      await writeFile(join(dir, 'docs', 'b.md'), '# B\n\nFreshly written runbook.\n');
      await expect
        .poll(() => search(db, { text: 'freshly written runbook' }, 'all').hits.length, { timeout: 3000 })
        .toBe(1);
      expect(synced).toContain('acme');
    } finally {
      stop();
    }
  });
});

async function gitProject() {
  const dir = await mkdtemp(join(tmpdir(), 'askdocs-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'docs', 'guide.md'), '# Guide\n\nPublic guide.\n');

  return dir;
}

describe('only what the folder really contains', () => {
  // Creating symlinks on Windows needs developer mode or admin rights.
  it.skipIf(process.platform === 'win32')(
    'ignores a symlink that points outside the folder, in plain folders and git repos',
    async () => {
      for (const useGit of [false, true]) {
        const root = await mkdtemp(join(tmpdir(), 'askdocs-link-'));
        await mkdir(join(root, 'public'));
        await mkdir(join(root, 'private'));

        if (useGit) execFileSync('git', ['init', '-q'], { cwd: join(root, 'public') });
        await writeFile(join(root, 'private', 'secret.md'), '# Secret\n\nThe vault password.\n');
        await writeFile(join(root, 'public', 'ok.md'), '# Ok\n\nFine.\n');
        await symlink(join(root, 'private', 'secret.md'), join(root, 'public', 'linked.md'));
        await symlink('ok.md', join(root, 'public', 'alias.md')); // inside the folder: fine

        const { files, skipped } = await loadSource(join(root, 'public'));
        expect(files.map((f) => f.path)).toEqual(['alias.md', 'ok.md']);
        expect(skipped).toEqual(['linked.md']);
      }
    },
  );

  it('refuses, rather than falling back to a glob, when git fails inside a repo', async () => {
    const dir = await gitProject();
    await writeFile(join(dir, '.gitignore'), 'secret.md\n');
    await writeFile(join(dir, 'secret.md'), '# Secret\n\nignored on purpose\n');
    const db = openStore();
    const { library, files } = await loadSource(dir, { name: 'p' });
    indexLibrary(db, library, files);
    expect(files.map((f) => f.path)).not.toContain('secret.md');

    await writeFile(join(dir, '.git', 'index'), 'garbage'); // git now fails on every read
    await expect(loadSource(dir, { name: 'p' })).rejects.toThrow(/git/i);
    await expect(syncLibrary(db, listLibraries(db, 'all')[0]!)).rejects.toThrow(/git/i);
    // The existing index is untouched.
    expect(search(db, { text: 'public guide' }, 'all').hits).toHaveLength(1);
    expect(search(db, { text: 'ignored on purpose' }, 'all').hits).toHaveLength(0);
  });

  it('refuses a checkout so broken that git says it is not a repo, instead of globbing past .gitignore', async () => {
    const dir = await gitProject();
    await writeFile(join(dir, '.gitignore'), 'secret.md\n');
    await writeFile(join(dir, 'secret.md'), '# Secret\n\nignored on purpose\n');
    await writeFile(join(dir, '.git', 'HEAD'), 'garbage'); // git: "not a git repository"
    await expect(loadSource(dir)).rejects.toThrow(/not a git repository/);
  });

  it('treats a folder that is not a repo, and a repo with no commits or remote, as normal', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'askdocs-plain-'));
    await writeFile(join(plain, 'a.md'), '# A\n\nx\n');
    expect((await loadSource(plain)).files).toHaveLength(1);
    const fresh = await gitProject();
    const { library, files } = await loadSource(fresh);
    expect(files).toHaveLength(1);
    expect(library.sha).toBeUndefined();
    expect(library.repo).toBeUndefined();
  });
});

const settle = () => new Promise((r) => setTimeout(r, 500));

describe('watching exclusion rules', () => {
  it('drops a doc as soon as it is .gitignored, including by a .gitignore above the served folder', async () => {
    const dir = await gitProject();
    await writeFile(join(dir, 'docs', 'draft.md'), '# Draft\n\nUnreleased pricing plan.\n');
    await writeFile(join(dir, 'docs', 'notes.md'), '# Notes\n\nScratch thoughts on retries.\n');
    const db = openStore();
    const { library, files } = await loadSource(join(dir, 'docs'), { name: 'docs' });
    indexLibrary(db, library, files);
    const stop = await watchLibraries(db, { debounceMs: 20 });

    try {
      await settle(); // macOS starts delivering file events a moment after the watch begins
      await writeFile(join(dir, '.gitignore'), 'docs/draft.md\n'); // repo root, outside the served folder
      await expect
        .poll(() => search(db, { text: 'pricing plan' }, 'all').hits.length, { timeout: 3000 })
        .toBe(0);
      await writeFile(join(dir, 'docs', '.gitignore'), 'notes.md\n'); // inside it
      await expect
        .poll(() => search(db, { text: 'scratch thoughts' }, 'all').hits.length, { timeout: 3000 })
        .toBe(0);
    } finally {
      stop();
    }
  });
});

describe('paths', () => {
  it('links a plain folder whose path has spaces with a valid file:// URL', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'askdocs spaces ')), 'team docs');
    await mkdir(dir);
    await writeFile(join(dir, 'a.md'), '# A\n\nx\n');
    const { library, files } = await loadSource(dir);
    expect(files.map((f) => f.path)).toEqual(['a.md']);
    expect(library.urlBase).toMatch(/^file:\/\/\/.*askdocs%20spaces%20[^/]+\/team%20docs\/$/);
    expect(() => new URL(`${library.urlBase}a.md`)).not.toThrow();
  });

  it('stores Windows-style relative paths with forward slashes', () => {
    expect(toPosixPath('guides\\setup\\install.md', '\\')).toBe('guides/setup/install.md');
    expect(toPosixPath('guides/setup/install.md', '/')).toBe('guides/setup/install.md');
  });
});

describe('the periodic check behind the watcher', () => {
  it('catches a change the file watcher never reported', async () => {
    const dir = await gitProject();
    const db = openStore();
    const { library, files } = await loadSource(join(dir, 'docs'), { name: 'docs' });
    indexLibrary(db, library, files);
    // Events would take a minute to act on; only the fingerprint check can make this pass in time.
    const stop = await watchLibraries(db, { debounceMs: 60_000, rescanMs: 50 });

    try {
      await writeFile(join(dir, 'docs', 'late.md'), '# Late\n\nArrived while nobody was listening.\n');
      await expect
        .poll(() => search(db, { text: 'nobody listening' }, 'all').hits.length, { timeout: 3000 })
        .toBe(1);
    } finally {
      stop();
    }
  });

  it('picks up an edit made after `add` but before the watcher started', async () => {
    const { dir, db } = await folder();
    await writeFile(join(dir, 'docs', 'a.md'), '# A\n\nEdited while nothing watched.\n');
    const stop = await watchLibraries(db, { debounceMs: 60_000, rescanMs: 50 });

    try {
      await expect
        .poll(() => search(db, { text: 'edited while nothing watched' }, 'all').hits.length, {
          timeout: 3000,
        })
        .toBe(1);
    } finally {
      stop();
    }
  });

  it('syncs once at startup, then not again while nothing changes', async () => {
    const dir = await gitProject();
    const db = openStore();
    const { library, files } = await loadSource(join(dir, 'docs'), { name: 'docs' });
    indexLibrary(db, library, files);
    const synced: string[] = [];

    const stop = await watchLibraries(db, {
      debounceMs: 60_000,
      rescanMs: 30,
      onSync: (id) => synced.push(id),
    });

    try {
      await expect.poll(() => synced, { timeout: 5000 }).toEqual(['docs']);
      // Ten more rescans with nothing changed.
      await new Promise((r) => setTimeout(r, 300));
      expect(synced).toEqual(['docs']);
    } finally {
      stop();
    }
  });
});

describe('commit citations', () => {
  it('cite the commit only while the indexed docs match it; the repo is kept either way', async () => {
    const dir = await gitProject();

    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });

    git('remote', 'add', 'origin', 'https://github.com/acme/docs.git');
    git('add', '.');
    git('commit', '-qm', 'docs');

    const clean = (await loadSource(dir, { name: 'docs' })).library;
    expect(clean).toMatchObject({ repo: 'acme/docs', sha: expect.any(String) });
    expect(clean.urlBase).toMatch(/^https:\/\/github\.com\/acme\/docs\/blob\//);

    await writeFile(join(dir, 'docs', 'guide.md'), '# Guide\n\nUnpublished edit.\n');
    const edited = (await loadSource(dir, { name: 'docs' })).library;
    expect(edited).toMatchObject({ repo: 'acme/docs', sha: undefined });
    expect(edited.urlBase).toMatch(/^file:/);

    git('checkout', '-q', '--', '.');
    await writeFile(join(dir, 'docs', 'new.md'), '# New\n\nNot committed yet.\n');
    expect((await loadSource(dir, { name: 'docs' })).library.sha).toBeUndefined();
  });
});

describe('a git source as the index records it', () => {
  it('drops the token CI clones private repos with, and leaves other forms alone', () => {
    expect(withoutCredentials('https://x-access-token:ghs_secret@github.com/acme/docs.git')).toBe(
      'https://github.com/acme/docs.git',
    );
    expect(withoutCredentials('https://github.com/acme/docs')).toBe('https://github.com/acme/docs');
    expect(withoutCredentials('git@github.com:acme/docs.git')).toBe('git@github.com:acme/docs.git');
  });

  it('keeps the token out of the error when a clone fails, since CI logs print it', async () => {
    const error = await loadSource('https://x-access-token:ghs_secret@127.0.0.1:1/acme/docs.git').then(
      () => undefined,
      (failure: Error) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    const printed = error instanceof Error ? `${error.message} ${String(error.cause)}` : '';
    expect(printed).toContain('https://127.0.0.1:1/acme/docs.git');
    expect(printed).not.toContain('ghs_secret');
  });
});
