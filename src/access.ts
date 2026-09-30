import { readFileSync } from 'node:fs';
import { definePolicy, type Identity, type Policy, type PolicySpec, type Principal } from 'mcp-authz';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import { traced } from './telemetry';

/**
 * Who may read which library, in two layers that must both agree:
 *
 * 1. An mcp-authz policy. Library ids are the permissions: a role granting
 *    `acme/payments` may read that library, `*` reads everything. A caller no
 *    rule matches is refused before any tool runs.
 * 2. Optionally, GitHub itself. For a library indexed from a GitHub repo, the
 *    caller's GitHub account must be able to read that repo right now. Remove
 *    someone from the team in GitHub and their agent stops seeing its docs.
 */
export type Access = {
  policy: Policy;
  github?: GithubConfig;
};

export type GithubConfig = {
  /** Verified token claim holding the caller's GitHub login, e.g. Auth0's `nickname` for a GitHub connection. */
  loginClaim: string;
  /** How long a GitHub answer is trusted. Also the worst-case lag after access is revoked. */
  ttlSeconds: number;
};

// Mirrors mcp-authz's PolicySpec so the file is typed without a cast; definePolicy then checks the semantics.
const PolicyFile = z
  .object({
    permissions: z.array(z.string()).optional(),
    roles: z.record(z.string(), z.array(z.string())),
    rules: z.array(
      z
        .object({
          match: z
            .object({
              issuer: z.string(),
              sub: z.string(),
              email: z.string(),
              domain: z.string(),
              claim: z.record(z.string(), z.string()),
            })
            .partial()
            .strict()
            .optional(),
          role: z.union([z.string(), z.array(z.string())]).optional(),
          deny: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const AccessFile = z.object({
  policy: PolicyFile,
  github: z
    .object({ loginClaim: z.string().min(1), ttlSeconds: z.number().int().min(0).default(60) })
    .strict()
    .optional(),
});

export function loadAccess(file: string): Access {
  return parseAccess(readFileSync(file, 'utf8'));
}

/** An access file's JSON, for runtimes that have it as text rather than a file (a Worker's secret). */
export function parseAccess(json: string): Access {
  const parsed = AccessFile.strict().parse(JSON.parse(json));

  // Unknown fields and roles that do not exist fail the boot, rather than quietly granting nothing.
  return { policy: definePolicy<PolicySpec>(parsed.policy), github: parsed.github };
}

const GithubPermission = z.object({
  permission: z.enum(['admin', 'maintain', 'write', 'triage', 'read', 'none']),
});

const GithubLogin = z.string().min(1);

/** Answers "can this GitHub login read this repo?" */
export type RepoReader = (login: string, repo: string) => Promise<boolean>;

/**
 * Asks GitHub with a service token (a GitHub App installation token or a PAT that
 * can see the org's repos), and caches each answer for `ttlSeconds`.
 *
 * Fails closed: an error from GitHub hides that repo's docs for this request and
 * says why on stderr, rather than serving docs nobody could vouch for.
 */
// Answers are cached in process: one GitHub call per (login, repo) per TTL.
export function githubRepoReader(
  args: {
    token: string;
    ttlSeconds: number;
    /** Give up on GitHub after this long and deny, rather than stall every request behind it. */
    timeoutMs?: number;
  },
  deps: { fetch: typeof fetch; now: () => number } = { fetch, now: Date.now },
): RepoReader {
  const cache = new Map<string, { ok: boolean; until: number }>();

  return async (login, repo) => {
    const key = `${login}\0${repo}`;
    const hit = cache.get(key);

    if (hit && hit.until > deps.now()) return hit.ok;

    // The login stays off the span: which repos are checked and how GitHub answered is enough to operate on.
    return traced('askdocs.github.check', { 'askdocs.repo': repo }, async (span) => {
      let ok = false;

      try {
        const res = await deps.fetch(
          `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
          {
            signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${args.token}`,
              'x-github-api-version': '2022-11-28',
            },
          },
        );

        if (res.ok) {
          const { permission } = GithubPermission.parse(await res.json());
          ok = permission !== 'none';
        } else if (res.status !== 404) {
          console.error(`askdocs: GitHub said ${res.status} checking ${login} on ${repo}; hiding it`);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `GitHub said ${res.status}` });

          return false;
        }
      } catch (error) {
        console.error(`askdocs: GitHub unreachable checking ${login} on ${repo}; hiding it`, error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'GitHub unreachable' });

        return false;
      }

      cache.set(key, { ok, until: deps.now() + args.ttlSeconds * 1000 });
      span.setAttribute('askdocs.github.allowed', ok);

      return ok;
    });
  };
}

/**
 * The libraries this caller may see, decided before any search runs.
 *
 * `notice` is set when repo-backed docs were withheld because the token carries no
 * GitHub login: almost always an authorization-server misconfiguration, which would
 * otherwise look like "the docs just aren't there".
 */
export async function allowedLibraries(
  args: {
    principal: Principal;
    identity: Identity;
    libraries: { id: string; repo: string | null }[];
    github?: GithubConfig;
  },
  deps: { canReadRepo?: RepoReader },
): Promise<{ libraries: { id: string; repo: string | null }[]; notice?: string }> {
  const { principal, identity, libraries, github } = args;
  // A claim is whatever the authorization server put there: only a non-empty string is a login.
  const login = github ? GithubLogin.safeParse(identity.claims[github.loginClaim]).data : undefined;
  let withheldForLogin = false;

  const checks = libraries.map(async (lib) => {
    if (!principal.can(lib.id)) return false;

    if (!github || !lib.repo) return true;

    if (!login) {
      withheldForLogin = true;

      return false;
    }

    return deps.canReadRepo ? deps.canReadRepo(login, lib.repo) : false;
  });

  const verdicts = await Promise.all(checks);
  // Each id keeps the repo it was checked against, so a library re-indexed from another repo while
  // this ran (or before a tool reads it) is out of scope rather than covered by this check.
  const allowed = libraries.filter((_, i) => verdicts[i]).map((lib) => ({ id: lib.id, repo: lib.repo }));

  if (!withheldForLogin || !github) return { libraries: allowed };
  console.error(
    `askdocs: token for ${principal.email ?? principal.sub} has no "${github.loginClaim}" claim; GitHub-backed libraries withheld`,
  );

  return {
    libraries: allowed,
    notice: `Some documentation is hidden because your sign-in did not include a GitHub username (claim "${github.loginClaim}"). Ask whoever runs this server to add it to the access token.`,
  };
}
