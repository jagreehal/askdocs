import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './server';
import { loadSource, syncLibrary } from './sources';
import { indexLibrary, listLibraries, openStore } from './store';

// What an operator's SDK does: a context manager so spans nest, W3C propagation so a caller's
// trace carries over, and a provider to record them.
const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

beforeEach(() => exporter.reset());

const spanNamed = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name);

describe('telemetry', () => {
  it('traces each tool call with its outcome, and never the question or the path asked for', async () => {
    const db = openStore();
    indexLibrary(db, { id: 'ops', source: 'test' }, [
      { path: 'secret-plans.md', text: '# Payouts\n\n## Retries\n\nA failed payout is retried.\n' },
    ]);
    const server = createServer(db, { principal: 'alice@acme.com', scope: 'all' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(a);

    await client.callTool({ name: 'search_docs', arguments: { query: 'payout retried sk_live_12345' } });
    await client.callTool({ name: 'read_doc', arguments: { library: 'ops', path: 'secret-plans.md' } });
    await client.callTool({ name: 'read_doc', arguments: { library: 'ops', path: 'hr/salaries.md' } });

    expect(spanNamed('tools/call search_docs')?.attributes).toMatchObject({
      'gen_ai.tool.name': 'search_docs',
      'askdocs.tool': 'search_docs',
      // The pasted key is half the question and in no doc, so the search is rightly unanswered.
      'askdocs.answered': false,
      'askdocs.results': 1,
    });
    expect(spanNamed('tools/call read_doc')?.attributes).toMatchObject({
      'askdocs.library': 'ops',
      'askdocs.results': 1,
    });

    const recorded = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(recorded).not.toMatch(/sk_live|secret-plans|salaries|alice/);
  });

  it("continues the agent's trace when the request carries one", async () => {
    const db = openStore();
    indexLibrary(db, { id: 'ops', source: 'test' }, [{ path: 'a.md', text: '# A\n\nPayouts.\n' }]);
    const server = createServer(db, { principal: 'dev', scope: 'all' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(a);

    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await client.callTool({
      name: 'search_docs',
      arguments: { query: 'payouts' },
      _meta: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });

    expect(spanNamed('tools/call search_docs')?.spanContext().traceId).toBe(traceId);
  });

  it('traces a sync with what it indexed, and marks a failed one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'askdocs-otel-'));
    await writeFile(join(dir, 'a.md'), '# A\n\nText.\n');
    const db = openStore();
    const { library, files } = await loadSource(dir, { name: 'docs' });
    indexLibrary(db, library, files);

    await syncLibrary(db, listLibraries(db, 'all')[0]!);
    expect(spanNamed('askdocs.sync')?.attributes).toEqual({
      'askdocs.library': 'docs',
      'askdocs.files': 1,
      'askdocs.sections': 1,
    });

    exporter.reset();
    await expect(syncLibrary(db, { id: 'old', source: dir, include: null })).rejects.toThrow(
      /Re-add it once/,
    );
    expect(spanNamed('askdocs.sync')?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
