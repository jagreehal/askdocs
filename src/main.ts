import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { discoverOAuth } from 'mcp-authz';
import { listenMcp } from 'mcp-authz/node';
import { githubRepoReader, loadAccess } from './access';
import { createHttpHandler, devAuth } from './http';
import { doctor } from './doctor';
import { createServer } from './server';
import { loadSource, syncLibrary, toPosixPath, watchLibraries } from './sources';
import {
  exportIndex,
  indexLibrary,
  listLibraries,
  openStore,
  queryStats,
  recentAudit,
  removeLibrary,
} from './store';
import { startTelemetry } from './telemetry';
import { embedderFrom, embedLibrary } from './vectors';

const USAGE = `askdocs [command]

  (no command)                                     when started by an MCP client: serve the current folder,
                                                   indexed in memory and kept fresh. Nothing to set up.
  serve <dir...>                                   the same, for the folders you name

  add <dir|git-url|site/llms.txt> [--name id] [--include glob]
                                                   index (or re-index) a library
  sync [library]                                   re-index from each library's source (for CI or cron)
  remove <library>                                 drop a library from the index
  list                                             show indexed libraries
  stats                                            top queries, and gaps: missing docs vs restricted docs
  audit [--limit n]                                recent tool calls: who, which agent, what they got
  serve [--watch]                                  MCP over stdio, from the persistent index
                                                   --watch re-indexes local folders as they change
  serve --http --access <file> [--port 8300]       remote MCP; each caller sees only what they may read
        [--dev-auth]                               sign tokens locally instead of a real authorization server
  token <email> [--claim key=value ...]            mint a --dev-auth token
  publish <url>                                    upload the index to askdocs on Cloudflare (ASKDOCS_ADMIN_TOKEN)
  export <file>                                    write the index as one file, for askdocs on Lambda
  doctor [dir...]                                  check Node, SQLite/FTS5, what would be indexed, and .mcp.json

  --db <file>          index location (default $ASKDOCS_DB or ~/.askdocs/docs.db; in-memory when serving folders)
  --audit-days <n>     keep audit entries this many days (default $ASKDOCS_AUDIT_DAYS or 30; 0 keeps none)
  --otel               serve: export traces and metrics over OTLP to $OTEL_EXPORTER_OTLP_ENDPOINT (needs autotel)
  --embed <spec>       add, sync, serve: semantic search too (default $ASKDOCS_EMBED). Without it, keyword only.
                       ollama:<model>, openai:<model>, google:<model>, bedrock:<model>,
                       compatible:<model>?url=<endpoint>, optionally ?dimensions=<n>. Needs ai and the
                       provider's package; keys from the environment (OPENAI_API_KEY,
                       GOOGLE_GENERATIVE_AI_API_KEY, AWS credentials and AWS_REGION, ASKDOCS_EMBED_API_KEY).

  serve --http without --dev-auth reads OAUTH_ISSUER, MCP_PUBLIC_URL and optionally
  OAUTH_JWKS_URI; GITHUB_TOKEN when the access file has a "github" block.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    name: { type: 'string' },
    include: { type: 'string' },
    http: { type: 'boolean' },
    access: { type: 'string' },
    port: { type: 'string', default: '8300' },
    'dev-auth': { type: 'boolean' },
    watch: { type: 'boolean' },
    claim: { type: 'string', multiple: true },
    limit: { type: 'string', default: '50' },
    'audit-days': { type: 'string' },
    otel: { type: 'boolean' },
    embed: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

// Before anything else: --help must never open storage, index a folder or wait on stdin.
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

// An MCP client launches servers with piped stdin and the project as cwd, so a bare
// `askdocs` there means "serve this folder". In a terminal it prints usage instead.
const [command, ...args] = positionals.length || process.stdin.isTTY ? positionals : ['serve', '.'];

const arg = args[0];

const folders = command === 'serve' ? args : [];

const dbFile = values.db ?? process.env.ASKDOCS_DB ?? join(homedir(), '.askdocs', 'docs.db');

// Diagnosis must not change anything: it runs before any index is opened or created.
if (command === 'doctor') {
  const checks = await doctor({ cwd: process.cwd(), folders: args, dbFile });

  for (const c of checks) {
    const mark = c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗';
    console.log(`${mark} ${c.label}${c.detail ? `\n    ${c.detail}` : ''}`);
  }

  process.exit(checks.some((c) => c.ok === false) ? 1 : 0);
}

// Serving named folders needs no state on disk: index in memory unless --db asks to keep it (for stats).
const db = folders.length && !values.db ? openStore() : openPersistent(dbFile);

const port = Number(values.port);

const embedSpec = values.embed ?? process.env.ASKDOCS_EMBED;

const embedder = embedSpec
  ? await embedderFrom(embedSpec).catch((error: Error) => {
      console.error(`askdocs: ${error.message}`);
      process.exit(1);
    })
  : undefined;

if (embedder) {
  console.error(
    `askdocs: semantic search with ${embedder.id}: every section and every question is sent to ${embedder.destination ?? 'the embedding provider'}`,
  );
}

/** Give a library's sections vectors; only what changed since last time is embedded. */
async function embed(id: string) {
  if (!embedder) return;
  const started = performance.now();
  const { embedded, reused, superseded } = await embedLibrary(db, id, embedder);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    superseded
      ? `askdocs: ${id} was re-indexed while embedding (${seconds}s); the next run reuses this one's vectors`
      : `askdocs: embedded ${id}: ${embedded} new, ${reused} unchanged (${seconds}s)`,
  );
}

/** The index is written either way: a failed embedding leaves keyword search working, and says so. */
async function embedOrWarn(id: string) {
  try {
    await embed(id);
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `askdocs: could not embed ${id}, so it is searchable by keyword only: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// While serving, embedding runs behind the server, one run at a time per library: search answers
// by keyword until a library's vectors are ready, then by both.
const embedding = new Map<string, Promise<void>>();

const embedLater = (id: string) => {
  if (embedder)
    embedding.set(
      id,
      (embedding.get(id) ?? Promise.resolve()).then(() => embedOrWarn(id)),
    );
};

const dev = () => devAuth({ port, keysFile: ensureParentDir(join(dirname(dbFile), 'dev-auth.json')) });

switch (command) {
  case 'add': {
    if (!arg) fail('add needs a directory or git URL');
    const { library, files, skipped } = await loadSource(arg, { name: values.name, include: values.include });
    // Re-adding the same source re-indexes it. A *different* source under a derived id would silently
    // replace someone else's library, so that needs an explicit --name.
    const existing = listLibraries(db, 'all').find((l) => l.id === library.id);

    if (existing && existing.source !== library.source && !values.name) {
      fail(
        `${library.id} is already indexed from ${existing.source}. Pass --name to index ${library.source} as well.`,
      );
    }

    const counts = indexLibrary(db, library, files);
    const repo = library.repo ? ` (access follows github.com/${library.repo})` : '';
    console.log(`Indexed ${library.id}: ${counts.sections} sections from ${counts.files} files${repo}`);
    warnSkipped(library.id, skipped);
    await embedOrWarn(library.id);
    break;
  }

  case 'sync': {
    const libs = listLibraries(db, 'all').filter((l) => !arg || l.id === arg);

    if (arg && !libs.length) fail(`No library ${arg}`);
    let failed = 0;

    for (const library of libs) {
      try {
        const counts = await syncLibrary(db, library);
        console.log(`Synced ${library.id}: ${counts.sections} sections from ${counts.files} files`);
        await embedOrWarn(library.id);
      } catch (error) {
        failed++;
        console.error(
          `Failed to sync ${library.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failed) process.exit(1);
    break;
  }

  case 'publish': {
    if (!arg) fail('publish needs the URL askdocs is deployed at, e.g. https://docs.acme.com');
    // From the environment, not a flag: a token on the command line ends up in shell history and CI logs.
    const token = process.env.ASKDOCS_ADMIN_TOKEN;

    if (!token) fail('publish needs ASKDOCS_ADMIN_TOKEN, the ADMIN_TOKEN secret of the deployed Worker');
    const libs = listLibraries(db, 'all');

    if (!libs.length) fail(`Nothing to publish: ${dbFile} has no libraries. Add some with askdocs add.`);

    const res = await fetch(new URL('/admin/publish', arg), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(exportIndex(db)),
    });

    if (!res.ok) fail(`Publishing to ${arg} failed: ${res.status} ${await res.text()}`);
    console.log(`Published ${libs.map((l) => l.id).join(', ')} to ${arg}`);
    break;
  }

  case 'export': {
    if (!arg) fail('export needs a file to write, e.g. askdocs export index.json');
    const libs = listLibraries(db, 'all');

    if (!libs.length) fail(`Nothing to export: ${dbFile} has no libraries. Add some with askdocs add.`);
    writeFileSync(arg, JSON.stringify(exportIndex(db)));
    console.log(`Exported ${libs.map((l) => l.id).join(', ')} to ${arg}`);
    break;
  }

  case 'remove':
    if (!arg) fail('remove needs a library id');
    removeLibrary(db, arg);
    console.log(`Removed ${arg}`);
    break;
  case 'list':
    for (const l of listLibraries(db, 'all'))
      console.log(`${l.id}\t${l.sections} sections\t${l.repo ?? '-'}\t${l.indexedAt}\t${l.source}`);
    break;
  case 'stats': {
    const { top, gaps } = queryStats(db);
    console.log(
      'Top queries\n' + (top.map((q) => `${who(q)}  ${q.query}${lib(q.library)}`).join('\n') || '  (none)'),
    );
    console.log(
      '\nNo results\n' +
        (gaps.map((g) => `${who(g)}  ${g.kind.padEnd(10)}  ${g.query}${lib(g.library)}`).join('\n') ||
          '  (none)'),
    );
    console.log(
      '\n  missing: nothing in the index answers it. restricted: it exists, the askers cannot see it.',
    );
    break;
  }

  case 'audit':
    for (const e of recentAudit(db, Number(values.limit)).toReversed()) {
      console.log(`${e.at}  ${e.principal}  ${e.agent ?? '-'}  ${e.tool}  "${e.query}"`);
      console.log(`    allowed:  ${e.allowed}`);
      console.log(`    returned: ${e.returned}`);
    }

    break;
  case 'token': {
    if (!arg) fail('token needs an email');

    const claims = Object.fromEntries(
      (values.claim ?? []).map((c) => {
        const [key, ...rest] = c.split('=');
        const value = rest.join('=');

        return [key, value.includes(',') ? value.split(',') : value];
      }),
    );

    console.log(await dev().mint(arg, claims));
    break;
  }

  case 'serve': {
    // Flushes buffered telemetry; a no-op without --otel.
    const flush = values.otel ? await startTelemetry() : () => Promise.resolve();

    // An HTTP server drains on SIGTERM and then lets the event loop empty: flush then.
    if (values.otel) process.once('beforeExit', () => void flush());

    for (const [folder, id] of folderIds(folders, values.name)) {
      const { library, files, skipped } = await loadSource(folder, { name: id, include: values.include });
      const counts = indexLibrary(db, library, files);
      console.error(
        `askdocs: serving ${library.id} (${counts.sections} sections from ${counts.files} files)`,
      );
      warnSkipped(library.id, skipped);
    }

    for (const indexed of listLibraries(db, 'all')) embedLater(indexed.id);

    if (values.watch || folders.length) {
      // stderr only: over stdio, stdout is the MCP protocol.
      await watchLibraries(db, {
        onSync: (id, result) => {
          console.error(
            result instanceof Error
              ? `askdocs: re-index of ${id} failed: ${result.message}`
              : `askdocs: re-indexed ${id} (${result.sections} sections)`,
          );

          if (!(result instanceof Error)) embedLater(id);
        },
      });
    }

    if (!values.http) {
      // One person, one machine: the OS account is the boundary, so everything indexed is in scope.
      const caller = { principal: userInfo().username, agent: 'stdio', scope: 'all' as const };
      await createServer(db, caller, { embedder }).connect(new StdioServerTransport());
      // The client closing stdin ends the session (and SIGTERM is its fallback). Exit then, rather
      // than let the folder watcher keep an orphaned server alive.
      const exit = () => void flush().finally(() => process.exit(0));
      process.stdin.once('end', exit);
      process.once('SIGTERM', exit);
      process.once('SIGINT', exit);
      break;
    }

    // Fail closed: a remote server with no access file would serve every library to anyone with a token.
    if (!values.access) fail('serve --http needs --access <file>');
    const access = loadAccess(values.access);
    const github = access.github;

    if (github && !process.env.GITHUB_TOKEN)
      fail('the access file has a "github" block, so GITHUB_TOKEN is required');

    const deps =
      github && process.env.GITHUB_TOKEN
        ? {
            canReadRepo: githubRepoReader({ token: process.env.GITHUB_TOKEN, ttlSeconds: github.ttlSeconds }),
          }
        : {};

    if (values['dev-auth']) {
      const auth = dev();
      const handler = createHttpHandler({ db, access, embedder, ...auth }, deps);
      await listenMcp(auth.wrap(handler), {
        port,
        name: 'askdocs',
        info: {
          resource: auth.resourceServerUrl.href,
          auth: 'DEV: tokens from `askdocs token`, not a real login',
        },
      });
      break;
    }

    const issuer = process.env.OAUTH_ISSUER;
    const publicUrl = process.env.MCP_PUBLIC_URL;

    if (!issuer || !publicUrl) fail('serve --http needs OAUTH_ISSUER and MCP_PUBLIC_URL (or --dev-auth)');

    const handler = createHttpHandler(
      {
        db,
        access,
        resourceServerUrl: new URL(publicUrl),
        oauthMetadata: await discoverOAuth(issuer),
        jwksUri: process.env.OAUTH_JWKS_URI,
        embedder,
      },
      deps,
    );

    await listenMcp(handler, { port, name: 'askdocs', info: { resource: publicUrl, issuer } });
    break;
  }

  default:
    console.log(USAGE);
    process.exit(1);
}

/**
 * One library id per folder. The folder name when that is unique; otherwise the path as
 * typed, so `serve a/docs b/docs` gives `a/docs` and `b/docs` rather than one `docs`
 * silently replacing the other. The same folder named twice is served once.
 */
function folderIds(dirs: string[], name?: string): Map<string, string> {
  const unique = [...new Set(dirs.map((d) => resolve(d)))];

  if (name && unique.length === 1) return new Map([[unique[0]!, name]]);
  const clash = (abs: string) => unique.filter((other) => basename(other) === basename(abs)).length > 1;

  return new Map(
    unique.map((abs) => [abs, clash(abs) ? toPosixPath(relative(process.cwd(), abs) || abs) : basename(abs)]),
  );
}

function warnSkipped(id: string, skipped: string[]) {
  if (skipped.length) {
    console.error(
      `askdocs: ${id}: skipped ${skipped.length} symlink(s) pointing outside the folder: ${skipped.join(', ')}`,
    );
  }
}

function openPersistent(file: string) {
  // Queries can contain whatever people paste, so the audit log is not kept forever by default.
  const days = Number(values['audit-days'] ?? process.env.ASKDOCS_AUDIT_DAYS ?? 30);

  if (!Number.isInteger(days) || days < 0) fail('--audit-days must be a whole number of days, 0 or more');

  return openStore(ensureParentDir(file), { auditRetentionDays: days });
}

function ensureParentDir(file: string) {
  mkdirSync(dirname(file), { recursive: true });

  return file;
}

function who(q: { asks: number; people: number }) {
  return `${String(q.asks).padStart(5)} asks ${String(q.people).padStart(3)} people`;
}

function lib(library: string | null) {
  return library ? `  [${library}]` : '';
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}
