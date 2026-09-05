import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { EmbeddingStorage } from '../dist/embeddings/storage.js';
import { cleanup, createTempVault } from './helpers.mjs';

const storageUrl = new URL('../dist/embeddings/storage.js', import.meta.url).href;
const vaults = [];
const modelIdentity = 'publication-test:latest@sha256:deterministic';
const commitSuffix = '\nCOMMITTED\n';
const directoryOf = vault => path.join(vault, '.mcp-obsidian');
const databaseOf = vault => path.join(directoryOf(vault), 'embeddings.db');
const lockOf = vault => path.join(directoryOf(vault), 'embeddings.publish.lock');

afterEach(() => {
  for (const vault of vaults.splice(0)) cleanup(vault);
});

const childScript = String.raw`
  const [storageUrl, vault, mode, modelIdentity] = process.argv.slice(1);
  const { EmbeddingStorage, getSharedStorage, inspectEmbeddingIndex } = await import(storageUrl);
  if (mode === 'publish' || mode === 'interrupt' || mode === 'uncommitted') {
    const storage = new EmbeddingStorage(vault, mode === 'interrupt'
      ? { afterCommitMarker: () => process.exit(77) }
      : mode === 'uncommitted' ? { afterSnapshotRename: () => process.exit(78) } : {});
    await storage.runBatch(async () => {
      storage.store('Baseline.md', [0, 1], 'latest-baseline', { modelIdentity }, null, 'latest baseline');
      storage.store('Published.md', [1, 0], 'latest-published', { modelIdentity }, null, 'committed publication');
    });
    storage.close();
  } else {
    let storage;
    try {
      let value;
      if (mode === 'inspect') {
        value = inspectEmbeddingIndex(vault);
      } else {
        storage = getSharedStorage(vault);
        value = {
          stats: storage.getStats(),
          pathStats: storage.getPathStats(),
          rows: storage.getAll(),
          baselineContent: storage.getContent('Baseline.md'),
          publishedContent: storage.getContent('Published.md'),
          search: storage.search([1, 0], 10, 0.9),
        };
      }
      storage?.close();
      storage = undefined;
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: {
        name: error.name, code: error.code, message: error.message, noMutation: error.noMutation,
      } }));
    } finally {
      storage?.close();
    }
  }
`;

function child(vault, mode, script = childScript, status = mode === 'interrupt' ? 77 : mode === 'uncommitted' ? 78 : 0) {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--input-type=module', '--eval', script, storageUrl, vault, mode, modelIdentity,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, status, result.stderr);
  return result;
}

function cold(vault, mode) {
  return JSON.parse(child(vault, mode).stdout);
}

function entry(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return {
    device: stat.dev, inode: stat.ino, links: stat.nlink, mode: stat.mode,
    size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
    bytes: stat.isFile() ? fs.readFileSync(target).toString('base64') : null,
  };
}

function inventory(vault) {
  return Object.fromEntries(['', ...fs.readdirSync(vault, { recursive: true }).sort()]
    .map(name => [name, entry(path.join(vault, name))]));
}

function unchanged(vault, operation) {
  const before = inventory(vault);
  try { return operation(); }
  finally { assert.deepEqual(inventory(vault), before, 'operation changed fixture bytes or identities'); }
}

function seed() {
  const vault = fs.realpathSync(createTempVault({
    'Baseline.md': '# Baseline\n\nlatest baseline',
    'Published.md': '# Published\n\ncommitted publication',
  }));
  vaults.push(vault);
  const storage = new EmbeddingStorage(vault);
  try {
    storage.store('Baseline.md', [0, 1], 'previous-baseline', { modelIdentity }, null, 'previous baseline');
  } finally { storage.close(); }
  return vault;
}

function readTransaction(vault, committed = true) {
  const raw = fs.readFileSync(lockOf(vault), 'utf8');
  assert.equal(raw.endsWith(commitSuffix), committed, 'child exited at the wrong publication boundary');
  return JSON.parse(committed ? raw.slice(0, -commitSuffix.length) : raw);
}

function rewriteTransaction(vault, change, committed = true) {
  const transaction = readTransaction(vault, committed);
  change(transaction);
  fs.writeFileSync(lockOf(vault), JSON.stringify(transaction) + (committed ? commitSuffix : ''));
  return transaction;
}

function snapshotPaths(target) {
  const db = new Database(fs.readFileSync(target), { readonly: true });
  try {
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    return db.prepare('SELECT file_path FROM embeddings ORDER BY file_path').all().map(row => row.file_path);
  } finally { db.close(); }
}

function interrupted(mode = 'interrupt') {
  const vault = seed();
  const previous = fs.readFileSync(databaseOf(vault));
  const publisher = child(vault, mode);
  const transaction = readTransaction(vault, mode === 'interrupt');
  assert.equal(transaction.pid, publisher.pid);
  assert.throws(() => process.kill(transaction.pid, 0), { code: 'ESRCH' });
  const rollbackName = `.embeddings.db.${transaction.pid}.${transaction.nonce}.rollback`;
  const rollback = path.join(directoryOf(vault), rollbackName);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)).sort(),
    [rollbackName, 'embeddings.db', 'embeddings.publish.lock'].sort());
  for (const [identity, target] of [
    [transaction.temporaryIdentity, databaseOf(vault)],
    [transaction.rollbackIdentity, rollback],
  ]) {
    const actual = entry(target);
    assert.equal(identity.inode, actual.inode.toString());
    assert.equal(identity.device, actual.device.toString());
    assert.equal(actual.links, 1n);
  }
  assert.deepEqual(fs.readFileSync(rollback), previous);
  assert.deepEqual(snapshotPaths(rollback), ['Baseline.md']);
  assert.deepEqual(snapshotPaths(databaseOf(vault)), ['Baseline.md', 'Published.md']);
  return { vault, rollback };
}

function driftHistoricalDevices(vault, committed = true) {
  const transaction = readTransaction(vault, committed);
  const identities = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.device === 'string' && typeof value.inode === 'string') identities.push(value);
    else for (const nested of Object.values(value)) visit(nested);
  };
  visit(transaction);
  assert.ok(identities.length >= 3, 'fixture must alter all historical transaction identities');
  const currentDevice = fs.statSync(databaseOf(vault), { bigint: true }).dev.toString();
  for (const identity of identities) assert.equal(identity.device, currentDevice);
  const oldDevice = (BigInt(currentDevice) + 1n).toString();
  // Simulate historical device-number drift, not a real remount or altered current stat results.
  for (const identity of identities) identity.device = oldDevice;
  fs.writeFileSync(lockOf(vault), JSON.stringify(transaction) + (committed ? commitSuffix : ''));
}

function assertLatestInspection(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.value.stats.totalEmbeddings, 2);
  assert.equal(outcome.value.stats.uniqueFiles, 2);
  assert.deepEqual(outcome.value.pathStats, [
    { filePath: 'Baseline.md', embeddingChunks: 1 },
    { filePath: 'Published.md', embeddingChunks: 1 },
  ]);
}

function assertLatestStorage(outcome) {
  assertLatestInspection(outcome);
  assert.deepEqual(outcome.value.rows.map(row => [row.filePath, row.contentHash]).sort(), [
    ['Baseline.md', 'latest-baseline'], ['Published.md', 'latest-published'],
  ]);
  assert.equal(outcome.value.baselineContent, 'latest baseline');
  assert.equal(outcome.value.publishedContent, 'committed publication');
  assert.deepEqual(outcome.value.search.map(row => row.filePath), ['Published.md']);
}

test('cold inspection accepts committed device drift without artifact byte or identity mutations', () => {
  const { vault } = interrupted();
  driftHistoricalDevices(vault);
  const inspected = unchanged(vault, () => cold(vault, 'inspect'));
  assertLatestInspection(inspected);
  const committed = entry(databaseOf(vault));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed, 'recovery must not republish or roll back the database');
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

test('cold storage search recovers latest committed data after device drift, not the rollback', () => {
  const { vault } = interrupted();
  driftHistoricalDevices(vault);
  const committed = entry(databaseOf(vault));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
  assertLatestStorage(unchanged(vault, () => cold(vault, 'storage')));
});

test('normal uninterrupted publication still supports nonmutating cold inspection and reopen', () => {
  const vault = seed();
  child(vault, 'publish');
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
  assertLatestInspection(unchanged(vault, () => cold(vault, 'inspect')));
  assertLatestStorage(unchanged(vault, () => cold(vault, 'storage')));
});

function assertRefused(outcome, code) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.ok(outcome.error.message.length > 0);
  if (code) assert.equal(outcome.error.code, code);
}

function refusesWithoutMutation(vault, code) {
  for (const mode of ['inspect', 'storage']) {
    assertRefused(unchanged(vault, () => cold(vault, mode)), code);
  }
}

function asVersion3(vault) {
  rewriteTransaction(vault, transaction => {
    transaction.version = 3;
    delete transaction.publishedSha256;
    delete transaction.rollbackSha256;
  });
}

function alterSnapshot(target) {
  const before = entry(target);
  const db = new Database(fs.readFileSync(target));
  try {
    db.exec("UPDATE embeddings SET content_hash = 'tampered-hash'");
    fs.writeFileSync(target, db.serialize());
  } finally { db.close(); }
  const after = entry(target);
  assert.equal(after.device, before.device);
  assert.equal(after.inode, before.inode);
  assert.equal(after.size, before.size);
  assert.notEqual(after.bytes, before.bytes);
  snapshotPaths(target);
}

test('emitted v4 transaction fingerprints match both intact snapshot byte streams', () => {
  const { vault, rollback } = interrupted();
  const transaction = readTransaction(vault);
  assert.equal(transaction.version, 4);
  for (const [field, target] of [
    ['publishedSha256', databaseOf(vault)], ['rollbackSha256', rollback],
  ]) {
    assert.match(transaction[field], /^[0-9a-f]{64}$/);
    assert.equal(transaction[field], createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
  }
});

test('proven v4 committed publication without drift is inspectable and recoverable', () => {
  const { vault } = interrupted();
  assertLatestInspection(unchanged(vault, () => cold(vault, 'inspect')));
  const committed = entry(databaseOf(vault));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

test('legacy v3 committed record retains exact-identity recovery compatibility', () => {
  const { vault } = interrupted();
  asVersion3(vault);
  assertRefused(unchanged(vault, () => cold(vault, 'inspect')), 'index_recovery_required');
  const committed = entry(databaseOf(vault));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

test('legacy v3 without fingerprints refuses committed device drift without cleanup', () => {
  const { vault } = interrupted();
  asVersion3(vault);
  driftHistoricalDevices(vault);
  refusesWithoutMutation(vault, 'index_recovery_identity_mismatch');
});

for (const artifact of ['published', 'rollback']) {
  for (const drift of [false, true]) {
    test(`${artifact} byte tamper with unchanged inode refuses recovery (device drift: ${drift})`, () => {
      const { vault, rollback } = interrupted();
      if (drift) driftHistoricalDevices(vault);
      alterSnapshot(artifact === 'published' ? databaseOf(vault) : rollback);
      refusesWithoutMutation(vault);
    });
  }

  test(`${artifact} inode replacement with identical bytes refuses committed device-drift recovery`, () => {
    const { vault, rollback } = interrupted();
    driftHistoricalDevices(vault);
    const target = artifact === 'published' ? databaseOf(vault) : rollback;
    const before = entry(target);
    const held = path.join(vault, `held-${artifact}.db`);
    fs.renameSync(target, held);
    fs.copyFileSync(held, target);
    assert.notEqual(entry(target).inode, before.inode);
    assert.equal(entry(target).bytes, before.bytes);
    refusesWithoutMutation(vault);
  });
}

test('active PID blocks otherwise proven committed device-drift recovery', () => {
  const { vault, rollback } = interrupted();
  driftHistoricalDevices(vault);
  const transaction = rewriteTransaction(vault, record => { record.pid = process.pid; });
  fs.renameSync(rollback, path.join(directoryOf(vault),
    `.embeddings.db.${transaction.pid}.${transaction.nonce}.rollback`));
  refusesWithoutMutation(vault, 'index_publication_in_progress');
});

test('uncommitted v4 transaction refuses historical device drift without rollback or cleanup', () => {
  const { vault } = interrupted('uncommitted');
  assert.equal(readTransaction(vault, false).version, 4);
  driftHistoricalDevices(vault, false);
  refusesWithoutMutation(vault);
});

for (const artifact of ['known.tmp', 'orphan.tmp', 'orphan.rollback', '-wal', '-shm', '-journal']) {
  test(`unexpected ${artifact} blocks proven committed recovery without changing evidence`, () => {
    const { vault } = interrupted();
    driftHistoricalDevices(vault);
    const record = readTransaction(vault);
    const name = artifact === 'known.tmp' ? `.embeddings.db.${record.pid}.${record.nonce}.tmp`
      : artifact.startsWith('-') ? `embeddings.db${artifact}` : `.embeddings.db.${artifact}`;
    fs.writeFileSync(path.join(directoryOf(vault), name), 'unexpected artifact evidence');
    refusesWithoutMutation(vault);
  });
}

for (const field of ['publishedSha256', 'rollbackSha256']) {
  for (const invalid of [undefined, 'a'.repeat(63), 'G'.repeat(64), 'A'.repeat(64)]) {
    test(`v4 ${field} refuses ${invalid === undefined ? 'missing' : invalid.slice(0, 1) + invalid.length} fingerprint`, () => {
      const { vault } = interrupted();
      driftHistoricalDevices(vault);
      rewriteTransaction(vault, record => {
        if (invalid === undefined) delete record[field];
        else record[field] = invalid;
      });
      refusesWithoutMutation(vault);
    });
  }
}

test('committed rollback already missing at entry permits nonmutating inspection and cold cleanup', () => {
  const { vault, rollback } = interrupted();
  driftHistoricalDevices(vault);
  fs.unlinkSync(rollback);
  assertLatestInspection(unchanged(vault, () => cold(vault, 'inspect')));
  const committed = entry(databaseOf(vault));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

const raceScript = String.raw`
  import fs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  import { mock } from 'node:test';
  import Database from 'better-sqlite3';
  const [storageUrl, vault, mode] = process.argv.slice(1);
  const directory = path.join(vault, '.mcp-obsidian');
  const lock = path.join(directory, 'embeddings.publish.lock');
  const rollbackName = fs.readdirSync(directory).find(name => name.endsWith('.rollback'));
  const rollback = path.join(directory, rollbackName);
  const rollbackInode = fs.statSync(rollback, { bigint: true }).ino;
  let injected = false;
  let injectedDirectory;
  let queried = false;
  const mutateRecord = () => {
    // Same inode and valid, semantically equivalent JSON; the original record bytes changed.
    const raw = fs.readFileSync(lock, 'utf8');
    fs.writeFileSync(lock, '{ ' + raw.slice(1));
    injected = true;
  };
  const prepare = Database.prototype.prepare;
  mock.method(Database.prototype, 'prepare', function (query, ...args) {
    if (mode === 'record-query' && !injected && query.includes('COUNT(*) as count')) mutateRecord();
    const statement = prepare.call(this, query, ...args);
    if (query.includes('GROUP BY file_path')) {
      const all = statement.all;
      mock.method(statement, 'all', function (...args) {
        const value = all.apply(this, args);
        queried = true;
        return value;
      });
    }
    return statement;
  });
  if (mode.startsWith('disappear-')) {
    const read = fs.readSync;
    mock.method(fs, 'readSync', (descriptor, ...args) => {
      const count = read(descriptor, ...args);
      if (!injected && count > 0 && fs.fstatSync(descriptor, { bigint: true }).ino === rollbackInode) {
        fs.unlinkSync(rollback);
        const stat = fs.statSync(directory, { bigint: true });
        injectedDirectory = {
          links: stat.nlink.toString(), size: stat.size.toString(),
          mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString(),
        };
        injected = true;
      }
      return count;
    });
    syncBuiltinESMExports();
  }
  const secureFsUrl = new URL('./secure-fs.js', storageUrl).href;
  const secureFs = await import(secureFsUrl);
  await mock.module(secureFsUrl, { namedExports: {
    ...secureFs,
    openFileAt: (directory, name, ...args) => {
      if (mode === 'record-final' && queried && !injected && name === 'embeddings.publish.lock') mutateRecord();
      return secureFs.openFileAt(directory, name, ...args);
    },
    unlinkAt: (directory, name) => {
      secureFs.unlinkAt(directory, name);
      if (mode === 'cleanup-interrupt' && name === rollbackName) process.exit(79);
    },
  } });
  const { inspectEmbeddingIndex, getSharedStorage } = await import(storageUrl);
  try {
    if (mode === 'disappear-storage' || mode === 'cleanup-interrupt') getSharedStorage(vault).close();
    else inspectEmbeddingIndex(vault);
    console.log(JSON.stringify({ ok: true, injected, injectedDirectory }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, injected, injectedDirectory, error: {
      name: error.name, code: error.code, message: error.message, noMutation: error.noMutation,
    } }));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
`;

for (const boundary of ['query', 'final']) {
  test(`inspection refuses in-place publication-record mutation at the ${boundary} check`, () => {
    const { vault } = interrupted();
    driftHistoricalDevices(vault);
    const before = inventory(vault);
    const raw = fs.readFileSync(lockOf(vault), 'utf8');
    const result = JSON.parse(child(vault, `record-${boundary}`, raceScript).stdout);
    assert.equal(result.injected, true, 'record mutation hook did not execute');
    assertRefused(result);
    assert.equal(result.error.noMutation, true);
    const after = inventory(vault);
    const key = path.join('.mcp-obsidian', 'embeddings.publish.lock');
    assert.equal(after[key].bytes, Buffer.from('{ ' + raw.slice(1)).toString('base64'));
    for (const field of ['device', 'inode', 'links', 'mode']) assert.equal(after[key][field], before[key][field]);
    delete before[key];
    delete after[key];
    assert.deepEqual(after, before, 'inspection changed evidence beyond the injected record mutation');
  });
}

for (const mode of ['inspect', 'storage']) {
  test(`${mode} refuses rollback disappearance during hash verification without further cleanup`, () => {
    const { vault, rollback } = interrupted();
    driftHistoricalDevices(vault);
    const before = inventory(vault);
    const result = JSON.parse(child(vault, `disappear-${mode}`, raceScript).stdout);
    assert.equal(result.injected, true, 'rollback disappearance hook did not execute');
    assertRefused(result);
    const after = inventory(vault);
    delete before[path.relative(vault, rollback)];
    // Directory link counts can also change on unlink (for example on APFS).
    for (const field of ['links', 'size', 'mtime', 'ctime']) {
      before['.mcp-obsidian'][field] = BigInt(result.injectedDirectory[field]);
    }
    assert.deepEqual(after, before, 'recovery changed evidence beyond the injected rollback removal');
  });
}

test('cold restart after rollback cleanup before lock removal retains the committed snapshot', () => {
  const { vault, rollback } = interrupted();
  driftHistoricalDevices(vault);
  const committed = entry(databaseOf(vault));
  const lock = entry(lockOf(vault));
  child(vault, 'cleanup-interrupt', raceScript, 79);
  assert.equal(fs.existsSync(rollback), false);
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(entry(lockOf(vault)), lock);
  assertLatestInspection(unchanged(vault, () => cold(vault, 'inspect')));
  assertLatestStorage(cold(vault, 'storage'));
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

// Handler integration uses a deterministic embedding-provider module stub, not live Ollama.
const semanticScript = String.raw`
  import { mock } from 'node:test';
  const [storageUrl, vault, mode] = process.argv.slice(1);
  const ollamaUrl = new URL('./ollama.js', storageUrl).href;
  const actual = await import(ollamaUrl);
  const model = { name: 'publication-test:latest', digest: 'sha256:deterministic' };
  await mock.module(ollamaUrl, { namedExports: {
    ...actual,
    checkOllamaAvailability: async () => ({ available: true, hasModel: true, model }),
    getEmbeddingModelProfile: async () => ({ ...model, contextLength: 2048, maxInputBytes: 1920 }),
    assertOllamaModelIdentity: async () => {},
    generateEmbedding: async () => ({ embedding: [1, 0], model: model.name, digest: model.digest }),
  } });
  mock.method(globalThis, 'fetch', async () => { throw new Error('fixture must not contact a real provider'); });
  const { createSemanticHandlers } = await import(new URL('../tools/semantic.js', storageUrl).href);
  const handlers = createSemanticHandlers({
    mode: 'single', vaults: [{ name: 'PublicationFixture', path: vault }],
    ollama: { host: 'http://127.0.0.1:1', model: model.name },
    disabledTools: new Set(), readOnly: true, wrapUntrusted: false,
  });
  const response = await handlers[mode]({
    vault: 'PublicationFixture', query: 'committed publication', minSimilarity: 0.9, limit: 5,
    expand: false, rerank: false,
  });
  console.log(JSON.stringify(response));
  const { getSharedStorage } = await import(storageUrl);
  if (mode === 'semantic_search' && response.isError === false) getSharedStorage(vault).close();
`;

test('cold actual status and search handlers recover v4 drift with a deterministic provider stub', () => {
  const { vault } = interrupted();
  driftHistoricalDevices(vault);
  const status = unchanged(vault, () => JSON.parse(child(vault, 'index_status', semanticScript).stdout));
  assert.equal(status.isError, false, JSON.stringify(status));
  const coverage = JSON.parse(status.content[0].text);
  assert.equal(coverage.totalEmbeddings, 2);
  assert.equal(coverage.currentIndexedFiles, 2);
  const committed = entry(databaseOf(vault));
  const search = JSON.parse(child(vault, 'semantic_search', semanticScript).stdout);
  assert.equal(search.isError, false, JSON.stringify(search));
  const result = JSON.parse(search.content[0].text);
  assert.deepEqual(result.results.map(hit => hit.path), ['Published.md']);
  assert.equal(result.indexCompatibility.compatibleEmbeddingCount, 2);
  assert.equal(result.indexCompatibility.reindexRequired, false);
  assert.deepEqual(entry(databaseOf(vault)), committed);
  assert.deepEqual(fs.readdirSync(directoryOf(vault)), ['embeddings.db']);
});

test('failed publication preserves canonical replacement injected during catch-path rollback hashing', () => {
  const vault = seed();
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { mock } from 'node:test';
    import { isDeepStrictEqual } from 'node:util';
    import Database from 'better-sqlite3';
    const [storageUrl, vault] = process.argv.slice(1);
    const directory = path.join(vault, '.mcp-obsidian');
    const canonical = path.join(directory, 'embeddings.db');
    const lock = path.join(directory, 'embeddings.publish.lock');
    const replacement = path.join(vault, 'independent-replacement.db');
    const independent = new Database(':memory:');
    independent.exec("CREATE TABLE replacement (value TEXT); INSERT INTO replacement VALUES ('preserve replacement')");
    fs.writeFileSync(replacement, independent.serialize());
    independent.close();
    let callbackFailed = false;
    let injected = false;
    let rollback;
    let rollbackIdentity;
    let expected;
    const read = fs.readSync;
    mock.method(fs, 'readSync', (descriptor, ...args) => {
      const count = read(descriptor, ...args);
      if (callbackFailed && !injected && count > 0) {
        const stat = fs.fstatSync(descriptor, { bigint: true });
        if (stat.dev === rollbackIdentity.device && stat.ino === rollbackIdentity.inode) {
          injected = true;
          fs.renameSync(replacement, canonical);
          expected = inventory(vault);
        }
      }
      return count;
    });
    syncBuiltinESMExports();
    const { EmbeddingStorage } = await import(storageUrl);
    const storage = new EmbeddingStorage(vault, {
      afterSnapshotRename: () => {
        assert.equal(fs.readFileSync(lock, 'utf8').includes('COMMITTED'), false);
        rollback = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.rollback')));
        rollbackIdentity = entry(rollback);
        callbackFailed = true;
        throw new Error('controlled afterSnapshotRename callback failure');
      },
    });
    let operationError;
    try { storage.store('Published.md', [1, 0], 'failed-publication', {}, null, 'uncommitted'); }
    catch (error) { operationError = error; }
    finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(callbackFailed, true);
    assert.equal(injected, true, 'catch-path rollback hash hook did not execute');
    const observed = inventory(vault);
    const databaseKey = path.relative(vault, canonical);
    assert.deepEqual({
      operationFailed: operationError instanceof Error,
      storageClosed: storage.isClosed(),
      replacementPreserved: isDeepStrictEqual(observed[databaseKey], expected[databaseKey]),
      rollbackPreserved: isDeepStrictEqual(observed[path.relative(vault, rollback)], expected[path.relative(vault, rollback)]),
      lockPreserved: isDeepStrictEqual(observed[path.relative(vault, lock)], expected[path.relative(vault, lock)]),
      entireInventoryPreserved: isDeepStrictEqual(observed, expected),
    }, {
      operationFailed: true, storageClosed: true, replacementPreserved: true,
      rollbackPreserved: true, lockPreserved: true, entireInventoryPreserved: true,
    });
    assert.throws(() => storage.getStats(), /storage is closed/i);
  ` + '\n' + entry.toString() + '\n' + inventory.toString();
  child(vault, 'catch-path-replacement', script);
});
