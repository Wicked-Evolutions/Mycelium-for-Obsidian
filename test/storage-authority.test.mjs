import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  EmbeddingStorage,
  getSharedStorage,
} from '../dist/embeddings/storage.js';
import { pinVaultRootSync } from '../dist/embeddings/vault-root.js';
import { cleanup, createTempVault } from './helpers.mjs';

const pathsToClean = [];

afterEach(() => {
  for (const targetPath of pathsToClean.splice(0)) cleanup(targetPath);
});

function makeVault(files) {
  const vault = createTempVault(files);
  pathsToClean.push(vault);
  return vault;
}

const abruptPublisherScript = String.raw`
  const { EmbeddingStorage } = await import(process.argv[1]);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const phase = process.argv[3];
  const dependencies = phase === 'before-rename'
    ? { afterRollbackPinned: () => process.exit(77) }
    : phase === 'after-rename-before-commit'
      ? { afterSnapshotRename: () => process.exit(78) }
      : phase === 'after-commit'
        ? { afterCommitMarker: () => process.exit(79) }
        : {
            afterSnapshotRename: () => {
              const directory = path.join(process.argv[2], '.mcp-obsidian');
              const rollback = fs.readdirSync(directory).find(name => name.endsWith('.rollback'));
              if (!rollback) throw new Error('rollback fixture is missing');
              fs.unlinkSync(path.join(directory, rollback));
              process.exit(80);
            },
          };
  const storage = new EmbeddingStorage(process.argv[2], dependencies);
  storage.store(
    'Published.md',
    [0, 1],
    'published-hash',
    { modelIdentity: 'model:latest@sha256:published' },
    null,
    'published generation'
  );
  process.exit(99);
`;

function runAbruptPublisher(vault, phase) {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    abruptPublisherScript,
    new URL('../dist/embeddings/storage.js', import.meta.url).href,
    vault,
    phase,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('storage rejects a symlinked storage directory before touching its target', (t) => {
  const outside = makeVault({ 'sentinel.txt': 'unchanged' });
  const vault = makeVault({ 'Note.md': '# Note' });
  try {
    fs.symlinkSync(outside, path.join(vault, '.mcp-obsidian'), 'dir');
  } catch {
    t.skip('filesystem does not support directory symlink fixtures');
    return;
  }

  assert.throws(
    () => getSharedStorage(pinVaultRootSync(vault)),
    /storage directory.*symbolic link/i,
  );
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(outside, 'embeddings.db')), false);
});

test('storage rejects a symlinked database before SQLite can modify its target', (t) => {
  const outside = makeVault({ 'outside.db': 'external sentinel bytes' });
  const vault = makeVault({ 'Note.md': '# Note' });
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  fs.mkdirSync(storageDirectory);
  const outsideDatabase = path.join(outside, 'outside.db');
  try {
    fs.symlinkSync(outsideDatabase, path.join(storageDirectory, 'embeddings.db'));
  } catch {
    t.skip('filesystem does not support file symlink fixtures');
    return;
  }

  assert.throws(
    () => getSharedStorage(pinVaultRootSync(vault)),
    /storage file.*symbolic link/i,
  );
  assert.equal(fs.readFileSync(outsideDatabase, 'utf8'), 'external sentinel bytes');
});

test('storage rejects symlinked SQLite sidecars before touching their targets', (t) => {
  const outside = makeVault({ 'outside.wal': 'external WAL sentinel' });
  const vault = makeVault({ 'Note.md': '# Note' });
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  fs.mkdirSync(storageDirectory);
  const outsideWal = path.join(outside, 'outside.wal');
  try {
    fs.symlinkSync(outsideWal, path.join(storageDirectory, 'embeddings.db-wal'));
  } catch {
    t.skip('filesystem does not support file symlink fixtures');
    return;
  }

  assert.throws(
    () => getSharedStorage(pinVaultRootSync(vault)),
    /SQLite sidecars.*symbolic links/i,
  );
  assert.equal(fs.readFileSync(outsideWal, 'utf8'), 'external WAL sentinel');
  assert.equal(fs.existsSync(path.join(storageDirectory, 'embeddings.db')), false);
});

test('a symlink swapped at the database-read boundary cannot redirect the snapshot', (t) => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const databasePath = path.join(vault, '.mcp-obsidian', 'embeddings.db');
  const heldDatabase = path.join(vault, '.mcp-obsidian', 'held.db');
  const externalTarget = path.join(outside, 'created-by-race.db');
  let fixtureReady = false;

  try {
    assert.throws(() => new EmbeddingStorage(pinVaultRootSync(vault), {
      openDatabaseFile: (candidate, flags) => {
        assert.equal(candidate, fs.realpathSync(path.dirname(databasePath)) + '/embeddings.db');
        fs.renameSync(candidate, heldDatabase);
        try {
          fs.symlinkSync(externalTarget, candidate);
        } catch (error) {
          fs.renameSync(heldDatabase, candidate);
          throw error;
        }
        fixtureReady = true;
        try {
          return fs.openSync(candidate, flags);
        } finally {
          fs.unlinkSync(candidate);
          fs.renameSync(heldDatabase, candidate);
        }
      },
    }), /symbolic link|ELOOP|opened embedding database/i);
  } catch (error) {
    if (!fixtureReady) {
      t.skip('filesystem does not support the symlink swap fixture');
      return;
    }
    throw error;
  }

  assert.equal(fs.existsSync(externalTarget), false);
});

test('a swap-back race cannot feed SQLite an existing external database snapshot', (t) => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const externalTarget = path.join(outside, 'external.db');
  const external = new Database(externalTarget);
  external.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  external.close();
  const before = fs.readFileSync(externalTarget);
  const databasePath = path.join(vault, '.mcp-obsidian', 'embeddings.db');
  const heldDatabase = path.join(vault, '.mcp-obsidian', 'held.db');
  let fixtureReady = false;

  try {
    assert.throws(() => new EmbeddingStorage(pinVaultRootSync(vault), {
      openDatabaseFile: (candidate) => {
        fs.renameSync(candidate, heldDatabase);
        try {
          fs.symlinkSync(externalTarget, candidate);
        } catch (error) {
          fs.renameSync(heldDatabase, candidate);
          throw error;
        }
        fixtureReady = true;
        const opened = fs.openSync(candidate, fs.constants.O_RDONLY);
        fs.unlinkSync(candidate);
        fs.renameSync(heldDatabase, candidate);
        return opened;
      },
    }), /does not match the pinned file identity/i);
  } catch (error) {
    if (!fixtureReady) {
      t.skip('filesystem does not support the swap-back fixture');
      return;
    }
    throw error;
  }

  assert.deepEqual(fs.readFileSync(externalTarget), before);
  const verify = new Database(externalTarget, { readonly: true });
  try {
    assert.deepEqual(verify.prepare('SELECT value FROM sentinel').all(), [{ value: 'unchanged' }]);
    assert.deepEqual(
      verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all(),
      ['sentinel'],
    );
  } finally {
    verify.close();
  }
});

test('rollback copying cannot attach an outside inode when the canonical path is swapped', () => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const databasePath = path.join(storageDirectory, 'embeddings.db');
  const heldDatabase = path.join(storageDirectory, 'held.db');
  const externalPath = path.join(outside, 'external.db');

  const external = new Database(externalPath);
  external.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  external.close();

  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  let swapped = false;
  let outsideAfterSwap;
  const storage = new EmbeddingStorage(root, {
    beforeRollbackSnapshotCopy: () => {
      if (swapped) return;
      fs.renameSync(databasePath, heldDatabase);
      try {
        fs.linkSync(externalPath, databasePath);
      } catch (error) {
        fs.renameSync(heldDatabase, databasePath);
        throw error;
      }
      swapped = true;
      const stat = fs.lstatSync(externalPath);
      outsideAfterSwap = {
        bytes: fs.readFileSync(externalPath),
        inode: stat.ino,
        links: stat.nlink,
      };
    },
  });

  assert.throws(
    () => storage.store('Legit.md', [0, 1], 'legit-hash', {}, null, 'legit generation'),
    /database with private rollback snapshot.*physical identity/i,
  );

  assert.equal(swapped, true);
  const outsideAfterFailure = fs.lstatSync(externalPath);
  assert.deepEqual(fs.readFileSync(externalPath), outsideAfterSwap.bytes);
  assert.equal(outsideAfterFailure.ino, outsideAfterSwap.inode);
  assert.equal(outsideAfterFailure.nlink, outsideAfterSwap.links);
  assert.equal(outsideAfterFailure.nlink, 2);
  assert.deepEqual(fs.readdirSync(storageDirectory).sort(), [
    'embeddings.db',
    'held.db',
  ]);

  fs.unlinkSync(databasePath);
  fs.renameSync(heldDatabase, databasePath);
  const restoredExternal = fs.lstatSync(externalPath);
  assert.equal(restoredExternal.nlink, 1);
  assert.deepEqual(fs.readFileSync(externalPath), outsideAfterSwap.bytes);
  storage.close();
});

test('post-check hard links for every SQLite sidecar remain byte-identical', (t) => {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const outside = makeVault({ 'external.sidecar': 'external sentinel bytes' });
    const vault = makeVault({ 'Note.md': '# Note' });
    const databasePath = path.join(vault, '.mcp-obsidian', 'embeddings.db');
    const externalSidecar = path.join(outside, 'external.sidecar');
    const before = fs.readFileSync(externalSidecar);
    let fixtureReady = false;

    try {
      assert.throws(() => new EmbeddingStorage(pinVaultRootSync(vault), {
        openDatabase: (source) => {
          const opened = new Database(source);
          const pragma = opened.pragma.bind(opened);
          opened.pragma = (...args) => {
            if (!fixtureReady) {
              fs.linkSync(externalSidecar, `${databasePath}${suffix}`);
              fixtureReady = true;
            }
            return pragma(...args);
          };
          return opened;
        },
      }), /SQLite sidecar has an invalid physical identity/i);
    } catch (error) {
      if (!fixtureReady) {
        t.skip('filesystem does not support the hard-link race fixture');
        return;
      }
      throw error;
    }

    assert.deepEqual(fs.readFileSync(externalSidecar), before, suffix);
  }
});

test('legacy outstanding WAL state cannot redirect recovery through a raced SHM hard link', (t) => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const databasePath = path.join(storageDirectory, 'embeddings.db');
  fs.mkdirSync(storageDirectory);

  const legacy = new Database(databasePath);
  legacy.pragma('journal_mode = WAL');
  legacy.pragma('wal_autocheckpoint = 0');
  legacy.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'checkpointed\')');
  legacy.pragma('wal_checkpoint(TRUNCATE)');
  legacy.exec('INSERT INTO sentinel VALUES (\'outstanding\')');
  const mainSnapshot = fs.readFileSync(databasePath);
  const walSnapshot = fs.readFileSync(`${databasePath}-wal`);
  const shmSnapshot = fs.readFileSync(`${databasePath}-shm`);
  legacy.close();
  fs.writeFileSync(databasePath, mainSnapshot);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${databasePath}${suffix}`)) fs.unlinkSync(`${databasePath}${suffix}`);
  }

  const externalShm = path.join(outside, 'external.shm');
  fs.writeFileSync(externalShm, shmSnapshot);
  const beforeExternal = fs.readFileSync(externalShm);
  let fixtureReady = false;

  try {
    assert.throws(() => new EmbeddingStorage(pinVaultRootSync(vault), {
      openDatabase: (source) => {
        const opened = new Database(source);
        const pragma = opened.pragma.bind(opened);
        opened.pragma = (...args) => {
          if (!fixtureReady) {
            fs.writeFileSync(`${databasePath}-wal`, walSnapshot);
            fs.linkSync(externalShm, `${databasePath}-shm`);
            fixtureReady = true;
          }
          return pragma(...args);
        };
        return opened;
      },
    }), /live or stale SQLite sidecar|invalid physical identity/i);
  } catch (error) {
    if (!fixtureReady) {
      t.skip('filesystem does not support the legacy WAL race fixture');
      return;
    }
    throw error;
  }

  assert.deepEqual(fs.readFileSync(externalShm), beforeExternal);
  assert.deepEqual(fs.readFileSync(databasePath), mainSnapshot);
});

test('SQLite receives only a private memory snapshot and persists it atomically', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const openedSources = [];
  const openDatabase = (source) => {
    openedSources.push(Buffer.isBuffer(source) ? 'buffer' : source);
    return new Database(source);
  };

  const storage = new EmbeddingStorage(root, { openDatabase });
  storage.store('Note.md', [1, 0], 'hash', {}, null, 'persisted content');
  storage.close();

  const reopened = new EmbeddingStorage(root, { openDatabase });
  try {
    assert.equal(reopened.getContent('Note.md'), 'persisted content');
    assert.deepEqual(openedSources, [':memory:', 'buffer']);
    assert.deepEqual(
      fs.readdirSync(path.join(vault, '.mcp-obsidian')).sort(),
      ['embeddings.db'],
    );
  } finally {
    reopened.close();
  }
});

test('batched indexing publishes one snapshot only at its owned boundary', async () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storage = new EmbeddingStorage(root);
  let releaseBatch;
  let signalBatchStarted;
  const batchStarted = new Promise(resolve => { signalBatchStarted = resolve; });
  const holdBatch = new Promise(resolve => { releaseBatch = resolve; });

  try {
    const batch = storage.runBatch(async () => {
      storage.store('Note.md', [1, 0], 'hash', {}, null, 'batched content');
      signalBatchStarted();
      await holdBatch;
    });
    await batchStarted;

    const beforeCommit = new EmbeddingStorage(root);
    try {
      assert.equal(beforeCommit.get('Note.md'), null);
    } finally {
      beforeCommit.close();
    }

    assert.throws(
      () => storage.store('Outsider.md', [0, 1], 'outside-batch'),
      /blocked by another active batch/i,
    );
    assert.equal(storage.get('Outsider.md'), null);

    releaseBatch();
    await batch;
    const afterCommit = new EmbeddingStorage(root);
    try {
      assert.equal(afterCommit.getContent('Note.md'), 'batched content');
      assert.equal(afterCommit.get('Outsider.md'), null);
    } finally {
      afterCommit.close();
    }
  } finally {
    storage.close();
  }
});

test('failed publications restore memory and cannot become durable later', async (t) => {
  const scenarios = [
    {
      name: 'store',
      mutate: storage => storage.store(
        'Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected content',
      ),
      assertRestored: storage => assert.equal(storage.get('Rejected.md'), null),
    },
    {
      name: 'delete',
      mutate: storage => storage.delete('Prior.md'),
      assertRestored: storage => assert.equal(
        storage.getContent('Prior.md'), 'prior content',
      ),
    },
    {
      name: 'clear',
      mutate: storage => storage.clear(),
      assertRestored: storage => {
        assert.equal(storage.getContent('Prior.md'), 'prior content');
        assert.equal(storage.getContent('Keep.md'), 'keep content');
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const vault = makeVault({ 'Note.md': '# Note' });
      const root = pinVaultRootSync(vault);
      const seed = new EmbeddingStorage(root);
      seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior content');
      seed.store('Keep.md', [1, 1], 'keep-hash', {}, null, 'keep content');
      seed.close();

      let rejectNextPublication = true;
      const storage = new EmbeddingStorage(root, {
        afterSnapshotRename: () => {
          if (!rejectNextPublication) return;
          rejectNextPublication = false;
          throw new Error('injected publication failure');
        },
      });

      assert.throws(() => scenario.mutate(storage), /injected publication failure/);
      scenario.assertRestored(storage);
      storage.store('Later.md', [0, 1], 'later-hash', {}, null, 'later content');
      scenario.assertRestored(storage);
      storage.close();

      const reopened = new EmbeddingStorage(root);
      try {
        scenario.assertRestored(reopened);
        assert.equal(reopened.getContent('Later.md'), 'later content');
      } finally {
        reopened.close();
      }
    });
  }
});

test('pre-journal serialization failures restore every mutation shape', async (t) => {
  const scenarios = [
    {
      name: 'store',
      mutate: storage => storage.store(
        'Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected content',
      ),
      assertRestored: storage => assert.equal(storage.get('Rejected.md'), null),
    },
    {
      name: 'delete',
      mutate: storage => storage.delete('Prior.md'),
      assertRestored: storage => assert.equal(
        storage.getContent('Prior.md'), 'prior content',
      ),
    },
    {
      name: 'clear',
      mutate: storage => storage.clear(),
      assertRestored: storage => {
        assert.equal(storage.getContent('Prior.md'), 'prior content');
        assert.equal(storage.getContent('Keep.md'), 'keep content');
      },
    },
    {
      name: 'successful batch task',
      async: true,
      mutate: storage => storage.runBatch(async () => {
        storage.store(
          'Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected content',
        );
        storage.delete('Prior.md');
      }),
      assertRestored: storage => {
        assert.equal(storage.get('Rejected.md'), null);
        assert.equal(storage.getContent('Prior.md'), 'prior content');
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const vault = makeVault({ 'Note.md': '# Note' });
      const root = pinVaultRootSync(vault);
      const seed = new EmbeddingStorage(root);
      seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior content');
      seed.store('Keep.md', [1, 1], 'keep-hash', {}, null, 'keep content');
      seed.close();

      let rejectNextSerialization = true;
      const storage = new EmbeddingStorage(root, {
        serializeDatabase: database => {
          if (rejectNextSerialization) {
            rejectNextSerialization = false;
            throw new Error('injected pre-journal serialization failure');
          }
          return database.serialize();
        },
      });

      if (scenario.async) {
        await assert.rejects(
          scenario.mutate(storage),
          /injected pre-journal serialization failure/,
        );
      } else {
        assert.throws(
          () => scenario.mutate(storage),
          /injected pre-journal serialization failure/,
        );
      }
      scenario.assertRestored(storage);

      storage.store('Later.md', [0, 1], 'later-hash', {}, null, 'later content');
      scenario.assertRestored(storage);
      storage.close();

      const reopened = new EmbeddingStorage(root);
      try {
        scenario.assertRestored(reopened);
        assert.equal(reopened.getContent('Later.md'), 'later content');
      } finally {
        reopened.close();
      }
    });
  }
});

test('pre-journal authority loss closes and unbinds the stale shared connection', async () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const stale = getSharedStorage(root);
  const winner = new EmbeddingStorage(root);
  let fresh;
  try {
    await assert.rejects(
      stale.runBatch(async () => {
        stale.store('Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected');
        winner.store('Winner.md', [1, 1], 'winner-hash', {}, null, 'winner');
      }),
      /physical identity changed during use/i,
    );
    assert.equal(stale.isClosed(), true);
    assert.throws(() => stale.get('Rejected.md'), /closed/i);

    winner.close();
    fresh = getSharedStorage(pinVaultRootSync(vault));
    assert.notEqual(fresh, stale);
    assert.equal(fresh.get('Rejected.md'), null);
    assert.equal(fresh.getContent('Prior.md'), 'prior generation');
    assert.equal(fresh.getContent('Winner.md'), 'winner');
  } finally {
    if (!stale.isClosed()) stale.close();
    if (!winner.isClosed()) winner.close();
    if (fresh && !fresh.isClosed()) fresh.close();
  }
});

test('a removed publication lock cannot make a rejected snapshot durable', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  let removeLock = true;
  const storage = new EmbeddingStorage(root, {
    afterSnapshotRename: () => {
      if (!removeLock) return;
      removeLock = false;
      fs.unlinkSync(path.join(storageDirectory, 'embeddings.publish.lock'));
    },
  });

  assert.throws(() => storage.store(
    'Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected generation',
  ));
  assert.equal(storage.getContent('Prior.md'), 'prior generation');
  assert.equal(storage.get('Rejected.md'), null);

  storage.store('Later.md', [1, 1], 'later-hash', {}, null, 'later generation');
  storage.close();

  const reopened = new EmbeddingStorage(root);
  try {
    assert.equal(reopened.getContent('Prior.md'), 'prior generation');
    assert.equal(reopened.get('Rejected.md'), null);
    assert.equal(reopened.getContent('Later.md'), 'later generation');
  } finally {
    reopened.close();
  }
  assert.deepEqual(fs.readdirSync(storageDirectory).sort(), ['embeddings.db']);
});

test('a post-commit failure reports success and requires a clean reopen', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const seed = new EmbeddingStorage(root);
  seed.close();
  const storage = new EmbeddingStorage(root, {
    afterCommitMarker: () => {
      throw new Error('injected post-commit failure');
    },
  });

  assert.doesNotThrow(() => storage.store(
    'Committed.md', [1, 0], 'committed-hash', {}, null, 'committed generation',
  ));
  assert.throws(() => storage.get('Committed.md'), /closed/i);

  const reopened = new EmbeddingStorage(root);
  try {
    assert.equal(reopened.getContent('Committed.md'), 'committed generation');
  } finally {
    reopened.close();
  }
});

test('failed and rejected batches restore their unpublished mutations', async () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior content');
  seed.close();

  let rejectNextPublication = true;
  const storage = new EmbeddingStorage(root, {
    afterSnapshotRename: () => {
      if (!rejectNextPublication) return;
      rejectNextPublication = false;
      throw new Error('injected batch publication failure');
    },
  });

  await assert.rejects(
    storage.runBatch(async () => {
      storage.store('Rejected.md', [0, 1], 'rejected-hash', {}, null, 'rejected content');
      storage.delete('Prior.md');
    }),
    /injected batch publication failure/,
  );
  assert.equal(storage.get('Rejected.md'), null);
  assert.equal(storage.getContent('Prior.md'), 'prior content');

  await assert.rejects(
    storage.runBatch(async () => {
      storage.clear();
      throw new Error('injected batch task failure');
    }),
    /injected batch task failure/,
  );
  assert.equal(storage.getContent('Prior.md'), 'prior content');

  storage.store('Later.md', [1, 1], 'later-hash', {}, null, 'later content');
  storage.close();

  const reopened = new EmbeddingStorage(root);
  try {
    assert.equal(reopened.get('Rejected.md'), null);
    assert.equal(reopened.getContent('Prior.md'), 'prior content');
    assert.equal(reopened.getContent('Later.md'), 'later content');
  } finally {
    reopened.close();
  }
});

test('competing snapshot publishers cannot both report a successful generation', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const seed = new EmbeddingStorage(root);
  seed.close();

  let publisherB;
  let publisherBError;
  let hookCalled = false;
  const publisherA = new EmbeddingStorage(root, {
    afterPublishLockAcquired: () => {
      if (hookCalled) return;
      hookCalled = true;
      try {
        publisherB.store('Publisher-B.md', [0, 1], 'b-hash', {}, null, 'publisher B');
      } catch (error) {
        publisherBError = error;
      }
    },
  });
  publisherB = new EmbeddingStorage(root);

  try {
    publisherA.store('Publisher-A.md', [1, 0], 'a-hash', {}, null, 'publisher A');
    assert.match(String(publisherBError), /publication is already in progress/i);
    publisherB.close();
    publisherA.close();

    const reopened = new EmbeddingStorage(root);
    try {
      assert.equal(reopened.getContent('Publisher-A.md'), 'publisher A');
      assert.equal(reopened.get('Publisher-B.md'), null);
    } finally {
      reopened.close();
    }
    assert.deepEqual(
      fs.readdirSync(path.join(vault, '.mcp-obsidian')).sort(),
      ['embeddings.db'],
    );
  } finally {
    if (!publisherA.isClosed()) publisherA.close();
    if (!publisherB.isClosed()) {
      try { publisherB.close(); } catch { /* stale publisher remains fail-closed */ }
    }
  }
});

test('temporary snapshot substitution is detected and the prior generation is restored', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const attackerVault = makeVault({ 'Injected.md': '# Injected' });
  const root = pinVaultRootSync(vault);
  const attackerRoot = pinVaultRootSync(attackerVault);

  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const attacker = new EmbeddingStorage(attackerRoot);
  attacker.store('Injected.md', [0, 1], 'injected-hash', {}, null, 'injected generation');
  attacker.close();
  const attackerSnapshot = fs.readFileSync(
    path.join(attackerVault, '.mcp-obsidian', 'embeddings.db')
  );

  const storage = new EmbeddingStorage(root, {
    beforeSnapshotRename: temporaryPath => {
      fs.unlinkSync(temporaryPath);
      fs.writeFileSync(temporaryPath, attackerSnapshot, { flag: 'wx', mode: 0o600 });
    },
  });

  assert.throws(
    () => storage.store('Legit.md', [1, 1], 'legit-hash', {}, null, 'legit generation'),
    /temporary file lost its verified physical identity/i,
  );
  storage.close();

  const databasePath = path.join(vault, '.mcp-obsidian', 'embeddings.db');
  const reopened = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      reopened.prepare('SELECT content FROM content_fts WHERE file_path = ?').pluck().all('Prior.md'),
      ['prior generation'],
    );
    assert.deepEqual(
      reopened.prepare('SELECT file_path FROM embeddings ORDER BY file_path').pluck().all(),
      ['Prior.md'],
    );
  } finally {
    reopened.close();
  }
  const retainedArtifacts = fs.readdirSync(path.join(vault, '.mcp-obsidian')).sort();
  assert.ok(retainedArtifacts.includes('embeddings.db'));
  assert.ok(retainedArtifacts.includes('embeddings.publish.lock'));
  assert.ok(retainedArtifacts.some(name => name.endsWith('.tmp')));
  assert.equal(retainedArtifacts.some(name => name.endsWith('.rollback')), false);
});

test('a storage-directory swap cannot redirect snapshot publication into an external directory', () => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const movedStorage = path.join(vault, '.mcp-obsidian-pinned');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  let swapped = false;
  let outsideBefore = new Map();
  const storage = new EmbeddingStorage(root, {
    beforeSnapshotRename: temporaryPath => {
      if (swapped) return;
      swapped = true;
      const temporaryName = path.basename(temporaryPath);
      const rollbackName = temporaryName.replace(/\.tmp$/, '.rollback');
      for (const name of [
        'embeddings.db',
        'embeddings.publish.lock',
        temporaryName,
        rollbackName,
      ]) {
        fs.writeFileSync(path.join(outside, name), `external:${name}`, { mode: 0o600 });
      }
      outsideBefore = new Map(fs.readdirSync(outside).map(name => {
        const targetPath = path.join(outside, name);
        const stat = fs.lstatSync(targetPath);
        return [name, { bytes: fs.readFileSync(targetPath), inode: stat.ino, links: stat.nlink }];
      }));
      fs.renameSync(storageDirectory, movedStorage);
      fs.symlinkSync(outside, storageDirectory, 'dir');
    },
  });

  try {
    assert.throws(
      () => storage.store('Legit.md', [0, 1], 'legit-hash', {}, null, 'legit generation'),
      /storage directory.*symbolic link|physical identity/i,
    );
    assert.equal(swapped, true);
    assert.deepEqual(fs.readdirSync(movedStorage).sort(), ['embeddings.db']);
    for (const [name, before] of outsideBefore) {
      const targetPath = path.join(outside, name);
      const after = fs.lstatSync(targetPath);
      assert.deepEqual(fs.readFileSync(targetPath), before.bytes, name);
      assert.equal(after.ino, before.inode, name);
      assert.equal(after.nlink, before.links, name);
    }
  } finally {
    if (fs.lstatSync(storageDirectory).isSymbolicLink()) fs.unlinkSync(storageDirectory);
    if (fs.existsSync(movedStorage)) fs.renameSync(movedStorage, storageDirectory);
  }

  const reopened = new EmbeddingStorage(root);
  try {
    assert.equal(reopened.getContent('Prior.md'), 'prior generation');
    assert.equal(reopened.get('Legit.md'), null);
  } finally {
    reopened.close();
  }
  storage.close();

  for (const [name, before] of outsideBefore) {
    const targetPath = path.join(outside, name);
    const after = fs.lstatSync(targetPath);
    assert.deepEqual(fs.readFileSync(targetPath), before.bytes, name);
    assert.equal(after.ino, before.inode, name);
    assert.equal(after.nlink, before.links, name);
  }
});

test('startup recovers an abrupt publisher exit before the snapshot rename', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const child = runAbruptPublisher(vault, 'before-rename');
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 77, child.stderr);
  const interruptedArtifacts = fs.readdirSync(storageDirectory);
  assert.ok(interruptedArtifacts.includes('embeddings.publish.lock'));
  assert.ok(interruptedArtifacts.some(name => name.endsWith('.rollback')));
  assert.ok(interruptedArtifacts.some(name => name.endsWith('.tmp')));

  const recovered = new EmbeddingStorage(root);
  try {
    assert.equal(recovered.getContent('Prior.md'), 'prior generation');
    assert.equal(recovered.get('Published.md'), null);
  } finally {
    recovered.close();
  }
  assert.deepEqual(fs.readdirSync(storageDirectory).sort(), ['embeddings.db']);
  assert.equal(fs.lstatSync(path.join(storageDirectory, 'embeddings.db')).nlink, 1);
});

test('startup restores the prior snapshot after an abrupt pre-commit exit', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const child = runAbruptPublisher(vault, 'after-rename-before-commit');
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 78, child.stderr);
  const interruptedArtifacts = fs.readdirSync(storageDirectory);
  assert.ok(interruptedArtifacts.includes('embeddings.publish.lock'));
  assert.ok(interruptedArtifacts.some(name => name.endsWith('.rollback')));
  assert.equal(interruptedArtifacts.some(name => name.endsWith('.tmp')), false);

  const recovered = new EmbeddingStorage(root);
  try {
    assert.equal(recovered.getContent('Prior.md'), 'prior generation');
    assert.equal(recovered.get('Published.md'), null);
  } finally {
    recovered.close();
  }
  assert.deepEqual(fs.readdirSync(storageDirectory).sort(), ['embeddings.db']);
  assert.equal(fs.lstatSync(path.join(storageDirectory, 'embeddings.db')).nlink, 1);
});

test('startup preserves the new snapshot after an abrupt post-commit exit', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const child = runAbruptPublisher(vault, 'after-commit');
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 79, child.stderr);
  const interruptedArtifacts = fs.readdirSync(storageDirectory);
  assert.ok(interruptedArtifacts.includes('embeddings.publish.lock'));
  assert.ok(interruptedArtifacts.some(name => name.endsWith('.rollback')));
  assert.equal(interruptedArtifacts.some(name => name.endsWith('.tmp')), false);

  const recovered = new EmbeddingStorage(root);
  try {
    assert.equal(recovered.getContent('Prior.md'), 'prior generation');
    assert.equal(recovered.getContent('Published.md'), 'published generation');
  } finally {
    recovered.close();
  }
  assert.deepEqual(fs.readdirSync(storageDirectory).sort(), ['embeddings.db']);
  assert.equal(fs.lstatSync(path.join(storageDirectory, 'embeddings.db')).nlink, 1);
});

test('startup fails closed when an interrupted prepared publication loses rollback', () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const root = pinVaultRootSync(vault);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  const seed = new EmbeddingStorage(root);
  seed.store('Prior.md', [1, 0], 'prior-hash', {}, null, 'prior generation');
  seed.close();

  const child = runAbruptPublisher(vault, 'after-rename-without-rollback');
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 80, child.stderr);
  const interruptedArtifacts = fs.readdirSync(storageDirectory);
  assert.ok(interruptedArtifacts.includes('embeddings.publish.lock'));
  assert.equal(interruptedArtifacts.some(name => name.endsWith('.rollback')), false);
  assert.equal(interruptedArtifacts.some(name => name.endsWith('.tmp')), false);

  assert.throws(
    () => new EmbeddingStorage(root),
    /cannot restore its missing rollback snapshot/i,
  );
});

test('storage rejects a hard-linked database without modifying the other name', () => {
  const outside = makeVault();
  const vault = makeVault({ 'Note.md': '# Note' });
  const outsideDatabase = path.join(outside, 'external.db');
  const external = new Database(outsideDatabase);
  external.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  external.close();
  const before = fs.readFileSync(outsideDatabase);
  const storageDirectory = path.join(vault, '.mcp-obsidian');
  fs.mkdirSync(storageDirectory);
  fs.linkSync(outsideDatabase, path.join(storageDirectory, 'embeddings.db'));

  assert.throws(
    () => getSharedStorage(pinVaultRootSync(vault)),
    /exactly one hard link/i,
  );
  assert.deepEqual(fs.readFileSync(outsideDatabase), before);

  const verify = new Database(outsideDatabase, { readonly: true });
  try {
    assert.deepEqual(verify.prepare('SELECT value FROM sentinel').all(), [{ value: 'unchanged' }]);
    assert.deepEqual(
      verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all(),
      ['sentinel'],
    );
  } finally {
    verify.close();
  }
});

test('same-path vault replacement receives a new store and invalidates old reads and writes', () => {
  const vault = makeVault({ 'Note.md': '# Generation A' });
  const movedVault = `${vault}-generation-a`;
  pathsToClean.push(movedVault);
  const rootA = pinVaultRootSync(vault);
  const storageA = getSharedStorage(rootA);
  storageA.store(
    'Note.md', [1, 0], 'a-hash',
    { modelIdentity: 'model:latest@sha256:a' }, null, 'generation A',
  );

  fs.renameSync(vault, movedVault);
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Generation B', 'utf8');
  const rootB = pinVaultRootSync(vault);
  const storageB = getSharedStorage(rootB);

  try {
    assert.notEqual(storageB, storageA);
    assert.equal(storageB.get('Note.md'), null);
    storageB.store(
      'Note.md', [0, 1], 'b-hash',
      { modelIdentity: 'model:latest@sha256:b' }, null, 'generation B',
    );
    assert.equal(storageB.getContent('Note.md'), 'generation B');
    assert.throws(() => storageA.get('Note.md'), /pinned vault root identity changed/i);
    assert.throws(
      () => storageA.store('Injected.md', [1, 1], 'bad-hash'),
      /pinned vault root identity changed/i,
    );
  } finally {
    storageA.close();
    storageB.close();
  }

  const movedStorage = getSharedStorage(pinVaultRootSync(movedVault));
  try {
    assert.equal(movedStorage.getContent('Note.md'), 'generation A');
    assert.equal(movedStorage.get('Injected.md'), null);
  } finally {
    movedStorage.close();
  }
});

test('compatible retrieval excludes stale model and wrong-dimension rows', () => {
  const vault = makeVault({
    'Current.md': '# Current',
    'Stale.md': '# Stale',
    'WrongDimension.md': '# Wrong dimension',
    'Empty.md': '# Empty',
    'Nonfinite.md': '# Nonfinite',
  });
  const storage = new EmbeddingStorage(pinVaultRootSync(vault));
  const currentIdentity = 'model:latest@sha256:current';

  try {
    storage.store(
      'Current.md', [1, 0], 'current',
      { modelIdentity: currentIdentity }, null, 'shared keyword current',
    );
    storage.store(
      'Stale.md', [1, 0], 'stale',
      { modelIdentity: 'model:latest@sha256:stale' }, null, 'shared keyword stale',
    );
    storage.store(
      'WrongDimension.md', [1, 0, 0], 'wrong-dimension',
      { modelIdentity: currentIdentity }, null, 'shared keyword wrong dimension',
    );
    storage.store(
      'Empty.md', [], 'empty',
      { modelIdentity: currentIdentity }, null, 'shared keyword empty',
    );
    storage.store(
      'Nonfinite.md', [Number.NaN, 0], 'nonfinite',
      { modelIdentity: currentIdentity }, null, 'shared keyword nonfinite',
    );

    const semantic = storage.searchCompatible([1, 0], currentIdentity, 10, 0);
    assert.deepEqual(semantic.results.map(result => result.filePath), ['Current.md']);
    assert.deepEqual(semantic.compatibility, {
      state: 'partial',
      modelIdentity: currentIdentity,
      embeddingDimension: 2,
      totalEmbeddingCount: 5,
      compatibleEmbeddingCount: 1,
      excludedEmbeddingCount: 4,
      excludedFileCount: 4,
      reindexRequired: true,
    });
    assert.deepEqual(
      storage.keywordSearchCompatible('shared keyword', currentIdentity, 2, 10)
        .map(result => result.filePath),
      ['Current.md'],
    );
    assert.throws(
      () => storage.searchCompatible([], currentIdentity, 10, 0),
      /invalid embedding vector/i,
    );
    assert.throws(
      () => storage.keywordSearchCompatible('shared keyword', currentIdentity, 0, 10),
      /positive safe integer/i,
    );
  } finally {
    storage.close();
  }
});
