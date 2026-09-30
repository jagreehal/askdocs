import { createServer as createNetServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { definePolicy, type PolicySpec } from 'mcp-authz';
import { listenMcp } from 'mcp-authz/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Access, RepoReader } from './access';
import { createHttpHandler, devAuth } from './http';
import { indexLibrary, openStore, queryStats, recentAudit } from './store';

/**
 * The experiment, as a test: two engineers point the same agent at the same
 * remote MCP server and ask the same question. Real HTTP, real signed tokens,
 * the real mcp-authz policy, the real index.
 */

const RUNBOOK = `# Payout reconciliation runbook

## When the reconciliation job fails

Page the payments on-call, then replay the failed payout batch from the ledger snapshot.
`;

const OVERVIEW = `# Engineering handbook

## Payments

The payments team owns payout reconciliation. Ask in #payments.
`;

type ToolArgs = Record<string, string | number | boolean>;

const ToolText = z.object({ content: z.array(z.object({ text: z.string() })) });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, () => {
      const { port } = z.object({ port: z.number() }).parse(s.address());
      s.close(() => resolve(port));
    });
  });
}

async function startServer(access: Access, deps: { canReadRepo?: RepoReader } = {}) {
  const port = await freePort();
  const db = openStore();
  indexLibrary(db, { id: 'acme/payments-docs', source: 'test', repo: 'acme/payments' }, [
    { path: 'runbooks/reconciliation.md', text: RUNBOOK },
  ]);
  indexLibrary(db, { id: 'acme/engineering', source: 'test' }, [{ path: 'handbook.md', text: OVERVIEW }]);

  const auth = devAuth({ port, keysFile: join(mkdtempSync(join(tmpdir(), 'askdocs-keys-')), 'k.json') });
  const handler = createHttpHandler({ db, access, ...auth }, deps);
  const server = await listenMcp(auth.wrap(handler), { port, name: 'askdocs-test' });

  const connect = async (email: string, claims: Record<string, string | string[]> = {}) => {
    const token = await auth.mint(email, claims);
    const client = new Client({ name: 'claude-code', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(auth.resourceServerUrl, {
        authProvider: { token: async () => token },
      }),
    );

    const call = async (name: string, args: ToolArgs) => {
      const result = await client.callTool({ name, arguments: args });

      return ToolText.parse(result)
        .content.map((c) => c.text)
        .join('\n');
    };

    return { client, call };
  };

  return { server, db, connect };
}

// Typed as PolicySpec, like loadAccess: library ids are open-ended strings, not a fixed literal set.
const policy = definePolicy<PolicySpec>({
  roles: {
    engineer: ['acme/engineering'],
    payments: ['acme/engineering', 'acme/payments-docs'],
  },
  rules: [
    { match: { domain: 'acme.com' }, role: 'engineer' },
    { match: { claim: { groups: 'payments' } }, role: 'payments' },
  ],
});

describe('policy-scoped retrieval over HTTP', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer({ policy });
  });
  afterAll(() => {
    ctx.server.close();
  });

  const QUESTION = 'What happens if the payout reconciliation job fails?';

  it('Alice, on the payments team, gets the payments runbook', async () => {
    const alice = await ctx.connect('alice@acme.com', { groups: ['payments'] });
    const found = await alice.call('search_docs', { query: QUESTION });
    expect(found.split('\n')[0]).toContain('acme/payments-docs · runbooks/reconciliation.md');
    expect(await alice.call('list_libraries', {})).toContain('acme/payments-docs');
  });

  it('Bob asks the same thing and only ever sees the general handbook', async () => {
    const bob = await ctx.connect('bob@acme.com');
    const found = await bob.call('search_docs', { query: QUESTION });
    expect(found).toContain('acme/engineering · handbook.md');
    expect(found).not.toContain('payments-docs');
    expect(await bob.call('list_libraries', {})).not.toContain('payments-docs');

    // Knowing the exact path does not help, and the answer does not confirm it exists.
    const read = await bob.call('read_doc', {
      library: 'acme/payments-docs',
      path: 'runbooks/reconciliation.md',
    });

    expect(read).toBe(
      'Unknown library "acme/payments-docs". Call list_libraries to see the libraries you can search.',
    );
    // Nor does asking for it by library.
    expect(await bob.call('search_docs', { query: 'replay payout', library: 'acme/payments-docs' })).toMatch(
      /^Unknown library "acme\/payments-docs"/,
    );
  });

  it('someone outside the company is refused before any tool runs', async () => {
    await expect(ctx.connect('sam@other.com')).rejects.toThrow(/403|forbidden/i);
  });

  it('audits who asked, through which agent, what they were allowed and what they got', () => {
    const events = recentAudit(ctx.db, 50);
    const bobs = events.find((e) => e.principal === 'bob@acme.com' && e.tool === 'read_doc')!;
    expect(bobs).toMatchObject({ agent: 'dev-cli', allowed: '["acme/engineering"]', returned: '[]' });
    const alices = events.find((e) => e.principal === 'alice@acme.com' && e.tool === 'search_docs')!;
    expect(JSON.parse(alices.allowed)).toEqual(['acme/engineering', 'acme/payments-docs']);
  });

  it('tells a missing doc apart from one the asker could not see', async () => {
    const bob = await ctx.connect('bob@acme.com');
    await bob.call('search_docs', { query: 'replay ledger snapshot' });
    await bob.call('search_docs', { query: 'what is our SLO' });
    const gaps = Object.fromEntries(queryStats(ctx.db).gaps.map((g) => [g.query, g.kind]));
    expect(gaps).toMatchObject({ 'replay ledger snapshot': 'restricted', 'what is our SLO': 'missing' });
  });
});

describe('GitHub decides for docs that live in a GitHub repo', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  let revoked = false;
  beforeAll(async () => {
    // The policy lets every acme.com engineer in; GitHub then decides repo by repo.
    const everyone = definePolicy<PolicySpec>({
      roles: { all: ['*'] },
      rules: [{ match: { domain: 'acme.com' }, role: 'all' }],
    });

    ctx = await startServer(
      { policy: everyone, github: { loginClaim: 'github_login', ttlSeconds: 0 } },
      { canReadRepo: async (login, repo) => login === 'alice-gh' && repo === 'acme/payments' && !revoked },
    );
  });
  afterAll(() => {
    ctx.server.close();
  });

  it('serves the repo-backed library only to GitHub logins that can read the repo, and not after access is revoked', async () => {
    const alice = await ctx.connect('alice@acme.com', { github_login: 'alice-gh' });
    const bob = await ctx.connect('bob@acme.com', { github_login: 'bob-gh' });
    const noLogin = await ctx.connect('carol@acme.com');

    expect(await alice.call('list_libraries', {})).toContain('acme/payments-docs');
    expect(await bob.call('list_libraries', {})).not.toContain('acme/payments-docs');
    expect(await noLogin.call('list_libraries', {})).not.toContain('acme/payments-docs');
    // A library with no repo behind it is governed by the policy alone.
    expect(await bob.call('list_libraries', {})).toContain('acme/engineering');

    // An authorization server that forgot to put the GitHub login in the token is visible, not silent.
    expect(await noLogin.call('list_libraries', {})).toContain('did not include a GitHub username');
    expect(await bob.call('list_libraries', {})).not.toContain('GitHub username');

    revoked = true;
    const later = await ctx.connect('alice@acme.com', { github_login: 'alice-gh' });
    expect(await later.call('list_libraries', {})).not.toContain('acme/payments-docs');
  });
});
