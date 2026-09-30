import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { embedderFrom, embedSpecId, parseEmbedSpec } from './vectors';

/** A provider's API played by a function: records each request and answers in that API's shape. */
function fakeApi() {
  const requests: {
    url: string;
    body: z.infer<typeof Json>;
    authorization: string | null;
    googleKey: string | null;
  }[] = [];

  const Json = z.record(z.string(), z.json());

  const fetch = async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = Json.parse(JSON.parse(z.string().parse(init?.body)));
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      body,
      authorization: headers.get('authorization'),
      googleKey: headers.get('x-goog-api-key'),
    });
    const vector = [0.1, 0.2, 0.3];

    if (url.endsWith(':embedContent')) return Response.json({ embedding: { values: vector } });

    if (url.endsWith('/invoke')) {
      // Cohere takes a batch; Titan and Nova one text per request.
      return body.texts
        ? Response.json({
            embeddings: z
              .array(z.string())
              .parse(body.texts)
              .map(() => vector),
          })
        : Response.json({ embedding: vector, inputTextTokenCount: 1 });
    }

    if (url.endsWith('/api/embed')) return Response.json({ model: body.model, embeddings: [vector] });

    if (url.endsWith(':batchEmbedContents')) {
      return Response.json({
        embeddings: z
          .array(z.unknown())
          .parse(body.requests)
          .map(() => ({ values: vector })),
      });
    }

    const inputs = z.array(z.string()).parse(body.input);

    return Response.json({
      object: 'list',
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: vector })),
      model: body.model,
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  };

  return { fetch, requests };
}

const saved = { ...process.env };

const id = (spec: string) => embedSpecId(parseEmbedSpec(spec));

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-openai';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-test-key';
  process.env.ASKDOCS_EMBED_API_KEY = 'compatible-test-key';
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTKEY';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-test-secret';
  process.env.AWS_REGION = 'eu-west-2';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('embedding specs', () => {
  it('names every setting that changes the vectors, and nothing secret', () => {
    expect(id('ollama:embeddinggemma')).toBe('ollama:embeddinggemma');
    // The same Ollama model, so the same vectors.
    expect(id('ollama:embeddinggemma:latest')).toBe('ollama:embeddinggemma');
    expect(id('openai:text-embedding-3-small?dimensions=512')).toBe(
      'openai:text-embedding-3-small?dimensions=512',
    );
    expect(id('compatible:nomic-embed-text?url=http://localhost:1234/v1/')).toBe(
      'compatible:nomic-embed-text?url=http://localhost:1234/v1',
    );

    // Different providers, endpoints or dimensions are different vectors.
    const ids = [
      'ollama:embeddinggemma',
      'ollama:embeddinggemma?url=http://gpu-box:11434',
      'compatible:embeddinggemma?url=http://localhost:1234/v1',
      'openai:text-embedding-3-small',
      'openai:text-embedding-3-small?dimensions=512',
    ].map(id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.join(' ')).not.toMatch(/test-key|sk-test/);
  });

  it('refuses a spec it cannot honour, and says what it takes', () => {
    expect(() => parseEmbedSpec('cohere:embed-english')).toThrow(/ollama:<model>, openai:<model>/);
    expect(() => parseEmbedSpec('openai:text-embedding-3-small?size=512')).toThrow(/Unsupported embedder/);
    expect(() => parseEmbedSpec('openai:text-embedding-3-small?dimensions=-1')).toThrow(
      /Unsupported embedder/,
    );
    expect(() => parseEmbedSpec('compatible:nomic-embed-text')).toThrow(/needs the service's endpoint/);
  });

  it('refuses an endpoint URL carrying a secret, which would be logged and stored', () => {
    for (const url of [
      'https://user:sk-live@embed.example.com/v1',
      'https://embed.example.com/v1?key=sk-live',
    ]) {
      expect(() => parseEmbedSpec(`compatible:m?url=${encodeURIComponent(url)}`)).toThrow(
        /must not carry credentials/,
      );
    }

    // The error is printed, so it never repeats the rejected secret, whatever else is wrong.
    for (const spec of [
      'compatible:m?url=https://user:sk-live@embed.example.com/v1',
      'compatible:m?url=https://embed.example.com/v1?key=sk-live',
      'compatible:m?url=https://user:sk-live@embed.example.com/v1&size=1',
    ]) {
      expect(() => parseEmbedSpec(spec)).toThrow(/Unsupported embedder/);
      expect(() => parseEmbedSpec(spec)).not.toThrow(/sk-live/);
    }
  });
});

describe('embedding providers', () => {
  it('Ollama: dimensions reach the request', async () => {
    const api = fakeApi();
    const embedder = await embedderFrom('ollama:embeddinggemma?dimensions=256', { fetch: api.fetch });
    await embedder.embed(['a passage'], 'document');

    expect(api.requests[0]).toMatchObject({
      url: 'http://127.0.0.1:11434/api/embed',
      body: { model: 'embeddinggemma', dimensions: 256 },
    });
  });

  it('OpenAI: its endpoint, key from the environment, and dimensions', async () => {
    const api = fakeApi();
    const embedder = await embedderFrom('openai:text-embedding-3-small?dimensions=512', { fetch: api.fetch });
    const [vector] = await embedder.embed(['a passage'], 'document');

    expect(vector).toHaveLength(3);
    expect(api.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/embeddings',
      authorization: 'Bearer sk-test-openai',
      body: { model: 'text-embedding-3-small', input: ['a passage'], dimensions: 512 },
    });
    expect(embedder.destination).toBe('OpenAI at https://api.openai.com/v1');
  });

  it('Google: a question and a passage are embedded as different tasks', async () => {
    const api = fakeApi();
    const embedder = await embedderFrom('google:gemini-embedding-001?dimensions=768', { fetch: api.fetch });
    await embedder.embed(['a question'], 'query');
    await embedder.embed(['one passage', 'another'], 'document');

    expect(api.requests[0]).toMatchObject({
      googleKey: 'google-test-key',
      body: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 },
    });
    expect(api.requests[1]?.body.requests).toEqual([
      expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 }),
      expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 }),
    ]);
  });

  it('Bedrock: in your AWS account and region, each family with its own task settings', async () => {
    const api = fakeApi();

    const titan = await embedderFrom('bedrock:amazon.titan-embed-text-v2:0?dimensions=512', {
      fetch: api.fetch,
    });

    await titan.embed(['a passage'], 'document');

    expect(api.requests[0]).toMatchObject({
      url: 'https://bedrock-runtime.eu-west-2.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke',
      body: { inputText: 'a passage', dimensions: 512, normalize: true },
    });
    expect(api.requests[0]?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\//);
    expect(titan.destination).toBe(
      'Amazon Bedrock in your AWS account at https://bedrock-runtime.eu-west-2.amazonaws.com',
    );

    const cohere = await embedderFrom('bedrock:cohere.embed-english-v3', { fetch: api.fetch });
    await cohere.embed(['a question'], 'query');
    await cohere.embed(['one passage', 'another'], 'document');

    expect(api.requests[1]?.body).toMatchObject({ input_type: 'search_query', texts: ['a question'] });
    expect(api.requests[2]?.body).toMatchObject({ input_type: 'search_document' });
  });

  it('OpenAI-compatible: the configured endpoint and key, and the model’s own task prompts', async () => {
    const api = fakeApi();

    const embedder = await embedderFrom('compatible:embeddinggemma?url=http://localhost:1234/v1', {
      fetch: api.fetch,
    });

    await embedder.embed(['what is retried?'], 'query');

    expect(api.requests[0]).toMatchObject({
      url: 'http://localhost:1234/v1/embeddings',
      authorization: 'Bearer compatible-test-key',
      body: { model: 'embeddinggemma', input: ['task: search result | query: what is retried?'] },
    });
    expect(embedder.destination).toBe('the embedding service at http://localhost:1234/v1 (this machine)');
  });

  it('applies a semantic confidence threshold only to the configurations it was measured on', async () => {
    const api = fakeApi();
    const gap = async (spec: string) => (await embedderFrom(spec, { fetch: api.fetch })).answeredGap;

    expect(await gap('ollama:embeddinggemma')).toBe(0.16);
    expect(await gap('ollama:embeddinggemma:latest')).toBe(0.16);
    expect(await gap('ollama:nomic-embed-text')).toBe(0.13);
    // Same model, but not the vectors that were measured.
    expect(await gap('compatible:embeddinggemma?url=http://localhost:1234/v1')).toBeUndefined();
    expect(await gap('openai:text-embedding-3-small')).toBeUndefined();
  });

  it('asks for a missing key up front, by name', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(embedderFrom('openai:text-embedding-3-small')).rejects.toThrow(/needs OPENAI_API_KEY/);
    delete process.env.AWS_ACCESS_KEY_ID;
    await expect(embedderFrom('bedrock:amazon.titan-embed-text-v2:0')).rejects.toThrow(
      /needs AWS_ACCESS_KEY_ID/,
    );
  });
});
