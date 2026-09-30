import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { definePolicy, type PolicySpec } from 'mcp-authz';
import { listenMcp } from 'mcp-authz/node';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { devAuth } from './http';
import { handler, lambdaHandler, toRequest, type IndexSource } from './lambda';
import { exportIndex, indexLibrary, openStore } from './store';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, () => {
      const { port } = z.object({ port: z.number() }).parse(s.address());
      s.close(() => resolve(port));
    });
  });
}

const dump = (text: string) => {
  const db = openStore();
  indexLibrary(db, { id: 'payments', source: 'https://github.com/acme/payments' }, [
    { path: 'runbook.md', text },
  ]);

  return JSON.stringify(exportIndex(db));
};

const V1 = dump(
  '# Runbook\n\n## Reconciliation\n\nReplay the failed payout batch from the ledger snapshot.\n',
);

const V2 = dump(
  '# Runbook\n\n## Reconciliation\n\nReconciliation now retries on its own; nothing to replay.\n',
);

const access = {
  policy: definePolicy<PolicySpec>({
    roles: { reader: ['*'] },
    rules: [{ match: { domain: 'acme.com' }, role: 'reader' }],
  }),
};

// The signing keys are fetched over HTTP, as from a real authorization server.
const port = await freePort();

const auth = devAuth({ port, keysFile: join(mkdtempSync(join(tmpdir(), 'askdocs-keys-')), 'k.json') });

const jwks = await listenMcp(
  auth.wrap(async () => new Response('not found', { status: 404 })),
  { port },
);

afterAll(() => jwks.close());

afterEach(() => vi.restoreAllMocks());

/** An MCP client whose requests reach the handler as API Gateway events, and come back from its results. */
async function connect(handle: ReturnType<typeof lambdaHandler>, email: string) {
  const token = await auth.mint(email);

  const fetch = async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    const result = await handle({
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(request.headers),
      body: Buffer.from(await request.arrayBuffer()).toString('base64'),
      isBase64Encoded: true,
      requestContext: { domainName: url.host, http: { method: request.method } },
    });

    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };

  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(auth.resourceServerUrl, {
      fetch,
      authProvider: { token: async () => token },
    }),
  );

  return async (query: string) => {
    const result = await client.callTool({ name: 'search_docs', arguments: { query } });

    return z
      .object({ content: z.array(z.object({ text: z.string() })) })
      .parse(result)
      .content.map((c) => c.text)
      .join('\n');
  };
}

const handlerFor = (index: IndexSource, refreshSeconds = 0) =>
  lambdaHandler({ index, refreshSeconds, access, ...auth });

describe('askdocs on Lambda', () => {
  it('answers MCP over API Gateway events, and audits each call to the log as JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const search = await connect(
      handlerFor(async (loaded) => (loaded ? undefined : { text: V1, version: 'v1' })),
      'alice@acme.com',
    );

    expect(await search('replay failed payout batch')).toMatch(/runbook\.md/);

    const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(entries).toContainEqual(
      expect.objectContaining({ message: 'askdocs audit', principal: 'alice@acme.com', tool: 'search_docs' }),
    );
  });

  it('refuses a caller without a token, as the server does anywhere else', async () => {
    const handle = handlerFor(async () => ({ text: V1, version: 'v1' }));

    const result = await handle({
      rawPath: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      requestContext: { domainName: `localhost:${port}`, http: { method: 'POST' } },
    });

    expect(result.statusCode).toBe(401);
  });

  it('picks up a newly published index without a redeploy, and survives a bad one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let published = { text: V1, version: 'v1' };
    const index: IndexSource = async (loaded) => (loaded === published.version ? undefined : published);
    const search = await connect(handlerFor(index, 0.001), 'alice@acme.com');

    expect(await search('replay failed payout batch')).toMatch(/ledger snapshot/);

    published = { text: V2, version: 'v2' };
    await new Promise((r) => setTimeout(r, 5));
    expect(await search('reconciliation retries')).toMatch(/nothing to replay/);

    published = { text: '{"not": "an index"}', version: 'v3' };
    await new Promise((r) => setTimeout(r, 5));
    expect(await search('reconciliation retries')).toMatch(/nothing to replay/);
  });

  it("routes a request under a custom domain's API mapping, whose prefix API Gateway strips", async () => {
    const mapped = lambdaHandler({
      index: async (loaded) => (loaded ? undefined : { text: V1, version: 'v1' }),
      refreshSeconds: 0,
      access,
      ...auth,
      resourceServerUrl: new URL(`http://localhost:${port}/docs/mcp`),
    });

    // docs.acme.com/docs/mcp, mapped at /docs, arrives as /mcp: MCP's challenge, not "not found".
    const result = await mapped({
      rawPath: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      requestContext: { domainName: `localhost:${port}`, http: { method: 'POST' } },
    });

    expect(result.statusCode).toBe(401);
    expect(
      toRequest(
        { rawPath: '/other', requestContext: { domainName: 'd', http: { method: 'GET' } } },
        new URL('https://d/docs/mcp'),
      ).url,
    ).toBe('https://d/other');
  });

  it('starts from its environment, with index and access files outside the function root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'askdocs-layer-'));
    writeFileSync(join(dir, 'index.json'), V1);
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ policy: { roles: {}, rules: [] } }));

    // The authorization server's metadata, which startup discovers.
    const issuer = createServer((_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...auth.oauthMetadata, issuer: issuerUrl, jwks_uri: auth.jwksUri }));
    }).listen(0);

    await new Promise((resolve) => issuer.once('listening', resolve));
    const issuerUrl = `http://localhost:${z.object({ port: z.number() }).parse(issuer.address()).port}`;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    Object.assign(process.env, {
      LAMBDA_TASK_ROOT: join(dir, 'task'),
      ASKDOCS_INDEX: join(dir, 'index.json'),
      ASKDOCS_ACCESS_FILE: join(dir, 'access.json'),
      OAUTH_ISSUER: issuerUrl,
      MCP_PUBLIC_URL: auth.resourceServerUrl.href,
    });

    try {
      const result = await handler({
        rawPath: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        requestContext: { domainName: `localhost:${port}`, http: { method: 'POST' } },
      });

      expect(result.statusCode).toBe(401);
    } finally {
      issuer.close();

      for (const name of [
        'LAMBDA_TASK_ROOT',
        'ASKDOCS_INDEX',
        'ASKDOCS_ACCESS_FILE',
        'OAUTH_ISSUER',
        'MCP_PUBLIC_URL',
      ])
        delete process.env[name];
    }
  });

  it('decodes a base64 body and keeps the query string', async () => {
    const request = toRequest({
      rawPath: '/mcp',
      rawQueryString: 'a=1',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"x":1}').toString('base64'),
      isBase64Encoded: true,
      requestContext: { domainName: 'docs.acme.com', http: { method: 'POST' } },
    });

    expect(request.url).toBe('https://docs.acme.com/mcp?a=1');
    expect(await request.json()).toEqual({ x: 1 });
  });
});
