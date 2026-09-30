# askdocs

askdocs lets your coding agent search your Markdown docs. Point it at a folder or a git repo. It splits each file by headings, indexes the sections in SQLite (full-text search built into Node's SQLite, called FTS5), and gives the agent tools to search and read them.

Your agent reaches those tools over MCP: a small local program it can call. Keyword search needs no embeddings and no vector database. [Semantic search](#semantic-search-optional) is optional: Ollama, OpenAI, Google, or any OpenAI-compatible embeddings API (local or hosted).

## Start here

You need **Node.js 24 or newer**. Official Node builds include FTS5. Older Node prints one line that says what to install.

### Add it to Claude Code

From the project whose docs you want searched:

```bash
claude mcp add docs -- npx -y askdocs
```

Claude Code starts askdocs in that project. On startup askdocs indexes the project's Markdown in memory (tens of milliseconds for a typical repo), keeps the index current as you edit, and writes nothing to disk.

### Share it with the team (or use Cursor)

Commit a `.mcp.json` so anyone who opens the repo gets the same setup. Cursor and other MCP clients read this file too:

```json
{ "mcpServers": { "docs": { "command": "npx", "args": ["-y", "askdocs"] } } }
```

### Serve specific folders

```bash
npx askdocs serve docs/ adr/
```

### Indexed files

By default askdocs looks for `**/*.{md,mdx}`. In a git repo it reads files git tracks, so `.gitignore`d build output, vendored copies, and scratch notes stay out. It skips `node_modules` and dot-directories.

### Check your setup

```bash
npx askdocs doctor
```

`doctor` reports:

- **The tools:** Node, SQLite, and FTS5.
- **Index preview:** which folders, how many files and sections, and whether they sit in a git checkout.
- **Your index:** the persistent index on disk, if you have one.
- **Your MCP config:** whether the project's `.mcp.json` would start askdocs. It catches mistakes like `npx` without `-y`, which pauses to ask a question the MCP client cannot answer.

### Ask your agent

Once the MCP server is connected, ask a real docs question in plain language, for example "how do we retry a failed payout?" The agent should call `search_docs`, then `read_doc` with the `line` and `revision` of the best hit. You do not call those tools yourself.

### When to keep an index on disk

With zero setup, askdocs re-reads the docs on every start: well under a second for a thousand documents, a few seconds for ten thousand. Past that, run `askdocs add` once and serve the persistent index, which starts at once. Searches take milliseconds either way ([measurements](eval/README.md#scale)).

## Tools

Three tools. The agent searches, then reads the best hit.

| Tool             | Does                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_docs`    | `query`, optional `library`, `language`, `limit`, `offset`. Ranked sections, each with a snippet and a citation: library, path, heading, `line`, the document's `revision`, the git `commit` when the indexed text matches it, and a link. Says when the matches are weak. |
| `read_doc`       | `library`, `path`, and optional `line`, `heading`, `outline`, `language`, `page`, `revision` (refuses a line from a document that has changed since the search). Reads one section and everything under it, a whole document, an outline, or the code in one language.     |
| `list_libraries` | What you can search, with `limit` and `offset`. Use this to pick a `library` before you search.                                                                                                                                                                            |

Every tool returns `structuredContent` against a declared `outputSchema`, plus text.

- **Size budget.** Snippets cap at 300 characters. `read_doc` returns about 4k tokens per page and tells the agent how to fetch the next page. Reading a huge document without choosing a section returns its outline and a pointer.
- **Stable addresses.** Every hit's `line` points at that section, even when headings repeat. `heading` also accepts a path like `Client B > Errors`. An ambiguous bare heading returns the candidates.
- **Errors that point forward.** Unknown library: call `list_libraries` (same message if the library is forbidden). Wrong path: use the path `search_docs` returned. Internal failures: one line to the agent, detail in the operator log.

## For a team: a persistent index

Index folders, git repos, or a published site, then serve from a database on disk:

```bash
npx askdocs add ./docs --name acme/payments
npx askdocs add https://github.com/withastro/docs --include 'src/content/docs/en/**/*.mdx'
npx askdocs add https://docs.acme.com/llms.txt   # a published site, without cloning anything
npx askdocs serve            # stdio, from ~/.askdocs/docs.db
```

Serve over HTTP so each person's agent only sees the libraries that person may read. askdocs applies authorization inside the query, before ranking.

Host it on any Node 24 server with a disk, [on Cloudflare](docs/cloudflare.md) with a Worker and a Durable Object, or [on AWS Lambda](docs/lambda.md) behind API Gateway. CI builds the index and publishes it: `askdocs publish` to Cloudflare, `askdocs export` to a file for Lambda.

### Try it on one machine

`--dev-auth` signs tokens on your machine. Verification, policy, scoping, and audit still run the real code path.

```bash
askdocs serve --http --dev-auth --access access.json
askdocs token alice@acme.com --claim groups=payments     # prints a bearer token
claude mcp add --transport http docs http://localhost:8300/mcp --header "Authorization: Bearer <token>"
```

### Permissions that follow the person

```bash
askdocs serve --http --access access.json    # OAUTH_ISSUER, MCP_PUBLIC_URL from env
```

`access.json` is an [mcp-authz](https://github.com/jagreehal/mcp-authz) policy. Library ids are the permissions:

```json
{
  "policy": {
    "roles": {
      "engineer": ["acme/engineering"],
      "payments": ["acme/engineering", "acme/payments-docs"]
    },
    "rules": [
      { "match": { "domain": "acme.com" }, "role": "engineer" },
      { "match": { "claim": { "groups": "payments" } }, "role": "payments" }
    ]
  },
  "github": { "loginClaim": "github_login", "ttlSeconds": 60 }
}
```

- **mcp-authz** verifies the bearer token (audience-bound to your MCP URL) and runs the policy. A caller no rule matches gets a 403 before any tool runs.
- **The optional `github` block** adds a second check for libraries indexed from a GitHub repo, including a local folder inside a GitHub checkout. The caller's GitHub login, read from a verified token claim, must be able to read that repo right now. The check uses `GITHUB_TOKEN` against GitHub's collaborator-permission API. Answers are cached for `ttlSeconds`, which is also the worst-case lag after you revoke access. GitHub errors fail closed.

  Your authorization server must put the GitHub username into the **access token** as a claim. Most providers put it in the ID token after a GitHub sign-in. Add it to the access token with an Auth0 Action, a WorkOS JWT template, or your provider's equivalent. If a token arrives without the claim, the caller's agent learns that some docs are hidden and why, and the server logs it. A misconfiguration cannot pass for "those docs don't exist".

- **askdocs scopes reads in SQL.** Every read puts the caller's allowed libraries in its `WHERE` clause. Sections outside that set are never ranked, snippeted, or counted toward `limit`. A document outside their scope reads like one that does not exist.
- **Hidden libraries stay invisible.** Each library has its own full-text index. A search only touches indexes of libraries the caller can see. A hidden library never appears in results, snippets, counts, or paging. It does not shift ranking statistics, change the weak-match verdict, or slow the search. "Unknown library" means the same for missing and forbidden. A test compares every tool response against a server where the hidden library was never indexed, byte for byte.
- **Operators see the split.** `askdocs stats` reads the index and can tell `missing` from `restricted`. No tool response tells a caller that an answer exists but is hidden from them.
- **Every call is audited:** principal, agent (the token's `client_id`), tool, query, the libraries allowed, and what was returned.

```bash
askdocs audit
```

- **Audit retention.** Queries are stored as typed. People paste tokens, customer names, and stack traces into questions. The persistent index keeps audit entries for 30 days by default: `--audit-days <n>` or `ASKDOCS_AUDIT_DAYS` changes that, and `0` records nothing. Old entries are deleted on startup and as new ones are written. The zero-config in-memory mode never writes the audit log to disk.

```
2026-09-29T06:05:26Z  bob@acme.com  claude-code  read_doc  "runbooks/reconciliation.md"
    allowed:  ["acme/engineering"]
    returned: []
```

## How it works

```
folder / git repo ──► heading-level sections ──► SQLite FTS5 (bm25, porter) ──► MCP (stdio)
                      title > h2 > h3 breadcrumb     title and breadcrumb
                      fence-aware                    weighted over body
```

- **Heading sections.** Every heading is a searchable unit. Its breadcrumb is indexed too, so `Retries` under `# Payments` matches "payments".
- **Sections have addresses.** A section is identified by its heading's line, or 0 for text before the first heading. Search returns that line and `read_doc` takes it, so reading a hit returns the section that matched.
- **Questions as words.** Queries are split into words, stripped of question words, and quoted, so nothing an agent types is parsed as an FTS operator. Sections matching any term are ranked by `bm25`, with titles and heading paths weighted above body text.
- **Weak matches are labeled.** A search counts as answered when one of the top three sections contains at least 45% of the question, with each word weighted by how rare it is in the docs you can see. "payments" in a payments handbook counts for almost nothing; a rare word missing from the docs counts a lot. Otherwise the agent is told the results are weak matches, and the query shows up as a gap. Keyword search cannot see paraphrases, so some real answers are flagged weak too.
- **Source links.** GitHub and GitLab sources link to the exact commit and line.
- **Re-indexing is atomic.** `add` again with the same id replaces the library in one transaction.
- **Frontmatter counts.** A `description:` or `summary:` in frontmatter is indexed with every section of that doc and ranked above body text.

## Keeping it fresh

Two ways to keep the index current:

- **`askdocs serve --watch`** re-indexes a local-folder library a moment after any file in it changes. Use it for docs you are editing.
- **`askdocs sync [library]`** re-reads every library from its source (folder or git remote) with the glob it was added with. Run it from CI on push, or from cron. It exits non-zero if any library fails.

Freshness is tested:

- **Sync coverage.** Deleted and renamed files, a changed include glob, and a force-pushed git source are all followed.
- **Failures keep the old index.** A sync that fails partway, from an unreadable file or a remote that is gone, leaves the previous index untouched.
- **Readers see one complete index.** Re-indexing builds the new version in a fresh table and swaps it in a single transaction. Every search reads one consistent snapshot. A test races a writer thread re-indexing 150 times against a reader on another connection.
- **Upgrades on open; newer indexes refused.** The index format is versioned. askdocs upgrades indexes from every earlier format when opened, and each upgrade is tested with a fixture from that version's own code. It refuses an index written by a newer askdocs.

## Gaps agents hit

```bash
askdocs stats
```

```
Top queries
   42 asks  17 people  how do I create a refund        [acme/payments]
No results
   12 asks   9 people  missing     replay a failed payout
    4 asks   3 people  restricted  PCI scope for card vault
```

A query counts as a gap when no result covered most of the question, including cases where something came back but failed the coverage check. `missing` means nothing in the whole index covers it: write the doc. `restricted` means the answer exists outside what those people could see: change access, or write a version they can read.

## Semantic search (optional)

Keyword search finds the section when the question uses the docs' words. It will miss a question like "can we run two replicas?" against a section titled "Why one instance". Turn on embeddings and each section is also found by meaning, ranked together with the keyword results.

Optional semantic search improves recall@3 from 79.4% to 89.0% on our documentation benchmark. Details in [eval/README.md](eval/README.md).

Turn it on when people ask in their own words (most questions from agents). Keyword search alone covers docs searched by exact names: error codes, API names, config keys.

```bash
ollama pull embeddinggemma
claude mcp add docs -- npx -y -p askdocs -p ai -p ai-sdk-ollama askdocs --embed ollama:embeddinggemma
```

`--embed` (or `$ASKDOCS_EMBED`) works with `serve`, `add`, and `sync`, and takes one of:

| `--embed`                           | Where the text goes                                                                           | Install next to askdocs        | Key from the environment                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `ollama:<model>`                    | your Ollama server                                                                            | `ai ai-sdk-ollama`             |                                                                 |
| `openai:<model>`                    | OpenAI                                                                                        | `ai @ai-sdk/openai`            | `OPENAI_API_KEY`                                                |
| `google:<model>`                    | Google                                                                                        | `ai @ai-sdk/google`            | `GOOGLE_GENERATIVE_AI_API_KEY`                                  |
| `bedrock:<model>`                   | Amazon Bedrock, in your AWS account (Titan, Cohere, Nova)                                     | `ai @ai-sdk/amazon-bedrock`    | AWS credentials and `AWS_REGION`, or `AWS_BEARER_TOKEN_BEDROCK` |
| `compatible:<model>?url=<endpoint>` | any OpenAI-style embeddings API, local or hosted (LM Studio, vLLM, llama.cpp, Ollama's `/v1`) | `ai @ai-sdk/openai-compatible` | `ASKDOCS_EMBED_API_KEY`, if it needs one                        |

Add `?url=` to point a provider at another server (no credentials or query string in it: keys come from the environment), and `?dimensions=<n>` to shorten vectors where the model supports it. Each configuration keeps its own vectors. Changing provider, endpoint, model, or dimensions embeds from scratch; switching back reuses what was there. askdocs says at startup where every section and question will be sent.

- **Keyword search is the default.** Without `--embed` nothing changes, and askdocs installs no extra packages.
- **It needs setup.** A model to embed with, and its packages next to askdocs (the `npx -p` line above does that for Ollama). The first index is embedded once (seconds for a few hundred sections on a laptop); after that, askdocs embeds what changed.
- **Local or hosted.** With Ollama or another server on your own machine, neither the docs nor the questions leave it. A hosted provider receives every section and every question. Through the library, `aiSdkEmbedder` takes any AI SDK embedding model.
- **Failures fall back to keywords.** A server answers by keyword until the vectors are ready. If embedding fails (provider down, model missing, bad API key) it keeps answering by keyword and says why on stderr.
- **Same permissions.** Vectors live in the index and are filtered to the libraries a caller may see before anything is ranked.
- **Confidence has limits.** A search still counts as answered when one of the top three hits covers most of the question's words. For the configurations measured so far (embeddinggemma and nomic-embed-text through Ollama), a clear match by meaning among those three counts too. Other providers and models, and collections of fewer than ten sections, use word coverage. Some correct paraphrased answers are still flagged as weak. An unanswerable question that sits next to related docs may slip through.

## Tracing and metrics

Off unless you ask. `serve --otel` exports OpenTelemetry traces and metrics over OTLP to `$OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`), with `$OTEL_EXPORTER_OTLP_HEADERS` for auth and `$OTEL_SERVICE_NAME` (default `askdocs`). The SDK is [`autotel`](https://www.npmjs.com/package/autotel), loaded only with `--otel`.

```bash
npm install -g askdocs
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com askdocs serve --http --access access.json --otel
```

| Span or metric                  | What it records                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `askdocs.http`                  | each HTTP request: method, path, status                                                                      |
| `tools/call <tool>`             | each tool call, in the standard MCP attributes, plus library, result count and whether a search was answered |
| `askdocs.github.check`          | each uncached GitHub permission check: repo, allowed, or why it failed                                       |
| `askdocs.sync`                  | each re-index: library, files, sections, or the error                                                        |
| `mcp.server.operation.duration` | histogram of tool call time                                                                                  |
| `askdocs.searches`              | count of searches, by whether one of the top results covered most of the question                            |

Tool calls are traced by [`autotel-mcp-instrumentation`](https://www.npmjs.com/package/autotel-mcp-instrumentation). An agent that sends W3C trace context in the request's `_meta` gets askdocs's spans inside its own trace.

**No questions in traces.** Spans carry library ids, counts, outcomes, and timings. They omit query text, the paths asked for, and who asked. Tool arguments and results stay off the span. A failed call records a fingerprint of the error and omits the text. People paste secrets into questions, and a trace backend would hold a second copy with no retention limit. The audit log already records those, for as long as `--audit-days` allows.

askdocs imports `@opentelemetry/api` and nothing else from OpenTelemetry, so an SDK you register some other way receives the same spans. Flushing it before the process exits is then up to you: `--otel` does that for you.

## CLI

```
askdocs                                        # started by an MCP client: serve this folder
askdocs serve <dir...>                         # serve these folders, in memory, kept fresh
askdocs add <dir|git-url> [--name id] [--include glob] [--embed spec]
askdocs sync [library] [--embed spec]
askdocs remove <library>
askdocs list
askdocs stats
askdocs audit [--limit n]
askdocs serve [--watch] [--otel] [--embed spec] # stdio, one person
askdocs serve --http --access <file> [--port 8300] [--dev-auth] [--otel] [--embed spec]
askdocs token <email> [--claim key=value ...]  # --dev-auth only
askdocs publish <url>                          # upload the index to askdocs on Cloudflare
askdocs export <file>                          # the index as one file, for askdocs on Lambda

--db <file>   default $ASKDOCS_DB or ~/.askdocs/docs.db
```

**Published sites.** A site that publishes [`llms.txt`](https://llmstxt.org) can be a library without cloning its repositories. askdocs indexes that file and the Markdown pages it links to.

- **Same-site links.** Links to other sites are skipped. A redirect that leaves the site is refused before any request goes to it. A docs site cannot point your server at other hosts, including ones on your internal network.
- **Markdown pages.** Pages that come back as HTML are skipped and listed.
- **Bounded.** At most 2,000 pages, 2 MB per page, and a 15 s timeout per request.
- **Refreshed by sync.** `askdocs sync` re-fetches the site. `--include` narrows it, e.g. `--include 'guides/**'`.

`--include` defaults to `**/*.{md,mdx}`. What gets read, and when it refuses:

- **`.gitignore` applies.** Inside a git checkout askdocs reads files git tracks (or would track). With `--watch` or zero-config serving, editing any `.gitignore` between the folder and the repo root, `.git/info/exclude`, or git's index re-applies the rules.
- **Git failures stop the index.** If git fails inside a checkout (a corrupt index, a broken `HEAD`), `add` and `sync` fail and the existing index is kept. askdocs does not fall back to reading every file. The global `core.excludesFile` is not watched.
- **Symlinks stay inside the folder.** A link that resolves outside the source folder, such as `../private/secret.md` or `/etc/...` in a cloned repo, is skipped and reported.
- **`node_modules` and dot-directories are skipped.**
- **Library names don't collide.** `serve a/docs b/docs` gives two libraries, `a/docs` and `b/docs`. `add` refuses to replace a library indexed from a different folder unless you pass `--name`.

## As a library

```ts
import { openStore, loadSource, indexLibrary, search, createServer } from 'askdocs';

const db = openStore('docs.db');
const { library, files } = await loadSource('https://github.com/acme/payments');
indexLibrary(db, library, files);
// Every read says whose scope it runs in: the libraries it may see, or 'all'.
search(db, { text: 'idempotency key' }, [{ id: library.id }]);

// Semantic search, with any AI SDK embedding model (or embedderFrom('ollama:embeddinggemma')):
import { openai } from '@ai-sdk/openai';
import { aiSdkEmbedder, embedLibrary, searchSemantic } from 'askdocs';

const embedder = aiSdkEmbedder('openai:text-embedding-3-small', openai.embedding('text-embedding-3-small'));
await embedLibrary(db, library.id, embedder);
await searchSemantic(db, { text: 'can two processors run at once?' }, 'all', embedder); // hybrid by default
```

## Development

```bash
pnpm quality     # build, oxlint + tsgolint (type-aware, type-checked), tests, prettier
pnpm eval        # retrieval quality against the baseline: see eval/README.md
```

The GitHub check also has a test against the real API, which is skipped by default:

```bash
ASKDOCS_LIVE=1 pnpm test github.live                  # fails closed on a rejected token
GITHUB_TOKEN=… ASKDOCS_LIVE_REPO=owner/name ASKDOCS_LIVE_READER=login pnpm test github.live
```

Indexes built by an older version upgrade in place when opened. The audit trail is kept.

## License

MIT
