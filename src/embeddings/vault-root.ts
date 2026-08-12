import * as fs from 'fs';
import * as fsp from 'fs/promises';

export interface PinnedVaultRoot {
  path: string;
  device: string;
  inode: string;
}

function pinnedRoot(
  canonicalPath: string,
  stat: fs.BigIntStats
): PinnedVaultRoot {
  if (!stat.isDirectory()) {
    throw new Error('The configured vault root is not a directory.');
  }
  return {
    path: canonicalPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

export async function pinVaultRoot(vaultPath: string): Promise<PinnedVaultRoot> {
  const canonicalPath = await fsp.realpath(vaultPath);
  const stat = await fsp.stat(canonicalPath, { bigint: true });
  return pinnedRoot(canonicalPath, stat);
}

export function pinVaultRootSync(vaultPath: string): PinnedVaultRoot {
  const canonicalPath = fs.realpathSync(vaultPath);
  const stat = fs.statSync(canonicalPath, { bigint: true });
  return pinnedRoot(canonicalPath, stat);
}

export function assertPinnedVaultRootSync(root: PinnedVaultRoot): void {
  try {
    const canonicalPath = fs.realpathSync(root.path);
    const stat = fs.statSync(root.path, { bigint: true });
    if (
      canonicalPath !== root.path ||
      !stat.isDirectory() ||
      stat.dev.toString() !== root.device ||
      stat.ino.toString() !== root.inode
    ) {
      throw new Error('Pinned vault root identity changed during indexing.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Pinned vault root identity changed')) {
      throw error;
    }
    throw new Error('Pinned vault root identity changed during indexing.');
  }
}

export async function assertPinnedVaultRoot(root: PinnedVaultRoot): Promise<void> {
  try {
    const [canonicalPath, stat] = await Promise.all([
      fsp.realpath(root.path),
      fsp.stat(root.path, { bigint: true }),
    ]);
    if (
      canonicalPath !== root.path ||
      !stat.isDirectory() ||
      stat.dev.toString() !== root.device ||
      stat.ino.toString() !== root.inode
    ) {
      throw new Error('Pinned vault root identity changed during indexing.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Pinned vault root identity changed')) {
      throw error;
    }
    throw new Error('Pinned vault root identity changed during indexing.');
  }
}
