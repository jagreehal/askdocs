import { discoverOAuth } from 'mcp-authz';
import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAccess } from './access';
import { lambdaHandler } from './lambda';
import { exportIndex, indexLibrary, openStore } from './store';

/**
 * An agent that signs in as itself, such as Claude in a team chat holding one OAuth
 * client-credentials token for everyone it answers. Its token names a `sub` and no person.
 */

const RESOURCE = 'https://docs.acme.com/mcp';

const AGENT = 'claude-tag@clients';

const as = new OAuth2Server();

await as.issuer.keys.generate('RS256');

await as.start(0, 'localhost');

const oauthMetadata = await discoverOAuth(as.issuer.url ?? '');

afterAll(() => as.stop());

const db = openStore();

indexLibrary(db, { id: 'handbook', source: 'https://github.com/acme/handbook' }, [
  { path: 'leave.md', text: '# Leave\n\n## Holidays\n\nBook holidays in the HR tool.\n' },
]);

indexLibrary(db, { id: 'payments', source: 'https://github.com/acme/payments' }, [
  { path: 'payouts.md', text: '# Payouts\n\n## Holidays\n\nNo payouts run on bank holidays.\n' },
]);

const text = JSON.stringify(exportIndex(db));

const server = (access: string) =>
  lambdaHandler({
    index: async (loaded) => (loaded ? undefined : { text, version: 'v1' }),
    refreshSeconds: 0,
    access: parseAccess(access),
    resourceServerUrl: new URL(RESOURCE),
    oauthMetadata,
  });

/** What a client-credentials grant issues: the service's own subject, for this server. */
const agentToken = () =>
  as.issuer.buildToken({
    scopesOrTransform: (_header, payload) =>
      Object.assign(payload, { sub: AGENT, aud: RESOURCE, azp: 'claude-tag', scope: 'mcp' }),
  });

const search = async (handle: ReturnType<typeof server>, query: string) =>
  handle({
    rawPath: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${await agentToken()}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query } },
    }),
    requestContext: { domainName: 'docs.acme.com', http: { method: 'POST' } },
  });

const policy = (rules: object[]) => ({
  roles: { everyone: ['handbook'], engineers: ['handbook', 'payments'] },
  rules,
});

describe('an agent signed in as itself', () => {
  it('reads the libraries the rule naming its sub grants, and no others', async () => {
    const handle = server(
      JSON.stringify({
        agents: true,
        policy: policy([
          { match: { sub: AGENT }, role: 'everyone' },
          { match: { domain: 'acme.com' }, role: 'engineers' },
        ]),
      }),
    );

    const result = await search(handle, 'holidays');

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('leave.md');
    expect(result.body).not.toContain('payouts.md');
  });

  it('is refused unless the access file accepts agents', async () => {
    const handle = server(JSON.stringify({ policy: policy([{ match: { sub: AGENT }, role: 'everyone' }]) }));

    expect((await search(handle, 'holidays')).statusCode).toBe(401);
  });

  it('gets nothing from a domain rule, which names people', async () => {
    const handle = server(
      JSON.stringify({
        agents: true,
        policy: policy([{ match: { domain: 'acme.com' }, role: 'engineers' }]),
      }),
    );

    expect((await search(handle, 'holidays')).statusCode).toBe(403);
  });

  it('takes `agents` as a boolean only', () => {
    expect(() => parseAccess(JSON.stringify({ agents: 'yes', policy: policy([]) }))).toThrow(/agents/);
  });
});
