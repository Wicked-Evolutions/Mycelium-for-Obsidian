import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { syncBuiltinESMExports } from 'node:module';
import { createTempVault, cleanup } from './helpers.mjs';
import { EmbeddingStorage } from '../dist/embeddings/storage.js';
import { recoverLegacyIndex } from '../dist/embeddings/recover-legacy-index.js';

const names = ['embeddings.db', 'embeddings.db-wal', 'embeddings.db-shm'];
function fixture(t) {
  const vault = fs.realpathSync(createTempVault({ 'First.md': '# First', 'WalOnly.md': '# WAL only' }));
  t.after(() => cleanup(vault));
  const store = new EmbeddingStorage(vault);
  store.store('First.md', [1, 0], 'first', { modelIdentity: 'fixture@digest' }, null, 'first content');
  store.close();
  const directory = path.join(vault, '.mcp-obsidian');
  const db = new Database(path.join(directory, names[0]));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.transaction(() => {
    db.prepare('INSERT INTO embeddings (file_path,block_id,content_hash,embedding,metadata,updated_at) VALUES (?,?,?,?,?,?)')
      .run('WalOnly.md', '', 'wal-only', Buffer.from(new Float32Array([0, 1]).buffer), '{"modelIdentity":"fixture@digest"}', 1234);
    db.prepare('INSERT INTO content_fts (file_path,block_id,content) VALUES (?,?,?)').run('WalOnly.md', '', 'committed only in the WAL');
  })();
  const original = new Map(names.map(name => [name, fs.readFileSync(path.join(directory, name))]));
  db.close();
  for (const [name, bytes] of original) fs.writeFileSync(path.join(directory, name), bytes);
  const base = Buffer.from(original.get(names[0]));
  base[18] = base[19] = 1;
  const baseDb = new Database(base);
  try { assert.equal(baseDb.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 1); }
  finally { baseDb.close(); }
  return { vault, directory, original };
}
function assertOriginals(fixture) {
  for (const [name, bytes] of fixture.original) assert.deepEqual(fs.readFileSync(path.join(fixture.directory, name)), bytes);
}
function backupOf(fixture) {
  const directories = fs.readdirSync(fixture.directory).filter(name => name.startsWith('.legacy-backup-') && fs.statSync(path.join(fixture.directory, name)).isDirectory());
  assert.equal(directories.length, 1);
  return path.join(fixture.directory, directories[0]);
}
function assertBackup(fixture) {
  const backup = backupOf(fixture);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const [name, bytes] of fixture.original) {
    assert.deepEqual(fs.readFileSync(path.join(backup, name)), bytes);
    assert.equal(fs.statSync(path.join(backup, name)).mode & 0o777, 0o600);
  }
  return backup;
}

test('legacy normalization preserves WAL-only embeddings, metadata and FTS across cold reopen', t => {
  const f = fixture(t);
  assert.throws(() => new EmbeddingStorage(f.vault), error => error.code === 'legacy_index_upgrade_required');
  const receipt = recoverLegacyIndex(f.vault, { offlineConfirmed: true });
  assert.equal(receipt.status, 'normalized');
  assert.equal(receipt.modelIdentityChanged, false);
  assert.ok(receipt.committedWalFrames > 0);
  assert.equal(receipt.backupDirectory, assertBackup(f));
  assert.equal(fs.existsSync(path.join(f.directory, names[1])), false);
  assert.equal(fs.existsSync(path.join(f.directory, names[2])), false);
  const bytes = fs.readFileSync(path.join(f.directory, names[0]));
  assert.equal(bytes[18], 1);
  assert.equal(bytes[19], 1);
  for (let i = 0; i < 2; i += 1) {
    const store = new EmbeddingStorage(f.vault);
    try {
      assert.equal(store.getStats().totalEmbeddings, 2);
      assert.equal(store.get('WalOnly.md').metadata.modelIdentity, 'fixture@digest');
      assert.deepEqual(store.get('WalOnly.md').embedding, [0, 1]);
      assert.equal(store.getContent('WalOnly.md', null), 'committed only in the WAL');
      assert.equal(store.keywordSearch('committed WAL')[0]?.filePath, 'WalOnly.md');
    } finally { store.close(); }
  }
});

test('offline confirmation is required before any recovery write', t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.directory);
  assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: false }), /Stop every server/);
  assertOriginals(f);
  assert.deepEqual(fs.readdirSync(f.directory), before);
});

for (const stage of ['backup', 'staged', 'published', 'wal-quarantined', 'quarantined']) {
  test(`interruption at ${stage} preserves a complete verified original bundle`, t => {
    const f = fixture(t);
    assert.throws(() => recoverLegacyIndex(f.vault, {
      offlineConfirmed: true,
      checkpoint: observed => { if (observed === stage) throw new Error('injected interruption'); },
    }), /Recovery stopped/);
    assertBackup(f);
    if (stage === 'backup' || stage === 'staged') assertOriginals(f);
    if (stage === 'published' || stage === 'wal-quarantined') {
      assert.throws(() => new EmbeddingStorage(f.vault), error => error.code === 'index_recovery_required');
      const db = new Database(fs.readFileSync(path.join(f.directory, names[0])));
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 2); }
      finally { db.close(); }
    }
    if (stage === 'quarantined') {
      const store = new EmbeddingStorage(f.vault);
      try { assert.equal(store.getStats().totalEmbeddings, 2); }
      finally { store.close(); }
    }
  });
}

test('artifact mutation after backup refuses publication and preserves the captured original', t => {
  const f = fixture(t);
  assert.throws(() => recoverLegacyIndex(f.vault, {
    offlineConfirmed: true,
    checkpoint: stage => {
      if (stage === 'backup') fs.appendFileSync(path.join(f.directory, names[1]), Buffer.from([1]));
    },
  }), /Recovery stopped/);
  assertBackup(f);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, names[0])), f.original.get(names[0]));
});

for (const mode of ['symlink', 'hardlink', 'directory']) {
  test(`recovery refuses a ${mode} sidecar before creating a backup`, t => {
    const f = fixture(t);
    const outside = fs.realpathSync(createTempVault({ 'Untouched.md': 'outside' }));
    t.after(() => cleanup(outside));
    const sidecar = path.join(f.directory, names[1]);
    fs.unlinkSync(sidecar);
    if (mode === 'directory') fs.mkdirSync(sidecar);
    else if (mode === 'symlink') fs.symlinkSync(path.join(outside, 'Untouched.md'), sidecar);
    else fs.linkSync(path.join(outside, 'Untouched.md'), sidecar);
    assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: true }));
    assert.equal(fs.readFileSync(path.join(outside, 'Untouched.md'), 'utf8'), 'outside');
    assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.legacy-backup-')), false);
  });
}

for (const corruption of ['truncated', 'checksum', 'mixed-salt', 'erased-commit']) {
  test(`recovery refuses ${corruption} WAL without publishing`, t => {
    const f = fixture(t);
    const wal = Buffer.from(f.original.get(names[1]));
    if (corruption === 'checksum') wal[32 + 24 + 20] ^= 1;
    if (corruption === 'mixed-salt') wal[32 + 8] ^= 1;
    if (corruption === 'erased-commit') wal.writeUInt32BE(0, wal.length - wal.readUInt32BE(8) - 24 + 4);
    fs.writeFileSync(path.join(f.directory, names[1]), corruption === 'truncated' ? wal.subarray(0, wal.length - 1) : wal);
    assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: true }));
    assert.deepEqual(fs.readFileSync(path.join(f.directory, names[0])), f.original.get(names[0]));
  });
}

test('current indexes and publication artifacts are not handled by the legacy command', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'embeddings.publish.lock'), 'retained publication');
  assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: true }), /separate operator recovery/);
  assertOriginals(f);
  fs.unlinkSync(path.join(f.directory, 'embeddings.publish.lock'));
  recoverLegacyIndex(f.vault, { offlineConfirmed: true });
  const before = fs.readFileSync(path.join(f.directory, names[0]));
  assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: true }), /recognized legacy/);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, names[0])), before);
});

for (const damage of ['remove-member', 'corrupt-member', 'replace-directory']) {
  test(`backup ${damage} at staging prevents database publication`, t => {
    const f = fixture(t);
    assert.throws(() => recoverLegacyIndex(f.vault, {
      offlineConfirmed: true,
      checkpoint: stage => {
        if (stage !== 'staged') return;
        const backup = backupOf(f);
        if (damage === 'remove-member') fs.unlinkSync(path.join(backup, names[1]));
        if (damage === 'corrupt-member') fs.appendFileSync(path.join(backup, names[0]), 'changed');
        if (damage === 'replace-directory') {
          fs.renameSync(backup, `${backup}-retained`);
          fs.mkdirSync(backup);
        }
      },
    }), /Recovery stopped/);
    assertOriginals(f);
  });
}

for (const operation of ['writeFileSync', 'fsyncSync']) {
  test(`backup ${operation} failure leaves every canonical original unchanged`, t => {
    const f = fixture(t);
    const original = fs[operation];
    let injected = false;
    t.mock.method(fs, operation, (...args) => {
      if (!injected && typeof args[0] === 'number') {
        injected = true;
        if (operation === 'writeFileSync') original(args[0], args[1].subarray(0, 16));
        throw new Error('injected backup I/O failure');
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => recoverLegacyIndex(f.vault, { offlineConfirmed: true }), /Recovery stopped/);
      assert.equal(injected, true);
      assertOriginals(f);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
