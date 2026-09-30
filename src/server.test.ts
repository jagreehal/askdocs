import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer } from './server';
import { loadSource } from './sources';
import { indexLibrary, openStore, recentAudit, type Scope } from './store';

async function connectedClient(scope: Scope = 'all') {
  const dir = await mkdtemp(join(tmpdir(), 'askdocs-test-'));
  await mkdir(join(dir, 'adr'));
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
  await writeFile(
    join(dir, 'payments.md'),
    '# Payments\n\n## Retries\n\nPayouts are retried with exponential backoff.\n\n### Idempotency\n\nDuplicate payouts are prevented by an idempotency key.\n\n## Refunds\n\nRefunds go through the ledger.\n',
  );
  await writeFile(
    join(dir, 'adr', '004-fifo.mdx'),
    '# ADR 004: FIFO queues\n\nWe use SQS FIFO for payout ordering.\n',
  );
  await writeFile(join(dir, 'node_modules', 'dep', 'README.md'), '# Should not be indexed\n\npayout\n');

  const db = openStore();
  const { library, files } = await loadSource(dir, { name: 'acme/payments' });
  expect(files.map((f) => f.path)).toEqual(['adr/004-fifo.mdx', 'payments.md']);
  indexLibrary(db, library, files);

  const server = createServer(db, { principal: 'dev', agent: 'test', scope });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);

  return { client, db };
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;

type ToolArgs = Record<string, string | number | boolean>;

const ToolText = z.object({ content: z.array(z.object({ text: z.string() })) });

const textOf = (result: CallResult) =>
  ToolText.parse(result)
    .content.map((c) => c.text)
    .join('\n');

describe('askdocs over MCP', () => {
  it('exposes exactly three tools', async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(['list_libraries', 'read_doc', 'search_docs']);
    expect(textOf(await client.callTool({ name: 'list_libraries', arguments: {} }))).toContain(
      'acme/payments',
    );
  });

  it('answers a natural-language question with the right section, then reads just that section', async () => {
    const { client } = await connectedClient();

    const found = textOf(
      await client.callTool({
        name: 'search_docs',
        arguments: { query: 'how do payout retries avoid duplicates?', library: 'acme/payments' },
      }),
    );

    expect(found.split('\n')[0]).toBe('[1] acme/payments · payments.md · Payments > Retries > Idempotency');

    const section = textOf(
      await client.callTool({
        name: 'read_doc',
        arguments: { library: 'acme/payments', path: 'payments.md', heading: 'Retries' },
      }),
    );

    expect(section).toContain('### Idempotency');
    expect(section).not.toContain('Refunds');
  });

  it('does not choke on FTS syntax in the query, and audits the miss', async () => {
    const { client, db } = await connectedClient();
    const miss = await client.callTool({ name: 'search_docs', arguments: { query: 'SLO "AND" (NEAR*' } });
    expect(textOf(miss)).toContain('No results');
    expect(recentAudit(db, 1)[0]).toMatchObject({
      principal: 'dev',
      agent: 'test',
      tool: 'search_docs',
      query: 'SLO "AND" (NEAR*',
      returned: '[]',
    });
  });

  it('lists real headings when asked for one that does not exist', async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: 'read_doc',
      arguments: { library: 'acme/payments', path: 'payments.md', heading: 'Chargebacks' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('  - Refunds');
  });

  it('reads an outline, or only the code in one language, without new tools', async () => {
    const { client } = await connectedClient();

    const read = (args: ToolArgs) =>
      client.callTool({
        name: 'read_doc',
        arguments: { library: 'acme/payments', path: 'payments.md', ...args },
      });

    expect(textOf(await read({ outline: true }))).toBe(
      '- Payments (line 1)\n  - Retries (line 3)\n    - Idempotency (line 7)\n  - Refunds (line 11)',
    );
    expect(textOf(await read({ line: 3, outline: true }))).toBe(
      '- Retries (line 3)\n  - Idempotency (line 7)',
    );
    expect(textOf(await read({ language: 'python' }))).toBe(
      'No python code blocks in that part of payments.md.',
    );
  });

  it('with an empty scope, the same index reveals nothing — not even that the library exists', async () => {
    const { client } = await connectedClient([]);
    expect(textOf(await client.callTool({ name: 'list_libraries', arguments: {} }))).toBe(
      'No libraries available.',
    );
    expect(
      textOf(await client.callTool({ name: 'search_docs', arguments: { query: 'idempotency' } })),
    ).toContain('No results');

    const read = await client.callTool({
      name: 'read_doc',
      arguments: { library: 'acme/payments', path: 'payments.md' },
    });

    expect(textOf(read)).toBe(
      'Unknown library "acme/payments". Call list_libraries to see the libraries you can search.',
    );
  });
});

async function clientFor(files: { path: string; text: string }[]) {
  const db = openStore();
  indexLibrary(db, { id: 'sdk', source: 'test' }, files);
  const server = createServer(db, { principal: 'dev', scope: 'all' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);

  const call = async (name: string, args: ToolArgs) =>
    textOf(await client.callTool({ name, arguments: args }));

  return Object.assign(call, { db });
}

/** Pull the `read_doc` arguments out of the first search hit, the way an agent would. */
const HitArgs = z.object({
  library: z.string(),
  path: z.string(),
  line: z.coerce.number(),
  revision: z.string(),
});

const firstHitArgs = (found: string) => {
  const header = /^\[1\] (?<library>\S+) · (?<path>\S+) · /.exec(found)?.groups;
  const cite = /^line: (?<line>\d+) · revision (?<revision>\w+)/m.exec(found)?.groups;

  return HitArgs.parse({ ...header, ...cite });
};

describe('every search hit can be read back exactly', () => {
  const CLIENTS =
    '# Clients\n\n## Client A\n\n### Errors\n\nA fails with TIMEOUT.\n\n## Client B\n\n### Errors\n\nB fails with QUOTA_EXCEEDED.\n';

  it('reads the Errors section of Client B, not the first Errors in the file', async () => {
    const call = await clientFor([{ path: 'clients.md', text: CLIENTS }]);
    const found = await call('search_docs', { query: 'client b errors quota' });
    expect(found.split('\n')[0]).toBe('[1] sdk · clients.md · Clients > Client B > Errors');
    const section = await call('read_doc', firstHitArgs(found));
    expect(section).toContain('QUOTA_EXCEEDED');
    expect(section).not.toContain('TIMEOUT');
  });

  it('reads a document that has no headings at all', async () => {
    const call = await clientFor([{ path: 'notes.md', text: 'Just a paragraph about rate limits.\n' }]);
    const section = await call('read_doc', firstHitArgs(await call('search_docs', { query: 'rate limits' })));
    expect(section).toBe('Just a paragraph about rate limits.');
  });

  it('accepts a heading path, and says which one it means when a bare heading is ambiguous', async () => {
    const call = await clientFor([{ path: 'clients.md', text: CLIENTS }]);
    expect(
      await call('read_doc', { library: 'sdk', path: 'clients.md', heading: 'Client B > Errors' }),
    ).toContain('QUOTA_EXCEEDED');
    const ambiguous = await call('read_doc', { library: 'sdk', path: 'clients.md', heading: 'Errors' });
    expect(ambiguous).toContain('"Errors" matches 2 sections');
    expect(ambiguous).toContain('Clients > Client A > Errors (line 5)');
    expect(ambiguous).toContain('Clients > Client B > Errors (line 11)');
  });
});

async function agentClient(files: { path: string; text: string }[], scope: Scope = 'all') {
  const db = openStore();
  indexLibrary(
    db,
    { id: 'sdk', source: 'test', sha: 'abc1234def', urlBase: 'https://example.com/blob/abc1234def/' },
    files,
  );
  indexLibrary(db, { id: 'secret', source: 'test' }, [
    { path: 'vault.md', text: '# Vault\n\nThe vault key rotates monthly.\n' },
  ]);
  const server = createServer(db, { principal: 'dev', scope });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  const call = (name: string, args: ToolArgs) => client.callTool({ name, arguments: args });

  return { client, call, db };
}

/** The SDK types structuredContent loosely; these are the fields the tests read. */
const Data = z.object({
  results: z.array(z.object({ path: z.string(), snippet: z.string() })).optional(),
  outline: z.array(z.object({ line: z.number() })).optional(),
  libraries: z.array(z.object({ id: z.string() })).optional(),
  nextOffset: z.number().optional(),
});

const data = (result: CallResult) => Data.parse(result.structuredContent);

const HUGE = `# Handbook\n\n${Array.from({ length: 40 }, (_, i) => `## Chapter ${i}\n\n${`Chapter ${i} prose about retries. `.repeat(60)}`).join('\n\n')}`;

describe('shaped for agents', () => {
  it('returns structured results with a citation that survives the docs changing', async () => {
    const { client, call } = await agentClient([
      { path: 'retries.md', text: '# Retries\n\n## Backoff\n\nExponential backoff with jitter.\n' },
    ]);

    const { tools } = await client.listTools();
    expect(tools.filter((t) => !t.outputSchema).map((t) => t.name)).toEqual([]);

    const result = await call('search_docs', { query: 'backoff jitter' });
    expect(result.structuredContent).toMatchObject({
      answered: true,
      results: [
        {
          library: 'sdk',
          path: 'retries.md',
          heading: 'Backoff',
          breadcrumb: 'Retries > Backoff',
          line: 3,
          commit: 'abc1234def',
          url: 'https://example.com/blob/abc1234def/retries.md#L3',
        },
      ],
    });
    expect(textOf(result)).toContain('commit abc1234');

    const read = await call('read_doc', { library: 'sdk', path: 'retries.md', line: 3 });
    expect(read.structuredContent).toMatchObject({
      library: 'sdk',
      path: 'retries.md',
      line: 3,
      heading: 'Backoff',
      commit: 'abc1234def',
      page: 1,
      pages: 1,
    });
  });

  it('caps snippets, even for a section that is one enormous line', async () => {
    const { call } = await agentClient([
      { path: 'blob.md', text: `# Blob\n\nneedle ${'x'.repeat(5000)} ${'y'.repeat(5000)}\n` },
    ]);

    const [hit] = data(await call('search_docs', { query: 'needle' })).results ?? [];
    expect(hit!.snippet.length).toBeLessThanOrEqual(300);
  });

  it('answers a read of a huge document with its outline and a pointer, and pages through long sections', async () => {
    const { call } = await agentClient([{ path: 'handbook.md', text: HUGE }]);
    const whole = await call('read_doc', { library: 'sdk', path: 'handbook.md' });
    expect(textOf(whole).length).toBeLessThan(20_000);
    expect(textOf(whole)).toMatch(/too long to return at once.*line/is);
    expect(whole.structuredContent).toMatchObject({ pages: expect.any(Number), text: '' });
    expect(data(whole).outline).toHaveLength(41);

    const page2 = await call('read_doc', { library: 'sdk', path: 'handbook.md', page: 2 });
    expect(textOf(page2).length).toBeLessThan(20_000);
    expect(page2.structuredContent).toMatchObject({ page: 2 });
    const beyond = await call('read_doc', { library: 'sdk', path: 'handbook.md', page: 99 });
    expect(beyond.isError).toBe(true);
    expect(textOf(beyond)).toMatch(/has \d+ pages/);
  });

  it('pages search results without overlap', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `r${i}.md`,
      text: `# R${i}\n\nretry policy number ${i}\n`,
    }));

    const { call } = await agentClient(files);
    const first = data(await call('search_docs', { query: 'retry policy', limit: 5 }));
    expect(first.nextOffset).toBe(5);
    const second = data(await call('search_docs', { query: 'retry policy', limit: 5, offset: 5 }));
    const third = data(await call('search_docs', { query: 'retry policy', limit: 5, offset: 10 }));
    const paths = [first, second, third].flatMap((p) => (p.results ?? []).map((r) => r.path));
    expect(new Set(paths).size).toBe(12);
    expect(third.nextOffset).toBeUndefined();
  });

  it('pages the library list', async () => {
    const { call, db } = await agentClient([{ path: 'a.md', text: '# A\n\nx\n' }]);

    for (let i = 0; i < 5; i++)
      indexLibrary(db, { id: `lib${i}`, source: 't' }, [{ path: 'a.md', text: '# A\n\nx\n' }]);
    const page = data(await call('list_libraries', { limit: 3 }));
    expect(page.libraries).toHaveLength(3);
    expect(page.nextOffset).toBe(3);
  });

  it('tells the agent what to do next, identically for an unknown and a forbidden library', async () => {
    const { call } = await agentClient([{ path: 'a.md', text: '# A\n\nx\n' }], [{ id: 'sdk' }]);
    const unknown = await call('search_docs', { query: 'vault', library: 'nope' });
    const forbidden = await call('search_docs', { query: 'vault', library: 'secret' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(
      'Unknown library "nope". Call list_libraries to see the libraries you can search.',
    );
    expect(textOf(forbidden)).toBe(textOf(unknown).replace('nope', 'secret'));
    const readForbidden = await call('read_doc', { library: 'secret', path: 'vault.md' });
    const readUnknown = await call('read_doc', { library: 'nope', path: 'vault.md' });
    expect(textOf(readForbidden)).toBe(textOf(readUnknown).replace('nope', 'secret'));
    expect(textOf(await call('read_doc', { library: 'sdk', path: 'missing.md' }))).toMatch(/search_docs/);
  });

  it('never leaks a stack trace', async () => {
    const { call, db } = await agentClient([{ path: 'a.md', text: '# A\n\nx\n' }]);
    db.close();
    const broken = await call('search_docs', { query: 'anything' });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toMatch(/^askdocs could not/);
    expect(textOf(broken)).not.toMatch(/\n\s+at /);
  });

  it('describes the intended loop in the tool descriptions', async () => {
    const { client } = await agentClient([]);
    const { tools } = await client.listTools();
    const about = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));
    expect(about.search_docs).toMatch(/then.*read_doc/is);
    expect(about.read_doc).toMatch(/search_docs/);
    expect(about.list_libraries).toMatch(/when/i);
  });
});

describe('reading what was found, not what replaced it', () => {
  it('refuses a line from a revision the document no longer has, and says to search again', async () => {
    const call = await clientFor([
      { path: 'setup.md', text: '# Setup\n\n## First\n\nRun the migrations.\n' },
    ]);

    const args = firstHitArgs(await call('search_docs', { query: 'migrations' }));
    indexLibrary(call.db, { id: 'sdk', source: 'test' }, [
      { path: 'setup.md', text: '# Setup\n\n## Replacement\n\nDrop the database.\n' },
    ]);
    const read = await call('read_doc', args);
    expect(read).toMatch(/has changed since search_docs.*search_docs again/);
    expect(read).not.toContain('Drop the database');
  });
});

describe('audit', () => {
  it('records list_libraries calls, with the page asked for and what it returned', async () => {
    const call = await clientFor([{ path: 'a.md', text: '# A\n' }]);
    await call('list_libraries', { offset: 5 });
    expect(recentAudit(call.db, 1)[0]).toMatchObject({
      tool: 'list_libraries',
      query: 'limit=50&offset=5',
      returned: '[]',
    });
  });
});
