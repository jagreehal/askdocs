import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The one-person, one-folder case, through the built CLI exactly as an MCP client
 * launches it: `askdocs` with no arguments, stdin piped, cwd = the project.
 */
const ToolText = z.object({ content: z.array(z.object({ text: z.string() })) });

const CLI = resolve(import.meta.dirname, '../dist/cli.js');

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'askdocs-project-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await mkdir(join(dir, 'docs'));
  await mkdir(join(dir, 'dist'));
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(dir, '.changeset'));
  await writeFile(join(dir, '.gitignore'), 'dist\nnode_modules\n');
  await writeFile(
    join(dir, 'README.md'),
    '# Payments service\n\n## Deploying\n\nMerge to main; the pipeline ships it.\n',
  );
  await writeFile(
    join(dir, 'docs', 'retries.md'),
    '# Retries\n\n## Idempotency\n\nEvery payout carries an idempotency key.\n',
  );
  await writeFile(join(dir, 'dist', 'retries.md'), '# Stale build copy\n\nidempotency key, but old.\n');
  await writeFile(
    join(dir, 'node_modules', 'dep', 'README.md'),
    '# Dependency\n\nidempotency key in a dependency.\n',
  );
  await writeFile(join(dir, '.changeset', 'x.md'), '---\n---\nidempotency key changeset note\n');

  return dir;
}

async function launch(cwd: string, home: string) {
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      cwd,
      // The full environment (Windows children need SystemRoot and friends), with home pointed elsewhere.
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'ignore',
    }),
  );

  const call = async (name: string, args: Record<string, string | number | boolean>) =>
    ToolText.parse(await client.callTool({ name, arguments: args })).content[0]!.text;

  return { client, call };
}

describe('zero setup: `askdocs` in a project folder', () => {
  it('serves the folder with no arguments, no add step and nothing written to $HOME', async () => {
    const dir = await project();
    const home = await mkdtemp(join(tmpdir(), 'askdocs-home-'));
    const { client, call } = await launch(dir, home);

    try {
      const found = await call('search_docs', { query: 'idempotency key' });
      expect(found.split('\n')[0]).toMatch(/· docs\/retries\.md · Retries > Idempotency$/);
      // .gitignore'd build output, dependencies and dot-directories never reach the index.
      expect(found).not.toMatch(/dist\/|node_modules|\.changeset/);
      expect(existsSync(join(home, '.askdocs'))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('sees an edit a moment after it is saved', async () => {
    const dir = await project();
    const { client, call } = await launch(dir, await mkdtemp(join(tmpdir(), 'askdocs-home-')));

    try {
      expect(await call('search_docs', { query: 'rollback' })).toContain('No results');
      await writeFile(join(dir, 'docs', 'rollback.md'), '# Rollback\n\nRevert the release tag.\n');
      await expect
        .poll(async () => (await call('search_docs', { query: 'rollback' })).split('\n')[0], {
          timeout: 4000,
        })
        .toMatch(/docs\/rollback\.md/);
    } finally {
      await client.close();
    }
  });
});

describe('the command line', () => {
  it('prints usage for --help even when stdin is piped, without serving anything', () => {
    const out = execFileSync(process.execPath, [CLI, '--help'], {
      cwd: tmpdir(),
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(out).toContain('askdocs [command]');
  });

  it('serves two folders with the same name as two libraries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'askdocs-twins-'));

    for (const team of ['payments', 'platform']) {
      await mkdir(join(root, team, 'docs'), { recursive: true });
      await writeFile(join(root, team, 'docs', 'readme.md'), `# ${team}\n\nThe ${team} runbook.\n`);
    }

    const client = new Client({ name: 'claude-code', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', 'payments/docs', 'platform/docs'],
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root },
        stderr: 'ignore',
      }),
    );

    try {
      const libs = ToolText.parse(await client.callTool({ name: 'list_libraries', arguments: {} }))
        .content[0]!.text;

      expect(libs).toContain('payments/docs');
      expect(libs).toContain('platform/docs');
    } finally {
      await client.close();
    }
  });

  it('refuses to let `add` replace a different folder that happens to share a name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'askdocs-add-'));

    for (const team of ['payments', 'platform']) {
      await mkdir(join(root, team, 'docs'), { recursive: true });
      await writeFile(join(root, team, 'docs', 'readme.md'), `# ${team}\n\nx\n`);
    }

    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args, '--db', join(root, 'i.db')], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });

    run('add', 'payments/docs');
    expect(() => run('add', 'platform/docs')).toThrow(/already indexed from .*payments.*--name/s);
    run('add', 'platform/docs', '--name', 'platform-docs');
    run('add', 'payments/docs'); // re-adding the same folder still re-indexes it
    expect(run('list')).toMatch(/docs\t.*payments[\s\S]*platform-docs/);
  });
});

describe('on an unsupported Node', () => {
  const nvm = join(process.env.HOME ?? '', '.nvm', 'versions', 'node');

  const old = ['v20.12.0', 'v22.14.0'].flatMap((v) => {
    const node = join(nvm, v, 'bin', 'node');

    return existsSync(node) ? [node] : [];
  });

  it.skipIf(!old.length)('fails with one line that says which Node to install', () => {
    for (const node of old) {
      let failure: { status: number; stderr: string } | undefined;

      try {
        execFileSync(node, [CLI, '--help'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        failure = z.object({ status: z.number(), stderr: z.string() }).parse(error);
      }

      expect(failure?.status).toBe(1);
      expect(failure?.stderr.trim().split('\n')).toEqual([
        expect.stringMatching(
          /^askdocs needs Node\.js 24 or newer; this is Node 2[02]\.\d+\.\d+\. Install .*nodejs\.org/,
        ),
      ]);
    }
  });
});
