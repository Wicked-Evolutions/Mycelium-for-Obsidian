/**
 * Wikilink parser for Obsidian files
 * Handles [[link]], [[link|alias]], and [[vault:link]] syntax
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { WikiLink } from '../types/index.js';
import { resolvePathInVault } from '../config.js';
import {
  abortableYield,
  isAbortError,
  throwIfAborted
} from '../cli/vault-target.js';

// Regex to match wikilinks: [[target]] or [[target|alias]]
const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Regex for cross-vault links: [[vault:target]]
const CROSS_VAULT_REGEX = /^([a-zA-Z][a-zA-Z0-9_-]*):(.+)$/;
const WIKILINK_CHECKPOINT_CHARS = 64 * 1024;

function makeWikilink(
  content: string,
  start: number,
  end: number,
  targetText: string,
  aliasText?: string
): WikiLink {
  const targetWithPossibleVault = targetText.trim();
  const alias = aliasText?.trim();
  const crossVaultMatch = targetWithPossibleVault.match(CROSS_VAULT_REGEX);
  const vault = crossVaultMatch ? crossVaultMatch[1] : undefined;
  const target = crossVaultMatch ? crossVaultMatch[2] : targetWithPossibleVault;
  const hashIdx = target.indexOf('#');

  return {
    raw: content.slice(start, end),
    target,
    alias,
    exists: false,
    rawTarget: targetWithPossibleVault,
    vault,
    path: hashIdx >= 0 ? target.slice(0, hashIdx) : target,
    subpath: hashIdx >= 0 ? target.slice(hashIdx + 1) : undefined,
    isEmbed: start > 0 && content[start - 1] === '!'
  };
}

/**
 * Extract all wikilinks from content.
 *
 * `raw`, `target`, `alias`, `exists` keep their historical semantics exactly
 * (cross-vault prefix stripped from `target`; subpath retained). The additive
 * graph-layer fields (`rawTarget`, `vault`, `path`, `subpath`, `isEmbed`) are
 * computed alongside without disturbing the legacy ones.
 */
export function extractWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match;

  // Reset lastIndex so repeated calls on the (global) regex start clean.
  WIKILINK_REGEX.lastIndex = 0;

  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    links.push(makeWikilink(
      content,
      match.index,
      WIKILINK_REGEX.lastIndex,
      match[1],
      match[2]
    ));
  }

  return links;
}

/** Extract wikilinks without monopolizing the event loop on a very large note. */
export async function extractWikilinksCooperative(
  content: string,
  signal?: AbortSignal
): Promise<WikiLink[]> {
  if (!signal) return extractWikilinks(content);

  const links: WikiLink[] = [];
  let index = 0;
  let nextCheckpoint = WIKILINK_CHECKPOINT_CHARS;

  throwIfAborted(signal);
  while (index + 1 < content.length) {
    if (index >= nextCheckpoint) {
      nextCheckpoint = index + WIKILINK_CHECKPOINT_CHARS;
      await abortableYield(signal);
    }
    if (content[index] !== '[' || content[index + 1] !== '[') {
      index += 1;
      continue;
    }

    const start = index;
    const targetStart = start + 2;
    let cursor = targetStart;
    while (cursor < content.length && content[cursor] !== ']' && content[cursor] !== '|') {
      cursor += 1;
      if (cursor >= nextCheckpoint) {
        nextCheckpoint = cursor + WIKILINK_CHECKPOINT_CHARS;
        await abortableYield(signal);
      }
    }

    if (cursor === targetStart || cursor >= content.length) {
      index = start + 2;
      continue;
    }

    if (content[cursor] === ']') {
      if (content[cursor + 1] === ']') {
        links.push(makeWikilink(content, start, cursor + 2, content.slice(targetStart, cursor)));
        index = cursor + 2;
      } else {
        index = start + 2;
      }
      continue;
    }

    const pipe = cursor;
    const aliasStart = pipe + 1;
    cursor = aliasStart;
    while (cursor < content.length && content[cursor] !== ']') {
      cursor += 1;
      if (cursor >= nextCheckpoint) {
        nextCheckpoint = cursor + WIKILINK_CHECKPOINT_CHARS;
        await abortableYield(signal);
      }
    }
    if (cursor > aliasStart && content[cursor] === ']' && content[cursor + 1] === ']') {
      links.push(makeWikilink(
        content,
        start,
        cursor + 2,
        content.slice(targetStart, pipe),
        content.slice(aliasStart, cursor)
      ));
      index = cursor + 2;
    } else {
      index = start + 2;
    }
  }
  throwIfAborted(signal);
  return links;
}

/**
 * Normalize a RAW wikilink target into the resolver-consistent, same-vault
 * key used for unresolved-link aggregation, or `null` when the target is
 * cross-vault (and therefore NOT a same-vault unresolved link).
 *
 * This is the SINGLE source of truth both graph providers use so that their
 * unresolved-target counts agree BY CONSTRUCTION:
 *   - The filesystem provider passes `link.rawTarget` (the verbatim inner
 *     target, vault prefix + subpath intact).
 *   - The Obsidian provider passes each RAW key from
 *     `app.metadataCache.unresolvedLinks` (verbatim) after aggregating in eval.
 *
 * Contract (mirrors `link.path` semantics for same-vault targets):
 *   - Cross-vault (`Vault:Target`, matches CROSS_VAULT_REGEX) → return `null`
 *     (SKIP; never counted as a same-vault unresolved link).
 *   - Otherwise strip an optional `|alias` (defensive — Obsidian's raw
 *     unresolvedLinks keys already have the alias stripped) and a
 *     `#heading` / `#^block` subpath, then return the remaining target.
 *
 * A note title that merely contains a space before a colon
 * (e.g. `"Principle Keywords: Breathe"`) does NOT match CROSS_VAULT_REGEX
 * (the vault segment forbids spaces), so it is a legitimate same-vault key
 * and is still counted.
 */
export function normalizeUnresolvedKey(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  // Cross-vault → not a same-vault unresolved link.
  if (CROSS_VAULT_REGEX.test(trimmed)) {
    return null;
  }
  // Defensive alias strip (`Target|alias` → `Target`).
  const pipeIdx = trimmed.indexOf('|');
  const withoutAlias = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed;
  // Subpath strip (`Target#heading` / `Target#^block` → `Target`).
  const hashIdx = withoutAlias.indexOf('#');
  const key = hashIdx >= 0 ? withoutAlias.slice(0, hashIdx) : withoutAlias;
  return key.trim();
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
export async function buildMultiFileIndex(
  vaultPath: string,
  signal?: AbortSignal
): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let visitedEntries = 0;

  async function indexDirectory(dirPath: string) {
    throwIfAborted(signal);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        visitedEntries += 1;
        if (signal && visitedEntries % 256 === 0) await abortableYield(signal);
        else throwIfAborted(signal);
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
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Directory not readable
    }
  }

  await indexDirectory(vaultPath);
  throwIfAborted(signal);
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
