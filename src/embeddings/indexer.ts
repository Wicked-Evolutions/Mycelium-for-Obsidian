import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { AsyncLocalStorage } from 'async_hooks';
import { resolvePathInVault, verifyFileHandleInVault } from '../config.js';
import { chunkMarkdownForEmbedding, EmbeddingChunk } from './chunking.js';
import {
  assertEmbeddingResultIdentity,
  assertOllamaModelIdentity,
  assertValidEmbeddingVector,
  EmbeddingModelProfile,
  generateEmbedding as generateOllamaEmbedding,
  OllamaConfig,
  resolveEmbeddingModelConfig,
} from './ollama.js';
import { EmbeddingStorage, FileEmbeddingReplacement } from './storage.js';
import {
  assertPinnedVaultRoot,
  PinnedVaultRoot,
} from './vault-root.js';

export interface IndexMarkdownFileOptions {
  vaultRoot: PinnedVaultRoot;
  filePath: string;
  aliases?: string[];
  storage: EmbeddingStorage;
  ollama: OllamaConfig;
  profile: EmbeddingModelProfile;
  force?: boolean;
  metadata?: Record<string, unknown>;
}

export interface IndexMarkdownFileResult {
  status: 'indexed' | 'skipped';
  sections: number;
  chunks: EmbeddingChunk[];
}

interface IndexMarkdownFileDependencies {
  generateEmbedding?: typeof generateOllamaEmbedding;
  assertModelIdentity?: typeof assertOllamaModelIdentity;
}

interface VerifiedSource {
  content: string;
  identity: string;
}

const fileLocks = new Map<string, Promise<void>>();
const vaultLocks = new Map<string, Promise<void>>();
const activeVaultLockOwners = new Map<string, symbol>();
const vaultLockContext = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  fileLocks.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

function vaultLockKey(vaultRoot: PinnedVaultRoot): string {
  return [vaultRoot.path, vaultRoot.device, vaultRoot.inode].join('\u0000');
}

/** Serialize index mutations for one pinned vault, while allowing nested indexer calls. */
export async function withVaultIndexLock<T>(
  vaultRoot: PinnedVaultRoot,
  task: () => Promise<T>
): Promise<T> {
  const key = vaultLockKey(vaultRoot);
  const held = vaultLockContext.getStore();
  const inheritedOwner = held?.get(key);
  if (inheritedOwner && activeVaultLockOwners.get(key) === inheritedOwner) {
    return task();
  }

  const previous = vaultLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  vaultLocks.set(key, tail);
  await previous;

  const owner = Symbol('vault-index-lock');
  activeVaultLockOwners.set(key, owner);
  const next = new Map(held ?? []);
  next.set(key, owner);
  try {
    return await vaultLockContext.run(next, task);
  } finally {
    if (activeVaultLockOwners.get(key) === owner) {
      activeVaultLockOwners.delete(key);
    }
    release();
    if (vaultLocks.get(key) === tail) vaultLocks.delete(key);
  }
}

async function readVerifiedSource(
  vaultRoot: PinnedVaultRoot,
  filePath: string
): Promise<VerifiedSource> {
  await assertPinnedVaultRoot(vaultRoot);
  const absolutePath = resolvePathInVault(vaultRoot.path, filePath);
  const handle = await fs.open(absolutePath, 'r');
  try {
    const realPath = await verifyFileHandleInVault(handle, absolutePath, vaultRoot.path);
    const stat = await handle.stat({ bigint: true });
    if (stat.size > BigInt(50 * 1024 * 1024)) {
      throw new Error('File exceeds the 50 MB embedding index limit.');
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    return {
      content,
      identity: `${realPath}\u0000${stat.dev.toString()}\u0000${stat.ino.toString()}`,
    };
  } finally {
    await handle.close();
  }
}

function modelIdentity(profile: EmbeddingModelProfile): string {
  return `${profile.name}@${profile.digest}`;
}

function sourceChanged(before: VerifiedSource, after: VerifiedSource): boolean {
  return before.identity !== after.identity || before.content !== after.content;
}

/**
 * Build and atomically replace one Markdown file's complete embedding manifest.
 * Provider work occurs before the verified post-read and SQLite transaction.
 */
export async function indexMarkdownFile(
  options: IndexMarkdownFileOptions,
  dependencies: IndexMarkdownFileDependencies = {}
): Promise<IndexMarkdownFileResult> {
  const lockKey = `${options.vaultRoot.path}\u0000${options.filePath}`;
  const generateEmbedding = dependencies.generateEmbedding ?? generateOllamaEmbedding;
  const assertModelIdentity = dependencies.assertModelIdentity ?? assertOllamaModelIdentity;
  const aliases = [...new Set((options.aliases ?? [])
    .filter(alias => alias && alias !== options.filePath))];
  const identity = modelIdentity(options.profile);
  const embeddingConfig = resolveEmbeddingModelConfig(options.ollama, options.profile);

  options.storage.assertVaultRoot(options.vaultRoot);

  return withVaultIndexLock(options.vaultRoot, () => withFileLock(lockKey, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await readVerifiedSource(options.vaultRoot, options.filePath);
      const chunks = chunkMarkdownForEmbedding(
        before.content,
        options.profile.maxInputBytes
      );
      const expected = chunks.map(chunk => ({
        blockId: chunk.blockId,
        contentHash: hashContent(chunk.embeddingText),
        content: chunk.embeddingText,
      }));

      if (
        !options.force &&
        options.storage.matchesFileManifest(
          options.filePath,
          aliases,
          expected,
          identity
        )
      ) {
        const after = await readVerifiedSource(options.vaultRoot, options.filePath);
        if (sourceChanged(before, after)) {
          if (attempt === 0) continue;
          throw new Error('Source file changed during embedding twice; no cache result was reused.');
        }
        await assertPinnedVaultRoot(options.vaultRoot);
        options.storage.assertVaultRoot(options.vaultRoot);
        await assertModelIdentity(options.ollama, options.profile);
        return { status: 'skipped', sections: chunks.length, chunks };
      }

      const indexedAt = new Date().toISOString();
      const replacements: FileEmbeddingReplacement[] = [];
      let embeddingDimension: number | null = null;
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (Buffer.byteLength(chunk.embeddingText, 'utf8') > options.profile.maxInputBytes) {
          throw new Error('Embedding chunk exceeded the verified model input budget.');
        }
        const result = await generateEmbedding(chunk.embeddingText, embeddingConfig);
        assertValidEmbeddingVector(result.embedding, 'Ollama');
        assertEmbeddingResultIdentity(result, options.profile);
        if (embeddingDimension === null) {
          embeddingDimension = result.embedding.length;
        } else if (result.embedding.length !== embeddingDimension) {
          throw new Error('Ollama embedding dimensions changed while indexing one file.');
        }
        replacements.push({
          blockId: chunk.blockId,
          contentHash: expected[index].contentHash,
          embedding: result.embedding,
          content: chunk.embeddingText,
          metadata: {
            ...options.metadata,
            indexedAt,
            heading: chunk.heading,
            level: chunk.level,
            startLine: chunk.startLine,
            chunked: chunk.blockId !== null,
            chunkIndex: chunk.chunkIndex,
            chunkCount: chunk.chunkCount,
            model: options.profile.name,
            modelDigest: options.profile.digest,
            modelIdentity: identity,
          },
        });
      }

      const after = await readVerifiedSource(options.vaultRoot, options.filePath);
      if (sourceChanged(before, after)) {
        if (attempt === 0) continue;
        throw new Error('Source file changed during embedding twice; no index rows were replaced.');
      }

      await assertPinnedVaultRoot(options.vaultRoot);
      await assertModelIdentity(options.ollama, options.profile);
      options.storage.replaceFileEmbeddings(options.filePath, aliases, replacements);
      return { status: 'indexed', sections: chunks.length, chunks };
    }

    throw new Error('Source file could not be indexed consistently.');
  }));
}

export interface DeleteIndexedFileOptions {
  vaultRoot: PinnedVaultRoot;
  filePath: string;
  storage: EmbeddingStorage;
}

async function sourceFileExists(
  vaultRoot: PinnedVaultRoot,
  filePath: string
): Promise<boolean> {
  let absolutePath: string;
  try {
    absolutePath = resolvePathInVault(vaultRoot.path, filePath);
  } catch {
    return false;
  }

  try {
    return (await fs.stat(absolutePath)).isFile();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

/** Delete one absent source through the same canonical per-file lock as indexing. */
export async function deleteIndexedFile(
  options: DeleteIndexedFileOptions
): Promise<boolean> {
  const lockKey = `${options.vaultRoot.path}\u0000${options.filePath}`;
  options.storage.assertVaultRoot(options.vaultRoot);

  return withVaultIndexLock(options.vaultRoot, () => withFileLock(lockKey, async () => {
    await assertPinnedVaultRoot(options.vaultRoot);
    if (await sourceFileExists(options.vaultRoot, options.filePath)) return false;
    await assertPinnedVaultRoot(options.vaultRoot);
    options.storage.delete(options.filePath);
    return true;
  }));
}

/** Remove stale embedding and FTS rows without racing same-file indexing. */
export async function deleteStaleIndexedFiles(
  vaultRoot: PinnedVaultRoot,
  storage: EmbeddingStorage
): Promise<number> {
  return withVaultIndexLock(vaultRoot, async () => {
    let removed = 0;
    for (const filePath of storage.getIndexedFilePaths()) {
      if (await deleteIndexedFile({ vaultRoot, filePath, storage })) removed += 1;
    }
    return removed;
  });
}
