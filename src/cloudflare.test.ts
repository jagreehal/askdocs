import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AskdocsIndex,
  durableObjectDatabase,
  type DurableObjectState,
  type Env,
  type SqlStorage,
} from './cloudflare';
import { exportIndex, importIndex, indexLibrary, openStore, parseIndexDump, search } from './store';
import { embedLibrary, searchSemantic, workersAiEmbedder, type WorkersAi } from './vectors';

/**
 * A Durable Object's SQL storage, played by node:sqlite with the platform's rules: BEGIN and
 * COMMIT are refused (transactionSync is the way), and blobs cross as ArrayBuffer.
 */
function durableObjectSql(): DurableObjectState['storage'] {
  const db = new DatabaseSync(':memory:');

  const sql: SqlStorage = {
    exec(query, ...bindings) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query))
        throw new Error('not allowed in a Durable Object');

      const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
      const statements = query.split(/;\s*\n/).filter((s) => s.trim());

      // Multi-statement text (a schema) runs whole; a single statement returns its rows.
      if (statements.length > 1) {
        db.exec(query);

        return { toArray: () => [], rowsWritten: 0 };
      }

      const stmt = db.prepare(query);
      const reader = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query);
      const rows = reader ? stmt.all(...params) : [];
      const written = reader ? 0 : Number(stmt.run(...params).changes);

      return {
        toArray: () =>
          rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                v instanceof Uint8Array
                  ? v.slice().buffer
                  : z.union([z.string(), z.number(), z.null()]).parse(v),
              ]),
            ),
          ),
        rowsWritten: written,
      };
    },
  };

  return {
    sql,
    transactionSync(write) {
      db.exec('SAVEPOINT tx');

      try {
        const result = write();
        db.exec('RELEASE tx');

        return result;
      } catch (error) {
        db.exec('ROLLBACK TO tx');
        db.exec('RELEASE tx');
        throw error;
      }
    },
  };
}

/** A Workers AI binding that embeds as a bag of words, deterministically. */
const fakeAi: WorkersAi = {
  async run(_model, { text }) {
    return {
      data: text.map((t) => {
        const v = Array.from({ length: 64 }, () => 0);

        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
          let h = 0;

          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % 64;
          v[h]! += 1;
        }

        return v;
      }),
    };
  },
};

const DOCS = [
  {
    path: 'processor.md',
    text: '# Processor\n\n## Why one instance\n\nOnly one instance runs, to keep ordering.\n',
  },
  { path: 'fees.md', text: '# Fees\n\n## Currency fee\n\nA fee is charged on conversion.\n' },
];

function published() {
  const source = openStore();
  indexLibrary(source, { id: 'payments', source: 'https://github.com/acme/payments' }, DOCS);

  return { source, body: JSON.stringify(exportIndex(source)) };
}

function durableObject(env: Partial<Env> = {}) {
  const storage = durableObjectSql();
  const background: Promise<void>[] = [];
  const state: DurableObjectState = { storage, waitUntil: (work) => background.push(work) };

  const index = new AskdocsIndex(state, {
    // Not reached by these tests: the Worker routes to the Durable Object, and MCP needs OAuth.
    ASKDOCS: {
      idFromName: (name) => name,
      get: () => ({ fetch: () => Promise.reject(new Error('unused')) }),
    },
    MCP_PUBLIC_URL: 'https://docs.example.com/mcp',
    OAUTH_ISSUER: 'https://auth.example.com',
    ACCESS: '{}',
    ADMIN_TOKEN: 'admin-secret',
    ...env,
  });

  return { index, storage, background };
}

/** One library whose two sections hold `a` and `b`, as CI would publish it. */
function publishedWith(a: string, b: string) {
  const db = openStore();
  indexLibrary(db, { id: 'payments', source: 'https://github.com/acme/payments' }, [
    { path: 'a.md', text: `# Notes\n\n## First\n\n${a}\n\n## Second\n\n${b}\n` },
  ]);

  return parseIndexDump(JSON.stringify(exportIndex(db)));
}

const admin = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`https://docs.example.com${path}`, {
    ...init,
    headers: init.token === undefined ? {} : { authorization: `Bearer ${init.token}` },
  });

afterEach(() => vi.restoreAllMocks());

describe('askdocs on Cloudflare', () => {
  it('retries starting up after the authorization server was briefly unreachable', async () => {
    const issuer = 'https://auth.example.com';

    let down = true;

    const metadata = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (down) throw new Error('connect ECONNREFUSED');

      return Response.json(metadata);
    });

    const { index } = durableObject({
      OAUTH_ISSUER: issuer,
      ACCESS: JSON.stringify({ policy: { roles: {}, rules: [] } }),
    });

    const mcp = () =>
      index.fetch(
        new Request('https://docs.example.com/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      );

    await expect(mcp()).rejects.toThrow(/No OAuth metadata/);
    down = false;
    expect((await mcp()).status).toBe(401);
  });

  it('searches a published index exactly as the index it came from', () => {
    const { source, body } = published();
    const { sql, transactionSync } = durableObjectSql();
    const db = durableObjectDatabase(sql);
    importIndex(db, parseIndexDump(body), transactionSync);

    for (const text of ['currency fee', 'ordering', 'why one instance']) {
      expect(search(db, { text }, 'all')).toEqual(search(source, { text }, 'all'));
    }
  });

  it('lets only the admin token publish, and publishing replaces the index', async () => {
    const { index } = durableObject();
    const { body } = published();

    expect((await index.fetch(admin('/admin/publish', { method: 'POST', body }))).status).toBe(403);
    expect(
      (await index.fetch(admin('/admin/publish', { method: 'POST', body, token: 'admin-secre' }))).status,
    ).toBe(403);

    const ok = await index.fetch(admin('/admin/publish', { method: 'POST', body, token: 'admin-secret' }));
    expect(await ok.json()).toEqual({ libraries: 1, sections: expect.any(Number) });
    expect((await index.fetch(admin('/admin/stats', { token: 'admin-secret' }))).status).toBe(200);
  });

  it('re-embeds only what changed when an index is published again', async () => {
    const calls: string[][] = [];

    const counting: WorkersAi = {
      run: async (model, input) => {
        calls.push(input.text);

        return fakeAi.run(model, input);
      },
    };

    const { index, background } = durableObject({
      EMBED_MODEL: '@cf/google/embeddinggemma-300m',
      AI: counting,
    });

    const publish = async (body: string) => {
      await index.fetch(admin('/admin/publish', { method: 'POST', body, token: 'admin-secret' }));
      await Promise.all(background);
    };

    await publish(published().body);
    const first = calls.flat().length;
    expect(first).toBeGreaterThan(0);

    await publish(published().body);
    expect(calls.flat().length).toBe(first);

    const changed = openStore();
    indexLibrary(changed, { id: 'payments', source: 'https://github.com/acme/payments' }, [
      DOCS[0]!,
      { path: 'fees.md', text: '# Fees\n\n## Currency fee\n\nNo fee on conversion any more.\n' },
    ]);
    await publish(JSON.stringify(exportIndex(changed)));
    expect(calls.flat().length - first).toBe(1);
  });

  it("never matches a previous index's vectors to a republished index's sections", async () => {
    const embedder = workersAiEmbedder(fakeAi, '@cf/google/embeddinggemma-300m');

    const served = openStore();
    importIndex(served, publishedWith('alpha alpha alpha', 'beta beta beta'));
    await embedLibrary(served, 'payments', embedder);

    const top = async () =>
      (await searchSemantic(served, { text: 'alpha' }, 'all', embedder, 'vector')).hits[0];

    expect((await top())?.heading).toBe('First');

    // The same FTS table number, the text swapped.
    importIndex(served, publishedWith('beta beta beta', 'alpha alpha alpha'));
    expect((await top())?.heading).not.toBe('First');

    await embedLibrary(served, 'payments', embedder);
    expect((await top())?.heading).toBe('Second');
  });

  it('embeds a published index in the background with Workers AI', async () => {
    const { index, storage, background } = durableObject({
      EMBED_MODEL: '@cf/google/embeddinggemma-300m',
      AI: fakeAi,
    });

    await index.fetch(
      admin('/admin/publish', { method: 'POST', body: published().body, token: 'admin-secret' }),
    );
    await Promise.all(background);

    const db = durableObjectDatabase(storage.sql);

    const { hits } = await searchSemantic(
      db,
      { text: 'ordering' },
      'all',
      workersAiEmbedder(fakeAi, '@cf/google/embeddinggemma-300m'),
      'vector',
    );

    expect(hits[0]?.path).toBe('processor.md');
  });
});
