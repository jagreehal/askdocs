import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK, type JWTPayload } from 'jose';
import { createMcpFetch, type Identity } from 'mcp-authz';
import { z } from 'zod';
import { allowedLibraries, type Access, type RepoReader } from './access';
import { createServer, type Caller } from './server';
import { listLibraries, type Database } from './store';
import { traced } from './telemetry';
import type { Embedder } from './vectors';

type OAuthMetadata = Parameters<typeof createMcpFetch>[0]['oauthMetadata'];

/**
 * Remote MCP over Streamable HTTP. mcp-authz verifies the bearer token and runs
 * the policy (refusing anyone it grants nothing); we then work out which
 * libraries this person may read and build a server that can only see those.
 */
export function createHttpHandler(
  args: {
    db: Database;
    access: Access;
    resourceServerUrl: URL;
    oauthMetadata: OAuthMetadata;
    jwksUri?: string;
    /** Semantic search alongside keywords; see vectors.ts. */
    embedder?: Embedder;
  },
  deps: { canReadRepo?: RepoReader } = {},
): (request: Request) => Promise<Response> {
  const { db, access } = args;

  const handle = createMcpFetch<Caller>({
    resourceServerUrl: args.resourceServerUrl,
    oauthMetadata: args.oauthMetadata,
    // Without jwksUri, mcp-authz falls back to the metadata's jwks_uri, exactly as if verifier were absent.
    verifier: { jwksUri: args.jwksUri, requireEmail: access.agents !== true },
    // Every client shipping today (Claude Code included) still opens with the initialize
    // handshake that 2026-07-28 removed, so "legacy" here means "every real client".
    legacy: 'stateless',
    policy: access.policy,
    resolve: async (identity, principal) => {
      const allowed = await allowedLibraries(
        { principal, identity, libraries: listLibraries(db, 'all'), github: access.github },
        deps,
      );

      const caller: Caller = {
        principal: principal.email ?? principal.sub,
        agent: agentOf(identity),
        scope: allowed.libraries,
      };

      if (allowed.notice) caller.notice = allowed.notice;

      return caller;
    },
    createServer: (caller) => createServer(db, caller, { embedder: args.embedder }),
  });

  return (request) =>
    traced(
      'askdocs.http',
      { 'http.request.method': request.method, 'url.path': new URL(request.url).pathname },
      async (span) => {
        const response = await handle(request);
        span.setAttribute('http.response.status_code', response.status);

        return response;
      },
    );
}

/** The OAuth client the token was minted for. Verified, unlike the name a client reports about itself. */
function agentOf(identity: Identity): string | undefined {
  return z
    .string()
    .optional()
    .catch(undefined)
    .parse(identity.claims.client_id ?? identity.claims.azp);
}

/**
 * A stand-in authorization server for trying the permission model on one machine.
 *
 * Not an AS: no login, consent or PKCE. It signs tokens and publishes the key,
 * which is the only part of an AS the resource server depends on — verification,
 * policy, scoping and audit are all the real code path. The key pair is generated
 * on first use and kept next to the index, so a token minted in one terminal
 * verifies in the server running in another.
 */
export type DevAuth = {
  resourceServerUrl: URL;
  jwksUri: string;
  oauthMetadata: OAuthMetadata;
  /** Sign a token for this email, with any extra claims (e.g. `groups`, a GitHub login). */
  mint: (email: string, claims?: JWTPayload) => Promise<string>;
  /** Serves the JWKS in front of the real handler; every other path is untouched. */
  wrap: (handler: (request: Request) => Promise<Response>) => (request: Request) => Promise<Response>;
};

export function devAuth(args: { port: number; keysFile: string }): DevAuth {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('--dev-auth is a development shortcut and refuses to run in production.');
  }

  const base = `http://localhost:${args.port}`;
  const issuer = `${base}/dev-auth`;
  const resourceServerUrl = new URL(`${base}/mcp`);

  const keys = async (): Promise<{ privateJwk: JWK; publicJwk: JWK }> => {
    if (existsSync(args.keysFile)) return JSON.parse(readFileSync(args.keysFile, 'utf8'));
    const pair = await generateKeyPair('RS256', { extractable: true });
    const privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'dev-key', alg: 'RS256' };
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'dev-key', alg: 'RS256' };
    writeFileSync(args.keysFile, JSON.stringify({ privateJwk, publicJwk }), { mode: 0o600 });

    return { privateJwk, publicJwk };
  };

  return {
    resourceServerUrl,
    jwksUri: `${issuer}/jwks`,
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    } satisfies OAuthMetadata,

    async mint(email, claims = {}) {
      const { privateJwk } = await keys();

      return new SignJWT({
        email_verified: true,
        scope: 'mcp',
        client_id: 'dev-cli',
        ...claims,
        email,
        hd: email.split('@')[1],
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev-key' })
        .setSubject(`dev|${email}`)
        .setIssuer(issuer)
        .setAudience(resourceServerUrl.href)
        .setExpirationTime('8h')
        .sign(await importJWK(privateJwk, 'RS256'));
    },

    wrap(handler) {
      return async (request) =>
        new URL(request.url).pathname === '/dev-auth/jwks'
          ? Response.json({ keys: [(await keys()).publicJwk] })
          : handler(request);
    },
  };
}
