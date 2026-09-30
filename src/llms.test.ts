import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadSource, syncLibrary } from './sources';
import { indexLibrary, listLibraries, openStore, search } from './store';

/** A published docs site: an llms.txt index and the Markdown pages it links to. */
type Page = { type: string; body: string } | { redirect: string } | { status: number };

const pages = new Map<string, Page>(
  Object.entries({
    '/llms.txt': {
      type: 'text/plain',
      body: [
        '# Acme docs',
        '',
        '> Everything about the Acme platform.',
        '',
        '## Guides',
        '',
        '- [Deploying](/guides/deploy.md): how releases go out',
        '- [Rollbacks](guides/rollback.md)',
        '- [Architecture](/architecture): HTML only, no Markdown version',
        '- [Moved page](/old.md)',
        '- [Renamed page](/moved-here.md)',
        '- [Partner docs](https://partner.example.com/api.md)',
        '',
        '## Optional',
        '',
        '- [Changelog](/changelog.md)',
      ].join('\n'),
    },
    '/guides/deploy.md': {
      type: 'text/markdown',
      body: '# Deploying\n\n## Canary\n\nShip to 5% of traffic first.\n',
    },
    '/guides/rollback.md': {
      type: 'text/markdown; charset=utf-8',
      body: '# Rollbacks\n\nRevert the release tag.\n',
    },
    '/architecture': { type: 'text/html', body: '<html><body><h1>Architecture</h1></body></html>' },
    '/old.md': { redirect: 'https://elsewhere.example.com/old.md' },
    '/moved-here.md': { redirect: '/guides/rollback.md' },
    '/changelog.md': { type: 'text/markdown', body: '# Changelog\n\n## 2.0\n\nNew billing engine.\n' },
  }),
);

let server: Server;

let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = pages.get(req.url ?? '');

    if (!page) res.writeHead(404).end();
    else if ('redirect' in page) res.writeHead(302, { location: page.redirect }).end();
    else if ('status' in page) res.writeHead(page.status).end();
    else res.writeHead(200, { 'content-type': page.type }).end(page.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
});

afterAll(() => {
  server.close();
});

describe('a site published with llms.txt', () => {
  it('becomes a library of the Markdown pages it links to, on the same site only', async () => {
    const { library, files, skipped } = await loadSource(`${base}/llms.txt`);
    expect(library).toMatchObject({ id: '127.0.0.1', source: `${base}/llms.txt`, urlBase: `${base}/` });
    // A redirect within the site is followed (moved-here.md serves rollback's text); one off it never is.
    expect(files.map((f) => f.path)).toEqual([
      'changelog.md',
      'guides/deploy.md',
      'guides/rollback.md',
      'llms.txt',
      'moved-here.md',
    ]);
    expect(skipped.toSorted()).toEqual([
      `${base}/architecture (not Markdown)`,
      `${base}/old.md (redirected off the site, to https://elsewhere.example.com)`,
      'https://partner.example.com/api.md (another site)',
    ]);

    const db = openStore();
    indexLibrary(db, library, files);
    expect(search(db, { text: 'canary traffic' }, 'all').hits[0]).toMatchObject({
      path: 'guides/deploy.md',
      heading: 'Canary',
      url: `${base}/guides/deploy.md#L3`,
    });
  });

  it('can be narrowed with --include, and re-synced', async () => {
    const db = openStore();
    const { library, files } = await loadSource(`${base}/llms.txt`, { include: 'guides/**' });
    indexLibrary(db, library, files);
    expect(listLibraries(db, 'all')[0]).toMatchObject({ files: 2 });
    pages.set('/guides/deploy.md', {
      type: 'text/markdown',
      body: '# Deploying\n\n## Blue green\n\nSwitch the router.\n',
    });
    await syncLibrary(db, listLibraries(db, 'all')[0]!);
    expect(search(db, { text: 'router switch' }, 'all').hits[0]?.path).toBe('guides/deploy.md');
  });

  it('fails, keeping nothing half-read, when llms.txt itself is missing', async () => {
    await expect(loadSource(`${base}/nope/llms.txt`)).rejects.toThrow(/404/);
  });

  it('stores one document per page: #fragments dropped, query strings kept in its path and citation', async () => {
    pages.set('/v/llms.txt', {
      type: 'text/plain',
      body: '- [Intro](/v/guide.md#intro)\n- [Install](/v/guide.md#install)\n- [v2](/v/guide.md?version=2)\n',
    });
    pages.set('/v/guide.md', { type: 'text/markdown', body: '# Guide\n\nVersion one.\n' });
    pages.set('/v/guide.md?version=2', { type: 'text/markdown', body: '# Guide\n\nVersion two tachyons.\n' });
    const { library, files } = await loadSource(`${base}/v/llms.txt`);
    expect(files.map((f) => f.path)).toEqual(['v/guide.md', 'v/guide.md?version=2', 'v/llms.txt']);
    const db = openStore();
    indexLibrary(db, library, files);
    expect(search(db, { text: 'tachyons' }, 'all').hits[0]?.url).toBe(`${base}/v/guide.md?version=2#L1`);
  });

  it('fails the sync, keeping the last good index, when a page is temporarily unavailable', async () => {
    pages.set('/flaky/llms.txt', { type: 'text/plain', body: '- [Runbook](/flaky/runbook.md)\n' });
    pages.set('/flaky/runbook.md', {
      type: 'text/markdown',
      body: '# Runbook\n\nPage the on-call quokka.\n',
    });
    const db = openStore();
    const { library, files } = await loadSource(`${base}/flaky/llms.txt`);
    indexLibrary(db, library, files);
    pages.set('/flaky/runbook.md', { status: 503 });
    await expect(syncLibrary(db, listLibraries(db, 'all')[0]!)).rejects.toThrow(/503/);
    expect(search(db, { text: 'quokka' }, 'all').hits).toHaveLength(1);
  });

  it('measures the page limit in bytes, not characters', async () => {
    pages.set('/big/llms.txt', { type: 'text/plain', body: '- [Big](/big/page.md)\n' });
    // 1M characters, 3 MB of UTF-8.
    pages.set('/big/page.md', { type: 'text/markdown', body: '€'.repeat(1024 * 1024) });
    const { skipped } = await loadSource(`${base}/big/llms.txt`);
    expect(skipped).toEqual([`${base}/big/page.md (over 2 MB)`]);
  });
});

describe('citations for pages whose URLs carry encoded characters', () => {
  it('link to the page as fetched, not to a path cut short at a decoded # or ?', async () => {
    pages.set('/enc/llms.txt', {
      type: 'text/plain',
      body: '- [C#](/enc/C%23.md)\n- [Why](/enc/why%3F.md)\n',
    });
    pages.set('/enc/C%23.md', { type: 'text/markdown', body: '# C sharp\n\nDelegates and axolotls.\n' });
    pages.set('/enc/why%3F.md', { type: 'text/markdown', body: '# Why\n\nBecause of narwhals.\n' });
    const { library, files } = await loadSource(`${base}/enc/llms.txt`);
    const db = openStore();
    indexLibrary(db, library, files);
    expect(search(db, { text: 'axolotls' }, 'all').hits[0]).toMatchObject({
      path: 'enc/C#.md',
      url: `${base}/enc/C%23.md#L1`,
    });
    expect(search(db, { text: 'narwhals' }, 'all').hits[0]?.url).toBe(`${base}/enc/why%3F.md#L1`);
  });
  it('keeps a page with an escaped ? apart from the same name with a query', async () => {
    pages.set('/q/llms.txt', { type: 'text/plain', body: '- [A](/q/guide%3Fv=2)\n- [B](/q/guide?v=2)\n' });
    pages.set('/q/guide%3Fv=2', { type: 'text/markdown', body: '# Escaped\n\nOcelots.\n' });
    pages.set('/q/guide?v=2', { type: 'text/markdown', body: '# Query\n\nCapybaras.\n' });
    const { files } = await loadSource(`${base}/q/llms.txt`);
    expect(files.map((f) => [f.path, f.url]).toSorted(([a], [b]) => (a! < b! ? -1 : 1))).toEqual([
      ['q/guide%3Fv=2', `${base}/q/guide%3Fv=2`],
      ['q/guide?v=2', `${base}/q/guide?v=2`],
      ['q/llms.txt', `${base}/q/llms.txt`],
    ]);
  });
});
