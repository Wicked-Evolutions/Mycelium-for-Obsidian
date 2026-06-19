/**
 * Wikilink parser for Obsidian files
 * Handles [[link]], [[link|alias]], and [[vault:link]] syntax
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { WikiLink } from '../types/index.js';
import { resolvePathInVault } from '../config.js';

// Regex to match wikilinks: [[target]] or [[target|alias]]
const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Regex for cross-vault links: [[vault:target]]
const CROSS_VAULT_REGEX = /^([a-zA-Z][a-zA-Z0-9_-]*):(.+)$/;

/**
 * Extract all wikilinks from content
 */
export function extractWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match;

  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const raw = match[0];
    const targetWithPossibleVault = match[1].trim();
    const alias = match[2]?.trim();

    // Check for cross-vault syntax
    const crossVaultMatch = targetWithPossibleVault.match(CROSS_VAULT_REGEX);

    links.push({
      raw,
      target: crossVaultMatch ? crossVaultMatch[2] : targetWithPossibleVault,
      alias,
      exists: false // Will be resolved later
    });
  }

  return links;
}

/**
 * Parse cross-vault link syntax
 */
export function parseCrossVaultLink(link: string): { vault?: string; note: string } {
  const match = link.match(CROSS_VAULT_REGEX);
  if (match) {
    return { vault: match[1], note: match[2] };
  }
  return { note: link };
}

/**
 * Resolve a wikilink target to an actual file path
 * Handles:
 * - Exact path match (folder/note.md)
 * - Note name only (note)
 * - Note name with extension (note.md)
 */
export async function resolveWikilink(
  target: string,
  vaultPath: string,
  fileIndex?: Map<string, string>, // Map of lowercase filename -> full path
  sourcePath?: string,             // Absolute path of the file containing the link (for same-folder tiebreak)
  multiIndex?: Map<string, string[]> // Multi-candidate index (basename -> [abs paths]) for duplicate-basename resolution
): Promise<string | null> {
  // Normalize target
  let normalizedTarget = target;

  // Add .md extension if not present
  if (!normalizedTarget.endsWith('.md')) {
    normalizedTarget += '.md';
  }

  // Try exact path first (with boundary check)
  try {
    const exactPath = resolvePathInVault(vaultPath, normalizedTarget);
    await fs.access(exactPath);
    return exactPath;
  } catch {
    // Not found at exact path, or path traversal blocked
  }

  // If we have a multi-candidate index, apply Obsidian tiebreak rules:
  // 1. Same folder as source  2. Shortest relative path  3. Alphabetical
  if (multiIndex) {
    const targetName = path.basename(normalizedTarget).toLowerCase();
    const candidates = multiIndex.get(targetName);
    if (candidates && candidates.length > 0) {
      if (candidates.length === 1) return candidates[0];
      const sourceDir = sourcePath ? path.dirname(sourcePath) : null;
      // Prefer same-folder as source
      if (sourceDir) {
        const sameFolder = candidates.find(c => path.dirname(c) === sourceDir);
        if (sameFolder) return sameFolder;
      }
      // Shortest relative path from vault root, then alphabetical
      const sorted = [...candidates].sort((a, b) => {
        const ra = path.relative(vaultPath, a);
        const rb = path.relative(vaultPath, b);
        const depthDiff = ra.split(path.sep).length - rb.split(path.sep).length;
        return depthDiff !== 0 ? depthDiff : ra.localeCompare(rb);
      });
      return sorted[0];
    }
  }

  // If we have a file index, search by filename
  if (fileIndex) {
    const targetName = path.basename(normalizedTarget).toLowerCase();
    const found = fileIndex.get(targetName);
    if (found) {
      return found;
    }
  }

  // Search the vault for the file (expensive, avoid if possible)
  const foundPath = await searchVaultForFile(vaultPath, normalizedTarget);
  return foundPath;
}

/**
 * Search the vault for a file by name (recursive)
 */
async function searchVaultForFile(
  dirPath: string,
  targetName: string,
  basePath?: string
): Promise<string | null> {
  basePath = basePath || dirPath;
  const targetBaseName = path.basename(targetName).toLowerCase();

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip hidden files and .obsidian folder
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const found = await searchVaultForFile(fullPath, targetName, basePath);
        if (found) return found;
      } else if (entry.isFile() && entry.name.toLowerCase() === targetBaseName) {
        return fullPath;
      }
    }
  } catch {
    // Directory not readable
  }

  return null;
}

/**
 * Build a file index for fast wikilink resolution
 * Maps lowercase filename -> absolute path (first occurrence only)
 */
export async function buildFileIndex(vaultPath: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  async function indexDirectory(dirPath: string) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        // Skip hidden files and .obsidian folder
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          await indexDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const lowerName = entry.name.toLowerCase();
          // Only store first occurrence (Obsidian behavior)
          if (!index.has(lowerName)) {
            index.set(lowerName, fullPath);
          }
        }
      }
    } catch {
      // Directory not readable
    }
  }

  await indexDirectory(vaultPath);
  return index;
}

/**
 * Build a multi-candidate file index for source-aware wikilink resolution.
 * Unlike buildFileIndex, this records ALL paths for each lowercase basename so
 * that duplicate-basename collisions can be resolved via same-folder / shortest-path
 * tiebreak rules (see resolveWikilink).
 *
 * Maps lowercase filename.md -> [absolute path, ...]
 */
export async function buildMultiFileIndex(vaultPath: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();

  async function indexDirectory(dirPath: string) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          await indexDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const lowerName = entry.name.toLowerCase();
          const existing = index.get(lowerName);
          if (existing) {
            existing.push(fullPath);
          } else {
            index.set(lowerName, [fullPath]);
          }
        }
      }
    } catch {
      // Directory not readable
    }
  }

  await indexDirectory(vaultPath);
  return index;
}

/**
 * Resolve all wikilinks in content
 */
export async function resolveAllWikilinks(
  content: string,
  vaultPath: string,
  fileIndex?: Map<string, string>
): Promise<WikiLink[]> {
  const links = extractWikilinks(content);

  for (const link of links) {
    const resolved = await resolveWikilink(link.target, vaultPath, fileIndex);
    if (resolved) {
      link.resolved = resolved;
      link.exists = true;
    }
  }

  return links;
}

/**
 * Get the line number where a wikilink appears
 */
export function getWikilinkLineNumber(content: string, wikilink: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(wikilink)) {
      return i + 1; // 1-indexed
    }
  }
  return 0;
}

/**
 * Get context around a wikilink (surrounding text)
 */
export function getWikilinkContext(content: string, wikilink: string, contextChars: number = 100): string {
  const index = content.indexOf(wikilink);
  if (index === -1) return '';

  const start = Math.max(0, index - contextChars);
  const end = Math.min(content.length, index + wikilink.length + contextChars);

  let context = content.slice(start, end);

  // Clean up context
  if (start > 0) context = '...' + context;
  if (end < content.length) context = context + '...';

  // Remove newlines for cleaner display
  context = context.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  return context;
}
