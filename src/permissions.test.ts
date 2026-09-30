import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServer } from './server';
import { indexLibrary, listLibraries, openStore, type Scope } from './store';

/**
 * The strongest statement we can make about a library someone may not read: their view of the
 * server is exactly the view of a server where that library was never indexed. So every probe
 * below runs against both, and the responses must be identical, byte for byte.
 */
const PUBLIC = Array.from({ length: 6 }, (_, i) => ({
  path: `guide-${i}.md`,
  text: `# Guide ${i}\n\n## Beta\n\nalpha beta notes ${i}.\n\n## Gamma\n\nalpha gamma notes ${i} ${'filler '.repeat(i * 3)}\n`,
}));

// Skewed on purpose: if its statistics leaked into ranking, "beta" would look common and "gamma" rare.
const SECRET = Array.from({ length: 30 }, (_, i) => ({
  path: `vault-${i}.md`,
  text: `# Vault ${i}\n\nbeta beta beta zebrafalcon rotation key ${i}.\n`,
}));

type ToolArgs = Record<string, string | number | boolean>;

async function view(opts: { withSecret: boolean; scope: Scope }) {
  const db = openStore();
  indexLibrary(db, { id: 'public', source: 'test' }, PUBLIC);

  if (opts.withSecret) indexLibrary(db, { id: 'secret', source: 'test' }, SECRET);

  return viewOf(db, opts.scope);
}

async function viewOf(db: ReturnType<typeof openStore>, scope: Scope) {
  const server = createServer(db, { principal: 'bob', scope });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'probe', version: '0' });
  await client.connect(a);

  return async (name: string, args: ToolArgs) => {
    const t0 = performance.now();
    const r = await client.callTool({ name, arguments: args });

    return {
      response: { content: r.content, structuredContent: r.structuredContent, isError: r.isError },
      ms: performance.now() - t0,
    };
  };
}

const PROBES: [string, ToolArgs][] = [
  ['list_libraries', {}],
  ['search_docs', { query: 'zebrafalcon' }], // only in the secret library
  ['search_docs', { query: 'rotation key' }],
  ['search_docs', { query: 'beta gamma' }], // ordering depends on term statistics
  ['search_docs', { query: 'alpha', limit: 2 }],
  ['search_docs', { query: 'alpha', limit: 2, offset: 2 }],
  ['search_docs', { query: 'alpha notes', limit: 25 }],
  ['search_docs', { query: 'zebrafalcon', library: 'secret' }],
  ['search_docs', { query: '"beta beta beta"' }],
  ['read_doc', { library: 'secret', path: 'vault-0.md' }],
  ['read_doc', { library: 'secret', path: 'vault-0.md', line: 1 }],
  ['read_doc', { library: 'public', path: 'vault-0.md' }],
];

describe('a library you cannot read is indistinguishable from one that does not exist', () => {
  it('gives identical responses to every probe', async () => {
    const hidden = await view({ withSecret: true, scope: [{ id: 'public' }] });
    const absent = await view({ withSecret: false, scope: 'all' });

    for (const [tool, args] of PROBES) {
      const [a, b] = [await hidden(tool, args), await absent(tool, args)];
      expect({ tool, args, ...a.response }).toEqual({ tool, args, ...b.response });
    }
  });

  it('never touches a hidden library at all, so its size cannot show up as time', async () => {
    const db = openStore();
    indexLibrary(db, { id: 'public', source: 'test' }, PUBLIC);
    indexLibrary(db, { id: 'secret', source: 'test' }, SECRET);
    const hiddenTable = `fts_${listLibraries(db, 'all').find((l) => l.id === 'secret')!.fts}`;
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (statement: string) => {
      sql.push(statement);

      return prepare(statement);
    };

    const call = await viewOf(db, [{ id: 'public' }]);

    for (const [tool, args] of PROBES) await call(tool, args);
    expect(sql.length).toBeGreaterThan(20);
    expect(sql.filter((s) => s.includes(hiddenTable))).toEqual([]);
  });

  it('never tells the agent whether a missing answer is restricted (that is for `askdocs stats`)', async () => {
    const hidden = await view({ withSecret: true, scope: [{ id: 'public' }] });
    const { response } = await hidden('search_docs', { query: 'zebrafalcon rotation' });
    expect(JSON.stringify(response)).not.toMatch(/restricted|permission|forbidden|not allowed/i);
  });
});
