import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as actualFs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { cleanup, createTempVault } from './helpers.mjs';

const scanFailures = new Set();
const inspectionFailures = new Map();
const searchFailures = new Map();
const inspected = [];
const opened = [];
const stores = new Set();
const vaults = [];
let providerError;

await mock.module('fs/promises', { namedExports: {
  ...actualFs,
  readdir: async (target, options) => {
    if (scanFailures.has(String(target))) throw new Error(`private scan failure: ${target}`);
    return actualFs.readdir(target, options);
  },
} });

const model = { name: 'fixture:latest', digest: 'sha256:fixture' };
const modelIdentity = `${model.name}@${model.digest}`;
const ollamaUrl = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const actualOllama = await import(ollamaUrl);
await mock.module(ollamaUrl, { namedExports: {
  ...actualOllama,
  checkOllamaAvailability: async () => {
    if (providerError) throw providerError;
    return { available: true, hasModel: true, model };
  },
  assertOllamaModelIdentity: async () => {},
  generateEmbedding: async () => ({
    embedding: [1, 0], dimensions: 2, model: model.name, digest: model.digest,
  }),
} });

const storageUrl = new URL('../dist/embeddings/storage.js', import.meta.url).href;
const actualStorage = await import(storageUrl);
const { EmbeddingStorage, EmbeddingStorageError } = actualStorage;
await mock.module(storageUrl, { namedExports: {
  ...actualStorage,
  inspectEmbeddingIndex: root => {
    inspected.push(root.path);
    if (inspectionFailures.has(root.path)) throw inspectionFailures.get(root.path);
    return actualStorage.inspectEmbeddingIndex(root);
  },
  getSharedStorage: root => {
    opened.push(root.path);
    if (searchFailures.has(root.path)) throw searchFailures.get(root.path);
    const storage = actualStorage.getSharedStorage(root);
    stores.add(storage);
    return storage;
  },
} });

await mock.module(new URL('../dist/tools/graph-annotate.js', import.meta.url).href, {
  namedExports: {
    annotateCrossVault: async ({ results }) => ({
      results: results.map(row => ({ ...row, graph: null })), graphByVault: {},
    }),
  },
});

const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const { indexRecoveryResponse, storageDiagnostic } = await import('../dist/tools/index-recovery.js');
const { SecureFilesystemUnavailableError } = await import('../dist/embeddings/secure-fs.js');
const { COMPLETENESS_REASON_LIMIT } = await import('../dist/result-metadata.js');

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const vault of vaults.splice(0)) cleanup(vault);
  scanFailures.clear();
  inspectionFailures.clear();
  searchFailures.clear();
  inspected.length = 0;
  opened.length = 0;
  providerError = undefined;
});

function makeVault(files = { 'Note.md': '# Note\n\nCurrent source' }) {
  const vault = fs.realpathSync(createTempVault(files));
  vaults.push(vault);
  return vault;
}

function handlersFor(namedVaults, dependencies) {
  return createCrossVaultHandlers({
    mode: 'multi',
    vaults: Object.entries(namedVaults).map(([name, vaultPath]) => ({ name, path: vaultPath })),
    ollama: { host: 'http://unused.invalid', model: model.name },
    disabledTools: new Set(), readOnly: true, wrapUntrusted: false,
  }, dependencies);
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

function seed(vault, rows = [['Note.md', null]], identity = modelIdentity) {
  const storage = new EmbeddingStorage(vault);
  try {
    for (const [file, block] of rows) {
      storage.store(file, [1, 0], 'hash', { modelIdentity: identity }, block, 'indexed content');
    }
  } finally { storage.close(); }
}

const directoryOf = vault => path.join(vault, '.mcp-obsidian');
const databaseOf = vault => path.join(directoryOf(vault), 'embeddings.db');

function legacy(vault) {
  fs.mkdirSync(directoryOf(vault));
  const database = new Database(databaseOf(vault));
  let bytes;
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
    database.exec('CREATE TABLE embeddings (file_path TEXT, updated_at INTEGER)');
    database.exec("INSERT INTO embeddings VALUES ('Note.md', 1)");
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.exec("INSERT INTO embeddings VALUES ('CommittedInWal.md', 2)");
    bytes = ['', '-wal', '-shm'].map(suffix => fs.readFileSync(databaseOf(vault) + suffix));
  } finally { database.close(); }
  ['', '-wal', '-shm'].forEach((suffix, i) => fs.writeFileSync(databaseOf(vault) + suffix, bytes[i]));
}

function corrupt(vault) {
  fs.mkdirSync(directoryOf(vault));
  fs.writeFileSync(databaseOf(vault), 'private invalid SQLite content');
}

function inventory(root) {
  const rows = [];
  const visit = relative => {
    const target = path.join(root, relative);
    const stat = fs.lstatSync(target, { bigint: true });
    rows.push({
      relative, device: stat.dev, inode: stat.ino, links: stat.nlink,
      mode: stat.mode, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
      content: stat.isSymbolicLink() ? fs.readlinkSync(target)
        : stat.isFile() ? createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null,
    });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
    }
  };
  visit('');
  return rows;
}

async function unchanged(roots, operation) {
  const before = roots.map(inventory);
  try { return await operation(); }
  finally { assert.deepEqual(roots.map(inventory), before, 'no vault or index mutation'); }
}

function partial(result, scanned, skipped, reasons) {
  assert.deepEqual(result.completeness, { state: 'partial', scanned, skipped, reasons });
  assert.ok(result.completeness.reasons.length <= COMPLETENESS_REASON_LIMIT);
}

const dependentRowFields = [
  'indexedPercent', 'currentIndexedFiles', 'staleIndexedFiles',
  'currentEmbeddingChunks', 'staleEmbeddingChunks', 'fileCoveragePercent',
  'embeddingChunksPerCurrentIndexedFile', 'embeddingChunksPerCurrentMarkdownFile',
];
const indexOnlyRowFields = ['totalEmbeddings', 'embeddingChunks', 'indexedFilePathCount'];
const dependentTotalFields = [
  'overallIndexedPercent', 'totalCurrentIndexedFiles', 'totalStaleIndexedFiles',
  'totalCurrentEmbeddingChunks', 'totalStaleEmbeddingChunks', 'overallFileCoveragePercent',
  'embeddingChunksPerCurrentIndexedFile', 'embeddingChunksPerCurrentMarkdownFile',
];
const indexOnlyTotalFields = ['totalEmbeddings', 'totalEmbeddingChunks', 'totalIndexedFilePathCount'];

function nullFields(row, fields) {
  for (const field of fields) assert.equal(row[field], null, `${field} is unknown, not zero or absent`);
}

function healthyRow(vault, currentMarkdownFiles, indexedFilePathCount = 0, currentIndexedFiles = 0,
  staleIndexedFiles = 0, currentEmbeddingChunks = 0, staleEmbeddingChunks = 0) {
  const percent = currentMarkdownFiles ? 100 * currentIndexedFiles / currentMarkdownFiles : 0;
  return {
    vault, totalFiles: currentMarkdownFiles,
    totalEmbeddings: currentEmbeddingChunks + staleEmbeddingChunks,
    indexedPercent: percent, currentMarkdownFiles, indexedFilePathCount, currentIndexedFiles,
    staleIndexedFiles, embeddingChunks: currentEmbeddingChunks + staleEmbeddingChunks,
    currentEmbeddingChunks, staleEmbeddingChunks, fileCoveragePercent: percent,
    embeddingChunksPerCurrentIndexedFile: currentIndexedFiles ? currentEmbeddingChunks / currentIndexedFiles : 0,
    embeddingChunksPerCurrentMarkdownFile: currentMarkdownFiles ? currentEmbeddingChunks / currentMarkdownFiles : 0,
  };
}

test('healthy ecosystem stats retain the complete response contract without opening mutable storage', async () => {
  const indexed = makeVault({ 'Note.md': '# Note', 'Other.md': '# Other', '.Hidden.md': '# Hidden' });
  const empty = makeVault();
  seed(indexed, [['Note.md', null], ['Note.md', 'section'], ['Gone.md', null]]);
  const result = payload(await unchanged([indexed, empty], () =>
    handlersFor({ Indexed: indexed, Empty: empty }).get_ecosystem_stats()));
  assert.deepEqual(result, {
    vaultCount: 2, totalFiles: 3, totalEmbeddings: 3, overallIndexedPercent: 33.33,
    totalMarkdownFiles: 3, totalIndexedFilePathCount: 2, totalCurrentIndexedFiles: 1,
    totalStaleIndexedFiles: 1, totalEmbeddingChunks: 3, totalCurrentEmbeddingChunks: 2,
    totalStaleEmbeddingChunks: 1, overallFileCoveragePercent: 33.33,
    embeddingChunksPerCurrentIndexedFile: 2, embeddingChunksPerCurrentMarkdownFile: 0.67,
    vaults: [healthyRow('Indexed', 2, 2, 1, 1, 2, 1), healthyRow('Empty', 1)],
    ollama: { available: true, model: model.name, hasModel: true },
  });
  assert.deepEqual(inspected, [indexed, empty]);
  assert.deepEqual(opened, []);
});

test('missing, empty-directory and empty-database indexes remain untouched and exactly empty', async () => {
  const missing = makeVault({});
  const directory = makeVault();
  const database = makeVault();
  fs.mkdirSync(directoryOf(directory));
  seed(database, []);
  const result = payload(await unchanged([missing, directory, database], () =>
    handlersFor({ Missing: missing, Directory: directory, Database: database }).get_ecosystem_stats()));
  assert.deepEqual(result.vaults, [healthyRow('Missing', 0), healthyRow('Directory', 1), healthyRow('Database', 1)]);
  assert.equal(result.totalEmbeddings, 0);
  assert.equal(result.overallIndexedPercent, 0);
  assert.equal(result.completeness, undefined);
  assert.deepEqual(opened, []);
});

test('older readable SQLite schema is inspected without normalization or deduplication', async () => {
  const vault = makeVault();
  fs.mkdirSync(directoryOf(vault));
  const db = new Database(databaseOf(vault));
  db.exec(`CREATE TABLE embeddings (file_path TEXT, updated_at INTEGER);
    INSERT INTO embeddings VALUES ('Note.md', 1), ('Note.md', 2);`);
  db.close();
  const result = payload(await unchanged([vault], () => handlersFor({ Older: vault }).get_ecosystem_stats()));
  assert.deepEqual(result.vaults, [healthyRow('Older', 1, 1, 1, 0, 2, 0)]);
  assert.deepEqual(opened, []);
});

for (const invalidPath of ['NULL', '42']) {
  test(`invalid legacy file_path ${invalidPath} cannot blank other vaults or known index counts`, async () => {
    const invalid = makeVault();
    const healthy = makeVault();
    fs.mkdirSync(directoryOf(invalid));
    const db = new Database(databaseOf(invalid));
    db.exec(`CREATE TABLE embeddings (file_path, updated_at INTEGER);
      INSERT INTO embeddings VALUES (${invalidPath}, 1), ('Note.md', 2);`);
    db.close();
    const result = payload(await unchanged([invalid, healthy], () =>
      handlersFor({ Invalid: invalid, Healthy: healthy }).get_ecosystem_stats()));
    const row = result.vaults[0];
    assert.equal(row.totalFiles, 1);
    assert.equal(row.currentMarkdownFiles, 1);
    assert.equal(row.totalEmbeddings, 2);
    assert.equal(row.embeddingChunks, 2);
    assert.equal(row.indexedFilePathCount, 2);
    nullFields(row, dependentRowFields);
    assert.equal(row.storageDiagnostic.code, 'index_inspection_failed');
    partial(row, 0, 1, ['vault_search_failed']);
    assert.deepEqual(result.vaults[1], healthyRow('Healthy', 1));
    assert.equal(result.totalFiles, 2);
    assert.equal(result.totalMarkdownFiles, 2);
    assert.equal(result.totalEmbeddings, 2);
    assert.equal(result.totalEmbeddingChunks, 2);
    assert.equal(result.totalIndexedFilePathCount, 2);
    nullFields(result, dependentTotalFields);
    partial(result, 1, 1, ['vault_search_failed']);
  });
}

test('mixed healthy, legacy, corrupt and pending indexes preserve every vault and readable file count', async () => {
  const healthy = makeVault();
  const wal = makeVault();
  const invalid = makeVault();
  const pending = makeVault();
  const empty = makeVault();
  seed(healthy);
  legacy(wal);
  corrupt(invalid);
  fs.mkdirSync(directoryOf(pending));
  fs.writeFileSync(path.join(directoryOf(pending), 'embeddings.publish.lock'), '{private invalid publication');
  const result = payload(await unchanged([healthy, wal, invalid, pending, empty], () =>
    handlersFor({ Healthy: healthy, Legacy: wal, Invalid: invalid, Pending: pending, Empty: empty }).get_ecosystem_stats()));
  assert.equal(result.vaultCount, 5);
  assert.equal(result.totalFiles, 5);
  assert.equal(result.totalMarkdownFiles, 5);
  assert.deepEqual(result.vaults[0], healthyRow('Healthy', 1, 1, 1, 0, 1, 0));
  assert.deepEqual(result.vaults[4], healthyRow('Empty', 1));
  const codes = ['legacy_index_upgrade_required', 'index_storage_unsafe', 'index_recovery_required'];
  for (const [i, code] of codes.entries()) {
    const row = result.vaults[i + 1];
    assert.equal(row.totalFiles, 1);
    assert.equal(row.currentMarkdownFiles, 1);
    nullFields(row, [...dependentRowFields, ...indexOnlyRowFields]);
    assert.deepEqual(row.storageDiagnostic, storageDiagnostic(new EmbeddingStorageError(code)));
    partial(row, 0, 1, ['vault_search_failed']);
  }
  nullFields(result, [...dependentTotalFields, ...indexOnlyTotalFields]);
  partial(result, 2, 3, ['vault_search_failed']);
  assert.ok(!JSON.stringify(result).includes('private'));
  for (const vault of [healthy, wal, invalid, pending, empty]) assert.ok(!JSON.stringify(result).includes(vault));
  assert.deepEqual(opened, []);
});

test('all unavailable indexes retain zero filesystem counts without reporting zero index totals', async () => {
  const wal = makeVault({});
  const invalid = makeVault({});
  legacy(wal);
  corrupt(invalid);
  const result = payload(await unchanged([wal, invalid], () =>
    handlersFor({ Legacy: wal, Invalid: invalid }).get_ecosystem_stats()));
  assert.equal(result.totalFiles, 0);
  assert.equal(result.totalMarkdownFiles, 0);
  nullFields(result, [...dependentTotalFields, ...indexOnlyTotalFields]);
  partial(result, 0, 2, ['vault_search_failed']);
  assert.equal(result.vaults.length, 2);
});

for (const location of ['root', 'subdirectory']) {
  test(`failed ${location} file scan preserves index-only counts and nulls file-dependent aggregates`, async () => {
    const failed = makeVault({ 'Note.md': '# Note', 'Sub/Other.md': '# Other' });
    const healthy = makeVault();
    seed(failed, [['Note.md', null], ['Sub/Other.md', null], ['Gone.md', null]]);
    seed(healthy);
    scanFailures.add(location === 'root' ? failed : path.join(failed, 'Sub'));
    const result = payload(await unchanged([failed, healthy], () =>
      handlersFor({ Failed: failed, Healthy: healthy }).get_ecosystem_stats()));
    const row = result.vaults[0];
    nullFields(row, ['totalFiles', 'currentMarkdownFiles', ...dependentRowFields]);
    assert.equal(row.totalEmbeddings, 3);
    assert.equal(row.embeddingChunks, 3);
    assert.equal(row.indexedFilePathCount, 3);
    assert.equal(row.storageDiagnostic, undefined);
    partial(row, 0, 1, ['scan_failure']);
    assert.deepEqual(result.vaults[1], healthyRow('Healthy', 1, 1, 1, 0, 1, 0));
    nullFields(result, ['totalFiles', 'totalMarkdownFiles', ...dependentTotalFields]);
    assert.equal(result.totalEmbeddings, 4);
    assert.equal(result.totalEmbeddingChunks, 4);
    assert.equal(result.totalIndexedFilePathCount, 4);
    partial(result, 1, 1, ['scan_failure']);
  });
}

test('one vault failing both scans counts once and contributes only fixed bounded reasons', async () => {
  const failed = makeVault();
  const healthy = makeVault();
  scanFailures.add(failed);
  inspectionFailures.set(failed, new Error(`private index failure: ${failed}`));
  const result = payload(await handlersFor({ Failed: failed, Healthy: healthy }).get_ecosystem_stats());
  const row = result.vaults[0];
  nullFields(row, ['totalFiles', 'currentMarkdownFiles', ...dependentRowFields, ...indexOnlyRowFields]);
  assert.deepEqual(row.storageDiagnostic, {
    code: 'index_inspection_failed',
    message: 'Embedding index statistics could not be inspected.',
    hint: 'Verify vault and index access, then retry. Preserve existing index artifacts.',
  });
  partial(row, 0, 1, ['scan_failure', 'vault_search_failed']);
  partial(result, 1, 1, ['scan_failure', 'vault_search_failed']);
  assert.deepEqual(result.vaults[1], healthyRow('Healthy', 1));
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('unavailable vault roots do not prevent later vault inspection', async () => {
  const healthy = makeVault();
  const missing = path.join(healthy, 'MissingVault');
  const result = payload(await unchanged([healthy], () =>
    handlersFor({ Missing: missing, Healthy: healthy }).get_ecosystem_stats()));
  nullFields(result.vaults[0], ['totalFiles', 'currentMarkdownFiles', ...dependentRowFields, ...indexOnlyRowFields]);
  partial(result.vaults[0], 0, 1, ['vault_unavailable']);
  partial(result, 1, 1, ['vault_unavailable']);
  assert.deepEqual(result.vaults[1], healthyRow('Healthy', 1));
  assert.deepEqual(inspected, [healthy]);
  assert.ok(!JSON.stringify(result).includes(missing));
});

test('unsupported secure filesystem keeps ecosystem filesystem statistics without inspecting indexes', async () => {
  const indexed = makeVault();
  const empty = makeVault({});
  seed(indexed);
  const handlers = handlersFor({ Indexed: indexed, Empty: empty }, { secureMutationSupported: () => false });
  const result = payload(await unchanged([indexed, empty], () => handlers.get_ecosystem_stats()));
  assert.equal(result.totalFiles, 1);
  assert.equal(result.totalMarkdownFiles, 1);
  nullFields(result, [...dependentTotalFields, ...indexOnlyTotalFields]);
  for (const [i, row] of result.vaults.entries()) {
    assert.equal(row.totalFiles, i === 0 ? 1 : 0);
    assert.equal(row.currentMarkdownFiles, row.totalFiles);
    nullFields(row, [...dependentRowFields, ...indexOnlyRowFields]);
    assert.deepEqual(row.storageDiagnostic, storageDiagnostic(new SecureFilesystemUnavailableError()));
    partial(row, 0, 1, ['vault_search_failed']);
  }
  partial(result, 0, 2, ['vault_search_failed']);
  assert.deepEqual(inspected, []);
  assert.deepEqual(opened, []);
  const semantic = await handlers.semantic_search_all({ query: 'source' });
  assert.equal(semantic.isError, true);
  assert.equal(semantic.structuredContent.code, 'semantic_storage_unavailable');
});

test('runtime secure-filesystem unavailability is recognized per vault after platform support succeeds', async () => {
  const failed = makeVault();
  const healthy = makeVault();
  inspectionFailures.set(failed, new SecureFilesystemUnavailableError());
  const result = payload(await handlersFor({ Failed: failed, Healthy: healthy }, {
    secureMutationSupported: () => true,
  }).get_ecosystem_stats());
  assert.equal(result.vaults[0].totalFiles, 1);
  assert.deepEqual(result.vaults[0].storageDiagnostic, storageDiagnostic(new SecureFilesystemUnavailableError()));
  assert.deepEqual(result.vaults[1], healthyRow('Healthy', 1));
  partial(result, 1, 1, ['vault_search_failed']);
});

test('semantic search retains healthy, unindexed and incompatible states alongside recognized and unknown failures', async () => {
  const healthy = makeVault();
  const wal = makeVault();
  const unknown = makeVault();
  const empty = makeVault();
  const incompatible = makeVault();
  seed(healthy);
  legacy(wal);
  seed(incompatible, [['Note.md', null]], 'other:latest@sha256:other');
  searchFailures.set(unknown, new Error(`legacy_index_upgrade_required private ${unknown}`));
  const result = payload(await unchanged([wal], () => handlersFor({
    Healthy: healthy, Legacy: wal, Unknown: unknown, Empty: empty, Incompatible: incompatible,
  }).semantic_search_all({ query: 'source' })));
  assert.equal(result.vaultsSearched, 5);
  assert.equal(result.vaultsIndexed, 2);
  assert.equal(result.resultCount, 1);
  assert.deepEqual(result.results.map(row => [row.vault, row.path, row.similarity]), [['Healthy', 'Note.md', 1]]);
  assert.deepEqual(result.resultMetadataByVault.map(row => row.state), ['searched', 'failed', 'failed', 'unindexed', 'incompatible']);
  const [searched, failed, unrecognized, unindexed, incompatibleRow] = result.resultMetadataByVault;
  assert.equal(searched.storageDiagnostic, undefined);
  assert.equal(searched.completeness, undefined);
  assert.equal(searched.indexCompatibility.state, 'complete');
  assert.deepEqual(failed.storageDiagnostic, storageDiagnostic(new EmbeddingStorageError('legacy_index_upgrade_required')));
  partial(failed, 0, 1, ['vault_search_failed']);
  assert.equal(unrecognized.storageDiagnostic, undefined);
  partial(unrecognized, 0, 1, ['vault_search_failed']);
  partial(unindexed, 0, 1, ['vault_unindexed']);
  partial(incompatibleRow, 0, 1, ['embedding_index_incompatible']);
  partial(result, 1, 4, ['vault_search_failed', 'vault_unindexed', 'embedding_index_incompatible']);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('all failed semantic vaults retain failed metadata and typed storage diagnostics', async () => {
  const first = makeVault();
  const second = makeVault();
  const errors = [new EmbeddingStorageError('index_publication_in_progress'), new SecureFilesystemUnavailableError()];
  searchFailures.set(first, errors[0]);
  searchFailures.set(second, errors[1]);
  const result = payload(await unchanged([first, second], () =>
    handlersFor({ First: first, Second: second }).semantic_search_all({ query: 'source' })));
  assert.equal(result.vaultsIndexed, 0);
  assert.equal(result.resultCount, 0);
  assert.deepEqual(result.results, []);
  for (const [i, row] of result.resultMetadataByVault.entries()) {
    assert.equal(row.state, 'failed');
    assert.deepEqual(row.storageDiagnostic, storageDiagnostic(errors[i]));
    partial(row, 0, 1, ['vault_search_failed']);
  }
  partial(result, 0, 2, ['vault_search_failed']);
});

for (const tool of ['semantic_search_all', 'get_ecosystem_stats']) {
  test(`${tool} outer catch preserves typed recovery and does not classify unknown errors by message`, async () => {
    const vault = makeVault();
    const handlers = handlersFor({ Fixture: vault });
    providerError = new EmbeddingStorageError('index_recovery_required', true);
    const response = await handlers[tool]({ query: 'source' });
    assert.deepEqual(response, indexRecoveryResponse(providerError));
    assert.equal(response.structuredContent.sideEffects.state, 'none');
    providerError = new Error('legacy_index_upgrade_required');
    const unknown = await handlers[tool]({ query: 'source' });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent, undefined);
    assert.match(unknown.content[0].text, /error: Error: legacy_index_upgrade_required/);
  });
}
