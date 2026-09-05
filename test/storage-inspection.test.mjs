import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  EmbeddingStorage,
  EmbeddingStorageError,
  getSharedStorage,
  inspectEmbeddingIndex,
} from '../dist/embeddings/storage.js';
import { pinVaultRootSync } from '../dist/embeddings/vault-root.js';
import { cleanup, createTempVault } from './helpers.mjs';

const vaults = [];
afterEach(() => {
  mock.restoreAll();
  for (const vault of vaults.splice(0)) cleanup(vault);
});

function makeVault() {
  const vault = fs.realpathSync(createTempVault({ 'Note.md': '# Unchanged source' }));
  vaults.push(vault);
  return vault;
}

const directoryOf = vault => path.join(vault, '.mcp-obsidian');
const databaseOf = vault => path.join(directoryOf(vault), 'embeddings.db');

function inventory(root) {
  const result = {};
  const visit = relative => {
    const target = path.join(root, relative);
    const stat = fs.lstatSync(target, { bigint: true });
    result[relative] = {
      device: stat.dev, inode: stat.ino, links: stat.nlink, mode: stat.mode,
      mtime: stat.mtimeNs, ctime: stat.ctimeNs,
      content: stat.isSymbolicLink() ? fs.readlinkSync(target)
        : stat.isFile() ? createHash('sha256').update(fs.readFileSync(target)).digest('hex')
          : null,
    };
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
    }
  };
  visit('');
  return result;
}

function unchanged(vault, operation) {
  const before = inventory(vault);
  try { return operation(); }
  finally { assert.deepEqual(inventory(vault), before); }
}

function diagnostic(code, noMutation = true) {
  return error => {
    assert.ok(error instanceof EmbeddingStorageError);
    assert.equal(error.code, code);
    assert.equal(error.noMutation, noMutation);
    const fixed = new EmbeddingStorageError(code);
    assert.equal(error.message, fixed.message);
    assert.equal(error.hint, fixed.hint);
    assert.ok(error.hint.length > 0);
    return true;
  };
}

function seed(vault) {
  const storage = new EmbeddingStorage(pinVaultRootSync(vault));
  try {
    storage.store('Note.md', [1, 0], 'one', {}, null, 'first');
    storage.store('Note.md', [0, 1], 'two', {}, 'section', 'second');
    storage.store('Other.md', [1, 1], 'three', {}, null, 'third');
    return { stats: storage.getStats(), pathStats: storage.getPathStats() };
  } finally { storage.close(); }
}

function interruptPublisher(vault, phase) {
  const child = spawnSync(process.execPath, [
    '--input-type=module', '--eval', `
      const { EmbeddingStorage } = await import(process.argv[1]);
      const phase = process.argv[3];
      const dependencies = phase === 'prepared'
        ? { afterRollbackPinned: () => process.exit(77) }
        : phase === 'renamed'
          ? { afterSnapshotRename: () => process.exit(77) }
          : { afterCommitMarker: () => process.exit(77) };
      const storage = new EmbeddingStorage(process.argv[2], dependencies);
      storage.store('Published.md', [1, 0], 'new', {}, null, 'committed row');
      process.exit(99);
    `,
    new URL('../dist/embeddings/storage.js', import.meta.url).href, vault, phase,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 77, child.stderr);
}

function legacyWal(vault) {
  fs.mkdirSync(directoryOf(vault));
  const database = databaseOf(vault);
  const legacy = new Database(database);
  let bytes;
  try {
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('wal_autocheckpoint = 0');
    legacy.exec('CREATE TABLE embeddings (file_path TEXT, updated_at INTEGER)');
    legacy.exec("INSERT INTO embeddings VALUES ('Checkpointed.md', 1)");
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    legacy.exec("INSERT INTO embeddings VALUES ('CommittedInWal.md', 2)");
    bytes = ['', '-wal', '-shm'].map(suffix => fs.readFileSync(`${database}${suffix}`));
  } finally { legacy.close(); }
  ['', '-wal', '-shm'].forEach((suffix, index) => fs.writeFileSync(`${database}${suffix}`, bytes[index]));
}

const inspectionFifoRaceScript = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { spawnSync } from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  import { mock } from 'node:test';
  import Database from 'better-sqlite3';

  const [storageUrl, vault, name, reopen] = process.argv.slice(1);
  const secureFsUrl = new URL('./secure-fs.js', storageUrl).href;
  const secureFs = await import(secureFsUrl);
  const target = path.join(vault, '.mcp-obsidian', name);
  const descriptors = new Set();
  const directories = [];
  let opened = 0;
  let closed = 0;
  let lockOpens = 0;
  let replaced = false;
  let sqliteClosed = 0;
  const track = descriptor => {
    assert.equal(descriptors.has(descriptor), false);
    descriptors.add(descriptor);
    opened++;
    if (fs.fstatSync(descriptor).isDirectory()) directories.push(descriptor);
    return descriptor;
  };
  const replace = () => {
    assert.equal(replaced, false);
    fs.renameSync(target, target + '.held');
    const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8', timeout: 2_000 });
    assert.equal(fifo.error, undefined, fifo.stderr);
    assert.equal(fifo.status, 0, fifo.stderr);
    replaced = true;
  };
  const closeDescriptor = fs.closeSync;
  mock.method(fs, 'closeSync', descriptor => {
    closeDescriptor(descriptor);
    if (descriptors.delete(descriptor)) {
      assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
      closed++;
    }
  });
  syncBuiltinESMExports();
  await mock.module(secureFsUrl, { namedExports: {
    ...secureFs,
    openPinnedDirectory: (...args) => track(secureFs.openPinnedDirectory(...args)),
    openDirectoryAt: (...args) => track(secureFs.openDirectoryAt(...args)),
    openFileAt: (directory, basename, ...args) => {
      if (name === 'embeddings.publish.lock' && basename === name && ++lockOpens === Number(reopen)) {
        replace();
      }
      return track(secureFs.openFileAt(directory, basename, ...args));
    },
  } });
  const prepare = Database.prototype.prepare;
  mock.method(Database.prototype, 'prepare', function (...args) {
    if (name === 'embeddings.db' && !replaced) replace();
    return prepare.apply(this, args);
  });
  const closeDatabase = Database.prototype.close;
  mock.method(Database.prototype, 'close', function () {
    closeDatabase.call(this);
    assert.equal(this.open, false);
    sqliteClosed++;
  });
  try {
    const { inspectEmbeddingIndex, EmbeddingStorageError } = await import(storageUrl);
    assert.throws(() => inspectEmbeddingIndex(vault), error => {
      assert.ok(error instanceof EmbeddingStorageError);
      assert.equal(error.code, 'index_storage_unsafe');
      assert.equal(error.noMutation, true);
      return true;
    });
    assert.equal(replaced, true);
    assert.ok(directories.length >= 2, 'both pinned directories must be tracked');
    assert.equal(descriptors.size, 0, 'inspection leaked a descriptor');
    assert.equal(closed, opened);
    assert.equal(sqliteClosed, name === 'embeddings.db' ? 1 : 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
`;

test('inspection does not create a missing storage directory or database', () => {
  for (const existingDirectory of [false, true]) {
    const vault = makeVault();
    if (existingDirectory) fs.mkdirSync(directoryOf(vault));
    const result = unchanged(vault, () => inspectEmbeddingIndex(pinVaultRootSync(vault)));
    assert.deepEqual(result, {
      stats: { totalEmbeddings: 0, uniqueFiles: 0, lastUpdated: null }, pathStats: [],
    });
  }
});

test('inspection matches existing storage statistics without publishing or changing artifacts', () => {
  const vault = makeVault();
  const expected = seed(vault);
  for (const input of [vault, pinVaultRootSync(vault), databaseOf(vault)]) {
    assert.deepEqual(unchanged(vault, () => inspectEmbeddingIndex(input)), expected);
  }
});

test('inspection leaves an existing empty index unchanged', () => {
  const vault = makeVault();
  const storage = new EmbeddingStorage(vault);
  const expected = { stats: storage.getStats(), pathStats: storage.getPathStats() };
  storage.close();
  assert.deepEqual(unchanged(vault, () => inspectEmbeddingIndex(vault)), expected);
});

test('inspection opens SQLite read-only in memory and issues no normalization pragmas', () => {
  const vault = makeVault();
  const expected = seed(vault);
  const pragma = Database.prototype.pragma;
  const observed = mock.method(Database.prototype, 'pragma', function (source, ...args) {
    assert.equal(this.name, ':memory:');
    assert.equal(this.readonly, true);
    assert.equal(source, 'table_info(embeddings)');
    return pragma.call(this, source, ...args);
  });
  mock.method(Database.prototype, 'exec', () => { throw new Error('inspection must not initialize a schema'); });
  assert.deepEqual(unchanged(vault, () => inspectEmbeddingIndex(vault)), expected);
  assert.equal(observed.mock.callCount(), 1);
});

test('inspection never normalizes an older schema or deduplicates its rows', () => {
  const vault = makeVault();
  fs.mkdirSync(directoryOf(vault));
  const legacy = new Database(databaseOf(vault));
  legacy.exec(`
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY, file_path TEXT, block_id TEXT, content_hash TEXT,
      embedding BLOB, metadata TEXT, updated_at INTEGER
    );
    INSERT INTO embeddings VALUES (1, 'Note.md', NULL, 'a', X'0000803f', '{}', 10);
    INSERT INTO embeddings VALUES (2, 'Note.md', NULL, 'b', X'0000803f', '{}', 20);
  `);
  legacy.close();
  const result = unchanged(vault, () => inspectEmbeddingIndex(vault));
  assert.deepEqual(result, {
    stats: { totalEmbeddings: 2, uniqueFiles: 1, lastUpdated: 20 },
    pathStats: [{ filePath: 'Note.md', embeddingChunks: 2 }],
  });
});

test('legacy WAL sidecars receive a typed offline-upgrade diagnosis without changing any bytes', () => {
  const vault = makeVault();
  legacyWal(vault);
  for (const open of [inspectEmbeddingIndex, getSharedStorage, value => new EmbeddingStorage(value)]) {
    unchanged(vault, () => assert.throws(() => open(vault), diagnostic('legacy_index_upgrade_required')));
  }
});

test('inspection refuses a sidecar-free WAL header without normalizing it', () => {
  const vault = makeVault();
  legacyWal(vault);
  fs.unlinkSync(`${databaseOf(vault)}-wal`);
  fs.unlinkSync(`${databaseOf(vault)}-shm`);
  unchanged(vault, () => assert.throws(
    () => inspectEmbeddingIndex(vault), diagnostic('legacy_index_upgrade_required'),
  ));
});

for (const phase of ['prepared', 'renamed', 'committed']) {
  test(`inspection preserves interrupted ${phase} publication evidence`, () => {
    const vault = makeVault();
    seed(vault);
    interruptPublisher(vault, phase);
    unchanged(vault, () => assert.throws(
      () => inspectEmbeddingIndex(vault), diagnostic('index_recovery_required'),
    ));
  });
}

test('committed device identity drift is typed and never accepted or cleaned up', () => {
  const vault = makeVault();
  seed(vault);
  interruptPublisher(vault, 'committed');
  const lock = path.join(directoryOf(vault), 'embeddings.publish.lock');
  const record = JSON.parse(fs.readFileSync(lock, 'utf8').split('\n')[0]);
  assert.equal(record.temporaryIdentity.inode, fs.statSync(databaseOf(vault), { bigint: true }).ino.toString());
  record.temporaryIdentity.device = (BigInt(record.temporaryIdentity.device) + 1n).toString();
  fs.writeFileSync(lock, `${JSON.stringify(record)}\nCOMMITTED\n`);
  for (const open of [inspectEmbeddingIndex, getSharedStorage, value => new EmbeddingStorage(value)]) {
    unchanged(vault, () => assert.throws(() => open(vault), diagnostic('index_recovery_identity_mismatch')));
  }
});

test('active publisher contention is distinct from offline recovery', () => {
  const vault = makeVault();
  seed(vault);
  interruptPublisher(vault, 'prepared');
  const lock = path.join(directoryOf(vault), 'embeddings.publish.lock');
  const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
  record.pid = process.pid;
  fs.writeFileSync(lock, JSON.stringify(record));
  for (const open of [inspectEmbeddingIndex, getSharedStorage]) {
    unchanged(vault, () => assert.throws(() => open(vault), diagnostic('index_publication_in_progress')));
  }
});

test('sidecars are diagnosed before normal-open recovery can clean committed evidence', () => {
  const vault = makeVault();
  seed(vault);
  interruptPublisher(vault, 'committed');
  fs.writeFileSync(`${databaseOf(vault)}-wal`, 'requires offline inspection');
  unchanged(vault, () => assert.throws(
    () => getSharedStorage(vault), diagnostic('index_recovery_required'),
  ));
});

for (const state of ['orphan.tmp', 'orphan.rollback', 'prepared', 'renamed', 'committed', 'active', 'identity-drift', 'malformed']) {
  test(`mixed WAL and ${state} publication evidence has read-only diagnosis parity`, () => {
    const legacy = makeVault();
    legacyWal(legacy);
    const vault = makeVault();
    seed(vault);
    if (state.startsWith('orphan.')) {
      fs.writeFileSync(path.join(directoryOf(vault), `.embeddings.db.${state}`), 'preserved evidence');
    } else {
      const phase = state === 'active' || state === 'malformed' ? 'prepared'
        : state === 'identity-drift' ? 'committed' : state;
      interruptPublisher(vault, phase);
    }
    // Keep the publication's canonical inode while introducing genuine legacy WAL bytes.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.writeFileSync(`${databaseOf(vault)}${suffix}`, fs.readFileSync(`${databaseOf(legacy)}${suffix}`));
    }
    const lock = path.join(directoryOf(vault), 'embeddings.publish.lock');
    if (state === 'active' || state === 'identity-drift') {
      const record = JSON.parse(fs.readFileSync(lock, 'utf8').split('\n')[0]);
      if (state === 'active') record.pid = process.pid;
      else record.temporaryIdentity.device = (BigInt(record.temporaryIdentity.device) + 1n).toString();
      fs.writeFileSync(lock, JSON.stringify(record) + (state === 'active' ? '' : '\nCOMMITTED\n'));
    } else if (state === 'malformed') {
      fs.writeFileSync(lock, 'not json');
    }
    const code = state === 'active' ? 'index_publication_in_progress'
      : state === 'identity-drift' ? 'index_recovery_identity_mismatch' : 'index_recovery_required';
    for (const open of [inspectEmbeddingIndex, getSharedStorage, value => new EmbeddingStorage(value)]) {
      unchanged(vault, () => assert.throws(() => open(vault), diagnostic(code)));
    }
  });
}

test('a sidecar appearing after recovery cleanup cannot claim no mutation', () => {
  const vault = makeVault();
  seed(vault);
  interruptPublisher(vault, 'committed');
  assert.throws(() => new EmbeddingStorage(vault, {
    openDatabase: source => {
      const db = new Database(source);
      fs.writeFileSync(`${databaseOf(vault)}-wal`, 'raced sidecar');
      return db;
    },
  }), diagnostic('index_recovery_required', false));
  assert.equal(fs.existsSync(path.join(directoryOf(vault), 'embeddings.publish.lock')), false);
  assert.equal(fs.readdirSync(directoryOf(vault)).some(name => name.endsWith('.rollback')), false);
});

test('shared opener preserves unknown certainty after its first preparation recovered storage', () => {
  const vault = makeVault();
  seed(vault);
  interruptPublisher(vault, 'committed');
  const vaultStat = fs.statSync(vault, { bigint: true });
  const lock = path.join(directoryOf(vault), 'embeddings.publish.lock');
  const close = fs.closeSync;
  let injected = false;
  mock.method(fs, 'closeSync', descriptor => {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    close(descriptor);
    if (!injected && stat.dev === vaultStat.dev && stat.ino === vaultStat.ino && !fs.existsSync(lock)) {
      injected = true;
      fs.writeFileSync(`${databaseOf(vault)}-wal`, 'raced after first preparation');
    }
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => getSharedStorage(vault), diagnostic('index_recovery_required', false));
    assert.equal(injected, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('WAL sidecars with a missing, malformed, or DELETE-format main are not diagnosed as legacy WAL', () => {
  for (const state of ['missing', 'malformed', 'delete', 'mixed-header']) {
    const vault = makeVault();
    if (state === 'delete' || state === 'mixed-header') {
      seed(vault);
      if (state === 'mixed-header') {
        const content = fs.readFileSync(databaseOf(vault));
        content[18] = 2;
        fs.writeFileSync(databaseOf(vault), content);
      }
    } else {
      fs.mkdirSync(directoryOf(vault));
      if (state === 'malformed') fs.writeFileSync(databaseOf(vault), 'not SQLite');
    }
    fs.writeFileSync(`${databaseOf(vault)}-wal`, 'preserve sidecar');
    const code = state === 'malformed' || state === 'mixed-header'
      ? 'index_storage_unsafe' : 'index_recovery_required';
    for (const open of [inspectEmbeddingIndex, getSharedStorage]) {
      unchanged(vault, () => assert.throws(() => open(vault), diagnostic(code)));
    }
  }
});

test('journal and orphan publication artifacts are not treated as a missing index', () => {
  for (const artifact of ['embeddings.db-journal', '.embeddings.db.orphan.tmp', '.embeddings.db.orphan.rollback']) {
    const vault = makeVault();
    fs.mkdirSync(directoryOf(vault));
    fs.writeFileSync(path.join(directoryOf(vault), artifact), 'preserved evidence');
    unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), diagnostic('index_recovery_required')));
  }
});

test('malformed publication records fail closed without cleanup', () => {
  for (const record of ['not json', 'null', '{}', '[]', '{"version":2}', '{}\nPARTIAL']) {
    const vault = makeVault();
    seed(vault);
    fs.writeFileSync(path.join(directoryOf(vault), 'embeddings.publish.lock'), record);
    unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), diagnostic('index_recovery_required')));
  }
});

test('empty and malformed existing databases are not reported as successful empty indexes', () => {
  for (const content of ['', 'not a database']) {
    const vault = makeVault();
    fs.mkdirSync(directoryOf(vault));
    fs.writeFileSync(databaseOf(vault), content);
    unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), diagnostic('index_storage_unsafe')));
  }
  const vault = makeVault();
  fs.mkdirSync(directoryOf(vault));
  const db = new Database(databaseOf(vault));
  db.exec('CREATE TABLE unrelated (value TEXT)');
  db.close();
  unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), diagnostic('index_storage_unsafe')));
});

test('inspection rejects a symlinked storage directory without touching its target', () => {
  const outside = makeVault();
  const vault = makeVault();
  seed(outside);
  fs.symlinkSync(directoryOf(outside), directoryOf(vault), 'dir');
  unchanged(outside, () => unchanged(vault, () => assert.throws(
    () => inspectEmbeddingIndex(vault), diagnostic('index_storage_unsafe'),
  )));
});

test('inspection refuses non-regular database and publication artifacts without blocking', () => {
  for (const name of ['embeddings.db', 'embeddings.db-wal', 'embeddings.publish.lock']) {
    for (const type of ['directory', 'fifo']) {
      const vault = makeVault();
      fs.mkdirSync(directoryOf(vault));
      const artifact = path.join(directoryOf(vault), name);
      if (type === 'directory') fs.mkdirSync(artifact);
      else {
        const created = spawnSync('mkfifo', [artifact], { encoding: 'utf8' });
        assert.equal(created.status, 0, created.stderr);
      }
      unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), diagnostic('index_storage_unsafe')));
    }
  }
});

for (const [name, reopen] of [['embeddings.db', 0], ['embeddings.publish.lock', 2], ['embeddings.publish.lock', 3]]) {
  test(`inspection closes descriptors after a FIFO swap at ${name} revalidation ${reopen}`, () => {
    const vault = makeVault();
    seed(vault);
    if (name === 'embeddings.publish.lock') interruptPublisher(vault, 'prepared');
    const target = path.join(directoryOf(vault), name);
    const before = fs.readFileSync(target);
    const child = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', '--input-type=module', '--eval', inspectionFifoRaceScript,
      new URL('../dist/embeddings/storage.js', import.meta.url).href, vault, name, String(reopen),
    ], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.ok(fs.lstatSync(target).isFIFO());
    assert.deepEqual(fs.readFileSync(target + '.held'), before);
  });
}

for (const linkType of ['symbolic', 'hard']) {
  test(`inspection rejects ${linkType}-linked database, sidecar, lock, and orphan artifacts`, () => {
    for (const name of ['embeddings.db', 'embeddings.db-wal', 'embeddings.db-shm', 'embeddings.db-journal', 'embeddings.publish.lock', '.embeddings.db.orphan.tmp']) {
      const outside = makeVault();
      const vault = makeVault();
      seed(outside);
      fs.mkdirSync(directoryOf(vault));
      const target = path.join(directoryOf(vault), name);
      if (linkType === 'symbolic') fs.symlinkSync(databaseOf(outside), target);
      else fs.linkSync(databaseOf(outside), target);
      unchanged(outside, () => unchanged(vault, () => assert.throws(
        () => inspectEmbeddingIndex(vault), diagnostic('index_storage_unsafe'),
      )));
    }
  });
}

test('a valid WAL sidecar cannot hide an unsafe SHM hard link', () => {
  const vault = makeVault();
  const outside = makeVault();
  legacyWal(vault);
  fs.unlinkSync(`${databaseOf(vault)}-shm`);
  fs.linkSync(path.join(outside, 'Note.md'), `${databaseOf(vault)}-shm`);
  for (const open of [inspectEmbeddingIndex, getSharedStorage]) {
    unchanged(outside, () => unchanged(vault, () => assert.throws(() => open(vault), diagnostic('index_storage_unsafe'))));
  }
});

test('unexpected SQLite-access faults retain their original exception', () => {
  const vault = makeVault();
  seed(vault);
  const unexpected = new TypeError('unexpected test fault');
  mock.method(Database.prototype, 'prepare', () => { throw unexpected; });
  unchanged(vault, () => assert.throws(() => inspectEmbeddingIndex(vault), error => error === unexpected));
});

test('both pinned descriptors close even when SQLite close throws', () => {
  const vault = makeVault();
  seed(vault);
  const unexpected = new Error('injected SQLite close failure');
  const closeDatabase = Database.prototype.close;
  const closeDescriptor = fs.closeSync;
  let closingDatabase = false;
  const closed = [];
  const identity = stat => [stat.dev, stat.ino];
  const expected = [directoryOf(vault), vault].map(target => identity(fs.statSync(target, { bigint: true })));
  mock.method(Database.prototype, 'close', function () {
    closeDatabase.call(this);
    closingDatabase = true;
    throw unexpected;
  });
  mock.method(fs, 'closeSync', descriptor => {
    if (closingDatabase) closed.push(identity(fs.fstatSync(descriptor, { bigint: true })));
    closeDescriptor(descriptor);
  });
  syncBuiltinESMExports();
  try {
    unchanged(vault, () => {
      try { assert.throws(() => inspectEmbeddingIndex(vault), error => error === unexpected); }
      finally { closingDatabase = false; }
    });
    assert.deepEqual(closed, expected);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('storage error certainty defaults to unknown', () => {
  assert.equal(new EmbeddingStorageError('index_storage_unsafe').noMutation, false);
});
