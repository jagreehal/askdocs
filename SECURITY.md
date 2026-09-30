# Security

## Reporting a vulnerability

Please report privately through [GitHub security advisories](https://github.com/jagreehal/askdocs/security/advisories/new), not in a public issue. Expect an acknowledgement within a few days. Fixes go into the latest release. There are no long-term support branches before 1.0.

## Where the boundaries are

**stdio (one person, one machine).** The operating-system account is the boundary. The server serves whatever the user who started it can read, so there are no permissions to configure. Serve only folders that user may share with their agent.

**HTTP (`askdocs serve --http`), for a team.** This is where the permission model applies.

- **Authentication.** Every request needs a bearer token, verified by [mcp-authz](https://github.com/jagreehal/mcp-authz): its signature against the issuer's JWKS, its issuer, and its audience. Tokens minted for another resource are refused, even when validly signed. Someone that no policy rule matches is refused before any tool runs.
- **Authorization is per library.** An `access.json` policy maps people and groups to library ids. With a `github` block, a library indexed from a GitHub repo also requires the caller's GitHub login to be able to read that repo, via GitHub's collaborator-permission API.
  - **Caching:** answers are cached for `ttlSeconds` (default 60), which is the longest a removed collaborator keeps access.
  - **Failing closed:** GitHub errors, an expired service token, rate limiting, malformed responses, and timeouts (5 s) all deny.
- **Hidden means absent.** Each library has its own full-text index, and a search only reads the indexes of libraries the caller may see. A library the caller can't read therefore can't show up anywhere:
  - in results, snippets, counts or paging
  - in ranking statistics or the "weak match" verdict
  - in timing, since its size adds no work
  - in errors: "Unknown library" reads the same for missing and forbidden

  A test compares every tool response against a server where that library was never indexed, byte for byte. Another test checks that no SQL statement a search runs ever names a hidden library's table.

- **Operator-only information.** Whether an unanswered question was _missing_ from the docs or _restricted_ is visible only in `askdocs stats`, which reads the index directly. It is never in a tool response.
- **Audit log.** Each call records who asked, through which OAuth client, the query, the libraries allowed, and what was returned. Queries can contain anything people paste, including tokens and customer data. The persistent index keeps them 30 days by default (`--audit-days`, `0` for none).
- **`--dev-auth`** signs tokens locally for trying things out. It refuses to start when `NODE_ENV=production`.

## What is read from disk

- **Only what the folder really contains.** In a git checkout, askdocs reads only files git tracks or would track, so `.gitignore` applies. Symlinks that resolve outside the source folder are skipped and reported.
- **Git failures stop the index.** If git fails inside a checkout, indexing stops rather than falling back to reading every file.
- **Remote sources.** Git sources are shallow-cloned to a temporary directory, which is deleted afterwards.

## Out of scope

- **Permissions finer than a library.** For example, Confluence-style per-page restrictions.
- **Rate limiting and denial-of-service protection.** Put the HTTP server behind your usual proxy.
- **Encryption at rest.** The index is a SQLite file containing your docs and the audit log. Protect it like the docs themselves.
