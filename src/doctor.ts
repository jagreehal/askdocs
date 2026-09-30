import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { gitCheckout, loadSource } from './sources';
import { indexLibrary, openStore, SCHEMA_VERSION } from './store';

export type Check = { ok: boolean | 'warn'; label: string; detail?: string };

/**
 * Everything that has to be true for `askdocs` to work in this folder, checked the way it
 * would actually run: the folder is really indexed (in memory), not just listed.
 */
export async function doctor(args: { cwd: string; folders: string[]; dbFile: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const node = process.versions.node;
  const nodeOk = Number(node.split('.')[0]) >= 24;
  const nodeCheck: Check = { ok: nodeOk, label: `Node ${node}` };

  if (!nodeOk) nodeCheck.detail = 'askdocs needs 24 or newer';

  checks.push(nodeCheck);

  try {
    const db = openStore();

    const { version } = z
      .object({ version: z.string() })
      .parse(db.prepare('SELECT sqlite_version() AS version').get());

    checks.push({ ok: true, label: `SQLite ${version} with FTS5` });
  } catch (error) {
    checks.push({
      ok: false,
      label: 'SQLite FTS5',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  for (const folder of args.folders.length ? args.folders : ['.']) {
    const dir = resolve(args.cwd, folder);

    try {
      const checkout = await gitCheckout(dir);
      const started = performance.now();
      const { library, files, skipped } = await loadSource(dir);
      const { sections } = indexLibrary(openStore(), library, files);
      const ms = Math.round(performance.now() - started);

      const where = checkout
        ? `git checkout${library.repo ? ` of github.com/${library.repo}` : ''}, .gitignore applies`
        : 'not a git checkout, every Markdown file counts';

      checks.push({
        ok: files.length > 0,
        label: `${dir}: ${files.length} files, ${sections} sections, indexed in ${ms} ms`,
        detail: files.length
          ? where
          : `${where}. No Markdown here: point askdocs at your docs, e.g. \`askdocs serve docs/\``,
      });

      if (skipped.length) {
        checks.push({
          ok: 'warn',
          label: `skipped ${skipped.length} symlink(s) pointing outside ${dir}`,
          detail: skipped.join(', '),
        });
      }
    } catch (error) {
      checks.push({ ok: false, label: dir, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  checks.push(persistentIndex(args.dbFile));
  checks.push(...mcpConfig(args.cwd));

  return checks;
}

function persistentIndex(file: string): Check {
  if (!existsSync(file)) {
    return {
      ok: true,
      label: `No persistent index at ${file}`,
      detail: 'fine for zero-config use; `askdocs add` creates it',
    };
  }

  try {
    const db = new DatabaseSync(file, { readOnly: true });

    const { user_version: version } = z
      .object({ user_version: z.number() })
      .parse(db.prepare('PRAGMA user_version').get());

    const tables = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'libraries'`).get();

    const libraries = tables
      ? z.object({ n: z.number() }).parse(db.prepare('SELECT count(*) AS n FROM libraries').get()).n
      : 0;

    db.close();

    if (version > SCHEMA_VERSION) {
      return {
        ok: false,
        label: `Index ${file} is from a newer askdocs (format ${version})`,
        detail: 'upgrade askdocs',
      };
    }

    const upgrade =
      version < SCHEMA_VERSION ? `; format ${version} upgrades to ${SCHEMA_VERSION} when next opened` : '';

    return { ok: true, label: `Index ${file}: ${libraries} libraries${upgrade}` };
  } catch (error) {
    return {
      ok: false,
      label: `Index ${file}`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const ServerEntry = z
  .object({ command: z.string().optional(), args: z.array(z.string()).optional() })
  .loose();

const McpJson = z.object({ mcpServers: z.record(z.string(), ServerEntry).optional() }).loose();

type ServerEntry = z.infer<typeof ServerEntry>;

/** Whether the project's .mcp.json would actually start askdocs. */
function mcpConfig(cwd: string): Check[] {
  const suggestion =
    'claude mcp add docs -- npx -y askdocs   (or commit .mcp.json: {"mcpServers":{"docs":{"command":"npx","args":["-y","askdocs"]}}})';

  const file = join(cwd, '.mcp.json');

  if (!existsSync(file))
    return [{ ok: 'warn', label: 'No .mcp.json in this folder', detail: `to set up: ${suggestion}` }];

  let servers: Record<string, ServerEntry>;

  try {
    servers = McpJson.parse(JSON.parse(readFileSync(file, 'utf8'))).mcpServers ?? {};
  } catch (error) {
    return [
      { ok: false, label: '.mcp.json is not a valid MCP config', detail: String(error).split('\n')[0] },
    ];
  }

  const mentions = (s: ServerEntry, name: string) =>
    [s.command ?? '', ...(s.args ?? [])].some((a) => a.includes(name));

  const ours = Object.entries(servers).filter(([, s]) => mentions(s, 'askdocs') || mentions(s, 'docs-mcp'));

  // Not broken: askdocs may be configured per user (`claude mcp add`) rather than per project.
  if (!ours.length) {
    return [
      {
        ok: 'warn',
        label: '.mcp.json has no server that runs askdocs',
        detail: `to add it for everyone: ${suggestion}`,
      },
    ];
  }

  return ours.map(([name, s]): Check => {
    const args = s.args ?? [];

    if (mentions(s, 'docs-mcp')) {
      return {
        ok: false,
        label: `.mcp.json "${name}" runs docs-mcp`,
        detail: 'the package is now askdocs: use ["-y", "askdocs"]',
      };
    }

    if (s.command === 'npx' && !args.includes('-y') && !args.includes('--yes')) {
      return {
        ok: false,
        label: `.mcp.json "${name}": npx without -y`,
        detail:
          'npx would stop to ask before installing, and an MCP client cannot answer. Use ["-y", "askdocs", ...]',
      };
    }

    if (s.command === 'node') {
      const script = args.find((a) => a.endsWith('.js'));

      if (script && !existsSync(resolve(cwd, script))) {
        return {
          ok: false,
          label: `.mcp.json "${name}": ${script} does not exist`,
          detail: 'build askdocs, or use npx -y askdocs',
        };
      }
    }

    if (args.includes('serve') && args.indexOf('serve') === args.length - 1) {
      return {
        ok: 'warn',
        label: `.mcp.json "${name}" runs \`askdocs serve\` with no folder`,
        detail:
          'that serves the persistent index (needs `askdocs add`). For this folder, drop "serve" or name folders after it',
      };
    }

    return { ok: true, label: `.mcp.json "${name}" starts askdocs` };
  });
}
