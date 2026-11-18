import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { EmbeddingStorage, inspectEmbeddingIndex } from '../dist/embeddings/storage.js';
import { cleanup, createTempVault } from './helpers.mjs';

const vaults = [];
const stores = [];
const modelIdentity = 'capacity-test:latest@sha256:deterministic';

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const store of stores.splice(0)) {
    if (!store.isClosed()) store.close();
  }
  for (const vault of vaults.splice(0)) cleanup(vault);
});

test('a symlink-aliased temporary root supports private storage and inspection cleanup', () => {
  const root = fs.realpathSync(createTempVault());
  vaults.push(root);
  const temporaryRoot = path.join(root, 'temporary-root');
  const alias = path.join(root, 'temporary-alias');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(temporaryRoot);
  fs.mkdirSync(vault);
  fs.symlinkSync(temporaryRoot, alias, 'dir');
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import Database from 'better-sqlite3';
    const { EmbeddingStorage, inspectEmbeddingIndex } = await import(process.argv[1]);
    const workingPaths = [];
    const storage = new EmbeddingStorage(process.argv[2], {
      openDatabase: source => {
        assert.equal(source, fs.realpathSync(source));
        assert.equal(path.dirname(path.dirname(source)), fs.realpathSync(os.tmpdir()));
        workingPaths.push(source);
        return new Database(source);
      },
    });
    storage.store('Note.md', [1, 0], 'hash', {}, null, 'evidence');
    assert.equal(inspectEmbeddingIndex(process.argv[2]).stats.uniqueFiles, 1);
    storage.close();
    for (const source of workingPaths) assert.equal(fs.existsSync(path.dirname(source)), false);
    assert.deepEqual(fs.readdirSync(fs.realpathSync(os.tmpdir())), []);
  `;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '--eval', script,
    new URL('../dist/embeddings/storage.js', import.meta.url).href, vault,
  ], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(temporaryRoot), []);
});

test('failed creation of the private database removes its empty directory', () => {
  const vault = fs.realpathSync(createTempVault());
  const temporaryRoot = fs.realpathSync(createTempVault());
  vaults.push(vault, temporaryRoot);
  const seed = new EmbeddingStorage(vault);
  seed.store('Prior.md', [1, 0], 'prior');
  seed.close();
  const canonical = path.join(vault, '.mcp-obsidian', 'embeddings.db');
  const before = fs.readFileSync(canonical);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import { mock } from 'node:test';
    const secure = await import(process.argv[1]);
    const failure = new Error('controlled private file creation failure');
    let injected = false;
    mock.module(process.argv[1], { namedExports: {
      ...secure,
      openFileAt: (directory, name, flags, mode) => {
        if (name === 'embeddings.db' && (flags & fs.constants.O_CREAT)) {
          injected = true;
          throw failure;
        }
        return secure.openFileAt(directory, name, flags, mode);
      },
    }});
    const { EmbeddingStorage } = await import(process.argv[2]);
    assert.throws(() => new EmbeddingStorage(process.argv[3]), error => error === failure);
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(os.tmpdir()), []);
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--input-type=module', '--eval', script,
    new URL('../dist/embeddings/secure-fs.js', import.meta.url).href,
    new URL('../dist/embeddings/storage.js', import.meta.url).href, vault,
  ], {
    env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  assert.deepEqual(fs.readFileSync(canonical), before);
});

test('disk-backed growth, inspection and rollback use bounded snapshot copies', async () => {
  const vault = fs.realpathSync(createTempVault({ 'Prior.md': '# Prior' }));
  vaults.push(vault);
  const canonical = path.join(vault, '.mcp-obsidian', 'embeddings.db');
  const workingPaths = new Set();
  let database;
  const dependencies = {
    openDatabase: source => {
      assert.equal(typeof source, 'string');
      assert.notEqual(source, ':memory:');
      assert.notEqual(source, canonical);
      workingPaths.add(source);
      database = new Database(source);
      database.pragma('cache_size = -256');
      return database;
    },
  };

  mock.method(Database.prototype, 'serialize', () => {
    throw new Error('index-sized serialization is forbidden');
  });
  const readFile = fs.readFileSync;
  mock.method(fs, 'readFileSync', (source, ...args) => {
    if (typeof source === 'number') {
      const opened = fs.fstatSync(source);
      assert.ok(!opened.isFile() || opened.size <= 1024 * 1024, 'whole large-file read is forbidden');
    } else {
      assert.ok(source !== canonical && !workingPaths.has(source), 'whole database read is forbidden');
    }
    return readFile(source, ...args);
  });
  syncBuiltinESMExports();

  const storage = new EmbeddingStorage(vault, dependencies);
  stores.push(storage);
  await storage.runBatch(async () => {
    database.exec('CREATE TABLE capacity_padding(payload BLOB)');
    const insert = database.prepare('INSERT INTO capacity_padding VALUES (zeroblob(?))');
    database.transaction(() => {
      for (let index = 0; index < 8; index += 1) insert.run(1024 * 1024);
    })();
    storage.store('Prior.md', [1, 0], 'prior', { modelIdentity }, null, 'prior evidence');
  });
  assert.ok(fs.statSync(canonical).size > 8 * 1024 * 1024);
  const expectedStats = storage.getStats();
  const expectedSearch = storage.search([1, 0], 10, 0.5);
  const expectedKeywords = storage.keywordSearch('evidence');
  assert.deepEqual(inspectEmbeddingIndex(vault).stats, expectedStats);

  await assert.rejects(storage.runBatch(async () => {
    storage.store('Rejected.md', [0, 1], 'rejected', { modelIdentity }, null, 'rejected evidence');
    storage.delete('Prior.md');
    throw new Error('injected failed batch');
  }), /injected failed batch/);
  assert.equal(storage.get('Rejected.md'), null);
  assert.deepEqual(storage.search([1, 0], 10, 0.5), expectedSearch);
  assert.deepEqual(storage.keywordSearch('evidence'), expectedKeywords);
  storage.close();

  const reopened = new EmbeddingStorage(vault, dependencies);
  stores.push(reopened);
  assert.deepEqual(reopened.getStats(), expectedStats);
  assert.deepEqual(reopened.search([1, 0], 10, 0.5), expectedSearch);
  assert.deepEqual(reopened.keywordSearch('evidence'), expectedKeywords);
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM capacity_padding').get().count, 8);
  reopened.store('Later.md', [0, 1], 'later', { modelIdentity }, null, 'later evidence');
  assert.equal(reopened.get('Rejected.md'), null);
  reopened.close();

  const final = new EmbeddingStorage(vault, dependencies);
  stores.push(final);
  assert.equal(final.getContent('Prior.md'), 'prior evidence');
  assert.equal(final.getContent('Later.md'), 'later evidence');
  assert.equal(final.get('Rejected.md'), null);
  final.close();
  for (const workingPath of workingPaths) {
    assert.equal(fs.existsSync(workingPath), false);
    assert.equal(fs.existsSync(path.dirname(workingPath)), false);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(canonical)), ['embeddings.db']);
});
