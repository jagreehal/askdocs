import { execFile } from 'node:child_process';
import { glob, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { basename, dirname, join, matchesGlob, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { watch } from 'node:fs';
import { z } from 'zod';
import { isLlmsTxt, loadLlmsTxt } from './llms';
import { traced } from './telemetry';
import { indexLibrary, listLibraries, type Library, type Database } from './store';

const run = promisify(execFile);

export type LoadedSource = {
  library: Library;
  files: { path: string; text: string; url?: string }[];
  /** Symlinks that resolve outside the source folder, and so were not read. */
  skipped: string[];
};

const DEFAULT_INCLUDE = '**/*.{md,mdx}';

/**
 * A local directory, anything `git clone` accepts, or a site's `llms.txt` URL (see llms.ts).
 *
 * Git sources are shallow-cloned to a temp dir and thrown away after reading:
 * the index is the product, the checkout is not.
 */
export async function loadSource(
  input: string,
  options: { name?: string; include?: string } = {},
): Promise<LoadedSource> {
  if (isLlmsTxt(input)) return loadLlmsTxt(input, options);
  const include = options.include ?? DEFAULT_INCLUDE;

  if (!isGitUrl(input)) {
    const dir = resolve(input);

    if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${input}`);
    const checkout = await gitCheckout(dir);

    // A folder inside a GitHub checkout inherits that repo's permissions and links, like a clone would.
    // Only "no commits yet" and "no origin remote" are normal; any other git failure throws, because
    // silently losing the origin would also silently drop the GitHub permission check.
    const [sha, origin, prefix] = checkout
      ? await Promise.all([
          git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowExit: [1] }),
          git(dir, ['remote', 'get-url', 'origin'], { allowExit: [2] }),
          git(dir, ['rev-parse', '--show-prefix']),
        ])
      : [];

    const repo = origin && isGithub(origin) ? repoPath(origin) : undefined;
    const read = await readFiles(dir, include, !!checkout);

    // A commit citation promises the text is what that commit holds. With an uncommitted or untracked
    // doc it is not, so link to the local files instead; `repo` stays, since access follows the repo.
    // Commit citations apply per library: all of its docs match the commit, or none are cited by it.
    const committed =
      sha &&
      !(await differsFromHead(
        dir,
        read.files.map((f) => f.path),
      ))
        ? sha
        : undefined;

    const urlBase =
      origin && repo && committed
        ? `${blobUrl(origin, repo, committed)}${prefix ?? ''}`
        : `${pathToFileURL(dir).href}/`;

    return {
      library: { id: options.name ?? basename(dir), source: dir, sha: committed, repo, urlBase, include },
      ...read,
    };
  }

  const dir = await mkdtemp(resolve(tmpdir(), 'askdocs-'));

  try {
    await run('git', ['clone', '--depth', '1', '--quiet', input, dir]).catch((error: Error) => {
      // The message holds the whole command line, token included, and CI logs print it.
      throw new Error(redact(error.message, input));
    });
    const sha = (await git(dir, ['rev-parse', 'HEAD']))!;
    const repo = repoPath(input);

    const library: Library = {
      id: options.name ?? repo,
      source: withoutCredentials(input),
      sha,
      include,
      urlBase: blobUrl(input, repo, sha),
    };

    if (isGithub(input)) library.repo = repo;

    return { library, ...(await readFiles(dir, include, true)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run git and return its output. An exit code listed in `allowExit` means "nothing here"
 * and returns undefined; every other failure throws. Git failing must never look like an
 * answer, because the fallbacks (a glob, no origin) widen what gets indexed.
 */
async function git(cwd: string, args: string[], options: { allowExit?: number[] } = {}) {
  try {
    // 64 MiB: `ls-files` on a large monorepo overflows the 1 MiB default.
    return (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const { code, stderr = '' } = GitFailure.safeParse(error).data ?? {};

    if (code !== undefined && options.allowExit?.includes(code)) return undefined;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim() || String(error)}`, {
      cause: error,
    });
  }
}

/** What execFile's rejection says about a git run: its exit code (a number; a spawn failure has a string code) and stderr. */
const GitFailure = z.object({
  code: z.number().optional().catch(undefined),
  stderr: z.string().optional().catch(undefined),
});

/** Whether any of these paths (relative to `dir`) is modified, staged or untracked relative to HEAD. */
async function differsFromHead(dir: string, paths: string[]): Promise<boolean> {
  const [changed, untracked] = await Promise.all([
    git(dir, ['diff', '--name-only', '-z', '--relative', 'HEAD']),
    git(dir, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);

  const differ = new Set(`${changed}\0${untracked}`.split('\0'));

  return paths.some((p) => differ.has(p));
}

/** The checkout `dir` is in, or undefined when it is plainly not in one. */
export async function gitCheckout(dir: string): Promise<{ root: string; gitDir: string } | undefined> {
  try {
    const [root, gitDir] = (await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']))!.split(
      '\n',
    );

    return { root: root!, gitDir: gitDir! };
  } catch (error) {
    // .gitignore only exists where a .git does. With no .git up the tree this is plainly not a
    // checkout (whatever git said, even if git is not installed). With one, any failure is an
    // error: a broken checkout reports "not a git repository", and globbing it would index
    // everything its .gitignore excludes.
    if (await insideDotGit(dir)) throw error;

    return undefined;
  }
}

async function insideDotGit(dir: string): Promise<boolean> {
  for (let d = dir; ; d = dirname(d)) {
    if (
      await lstat(join(d, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true;

    if (dirname(d) === d) return false;
  }
}

const isGithub = (url: string) => /github\.com[/:]/.test(url);

function isGitUrl(input: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(input) || input.endsWith('.git');
}

/**
 * A clone URL as the index records it: without a user or token. CI clones private repos with
 * `https://x-access-token:<token>@github.com/…`, and an index is published to wherever it's served.
 */
export function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';

    return parsed.href;
  } catch {
    // Not a URL (git@host:path): no credentials to carry.
    return url;
  }
}

/** `text` with the credentials in clone URL `url` removed, wherever they appear. */
function redact(text: string, url: string): string {
  const secrets = URL.canParse(url) ? [new URL(url).password, new URL(url).username] : [];

  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (out, secret) => out.replaceAll(secret, '***').replaceAll(decodeURIComponent(secret), '***'),
      text.replaceAll(url, withoutCredentials(url)),
    );
}

/** `https://github.com/withastro/docs.git` and `git@github.com:withastro/docs` both → `withastro/docs`. */
function repoPath(url: string): string {
  return url
    .replace(/\.git$/, '')
    .replace(/^.*?:\/\/[^/]+\/|^git@[^:]+:/, '')
    .replace(/\/$/, '');
}

function blobUrl(url: string, repo: string, sha: string): string | undefined {
  if (isGithub(url)) return `https://github.com/${repo}/blob/${sha}/`;

  if (/gitlab\.com[/:]/.test(url)) return `https://gitlab.com/${repo}/-/blob/${sha}/`;

  return undefined;
}

/**
 * Inside a git checkout, the files git would track: `.gitignore` already says what is
 * build output, vendored or scratch, so it never reaches the index. Elsewhere, a glob.
 * Either way node_modules and dot-directories are skipped.
 */
async function readFiles(dir: string, include: string, inCheckout: boolean) {
  const { files: found, skipped } = await listFiles(dir, include, inCheckout);
  const files: { path: string; text: string }[] = [];

  for (const f of found) files.push({ path: f.path, text: await readFile(f.real, 'utf8') });

  return { files, skipped };
}

/**
 * The files a library consists of, without reading them: what git would track (or the glob
 * matches), resolved through symlinks, keeping only what lands inside the folder. A link to
 * ../private/secret.md, or to /etc on a server, is not part of these docs.
 */
async function listFiles(dir: string, include: string, inCheckout: boolean) {
  const paths: string[] = [];

  if (inCheckout) {
    const listed = await git(dir, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--deduplicate',
    ]);

    for (const p of listed!.split('\0')) {
      if (p && matchesGlob(p, include) && !p.split('/').slice(0, -1).some(skipDir)) paths.push(p);
    }
  } else {
    for await (const path of glob(include, { cwd: dir, exclude: skipDir })) paths.push(toPosixPath(path));
  }

  const root = await realpath(dir);
  const files: { path: string; real: string }[] = [];
  const skipped: string[] = [];

  for (const path of paths.toSorted()) {
    let real: string;

    try {
      real = await realpath(resolve(dir, path));
    } catch (error) {
      // Tracked but deleted in the working tree (or a dangling link): the index follows the files.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }

    if (real.startsWith(root + sep)) files.push({ path, real });
    else skipped.push(path);
  }

  return { files, skipped };
}

/**
 * A cheap summary of a local library's current state: which files it has and their sizes and
 * modification times. Listing applies .gitignore and the glob, so an ignore-rule change shows up
 * too. Equal fingerprints mean re-indexing would change nothing.
 */
async function fingerprint(dir: string, include: string): Promise<string> {
  const { files } = await listFiles(dir, include, !!(await gitCheckout(dir)));

  const parts = await Promise.all(
    files.map(async (f) => {
      const s = await stat(f.real);

      return `${f.path}\0${s.size}\0${s.mtimeMs}`;
    }),
  );

  return parts.join('\n');
}

/** Library paths use `/` on every platform: git does, URLs do, and a Windows `guides\\a.md` must match `guides/**`. */
export const toPosixPath = (path: string, separator: string = sep) => path.split(separator).join('/');

const skipDir = (name: string) => name === 'node_modules' || (name.startsWith('.') && name !== '.');

/**
 * Re-index a library from wherever it was added from, with the same include glob.
 *
 * Refuses a library indexed before the glob was recorded: guessing the default would
 * quietly widen what everyone allowed that library can read.
 */
export async function syncLibrary(
  db: Database,
  library: { id: string; source: string; include: string | null },
): Promise<{ files: number; sections: number }> {
  return traced('askdocs.sync', { 'askdocs.library': library.id }, async (span) => {
    if (!library.include) {
      throw new Error(
        `${library.id} was indexed before askdocs recorded include globs. Re-add it once: askdocs add ${library.source} --name ${library.id} [--include <glob>]`,
      );
    }

    const loaded = await loadSource(library.source, { name: library.id, include: library.include });
    const counts = indexLibrary(db, loaded.library, loaded.files);
    span.setAttributes({ 'askdocs.files': counts.files, 'askdocs.sections': counts.sections });

    return counts;
  });
}

/**
 * Keep local-folder libraries current: an edit re-indexes that library, debounced, so
 * agents never read yesterday's docs. Git sources are not watched; run `askdocs sync`
 * from CI or cron for those.
 *
 * In a checkout, the rules that decide what is indexed are watched too: every
 * `.gitignore` from the folder up to the repo root, `.git/info/exclude`, and git's index
 * (so `git rm --cached` counts). Ignore a doc and it leaves the index.
 */
// Watches the libraries that exist at startup; a change re-indexes its library.
export async function watchLibraries(
  db: Database,
  options: {
    debounceMs?: number;
    /**
     * Also compare each library's fingerprint this often, and re-index if it changed. File
     * events can be missed (right after a watch starts, when the OS coalesces them, or in a
     * directory created a moment ago); this makes a missed event cost a delay, not a stale index.
     */
    rescanMs?: number;
    onSync?: (id: string, result: { sections: number } | Error) => void;
  } = {},
): Promise<() => void> {
  const stops: (() => void)[] = [];

  for (const lib of listLibraries(db, 'all')) {
    if (isGitUrl(lib.source) || isLlmsTxt(lib.source)) continue;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> | undefined;
    let again = false;
    // Unknown until the first sync: the index may predate edits made while nothing was watching.
    let seen: string | undefined;

    const fail = (cause: unknown) =>
      options.onSync?.(lib.id, cause instanceof Error ? cause : new Error(String(cause)));

    const resync = () => {
      if (running) {
        again = true;

        return;
      }

      // Fingerprint before reading: a file changed mid-sync then differs on the next check, instead
      // of being recorded as already indexed.
      running = fingerprint(lib.source, lib.include ?? '')
        .catch(() => '')
        .then(async (before) => {
          const r = await syncLibrary(db, lib);
          seen = before;
          options.onSync?.(lib.id, r);
        })
        .catch(fail)
        .finally(() => {
          running = undefined;

          if (again) {
            again = false;
            resync();
          }
        });
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(resync, options.debounceMs ?? 300);
    };

    const watchPath = (path: string, recursive: boolean, relevant: (file: string | null) => boolean) => {
      try {
        const watcher = watch(path, { recursive }, (_event, file) => {
          if (relevant(file)) schedule();
        });

        // Watch failures (folder deleted, OS watch limits) arrive as events; unhandled, they would kill the server.
        watcher.on('error', fail);
        stops.push(() => watcher.close());
      } catch (error) {
        fail(error);
      }
    };

    watchPath(lib.source, true, (file) => !file || !ignoredChange(file));

    try {
      const checkout = await gitCheckout(lib.source);

      if (checkout) {
        // Git reports resolved paths (/private/var on macOS), so compare resolved paths.
        const [source, root] = await Promise.all([realpath(lib.source), realpath(checkout.root)]);

        for (let d = dirname(source); d === root || d.startsWith(root + sep); d = dirname(d)) {
          watchPath(d, false, (file) => file === '.gitignore');

          if (d === root) break;
        }

        watchPath(checkout.gitDir, false, (file) => file === 'index');
        const info = join(checkout.gitDir, 'info');

        if (
          await stat(info).then(
            () => true,
            () => false,
          )
        )
          watchPath(info, false, (file) => file === 'exclude');
      }
    } catch (error) {
      fail(error);
    }

    // The periodic check: once soon after starting (covering the window before the OS delivers
    // events), then every rescanMs.
    const check = async () => {
      if (running || !lib.include) return;
      const now = await fingerprint(lib.source, lib.include).catch(() => undefined);

      // Re-checked after the await: the startup check and the first interval can overlap.
      if (now !== undefined && now !== seen && !running) resync();
    };

    const every = options.rescanMs ?? 60_000;
    const first = setTimeout(() => void check(), Math.min(every, 2_000));
    const interval = setInterval(() => void check(), every);
    first.unref();
    interval.unref();
    stops.push(() => {
      clearTimeout(timer);
      clearTimeout(first);
      clearInterval(interval);
    });
  }

  return () => {
    for (const stop of stops) stop();
  };
}

/** Changes that cannot affect the index: inside node_modules or a dot-directory. A `.gitignore` always can. */
function ignoredChange(file: string): boolean {
  const parts = file.split(/[\\/]/);

  if (parts.at(-1) === '.gitignore') return false;

  return parts.some(skipDir);
}
