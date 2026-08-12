import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { cleanup, createTempVault } from './helpers.mjs';

let ollamaState = { available: false, hasModel: false };
const ollamaSpecifier = new URL('../dist/embeddings/ollama.js', import.meta.url).href;

await mock.module(ollamaSpecifier, {
  namedExports: {
    assertEmbeddingResultIdentity: (result, expected) => {
      if (result.model !== expected.name || result.digest !== expected.digest) {
        throw new Error('Ollama embedding model identity changed during the operation.');
      }
    },
    assertOllamaModelIdentity: async () => {},
    isValidEmbeddingVector: (value) => Array.isArray(value) &&
      value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item)),
    assertValidEmbeddingVector: (value, source = 'Embedding provider') => {
      if (!Array.isArray(value) || value.length === 0 || value.some(item => !Number.isFinite(item))) {
        throw new Error(`${source} returned an invalid embedding vector.`);
      }
    },
    checkOllamaAvailability: async () => ollamaState,
    getEmbeddingModelProfile: async () => ({
      name: 'mock-embed:latest', digest: 'sha256:mock', contextLength: 2048, maxInputBytes: 1920,
    }),
    resolveEmbeddingModelConfig: (config, model) => ({
      ...config, model: model.name, modelDigest: model.digest,
    }),
    generateEmbedding: async (_text, config) => ({
      embedding: [1, 0], dimensions: 2, model: config.model, digest: config.modelDigest,
    }),
    generateCompletion: async () => 'mock completion',
    cosineSimilarity: () => 0,
  },
});

const { loadConfig } = await import('../dist/config.js');
const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const { getSharedStorage } = await import('../dist/embeddings/storage.js');

let vaultDir;
let config;
let handlers;
let crossVaultHandlers;

before(() => {
  vaultDir = createTempVault({ 'Note.md': '# Note\n\nContent.' });
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ RecoveryVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  config = loadConfig();
  handlers = createSemanticHandlers(config);
  crossVaultHandlers = createCrossVaultHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

function payload(response) {
  const parsed = JSON.parse(response.content[0].text);
  assert.deepEqual(parsed, response.structuredContent);
  return parsed;
}

test('unsupported semantic storage returns one structured outcome without blocking filesystem search', async () => {
  const unsupportedSemantic = createSemanticHandlers(config, {
    secureMutationSupported: () => false,
  });
  const unsupportedCrossVault = createCrossVaultHandlers(config, {
    secureMutationSupported: () => false,
  });
  const calls = [
    unsupportedSemantic.semantic_search({ vault: 'RecoveryVault', query: 'topic' }),
    unsupportedSemantic.index_vault({ vault: 'RecoveryVault' }),
    unsupportedSemantic.index_file({ vault: 'RecoveryVault', path: 'Note.md' }),
    unsupportedSemantic.get_similar({ vault: 'RecoveryVault', path: 'Note.md' }),
    unsupportedSemantic.index_status({ vault: 'RecoveryVault' }),
    unsupportedCrossVault.semantic_search_all({ query: 'topic' }),
    unsupportedCrossVault.get_ecosystem_stats(),
  ];

  for (const response of await Promise.all(calls)) {
    const result = payload(response);
    assert.equal(response.isError, true);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'semantic_storage_unavailable');
    assert.equal(result.retryable, false);
    assert.deepEqual(result.sideEffects, { state: 'none' });
  }

  const filesystemSearch = await unsupportedCrossVault.search_all_vaults({ query: 'Content' });
  assert.equal(filesystemSearch.isError, false);
  assert.equal(JSON.parse(filesystemSearch.content[0].text).totalResults, 1);
});

test('semantic search distinguishes unavailable Ollama from a missing model', async () => {
  ollamaState = { available: false, hasModel: false };
  const unavailable = await handlers.semantic_search({
    vault: 'RecoveryVault',
    query: 'topic',
  });
  assert.equal(unavailable.isError, true);
  assert.equal(payload(unavailable).code, 'ollama_unavailable');

  ollamaState = { available: true, hasModel: false };
  const missingModel = await handlers.semantic_search({
    vault: 'RecoveryVault',
    query: 'topic',
  });
  assert.equal(missingModel.isError, true);
  assert.equal(payload(missingModel).code, 'model_unavailable');
  assert.deepEqual(payload(missingModel).sideEffects, { state: 'none' });
});

test('empty semantic index returns an actionable compatibility-preserving outcome', async () => {
  ollamaState = {
    available: true,
    hasModel: true,
    model: { name: 'mock-embed:latest', digest: 'sha256:mock' },
  };
  const response = await handlers.semantic_search({
    vault: 'RecoveryVault',
    query: 'topic',
  });
  const result = payload(response);

  assert.equal(response.isError, false);
  assert.equal(result.error, 'No indexed content. Run index_vault first.');
  assert.equal(result.indexed, 0);
  assert.equal(result.status, 'needs_action');
  assert.equal(result.code, 'index_required');
  assert.deepEqual(result.sideEffects, { state: 'none' });
  assert.deepEqual(result.actions, [{
    label: 'Index this vault',
    tool: 'index_vault',
    arguments: { vault: 'RecoveryVault' },
  }]);
});

test('get_similar distinguishes missing and empty file embeddings', async () => {
  const missing = await handlers.get_similar({
    vault: 'RecoveryVault',
    path: 'Missing.md',
  });
  const missingPayload = payload(missing);
  assert.equal(missing.isError, false);
  assert.equal(missingPayload.error, 'File not indexed. Run index_file first.');
  assert.equal(missingPayload.path, 'Missing.md');
  assert.equal(missingPayload.code, 'file_index_required');
  assert.deepEqual(missingPayload.sideEffects, { state: 'none' });
  assert.equal(missingPayload.actions, undefined);

  for (const unsafePath of ['../Outside.md', '/Users/alice/Secret.md']) {
    const unsafe = payload(await handlers.get_similar({
      vault: 'RecoveryVault',
      path: unsafePath,
    }));
    assert.equal(unsafe.code, 'file_index_required');
    assert.equal(unsafe.actions, undefined);
  }

  getSharedStorage(vaultDir).store('Note.md', [], 'empty-hash');
  const empty = await handlers.get_similar({
    vault: 'RecoveryVault',
    path: 'Note.md',
  });
  const emptyPayload = payload(empty);
  assert.equal(empty.isError, false);
  assert.equal(
    emptyPayload.error,
    'File has empty embedding (likely empty/minimal content). Try re-indexing.',
  );
  assert.equal(emptyPayload.path, 'Note.md');
  assert.equal(emptyPayload.code, 'empty_embedding');
  assert.deepEqual(emptyPayload.sideEffects, { state: 'none' });
  assert.deepEqual(emptyPayload.actions, [{
    label: 'Index this file',
    tool: 'index_file',
    arguments: { path: 'Note.md', vault: 'RecoveryVault' },
  }]);
});

test('cross-vault semantic search distinguishes unavailable Ollama from a missing model', async () => {
  ollamaState = { available: false, hasModel: false };
  const unavailable = await crossVaultHandlers.semantic_search_all({ query: 'topic' });
  assert.equal(unavailable.isError, true);
  assert.equal(payload(unavailable).code, 'ollama_unavailable');

  ollamaState = { available: true, hasModel: false };
  const missingModel = await crossVaultHandlers.semantic_search_all({ query: 'topic' });
  assert.equal(missingModel.isError, true);
  assert.equal(payload(missingModel).code, 'model_unavailable');
  assert.deepEqual(payload(missingModel).sideEffects, { state: 'none' });
});
