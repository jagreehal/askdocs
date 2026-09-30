import { describe, expect, it } from 'vitest';
import {
  exportIndex,
  importIndex,
  indexLibrary,
  openStore,
  parseIndexDump,
  recentAudit,
  recordAudit,
} from './store';
import { embedLibrary, searchSemantic, type Embedder } from './vectors';

/**
 * A deterministic stand-in for a model: a bag of words hashed into 512 dimensions, with one
 * synonym pair so "similar meaning, different words" can be tested without a network.
 */
function fakeEmbedder(calls: string[][] = []): Embedder {
  const SAME = new Map([['replicas', 'instance']]);

  return {
    id: 'fake:bag-of-words',
    async embed(texts) {
      calls.push(texts);

      return texts.map((text) => {
        const v = new Float32Array(512);

        for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          const word = SAME.get(raw) ?? raw.replace(/s$/, '');
          let h = 0;

          for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 512;
          v[h]! += 1;
        }

        return v;
      });
    },
  };
}

const PROCESSOR = [
  {
    path: 'processor.md',
    text: '# Processor\n\n## Why one instance\n\nOnly one instance runs, to keep ordering.\n',
  },
  { path: 'fees.md', text: '# Fees\n\n## Currency fee\n\nA fee is charged on conversion.\n' },
];

describe('semantic search', () => {
  it('finds a section by meaning when the question shares none of its words', async () => {
    const db = openStore();
    const embedder = fakeEmbedder();
    indexLibrary(db, { id: 'payments', source: 'test' }, PROCESSOR);
    await embedLibrary(db, 'payments', embedder);

    const q = { text: 'replicas?', limit: 3 };
    expect((await searchSemantic(db, q, 'all', embedder, 'keyword')).hits).toEqual([]);
    expect((await searchSemantic(db, q, 'all', embedder, 'hybrid')).hits[0]).toMatchObject({
      path: 'processor.md',
      heading: 'Why one instance',
    });
  });

  it('embeds only what changed, and ignores vectors from before a re-index', async () => {
    const db = openStore();
    const calls: string[][] = [];
    const embedder = fakeEmbedder(calls);
    indexLibrary(db, { id: 'payments', source: 'test' }, PROCESSOR);
    const first = await embedLibrary(db, 'payments', embedder);
    expect(first).toMatchObject({ reused: 0 });

    // Re-indexed with one section changed: its vector is stale until embedded again, and must not be used.
    indexLibrary(db, { id: 'payments', source: 'test' }, [
      PROCESSOR[0]!,
      { path: 'fees.md', text: '# Fees\n\n## Currency fee\n\nNo fee on conversion any more.\n' },
    ]);
    expect((await searchSemantic(db, { text: 'replicas' }, 'all', embedder, 'vector')).hits).toEqual([]);

    expect(await embedLibrary(db, 'payments', embedder)).toEqual({
      sections: first.sections,
      embedded: 1,
      reused: first.embedded - 1,
      superseded: false,
    });
    expect(calls.at(-1)).toEqual([expect.stringContaining('No fee on conversion')]);
    expect((await searchSemantic(db, { text: 'replicas' }, 'all', embedder, 'vector')).hits[0]?.path).toBe(
      'processor.md',
    );
  });

  it('never returns, or ranks against, a library outside the caller’s scope', async () => {
    const db = openStore();
    const embedder = fakeEmbedder();
    indexLibrary(db, { id: 'public', source: 'test' }, PROCESSOR);
    indexLibrary(db, { id: 'secret', source: 'test' }, [
      { path: 'plan.md', text: '# Plan\n\n## Replicas\n\nWe will run replicas of the instance next year.\n' },
    ]);
    await embedLibrary(db, 'public', embedder);
    await embedLibrary(db, 'secret', embedder);

    for (const mode of ['vector', 'hybrid'] as const) {
      const { hits } = await searchSemantic(
        db,
        { text: 'replicas instance' },
        [{ id: 'public' }],
        embedder,
        mode,
      );

      expect(hits.map((h) => h.library)).toEqual(expect.arrayContaining(['public']));
      expect(hits.some((h) => h.library === 'secret')).toBe(false);
    }
  });

  it('embeds a long section in pieces and ranks it by its best piece', async () => {
    const db = openStore();
    const embedder = fakeEmbedder();

    const filler = Array.from({ length: 60 }, (_, i) => `Line ${i} talks about ordinary configuration.`).join(
      '\n',
    );

    indexLibrary(db, { id: 'docs', source: 'test' }, [
      {
        path: 'long.md',
        text: `# Long\n\n## Everything\n\n${filler}\nThe instance count is fixed at one.\n`,
      },
    ]);

    const { sections, embedded } = await embedLibrary(db, 'docs', embedder);
    expect(embedded).toBeGreaterThan(sections);
    expect((await searchSemantic(db, { text: 'replicas' }, 'all', embedder, 'vector')).hits[0]?.heading).toBe(
      'Everything',
    );
  });

  it('keeps keyword results for a library that has no vectors yet', async () => {
    const db = openStore();
    indexLibrary(db, { id: 'payments', source: 'test' }, PROCESSOR);

    const { hits } = await searchSemantic(db, { text: 'currency fee' }, 'all', fakeEmbedder(), 'hybrid');
    expect(hits[0]).toMatchObject({ path: 'fees.md', heading: 'Currency fee' });
  });

  it('keeps the work of a run a re-index overtook, for the next run to reuse', async () => {
    const db = openStore();
    indexLibrary(db, { id: 'payments', source: 'test' }, PROCESSOR);

    const slow: Embedder = {
      ...fakeEmbedder(),
      async embed(texts, kind) {
        // The watcher re-indexes while this embedding is in flight.
        indexLibrary(db, { id: 'payments', source: 'test' }, PROCESSOR);

        return fakeEmbedder().embed(texts, kind);
      },
    };

    const overtaken = await embedLibrary(db, 'payments', slow);
    expect(overtaken).toMatchObject({ superseded: true });
    expect((await searchSemantic(db, { text: 'replicas' }, 'all', fakeEmbedder(), 'vector')).hits).toEqual(
      [],
    );

    expect(await embedLibrary(db, 'payments', fakeEmbedder())).toMatchObject({
      embedded: 0,
      reused: overtaken.embedded,
      superseded: false,
    });
  });

  it('counts a clear match by meaning as answered, when the model has a measured gap', async () => {
    const db = openStore();

    const filler = [
      'billing',
      'invoices',
      'exports',
      'themes',
      'locales',
      'fonts',
      'uploads',
      'webhooks',
      'tokens',
      'reports',
    ];

    indexLibrary(db, { id: 'docs', source: 'test' }, [
      PROCESSOR[0]!,
      ...filler.map((w) => ({ path: `${w}.md`, text: `# ${w}\n\n## About ${w}\n\nHow ${w} work here.\n` })),
    ]);
    const plain = fakeEmbedder();
    const measured = { ...plain, answeredGap: 0.3 };
    await embedLibrary(db, 'docs', plain);

    // "replicas" shares no word with "Why one instance", so keyword coverage alone calls it weak.
    const paraphrase = { text: 'replicas' };
    expect((await searchSemantic(db, paraphrase, 'all', plain)).answered).toBe(false);
    expect((await searchSemantic(db, paraphrase, 'all', measured)).answered).toBe(true);

    // Nothing stands out for a question the docs don't cover: still weak.
    expect(
      (await searchSemantic(db, { text: 'kubernetes certificate rotation' }, 'all', measured)).answered,
    ).toBe(false);
  });

  it('survives export and import unchanged, vectors included, keeping the target’s audit log', async () => {
    const source = openStore();
    const embedder = fakeEmbedder();
    indexLibrary(source, { id: 'payments', source: 'test' }, PROCESSOR);
    await embedLibrary(source, 'payments', embedder);

    const target = openStore();
    recordAudit(target, {
      principal: 'alice',
      tool: 'search_docs',
      query: 'kept',
      allowed: 'all',
      returned: [],
      ms: 1,
    });
    importIndex(target, parseIndexDump(JSON.stringify(exportIndex(source))));

    for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
      for (const text of ['replicas', 'currency fee', 'ordering']) {
        const before = await searchSemantic(source, { text }, 'all', embedder, mode);
        const after = await searchSemantic(target, { text }, 'all', embedder, mode);
        expect(after).toEqual(before);
      }
    }

    expect(recentAudit(target).map((e) => e.query)).toEqual(['kept']);
  });

  it('refuses a dump from another index format', () => {
    const dump = exportIndex(openStore());
    expect(() =>
      importIndex(openStore(), parseIndexDump(JSON.stringify({ ...dump, format: dump.format + 1 }))),
    ).toThrow(/same askdocs version/);
  });
});
