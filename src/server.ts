import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from 'autotel-mcp-instrumentation/server';
import { z } from 'zod';
import { codeBlocks, listHeadings, matchHeadings, sectionAt } from './markdown';
import { citationUrl, listLibraries, readDoc, recordAudit, search, type Scope, type Database } from './store';
import { recordToolCall } from './telemetry';
import { searchSemantic, type Embedder } from './vectors';

/** Who is calling, and what they may see. Built once per request, before any tool runs. */
export type Caller = {
  /** Audit identity: email or `sub` over HTTP, the OS user over stdio. */
  principal: string;
  /** The OAuth client the token was issued to (e.g. Claude Code), when the token says. */
  agent?: string;
  scope: Scope;
  /** Why the scope is narrower than it should be, when we know — shown to the agent so it can tell the human. */
  notice?: string;
};

/** Response budgets, so no single call floods an agent's context. */
const SNIPPET_CHARS = 300;

const PAGE_CHARS = 16_000; // ~4k tokens per read_doc page

const WEAK =
  'Weak matches only: none of the top results covers most of your question, so the docs may not answer it. Say so rather than relying on these.';

const Citation = {
  library: z.string(),
  path: z.string(),
  heading: z.string(),
  line: z.number().describe('Pass to read_doc as `line`. 0 is the text before the first heading'),
  commit: z.string().optional().describe('Git commit the library was indexed at'),
  revision: z
    .string()
    .describe('Pass to read_doc as `revision`, so a line from an edited document is refused'),
  url: z.string().optional().describe('Link a human can open'),
};

const Outline = z.array(z.object({ level: z.number(), text: z.string(), line: z.number() }));

const SearchOutput = z.object({
  results: z.array(z.object({ ...Citation, title: z.string(), breadcrumb: z.string(), snippet: z.string() })),
  answered: z.boolean().describe('False when no top result covers most of the question'),
  nextOffset: z.number().optional().describe('Pass as `offset` for more results'),
  notice: z.string().optional(),
});

const ReadOutput = z.object({
  library: z.string(),
  path: z.string(),
  title: z.string(),
  heading: z.string().optional(),
  line: z.number().optional(),
  text: z.string().describe('Empty when the document is too long to return at once; see outline'),
  page: z.number(),
  pages: z.number(),
  outline: Outline.optional(),
  revision: z.string(),
  commit: z.string().optional(),
  url: z.string().optional(),
  notice: z.string().optional(),
});

const ListOutput = z.object({
  libraries: z.array(
    z.object({ id: z.string(), files: z.number(), sections: z.number(), commit: z.string().optional() }),
  ),
  nextOffset: z.number().optional(),
  notice: z.string().optional(),
});

type Result = CallToolResult;

const fail = (message: string): Result => ({ content: [{ type: 'text', text: message }], isError: true });

const unknownLibrary = (library: string) =>
  fail(`Unknown library "${library}". Call list_libraries to see the libraries you can search.`);

/**
 * A handler that cannot throw. An agent gets an error it can act on, never a stack trace;
 * the details go to stderr for whoever runs the server.
 */
function safe<A>(handler: (args: A) => Result | Promise<Result>): (args: A) => Promise<Result> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      console.error('askdocs: tool call failed:', error);
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);

      return fail(
        `askdocs could not complete this request (${reason}). Try again; if it keeps failing, the server's operator can run \`askdocs doctor\`.`,
      );
    }
  };
}

/** Split text into pages of at most PAGE_CHARS, on line boundaries where possible. */
function paginate(text: string): string[] {
  const pages: string[] = [];
  let page = '';

  for (const line of text.split('\n')) {
    for (let rest = line; ;) {
      const room = PAGE_CHARS - page.length - (page ? 1 : 0);

      if (rest.length <= room) {
        page += (page ? '\n' : '') + rest;
        break;
      }

      if (page) {
        pages.push(page);
        page = '';
        continue;
      }

      pages.push(rest.slice(0, PAGE_CHARS));
      rest = rest.slice(PAGE_CHARS);
    }
  }

  if (page || !pages.length) pages.push(page);

  return pages;
}

const capSnippet = (snippet: string) =>
  snippet.length <= SNIPPET_CHARS ? snippet : `${snippet.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`;

/** Headings of a document, or of the section starting at `line`, with the document's own line numbers. */
function outlineOf(body: string, line?: number) {
  const all = listHeadings(body);

  if (line === undefined) return all;
  const at = all.findIndex((h) => h.line === line);

  if (at < 0) return [];
  const end = all.findIndex((h, i) => i > at && h.level <= all[at]!.level);

  return all.slice(at, end < 0 ? undefined : end);
}

/** Indented relative to the shallowest heading, with each heading's line so it can be read directly. */
function toc(outline: { level: number; text: string; line: number }[]): string {
  const top = Math.min(...outline.map((h) => h.level));

  return outline.map((h) => `${'  '.repeat(h.level - top)}- ${h.text} (line ${h.line})`).join('\n');
}

/**
 * Which part of a document the caller asked for. `line` is exact (search_docs returns it);
 * `heading` may be a heading or a heading path, and must match exactly one section.
 */
function resolveSection(
  body: string,
  path: string,
  ask: { line?: number; heading?: string },
): { text: string; line?: number; heading?: string } | { error: string } {
  const headingAt = (line: number) => listHeadings(body).find((h) => h.line === line)?.text;

  if (ask.line !== undefined) {
    const found = sectionAt(body, ask.line);

    return found !== undefined
      ? { text: found, line: ask.line, heading: headingAt(ask.line) }
      : {
          error: `No section starts at line ${ask.line} of ${path}. Use a line from search_docs, or one of these:\n${toc(listHeadings(body))}`,
        };
  }

  if (!ask.heading) return { text: body };
  const matches = matchHeadings(body, ask.heading);

  if (matches.length === 1) {
    const [m] = matches;

    return { text: sectionAt(body, m!.line)!, line: m!.line, heading: m!.text };
  }

  if (!matches.length) {
    return { error: `No heading "${ask.heading}" in ${path}. Headings:\n${toc(listHeadings(body))}` };
  }

  const options = matches.map((m) => `- ${m.path.join(' > ')} (line ${m.line})`).join('\n');

  return {
    error: `"${ask.heading}" matches ${matches.length} sections in ${path}. Pass line, or a heading path:\n${options}`,
  };
}

/**
 * Three tools, on purpose. Agents do search → read; every extra tool is one more
 * thing for the model to choose wrongly between.
 *
 * Every read goes through the caller's scope, and a document outside it reads
 * exactly like one that does not exist, so its existence is not disclosed either.
 */
export function createServer(
  db: Database,
  caller: Caller,
  options: {
    /** Rank by meaning as well as keywords (see vectors.ts). Without one, search is keyword only. */
    embedder?: Embedder;
  } = {},
): McpServer {
  // A span per tool call, in the standard MCP attributes, continuing the agent's trace when its
  // request carries one. Tool arguments and results stay off the span (the defaults): they are
  // the questions people ask and the docs they read.
  const server = instrumentMcpServer(
    new McpServer({ name: 'askdocs', version: '0.1.0' }, { capabilities: { tools: {} } }),
  );

  const withNotice = (text: string) => (caller.notice ? `${text}\n\n${caller.notice}` : text);
  const visible = () => new Set(listLibraries(db, caller.scope).map((l) => l.id));

  // Hybrid when there is an embedder. If embedding the question fails (Ollama stopped, say),
  // keyword search still answers: semantic search is an enhancement, never a dependency.
  const find = async (q: Parameters<typeof search>[1]) => {
    if (!options.embedder) return search(db, q, caller.scope);

    try {
      return await searchSemantic(db, q, caller.scope, options.embedder);
    } catch (error) {
      console.error('askdocs: semantic search failed, answering by keyword alone:', error);

      return search(db, q, caller.scope);
    }
  };

  const audit = (event: {
    tool: string;
    query: string;
    library?: string;
    returned: string[];
    answered?: boolean;
    started: number;
  }) => {
    const ms = performance.now() - event.started;
    recordToolCall({ ...event, results: event.returned.length });
    recordAudit(db, {
      principal: caller.principal,
      agent: caller.agent,
      allowed: caller.scope === 'all' ? 'all' : caller.scope.map((s) => s.id),
      tool: event.tool,
      query: event.query,
      library: event.library,
      returned: event.returned,
      answered: event.answered,
      ms,
    });
  };

  server.registerTool(
    'list_libraries',
    {
      description:
        'List the documentation libraries you can search. Use it when you need to know what docs exist, or want to limit search_docs to one library with `library`. You do not need it before searching: search_docs covers every library by default.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max libraries, default 50'),
        offset: z.number().int().min(0).optional().describe('Skip this many, for paging'),
      }),
      outputSchema: ListOutput,
      annotations: { readOnlyHint: true },
    },
    safe(({ limit = 50, offset = 0 }) => {
      const started = performance.now();
      const all = listLibraries(db, caller.scope);
      const libs = all.slice(offset, offset + limit);
      const more = all.length > offset + limit;
      audit({
        tool: 'list_libraries',
        query: `limit=${limit}&offset=${offset}`,
        returned: libs.map((l) => l.id),
        started,
      });

      const structured: z.infer<typeof ListOutput> = {
        libraries: libs.map((l) => {
          const entry: z.infer<typeof ListOutput>['libraries'][number] = {
            id: l.id,
            files: l.files,
            sections: l.sections,
          };

          if (l.sha) entry.commit = l.sha;

          return entry;
        }),
      };

      if (more) structured.nextOffset = offset + limit;

      if (caller.notice) structured.notice = caller.notice;

      const lines = libs.map((l) => `${l.id} — ${l.sections} sections in ${l.files} files`);

      if (more) lines.push(`(more: call list_libraries with offset ${offset + limit})`);

      return {
        content: [{ type: 'text', text: withNotice(lines.join('\n') || 'No libraries available.') }],
        structuredContent: structured,
      };
    }),
  );

  server.registerTool(
    'search_docs',
    {
      description:
        "Search this project's documentation. Use it first whenever you need facts from the docs: how something works, an API, configuration, a runbook, an architecture decision. It returns ranked sections with a snippet and a citation (library, path, heading, line, revision, commit); then call read_doc with the library, path, line and revision of the best hit to read that section in full. If read_doc says the document has changed, search again. If it says the matches are weak, the docs probably do not cover the question: say so instead of guessing. Use specific terms (service names, error codes, API names), and wrap the whole query in double quotes to match an exact phrase such as an error message.",
      inputSchema: z.object({
        query: z.string().min(1).describe('What you are looking for, e.g. "payout retry idempotency"'),
        library: z.string().optional().describe('Limit to one library id from list_libraries'),
        language: z
          .string()
          .optional()
          .describe('Only sections with a code example in this language, e.g. "typescript", "bash"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results, default 8'),
        offset: z.number().int().min(0).optional().describe('Skip this many results, for paging'),
      }),
      outputSchema: SearchOutput,
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, library, language, limit = 8, offset = 0 }) => {
      const started = performance.now();

      if (library && !visible().has(library)) {
        audit({ tool: 'search_docs', query, library, returned: [], answered: false, started });

        return unknownLibrary(library);
      }

      const { hits, answered, more } = await find({ text: query, library, language, limit, offset });

      audit({
        tool: 'search_docs',
        query,
        library,
        returned: hits.map((h) => `${h.library}/${h.path}#${h.heading}`),
        answered,
        started,
      });

      const results = hits.map((h) => {
        const result: z.infer<typeof SearchOutput>['results'][number] = {
          library: h.library,
          path: h.path,
          heading: h.heading,
          line: h.line,
          revision: h.revision,
          title: h.title,
          breadcrumb: h.breadcrumb,
          snippet: capSnippet(h.snippet),
        };

        if (h.commit) result.commit = h.commit;

        if (h.url) result.url = h.url;

        return result;
      });

      const structuredContent: z.infer<typeof SearchOutput> = { results, answered };

      if (more) structuredContent.nextOffset = offset + limit;

      if (caller.notice) structuredContent.notice = caller.notice;

      if (!results.length) {
        const none = `No results for "${query}"${library ? ` in ${library}` : ''}. The docs may not cover it; try other terms, or say the docs do not answer it.`;

        return { content: [{ type: 'text', text: withNotice(none) }], structuredContent };
      }

      const body = results
        .map((r, i) =>
          [
            `[${offset + i + 1}] ${r.library} · ${r.path} · ${r.breadcrumb}`,
            `line: ${r.line} · revision ${r.revision}${r.commit ? ` · commit ${r.commit.slice(0, 7)}` : ''}`,
            r.snippet,
            ...(r.url ? [`source: ${r.url}`] : []),
          ].join('\n'),
        )
        .join('\n\n');

      const next = more ? `\n\n(more results: call search_docs with offset ${offset + limit})` : '';

      return {
        content: [{ type: 'text', text: withNotice(`${answered ? '' : `${WEAK}\n\n`}${body}${next}`) }],
        structuredContent,
      };
    }),
  );

  server.registerTool(
    'read_doc',
    {
      description:
        'Read documentation found with search_docs. Pass the library, path, line and revision of a search result to read exactly that section (its heading and everything nested under it); this keeps context small. The revision makes the read fail, rather than return different text, if the document changed after the search. Without line or heading it reads the whole document, or, if that is too long, returns its outline so you can pick a section. Pass outline to get only the headings, or language to get only the code examples. Long sections come in pages: pass page to continue.',
      inputSchema: z.object({
        library: z.string().describe('Library id, from search_docs'),
        path: z.string().describe('Document path, from search_docs'),
        line: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'The section to read: the line from search_docs, or from an outline. 0 is the text before the first heading',
          ),
        heading: z
          .string()
          .optional()
          .describe(
            'Alternative to line: a heading, or a heading path like "Client B > Errors" when names repeat',
          ),
        outline: z.boolean().optional().describe('Return only the heading outline, to pick a section from'),
        language: z
          .string()
          .optional()
          .describe('Return only the code blocks in this language, from the document or the section'),
        page: z.number().int().min(1).optional().describe('Page of a long section or document, from 1'),
        revision: z
          .string()
          .optional()
          .describe('The revision from search_docs. If the document has changed since, the read is refused'),
      }),
      outputSchema: ReadOutput,
      annotations: { readOnlyHint: true },
    },
    safe(({ library, path, line, heading, outline, language, page, revision }) => {
      const started = performance.now();
      const doc = visible().has(library) ? readDoc(db, { library, path }, caller.scope) : undefined;
      // A line or heading from an older revision may now point at different text: refuse it, rather than
      // hand over a section that only looks like the one that was found.
      const stale = !!doc && revision !== undefined && revision !== doc.revision;
      const section = doc && !stale ? resolveSection(doc.body, path, { line, heading }) : undefined;

      const what = [
        line !== undefined ? `#L${line}` : heading && `#${heading}`,
        outline && '?outline',
        language && `?language=${language}`,
        page && `?page=${page}`,
      ]
        .filter(Boolean)
        .join('');

      audit({
        tool: 'read_doc',
        query: `${path}${what}`,
        library,
        returned: section && 'text' in section ? [`${library}/${path}${what}`] : [],
        started,
      });

      if (!visible().has(library)) return unknownLibrary(library);

      if (stale) {
        return fail(
          `${path} has changed since search_docs returned revision ${revision}, so that line may point at different text. Call search_docs again for current lines.`,
        );
      }

      if (!doc || !section) {
        return fail(`No document "${path}" in ${library}. Use a path exactly as search_docs returned it.`);
      }

      if ('error' in section) return fail(section.error);

      const sectionOutline = outlineOf(doc.body, section.line);
      const url = citationUrl({ url: doc.url, urlBase: doc.urlBase, path }, section.line ?? 1);

      const base: Omit<z.infer<typeof ReadOutput>, 'text' | 'page' | 'pages'> = {
        library,
        path,
        title: doc.title,
        revision: doc.revision,
      };

      if (section.heading) base.heading = section.heading;

      if (section.line !== undefined) base.line = section.line;

      if (doc.commit) base.commit = doc.commit;

      if (url) base.url = url;

      if (caller.notice) base.notice = caller.notice;

      const reply = (
        text: string,
        extra: { page: number; pages: number; outline?: typeof sectionOutline },
      ) => ({
        content: [{ type: 'text' as const, text: withNotice(text) }],
        structuredContent: { ...base, text: extra.outline ? '' : text, ...extra },
      });

      if (outline)
        return reply(toc(sectionOutline) || '(no headings)', { page: 1, pages: 1, outline: sectionOutline });

      const content = language
        ? codeBlocks(section.text, language)
            .map((b) => `\`\`\`${b.language}\n${b.code}\n\`\`\``)
            .join('\n\n')
        : section.text;

      if (language && !content)
        return reply(`No ${language} code blocks in that part of ${path}.`, { page: 1, pages: 1 });

      const pages = paginate(content);

      // A whole document too long to return: its outline is the useful answer.
      if (pages.length > 1 && !page && line === undefined && !heading && !language) {
        const pointer = `${path} is too long to return at once (${content.length.toLocaleString('en')} characters, ${pages.length} pages). Read one section by passing its line from this outline, or page through with page: 1.\n\n${toc(sectionOutline)}`;

        return {
          content: [{ type: 'text', text: withNotice(pointer) }],
          structuredContent: { ...base, text: '', page: 0, pages: pages.length, outline: sectionOutline },
        };
      }

      const n = page ?? 1;

      if (n > pages.length) {
        return fail(`Page ${n} does not exist: this part of ${path} has ${pages.length} pages.`);
      }

      const more =
        n < pages.length
          ? `\n\n(page ${n} of ${pages.length}: call read_doc with the same arguments and page ${n + 1} to continue)`
          : '';

      return {
        content: [{ type: 'text', text: withNotice(`${pages[n - 1]}${more}`) }],
        structuredContent: { ...base, text: pages[n - 1]!, page: n, pages: pages.length },
      };
    }),
  );

  return server;
}
