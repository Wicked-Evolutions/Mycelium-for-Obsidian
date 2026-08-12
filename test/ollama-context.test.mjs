import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkOllamaAvailability,
  generateEmbedding,
  getEmbeddingModelProfile,
  resolveEmbeddingModelConfig,
} from '../dist/embeddings/ollama.js';

const config = { host: 'http://ollama.test', model: 'nomic-embed-text' };
const match = { name: 'nomic-embed-text:latest', digest: 'sha256:model' };

test('model profile uses the architecture-specific context length conservatively', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [match] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model_info: {
        'general.architecture': 'nomic-bert',
        'nomic-bert.context_length': 2048,
        'unrelated.context_length': 999999,
      },
    }), { status: 200 });
  };

  const result = await getEmbeddingModelProfile(config, match, fetchImpl);
  assert.deepEqual(requests, [{
    url: 'http://ollama.test/api/show',
    body: { model: 'nomic-embed-text:latest' },
  }, {
    url: 'http://ollama.test/api/tags',
    body: undefined,
  }]);
  assert.equal(result.name, match.name);
  assert.equal(result.digest, match.digest);
  assert.equal(result.contextLength, 2048);
  assert.ok(result.maxInputBytes > 0 && result.maxInputBytes < result.contextLength);
});

test('model profile rejects a tag changed during profile lookup', async () => {
  let requests = 0;
  await assert.rejects(
    getEmbeddingModelProfile(config, match, async (url) => {
      requests += 1;
      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({
          model_info: {
            'general.architecture': 'nomic-bert',
            'nomic-bert.context_length': 2048,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        models: [{ name: match.name, digest: 'sha256:replacement' }],
      }), { status: 200 });
    }),
    /model identity changed/i,
  );
  assert.equal(requests, 2);
});

test('model profile fails closed when context metadata is absent or invalid', async () => {
  for (const model_info of [
    {},
    { 'general.architecture': 'nomic-bert' },
    { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': '2048' },
    { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 64 },
  ]) {
    await assert.rejects(
      getEmbeddingModelProfile(config, match, async () => new Response(
        JSON.stringify({ model_info }), { status: 200 },
      )),
      /context length/i,
    );
  }
});

test('untagged model selection binds deterministically to latest and its digest', async () => {
  const fetchTags = async () => new Response(JSON.stringify({
    models: [
      { name: 'demo:v1', digest: 'sha256:v1' },
      { name: 'demo:latest', digest: 'sha256:latest' },
    ],
  }), { status: 200 });

  const untagged = await checkOllamaAvailability(
    { host: 'http://ollama.test', model: 'demo' },
    fetchTags,
  );
  assert.deepEqual(untagged.model, {
    name: 'demo:latest',
    digest: 'sha256:latest',
  });

  const tagged = await checkOllamaAvailability(
    { host: 'http://ollama.test', model: 'demo:v1' },
    fetchTags,
  );
  assert.deepEqual(tagged.model, { name: 'demo:v1', digest: 'sha256:v1' });

  const noLatest = await checkOllamaAvailability(
    { host: 'http://ollama.test', model: 'other' },
    async () => new Response(JSON.stringify({
      models: [{ name: 'other:v1', digest: 'sha256:other-v1' }],
    }), { status: 200 }),
  );
  assert.equal(noLatest.hasModel, false, 'an arbitrary prefix tag is never selected');
});

test('embedding requests use the exact resolved model name', async () => {
  const requests = [];
  const resolved = resolveEmbeddingModelConfig(
    { host: 'http://ollama.test', model: 'demo' },
    { name: 'demo:latest', digest: 'sha256:latest' },
  );
  const result = await generateEmbedding('bounded prompt', resolved, async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      models: [{ name: 'demo:latest', digest: 'sha256:latest' }],
    }), { status: 200 });
  });

  assert.deepEqual(requests, [
    {
      url: 'http://ollama.test/api/embeddings',
      body: { model: 'demo:latest', prompt: 'bounded prompt' },
    },
    { url: 'http://ollama.test/api/ps', body: undefined },
    { url: 'http://ollama.test/api/tags', body: undefined },
  ]);
  assert.equal(result.model, 'demo:latest');
  assert.equal(result.digest, 'sha256:latest');
});

test('embedding requests reject a retagged producer or post-call tag', async () => {
  const resolved = resolveEmbeddingModelConfig(
    { host: 'http://ollama.test', model: 'demo' },
    { name: 'demo:latest', digest: 'sha256:expected' },
  );

  for (const changedAt of ['producer', 'tag']) {
    await assert.rejects(
      generateEmbedding('retag race', resolved, async (url) => {
        if (url.endsWith('/api/embeddings')) {
          return new Response(JSON.stringify({ embedding: [1, 2] }), { status: 200 });
        }
        const digest = (
          changedAt === 'producer' && url.endsWith('/api/ps') ||
          changedAt === 'tag' && url.endsWith('/api/tags')
        ) ? 'sha256:replacement' : 'sha256:expected';
        return new Response(JSON.stringify({
          models: [{ name: 'demo:latest', digest }],
        }), { status: 200 });
      }),
      /model identity changed/i,
    );
  }
});

test('embedding requests reject empty, nonnumeric, and nonfinite provider vectors', async () => {
  for (const embedding of [
    [],
    [1, '2'],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    null,
  ]) {
    await assert.rejects(
      generateEmbedding('invalid vector', config, async () => new Response(
        JSON.stringify({ embedding }), { status: 200 },
      )),
      /invalid embedding vector/i,
    );
  }
});
