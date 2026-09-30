import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { discoverOAuth } from 'mcp-authz';
import { z } from 'zod';
import { githubRepoReader, loadAccess, parseAccess, type Access, type RepoReader } from './access';
import { createHttpHandler } from './http';
import { importIndex, openStore, parseIndexDump, type AuditEvent } from './store';
import { embedderFrom, type Embedder } from './vectors';

/**
 * askdocs on AWS Lambda, behind API Gateway (for example aws-cdk-mcp's StatelessMcpServer) or a
 * function URL. MCP is stateless here, so any instance answers any request.
 *
 * In your Lambda:    export { handler } from 'askdocs/lambda';
 *
 * CI builds the index with `askdocs add` and writes it with `askdocs export index.json`, then
 * either bundles that file with the function or uploads it to S3. From S3, a warm instance
 * checks for a new index every ASKDOCS_REFRESH_SECONDS, so publishing needs no redeploy.
 *
 * The index lives in memory: nothing is written to disk. Audit entries go to the function's log
 * (CloudWatch) as JSON lines, next to the gateway's access logs.
 */

/** API Gateway HTTP API (payload 2.0) and function URL events: the fields a request needs. */
const LambdaEvent = z.object({
  rawPath: z.string(),
  rawQueryString: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().default(false),
  requestContext: z.object({ domainName: z.string(), http: z.object({ method: z.string() }) }),
});

export type LambdaResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
};

/**
 * Where the index comes from. Given the version already loaded, it returns a newer one, or
 * undefined when nothing changed.
 */
export type IndexSource = (
  loaded: string | undefined,
) => Promise<{ text: string; version: string } | undefined>;

/**
 * A custom domain's API mapping (docs.acme.com/docs → this API) is stripped from `rawPath`, so
 * `/docs/mcp` arrives as `/mcp`. When the public URL ends with the path that arrived, the rest of
 * it is that prefix, and it goes back on: the router matches the URL clients actually use.
 * OAuth discovery lives at the domain's root, outside the mapping: aws-cdk-mcp's `metadataApi`
 * answers it there (docs/lambda.md), or a root mapping to this function, which serves it too.
 */
function publicPath(rawPath: string, publicUrl: URL | undefined): string {
  const path = publicUrl?.pathname ?? rawPath;

  return path !== rawPath && path.endsWith(rawPath) ? path : rawPath;
}

export function toRequest(event: z.input<typeof LambdaEvent>, publicUrl?: URL): Request {
  const e = LambdaEvent.parse(event);
  const query = e.rawQueryString ? `?${e.rawQueryString}` : '';
  const method = e.requestContext.http.method;
  const hasBody = e.body !== undefined && method !== 'GET' && method !== 'HEAD';

  return new Request(`https://${e.requestContext.domainName}${publicPath(e.rawPath, publicUrl)}${query}`, {
    method,
    headers: e.headers,
    body: hasBody ? Buffer.from(e.body ?? '', e.isBase64Encoded ? 'base64' : 'utf8') : null,
  });
}

/** MCP answers are JSON or a finished event stream, so the whole body is text. */
export async function toResult(response: Response): Promise<LambdaResult> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
    isBase64Encoded: false,
  };
}

/** Each audit entry as one JSON line in the function's log. */
const logAudit = (entry: AuditEvent & { at: string }) =>
  console.log(JSON.stringify({ message: 'askdocs audit', ...entry }));

export function lambdaHandler(args: {
  index: IndexSource;
  /** How often a warm instance asks `index` for a newer version; 0 never does (a bundled file). */
  refreshSeconds: number;
  access: Access;
  resourceServerUrl: URL;
  oauthMetadata: Parameters<typeof createHttpHandler>[0]['oauthMetadata'];
  jwksUri?: string;
  embedder?: Embedder;
  canReadRepo?: RepoReader;
  /** 0 records no audit at all. */
  auditDays?: number;
}): (event: z.input<typeof LambdaEvent>) => Promise<LambdaResult> {
  let current: { handle: (request: Request) => Promise<Response>; version: string } | undefined;
  let checkedAt = 0;

  const load = async () => {
    const next = await args.index(current?.version);

    if (!next) return;
    const db = openStore(':memory:', { auditRetentionDays: args.auditDays, auditSink: logAudit });
    const { libraries, sections } = importIndex(db, parseIndexDump(next.text));

    const handle = createHttpHandler(
      {
        db,
        access: args.access,
        resourceServerUrl: args.resourceServerUrl,
        oauthMetadata: args.oauthMetadata,
        jwksUri: args.jwksUri,
        embedder: args.embedder,
      },
      args.canReadRepo ? { canReadRepo: args.canReadRepo } : {},
    );

    current = { handle, version: next.version };
    console.error(`askdocs: serving index ${next.version} (${libraries} libraries, ${sections} sections)`);
  };

  return async (event) => {
    const due = args.refreshSeconds > 0 && Date.now() - checkedAt >= args.refreshSeconds * 1000;

    if (!current || due) {
      checkedAt = Date.now();

      try {
        await load();
      } catch (error) {
        // A bad upload must not take the docs down: keep answering from the index already loaded.
        if (!current) throw error;
        console.error('askdocs: could not load the new index; still serving the previous one', error);
      }
    }

    // SAFETY: load() either set current or threw, when there was none.
    const { handle } = current!;

    return toResult(await handle(toRequest(event, args.resourceServerUrl)));
  };
}

/** A file bundled with the function: read once. */
export function fileIndex(path: string): IndexSource {
  return async (loaded) =>
    loaded ? undefined : { text: readFileSync(path, 'utf8'), version: `file ${path}` };
}

/** An object in S3, fetched only when its ETag changes. Uses the AWS SDK the Lambda runtime ships. */
export function s3Index(url: string): IndexSource {
  const { hostname: Bucket, pathname } = new URL(url);
  const Key = decodeURIComponent(pathname.slice(1));

  return async (loaded) => {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});

    try {
      const object = await s3.send(new GetObjectCommand({ Bucket, Key, IfNoneMatch: loaded }));

      return { text: (await object.Body?.transformToString()) ?? '', version: object.ETag ?? '' };
    } catch (error) {
      if (z.object({ $metadata: z.object({ httpStatusCode: z.literal(304) }) }).safeParse(error).success)
        return undefined;
      throw error;
    }
  };
}

/** The handler configured from the function's environment; see docs/lambda.md. */
async function fromEnvironment() {
  const env = process.env;

  const need = (name: string) => {
    const value = env[name];

    if (!value) throw new Error(`askdocs on Lambda needs ${name}; see docs/lambda.md`);

    return value;
  };

  const where = need('ASKDOCS_INDEX');
  const root = env.LAMBDA_TASK_ROOT ?? process.cwd();
  // A relative path is in the function's bundle; an absolute one anywhere (a layer's /opt).
  const inBundle = (file: string) => (isAbsolute(file) ? file : join(root, file));

  const index = where.startsWith('s3://') ? s3Index(where) : fileIndex(inBundle(where));

  // Fail closed: without an access policy, every library would be served to anyone with a token.
  const access = env.ASKDOCS_ACCESS
    ? parseAccess(env.ASKDOCS_ACCESS)
    : loadAccess(inBundle(need('ASKDOCS_ACCESS_FILE')));

  if (access.github && !env.GITHUB_TOKEN)
    throw new Error('the access policy has a "github" block, so GITHUB_TOKEN is required');

  const canReadRepo =
    access.github && env.GITHUB_TOKEN
      ? githubRepoReader({ token: env.GITHUB_TOKEN, ttlSeconds: access.github.ttlSeconds })
      : undefined;

  return lambdaHandler({
    index,
    refreshSeconds: where.startsWith('s3://') ? Number(env.ASKDOCS_REFRESH_SECONDS ?? 60) : 0,
    access,
    resourceServerUrl: new URL(need('MCP_PUBLIC_URL')),
    oauthMetadata: await discoverOAuth(need('OAUTH_ISSUER')),
    jwksUri: env.OAUTH_JWKS_URI,
    embedder: env.ASKDOCS_EMBED ? await embedderFrom(env.ASKDOCS_EMBED) : undefined,
    canReadRepo,
    auditDays: env.ASKDOCS_AUDIT_DAYS === undefined ? undefined : Number(env.ASKDOCS_AUDIT_DAYS),
  });
}

let configured: ReturnType<typeof fromEnvironment> | undefined;

export async function handler(event: z.input<typeof LambdaEvent>): Promise<LambdaResult> {
  // Set up once per instance, on its first request; a failed setup is retried by the next one.
  configured ??= fromEnvironment().catch((error) => {
    configured = undefined;
    throw error;
  });

  return (await configured)(event);
}
