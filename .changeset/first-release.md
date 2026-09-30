---
'askdocs': minor
---

First release. askdocs indexes your Markdown docs and serves them to coding agents over MCP with `search_docs`, `read_doc` and `list_libraries`.

- `npx -y askdocs` serves the current folder from an in-memory index that follows your edits and your `.gitignore`.
- `askdocs add` indexes folders, git repositories and `llms.txt` sites, and `askdocs sync` refreshes them.
- Each result cites its library, path, heading, line and commit, and long documents come back in pages.
- `askdocs serve --http` verifies OAuth tokens and shows each caller the libraries they can read, GitHub repo permissions included.
- `--embed` adds semantic search through Ollama, OpenAI, Google, Amazon Bedrock or any OpenAI-compatible API. Recall@3 rises from 79% to 89% on the included eval.
- `askdocs/cloudflare` and `askdocs/lambda` run the team server on a Cloudflare Durable Object or on AWS Lambda.
- `serve --otel` exports OpenTelemetry traces and metrics.
