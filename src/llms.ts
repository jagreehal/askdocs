import { matchesGlob } from 'node:path';
import type { LoadedSource } from './sources';

/** Bounds on what one llms.txt can make us fetch. */
const MAX_PAGES = 2_000;

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

const TIMEOUT_MS = 15_000;

const CONCURRENCY = 8;

export const isLlmsTxt = (input: string) => /^https?:\/\/.+\/llms(-full)?\.txt$/i.test(input);

/**
 * A published docs site as a library: its llms.txt and the Markdown pages it links to
 * (https://llmstxt.org). Only pages on the same origin are fetched, and only if they come back
 * as Markdown or plain text: an llms.txt is an index of this site, not a crawl frontier.
 *
 * Paths are the pages' URL paths, decoded to read like file names; citations link to each page's
 * own URL, as fetched, so `C%23.md` stays one page rather than `C` with a fragment.
 */
export async function loadLlmsTxt(
  url: string,
  options: { name?: string; include?: string },
  deps: { fetch: typeof fetch } = { fetch },
): Promise<LoadedSource> {
  const index = new URL(url);
  const include = options.include ?? '**';
  const skipped: string[] = [];
  const files: { path: string; text: string; url: string }[] = [];

  const llms = await get(index, deps.fetch, index.origin);

  if ('reason' in llms) throw new Error(`Could not read ${url}: ${llms.reason}`);
  const indexPath = pathOf(index);

  if (matchesGlob(indexPath, include)) files.push({ path: indexPath, text: llms.text, url: index.href });

  // Keyed by the path each page is stored under, so links differing only in a #fragment (or in
  // escaping that means the same thing, `%62` for `b`) are one page, not a duplicate document.
  const pages = new Map<string, URL>();

  for (const [, link] of llms.text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let target: URL;

    try {
      target = new URL(link!, index);
    } catch {
      continue;
    }

    target.hash = '';

    if (target.origin !== index.origin) {
      skipped.push(`${target.href} (another site)`);
      continue;
    }

    const path = pathOf(target);

    if (path === indexPath || !matchesGlob(pathOnly(target), include)) continue;
    pages.set(path, target);
  }

  const queue = [...pages];

  if (queue.length > MAX_PAGES) {
    skipped.push(`${queue.length - MAX_PAGES} more pages (over the ${MAX_PAGES}-page limit)`);
    queue.length = MAX_PAGES;
  }

  // A few at a time: fast, without hammering the site. A page that failed for a reason that may
  // pass (network, timeout, 5xx, 429) fails the whole load, so the index keeps its last good copy
  // instead of losing that page; a page that is gone or not Markdown is deliberately left out.
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < queue.length) {
        const [path, page] = queue[next++]!;
        const body = await get(page, deps.fetch, index.origin);

        if ('text' in body) files.push({ path, text: body.text, url: page.href });
        else if (body.transient) {
          next = queue.length;
          throw new Error(`Could not read ${page.href}: ${body.reason}. Nothing was changed; try again.`);
        } else skipped.push(`${page.href} (${body.reason})`);
      }
    }),
  );

  return {
    library: {
      id: options.name ?? index.hostname,
      source: url,
      include,
      urlBase: `${index.origin}/`,
    },
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    skipped,
  };
}

/** `https://docs.acme.com/guides/deploy.md?v=2` → `guides/deploy.md?v=2`: the query picks the content, so it is part of the identity. */
const pathOf = (url: URL) => pathOnly(url) + url.search;

/**
 * The URL path, decoded to read like a file name, except for escapes whose decoded character
 * would collide with another URL's path (`%3F` with a query, `%2F` with a folder, `%25` with an
 * escape): `guide%3Fv=2` and `guide?v=2` are different pages and keep different paths.
 */
const pathOnly = (url: URL) =>
  url.pathname
    .split(/(%(?:2[5F]|3F))/i)
    .map((part, i) => (i % 2 ? part.toUpperCase() : decodeOrKeep(part)))
    .join('')
    .replace(/^\/+/, '') || 'index';

const decodeOrKeep = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray `%` that is not an escape: keep it as written.
    return text;
  }
};

/**
 * The page's text, or why it was not used. Redirects are followed by hand, and only while they
 * stay on `origin`: letting fetch follow them would send a request wherever the site points it,
 * including hosts on the server's own network.
 */
async function get(
  url: URL,
  fetchFn: typeof fetch,
  origin: string,
): Promise<{ text: string } | { reason: string; transient?: boolean }> {
  let res: Response;
  let at = url;

  for (let hops = 0; ; hops++) {
    try {
      res = await fetchFn(at, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'text/markdown, text/plain;q=0.9' },
      });
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), transient: true };
    }

    const location = res.headers.get('location');

    if (res.status < 300 || res.status >= 400 || !location) break;
    const next = new URL(location, at);

    if (next.origin !== origin) return { reason: `redirected off the site, to ${next.origin}` };

    if (hops === 5) return { reason: 'too many redirects' };
    at = next;
  }

  if (!res.ok) {
    await res.body?.cancel();

    return {
      reason: `HTTP ${res.status}`,
      transient: res.status >= 500 || res.status === 408 || res.status === 429,
    };
  }

  const type = res.headers.get('content-type') ?? '';
  const markdownish = /markdown|text\/plain/i.test(type) || (!type && /\.(md|mdx|txt)$/i.test(at.pathname));

  if (!markdownish) return { reason: 'not Markdown' };
  const text = await readCapped(res);

  return text === undefined ? { reason: `over ${MAX_PAGE_BYTES / 1024 / 1024} MB` } : { text };
}

/** The body as text, or undefined once it passes MAX_PAGE_BYTES, without reading (or buffering) the rest. */
async function readCapped(res: Response): Promise<string | undefined> {
  if (Number(res.headers.get('content-length')) > MAX_PAGE_BYTES) {
    await res.body?.cancel();

    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  // Leaving the loop early cancels the stream.
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;

    if (size > MAX_PAGE_BYTES) return undefined;
    chunks.push(chunk);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}
