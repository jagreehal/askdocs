import { createHash } from 'node:crypto';
import type { EmbeddingModel, embedMany } from 'ai';
import { z } from 'zod';
import { optional } from './optional';
import {
  joinCjk,
  listLibraries,
  search,
  searchWithVectors,
  type Scope,
  type SearchLibrary,
  type SearchResult,
  type VectorLeg,
  type Database,
} from './store';

/**
 * Semantic search, as an opt-in layer over the keyword index. Keyword search needs nothing and
 * stays the default; with an embedder, each section also gets a vector, and a search ranks by
 * similarity alongside (or instead of) keywords.
 *
 * Vectors live in the same SQLite file, one row per section (or per piece of a long one), tagged
 * with the library's index generation: a re-index makes the old ones invisible at once, and
 * unchanged sections reuse their vectors instead of being embedded again.
 */
// Similarity is exact cosine over each library's vectors, held in memory.

/** Turns text into vectors. `id` names the model; vectors from different models are never mixed. */
export type Embedder = {
  /**
   * What the vectors are stored under: the provider, model and every setting that changes them
   * (endpoint, dimensions), never a credential. Vectors under different ids are never compared.
   */
  id: string;
  embed: (texts: string[], kind: 'query' | 'document') => Promise<Float32Array[]>;
  /**
   * How far the best match's similarity must stand above the 10th best for a search to count as
   * answered by meaning, when too few of the question's words appear for keywords to vouch for it.
   * Only for configurations it was measured on; without it, keyword coverage alone decides.
   */
  answeredGap?: number;
  /** Where the docs and questions are sent to be embedded, for saying so. */
  destination?: string;
};

/**
 * Task prompts models were trained with, and are measurably worse without. They belong to the
 * model, so they apply whichever provider serves it. Fixed per model here, so covered by the
 * embedder's id and RECIPE.
 */
const PROMPTS = new Map<string, { query: string; document: string }>([
  ['embeddinggemma', { query: 'task: search result | query: ', document: 'title: none | text: ' }],
  ['nomic-embed-text', { query: 'search_query: ', document: 'search_document: ' }],
]);

/**
 * `answeredGap` for the configurations it was measured on, and only those: the smallest gap
 * between the best and 10th-best similarity that improved no-answer detection on both evals
 * (public and private) at once. The same model from another provider, or with its dimensions cut,
 * is a different set of vectors and has not been measured. See eval/README.md.
 */
const EVALUATED = new Map([
  ['ollama:embeddinggemma', 0.16],
  ['ollama:nomic-embed-text', 0.13],
]);

/** `ollama:embeddinggemma:latest` → `embeddinggemma`; `compatible:org/nomic-embed-text?url=…` → `nomic-embed-text`. */
const modelName = (id: string) =>
  id
    .replace(/^[\w-]+:/, '')
    .replace(/\?.*$/, '')
    .replace(/:[\w.-]+$/, '')
    .replace(/^.*\//, '');

type ProviderOptions = NonNullable<Parameters<typeof embedMany>[0]['providerOptions']>;

/** How an AI SDK model is called: per-task settings for providers that tell a query from a document, and where it sends the text. */
export type EmbedderOptions = {
  providerOptions?: (kind: 'query' | 'document') => ProviderOptions;
  destination?: string;
};

/**
 * Any AI SDK embedding model: OpenAI, Google, Mistral, Cohere, Bedrock, Ollama, and the rest.
 * `providerOptions` gives per-task settings to providers that distinguish a query from a document.
 */
export function aiSdkEmbedder(id: string, model: EmbeddingModel, options: EmbedderOptions = {}): Embedder {
  const prompts = PROMPTS.get(modelName(id));
  const gap = EVALUATED.get(id.replace(/:latest$/, ''));

  const embedder: Embedder = {
    id,
    async embed(texts, kind) {
      const ai = await optional<typeof import('ai')>('ai');

      const { embeddings } = await ai.embedMany({
        model,
        values: texts.map((t) => (prompts?.[kind] ?? '') + t),
        providerOptions: options.providerOptions?.(kind),
      });

      return embeddings.map((e) => Float32Array.from(e));
    },
  };

  if (gap !== undefined) embedder.answeredGap = gap;

  if (options.destination) embedder.destination = options.destination;

  return embedder;
}

/** The Workers AI binding, as far as embedding needs it. */
export type WorkersAi = {
  run: (model: string, input: { text: string[] }) => Promise<{ data: number[][] }>;
};

/**
 * A Workers AI embedding model, through the AI binding in a Worker (see cloudflare.ts). Documents
 * and questions are both embedded here, so they always come from the same model.
 *
 * embeddinggemma's task prompts apply to any host of the model. Its answered-by-meaning gap was
 * measured on the Ollama build and is not carried over, so answered falls back to keyword coverage.
 */
export function workersAiEmbedder(ai: WorkersAi, model: string): Embedder {
  const prompts = PROMPTS.get(modelName(model));

  return {
    id: `workers-ai:${model}`,
    async embed(texts, kind) {
      const vectors: Float32Array[] = [];

      // The API takes at most 100 texts per call.
      for (let i = 0; i < texts.length; i += 100) {
        const { data } = await ai.run(model, {
          text: texts.slice(i, i + 100).map((t) => (prompts?.[kind] ?? '') + t),
        });

        for (const v of data) vectors.push(Float32Array.from(v));
      }

      return vectors;
    },
  };
}

const PROVIDERS = ['ollama', 'openai', 'google', 'bedrock', 'compatible'] as const;

const EmbedSpec = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  // Keys come from the environment: a URL is logged and stored as part of the embedder's id.
  url: z
    .url({ protocol: /^https?$/ })
    .refine((u) => {
      const parsed = new URL(u);

      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    }, 'the endpoint URL must not carry credentials or a query string; API keys come from the environment')
    .optional(),
  dimensions: z.coerce.number().int().positive().optional(),
});

/**
 * `provider:model`, with settings as a query string: `openai:text-embedding-3-small?dimensions=512`,
 * `compatible:nomic-embed-text?url=http://localhost:1234/v1`. Ollama's `:latest` tag is the model
 * itself, so it's dropped: `ollama:embeddinggemma` and `ollama:embeddinggemma:latest` share vectors.
 */
export function parseEmbedSpec(spec: string) {
  const colon = spec.indexOf(':');
  const rest = spec.slice(colon + 1);
  const question = rest.indexOf('?');
  const params = new URLSearchParams(question < 0 ? '' : rest.slice(question + 1));
  const unknown = [...params.keys()].filter((k) => k !== 'url' && k !== 'dimensions');

  if (colon < 1 || unknown.length || !new Set<string>(PROVIDERS).has(spec.slice(0, colon))) {
    throw new Error(
      `Unsupported embedder. Use ${PROVIDERS.map((p) => `${p}:<model>`).join(', ')}, with ?url= and ?dimensions= where the provider takes them.`,
    );
  }

  const parsed = EmbedSpec.safeParse({
    provider: spec.slice(0, colon),
    model: question < 0 ? rest : rest.slice(0, question),
    url: params.get('url') ?? undefined,
    dimensions: params.get('dimensions') ?? undefined,
  });

  if (!parsed.success) throw new Error(`Unsupported embedder: ${z.prettifyError(parsed.error)}`);

  const parts = parsed.data;

  if (parts.provider === 'compatible' && !parts.url) {
    throw new Error(
      `compatible:${parts.model} needs the service's endpoint: compatible:<model>?url=https://…/v1`,
    );
  }

  if (parts.provider === 'ollama') parts.model = parts.model.replace(/:latest$/, '');

  if (parts.url) parts.url = parts.url.replace(/\/+$/, '');

  return parts;
}

/** The embedder's id: the spec, canonical. Same vectors, same id; any setting that changes them, another. */
export function embedSpecId(spec: ReturnType<typeof parseEmbedSpec>): string {
  // Readable, not URL-encoded: it's a key and a label, never parsed back.
  const settings = [spec.url && `url=${spec.url}`, spec.dimensions && `dimensions=${spec.dimensions}`].filter(
    Boolean,
  );

  return `${spec.provider}:${spec.model}${settings.length ? `?${settings.join('&')}` : ''}`;
}

/** What every provider's factory takes: where to send requests, and (for tests) how. */
type ProviderClient = { baseURL?: string; fetch?: typeof fetch };

type GoogleEmbeddingOptions = {
  taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';
  outputDimensionality?: number;
};

const onThisMachine = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

/** Where embedding sends the text, in words: a local server, or a service. */
const describe = (what: string, url: string) =>
  `${what} at ${url}${onThisMachine(url) ? ' (this machine)' : ''}`;

/**
 * Bedrock's embedding families each name the same settings differently. Cohere and Nova embed a
 * question and a passage differently, by design; Titan is normalized so cosine is its measure.
 */
function bedrockOptions(model: string, kind: 'query' | 'document', dimensions: number | undefined) {
  if (/\bcohere\./.test(model)) {
    return {
      inputType: kind === 'query' ? 'search_query' : 'search_document',
      ...(dimensions ? { outputDimension: dimensions } : undefined),
    };
  }

  if (/\bnova\b/.test(model)) {
    return {
      embeddingPurpose: kind === 'query' ? 'TEXT_RETRIEVAL' : 'GENERIC_INDEX',
      ...(dimensions ? { embeddingDimension: dimensions } : undefined),
    };
  }

  return { normalize: true, ...(dimensions ? { dimensions } : undefined) };
}

/** An optional package, loaded only for the provider chosen; if it isn't installed, say what to install. */
const need = (spec: string, packages: string) => (cause: unknown) => {
  throw new Error(
    `--embed ${spec} needs ${packages} installed next to askdocs: npm install ${packages} (or npx -y ${packages
      .split(' ')
      .map((p) => `-p ${p}`)
      .join(' ')} -p askdocs askdocs …)`,
    { cause },
  );
};

const requireEnv = (spec: string, name: string, what = 'your API key') => {
  if (!process.env[name]) throw new Error(`--embed ${spec} needs ${name} set to ${what}`);
};

/**
 * An embedder from a spec (see `parseEmbedSpec`), with its provider package loaded on demand.
 * Credentials come from the environment: OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, and
 * ASKDOCS_EMBED_API_KEY for an OpenAI-compatible service. `fetch` is for tests.
 */
export async function embedderFrom(spec: string, deps: { fetch?: typeof fetch } = {}): Promise<Embedder> {
  const parts = parseEmbedSpec(spec);
  const id = embedSpecId(parts);
  const { url, dimensions } = parts;
  const client: ProviderClient = {};

  if (url) client.baseURL = url;

  if (deps.fetch) client.fetch = deps.fetch;

  switch (parts.provider) {
    case 'ollama': {
      await optional<typeof import('ai')>('ai').catch(need(id, 'ai ai-sdk-ollama'));

      const { createOllama } = await optional<typeof import('ai-sdk-ollama')>('ai-sdk-ollama').catch(
        need(id, 'ai ai-sdk-ollama'),
      );

      return aiSdkEmbedder(
        id,
        createOllama(client).embedding(parts.model, dimensions ? { dimensions } : {}),
        {
          destination: describe('your Ollama server', url ?? 'http://127.0.0.1:11434'),
        },
      );
    }

    case 'openai': {
      requireEnv(id, 'OPENAI_API_KEY');
      await optional<typeof import('ai')>('ai').catch(need(id, 'ai @ai-sdk/openai'));

      const { createOpenAI } = await optional<typeof import('@ai-sdk/openai')>('@ai-sdk/openai').catch(
        need(id, 'ai @ai-sdk/openai'),
      );

      const options: EmbedderOptions = {
        destination: describe('OpenAI', url ?? 'https://api.openai.com/v1'),
      };

      if (dimensions) options.providerOptions = () => ({ openai: { dimensions } });

      return aiSdkEmbedder(id, createOpenAI(client).embedding(parts.model), options);
    }

    case 'google': {
      requireEnv(id, 'GOOGLE_GENERATIVE_AI_API_KEY');
      await optional<typeof import('ai')>('ai').catch(need(id, 'ai @ai-sdk/google'));

      const { createGoogleGenerativeAI } = await optional<typeof import('@ai-sdk/google')>(
        '@ai-sdk/google',
      ).catch(need(id, 'ai @ai-sdk/google'));

      return aiSdkEmbedder(id, createGoogleGenerativeAI(client).embedding(parts.model), {
        // Gemini embeds a question and a passage differently, by design.
        providerOptions: (kind) => {
          const google: GoogleEmbeddingOptions = {
            taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          };

          if (dimensions) google.outputDimensionality = dimensions;

          return { google };
        },
        destination: describe('Google', url ?? 'https://generativelanguage.googleapis.com/v1beta'),
      });
    }

    case 'bedrock': {
      // AWS's own credentials (a Lambda role's, or `aws configure export-credentials --format env`), or a Bedrock API key.
      if (!process.env.AWS_BEARER_TOKEN_BEDROCK)
        requireEnv(id, 'AWS_ACCESS_KEY_ID', 'AWS credentials (or set AWS_BEARER_TOKEN_BEDROCK)');
      requireEnv(id, 'AWS_REGION', 'the region your Bedrock models are in');
      await optional<typeof import('ai')>('ai').catch(need(id, 'ai @ai-sdk/amazon-bedrock'));

      const { createAmazonBedrock } = await optional<typeof import('@ai-sdk/amazon-bedrock')>(
        '@ai-sdk/amazon-bedrock',
      ).catch(need(id, 'ai @ai-sdk/amazon-bedrock'));

      const region = process.env.AWS_REGION ?? '';

      return aiSdkEmbedder(id, createAmazonBedrock(client).embedding(parts.model), {
        providerOptions: (kind) => ({ bedrock: bedrockOptions(parts.model, kind, dimensions) }),
        destination: describe(
          'Amazon Bedrock in your AWS account',
          url ?? `https://bedrock-runtime.${region}.amazonaws.com`,
        ),
      });
    }

    case 'compatible': {
      await optional<typeof import('ai')>('ai').catch(need(id, 'ai @ai-sdk/openai-compatible'));

      const { createOpenAICompatible } = await optional<typeof import('@ai-sdk/openai-compatible')>(
        '@ai-sdk/openai-compatible',
      ).catch(need(id, 'ai @ai-sdk/openai-compatible'));

      const endpoint = url ?? '';
      const apiKey = process.env.ASKDOCS_EMBED_API_KEY;

      const provider = createOpenAICompatible({
        name: 'compatible',
        baseURL: endpoint,
        apiKey,
        fetch: deps.fetch,
      });

      const options: EmbedderOptions = { destination: describe('the embedding service', endpoint) };

      if (dimensions) options.providerOptions = () => ({ openaiCompatible: { dimensions } });

      return aiSdkEmbedder(id, provider.embeddingModel(parts.model), options);
    }
  }

  const unsupported: never = parts.provider;
  throw new Error(`Unsupported embedding provider ${String(unsupported)}`);
}

/** Bump when what is embedded changes shape: every vector is then made again. */
const RECIPE = 'askdocs-embed-1';

/** A section longer than this is embedded in pieces; the section scores as its best piece. */
const PIECE_CHARS = 1_500;

/**
 * What gets embedded for a section: where it sits in the docs, then a piece of its text. On its
 * own a section often never names its subject ("Why one instance"); its breadcrumb does.
 */
function piecesOf(section: { breadcrumb: string; summary: string; content: string }): string[] {
  const header = [section.breadcrumb, section.summary].filter(Boolean).join('\n');
  const pieces: string[] = [];
  let piece = '';

  for (const line of section.content.split('\n')) {
    if (piece && piece.length + line.length + 1 > PIECE_CHARS) {
      pieces.push(piece);
      piece = '';
    }

    piece = piece ? `${piece}\n${line}` : line.slice(0, PIECE_CHARS);
  }

  if (piece || !pieces.length) pieces.push(piece);

  return pieces.map((p) => (p ? `${header}\n\n${p}` : header));
}

const hashOf = (model: string, text: string) =>
  createHash('sha256').update(`${RECIPE}\0${model}\0${text}`).digest('hex').slice(0, 32);

const toBlob = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

const fromBlob = (blob: Uint8Array) =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/** Unit length, so a dot product is the cosine similarity. */
function normalised(vector: Float32Array): Float32Array {
  let norm = 0;

  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;

  return vector.map((x) => x / norm);
}

/**
 * Give every section of a library a vector from `embedder`. Sections whose embedded text is
 * unchanged reuse the vector they had, so re-embedding after an edit costs only what changed.
 * If the library is re-indexed while this runs (`superseded`), search keeps its current vectors:
 * what this run made is stored under the index it was made from, which search never reads, so
 * the run for the newer index reuses it rather than embedding it again.
 */
export async function embedLibrary(
  db: Database,
  libraryId: string,
  embedder: Embedder,
): Promise<{ sections: number; embedded: number; reused: number; superseded: boolean }> {
  const lib = listLibraries(db, 'all').find((l) => l.id === libraryId);

  if (!lib) throw new Error(`Unknown library "${libraryId}"`);

  // SAFETY: rowid and line are integers; the FTS columns are stored TEXT.
  const sections = db
    .prepare(`SELECT rowid AS id, path, line, breadcrumb, summary, content FROM fts_${lib.fts}`)
    .all() as {
    id: number;
    path: string;
    line: number;
    breadcrumb: string;
    summary: string;
    content: string;
  }[];

  const pieces = sections.flatMap((s) =>
    piecesOf({
      breadcrumb: joinCjk(s.breadcrumb),
      summary: joinCjk(s.summary),
      content: joinCjk(s.content),
    }).map((text, piece) => ({ ...s, piece, text, hash: hashOf(embedder.id, text) })),
  );

  // SAFETY: hash is TEXT and vector a BLOB, both NOT NULL.
  const known = new Map(
    (
      db
        .prepare('SELECT hash, vector FROM vectors WHERE library = ? AND model = ?')
        .all(lib.id, embedder.id) as {
        hash: string;
        vector: Uint8Array;
      }[]
    ).map((r) => [r.hash, fromBlob(r.vector)]),
  );

  const missing = [...new Set(pieces.filter((p) => !known.has(p.hash)).map((p) => p.text))];
  const made = missing.length ? await embedder.embed(missing, 'document') : [];
  const byText = new Map(missing.map((text, i) => [text, normalised(made[i]!)]));

  const dimensions = new Set([...known.values(), ...byText.values()].map((v) => v.length));

  if (dimensions.size > 1) {
    throw new Error(`${embedder.id} returned vectors of different lengths (${[...dimensions].join(', ')})`);
  }

  let superseded = false;
  db.exec('BEGIN IMMEDIATE');

  try {
    // SAFETY: `fts` is a nullable INTEGER, and get() gives undefined when the library is gone.
    const now = db.prepare('SELECT fts FROM libraries WHERE id = ?').get(lib.id) as
      { fts: number | null } | undefined;

    if (!now) {
      db.exec('ROLLBACK');

      return { sections: sections.length, embedded: 0, reused: 0, superseded: true };
    }

    superseded = now.fts !== lib.fts;

    if (!superseded)
      db.prepare('DELETE FROM vectors WHERE library = ? AND model = ?').run(lib.id, embedder.id);

    const insert = db.prepare(
      'INSERT OR REPLACE INTO vectors (library, fts, section, piece, path, line, model, hash, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    for (const p of pieces) {
      const vector = known.get(p.hash) ?? byText.get(p.text)!;
      insert.run(lib.id, lib.fts, p.id, p.piece, p.path, p.line, embedder.id, p.hash, toBlob(vector));
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  loaded.get(db)?.delete(lib.id);

  return {
    sections: sections.length,
    embedded: missing.length,
    reused: pieces.length - missing.length,
    superseded,
  };
}

type Loaded = { key: string; rows: { id: number; path: string; line: number; vector: Float32Array }[] };

/** Each library's vectors for one model and index generation, read once and kept. */
const loaded = new WeakMap<Database, Map<string, Loaded>>();

function vectorsOf(db: Database, lib: SearchLibrary, model: string): Loaded['rows'] {
  // indexedAt too: a published index may reuse the previous one's FTS table number.
  const key = `${lib.fts}\0${lib.indexedAt}\0${model}`;
  const cache = loaded.get(db) ?? new Map<string, Loaded>();
  loaded.set(db, cache);
  const hit = cache.get(lib.id);

  if (hit?.key === key) return hit.rows;

  // SAFETY: section and line are integers, path is TEXT and vector a BLOB, all NOT NULL.
  const rows = (
    db
      .prepare(
        'SELECT section AS id, path, line, vector FROM vectors WHERE library = ? AND model = ? AND fts = ?',
      )
      .all(lib.id, model, lib.fts) as { id: number; path: string; line: number; vector: Uint8Array }[]
  ).map((r) => ({ ...r, vector: fromBlob(r.vector) }));

  cache.set(lib.id, { key, rows });

  return rows;
}

/** The SQLite vector store as a search leg: each visible library's sections, by similarity to `query`. */
function sqliteVectors(
  db: Database,
  embedder: Embedder,
  query: Float32Array,
  mode: VectorLeg['mode'],
): VectorLeg {
  const model = embedder.id;
  const q = normalised(query);

  return {
    mode,
    answeredGap: embedder.answeredGap,
    rank(libs, { pool, language }) {
      return libs.flatMap((lib) => {
        // SAFETY: rowid is an integer.
        const allowed = language
          ? new Set(
              (
                db
                  .prepare(`SELECT rowid AS id FROM fts_${lib.fts} WHERE ' ' || languages || ' ' LIKE ?`)
                  .all(`% ${language} %`) as { id: number }[]
              ).map((r) => r.id),
            )
          : undefined;

        const best = new Map<number, { id: number; path: string; line: number; score: number }>();

        for (const row of vectorsOf(db, lib, model)) {
          if (allowed && !allowed.has(row.id)) continue;

          let score = 0;

          for (let i = 0; i < q.length; i++) score += q[i]! * row.vector[i]!;

          if (score > (best.get(row.id)?.score ?? -Infinity)) best.set(row.id, { ...row, score });
        }

        return [...best.values()]
          .toSorted((a, b) => b.score - a.score)
          .slice(0, pool)
          .map((row) => ({ ...row, lib }));
      });
    },
  };
}

/**
 * Search with an embedder: `hybrid` fuses keyword and vector rankings, `vector` uses similarity
 * alone, `keyword` is plain `search`. In `hybrid`, a library with no vectors for this model yet
 * still ranks by keyword, so turning embeddings on never makes results disappear.
 */
export async function searchSemantic(
  db: Database,
  query: Parameters<typeof search>[1],
  scope: Scope,
  embedder: Embedder,
  mode: 'keyword' | VectorLeg['mode'] = 'hybrid',
): Promise<SearchResult> {
  if (mode === 'keyword') return search(db, query, scope);
  const [vector] = await embedder.embed([query.text], 'query');

  return searchWithVectors(db, query, scope, sqliteVectors(db, embedder, vector!, mode));
}
