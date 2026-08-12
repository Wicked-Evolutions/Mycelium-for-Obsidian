import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanup, createTempVault } from './helpers.mjs';

const storageByPath = new Map();
const embeddingModels = [];
const ollamaSpecifier = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const storageSpecifier = new URL('../dist/embeddings/storage.js', import.meta.url).href;

await mock.module(ollamaSpecifier, {
  namedExports: {
    assertEmbeddingResultIdentity: (result, expected) => {
      if (result.model !== expected.name || result.digest !== expected.digest) {
        throw new Error('Ollama embedding model identity changed during the operation.');
      }
    },
    assertOllamaModelIdentity: async () => {},
    assertValidEmbeddingVector: (value, source = 'Embedding provider') => {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some(item => typeof item !== 'number' || !Number.isFinite(item))
      ) {
        throw new Error(`${source} returned an invalid embedding vector.`);
      }
    },
    checkOllamaAvailability: async () => ({
      available: true,
      hasModel: true,
      model: { name: 'mock-embed:latest', digest: 'sha256:mock' },
    }),
    getEmbeddingModelProfile: async () => ({
      name: 'mock-embed:latest', digest: 'sha256:mock', contextLength: 2048, maxInputBytes: 1920,
    }),
    resolveEmbeddingModelConfig: (config, model) => ({
      ...config, model: model.name, modelDigest: model.digest,
    }),
    generateEmbedding: async (_text, config) => {
      embeddingModels.push(config.model);
      return {
        embedding: _text === 'invalid-empty-vector' ? [] : [1, 0],
        dimensions: _text === 'invalid-empty-vector' ? 0 : 2,
        model: config.model,
        digest: _text === 'retagged-provider-vector'
          ? 'sha256:replacement'
          : config.modelDigest,
      };
    },
    generateCompletion: async () => 'unused mock completion',
    cosineSimilarity: () => 0,
  },
});

await mock.module(storageSpecifier, {
  namedExports: {
    getSharedStorage: (vaultRoot) => {
      const vaultPath = typeof vaultRoot === 'string' ? vaultRoot : vaultRoot.path;
      const storage = storageByPath.get(vaultPath);
      if (storage instanceof Error) throw storage;
      if (!storage) throw new Error('missing fake storage');
      return storage;
    },
  },
});

const { loadConfig } = await import('../dist/config.js');
const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');

const vaultsToClean = [];

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  storageByPath.clear();
  for (const vault of vaultsToClean) cleanup(vault);
});

function makeVault(files) {
  const vault = fs.realpathSync(createTempVault(files));
  vaultsToClean.push(vault);
  return vault;
}

function configFor(vaults) {
  process.env.OBSIDIAN_VAULTS = JSON.stringify(vaults);
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  return loadConfig();
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

function storageFixture(overrides = {}) {
  const fixture = {
    getStats: () => ({ totalEmbeddings: 1, uniqueFiles: 1, lastUpdated: null }),
    search: () => [],
    keywordSearch: () => [],
    getContent: (filePath, blockId) => `content:${filePath}:${blockId ?? ''}`,
    get: () => null,
    getPathStats: () => [],
    ...overrides,
  };
  fixture.searchCompatible ??= (embedding, modelIdentity, limit, minSimilarity) => {
    const stats = fixture.getStats();
    return {
      results: fixture.search(embedding, limit, minSimilarity),
      compatibility: {
        state: 'complete',
        modelIdentity,
        embeddingDimension: embedding.length,
        totalEmbeddingCount: stats.totalEmbeddings,
        compatibleEmbeddingCount: stats.totalEmbeddings,
        excludedEmbeddingCount: 0,
        excludedFileCount: 0,
        reindexRequired: false,
      },
    };
  };
  fixture.keywordSearchCompatible ??= (query, _modelIdentity, _dimension, limit) =>
    fixture.keywordSearch(query, limit);
  return fixture;
}

test('semantic_search keeps sentinel rows out of ranking, scores, and reranker inputs', async () => {
  embeddingModels.length = 0;
  const vault = makeVault({
    'A.md': '# A\n\nalpha',
    'B.md': '# B\n\nbeta',
    'C.md': '# C\n\ngamma',
    'D.md': '# D\n\ndelta',
  });
  const searchLimits = [];
  const keywordLimits = [];
  const semanticRows = [
    { filePath: 'A.md', blockId: 'a1', similarity: 0.95, metadata: {} },
    { filePath: 'B.md', blockId: 'b1', similarity: 0.90, metadata: {} },
    { filePath: 'A.md', blockId: 'a2', similarity: 0.85, metadata: {} },
    { filePath: 'C.md', blockId: 'c1', similarity: 0.80, metadata: {} },
    // Evidence-only provider sentinel: another block from an already represented note.
    { filePath: 'A.md', blockId: 'sentinel', similarity: 0.75, metadata: {} },
  ];
  const keywordRows = [
    { filePath: 'B.md', blockId: 'b1', score: 10 },
    { filePath: 'C.md', blockId: 'c1', score: 8 },
    { filePath: 'A.md', blockId: 'a1', score: 6 },
    { filePath: 'D.md', blockId: 'd1', score: 4 },
    { filePath: 'B.md', blockId: 'sentinel', score: 2 },
  ];
  storageByPath.set(vault, storageFixture({
    getStats: () => ({ totalEmbeddings: semanticRows.length, uniqueFiles: 3, lastUpdated: null }),
    search: (_embedding, limit) => {
      searchLimits.push(limit);
      return semanticRows.slice(0, limit);
    },
    keywordSearch: (_query, limit) => {
      keywordLimits.push(limit);
      return keywordRows.slice(0, limit);
    },
  }));

  const rerankerInputs = [];
  const backend = {
    name: 'capture',
    available: () => true,
    rerank: async (_query, candidates) => {
      rerankerInputs.push(...candidates);
      return candidates.map((candidate, index) => ({
        id: candidate.id,
        reranker_score: candidates.length - index,
      }));
    },
  };
  const handlers = createSemanticHandlers(configFor({ Semantic: vault }));
  const result = payload(await handlers.semantic_search({
    vault: 'Semantic',
    query: 'topic',
    limit: 2,
    minSimilarity: 0,
    rerank: true,
    _rerankerBackend: backend,
  }));

  assert.deepEqual(searchLimits, [5], 'historical cap 4 plus one evidence row');
  assert.deepEqual(keywordLimits, [5], 'BM25 uses the same evidence-only bound');
  assert.equal(result.limit_reached, true);
  assert.deepEqual(result.results.map(row => row.path), ['B.md', 'A.md']);
  assert.deepEqual(result.results.map(row => row.per_signal), [
    { bm25: { rank: 1 }, embeddings: { rank: 2 } },
    { bm25: { rank: 3 }, embeddings: { rank: 1 } },
  ]);
  assert.equal(result.results[0].fusionScore, 1 / 61 + 1 / 62);
  assert.equal(result.results[1].fusionScore, 1 / 61 + 1 / 63);
  assert.deepEqual(rerankerInputs.map(row => row.id), ['B.md:b1', 'A.md:a1']);
  assert.deepEqual(rerankerInputs.map(row => row.text), [
    'content:B.md:b1',
    'content:A.md:a1',
  ]);
  assert.ok(!rerankerInputs.some(row => row.id.includes('sentinel')));
  assert.deepEqual(embeddingModels, ['mock-embed:latest']);
});

test('semantic_search preserves the historical positive fractional result cap', async () => {
  const vault = makeVault({
    'A.md': '# A',
    'B.md': '# B',
    'C.md': '# C',
  });
  const requestedLimits = [];
  const rows = [
    { filePath: 'A.md', blockId: 'a', similarity: 0.9, metadata: {} },
    { filePath: 'B.md', blockId: 'b', similarity: 0.8, metadata: {} },
    { filePath: 'C.md', blockId: 'c', similarity: 0.7, metadata: {} },
  ];
  storageByPath.set(vault, storageFixture({
    getStats: () => ({ totalEmbeddings: 3, uniqueFiles: 3, lastUpdated: null }),
    search: (_embedding, limit) => {
      requestedLimits.push(limit);
      return rows.slice(0, limit);
    },
  }));

  const rerankerInputs = [];
  const backend = {
    name: 'fractional-capture',
    available: () => true,
    rerank: async (_query, candidates) => {
      rerankerInputs.push(...candidates);
      return candidates.map((candidate, index) => ({
        id: candidate.id,
        reranker_score: candidates.length - index,
      }));
    },
  };
  const handlers = createSemanticHandlers(configFor({ FractionalSemantic: vault }));
  const result = payload(await handlers.semantic_search({
    vault: 'FractionalSemantic',
    query: 'topic',
    limit: 1.5,
    minSimilarity: 0,
    rerank: true,
    _rerankerBackend: backend,
  }));

  assert.deepEqual(requestedLimits, [4], 'historical candidate cap 3 plus one evidence row');
  assert.deepEqual(result.results.map(row => row.path), ['A.md', 'B.md']);
  assert.deepEqual(rerankerInputs.map(row => row.id), ['A.md:a', 'B.md:b']);
  assert.equal(result.limit_reached, true);
});

test('semantic_search reports and excludes incompatible model generations', async () => {
  const vault = makeVault({
    'Current.md': '# Current\n\ncurrent content',
    'Stale.md': '# Stale\n\nstale content',
  });
  const compatibility = {
    state: 'partial',
    modelIdentity: 'mock-embed:latest@sha256:mock',
    embeddingDimension: 2,
    totalEmbeddingCount: 2,
    compatibleEmbeddingCount: 1,
    excludedEmbeddingCount: 1,
    excludedFileCount: 1,
    reindexRequired: true,
  };
  storageByPath.set(vault, storageFixture({
    getStats: () => ({ totalEmbeddings: 2, uniqueFiles: 2, lastUpdated: null }),
    searchCompatible: () => ({
      results: [{
        filePath: 'Current.md', blockId: null, similarity: 0.9,
        metadata: { modelIdentity: compatibility.modelIdentity },
      }],
      compatibility,
    }),
    keywordSearchCompatible: () => [],
  }));

  const handlers = createSemanticHandlers(configFor({ Compatible: vault }));
  const result = payload(await handlers.semantic_search({
    vault: 'Compatible', query: 'current', limit: 10, minSimilarity: 0,
  }));

  assert.deepEqual(result.results.map(row => row.path), ['Current.md']);
  assert.deepEqual(result.indexCompatibility, compatibility);
  assert.equal(result.results.some(row => row.path === 'Stale.md'), false);
});

test('semantic_search fails before semantic or BM25 retrieval on an invalid query vector', async () => {
  const vault = makeVault({ 'Indexed.md': '# Indexed' });
  let semanticCalls = 0;
  let keywordCalls = 0;
  storageByPath.set(vault, storageFixture({
    searchCompatible: () => {
      semanticCalls += 1;
      return { results: [], compatibility: {} };
    },
    keywordSearchCompatible: () => {
      keywordCalls += 1;
      return [];
    },
  }));

  const handlers = createSemanticHandlers(configFor({ InvalidVector: vault }));
  const response = await handlers.semantic_search({
    vault: 'InvalidVector', query: 'invalid-empty-vector', minSimilarity: 0,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /invalid embedding vector/i);
  assert.equal(semanticCalls, 0);
  assert.equal(keywordCalls, 0);
});

test('semantic query generation rejects a producer digest mismatch before exact retrieval', async () => {
  const vault = makeVault({ 'Indexed.md': '# Indexed' });
  let retrievalCalls = 0;
  storageByPath.set(vault, storageFixture({
    searchCompatible: () => {
      retrievalCalls += 1;
      return { results: [], compatibility: {} };
    },
    keywordSearchCompatible: () => {
      retrievalCalls += 1;
      return [];
    },
  }));
  const config = configFor({ Retagged: vault });

  const single = await createSemanticHandlers(config).semantic_search({
    vault: 'Retagged', query: 'retagged-provider-vector', minSimilarity: 0,
  });
  const crossVault = await createCrossVaultHandlers(config).semantic_search_all({
    query: 'retagged-provider-vector', minSimilarity: 0,
  });

  assert.equal(single.isError, true);
  assert.match(single.content[0].text, /model identity changed/i);
  assert.equal(crossVault.isError, true);
  assert.match(crossVault.content[0].text, /model identity changed/i);
  assert.equal(retrievalCalls, 0);
});

test('get_similar accounts for every self chunk without changing the historical returned pool', async () => {
  const vault = makeVault({
    'Self.md': '# Self',
    'OtherA.md': '# Other A',
    'OtherB.md': '# Other B',
    'OtherC.md': '# Other C',
  });
  const requestedLimits = [];
  const rows = [
    { filePath: 'Self.md', blockId: 's1', similarity: 1, metadata: {} },
    { filePath: 'OtherA.md', blockId: 'a', similarity: 0.9, metadata: {} },
    { filePath: 'Self.md', blockId: 's2', similarity: 0.8, metadata: {} },
    { filePath: 'Self.md', blockId: 's3', similarity: 0.7, metadata: {} },
    { filePath: 'OtherB.md', blockId: 'b', similarity: 0.6, metadata: {} },
    { filePath: 'OtherC.md', blockId: 'c', similarity: 0.5, metadata: {} },
  ];
  storageByPath.set(vault, storageFixture({
    get: () => ({
      filePath: 'Self.md', blockId: 's1', embedding: [1, 0],
      metadata: { modelIdentity: 'mock-embed:latest@sha256:mock' },
    }),
    getPathStats: () => [
      { filePath: 'Self.md', embeddingChunks: 3 },
      { filePath: 'OtherA.md', embeddingChunks: 1 },
      { filePath: 'OtherB.md', embeddingChunks: 1 },
      { filePath: 'OtherC.md', embeddingChunks: 1 },
    ],
    search: (_embedding, limit) => {
      requestedLimits.push(limit);
      return rows.slice(0, limit);
    },
  }));

  const handlers = createSemanticHandlers(configFor({ Similar: vault }));
  const result = payload(await handlers.get_similar({
    vault: 'Similar', path: 'Self.md', limit: 2,
  }));

  assert.deepEqual(requestedLimits, [6], 'limit + all self chunks + one evidence row');
  assert.deepEqual(result.similarFiles.map(row => row.path), ['OtherA.md']);
  assert.equal(result.limit_reached, true);
});

test('semantic_search_all isolates searched, unindexed, and failed vaults in configured order', async () => {
  const searched = makeVault({
    'HitA.md': '# Hit A\n\nalpha',
    'HitB.md': '# Hit B\n\nbeta',
  });
  const unindexed = makeVault({ 'Empty.md': '# Empty' });
  const constructionFailed = makeVault({ 'ConstructionFailed.md': '# Failed' });
  const statsFailed = makeVault({ 'StatsFailed.md': '# Failed' });
  const searchFailed = makeVault({ 'SearchFailed.md': '# Failed' });
  const rows = [
    { filePath: 'HitA.md', blockId: 'a', similarity: 0.95, metadata: {} },
    { filePath: 'HitB.md', blockId: 'b', similarity: 0.90, metadata: {} },
    { filePath: 'HitA.md', blockId: 'sentinel', similarity: 0.85, metadata: {} },
  ];
  const searchLimits = [];
  storageByPath.set(searched, storageFixture({
    getStats: () => ({ totalEmbeddings: 3, uniqueFiles: 2, lastUpdated: null }),
    search: (_embedding, limit) => {
      searchLimits.push(limit);
      return rows.slice(0, limit);
    },
  }));
  storageByPath.set(unindexed, storageFixture({
    getStats: () => ({ totalEmbeddings: 0, uniqueFiles: 0, lastUpdated: null }),
  }));
  storageByPath.set(constructionFailed, new Error('private storage failure'));
  storageByPath.set(statsFailed, storageFixture({
    getStats: () => { throw new Error('private stats failure'); },
  }));
  storageByPath.set(searchFailed, storageFixture({
    getStats: () => ({ totalEmbeddings: 1, uniqueFiles: 1, lastUpdated: null }),
    search: () => { throw new Error('private search failure'); },
  }));

  const handlers = createCrossVaultHandlers(configFor({
    Searched: searched,
    Unindexed: unindexed,
    ConstructionFailed: constructionFailed,
    StatsFailed: statsFailed,
    SearchFailed: searchFailed,
  }));
  const result = payload(await handlers.semantic_search_all({
    query: 'topic', limit: 1, minSimilarity: 0,
  }));

  assert.deepEqual(searchLimits, [3], 'historical per-vault cap 2 plus one evidence row');
  assert.equal(result.resultCount, 1);
  assert.deepEqual(result.results.map(row => row.path), ['HitA.md']);
  assert.equal(result.vaultsSearched, 5);
  assert.equal(result.vaultsIndexed, 2);
  assert.equal(result.limit_reached, true);
  assert.deepEqual(result.completeness, {
    state: 'partial',
    scanned: 1,
    skipped: 4,
    reasons: ['vault_unindexed', 'vault_search_failed'],
  });
  assert.deepEqual(
    result.resultMetadataByVault.map(row => ({
      vault: row.vault,
      state: row.state,
      limit_reached: row.limit_reached,
      reason: row.completeness?.reasons?.[0],
    })),
    [
      { vault: 'Searched', state: 'searched', limit_reached: true, reason: undefined },
      { vault: 'Unindexed', state: 'unindexed', limit_reached: undefined, reason: 'vault_unindexed' },
      { vault: 'ConstructionFailed', state: 'failed', limit_reached: undefined, reason: 'vault_search_failed' },
      { vault: 'StatsFailed', state: 'failed', limit_reached: undefined, reason: 'vault_search_failed' },
      { vault: 'SearchFailed', state: 'failed', limit_reached: undefined, reason: 'vault_search_failed' },
    ],
  );
});

test('semantic_search_all isolates an all-incompatible vault and aggregates reindex truth', async () => {
  const current = makeVault({ 'Current.md': '# Current' });
  const stale = makeVault({ 'Stale.md': '# Stale' });
  const currentCompatibility = {
    state: 'complete',
    modelIdentity: 'mock-embed:latest@sha256:mock',
    embeddingDimension: 2,
    totalEmbeddingCount: 1,
    compatibleEmbeddingCount: 1,
    excludedEmbeddingCount: 0,
    excludedFileCount: 0,
    reindexRequired: false,
  };
  const staleCompatibility = {
    ...currentCompatibility,
    state: 'partial',
    compatibleEmbeddingCount: 0,
    excludedEmbeddingCount: 1,
    excludedFileCount: 1,
    reindexRequired: true,
  };
  storageByPath.set(current, storageFixture({
    searchCompatible: () => ({
      results: [{ filePath: 'Current.md', blockId: null, similarity: 0.9, metadata: {} }],
      compatibility: currentCompatibility,
    }),
  }));
  storageByPath.set(stale, storageFixture({
    searchCompatible: () => ({ results: [], compatibility: staleCompatibility }),
  }));

  const handlers = createCrossVaultHandlers(configFor({ Current: current, Stale: stale }));
  const result = payload(await handlers.semantic_search_all({
    query: 'topic', limit: 10, minSimilarity: 0,
  }));

  assert.deepEqual(result.results.map(row => row.path), ['Current.md']);
  assert.deepEqual(result.resultMetadataByVault.map(row => [row.vault, row.state]), [
    ['Current', 'searched'],
    ['Stale', 'incompatible'],
  ]);
  assert.deepEqual(result.completeness, {
    state: 'partial',
    scanned: 1,
    skipped: 1,
    reasons: ['embedding_index_incompatible'],
  });
  assert.deepEqual(result.indexCompatibility, {
    state: 'partial',
    modelIdentity: 'mock-embed:latest@sha256:mock',
    embeddingDimension: 2,
    totalEmbeddingCount: 2,
    compatibleEmbeddingCount: 1,
    excludedEmbeddingCount: 1,
    excludedFileCount: 1,
    reindexRequired: true,
  });
});
