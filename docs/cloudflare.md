# askdocs on Cloudflare

The team server without a server. A Worker takes MCP requests, and one Durable Object keeps the index in its own SQLite (FTS5 included), checks every caller's token and permissions, and keeps the audit log. CI builds the index with `askdocs add` and uploads it with `askdocs publish`, so there is no disk to look after and no `--watch`: the index is as fresh as your last publish.

```
GitHub Action ── askdocs add … ── askdocs publish ──► Worker ──► Durable Object: index, audit log
                                                        ▲
                               agents (MCP over HTTP) ──┘
```

Search runs the same code as the Node server and returns the same results; only the storage differs.

## The Worker

Start from any Worker project (`npm create cloudflare@latest` makes one), then `npm install askdocs`.

`src/index.ts`, all of it:

```ts
export { AskdocsIndex, default } from 'askdocs/cloudflare';
```

`wrangler.toml`:

```toml
name = "askdocs"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[vars]
MCP_PUBLIC_URL = "https://docs.acme.com/mcp"   # tokens must be issued for exactly this URL
OAUTH_ISSUER = "https://acme.us.auth0.com/"

[[durable_objects.bindings]]
name = "ASKDOCS"
class_name = "AskdocsIndex"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AskdocsIndex"]
```

Secrets:

```bash
npx wrangler secret put ADMIN_TOKEN     # any long random string; CI uses it to publish
npx wrangler secret put ACCESS          # the access file's JSON, as in the README
npx wrangler secret put GITHUB_TOKEN    # only if ACCESS has a "github" block
npx wrangler deploy
```

| Setting          | What it is                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL` | where agents reach the server; the token audience                                           |
| `OAUTH_ISSUER`   | your authorization server; its metadata is discovered from here                             |
| `OAUTH_JWKS_URI` | optional: where its signing keys are, if not in its metadata                                |
| `ACCESS`         | who may read which library ([access file](../README.md#permissions-that-follow-the-person)) |
| `ADMIN_TOKEN`    | for `/admin/*`: publishing, and reading the audit log                                       |
| `GITHUB_TOKEN`   | for `ACCESS`'s `github` block: checks that each caller can read each repo                   |
| `AUDIT_DAYS`     | days of audit log to keep (default 30; `0` keeps none)                                      |
| `EMBED_MODEL`    | optional semantic search, with Workers AI (below)                                           |

## Publishing from CI

A scheduled workflow, like a docs site's, keeps the index current. It clones each repo, indexes its docs and uploads the result. Pin askdocs to the version the Worker runs: an index is only published to the same index format.

```yaml
name: Publish docs index
on:
  push: { branches: [main] }
  schedule: [{ cron: '*/30 * * * *' }]
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      # A read-only token for the private repos, from a GitHub App (not a personal token).
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: ${{ vars.DOCS_APP_ID }}
          private-key: ${{ secrets.DOCS_APP_KEY }}
          owner: acme
      - run: git config --global url."https://x-access-token:${{ steps.app.outputs.token }}@github.com/".insteadOf "https://github.com/"
      - run: |
          npx -y $ASKDOCS add https://github.com/acme/payments --include 'docs/**/*.md' --db index.db
          npx -y $ASKDOCS add https://github.com/acme/handbook --include 'docs/**/*.md' --db index.db
          npx -y $ASKDOCS publish https://docs.acme.com --db index.db
        env:
          ASKDOCS: askdocs@0.1.0 # the version in the Worker's package.json
          ASKDOCS_ADMIN_TOKEN: ${{ secrets.ASKDOCS_ADMIN_TOKEN }}
```

- **Tokens stay out of the index.** A clone URL is recorded without its user or token, and the `insteadOf` rule above keeps the token out of the URLs altogether.
- **Publishing is atomic.** Searches see the old index or the new one, never a mix. The audit log is kept.
- **The admin token** comes from `ASKDOCS_ADMIN_TOKEN`, never a flag, so it stays out of shell history and logs.

## Semantic search

```toml
[vars]
EMBED_MODEL = "@cf/google/embeddinggemma-300m"

[ai]
binding = "AI"
```

After each publish, the Durable Object embeds the sections with Workers AI in the background; searches answer by keyword until the vectors are ready. Only changed sections are embedded again, so a publish that changes nothing costs nothing. Documents and questions are embedded by the same model, in the same place. Workers AI receives every section and every question.

One limit: "answered by meaning" (a clear semantic match counting as an answer) was measured on the Ollama build of embeddinggemma, not this one, so here the weak-match signal comes from keyword coverage alone.

## Operating it

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://docs.acme.com/admin/status   # libraries, and how many sections have vectors
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://docs.acme.com/admin/audit    # recent tool calls
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://docs.acme.com/admin/stats    # top queries and gaps
```

## Limits

- **One Durable Object serves every request, one at a time.** A search takes milliseconds, which is plenty for a team; a very busy server would shard by library.
- **The index has to fit a Durable Object:** fine for tens of thousands of sections. The whole index is uploaded on each publish.
- **No `--watch`:** freshness comes from publishing, on push or on a schedule.
