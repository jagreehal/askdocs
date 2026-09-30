import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctor } from './doctor';

/** A git project whose path has spaces in it, as plenty of real ones do. */
async function project(mcpJson?: string) {
  const dir = join(await mkdtemp(join(tmpdir(), 'askdocs doctor ')), 'my docs repo');
  await mkdir(join(dir, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(join(dir, 'docs', 'guide.md'), '# Guide\n\n## Setup\n\nRun it.\n');

  if (mcpJson !== undefined) {
    await writeFile(join(dir, '.mcp.json'), mcpJson);
  }

  return dir;
}

const run = async (dir: string) =>
  doctor({ cwd: dir, folders: [], dbFile: join(dir, 'nothing-here', 'docs.db') });

const mcp = (args: string[], command = 'npx') => JSON.stringify({ mcpServers: { docs: { command, args } } });

const status = (checks: Awaited<ReturnType<typeof run>>, label: RegExp) =>
  checks.find((c) => label.test(c.label))?.ok;

describe('askdocs doctor', () => {
  it('reports Node, SQLite/FTS5 and what it would index, and changes nothing', async () => {
    const dir = await project(mcp(['-y', 'askdocs']));
    const checks = await run(dir);
    expect(status(checks, /^Node /)).toBe(true);
    expect(status(checks, /^SQLite .* with FTS5$/)).toBe(true);
    expect(checks.find((c) => c.label.includes('my docs repo'))).toMatchObject({
      ok: true,
      label: expect.stringMatching(/1 files, 1 sections/),
      detail: expect.stringMatching(/git checkout, .gitignore applies/),
    });
    expect(status(checks, /\.mcp\.json "docs" starts askdocs/)).toBe(true);
    expect(checks.some((c) => c.ok === false)).toBe(false);
    expect(existsSync(join(dir, 'nothing-here'))).toBe(false);
  });

  it('flags an .mcp.json that would not start askdocs, and says how to fix it', async () => {
    const cases: [string, boolean | 'warn', RegExp][] = [
      [mcp(['askdocs']), false, /-y/],
      [mcp(['-y', 'docs-mcp']), false, /now askdocs/],
      [mcp(['./node_modules/askdocs/dist/cli.js'], 'node'), false, /does not exist/],
      [mcp(['-y', 'askdocs', 'serve']), 'warn', /persistent index/],
      ['{ not json', false, /./],
      [
        JSON.stringify({ mcpServers: { other: { command: 'uvx', args: ['something'] } } }),
        'warn',
        /claude mcp add docs -- npx -y askdocs/,
      ],
    ];

    for (const [config, ok, hint] of cases) {
      const check = (await run(await project(config))).find((c) => c.label.includes('.mcp.json'));
      expect({ config, ok: check?.ok, hint: hint.test(`${check?.label} ${check?.detail}`) }).toEqual({
        config,
        ok,
        hint: true,
      });
    }
  });

  it('fails a folder with no Markdown, pointing at the fix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'askdocs-empty-'));
    const check = (await run(dir)).find((c) => c.label.startsWith(dir));
    expect(check).toMatchObject({ ok: false, detail: expect.stringMatching(/askdocs serve docs\//) });
  });
});
