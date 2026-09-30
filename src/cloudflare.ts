import { createHash, timingSafeEqual } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { discoverOAuth } from 'mcp-authz';
import { z } from 'zod';
import { githubRepoReader, parseAccess } from './access';
import { createHttpHandler } from './http';
import {
  attachStore,
  importIndex,
  listLibraries,
  parseIndexDump,
  queryStats,
  recentAudit,
  type Database,
} from './store';
import { embedLibrary, workersAiEmbedder, type Embedder, type WorkersAi } from './vectors';

/**
 * askdocs on Cloudflare: a Worker in front of one Durable Object, which keeps the index in its
 * own SQLite (FTS5 included) and serves MCP from it. No server, no disk: CI builds the index
 * with `askdocs add` and uploads it with `askdocs publish`.
 *
 * In your Worker:    export { AskdocsIndex, default } from 'askdocs/cloudflare';
 *
 * The Durable Object also keeps the audit log, which the admin endpoints read.
 */
type SqlValue = string | number | null | ArrayBuffer;

export type SqlStorage = {
  exec: (
    query: string,
    ...bindings: SqlValue[]
  ) => { toArray: () => Record<string, SqlValue>[]; rowsWritten: number };
};

export type DurableObjectState = {
  storage: { sql: SqlStorage; transactionSync: <T>(write: () => T) => T };
  waitUntil: (work: Promise<void>) => void;
};

type DurableObjectNamespace = {
  idFromName: (name: string) => string;
  get: (id: string) => { fetch: (request: Request) => Promise<Response> };
};

export type Env = {
  ASKDOCS: DurableObjectNamespace;
  /** Where agents reach this server, e.g. https://docs.acme.com/mcp. Tokens must be issued for it. */
  MCP_PUBLIC_URL: string;
  OAUTH_ISSUER: string;
  OAUTH_JWKS_URI?: string;
  /** The access file's JSON (see the README): who may read which library. */
  ACCESS: string;
  /** Bearer token for /admin: publishing an index, and reading the audit log and gaps. */
  ADMIN_TOKEN: string;
  /** Needed when ACCESS has a "github" block. */
  GITHUB_TOKEN?: string;
  /** A Workers AI embedding model, e.g. @cf/google/embeddinggemma-300m, for semantic search. Needs the AI binding. */
  EMBED_MODEL?: string;
  AI?: WorkersAi;
  /** Days of audit log to keep (default 30; 0 keeps none). */
  AUDIT_DAYS?: string;
};

type Param = Parameters<ReturnType<Database['prepare']>['all']>[number];

/** Bytes cross into a Durable Object as an ArrayBuffer of their own. */
const bind = (params: Param[]) =>
  params.map((v): SqlValue => (v instanceof Uint8Array ? v.slice().buffer : v));

const digest = (secret: string) => createHash('sha256').update(secret).digest();

/**
 * node:sqlite's DatabaseSync, as far as askdocs uses it, over a Durable Object's SQL storage.
 * Blobs cross as ArrayBuffer there and as bytes here.
 */
export function durableObjectDatabase(sql: SqlStorage): Database {
  const rows = (text: string, params: Param[]) =>
    sql
      .exec(text, ...bind(params))
      .toArray()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]): [string, SQLOutputValue] => [
            k,
            v instanceof ArrayBuffer ? new Uint8Array(v) : v,
          ]),
        ),
      );

  return {
    // A Durable Object runs one request at a time, and writes made without an await in between
    // commit together: a read is already a snapshot. It forbids BEGIN and COMMIT, so they are
    // no-ops here; askdocs never awaits inside one. A failed statement between them is not
    // rolled back, where SQLite would; importIndex uses transactionSync, which is.
    isTransaction: true,
    exec(text) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) return;
      sql.exec(text);
    },
    prepare(text) {
      return {
        all: (...params: Param[]) => rows(text, params),
        get: (...params: Param[]) => rows(text, params)[0],
        run: (...params: Param[]) => ({
          changes: sql.exec(text, ...bind(params)).rowsWritten,
          lastInsertRowid: 0,
        }),
      };
    },
  };
}

/** Constant-time: a token check that takes as long for a near miss as for a wild guess. */
function sameSecret(given: string, expected: string): boolean {
  return expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
}

export class AskdocsIndex {
  private readonly db: Database;
  private readonly embedder: Embedder | undefined;
  private mcp: Promise<(request: Request) => Promise<Response>> | undefined;
  private embedding = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.db = attachStore(durableObjectDatabase(state.storage.sql), {
      auditRetentionDays: Number(env.AUDIT_DAYS ?? 30),
    });

    if (env.EMBED_MODEL) {
      if (!env.AI) throw new Error('EMBED_MODEL needs an AI binding (Workers AI) in wrangler.toml');
      this.embedder = workersAiEmbedder(env.AI, env.EMBED_MODEL);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/admin/')) return this.admin(request, url);

    // A failed start (the issuer briefly unreachable) is retried by the next request.
    this.mcp ??= this.startMcp().catch((error: Error) => {
      this.mcp = undefined;
      throw error;
    });

    return (await this.mcp)(request);
  }

  private async startMcp() {
    const access = parseAccess(this.env.ACCESS);

    // Fail closed, as the CLI does: GitHub-backed permissions with no way to ask GitHub would serve nobody correctly.
    if (access.github && !this.env.GITHUB_TOKEN)
      throw new Error('ACCESS has a "github" block, so GITHUB_TOKEN is required');

    const canReadRepo =
      access.github && this.env.GITHUB_TOKEN
        ? githubRepoReader({ token: this.env.GITHUB_TOKEN, ttlSeconds: access.github.ttlSeconds })
        : undefined;

    return createHttpHandler(
      {
        db: this.db,
        access,
        resourceServerUrl: new URL(this.env.MCP_PUBLIC_URL),
        oauthMetadata: await discoverOAuth(this.env.OAUTH_ISSUER),
        jwksUri: this.env.OAUTH_JWKS_URI,
        embedder: this.embedder,
      },
      canReadRepo ? { canReadRepo } : {},
    );
  }

  private async admin(request: Request, url: URL): Promise<Response> {
    const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

    if (!sameSecret(given, this.env.ADMIN_TOKEN)) return new Response('forbidden', { status: 403 });

    if (url.pathname === '/admin/publish' && request.method === 'POST') {
      const dump = parseIndexDump(await request.text());
      const loaded = importIndex(this.db, dump, (write) => this.state.storage.transactionSync(write));
      // Vectors follow in the background: searches answer by keyword until they're ready.
      this.embedInBackground();

      return Response.json(loaded);
    }

    if (url.pathname === '/admin/audit')
      return Response.json(recentAudit(this.db, Number(url.searchParams.get('limit') ?? 50)));

    if (url.pathname === '/admin/stats') return Response.json(queryStats(this.db));

    if (url.pathname === '/admin/status') {
      const model = this.embedder?.id;

      const embedded = model
        ? z
            .array(z.object({ library: z.string(), n: z.number() }))
            .parse(
              this.db
                .prepare(
                  'SELECT library, count(DISTINCT section) AS n FROM vectors WHERE model = ? GROUP BY library',
                )
                .all(model),
            )
        : [];

      return Response.json({
        embedding: model ?? null,
        libraries: listLibraries(this.db, 'all').map((l) => ({
          id: l.id,
          sections: l.sections,
          indexedAt: l.indexedAt,
          embedded: embedded.find((e) => e.library === l.id)?.n ?? 0,
        })),
      });
    }

    return new Response('not found', { status: 404 });
  }

  /** One embedding run at a time; each embeds only what changed since the last. */
  private embedInBackground() {
    const embedder = this.embedder;

    if (!embedder) return;

    this.embedding = this.embedding.then(async () => {
      for (const lib of listLibraries(this.db, 'all')) {
        try {
          await embedLibrary(this.db, lib.id, embedder);
        } catch (error) {
          console.error(`askdocs: could not embed ${lib.id}; it is searchable by keyword only`, error);
        }
      }
    });
    this.state.waitUntil(this.embedding);
  }
}

/** Every request goes to the one index. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASKDOCS.get(env.ASKDOCS.idFromName('askdocs')).fetch(request);
  },
};
