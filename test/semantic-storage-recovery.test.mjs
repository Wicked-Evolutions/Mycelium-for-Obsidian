import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { cleanup, createTempVault } from './helpers.mjs';

const ollamaUrl = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const actualOllama = await import(ollamaUrl);
const model = { name: 'test:latest', digest: 'test-digest' };
await mock.module(ollamaUrl, { namedExports: {
  ...actualOllama,
  checkOllamaAvailability: async () => ({ available: true, hasModel: true, model }),
  getEmbeddingModelProfile: async () => ({ ...model, contextLength: 2048, maxInputBytes: 1920 }),
  assertOllamaModelIdentity: async () => {},
  generateEmbedding: async () => ({ embedding: [1, 0], dimensions: 2, model: model.name, digest: model.digest }),
} });
const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { loadConfig } = await import('../dist/config.js');
const { EmbeddingStorage, EmbeddingStorageError } = await import('../dist/embeddings/storage.js');
const { indexRecoveryResponse } = await import('../dist/tools/index-recovery.js');
const vaults = [];
const originalVaults = process.env.OBSIDIAN_VAULTS;
afterEach(() => {
  for (const vault of vaults.splice(0)) cleanup(vault);
  if (originalVaults === undefined) delete process.env.OBSIDIAN_VAULTS;
  else process.env.OBSIDIAN_VAULTS = originalVaults;
});

function fixture() {
  const vault = fs.realpathSync(createTempVault({ 'Note.md': '# Note\n\nIndexed content' }));
  vaults.push(vault);
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ Test: vault });
  return { vault, handlers: createSemanticHandlers(loadConfig()) };
}
function inventory(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(name => {
    const target = path.join(root, name);
    const stat = fs.lstatSync(target);
    return [name, stat.ino, stat.mtimeMs, stat.ctimeMs,
      stat.isFile() ? fs.readFileSync(target).toString('base64') : null];
  });
}
function legacy(vault) {
  const dir = path.join(vault, '.mcp-obsidian');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'embeddings.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE embeddings (file_path TEXT, updated_at INTEGER)');
  db.exec("INSERT INTO embeddings VALUES ('Note.md', 1)");
  const bytes = ['', '-wal', '-shm'].map(suffix => fs.readFileSync(file + suffix));
  db.close();
  ['', '-wal', '-shm'].forEach((suffix, i) => fs.writeFileSync(file + suffix, bytes[i]));
}

test('status does not initialize a missing index and retains healthy fields', async () => {
  const { vault, handlers } = fixture();
  const before = inventory(vault);
  const response = await handlers.index_status({ vault: 'Test' });
  assert.equal(response.isError, false);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.currentMarkdownFiles, 1);
  assert.equal(result.totalEmbeddings, 0);
  assert.equal(result.lastUpdated, null);
  assert.equal(result.ollama.available, true);
  assert.deepEqual(inventory(vault), before);
});

test('status reads existing statistics without publishing a snapshot', async () => {
  const { vault, handlers } = fixture();
  const store = new EmbeddingStorage(vault);
  store.store('Note.md', [1, 0], 'hash', {}, null, 'content');
  store.close();
  const before = inventory(vault);
  const response = await handlers.index_status({ vault: 'Test' });
  assert.equal(response.isError, false);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.currentIndexedFiles, 1);
  assert.equal(result.totalEmbeddings, 1);
  assert.equal(result.fileCoveragePercent, 100);
  assert.deepEqual(inventory(vault), before);
});

for (const tool of ['index_status', 'semantic_search', 'get_similar', 'index_file', 'index_vault']) {
  test(`${tool} reports legacy storage explicitly without changing it`, async () => {
    const { vault, handlers } = fixture();
    legacy(vault);
    const before = inventory(vault);
    const response = await handlers[tool]({ vault: 'Test', query: 'content', path: 'Note.md' });
    assert.equal(response.isError, true);
    const result = response.structuredContent;
    assert.equal(result.code, 'legacy_index_upgrade_required');
    assert.equal(result.status, 'needs_action');
    assert.equal(result.retryable, false);
    assert.equal(result.sideEffects.state, 'none');
    assert.ok(!JSON.stringify(result).includes(vault));
    assert.deepEqual(inventory(vault), before);
  });
}

test('pending malformed publication gets a nonmutating actionable status', async () => {
  const { vault, handlers } = fixture();
  fs.mkdirSync(path.join(vault, '.mcp-obsidian'));
  fs.writeFileSync(path.join(vault, '.mcp-obsidian', 'embeddings.publish.lock'), '{invalid');
  const before = inventory(vault);
  const response = await handlers.index_status({ vault: 'Test' });
  assert.equal(response.structuredContent.code, 'index_recovery_required');
  assert.equal(response.structuredContent.sideEffects.state, 'none');
  assert.deepEqual(inventory(vault), before);
});

test('typed outcomes preserve uncertain side effects and do not classify arbitrary messages', () => {
  for (const noMutation of [true, false]) {
    const response = indexRecoveryResponse(new EmbeddingStorageError('index_recovery_required', noMutation));
    assert.equal(response.structuredContent.sideEffects.state, noMutation ? 'none' : 'unknown');
  }
  const active = indexRecoveryResponse(new EmbeddingStorageError('index_publication_in_progress'));
  assert.equal(active.structuredContent.status, 'conflict');
  assert.equal(active.structuredContent.retryable, true);
  assert.equal(indexRecoveryResponse(new Error('legacy_index_upgrade_required')), undefined);
});
