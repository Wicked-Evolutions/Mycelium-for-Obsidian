import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { assertPinnedVaultRootSync, pinVaultRootSync, type PinnedVaultRoot } from './vault-root.js';
import {
  descriptorIdentity, fsyncDirectory, mkdirAt, openDirectoryAt, openFileAt,
  openPinnedDirectory, renameAt, sameSecureIdentity,
} from './secure-fs.js';

const DATABASE = 'embeddings.db';
const ARTIFACTS = [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`] as const;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type Snapshot = { name: string; bytes: Buffer; stat: fs.BigIntStats };

function readArtifact(directory: number, name: string): Snapshot | null {
  let fd: number;
  try {
    fd = openFileAt(directory, name, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Recovery requires regular single-link artifacts.');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) {
      throw new Error('Recovery artifact changed while being read.');
    }
    return { name, bytes, stat };
  } finally {
    fs.closeSync(fd);
  }
}

function sameSnapshot(expected: Snapshot, actual: Snapshot | null): boolean {
  return actual !== null && expected.stat.dev === actual.stat.dev && expected.stat.ino === actual.stat.ino &&
    expected.stat.size === actual.stat.size && expected.stat.mtimeNs === actual.stat.mtimeNs &&
    expected.stat.ctimeNs === actual.stat.ctimeNs && expected.bytes.equals(actual.bytes);
}

function writePrivate(directory: number, name: string, bytes: Buffer): Snapshot {
  const fd = openFileAt(directory, name, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const written = readArtifact(directory, name);
  if (!written || !written.bytes.equals(bytes)) throw new Error('Recovery copy verification failed.');
  return written;
}

// Conservative WAL admission. SQLite remains the parser/checkpointer; its reported
// frame count must include every committed frame in this single-generation file.
function committedFrames(database: Buffer, wal?: Buffer): number {
  if (database.length < 100 || database.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
      database[18] !== 2 || database[19] !== 2) {
    throw new Error('Only a recognized legacy WAL-format database can be normalized.');
  }
  if (!wal || wal.length === 0) return 0;
  if (wal.length < 32 || ![0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0)) ||
      wal.readUInt32BE(4) !== 3007000) throw new Error('Unrecognized WAL header; recovery refused.');
  const encodedSize = database.readUInt16BE(16);
  const pageSize = encodedSize === 1 ? 65536 : encodedSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 ||
      wal.readUInt32BE(8) !== pageSize || (wal.length - 32) % (pageSize + 24) !== 0) {
    throw new Error('Incomplete or inconsistent WAL framing; recovery refused.');
  }
  let lastCommit = 0;
  let frame = 0;
  for (let offset = 32; offset < wal.length; offset += pageSize + 24) {
    frame += 1;
    if (wal.readUInt32BE(offset) === 0 ||
        !wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) {
      throw new Error('Mixed WAL generations require operator inspection.');
    }
    if (wal.readUInt32BE(offset + 4) !== 0) lastCommit = frame;
  }
  if (lastCommit !== frame) throw new Error('Ambiguous trailing WAL frames require operator inspection.');
  return lastCommit;
}

function logicalDigest(db: Database.Database): string {
  const digest = createHash('sha256');
  digest.update(JSON.stringify([db.pragma('user_version', { simple: true }), db.pragma('application_id', { simple: true })]));
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string; sql: string }>;
  if (!tables.some(table => table.name === 'embeddings')) throw new Error('The database is not an embedding index.');
  for (const table of tables) {
    const rows: string[] = [];
    const identifier = `"${table.name.replaceAll('"', '""')}"`;
    for (const row of db.prepare(`SELECT * FROM ${identifier}`).raw().safeIntegers().iterate()) {
      rows.push(hash(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? { integer: value.toString() } : value)));
    }
    digest.update(JSON.stringify([table.name, table.sql, rows.sort()]));
  }
  return digest.digest('hex');
}

function assertIntegrity(db: Database.Database): void {
  const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('SQLite integrity validation failed.');
}

export interface LegacyRecoveryOptions {
  offlineConfirmed: boolean;
  // Test-only checkpoints; never supplied by the operator entrypoint.
  checkpoint?: (stage: 'backup' | 'staged' | 'published' | 'wal-quarantined' | 'quarantined') => void;
}

/** Explicit offline operation. No server startup, watcher or storage opener is imported. */
export function recoverLegacyIndex(vault: string | PinnedVaultRoot, options: LegacyRecoveryOptions) {
  if (!options.offlineConfirmed) throw new Error('Stop every server/watcher and prevent relaunch before confirming offline recovery.');
  const root = typeof vault === 'string' ? pinVaultRootSync(vault) : vault;
  assertPinnedVaultRootSync(root);
  const vaultFd = openPinnedDirectory(root.path, { device: root.device, inode: root.inode });
  let storageFd: number | undefined;
  let backupFd: number | undefined;
  let workingDirectory: string | undefined;
  let backupName: string | undefined;
  try {
    storageFd = openDirectoryAt(vaultFd, '.mcp-obsidian');
    const storageIdentity = descriptorIdentity(storageFd);
    const storagePath = path.join(root.path, '.mcp-obsidian');
    const assertLocation = () => {
      assertPinnedVaultRootSync(root);
      const current = openDirectoryAt(vaultFd, '.mcp-obsidian');
      try {
        if (!sameSecureIdentity(descriptorIdentity(current), storageIdentity) || fs.realpathSync(storagePath) !== storagePath) {
          throw new Error('Recovery storage directory identity changed.');
        }
      } finally { fs.closeSync(current); }
    };
    const assertNoPublication = () => {
      assertLocation();
      for (const name of ['embeddings.publish.lock', `${DATABASE}-journal`]) {
        if (readArtifact(storageFd!, name)) throw new Error('Publication or rollback-journal state requires separate operator recovery.');
      }
      if (fs.readdirSync(storagePath).some(name => /^\.embeddings\.db\..*\.(tmp|rollback)$/.test(name))) {
        throw new Error('Publication artifacts require separate operator recovery.');
      }
      assertLocation();
    };
    assertNoPublication();
    const snapshots = ARTIFACTS.map(name => readArtifact(storageFd!, name));
    const database = snapshots[0];
    if (!database) throw new Error('There is no existing index to normalize.');
    const frames = committedFrames(database.bytes, snapshots[1]?.bytes);
    const assertOriginals = () => {
      assertNoPublication();
      snapshots.forEach((snapshot, index) => {
        const current = readArtifact(storageFd!, ARTIFACTS[index]);
        if (snapshot ? !sameSnapshot(snapshot, current) : current !== null) {
          throw new Error('Recovery artifacts changed; keep the offline window and inspect the preserved bundle.');
        }
      });
    };
    assertOriginals();
    backupName = `.legacy-backup-${randomUUID()}`;
    mkdirAt(storageFd, backupName, 0o700);
    backupFd = openDirectoryAt(storageFd, backupName);
    const backupIdentity = descriptorIdentity(backupFd);
    const backupSnapshots = snapshots.map(snapshot => snapshot ? writePrivate(backupFd!, snapshot.name, snapshot.bytes) : null);
    const assertBackup = () => {
      const current = openDirectoryAt(storageFd!, backupName!);
      try {
        if (!sameSecureIdentity(descriptorIdentity(current), backupIdentity)) throw new Error('Recovery backup directory changed.');
        backupSnapshots.forEach((snapshot, index) => {
          const member = readArtifact(current, ARTIFACTS[index]);
          if (snapshot ? !sameSnapshot(snapshot, member) : member !== null) throw new Error('Recovery backup member changed.');
        });
      } finally { fs.closeSync(current); }
    };
    fsyncDirectory(backupFd);
    fsyncDirectory(storageFd);
    assertOriginals();
    options.checkpoint?.('backup');

    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mycelium-legacy-work-'));
    const workingPath = path.join(workingDirectory, DATABASE);
    fs.writeFileSync(workingPath, database.bytes, { flag: 'wx', mode: 0o600 });
    if (snapshots[1]) fs.writeFileSync(`${workingPath}-wal`, snapshots[1].bytes, { flag: 'wx', mode: 0o600 });
    const db = new Database(workingPath);
    let logical: string;
    try {
      db.pragma('wal_autocheckpoint = 0');
      assertIntegrity(db);
      logical = logicalDigest(db);
      const checkpoint = db.pragma('wal_checkpoint(FULL)') as Array<{ busy: number; log: number; checkpointed: number }>;
      if (checkpoint.length !== 1 || checkpoint[0].busy !== 0 || checkpoint[0].log !== frames || checkpoint[0].checkpointed !== frames) {
        throw new Error('SQLite did not confirm the complete committed WAL; recovery refused.');
      }
      if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Single-file conversion failed.');
      assertIntegrity(db);
      if (logicalDigest(db) !== logical) throw new Error('Logical index content changed during normalization.');
    } finally { db.close(); }
    const normalized = fs.readFileSync(workingPath);
    const checked = new Database(normalized);
    try {
      assertIntegrity(checked);
      if (logicalDigest(checked) !== logical) throw new Error('Normalized snapshot content verification failed.');
    } finally { checked.close(); }

    assertOriginals();
    const stagedName = `.legacy-normalized-${randomUUID()}`;
    const staged = writePrivate(storageFd, stagedName, normalized);
    fsyncDirectory(storageFd);
    options.checkpoint?.('staged');
    assertOriginals();
    assertBackup();
    if (!sameSnapshot(staged, readArtifact(storageFd, stagedName))) throw new Error('Staged recovery snapshot changed.');
    renameAt(storageFd, stagedName, DATABASE);
    fsyncDirectory(storageFd);
    options.checkpoint?.('published');

    for (let index = 1; index < ARTIFACTS.length; index += 1) {
      assertNoPublication();
      assertBackup();
      const published = readArtifact(storageFd, DATABASE);
      if (!published || published.stat.dev !== staged.stat.dev || published.stat.ino !== staged.stat.ino || !published.bytes.equals(normalized)) {
        throw new Error('Published recovery snapshot changed; preserved artifacts require operator inspection.');
      }
      const original = snapshots[index];
      const current = readArtifact(storageFd, ARTIFACTS[index]);
      if (original ? !sameSnapshot(original, current) : current !== null) throw new Error('Recovery sidecar identity changed.');
      if (original) {
        const quarantineName = `${backupName}-${index}.saved`;
        if (readArtifact(storageFd, quarantineName)) throw new Error('Recovery quarantine destination already exists.');
        renameAt(storageFd, ARTIFACTS[index], quarantineName);
        fsyncDirectory(storageFd);
        if (index === 1) options.checkpoint?.('wal-quarantined');
      }
    }
    options.checkpoint?.('quarantined');
    assertLocation();
    assertBackup();
    return { status: 'normalized', backupDirectory: path.join(storagePath, backupName), databaseHash: hash(normalized), logicalDigest: logical, committedWalFrames: frames, modelIdentityChanged: false };
  } catch (error) {
    if (backupName) {
      throw new Error(`Recovery stopped; keep all servers offline and preserve the ${backupName} bundle for operator inspection.`, { cause: error });
    }
    throw error;
  } finally {
    try { if (workingDirectory) fs.rmSync(workingDirectory, { recursive: true, force: true }); }
    finally {
      try { if (backupFd !== undefined) fs.closeSync(backupFd); }
      finally {
        try { if (storageFd !== undefined) fs.closeSync(storageFd); }
        finally { fs.closeSync(vaultFd); }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { vault: { type: 'string' }, 'offline-confirmed': { type: 'boolean' } } });
    if (!values.vault) throw new Error('An explicit configured --vault is required.');
    const config = loadConfig();
    const matches = config.vaults.filter(vault => vault.name.toLowerCase() === values.vault!.toLowerCase());
    if (matches.length !== 1) throw new Error('The configured vault name must resolve unambiguously.');
    console.log(JSON.stringify(recoverLegacyIndex(matches[0].path, { offlineConfirmed: values['offline-confirmed'] === true }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Legacy recovery failed.');
    process.exitCode = 1;
  }
}
