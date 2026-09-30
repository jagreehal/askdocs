import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubRepoReader, loadAccess } from './access';

function fakeGithub(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; auth: string | null }[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const login = url.split('/collaborators/')[1]!.split('/')[0]!;
    const r = responses[login] ?? { status: 404 };

    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };

  return { fetch, calls };
}

describe('githubRepoReader', () => {
  it("follows GitHub's answer, caches it for the TTL, and asks again after", async () => {
    let now = 0;

    const gh = fakeGithub({
      alice: { status: 200, body: { permission: 'read' } },
      bob: { status: 200, body: { permission: 'none' } },
    });

    const canRead = githubRepoReader({ token: 't0k', ttlSeconds: 60 }, { fetch: gh.fetch, now: () => now });

    expect(await canRead('alice', 'acme/payments')).toBe(true);
    expect(await canRead('bob', 'acme/payments')).toBe(false);
    expect(await canRead('mallory', 'acme/payments')).toBe(false); // 404: not a collaborator
    expect(gh.calls[0]).toEqual({
      url: 'https://api.github.com/repos/acme/payments/collaborators/alice/permission',
      auth: 'Bearer t0k',
    });

    await canRead('alice', 'acme/payments');
    expect(gh.calls).toHaveLength(3);
    now = 61_000;
    await canRead('alice', 'acme/payments');
    expect(gh.calls).toHaveLength(4);
  });

  it('fails closed on a GitHub error, and does not cache the failure', async () => {
    const gh = fakeGithub({ alice: { status: 502 } });
    const canRead = githubRepoReader({ token: 't', ttlSeconds: 60 }, { fetch: gh.fetch, now: () => 0 });
    expect(await canRead('alice', 'acme/payments')).toBe(false);
    await canRead('alice', 'acme/payments');
    expect(gh.calls).toHaveLength(2);
  });

  it('fails closed when the service token has expired or been revoked (401), without caching it', async () => {
    const gh = fakeGithub({ alice: { status: 401, body: { message: 'Bad credentials' } } });
    const canRead = githubRepoReader({ token: 'expired', ttlSeconds: 60 }, { fetch: gh.fetch, now: () => 0 });
    expect(await canRead('alice', 'acme/payments')).toBe(false);
    expect(await canRead('alice', 'acme/payments')).toBe(false);
    expect(gh.calls).toHaveLength(2); // a fixed token takes effect on the next request
  });

  it('fails closed when rate limited (403) or when GitHub answers with something unexpected', async () => {
    for (const reply of [
      { status: 403, body: { message: 'API rate limit exceeded' } },
      { status: 200, body: { permission: 'superuser' } },
      { status: 200, body: 'not json at all' },
    ]) {
      const gh = fakeGithub({ alice: reply });
      const canRead = githubRepoReader({ token: 't', ttlSeconds: 60 }, { fetch: gh.fetch, now: () => 0 });
      expect({ reply, allowed: await canRead('alice', 'acme/payments') }).toEqual({ reply, allowed: false });
    }
  });

  it('fails closed when GitHub is down or hangs past the timeout', async () => {
    const down = githubRepoReader(
      { token: 't', ttlSeconds: 60 },
      { fetch: async () => Promise.reject(new TypeError('fetch failed')), now: () => 0 },
    );

    expect(await down('alice', 'acme/payments')).toBe(false);

    const hangs = githubRepoReader(
      { token: 't', ttlSeconds: 60, timeoutMs: 50 },
      {
        fetch: (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        now: () => 0,
      },
    );

    expect(await hangs('alice', 'acme/payments')).toBe(false);
  });

  it('a removed collaborator keeps access only until the cached answer expires, never longer', async () => {
    let now = 0;
    let permission = 'write';

    const canRead = githubRepoReader(
      { token: 't', ttlSeconds: 60 },
      { fetch: async () => Response.json({ permission }), now: () => now },
    );

    expect(await canRead('alice', 'acme/payments')).toBe(true);
    permission = 'none'; // removed from the repo on GitHub
    now = 59_000;
    expect(await canRead('alice', 'acme/payments')).toBe(true); // the documented worst-case lag
    now = 60_001;
    expect(await canRead('alice', 'acme/payments')).toBe(false);
  });
});

function write(json: string) {
  const file = join(tmpdir(), `access-${Math.random()}.json`);
  writeFileSync(file, json);

  return file;
}

describe('loadAccess', () => {
  it('refuses a typo instead of quietly granting nothing', () => {
    expect(() =>
      loadAccess(
        write(
          JSON.stringify({
            policy: { roles: { all: ['*'] }, rules: [{ mach: { domain: 'acme.com' }, role: 'all' }] },
          }),
        ),
      ),
    ).toThrow(/mach/);
    expect(() =>
      loadAccess(write(JSON.stringify({ policy: { roles: {}, rules: [{ role: 'ghost' }] } }))),
    ).toThrow(/ghost/);
  });

  it('defaults the GitHub TTL to a minute', () => {
    const access = loadAccess(
      write(
        JSON.stringify({
          policy: { roles: { all: ['*'] }, rules: [{ role: 'all' }] },
          github: { loginClaim: 'nickname' },
        }),
      ),
    );

    expect(access.github).toEqual({ loginClaim: 'nickname', ttlSeconds: 60 });
  });
});
