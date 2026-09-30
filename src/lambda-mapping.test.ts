import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { definePolicy, discoverOAuth, type PolicySpec } from 'mcp-authz';
import { OAuth2Server, type MutableToken, type TokenRequestIncomingMessage } from 'oauth2-mock-server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { lambdaHandler } from './lambda';
import { exportIndex, indexLibrary, openStore } from './store';

/**
 * askdocs at https://docs.acme.com/docs/mcp: a custom domain whose `/docs` API mapping points at
 * the askdocs Lambda (API Gateway strips `/docs`), and whose root mapping answers OAuth discovery,
 * which clients look for at the domain's root. A real MCP client signs in at a real (mock)
 * authorization server and calls a tool.
 */

const as = new OAuth2Server();

await as.issuer.keys.generate('RS256');

await as.start(0, 'localhost');

const gateway = createServer();

await new Promise<void>((resolve) => gateway.listen(0, 'localhost', resolve));

const domain = `http://localhost:${z.object({ port: z.number() }).parse(gateway.address()).port}`;

const RESOURCE = `${domain}/docs/mcp`;

afterAll(async () => {
  gateway.close();
  await as.stop();
});

/** The claims a person's token carries; the audience is the resource the client asked for (RFC 8707). */
const person = (aud: string | undefined) => ({
  aud,
  sub: 'alice',
  email: 'alice@acme.com',
  email_verified: true,
  client_id: 'askdocs-test',
  scope: 'mcp',
});

as.service.on('beforeTokenSigning', (token: MutableToken, req: TokenRequestIncomingMessage) => {
  const body = z.object({ resource: z.string().optional() }).parse(req.body);
  Object.assign(token.payload, person(body.resource));
});

const db = openStore();

indexLibrary(db, { id: 'payments', source: 'https://github.com/acme/payments' }, [
  { path: 'runbook.md', text: '# Runbook\n\n## Reconciliation\n\nReplay the failed payout batch.\n' },
]);

const text = JSON.stringify(exportIndex(db));

const askdocs = lambdaHandler({
  index: async (loaded) => (loaded ? undefined : { text, version: 'v1' }),
  refreshSeconds: 0,
  access: {
    policy: definePolicy<PolicySpec>({
      roles: { reader: ['*'] },
      rules: [{ match: { domain: 'acme.com' }, role: 'reader' }],
    }),
  },
  resourceServerUrl: new URL(RESOURCE),
  oauthMetadata: await discoverOAuth(as.issuer.url ?? ''),
});

// The custom domain: `/docs/*` reaches askdocs without its prefix, as API Gateway sends it; the
// root mapping takes discovery (here the same Lambda, which serves it for its own resource).
async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', domain);
  const chunks: Buffer[] = [];

  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const mapped = url.pathname.startsWith('/docs/');

  if (!mapped && !url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    res.writeHead(404).end();

    return;
  }

  const result = await askdocs({
    rawPath: mapped ? url.pathname.slice('/docs'.length) : url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    body: Buffer.concat(chunks).toString('base64'),
    isBase64Encoded: true,
    requestContext: { domainName: url.host, http: { method: req.method ?? 'GET' } },
  });

  res.writeHead(result.statusCode, result.headers).end(result.body);
}

gateway.on('request', (req, res) => void route(req, res));

const call = (token: string | undefined) =>
  fetch(RESOURCE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : undefined),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_libraries', arguments: {} },
    }),
  });

const token = (aud: string, expiresIn = 3600) =>
  as.issuer.buildToken({
    expiresIn,
    scopesOrTransform: (_header, payload) => Object.assign(payload, person(aud)),
  });

/** What the client keeps between the two legs of signing in. */
type SignIn = { tokens?: { access_token: string; token_type: string }; verifier?: string; url?: URL };

describe('askdocs under a custom domain path mapping', () => {
  it('advertises the full resource URL from root discovery, and points clients there', async () => {
    const meta = await (await fetch(`${domain}/.well-known/oauth-protected-resource/docs/mcp`)).json();
    expect(meta).toMatchObject({ resource: RESOURCE, authorization_servers: [as.issuer.url] });

    expect((await call(undefined)).headers.get('www-authenticate')).toContain(
      `resource_metadata="${domain}/.well-known/oauth-protected-resource/docs/mcp"`,
    );
  });

  it('lets a real MCP client sign in and call a tool', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const saved: SignIn = {};

    const authProvider = {
      redirectUrl: 'http://localhost/callback',
      clientMetadata: { redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' },
      clientInformation: () => ({ client_id: 'askdocs-test' }),
      tokens: () => saved.tokens,
      saveTokens: (tokens: { access_token: string; token_type: string }) => void (saved.tokens = tokens),
      redirectToAuthorization: (url: URL) => void (saved.url = url),
      saveCodeVerifier: (verifier: string) => void (saved.verifier = verifier),
      codeVerifier: () => saved.verifier ?? '',
    };

    const transport = () => new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider });
    const first = transport();

    await expect(new Client({ name: 'claude-code', version: '0' }).connect(first)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(saved.url?.searchParams.get('resource')).toBe(RESOURCE);

    // The browser leg: the authorization server signs alice in and redirects back with a code.
    const redirect = await fetch(saved.url ?? '', { redirect: 'manual' });
    await first.finishAuth(new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '');

    const client = new Client({ name: 'claude-code', version: '0' });
    await client.connect(transport());

    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'replay payout batch' },
    });

    await client.close();

    expect(JSON.stringify(result)).toContain('runbook.md');
  });

  it('refuses missing, expired and wrong-audience tokens', async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call(await token(RESOURCE, -60))).status).toBe(401);
    expect((await call(await token(`${domain}/mcp`))).status).toBe(401);
    expect((await call(await token(RESOURCE))).status).toBe(200);
  });
});
