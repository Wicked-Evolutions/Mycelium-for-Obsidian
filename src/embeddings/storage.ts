/**
 * SQLite vector storage for embeddings
 * Stores embeddings as binary blobs for efficient retrieval
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import {
  assertValidEmbeddingVector,
  cosineSimilarity,
  isValidEmbeddingVector,
} from './ollama.js';
import type { EmbeddingPathStat } from './index-stats.js';
import {
  assertPinnedVaultRootSync,
  pinVaultRootSync,
  type PinnedVaultRoot,
} from './vault-root.js';
import {
  SecureFilesystemOperationError,
  fsyncDirectory,
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  openPinnedDirectory,
  renameAt,
  unlinkAt,
} from './secure-fs.js';

export interface StoredEmbedding {
  id: number;
  filePath: string;
  blockId: string | null;
  contentHash: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface SearchResult {
  filePath: string;
  blockId: string | null;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface FileEmbeddingManifestEntry {
  blockId: string | null;
  contentHash: string;
  content: string;
}

export interface FileEmbeddingReplacement extends FileEmbeddingManifestEntry {
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface EmbeddingIndexCompatibility {
  state: 'complete' | 'partial';
  modelIdentity: string;
  embeddingDimension: number;
  totalEmbeddingCount: number;
  compatibleEmbeddingCount: number;
  excludedEmbeddingCount: number;
  excludedFileCount: number;
  reindexRequired: boolean;
}

export interface CompatibleSearchResults {
  results: SearchResult[];
  compatibility: EmbeddingIndexCompatibility;
}

export interface EmbeddingStorageDependencies {
  openDatabase?: (
    source: string | Buffer
  ) => Database.Database;
  serializeDatabase?: (database: Database.Database) => Buffer;
  openDatabaseFile?: (databasePath: string, flags: number) => number;
  beforeRollbackSnapshotCopy?: () => void;
  beforeSnapshotRename?: (temporaryPath: string) => void;
  afterPublishLockAcquired?: () => void;
  afterRollbackPinned?: () => void;
  afterSnapshotRename?: () => void;
  afterCommitMarker?: () => void;
}

interface FileIdentity {
  device: string;
  inode: string;
}

interface StorageAuthority {
  vaultRoot: PinnedVaultRoot;
  storageDirectory: string;
  storageDirectoryIdentity: FileIdentity;
  databasePath: string;
  databaseIdentity: FileIdentity;
}

interface PublishLock {
  name: string;
  descriptor: number;
  identity: FileIdentity;
  record: string;
}

interface PublicationTransaction {
  version: 3;
  pid: number;
  nonce: string;
  previousDatabaseIdentity: FileIdentity;
  temporaryIdentity: FileIdentity;
  rollbackIdentity: FileIdentity;
}

const PUBLISH_COMMIT_SUFFIX = '\nCOMMITTED\n';

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function lstatIfPresent(targetPath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function verifiedIdentity(
  targetPath: string,
  expectedType: 'directory' | 'file'
): FileIdentity {
  const stat = fs.lstatSync(targetPath, { bigint: true });
  if (stat.isSymbolicLink()) {
    throw new Error(`Embedding storage ${expectedType} must not be a symbolic link.`);
  }
  const hasExpectedType = expectedType === 'directory'
    ? stat.isDirectory()
    : stat.isFile();
  if (!hasExpectedType || fs.realpathSync(targetPath) !== targetPath) {
    throw new Error(`Embedding storage ${expectedType} has an invalid physical identity.`);
  }
  if (expectedType === 'file' && stat.nlink !== 1n) {
    throw new Error('Embedding storage files must have exactly one hard link.');
  }
  return identityOf(stat);
}

function assertNoSqliteSidecarsAt(
  storageDirectoryDescriptor: number,
  databasePath: string
): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    let descriptor: number;
    try {
      descriptor = openFileAt(
        storageDirectoryDescriptor,
        `embeddings.db${suffix}`,
        fs.constants.O_RDONLY
      );
    } catch (error) {
      if (isSecureFsCode(error, 'ENOENT')) continue;
      throw new Error(
        isSecureFsCode(error, 'ELOOP')
          ? 'Embedding storage SQLite sidecars must not be symbolic links.'
          : 'Embedding storage SQLite sidecar has an invalid physical identity.'
      );
    }
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        fs.realpathSync(`${databasePath}${suffix}`) !== `${databasePath}${suffix}`
      ) {
        throw new Error('Embedding storage SQLite sidecar has an invalid physical identity.');
      }
      throw new Error(
        'Embedding storage has a live or stale SQLite sidecar; stop older Mycelium processes before retrying.'
      );
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

function readPinnedDatabase(
  authority: StorageAuthority,
  openDatabaseFile: (databasePath: string, flags: number) => number
): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = openDatabaseFile(authority.databasePath, flags);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameIdentity(identityOf(before), authority.databaseIdentity)
    ) {
      throw new Error('Opened embedding database does not match the pinned file identity.');
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      after.size !== BigInt(content.length) ||
      !sameIdentity(identityOf(after), authority.databaseIdentity)
    ) {
      throw new Error('Embedding database changed while its snapshot was read.');
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyVerifiedSnapshot(
  sourceDescriptor: number,
  destinationDescriptor: number,
  expectedSourceIdentity: FileIdentity
): FileIdentity {
  const sourceBefore = fs.fstatSync(sourceDescriptor, { bigint: true });
  const destinationBefore = fs.fstatSync(destinationDescriptor, { bigint: true });
  if (
    !sourceBefore.isFile() ||
    sourceBefore.nlink !== 1n ||
    !sameIdentity(identityOf(sourceBefore), expectedSourceIdentity)
  ) {
    throw new Error('Embedding database changed before its rollback snapshot was copied.');
  }
  if (
    !destinationBefore.isFile() ||
    destinationBefore.nlink !== 1n ||
    destinationBefore.size !== 0n
  ) {
    throw new Error('Embedding rollback snapshot did not start as one private empty file.');
  }
  if (sourceBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Embedding database is too large to copy safely.');
  }

  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const totalBytes = Number(sourceBefore.size);
  let offset = 0;
  while (offset < totalBytes) {
    const bytesRead = fs.readSync(
      sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.length, totalBytes - offset),
      offset
    );
    if (bytesRead <= 0) {
      throw new Error('Embedding database ended while its rollback snapshot was copied.');
    }
    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      bytesWritten += fs.writeSync(
        destinationDescriptor,
        buffer,
        bytesWritten,
        bytesRead - bytesWritten,
        offset + bytesWritten
      );
    }
    offset += bytesRead;
  }
  fs.fsyncSync(destinationDescriptor);

  const sourceAfter = fs.fstatSync(sourceDescriptor, { bigint: true });
  const destinationAfter = fs.fstatSync(destinationDescriptor, { bigint: true });
  if (
    !sourceAfter.isFile() ||
    sourceAfter.nlink !== 1n ||
    sourceAfter.size !== sourceBefore.size ||
    sourceAfter.mtimeNs !== sourceBefore.mtimeNs ||
    sourceAfter.ctimeNs !== sourceBefore.ctimeNs ||
    !sameIdentity(identityOf(sourceAfter), expectedSourceIdentity)
  ) {
    throw new Error('Embedding database changed while its rollback snapshot was copied.');
  }
  if (
    !destinationAfter.isFile() ||
    destinationAfter.nlink !== 1n ||
    destinationAfter.size !== sourceBefore.size
  ) {
    throw new Error('Embedding rollback snapshot copy is incomplete.');
  }
  return identityOf(destinationAfter);
}

function normalizeDatabaseSnapshot(content: Buffer): {
  source: string | Buffer;
  requiresPersistence: boolean;
} {
  if (content.length === 0) {
    return { source: ':memory:', requiresPersistence: true };
  }
  const snapshot = Buffer.from(content);
  if (snapshot.length >= 20 && (snapshot[18] === 2 || snapshot[19] === 2)) {
    // A quiescent WAL database has already checkpointed its data into the main
    // file. Let SQLite normalize only a private copy; it never opens the vault path.
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mycelium-embedding-migration-')
    );
    const temporaryDatabase = path.join(temporaryRoot, 'embeddings.db');
    let migration: Database.Database | null = null;
    try {
      fs.writeFileSync(temporaryDatabase, snapshot, { mode: 0o600, flag: 'wx' });
      migration = new Database(temporaryDatabase, { fileMustExist: true });
      migration.pragma('journal_mode = DELETE');
      return {
        source: migration.serialize(),
        requiresPersistence: true,
      };
    } finally {
      migration?.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  return { source: snapshot, requiresPersistence: false };
}

function normalizeVaultRoot(input: string | PinnedVaultRoot): PinnedVaultRoot {
  if (typeof input !== 'string') return input;

  const requestedPath = path.resolve(input);
  const requestedStat = lstatIfPresent(requestedPath);
  if (requestedStat?.isDirectory()) {
    return pinVaultRootSync(requestedPath);
  }

  const storageDirectory = path.dirname(requestedPath);
  if (
    path.basename(requestedPath) !== 'embeddings.db' ||
    path.basename(storageDirectory) !== '.mcp-obsidian'
  ) {
    throw new Error('Embedding storage must be constructed for a vault root or its canonical embeddings.db path.');
  }
  const requestedVaultPath = path.dirname(storageDirectory);
  const vaultRoot = pinVaultRootSync(requestedVaultPath);
  const expectedRequestedPath = path.join(
    path.resolve(requestedVaultPath),
    '.mcp-obsidian',
    'embeddings.db'
  );
  if (requestedPath !== expectedRequestedPath) {
    throw new Error('Embedding database path does not belong to the pinned vault root.');
  }
  return vaultRoot;
}

function prepareStorageAuthority(vaultRoot: PinnedVaultRoot): StorageAuthority {
  assertPinnedVaultRootSync(vaultRoot);
  const storageDirectory = path.join(vaultRoot.path, '.mcp-obsidian');
  const databasePath = path.join(storageDirectory, 'embeddings.db');
  const vaultDescriptor = openPinnedDirectory(vaultRoot.path, {
    device: vaultRoot.device,
    inode: vaultRoot.inode,
  });
  let storageDescriptor: number | null = null;
  try {
    try {
      storageDescriptor = openDirectoryAt(vaultDescriptor, '.mcp-obsidian');
    } catch (error) {
      if (!isSecureFsCode(error, 'ENOENT')) {
        throw new Error(
          'Embedding storage directory must not be a symbolic link and must have a valid physical identity.'
        );
      }
      mkdirAt(vaultDescriptor, '.mcp-obsidian', 0o700);
      fsyncDirectory(vaultDescriptor);
      storageDescriptor = openDirectoryAt(vaultDescriptor, '.mcp-obsidian');
    }

    const storageStat = fs.fstatSync(storageDescriptor, { bigint: true });
    if (!storageStat.isDirectory()) {
      throw new Error('Embedding storage directory has an invalid physical identity.');
    }
    const storageDirectoryIdentity = identityOf(storageStat);
    if (!sameIdentity(
      verifiedIdentity(storageDirectory, 'directory'),
      storageDirectoryIdentity
    )) {
      throw new Error('Embedding storage directory changed while it was pinned.');
    }

    recoverStalePublication(
      storageDirectoryIdentity,
      storageDescriptor
    );
    assertNoSqliteSidecarsAt(storageDescriptor, databasePath);

    let databaseDescriptor: number;
    try {
      databaseDescriptor = openFileAt(
        storageDescriptor,
        'embeddings.db',
        fs.constants.O_RDONLY
      );
    } catch (error) {
      if (!isSecureFsCode(error, 'ENOENT')) {
        throw new Error(
          isSecureFsCode(error, 'ELOOP')
            ? 'Embedding storage file must not be a symbolic link.'
            : 'Embedding storage file must have a valid physical identity.'
        );
      }
      databaseDescriptor = openFileAt(
        storageDescriptor,
        'embeddings.db',
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        0o600
      );
      fs.fsyncSync(databaseDescriptor);
      fsyncDirectory(storageDescriptor);
    }

    let databaseIdentity: FileIdentity;
    try {
      const databaseStat = fs.fstatSync(databaseDescriptor, { bigint: true });
      if (!databaseStat.isFile() || databaseStat.nlink !== 1n) {
        throw new Error('Embedding storage files must have exactly one hard link.');
      }
      databaseIdentity = identityOf(databaseStat);
    } finally {
      fs.closeSync(databaseDescriptor);
    }

    assertNoSqliteSidecarsAt(storageDescriptor, databasePath);
    assertPinnedVaultRootSync(vaultRoot);
    if (!sameIdentity(
      verifiedIdentity(storageDirectory, 'directory'),
      storageDirectoryIdentity
    )) {
      throw new Error('Embedding storage directory changed during preparation.');
    }

    return {
      vaultRoot,
      storageDirectory,
      storageDirectoryIdentity,
      databasePath,
      databaseIdentity,
    };
  } finally {
    if (storageDescriptor !== null) fs.closeSync(storageDescriptor);
    fs.closeSync(vaultDescriptor);
  }
}

function assertStorageAuthority(authority: StorageAuthority): void {
  assertPinnedVaultRootSync(authority.vaultRoot);
  const directoryIdentity = verifiedIdentity(authority.storageDirectory, 'directory');
  const storageDescriptor = openPinnedDirectory(
    authority.storageDirectory,
    authority.storageDirectoryIdentity
  );
  let databaseDescriptor: number | null = null;
  let databaseIdentity: FileIdentity;
  try {
    databaseDescriptor = openFileAt(
      storageDescriptor,
      'embeddings.db',
      fs.constants.O_RDONLY
    );
    const databaseStat = fs.fstatSync(databaseDescriptor, { bigint: true });
    if (!databaseStat.isFile() || databaseStat.nlink !== 1n) {
      throw new Error('Embedding storage files must have exactly one hard link.');
    }
    databaseIdentity = identityOf(databaseStat);
    assertNoSqliteSidecarsAt(storageDescriptor, authority.databasePath);
  } finally {
    if (databaseDescriptor !== null) fs.closeSync(databaseDescriptor);
    fs.closeSync(storageDescriptor);
  }
  if (
    !sameIdentity(directoryIdentity, authority.storageDirectoryIdentity) ||
    !sameIdentity(databaseIdentity, authority.databaseIdentity)
  ) {
    throw new Error('Embedding storage physical identity changed during use.');
  }
  assertPinnedVaultRootSync(authority.vaultRoot);
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function isSecureFsCode(error: unknown, code: string): boolean {
  return error instanceof SecureFilesystemOperationError && error.code === code;
}

function assertOpenAtIdentity(
  storageDirectoryDescriptor: number,
  name: string,
  descriptor: number,
  expectedIdentity: FileIdentity,
  expectedLinks: bigint,
  label: string
): void {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const currentDescriptor = openFileAt(
    storageDirectoryDescriptor,
    name,
    fs.constants.O_RDONLY
  );
  try {
    const current = fs.fstatSync(currentDescriptor, { bigint: true });
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.nlink !== expectedLinks ||
      current.nlink !== expectedLinks ||
      !sameIdentity(identityOf(opened), expectedIdentity) ||
      !sameIdentity(identityOf(current), expectedIdentity)
    ) {
      throw new Error(`${label} lost its verified physical identity.`);
    }
  } finally {
    fs.closeSync(currentDescriptor);
  }
}

function statArtifactAtIfPresent(
  storageDirectoryDescriptor: number,
  name: string
): fs.BigIntStats | null {
  let descriptor: number;
  try {
    descriptor = openFileAt(storageDirectoryDescriptor, name, fs.constants.O_RDONLY);
  } catch (error) {
    if (isSecureFsCode(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) {
      throw new Error('Embedding publication artifact has an invalid physical type.');
    }
    return stat;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isValidIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<FileIdentity>;
  return typeof identity.device === 'string' &&
    /^\d+$/.test(identity.device) &&
    typeof identity.inode === 'string' &&
    /^\d+$/.test(identity.inode);
}

function readPublishLockOwner(
  storageDirectoryDescriptor: number
): {
  transaction: PublicationTransaction;
  identity: FileIdentity;
  committed: boolean;
} {
  const descriptor = openFileAt(
    storageDirectoryDescriptor,
    'embeddings.publish.lock',
    fs.constants.O_RDONLY
  );
  try {
    const initial = fs.fstatSync(descriptor, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n) {
      throw new Error('Embedding publication lock has an invalid physical identity.');
    }
    const identity = identityOf(initial);
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      'embeddings.publish.lock',
      descriptor,
      identity,
      1n,
      'Embedding publication lock'
    );
    const raw = fs.readFileSync(descriptor, 'utf8');
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      'embeddings.publish.lock',
      descriptor,
      identity,
      1n,
      'Embedding publication lock'
    );
    const committed = raw.endsWith(PUBLISH_COMMIT_SUFFIX);
    const record = committed
      ? raw.slice(0, -PUBLISH_COMMIT_SUFFIX.length)
      : raw;
    if (!record || record.includes('\n')) {
      throw new Error('Embedding publication lock owner is invalid.');
    }
    const owner = JSON.parse(record) as Partial<PublicationTransaction>;
    if (
      owner.version !== 3 ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.nonce !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.nonce) ||
      !isValidIdentity(owner.previousDatabaseIdentity) ||
      !isValidIdentity(owner.temporaryIdentity) ||
      !isValidIdentity(owner.rollbackIdentity)
    ) {
      throw new Error('Embedding publication lock owner is invalid.');
    }
    return {
      transaction: owner as PublicationTransaction,
      identity,
      committed,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, 'ESRCH');
  }
}

function assertArtifactIdentityAt(
  storageDirectoryDescriptor: number,
  name: string,
  expectedIdentity: FileIdentity,
  expectedLinks: bigint,
  label: string
): void {
  const descriptor = openFileAt(
    storageDirectoryDescriptor,
    name,
    fs.constants.O_RDONLY
  );
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== expectedLinks ||
      !sameIdentity(identityOf(stat), expectedIdentity)
    ) {
      throw new Error(`${label} has an invalid physical identity.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function unlinkVerifiedArtifact(
  storageDirectoryDescriptor: number,
  name: string,
  expectedIdentity: FileIdentity,
  expectedLinks: bigint,
  label: string
): void {
  const descriptor = openFileAt(
    storageDirectoryDescriptor,
    name,
    fs.constants.O_RDONLY
  );
  try {
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      name,
      descriptor,
      expectedIdentity,
      expectedLinks,
      label
    );
    unlinkAt(storageDirectoryDescriptor, name);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== expectedLinks - 1n ||
      !sameIdentity(identityOf(after), expectedIdentity)
    ) {
      throw new Error(`${label} changed while it was removed.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoverStalePublication(
  storageDirectoryIdentity: FileIdentity,
  storageDirectoryDescriptor: number
): 'none' | 'previous' | 'published' {
  const pinnedDirectory = fs.fstatSync(storageDirectoryDescriptor, { bigint: true });
  if (
    !pinnedDirectory.isDirectory() ||
    !sameIdentity(identityOf(pinnedDirectory), storageDirectoryIdentity)
  ) {
    throw new Error('Embedding publication recovery lost its pinned storage directory.');
  }

  let owner: ReturnType<typeof readPublishLockOwner>;
  try {
    owner = readPublishLockOwner(storageDirectoryDescriptor);
  } catch (error) {
    if (isSecureFsCode(error, 'ENOENT')) return 'none';
    throw error;
  }
  if (processIsAlive(owner.transaction.pid)) {
    throw new Error('Embedding snapshot publication is already in progress.');
  }

  const { transaction } = owner;
  const temporaryName = `.embeddings.db.${transaction.pid}.${transaction.nonce}.tmp`;
  const rollbackName = `.embeddings.db.${transaction.pid}.${transaction.nonce}.rollback`;
  const canonical = statArtifactAtIfPresent(
    storageDirectoryDescriptor,
    'embeddings.db'
  );
  const temporary = statArtifactAtIfPresent(
    storageDirectoryDescriptor,
    temporaryName
  );
  const rollback = statArtifactAtIfPresent(
    storageDirectoryDescriptor,
    rollbackName
  );
  if (!canonical || !canonical.isFile()) {
    throw new Error('Embedding publication recovery could not verify the canonical database.');
  }

  const canonicalIdentity = identityOf(canonical);
  let recovered: 'previous' | 'published';
  if (owner.committed) {
    if (!sameIdentity(canonicalIdentity, transaction.temporaryIdentity)) {
      throw new Error('Committed embedding recovery found an unknown database generation.');
    }
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      'embeddings.db',
      transaction.temporaryIdentity,
      1n,
      'Published embedding database during recovery'
    );
    if (temporary) {
      throw new Error('Published embedding recovery found an unexpected temporary path.');
    }
    if (rollback) {
      assertArtifactIdentityAt(
        storageDirectoryDescriptor,
        rollbackName,
        transaction.rollbackIdentity,
        1n,
        'Embedding rollback snapshot during committed recovery'
      );
      unlinkVerifiedArtifact(
        storageDirectoryDescriptor,
        rollbackName,
        transaction.rollbackIdentity,
        1n,
        'Embedding rollback snapshot during committed recovery'
      );
    }
    recovered = 'published';
  } else if (sameIdentity(canonicalIdentity, transaction.previousDatabaseIdentity)) {
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      'embeddings.db',
      transaction.previousDatabaseIdentity,
      1n,
      'Embedding database during prepared recovery'
    );
    if (temporary) {
      assertArtifactIdentityAt(
        storageDirectoryDescriptor,
        temporaryName,
        transaction.temporaryIdentity,
        1n,
        'Embedding temporary snapshot during prepared recovery'
      );
      unlinkVerifiedArtifact(
        storageDirectoryDescriptor,
        temporaryName,
        transaction.temporaryIdentity,
        1n,
        'Embedding temporary snapshot during prepared recovery'
      );
    }
    if (rollback) {
      assertArtifactIdentityAt(
        storageDirectoryDescriptor,
        rollbackName,
        transaction.rollbackIdentity,
        1n,
        'Embedding rollback snapshot during prepared recovery'
      );
      unlinkVerifiedArtifact(
        storageDirectoryDescriptor,
        rollbackName,
        transaction.rollbackIdentity,
        1n,
        'Embedding rollback snapshot during prepared recovery'
      );
    }
    recovered = 'previous';
  } else if (sameIdentity(canonicalIdentity, transaction.temporaryIdentity)) {
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      'embeddings.db',
      transaction.temporaryIdentity,
      1n,
      'Uncommitted embedding database during recovery'
    );
    if (temporary) {
      throw new Error('Prepared embedding recovery found an unexpected temporary path.');
    }
    if (!rollback) {
      throw new Error('Prepared embedding recovery cannot restore its missing rollback snapshot.');
    }
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      rollbackName,
      transaction.rollbackIdentity,
      1n,
      'Embedding rollback snapshot during prepared recovery'
    );
    renameAt(storageDirectoryDescriptor, rollbackName, 'embeddings.db');
    fsyncDirectory(storageDirectoryDescriptor);
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      'embeddings.db',
      transaction.rollbackIdentity,
      1n,
      'Restored embedding database during prepared recovery'
    );
    recovered = 'previous';
  } else if (sameIdentity(canonicalIdentity, transaction.rollbackIdentity)) {
    if (rollback || temporary) {
      throw new Error('Restored embedding recovery found unexpected publication artifacts.');
    }
    assertArtifactIdentityAt(
      storageDirectoryDescriptor,
      'embeddings.db',
      transaction.rollbackIdentity,
      1n,
      'Restored embedding database during recovery'
    );
    recovered = 'previous';
  } else {
    throw new Error('Embedding publication recovery found an unknown database generation.');
  }

  fsyncDirectory(storageDirectoryDescriptor);
  unlinkVerifiedArtifact(
    storageDirectoryDescriptor,
    'embeddings.publish.lock',
    owner.identity,
    1n,
    'Embedding publication lock during recovery'
  );
  fsyncDirectory(storageDirectoryDescriptor);
  return recovered;
}

function acquirePublishLock(
  transaction: PublicationTransaction,
  storageDirectoryDescriptor: number
): PublishLock {
  const lockName = 'embeddings.publish.lock';
  const flags = fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_RDWR;

  let descriptor: number;
  try {
    descriptor = openFileAt(
      storageDirectoryDescriptor,
      lockName,
      flags,
      0o600
    );
  } catch (error) {
    if (isSecureFsCode(error, 'EEXIST')) {
      throw new Error('Embedding snapshot publication is already in progress.');
    }
    throw error;
  }

  let identity: FileIdentity | null = null;
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error('Embedding publication lock has an invalid physical identity.');
    }
    identity = identityOf(stat);
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      lockName,
      descriptor,
      identity,
      1n,
      'Embedding publication lock'
    );
    const record = JSON.stringify(transaction);
    fs.writeFileSync(descriptor, record);
    fs.fsyncSync(descriptor);
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      lockName,
      descriptor,
      identity,
      1n,
      'Embedding publication lock'
    );
    fsyncDirectory(storageDirectoryDescriptor);
    return { name: lockName, descriptor, identity, record };
  } catch (error) {
    let cleanupError: unknown;
    if (identity) {
      try {
        unlinkVerifiedArtifact(
          storageDirectoryDescriptor,
          lockName,
          identity,
          1n,
          'Embedding publication lock'
        );
        fsyncDirectory(storageDirectoryDescriptor);
      } catch (caught) {
        cleanupError = caught;
      }
    }
    fs.closeSync(descriptor);
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Embedding publication lock acquisition and cleanup both failed.'
      );
    }
    throw error;
  }
}

function readDescriptorText(descriptor: number, byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Embedding publication record has an invalid byte length.');
  }
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const bytesRead = fs.readSync(
      descriptor,
      bytes,
      offset,
      byteLength - offset,
      offset
    );
    if (bytesRead <= 0) {
      throw new Error('Embedding publication record ended before verification completed.');
    }
    offset += bytesRead;
  }
  return bytes.toString('utf8');
}

function markPublishCommitted(
  lock: PublishLock,
  storageDirectoryDescriptor: number
): void {
  assertOpenAtIdentity(
    storageDirectoryDescriptor,
    lock.name,
    lock.descriptor,
    lock.identity,
    1n,
    'Embedding publication lock before commit'
  );
  const recordBytes = Buffer.byteLength(lock.record, 'utf8');
  const commitBytes = Buffer.from(PUBLISH_COMMIT_SUFFIX, 'utf8');
  const before = fs.fstatSync(lock.descriptor, { bigint: true });
  if (before.size !== BigInt(recordBytes)) {
    throw new Error('Embedding publication lock changed before commit.');
  }
  let written = 0;
  while (written < commitBytes.length) {
    written += fs.writeSync(
      lock.descriptor,
      commitBytes,
      written,
      commitBytes.length - written,
      recordBytes + written
    );
  }
  fs.fsyncSync(lock.descriptor);
  assertOpenAtIdentity(
    storageDirectoryDescriptor,
    lock.name,
    lock.descriptor,
    lock.identity,
    1n,
    'Committed embedding publication lock'
  );
  const expected = `${lock.record}${PUBLISH_COMMIT_SUFFIX}`;
  const after = fs.fstatSync(lock.descriptor, { bigint: true });
  if (
    after.size !== BigInt(Buffer.byteLength(expected, 'utf8')) ||
    readDescriptorText(lock.descriptor, Number(after.size)) !== expected
  ) {
    throw new Error('Embedding publication commit marker could not be verified.');
  }
  fsyncDirectory(storageDirectoryDescriptor);
}

function releasePublishLock(
  lock: PublishLock,
  storageDirectoryDescriptor: number
): void {
  try {
    assertOpenAtIdentity(
      storageDirectoryDescriptor,
      lock.name,
      lock.descriptor,
      lock.identity,
      1n,
      'Embedding publication lock'
    );
    unlinkAt(storageDirectoryDescriptor, lock.name);
    const after = fs.fstatSync(lock.descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 0n ||
      !sameIdentity(identityOf(after), lock.identity)
    ) {
      throw new Error('Embedding publication lock changed while it was released.');
    }
    fsyncDirectory(storageDirectoryDescriptor);
  } finally {
    fs.closeSync(lock.descriptor);
  }
}

function authorityKey(authority: StorageAuthority): string {
  const root = authority.vaultRoot;
  const directory = authority.storageDirectoryIdentity;
  const database = authority.databaseIdentity;
  return [
    root.path,
    root.device,
    root.inode,
    directory.device,
    directory.inode,
    database.device,
    database.inode,
  ].join('\u0000');
}

// Shared storage instances across the process — prevents duplicate DB connections
// between semantic.ts, watcher.ts, and crossvault.ts
const sharedInstances = new Map<string, EmbeddingStorage>();

/**
 * Get or create a shared EmbeddingStorage instance for a vault.
 * Ensures only one DB connection per vault path across the entire process.
 */
export function getSharedStorage(vault: string | PinnedVaultRoot): EmbeddingStorage {
  const vaultRoot = normalizeVaultRoot(vault);
  const authority = prepareStorageAuthority(vaultRoot);
  const key = authorityKey(authority);
  const existing = sharedInstances.get(key);
  if (existing && !existing.isClosed()) {
    existing.assertVaultRoot(vaultRoot);
    return existing;
  }

  const storage = new EmbeddingStorage(vaultRoot);
  const storageKey = storage.getAuthorityKey();
  storage.bindSharedKey(storageKey);
  sharedInstances.set(storageKey, storage);
  return storage;
}

export class EmbeddingStorage {
  private db!: Database.Database;
  private readonly dbPath: string;
  private readonly authority: StorageAuthority;
  private readonly dependencies: EmbeddingStorageDependencies;
  private readonly openDatabase: (source: string | Buffer) => Database.Database;
  private readonly batchContext = new AsyncLocalStorage<symbol>();
  private closed = false;
  private sharedKey: string | null = null;
  private dirty = false;
  private persistedSnapshot: Buffer | null = null;
  private batchOwner: symbol | null = null;

  constructor(
    vault: string | PinnedVaultRoot,
    dependencies: EmbeddingStorageDependencies = {}
  ) {
    const vaultRoot = normalizeVaultRoot(vault);
    this.authority = prepareStorageAuthority(vaultRoot);
    this.dbPath = this.authority.databasePath;
    this.dependencies = dependencies;
    this.openDatabase = dependencies.openDatabase ?? (
      (source: string | Buffer) => new Database(source)
    );
    const openDatabaseFile = dependencies.openDatabaseFile ?? fs.openSync;

    try {
      const content = readPinnedDatabase(this.authority, openDatabaseFile);
      assertStorageAuthority(this.authority);
      const snapshot = normalizeDatabaseSnapshot(content);
      this.db = this.openDatabase(snapshot.source);
      assertStorageAuthority(this.authority);
      const schemaChanged = this.initialize();
      assertStorageAuthority(this.authority);
      if (snapshot.requiresPersistence || schemaChanged) {
        this.dirty = true;
        this.persistSnapshot();
      }
      if (this.persistedSnapshot === null) {
        this.persistedSnapshot = Buffer.from(this.db.serialize());
      }
    } catch (error) {
      if (this.db?.open) this.db.close();
      throw error;
    }
  }

  bindSharedKey(key: string): void {
    this.sharedKey = key;
  }

  getAuthorityKey(): string {
    return authorityKey(this.authority);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private ensureAuthority(): void {
    if (this.closed) throw new Error('Embedding storage is closed.');
    assertStorageAuthority(this.authority);
  }

  private refreshSharedKey(): void {
    if (!this.sharedKey) return;
    if (sharedInstances.get(this.sharedKey) === this) {
      sharedInstances.delete(this.sharedKey);
    }
    this.sharedKey = authorityKey(this.authority);
    sharedInstances.set(this.sharedKey, this);
  }

  private unbindSharedInstance(): void {
    if (this.sharedKey && sharedInstances.get(this.sharedKey) === this) {
      sharedInstances.delete(this.sharedKey);
    }
  }

  private invalidate(): void {
    this.dirty = false;
    if (this.db?.open) this.db.close();
    this.closed = true;
    this.unbindSharedInstance();
  }

  private restorePersistedSnapshot(): void {
    this.dirty = false;
    if (this.persistedSnapshot === null) return;

    let restored: Database.Database | null = null;
    try {
      assertStorageAuthority(this.authority);
      restored = this.openDatabase(Buffer.from(this.persistedSnapshot));
      restored.pragma('busy_timeout = 5000');
    } catch (error) {
      restored?.close();
      this.invalidate();
      throw error;
    }

    const rejected = this.db;
    this.db = restored;
    rejected.close();
  }

  private rejectUncommittedMutation(error: unknown): never {
    try {
      this.restorePersistedSnapshot();
    } catch (restoreError) {
      const failureMessage = error instanceof Error
        ? error.message
        : String(error);
      throw new AggregateError(
        [error, restoreError],
        `${failureMessage} The in-memory embedding state was invalidated.`
      );
    }
    throw error;
  }

  private persistSnapshot(): void {
    if (!this.dirty) return;
    let snapshot: Buffer;
    try {
      this.ensureAuthority();
      snapshot = this.dependencies.serializeDatabase
        ? this.dependencies.serializeDatabase(this.db)
        : this.db.serialize();
      if (!Buffer.isBuffer(snapshot)) {
        throw new Error('Embedding snapshot serialization returned invalid bytes.');
      }
    } catch (error) {
      this.rejectUncommittedMutation(error);
    }
    const transactionNonce = randomUUID();
    const temporaryName = `.embeddings.db.${process.pid}.${transactionNonce}.tmp`;
    const temporaryPath = path.join(
      this.authority.storageDirectory,
      temporaryName
    );
    const rollbackName = `.embeddings.db.${process.pid}.${transactionNonce}.rollback`;
    let storageDirectoryDescriptor: number | null = null;
    let descriptor: number | null = null;
    let temporaryIdentity: FileIdentity | null = null;
    let canonicalDescriptor: number | null = null;
    let publicationLock: PublishLock | null = null;
    let rollbackDescriptor: number | null = null;
    let rollbackIdentity: FileIdentity | null = null;
    let rollbackPresent = false;
    let renamed = false;
    let publicationCommitted = false;
    let previousGenerationRestored = true;
    const previousIdentity = { ...this.authority.databaseIdentity };
    let operationError: unknown = null;

    try {
      storageDirectoryDescriptor = openPinnedDirectory(
        this.authority.storageDirectory,
        this.authority.storageDirectoryIdentity
      );
      const flags = fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY;
      descriptor = openFileAt(
        storageDirectoryDescriptor,
        temporaryName,
        flags,
        0o600
      );
      fs.writeFileSync(descriptor, snapshot);
      fs.fsyncSync(descriptor);
      const temporaryStat = fs.fstatSync(descriptor, { bigint: true });
      if (!temporaryStat.isFile() || temporaryStat.nlink !== 1n) {
        throw new Error('Embedding snapshot temporary file lost its private identity.');
      }
      temporaryIdentity = identityOf(temporaryStat);

      canonicalDescriptor = openFileAt(
        storageDirectoryDescriptor,
        'embeddings.db',
        fs.constants.O_RDONLY
      );
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        'embeddings.db',
        canonicalDescriptor,
        previousIdentity,
        1n,
        'Embedding database before rollback snapshot'
      );

      rollbackDescriptor = openFileAt(
        storageDirectoryDescriptor,
        rollbackName,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        0o600
      );
      const rollbackStat = fs.fstatSync(rollbackDescriptor, { bigint: true });
      if (
        !rollbackStat.isFile() ||
        rollbackStat.nlink !== 1n ||
        rollbackStat.size !== 0n
      ) {
        throw new Error('Embedding rollback snapshot lost its private identity.');
      }
      rollbackIdentity = identityOf(rollbackStat);
      rollbackPresent = true;
      this.dependencies.beforeRollbackSnapshotCopy?.();
      const copiedRollbackIdentity = copyVerifiedSnapshot(
        canonicalDescriptor,
        rollbackDescriptor,
        previousIdentity
      );
      if (!sameIdentity(copiedRollbackIdentity, rollbackIdentity)) {
        throw new Error('Embedding rollback snapshot changed while it was copied.');
      }
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        rollbackName,
        rollbackDescriptor,
        rollbackIdentity,
        1n,
        'Embedding rollback snapshot'
      );
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        'embeddings.db',
        canonicalDescriptor,
        previousIdentity,
        1n,
        'Embedding database with private rollback snapshot'
      );
      fsyncDirectory(storageDirectoryDescriptor);

      publicationLock = acquirePublishLock(
        {
          version: 3,
          pid: process.pid,
          nonce: transactionNonce,
          previousDatabaseIdentity: previousIdentity,
          temporaryIdentity,
          rollbackIdentity,
        },
        storageDirectoryDescriptor
      );
      this.dependencies.afterPublishLockAcquired?.();
      assertStorageAuthority(this.authority);
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        rollbackName,
        rollbackDescriptor,
        rollbackIdentity,
        1n,
        'Embedding rollback snapshot'
      );
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        'embeddings.db',
        canonicalDescriptor,
        previousIdentity,
        1n,
        'Embedding database with private rollback snapshot'
      );
      this.dependencies.afterRollbackPinned?.();

      this.dependencies.beforeSnapshotRename?.(temporaryPath);
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        temporaryName,
        descriptor,
        temporaryIdentity,
        1n,
        'Embedding snapshot temporary file'
      );
      renameAt(storageDirectoryDescriptor, temporaryName, 'embeddings.db');
      renamed = true;
      previousGenerationRestored = false;
      fsyncDirectory(storageDirectoryDescriptor);
      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        'embeddings.db',
        descriptor,
        temporaryIdentity,
        1n,
        'Published embedding snapshot'
      );
      this.authority.databaseIdentity = temporaryIdentity;
      assertStorageAuthority(this.authority);
      this.dependencies.afterSnapshotRename?.();

      assertOpenAtIdentity(
        storageDirectoryDescriptor,
        rollbackName,
        rollbackDescriptor,
        rollbackIdentity,
        1n,
        'Embedding rollback snapshot'
      );
      markPublishCommitted(publicationLock, storageDirectoryDescriptor);
      publicationCommitted = true;
      this.persistedSnapshot = Buffer.from(snapshot);
      this.dirty = false;
      this.refreshSharedKey();
      this.dependencies.afterCommitMarker?.();
    } catch (error) {
      operationError = error;
      if (
        !publicationCommitted &&
        storageDirectoryDescriptor !== null &&
        rollbackPresent &&
        rollbackIdentity !== null
      ) {
        try {
          if (renamed) {
            if (temporaryIdentity === null) {
              throw new Error('Published embedding snapshot identity is unavailable for rollback.');
            }
            assertArtifactIdentityAt(
              storageDirectoryDescriptor,
              'embeddings.db',
              temporaryIdentity,
              1n,
              'Failed published embedding snapshot'
            );
            assertArtifactIdentityAt(
              storageDirectoryDescriptor,
              rollbackName,
              rollbackIdentity,
              1n,
              'Embedding rollback snapshot'
            );
            renameAt(storageDirectoryDescriptor, rollbackName, 'embeddings.db');
            rollbackPresent = false;
            renamed = false;
            previousGenerationRestored = true;
            fsyncDirectory(storageDirectoryDescriptor);
            assertArtifactIdentityAt(
              storageDirectoryDescriptor,
              'embeddings.db',
              rollbackIdentity,
              1n,
              'Restored embedding database'
            );
            this.authority.databaseIdentity = rollbackIdentity;
            this.refreshSharedKey();
          } else {
            unlinkVerifiedArtifact(
              storageDirectoryDescriptor,
              rollbackName,
              rollbackIdentity,
              1n,
              'Embedding rollback snapshot'
            );
            rollbackPresent = false;
            fsyncDirectory(storageDirectoryDescriptor);
            this.authority.databaseIdentity = previousIdentity;
            previousGenerationRestored = true;
          }
        } catch (rollbackError) {
          operationError = new AggregateError(
            [operationError, rollbackError],
            'Embedding snapshot publication failed and rollback could not be completed.'
          );
        }
      }
    }

    if (rollbackDescriptor !== null) fs.closeSync(rollbackDescriptor);
    if (canonicalDescriptor !== null) fs.closeSync(canonicalDescriptor);

    let cleanupError: unknown = null;
    if (
      storageDirectoryDescriptor !== null &&
      descriptor !== null &&
      temporaryIdentity === null
    ) {
      try {
        const stat = fs.fstatSync(descriptor, { bigint: true });
        if (stat.isFile() && stat.nlink === 1n) {
          temporaryIdentity = identityOf(stat);
        }
      } catch (error) {
        cleanupError = error;
      }
    }

    if (storageDirectoryDescriptor !== null && temporaryIdentity !== null) {
      try {
        if (statArtifactAtIfPresent(storageDirectoryDescriptor, temporaryName)) {
          unlinkVerifiedArtifact(
            storageDirectoryDescriptor,
            temporaryName,
            temporaryIdentity,
            1n,
            'Embedding snapshot temporary file'
          );
          fsyncDirectory(storageDirectoryDescriptor);
        }
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError(
            [cleanupError, error],
            'Embedding snapshot temporary cleanup encountered multiple failures.'
          )
          : error;
      }
    }
    if (descriptor !== null) fs.closeSync(descriptor);

    if (
      publicationCommitted &&
      storageDirectoryDescriptor !== null &&
      rollbackPresent &&
      rollbackIdentity !== null
    ) {
      try {
        unlinkVerifiedArtifact(
          storageDirectoryDescriptor,
          rollbackName,
          rollbackIdentity,
          1n,
          'Embedding rollback snapshot after commit'
        );
        rollbackPresent = false;
        fsyncDirectory(storageDirectoryDescriptor);
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError(
            [cleanupError, error],
            'Committed embedding publication cleanup encountered multiple failures.'
          )
          : error;
      }
    }

    if (publicationLock && storageDirectoryDescriptor !== null) {
      if (!rollbackPresent && cleanupError === null) {
        try {
          releasePublishLock(publicationLock, storageDirectoryDescriptor);
        } catch (error) {
          cleanupError = error;
        }
      } else {
        fs.closeSync(publicationLock.descriptor);
      }
      publicationLock = null;
    }
    if (storageDirectoryDescriptor !== null) {
      fs.closeSync(storageDirectoryDescriptor);
    }

    let finalError: unknown = operationError ?? cleanupError;
    if (operationError && cleanupError) {
      const operationMessage = operationError instanceof Error
        ? operationError.message
        : String(operationError);
      finalError = new AggregateError(
        [operationError, cleanupError],
        `${operationMessage} Publication cleanup could not be completed.`
      );
    }
    if (publicationCommitted) {
      if (finalError) {
        console.error(
          '[mcp-obsidian] Embedding snapshot committed, but publication cleanup failed; restart is required:',
          finalError
        );
        try {
          this.invalidate();
        } catch (invalidateError) {
          console.error(
            '[mcp-obsidian] Committed embedding storage could not be invalidated cleanly:',
            invalidateError
          );
        }
      }
      return;
    }
    if (finalError) {
      if (!previousGenerationRestored) {
        try {
          this.invalidate();
        } catch (invalidateError) {
          finalError = new AggregateError(
            [finalError, invalidateError],
            'Embedding publication failed without a verified rollback and invalidation also failed.'
          );
        }
        throw finalError;
      }
      this.rejectUncommittedMutation(finalError);
    }
  }

  private assertMutationAllowed(): void {
    this.ensureAuthority();
    if (
      this.batchOwner !== null &&
      this.batchContext.getStore() !== this.batchOwner
    ) {
      throw new Error('Embedding storage mutation is blocked by another active batch.');
    }
  }

  private recordMutation(): void {
    this.dirty = true;
    if (this.batchOwner === null) this.persistSnapshot();
  }

  async runBatch<T>(task: () => Promise<T>): Promise<T> {
    this.ensureAuthority();
    const activeContext = this.batchContext.getStore();
    if (this.batchOwner !== null) {
      if (activeContext !== this.batchOwner) {
        throw new Error('Embedding storage batch is already owned by another operation.');
      }
      return task();
    }

    if (this.dirty) {
      throw new Error('Embedding storage cannot start a batch with unpublished mutations.');
    }

    const owner = Symbol('embedding-storage-batch');
    this.batchOwner = owner;
    return this.batchContext.run(owner, async () => {
      let result!: T;
      try {
        result = await task();
      } catch (error) {
        try {
          if (this.dirty) this.restorePersistedSnapshot();
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'Embedding storage batch failed and the in-memory state was invalidated.'
          );
        }
        throw error;
      } finally {
        this.batchOwner = null;
      }
      if (this.dirty) this.persistSnapshot();
      return result;
    });
  }

  assertVaultRoot(vault: string | PinnedVaultRoot): void {
    const vaultRoot = normalizeVaultRoot(vault);
    if (
      this.authority.vaultRoot.path !== vaultRoot.path ||
      this.authority.vaultRoot.device !== vaultRoot.device ||
      this.authority.vaultRoot.inode !== vaultRoot.inode
    ) {
      throw new Error('Embedding storage does not belong to the pinned vault root.');
    }
    this.ensureAuthority();
  }

  /**
   * Initialize database schema
   */
  private initialize(): boolean {
    let changed = false;
    this.db.pragma('busy_timeout = 5000');

    // Check if we need to migrate from old schema
    const tableExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
    ).get();

    if (tableExists) {
      // Check if we need to add the new unique index
      const hasNewIndex = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_unique_file_block'"
      ).get();

      if (!hasNewIndex) {
        // The old UNIQUE(file_path, block_id) did not deduplicate NULL block IDs.
        this.db.exec(`
          DELETE FROM embeddings WHERE id NOT IN (
            SELECT MIN(id) FROM embeddings
            GROUP BY file_path, COALESCE(block_id, '')
          );
        `);
        // Drop old constraint by recreating table (SQLite limitation)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS embeddings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            block_id TEXT DEFAULT '',
            content_hash TEXT NOT NULL,
            embedding BLOB NOT NULL,
            metadata TEXT,
            updated_at INTEGER NOT NULL
          );

          INSERT INTO embeddings_new (id, file_path, block_id, content_hash, embedding, metadata, updated_at)
          SELECT id, file_path, COALESCE(block_id, ''), content_hash, embedding, metadata, updated_at
          FROM embeddings;

          DROP TABLE embeddings;
          ALTER TABLE embeddings_new RENAME TO embeddings;

          CREATE UNIQUE INDEX idx_unique_file_block ON embeddings(file_path, block_id);
          CREATE INDEX IF NOT EXISTS idx_file_path ON embeddings(file_path);
          CREATE INDEX IF NOT EXISTS idx_content_hash ON embeddings(content_hash);
          CREATE INDEX IF NOT EXISTS idx_updated_at ON embeddings(updated_at);
        `);
        changed = true;
        console.error('[mcp-obsidian] Migrated embeddings table to fix duplicate bug');
      }
    } else {
      // Fresh install - create with correct schema
      this.db.exec(`
        CREATE TABLE embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          block_id TEXT DEFAULT '',
          content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          metadata TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX idx_unique_file_block ON embeddings(file_path, block_id);
        CREATE INDEX idx_file_path ON embeddings(file_path);
        CREATE INDEX idx_content_hash ON embeddings(content_hash);
        CREATE INDEX idx_updated_at ON embeddings(updated_at);
      `);
      changed = true;
    }

    // Create FTS5 table for keyword search (hybrid search)
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='content_fts'"
    ).get();
    if (!ftsExists) {
      this.db.exec(`
      CREATE VIRTUAL TABLE content_fts USING fts5(
        file_path,
        block_id,
        content,
        tokenize='porter unicode61'
      );
    `);
      changed = true;
    }
    return changed;
  }

  /**
   * Store an embedding (and optionally content for FTS)
   */
  store(
    filePath: string,
    embedding: number[],
    contentHash: string,
    metadata: Record<string, unknown> = {},
    blockId: string | null = null,
    content?: string  // Optional content for FTS indexing
  ): void {
    this.assertMutationAllowed();
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
    // Use empty string instead of NULL to make UNIQUE constraint work
    const normalizedBlockId = blockId || '';

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (file_path, block_id, content_hash, embedding, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      stmt.run(
        filePath,
        normalizedBlockId,
        contentHash,
        embeddingBlob,
        JSON.stringify(metadata),
        Date.now()
      );

      // Also store in FTS if content provided
      if (content) {
        this.db.prepare(`
          DELETE FROM content_fts WHERE file_path = ? AND block_id = ?
        `).run(filePath, normalizedBlockId);

        this.db.prepare(`
          INSERT INTO content_fts (file_path, block_id, content)
          VALUES (?, ?, ?)
        `).run(filePath, normalizedBlockId, content);
      }
    })();
    this.recordMutation();
  }

  /**
   * Get embedding for a file (or any section of it)
   * When blockId is null, tries '' first (whole file), then returns the first section found.
   */
  get(filePath: string, blockId: string | null = null): StoredEmbedding | null {
    this.ensureAuthority();
    const normalizedBlockId = blockId || '';
    const stmt = this.db.prepare(`
      SELECT * FROM embeddings WHERE file_path = ? AND block_id = ?
    `);

    let row = stmt.get(filePath, normalizedBlockId) as {
      id: number;
      file_path: string;
      block_id: string;
      content_hash: string;
      embedding: Buffer;
      metadata: string;
      updated_at: number;
    } | undefined;

    // Fix for get_similar: if looking for whole-file embedding but file is chunked,
    // fall back to the first section's embedding
    if (!row && normalizedBlockId === '') {
      row = this.db.prepare(`
        SELECT * FROM embeddings WHERE file_path = ? ORDER BY id ASC LIMIT 1
      `).get(filePath) as typeof row;
    }

    if (!row) return null;

    return {
      id: row.id,
      filePath: row.file_path,
      blockId: row.block_id || null,  // Return null for empty string for API consistency
      contentHash: row.content_hash,
      embedding: Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)),
      metadata: JSON.parse(row.metadata || '{}'),
      updatedAt: row.updated_at
    };
  }

  /**
   * Check if embedding exists and is up to date
   */
  isUpToDate(filePath: string, contentHash: string, blockId: string | null = null): boolean {
    this.ensureAuthority();
    const normalizedBlockId = blockId || '';
    const stmt = this.db.prepare(`
      SELECT content_hash FROM embeddings
      WHERE file_path = ? AND block_id = ?
    `);

    const row = stmt.get(filePath, normalizedBlockId) as { content_hash: string } | undefined;
    return row?.content_hash === contentHash;
  }

  /**
   * Verify the complete canonical embedding + FTS manifest for one source file.
   * Compatibility aliases must be absent for the cache to be reusable.
   */
  matchesFileManifest(
    filePath: string,
    aliases: string[],
    expected: FileEmbeddingManifestEntry[],
    modelIdentity: string
  ): boolean {
    this.ensureAuthority();
    const paths = [...new Set([filePath, ...aliases].filter(Boolean))];
    const placeholders = paths.map(() => '?').join(', ');
    const embeddingRows = this.db.prepare(`
      SELECT file_path, block_id, content_hash, metadata, LENGTH(embedding) AS embedding_bytes
      FROM embeddings
      WHERE file_path IN (${placeholders})
      ORDER BY file_path, block_id
    `).all(...paths) as Array<{
      file_path: string;
      block_id: string;
      content_hash: string;
      metadata: string;
      embedding_bytes: number;
    }>;
    const ftsRows = this.db.prepare(`
      SELECT file_path, block_id, content
      FROM content_fts
      WHERE file_path IN (${placeholders})
      ORDER BY file_path, block_id
    `).all(...paths) as Array<{
      file_path: string;
      block_id: string;
      content: string;
    }>;

    if (embeddingRows.length !== expected.length || ftsRows.length !== expected.length) {
      return false;
    }

    const expectedByBlock = new Map(expected.map(entry => [entry.blockId || '', entry]));
    if (expectedByBlock.size !== expected.length) return false;

    for (const row of embeddingRows) {
      if (row.file_path !== filePath || row.embedding_bytes <= 0) return false;
      const entry = expectedByBlock.get(row.block_id);
      if (!entry || entry.contentHash !== row.content_hash) return false;
      try {
        const metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
        if (metadata.modelIdentity !== modelIdentity) return false;
      } catch {
        return false;
      }
    }

    for (const row of ftsRows) {
      if (row.file_path !== filePath) return false;
      const entry = expectedByBlock.get(row.block_id);
      if (!entry || entry.content !== row.content) return false;
    }
    return true;
  }

  /** Replace canonical and alias rows as one embeddings + FTS transaction. */
  replaceFileEmbeddings(
    filePath: string,
    aliases: string[],
    replacements: FileEmbeddingReplacement[]
  ): void {
    this.assertMutationAllowed();
    const paths = [...new Set([filePath, ...aliases].filter(Boolean))];
    const normalized = replacements.map(replacement => ({
      ...replacement,
      blockId: replacement.blockId || '',
      embeddingBlob: Buffer.from(new Float32Array(replacement.embedding).buffer),
      serializedMetadata: JSON.stringify(replacement.metadata),
    }));
    const blockIds = new Set(normalized.map(replacement => replacement.blockId));
    if (blockIds.size !== normalized.length) {
      throw new Error('Embedding replacement contains duplicate block IDs.');
    }
    if (normalized.some(replacement => replacement.embedding.length === 0)) {
      throw new Error('Embedding replacement contains an empty vector.');
    }

    const deleteEmbeddings = this.db.prepare('DELETE FROM embeddings WHERE file_path = ?');
    const deleteFts = this.db.prepare('DELETE FROM content_fts WHERE file_path = ?');
    const insertEmbedding = this.db.prepare(`
      INSERT INTO embeddings (file_path, block_id, content_hash, embedding, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO content_fts (file_path, block_id, content)
      VALUES (?, ?, ?)
    `);
    const updatedAt = Date.now();

    this.db.transaction(() => {
      for (const oldPath of paths) {
        deleteEmbeddings.run(oldPath);
        deleteFts.run(oldPath);
      }
      for (const replacement of normalized) {
        insertEmbedding.run(
          filePath,
          replacement.blockId,
          replacement.contentHash,
          replacement.embeddingBlob,
          replacement.serializedMetadata,
          updatedAt
        );
        insertFts.run(filePath, replacement.blockId, replacement.content);
      }
    })();
    this.recordMutation();
  }

  /**
   * Delete embeddings for a file
   */
  delete(filePath: string): void {
    this.assertMutationAllowed();
    const deleteEmbeddings = this.db.prepare('DELETE FROM embeddings WHERE file_path = ?');
    const deleteFts = this.db.prepare('DELETE FROM content_fts WHERE file_path = ?');
    this.db.transaction(() => {
      deleteEmbeddings.run(filePath);
      deleteFts.run(filePath);
    })();
    this.recordMutation();
  }

  getIndexedFilePaths(): string[] {
    this.ensureAuthority();
    const rows = this.db.prepare(`
      SELECT file_path FROM embeddings
      UNION
      SELECT file_path FROM content_fts
      ORDER BY file_path
    `).all() as Array<{ file_path: string }>;
    return rows.map(row => row.file_path);
  }

  /**
   * Delete all embeddings
   */
  clear(): void {
    this.assertMutationAllowed();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM embeddings');
      this.db.exec('DELETE FROM content_fts');
    })();
    this.recordMutation();
  }

  /**
   * Get all embeddings (for similarity search)
   * Filters out empty embeddings that would cause dimension mismatch
   */
  getAll(): StoredEmbedding[] {
    this.ensureAuthority();
    // Only get embeddings with actual content (non-empty blobs)
    const stmt = this.db.prepare('SELECT * FROM embeddings WHERE LENGTH(embedding) > 0');
    const rows = stmt.all() as Array<{
      id: number;
      file_path: string;
      block_id: string;
      content_hash: string;
      embedding: Buffer;
      metadata: string;
      updated_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      filePath: row.file_path,
      blockId: row.block_id || null,  // Return null for empty string for API consistency
      contentHash: row.content_hash,
      embedding: Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)),
      metadata: JSON.parse(row.metadata || '{}'),
      updatedAt: row.updated_at
    }));
  }

  /**
   * Search for similar embeddings (semantic search)
   */
  search(queryEmbedding: number[], limit: number = 10, minSimilarity: number = 0): SearchResult[] {
    const allEmbeddings = this.getAll();

    const results: SearchResult[] = allEmbeddings
      .map(stored => ({
        filePath: stored.filePath,
        blockId: stored.blockId,
        similarity: cosineSimilarity(queryEmbedding, stored.embedding),
        metadata: stored.metadata
      }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return results;
  }

  /**
   * Search only the exact model generation and vector dimension used by the
   * current query. Rows from interrupted migrations remain visible in the
   * compatibility receipt but cannot enter the ranking.
   */
  searchCompatible(
    queryEmbedding: number[],
    modelIdentity: string,
    limit: number = 10,
    minSimilarity: number = 0
  ): CompatibleSearchResults {
    this.ensureAuthority();
    assertValidEmbeddingVector(queryEmbedding, 'Query embedding');
    const rows = this.db.prepare(`
      SELECT file_path, block_id, embedding, metadata
      FROM embeddings
    `).all() as Array<{
      file_path: string;
      block_id: string;
      embedding: Buffer;
      metadata: string;
    }>;
    const compatible: Array<{
      filePath: string;
      blockId: string | null;
      embedding: number[];
      metadata: Record<string, unknown>;
    }> = [];
    const excludedFiles = new Set<string>();
    const expectedBytes = queryEmbedding.length * Float32Array.BYTES_PER_ELEMENT;

    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.metadata || '{}') as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed legacy metadata is an incompatible row, not a search failure.
      }
      if (
        metadata.modelIdentity !== modelIdentity ||
        row.embedding.length !== expectedBytes
      ) {
        excludedFiles.add(row.file_path);
        continue;
      }
      const embedding = Array.from(new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.length / Float32Array.BYTES_PER_ELEMENT
      ));
      if (!isValidEmbeddingVector(embedding)) {
        excludedFiles.add(row.file_path);
        continue;
      }
      compatible.push({
        filePath: row.file_path,
        blockId: row.block_id || null,
        embedding,
        metadata,
      });
    }

    const results = compatible
      .map(stored => ({
        filePath: stored.filePath,
        blockId: stored.blockId,
        similarity: cosineSimilarity(queryEmbedding, stored.embedding),
        metadata: stored.metadata,
      }))
      .filter(result => result.similarity >= minSimilarity)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
    const excludedEmbeddingCount = rows.length - compatible.length;

    return {
      results,
      compatibility: {
        state: excludedEmbeddingCount === 0 ? 'complete' : 'partial',
        modelIdentity,
        embeddingDimension: queryEmbedding.length,
        totalEmbeddingCount: rows.length,
        compatibleEmbeddingCount: compatible.length,
        excludedEmbeddingCount,
        excludedFileCount: excludedFiles.size,
        reindexRequired: excludedEmbeddingCount > 0,
      },
    };
  }

  /**
   * Fetch the full passage TEXT for a candidate by (file_path, block_id).
   *
   * Used by the reranker SEAM (issue #27): the fused top-K candidates are keyed
   * by `${filePath}:${blockId}`, and the reranker must score the REAL passage
   * text (the full chunk stored in content_fts), not the 200-char preview.
   * `blockId` is normalized to '' (whole-file) the same way `store` writes it.
   * Returns null when no FTS row exists (e.g. content was never passed to store).
   */
  getContent(filePath: string, blockId: string | null = null): string | null {
    this.ensureAuthority();
    const normalizedBlockId = blockId || '';
    const row = this.db.prepare(`
      SELECT content FROM content_fts WHERE file_path = ? AND block_id = ?
    `).get(filePath, normalizedBlockId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /**
   * Keyword search result
   */
  keywordSearch(query: string, limit: number = 10): Array<{
    filePath: string;
    blockId: string | null;
    score: number;
  }> {
    this.ensureAuthority();
    try {
      // FTS5 MATCH query - sanitize to prevent operator injection.
      // Strip quotes, then wrap each word in double quotes to treat as literals,
      // neutralizing FTS5 operators (AND, OR, NOT, NEAR) and column filters.
      const words = query
        .replace(/['"]/g, '')
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_\-]/g, ''))  // strip special chars
        .filter(w => w.length > 0 && w.length < 100);  // drop empty/absurd tokens
      if (words.length === 0) return [];
      // Each word quoted as literal — FTS5 operators like NEAR/AND/OR are neutralized
      const sanitizedQuery = words.map(w => `"${w}"`).join(' ');

      const rows = this.db.prepare(`
        SELECT file_path, block_id, bm25(content_fts) as score
        FROM content_fts
        WHERE content_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(sanitizedQuery, limit) as Array<{
        file_path: string;
        block_id: string;
        score: number;
      }>;

      return rows.map(row => ({
        filePath: row.file_path,
        blockId: row.block_id || null,
        score: Math.abs(row.score)  // BM25 returns negative scores, lower is better
      }));
    } catch {
      // FTS query syntax error - return empty
      return [];
    }
  }

  /** Keyword search constrained to the same exact embedding cohort. */
  keywordSearchCompatible(
    query: string,
    modelIdentity: string,
    embeddingDimension: number,
    limit: number = 10
  ): Array<{
    filePath: string;
    blockId: string | null;
    score: number;
  }> {
    this.ensureAuthority();
    if (!Number.isSafeInteger(embeddingDimension) || embeddingDimension <= 0) {
      throw new Error('Embedding dimension must be a positive safe integer.');
    }
    try {
      const words = query
        .replace(/['"]/g, '')
        .split(/\s+/)
        .map(word => word.replace(/[^a-zA-Z0-9_\-]/g, ''))
        .filter(word => word.length > 0 && word.length < 100);
      if (words.length === 0) return [];
      const sanitizedQuery = words.map(word => `"${word}"`).join(' ');
      const embeddingBytes = embeddingDimension * Float32Array.BYTES_PER_ELEMENT;
      const boundedLimit = Math.max(0, Math.ceil(limit));
      if (boundedLimit === 0) return [];
      const batchSize = Math.max(50, Math.min(1_000, boundedLimit * 2));
      const statement = this.db.prepare(`
        SELECT content_fts.file_path, content_fts.block_id,
               bm25(content_fts) as score, embeddings.embedding
        FROM content_fts
        JOIN embeddings
          ON embeddings.file_path = content_fts.file_path
         AND embeddings.block_id = content_fts.block_id
        WHERE content_fts MATCH ?
          AND LENGTH(embeddings.embedding) = ?
          AND CASE
                WHEN json_valid(embeddings.metadata)
                THEN json_extract(embeddings.metadata, '$.modelIdentity')
                ELSE NULL
              END = ?
        ORDER BY score
        LIMIT ? OFFSET ?
      `);
      const results: Array<{
        filePath: string;
        blockId: string | null;
        score: number;
      }> = [];
      let offset = 0;

      while (results.length < boundedLimit) {
        const rows = statement.all(
          sanitizedQuery,
          embeddingBytes,
          modelIdentity,
          batchSize,
          offset
        ) as Array<{
          file_path: string;
          block_id: string;
          score: number;
          embedding: Buffer;
        }>;
        for (const row of rows) {
          const embedding = Array.from(new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.length / Float32Array.BYTES_PER_ELEMENT
          ));
          if (!isValidEmbeddingVector(embedding)) continue;
          results.push({
            filePath: row.file_path,
            blockId: row.block_id || null,
            score: Math.abs(row.score),
          });
          if (results.length === boundedLimit) break;
        }
        offset += rows.length;
        if (rows.length < batchSize) break;
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Get statistics
   */
  getStats(): { totalEmbeddings: number; uniqueFiles: number; lastUpdated: number | null } {
    this.ensureAuthority();
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM embeddings');
    const filesStmt = this.db.prepare('SELECT COUNT(DISTINCT file_path) as count FROM embeddings');
    const lastUpdatedStmt = this.db.prepare('SELECT MAX(updated_at) as last FROM embeddings');

    const count = (countStmt.get() as { count: number }).count;
    const files = (filesStmt.get() as { count: number }).count;
    const lastUpdated = (lastUpdatedStmt.get() as { last: number | null }).last;

    return {
      totalEmbeddings: count,
      uniqueFiles: files,
      lastUpdated
    };
  }

  /**
   * Get per-indexed-path row counts for coverage accounting.
   */
  getPathStats(): EmbeddingPathStat[] {
    this.ensureAuthority();
    const rows = this.db.prepare(`
      SELECT file_path as filePath, COUNT(*) as embeddingChunks
      FROM embeddings
      GROUP BY file_path
      ORDER BY file_path
    `).all() as Array<{ filePath: string; embeddingChunks: number }>;

    return rows.map(row => ({
      filePath: row.filePath,
      embeddingChunks: row.embeddingChunks
    }));
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.closed) return;
    if (this.batchOwner !== null) {
      throw new Error('Embedding storage cannot close while a batch is active.');
    }
    let persistError: unknown;
    try {
      if (this.dirty) this.persistSnapshot();
    } catch (error) {
      persistError = error;
    } finally {
      this.db.close();
      this.closed = true;
      this.unbindSharedInstance();
    }
    if (persistError) throw persistError;
  }
}
