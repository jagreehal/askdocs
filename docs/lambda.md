# askdocs on AWS Lambda

The team server as a Lambda behind API Gateway. MCP here is stateless, so any instance answers any request and Lambda scales it like any other function. CI builds the index with `askdocs add`, writes it to one file with `askdocs export`, and either bundles that file with the function or uploads it to S3. The index is held in memory: nothing is written to disk. Audit entries go to the function's log in CloudWatch.

```
GitHub Action ── askdocs add … ── askdocs export index.json ──► S3 (or the function bundle)
                                                                  │
agents, Claude Tag, a Slack bot ──► API Gateway ──► Lambda: askdocs/lambda (index in memory)
```

Search runs the same code as the Node server and returns the same results.

## The function

`src/mcp.ts`, all of it:

```ts
export { handler } from 'askdocs/lambda';
```

A stack with [aws-cdk-mcp](https://github.com/jagreehal/aws-cdk-mcp), which puts one HTTP API with throttling, access logs and a 5xx alarm in front of it:

```ts
import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StatelessMcpServer } from 'aws-cdk-mcp';

const index = new Bucket(this, 'DocsIndex', { enforceSSL: true, versioned: true });

const handler = new NodejsFunction(this, 'Askdocs', {
  entry: 'src/mcp.ts',
  runtime: Runtime.NODEJS_24_X, // node:sqlite with FTS5
  memorySize: 1024,
  timeout: Duration.seconds(30),
  environment: {
    ASKDOCS_INDEX: `s3://${index.bucketName}/index.json`,
    ASKDOCS_ACCESS_FILE: 'access.json',
    OAUTH_ISSUER: 'https://acme.us.auth0.com/',
    MCP_PUBLIC_URL: 'https://docs.acme.com/mcp', // tokens must be issued for exactly this URL
  },
  bundling: {
    commandHooks: {
      beforeBundling: () => [],
      beforeInstall: () => [],
      afterBundling: (input, output) => [`cp ${input}/access.json ${output}/`],
    },
  },
});

index.grantRead(handler);

new StatelessMcpServer(this, 'Mcp', {
  handler,
  auth: {
    type: 'jwt',
    issuer: 'https://acme.us.auth0.com/',
    audience: ['https://docs.acme.com/mcp'],
    requiredScopes: ['mcp'],
  },
});
```

- **Auth is checked twice.** API Gateway checks the issuer, audience and scope before the function runs. askdocs then verifies the token again and applies the [access policy](../README.md#permissions-that-follow-the-person), so each caller sees only the libraries they may read. `auth: { type: 'none' }` leaves all of it to askdocs.
- **A custom domain.** Set `MCP_PUBLIC_URL` to the URL clients use, and aws-cdk-mcp's `publicUrl` to the same. Mapped at the root (`docs.acme.com` → this API), that's `https://docs.acme.com/mcp`. Under a path, see below.

### Under a path: `docs.acme.com/docs`

Clients look for OAuth metadata at the domain's root (`https://docs.acme.com/.well-known/oauth-protected-resource/docs/mcp`), which a `/docs` mapping never receives. aws-cdk-mcp 0.3.0 or later serves it from a second API mapped at the root, naming the full URL as the resource:

```ts
import { ApiMapping, DomainName, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';

const domain = new DomainName(this, 'DocsDomain', { domainName: 'docs.acme.com', certificate });
const metadataApi = new HttpApi(this, 'DocsDiscovery');

const server = new StatelessMcpServer(this, 'Mcp', {
  handler, // MCP_PUBLIC_URL: 'https://docs.acme.com/docs/mcp'
  auth: {
    type: 'jwt',
    issuer: 'https://acme.us.auth0.com/',
    audience: ['https://docs.acme.com/docs/mcp'],
    requiredScopes: ['mcp'],
  },
  publicUrl: 'https://docs.acme.com/docs/mcp',
  metadataApi,
});

new ApiMapping(this, 'DiscoveryMapping', { api: metadataApi, domainName: domain });
new ApiMapping(this, 'DocsMapping', {
  api: server.api,
  stage: server.stage,
  domainName: domain,
  apiMappingKey: 'docs',
});
```

API Gateway strips `/docs` before the function sees the request; askdocs puts it back from `MCP_PUBLIC_URL`, and tokens are issued for the full URL. The root discovery route describes one resource, so each askdocs server under a path needs its own domain.

| Setting                   | What it is                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `ASKDOCS_INDEX`           | `s3://bucket/key`, or a file: relative to the function's root, or absolute (a layer's `/opt/…`) |
| `ASKDOCS_REFRESH_SECONDS` | with S3: how often a warm instance checks for a new index (default 60)                          |
| `ASKDOCS_ACCESS_FILE`     | the access file: relative to the function's root, or absolute                                   |
| `ASKDOCS_ACCESS`          | or the access file's JSON itself (Lambda's environment is capped at 4 KB)                       |
| `MCP_PUBLIC_URL`          | where agents reach the server; the token audience                                               |
| `OAUTH_ISSUER`            | your authorization server; its metadata is discovered from here                                 |
| `OAUTH_JWKS_URI`          | optional: where its signing keys are, if not in its metadata                                    |
| `GITHUB_TOKEN`            | for the access file's `github` block (from Secrets Manager in production)                       |
| `ASKDOCS_AUDIT_DAYS`      | `0` records no audit; otherwise retention is the log group's                                    |
| `ASKDOCS_EMBED`           | optional semantic search for questions, the same spec the index was embedded with (below)       |

## Publishing from CI

The same workflow as [for Cloudflare](cloudflare.md#publishing-from-ci), ending in S3 instead:

```yaml
- run: |
    npx -y $ASKDOCS add https://github.com/acme/payments --include 'docs/**/*.md' --db index.db
    npx -y $ASKDOCS export index.json --db index.db
    aws s3 cp index.json s3://$BUCKET/index.json
  env:
    ASKDOCS: askdocs@0.1.0 # the version the function runs
```

- **Fresh without a redeploy.** Each instance asks S3 for the index at most every `ASKDOCS_REFRESH_SECONDS`, with the ETag it has: an unchanged index costs one small request. A new one is loaded in place, and the request that noticed it waits for the download.
- **A bad upload doesn't take the docs down.** If the new index doesn't load, instances keep serving the one they have and log why. A cold instance has no previous index and fails until a good one is uploaded.
- **Pin the version.** An index is only read by the askdocs version that wrote it.
- **Or bundle the file** (`ASKDOCS_INDEX: 'index.json'`, copied in by `afterBundling`) and redeploy to publish. No bucket, and every instance runs the same index.

## Audit log

Each tool call is one JSON line in the function's log, next to aws-cdk-mcp's access logs:

```json
{
  "message": "askdocs audit",
  "at": "2026-09-30T07:52:50.947Z",
  "principal": "alice@acme.com",
  "agent": "claude-code",
  "tool": "search_docs",
  "query": "…",
  "allowed": ["payments"],
  "returned": ["payments/runbook.md#Reconciliation"],
  "answered": true,
  "ms": 31
}
```

Queries hold whatever people paste, so set the log group's retention to what you need. `askdocs stats` and `askdocs audit` read an index's own log, which on Lambda stays empty: use CloudWatch Logs Insights instead, for example `filter message = "askdocs audit" | stats count() by query`.

## Semantic search

Embed the index in CI (`askdocs add … --embed <spec>`) and set the same spec as `ASKDOCS_EMBED`, so each question is embedded by the same model. With `bedrock:`, neither the docs nor the questions leave your AWS account:

```ts
environment: { ASKDOCS_EMBED: 'bedrock:amazon.titan-embed-text-v2:0', /* … */ },
bundling: { nodeModules: ['ai', '@ai-sdk/amazon-bedrock'] },
```

```ts
handler.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
  }),
);
```

The provider packages are loaded only when used, so bundlers leave them out: `nodeModules` installs them next to the function. Lambda's role credentials and `AWS_REGION` are already in its environment. If embedding fails, askdocs answers by keyword and logs why.

## From Slack

- **Claude Tag** holds one credential for the whole workspace. Create a machine-to-machine client in your authorization server whose tokens are issued for `MCP_PUBLIC_URL`, and connect it in Claude Tag as an OAuth 2.0 client-credentials credential. In the access file, set `"agents": true` and grant the client's `sub` the libraries everyone in those channels may read. Claude Tag calls from `160.79.104.0/21`, if you allowlist.
- **Your own Slack bot** works the same way: a client-credentials token, and the AI SDK's MCP client pointed at `MCP_PUBLIC_URL`. The bot then gets `search_docs` and `read_doc` as tools.

## Limits

- **The index has to fit in memory.** Fine for tens of thousands of sections at 1 GB; each cold start (and each new index) parses the whole file.
- **No `--watch`.** Freshness comes from publishing, on push or on a schedule.
