/**
 * Content digest for the session-scoped graph cache.
 *
 * The base graph is cached by `vault + graph-version`, where graph-version is a
 * digest over the vault's markdown paths and bytes. Any add/remove/edit changes
 * the digest even when size and timestamps are preserved. There is no persistent
 * store or watcher.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { abortableYield, throwIfAborted } from '../cli/vault-target.js';

const DIGEST_DOMAIN = Buffer.from('mycelium-graph-digest-v2', 'utf8');

function updateFrame(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

/**
 * Walk the vault for .md files and accumulate a stable digest of their paths and
 * content. Hidden files and dotfolders (.obsidian) are skipped to
 * mirror the rest of the codebase.
 */
export async function computeGraphDigest(
  vaultPath: string,
  signal?: AbortSignal
): Promise<string> {
  const files: string[] = [];
  let visitedEntries = 0;

  async function walk(dir: string): Promise<void> {
    throwIfAborted(signal);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      visitedEntries += 1;
      if (signal && visitedEntries % 256 === 0) await abortableYield(signal);
      else throwIfAborted(signal);
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile() && d.name.endsWith('.md')) {
        files.push(path.relative(vaultPath, full));
      }
    }
  }

  await walk(vaultPath);
  throwIfAborted(signal);
  files.sort();
  const h = createHash('sha256');
  updateFrame(h, DIGEST_DOMAIN);
  for (let index = 0; index < files.length; index += 1) {
    if (signal && index % 128 === 0) await abortableYield(signal);
    else throwIfAborted(signal);
    const rel = files[index];
    const pathBytes = Buffer.from(rel, 'utf8');
    let content: Buffer;
    try {
      content = await fs.readFile(path.join(vaultPath, rel), { signal });
    } catch (error) {
      throwIfAborted(signal);
      throw new Error('Vault graph content could not be read completely.', {
        cause: error
      });
    }
    updateFrame(h, pathBytes);
    updateFrame(h, content);
  }
  return h.digest('hex');
}

/**
 * Deterministic hash of an exclusion predicate so ranked signals can be cached
 * per (vault + graph-version + exclude-hash). Order-insensitive over conditions
 * is NOT required — we hash the JSON as-given, which is stable for a given call.
 */
export function hashExclude(value: unknown): string {
  const h = createHash('sha1');
  h.update(JSON.stringify(value ?? null));
  return h.digest('hex');
}
