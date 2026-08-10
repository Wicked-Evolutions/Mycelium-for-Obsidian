/**
 * Read-only semantic-index coverage accounting.
 *
 * These helpers deliberately separate file coverage from embedding chunk counts.
 * They do not inspect embedding vector contents or claim index freshness.
 */

import * as path from 'path';
import * as fs from 'fs';
import { resolvePathInVault } from '../config.js';

export interface EmbeddingPathStat {
  filePath: string;
  embeddingChunks: number;
}

export interface IndexCoverageStats {
  currentMarkdownFiles: number;
  indexedFilePathCount: number;
  currentIndexedFiles: number;
  staleIndexedFiles: number;
  embeddingChunks: number;
  currentEmbeddingChunks: number;
  staleEmbeddingChunks: number;
  fileCoveragePercent: number;
  embeddingChunksPerCurrentIndexedFile: number;
  embeddingChunksPerCurrentMarkdownFile: number;
  staleIndexedFileSamples: string[];
}

interface ClassifiedPathStat extends EmbeddingPathStat {
  canonicalCurrentPath?: string;
  safeDisplayPath?: string;
  normalizedDisplayPath?: string;
}

interface CurrentMarkdownFile {
  path: string;
  normalizedPath: string;
}

interface CurrentMarkdownFileIndex {
  byIdentity: Map<string, CurrentMarkdownFile[]>;
}

export function calculateIndexCoverage(
  vaultPath: string,
  currentMarkdownPaths: string[],
  indexedPathStats: EmbeddingPathStat[],
  options: { staleSampleLimit?: number } = {}
): IndexCoverageStats {
  const currentFileIndex = buildCurrentMarkdownFileIndex(vaultPath, currentMarkdownPaths);
  const currentCandidates = new Map<string, ClassifiedPathStat[]>();
  const staleStats: ClassifiedPathStat[] = [];

  for (const stat of indexedPathStats) {
    const classified = classifyIndexedPath(vaultPath, currentFileIndex, stat);
    if (classified.canonicalCurrentPath) {
      const group = currentCandidates.get(classified.canonicalCurrentPath) ?? [];
      group.push(classified);
      currentCandidates.set(classified.canonicalCurrentPath, group);
    } else {
      staleStats.push(classified);
    }
  }

  let currentIndexedFiles = 0;
  let currentEmbeddingChunks = 0;

  for (const [canonicalPath, candidates] of currentCandidates) {
    const current = chooseCurrentRepresentative(canonicalPath, candidates);
    currentIndexedFiles += 1;
    currentEmbeddingChunks += current.embeddingChunks;

    for (const candidate of candidates) {
      if (candidate !== current) {
        staleStats.push(candidate);
      }
    }
  }

  const indexedFilePathCount = indexedPathStats.length;
  const embeddingChunks = indexedPathStats.reduce((sum, stat) => sum + stat.embeddingChunks, 0);
  const staleIndexedFiles = staleStats.length;
  const staleEmbeddingChunks = staleStats.reduce((sum, stat) => sum + stat.embeddingChunks, 0);

  return {
    currentMarkdownFiles: currentMarkdownPaths.length,
    indexedFilePathCount,
    currentIndexedFiles,
    staleIndexedFiles,
    embeddingChunks,
    currentEmbeddingChunks,
    staleEmbeddingChunks,
    fileCoveragePercent: coveragePercent(currentIndexedFiles, currentMarkdownPaths.length),
    embeddingChunksPerCurrentIndexedFile: ratio(currentEmbeddingChunks, currentIndexedFiles),
    embeddingChunksPerCurrentMarkdownFile: ratio(currentEmbeddingChunks, currentMarkdownPaths.length),
    staleIndexedFileSamples: staleSamples(staleStats, options.staleSampleLimit ?? 10)
  };
}

export function findCurrentMarkdownPathByIdentity(
  vaultPath: string,
  currentMarkdownPaths: string[],
  resolvedFilePath: string
): string | null {
  const targetIdentity = getFileIdentity(resolvedFilePath);
  if (!targetIdentity) return null;

  const currentFileIndex = buildCurrentMarkdownFileIndex(vaultPath, currentMarkdownPaths);
  const currentFiles = currentFileIndex.byIdentity.get(targetIdentity);
  if (!currentFiles || currentFiles.length === 0) return null;

  const displayPath = path.relative(vaultPath, resolvedFilePath);
  return chooseCurrentMarkdownFile(displayPath, currentFiles).path;
}

export function coveragePercent(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  if (numerator === denominator) return 100;

  const rounded = round2((numerator / denominator) * 100);
  if (rounded <= 0) return 0.01;
  if (rounded <= 100 && numerator > denominator) return 100.01;
  if (rounded >= 100 && numerator < denominator) return 99.99;
  return rounded;
}

export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  return round2(numerator / denominator);
}

function classifyIndexedPath(
  vaultPath: string,
  currentFileIndex: CurrentMarkdownFileIndex,
  stat: EmbeddingPathStat
): ClassifiedPathStat {
  if (isHostPathLike(stat.filePath)) {
    return stat;
  }

  try {
    const resolved = resolvePathInVault(vaultPath, stat.filePath);
    const displayPath = path.relative(vaultPath, resolved);
    const safeDisplayPath = isSafeVaultRelativePath(displayPath) ? displayPath : undefined;
    const normalizedDisplayPath = safeDisplayPath ? normalizeKey(safeDisplayPath) : undefined;

    const targetIdentity = getFileIdentity(resolved);
    const currentFiles = targetIdentity
      ? currentFileIndex.byIdentity.get(targetIdentity)
      : undefined;

    if (currentFiles && currentFiles.length > 0) {
      const currentFile = chooseCurrentMarkdownFile(displayPath, currentFiles);
      return {
        ...stat,
        canonicalCurrentPath: currentFile.path,
        safeDisplayPath,
        normalizedDisplayPath
      };
    }

    return {
      ...stat,
      safeDisplayPath,
      normalizedDisplayPath
    };
  } catch {
    return stat;
  }
}

function buildCurrentMarkdownFileIndex(
  vaultPath: string,
  currentMarkdownPaths: string[]
): CurrentMarkdownFileIndex {
  const byIdentity = new Map<string, CurrentMarkdownFile[]>();

  for (const currentPath of currentMarkdownPaths) {
    if (isHostPathLike(currentPath)) continue;

    try {
      const resolved = resolvePathInVault(vaultPath, currentPath);
      const identity = getFileIdentity(resolved);
      if (!identity) continue;

      const currentFile = {
        path: currentPath,
        normalizedPath: normalizeKey(currentPath)
      };
      const currentFiles = byIdentity.get(identity) ?? [];
      currentFiles.push(currentFile);
      byIdentity.set(identity, currentFiles);
    } catch {
      // Ignore current-file records that cannot be safely resolved/stat'd.
    }
  }

  return { byIdentity };
}

function chooseCurrentMarkdownFile(
  displayPath: string,
  currentFiles: CurrentMarkdownFile[]
): CurrentMarkdownFile {
  return [...currentFiles].sort((a, b) => {
    const aExact = a.path === displayPath;
    const bExact = b.path === displayPath;
    if (aExact !== bExact) return aExact ? -1 : 1;

    const normalizedCompare = compareCodePoint(a.normalizedPath, b.normalizedPath);
    if (normalizedCompare !== 0) return normalizedCompare;

    return compareCodePoint(a.path, b.path);
  })[0];
}

function chooseCurrentRepresentative(
  canonicalPath: string,
  candidates: ClassifiedPathStat[]
): ClassifiedPathStat {
  return [...candidates].sort((a, b) => {
    const aExact = a.filePath === canonicalPath;
    const bExact = b.filePath === canonicalPath;
    if (aExact !== bExact) return aExact ? -1 : 1;

    const displayCompare = compareCodePoint(a.normalizedDisplayPath ?? '', b.normalizedDisplayPath ?? '');
    if (displayCompare !== 0) return displayCompare;

    return compareCodePoint(a.filePath, b.filePath);
  })[0];
}

function staleSamples(stats: ClassifiedPathStat[], limit: number): string[] {
  if (limit <= 0) return [];

  const safePaths = new Set<string>();
  for (const stat of stats) {
    if (stat.safeDisplayPath && isSafeVaultRelativePath(stat.safeDisplayPath)) {
      safePaths.add(stat.safeDisplayPath);
    }
  }

  return [...safePaths].sort(compareCodePoint).slice(0, limit);
}

function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }

  return left.length - right.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeKey(filePath: string): string {
  return filePath.normalize('NFC');
}

function getFileIdentity(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

function isSafeVaultRelativePath(filePath: string): boolean {
  if (filePath.length === 0 || filePath === '.') return false;
  if (isHostPathLike(filePath)) return false;
  return !filePath.split(/[\\/]+/).includes('..');
}

function isHostPathLike(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath);
}
