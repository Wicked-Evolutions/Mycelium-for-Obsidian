/**
 * Vault analytics and health tools for Obsidian MCP
 * Orphan detection, broken links, stale notes, and composite health reports
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { parseMarkdownFile, extractTitle } from '../parsers/markdown.js';
import {
  extractWikilinks,
  resolveWikilink
} from '../parsers/wikilink.js';
import { vaultParam, limitParam } from './schema-helpers.js';
import { withAnnotations, ToolAnnotations } from './safety.js';
import {
  CompletenessReason,
  exactResultMetadata,
  limitReachedMetadata,
  partialCompletenessMetadata,
} from '../result-metadata.js';

interface BrokenLinkOccurrence {
  source: string;
  target: string;
  lineNumber: number;
  sourceText: string;
  columnStart: number;
  occurrenceIndexOnLine: number;
}

interface UniqueUnresolvedTargetString {
  target: string;
  occurrenceCount: number;
  sourceCount: number;
}

/**
 * Tool definitions
 */
const rawAnalyticsTools: Tool[] = [
  {
    name: 'get_vault_health',
    description: 'Comprehensive vault health report: orphan notes, broken links, stale notes, and file stats. Runs all analytics in one pass.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        stale_days: {
          type: 'number',
          description: 'Days threshold for stale note detection',
          default: 90
        }
      }
    }
  },
  {
    name: 'get_orphan_notes',
    description: 'Find notes with zero inbound wikilinks (not linked to by any other note).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        exclude_patterns: {
          type: 'array',
          description: 'Directory patterns to exclude (e.g., ["00 Inbox", "05 Resources/Templates"])',
          items: { type: 'string' }
        },
        limit: limitParam(50)
      }
    }
  },
  {
    name: 'get_broken_links',
    description: 'Find all wikilinks that point to non-existent notes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        limit: limitParam(50)
      }
    }
  },
  {
    name: 'get_stale_notes',
    description: 'Find notes not modified within a given number of days.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        days: {
          type: 'number',
          description: 'Days since last modification',
          default: 90
        },
        type_filter: {
          type: 'string',
          description: 'Only include notes with this frontmatter type (e.g., "PROJECT")'
        },
        exclude_patterns: {
          type: 'array',
          description: 'Directory patterns to exclude',
          items: { type: 'string' }
        },
        limit: limitParam(50)
      }
    }
  }
];

/** All analytics tools are read-only reports. */
const analyticsAnnotations: Record<string, ToolAnnotations> = {
  get_vault_health: { readOnlyHint: true },
  get_orphan_notes: { readOnlyHint: true },
  get_broken_links: { readOnlyHint: true },
  get_stale_notes: { readOnlyHint: true },
};

export const analyticsTools: Tool[] = withAnnotations(rawAnalyticsTools, analyticsAnnotations);

/**
 * Collect all markdown files with metadata
 */
interface CollectedFile {
  relativePath: string;
  mtime: Date;
  indexable: boolean;
}

interface FileInventory {
  files: CollectedFile[];
  skipped: number;
  reasons: CompletenessReason[];
}

interface BacklinkScan {
  backlinkCounts: Map<string, number>;
  brokenLinks: BrokenLinkOccurrence[];
  scanned: number;
  skipped: number;
  reasons: CompletenessReason[];
}

async function collectFiles(
  dirPath: string,
  vaultPath: string,
  inventory: FileInventory = { files: [], skipped: 0, reasons: [] },
  isRoot = true
): Promise<FileInventory> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    if (isRoot) throw new Error('Analytics root directory is unavailable');
    inventory.skipped += 1;
    inventory.reasons.push('directory_unavailable');
    return inventory;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, vaultPath, inventory, false);
    } else if (entry.name.endsWith('.md')) {
      try {
        const stats = await fs.stat(fullPath);
        inventory.files.push({
          relativePath: path.relative(vaultPath, fullPath),
          mtime: stats.mtime,
          // Preserve legacy scanning of Markdown symlinks, but never let one
          // become an authoritative local wikilink resolution candidate.
          indexable: entry.isFile(),
        });
      } catch {
        inventory.skipped += 1;
        inventory.reasons.push('file_metadata_unavailable');
      }
    }
  }

  return inventory;
}

/**
 * Build a reverse link index: for each note, which notes link TO it
 */
async function buildBacklinkIndex(
  vaultPath: string,
  inventory: FileInventory
): Promise<BacklinkScan> {
  // Use one tracked inventory so duplicate-basename resolution and completeness agree.
  const multiIndex = new Map<string, string[]>();
  const backlinkCounts = new Map<string, number>();
  const brokenLinks: BrokenLinkOccurrence[] = [];
  let scanned = 0;
  let skipped = inventory.skipped;
  const reasons = [...inventory.reasons];

  for (const file of inventory.files) {
    if (file.indexable) {
      const absolutePath = path.join(vaultPath, file.relativePath);
      const key = path.basename(file.relativePath).toLowerCase();
      const candidates = multiIndex.get(key);
      if (candidates) {
        candidates.push(absolutePath);
      } else {
        multiIndex.set(key, [absolutePath]);
      }
    }
    backlinkCounts.set(file.relativePath, 0);
  }

  for (const file of inventory.files) {
    let content: string;
    try {
      const sourceAbsPath = path.join(vaultPath, file.relativePath);
      content = await fs.readFile(sourceAbsPath, 'utf-8');
    } catch {
      skipped += 1;
      reasons.push('file_unreadable');
      continue;
    }

    try {
      const sourceAbsPath = path.join(vaultPath, file.relativePath);
      const links = extractWikilinks(content);
      const occurrenceDetails = getWikilinkOccurrenceDetails(content, links.map(link => link.raw));
      const resolvedTargets: string[] = [];
      const fileBrokenLinks: BrokenLinkOccurrence[] = [];

      for (let linkIndex = 0; linkIndex < links.length; linkIndex++) {
        const link = links[linkIndex];
        // Pass sourcePath so same-folder notes win the tiebreak when basenames collide
        const resolved = await resolveWikilink(link.target, vaultPath, undefined, sourceAbsPath, multiIndex);

        if (resolved) {
          resolvedTargets.push(path.relative(vaultPath, resolved));
        } else {
          const occurrence = occurrenceDetails[linkIndex] ?? {
            lineNumber: 0,
            columnStart: 0,
            occurrenceIndexOnLine: 0,
            sourceText: link.raw
          };
          fileBrokenLinks.push({
            source: file.relativePath,
            target: link.target,
            lineNumber: occurrence.lineNumber,
            sourceText: occurrence.sourceText,
            columnStart: occurrence.columnStart,
            occurrenceIndexOnLine: occurrence.occurrenceIndexOnLine
          });
        }
      }

      for (const relTarget of resolvedTargets) {
        backlinkCounts.set(relTarget, (backlinkCounts.get(relTarget) || 0) + 1);
      }
      brokenLinks.push(...fileBrokenLinks);
      scanned += 1;
    } catch {
      skipped += 1;
      reasons.push('scan_failure');
    }
  }

  return { backlinkCounts, brokenLinks, scanned, skipped, reasons };
}

function getWikilinkOccurrenceDetails(
  content: string,
  rawLinksInParseOrder: string[]
): Array<{ lineNumber: number; columnStart: number; occurrenceIndexOnLine: number; sourceText: string }> {
  const lineStarts = getLineStarts(content);
  const perLineCounts = new Map<number, number>();
  const details: Array<{ lineNumber: number; columnStart: number; occurrenceIndexOnLine: number; sourceText: string }> = [];

  let searchFrom = 0;
  for (const raw of rawLinksInParseOrder) {
    const rawStart = content.indexOf(raw, searchFrom);
    if (rawStart === -1) {
      details.push({ lineNumber: 0, columnStart: 0, occurrenceIndexOnLine: 0, sourceText: raw });
      continue;
    }

    const sourceStart = rawStart > 0 && content[rawStart - 1] === '!' ? rawStart - 1 : rawStart;
    const sourceText = sourceStart < rawStart ? `!${raw}` : raw;
    const lineNumber = lineNumberForOffset(lineStarts, sourceStart);
    const columnStart = sourceStart - lineStarts[lineNumber - 1] + 1;
    const occurrenceIndexOnLine = (perLineCounts.get(lineNumber) ?? 0) + 1;
    perLineCounts.set(lineNumber, occurrenceIndexOnLine);

    details.push({ lineNumber, columnStart, occurrenceIndexOnLine, sourceText });
    searchFrom = rawStart + raw.length;
  }

  return details;
}

function getLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return high + 1;
}

function uniqueUnresolvedTargetStrings(
  brokenLinks: BrokenLinkOccurrence[]
): UniqueUnresolvedTargetString[] {
  const grouped = new Map<string, { occurrenceCount: number; sources: Set<string> }>();

  for (const link of brokenLinks) {
    const group = grouped.get(link.target) ?? { occurrenceCount: 0, sources: new Set<string>() };
    group.occurrenceCount += 1;
    group.sources.add(link.source);
    grouped.set(link.target, group);
  }

  return [...grouped.entries()]
    .map(([target, group]) => ({
      target,
      occurrenceCount: group.occurrenceCount,
      sourceCount: group.sources.size
    }))
    .sort((a, b) => (
      b.occurrenceCount - a.occurrenceCount ||
      a.target.localeCompare(b.target)
    ));
}

/**
 * Check if a path matches any exclude pattern
 */
function matchesExclude(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => filePath.startsWith(p));
}

/**
 * Handler functions
 */
export function createAnalyticsHandlers(config: Config) {
  return {
    get_vault_health: async (args: {
      vault?: string;
      stale_days?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const staleDays = args.stale_days || 90;
        const staleThreshold = Date.now() - (staleDays * 24 * 60 * 60 * 1000);

        // Collect files
        const inventory = await collectFiles(vault.path, vault.path);
        const files = inventory.files;

        // Build backlink index (also finds broken links)
        const backlinkScan = await buildBacklinkIndex(vault.path, inventory);
        const { backlinkCounts, brokenLinks } = backlinkScan;
        const uniqueTargets = uniqueUnresolvedTargetStrings(brokenLinks);

        // Orphans (zero backlinks, excluding root-level files)
        const orphans = files
          .filter(f => (backlinkCounts.get(f.relativePath) || 0) === 0)
          .filter(f => f.relativePath.includes('/')) // Skip root-level files
          .map(f => f.relativePath);

        // Stale notes
        const staleNotes = files
          .filter(f => f.mtime.getTime() < staleThreshold)
          .map(f => ({
            path: f.relativePath,
            lastModified: f.mtime.toISOString()
          }));
        const topOrphans = orphans.slice(0, 10);
        const topBrokenLinks = brokenLinks.slice(0, 10);
        const topUniqueTargets = uniqueTargets.slice(0, 10);
        const topStaleNotes = staleNotes.slice(0, 10);
        const linkScanExact = backlinkScan.skipped === 0;
        const inventoryExact = inventory.skipped === 0;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              totalFiles: files.length,
              orphanNotes: orphans.length,
              brokenLinks: brokenLinks.length,
              brokenLinkOccurrenceCount: brokenLinks.length,
              uniqueUnresolvedTargetStringCount: uniqueTargets.length,
              staleNotes: staleNotes.length,
              staleDaysThreshold: staleDays,
              topOrphans,
              topBrokenLinks,
              topUniqueUnresolvedTargetStrings: topUniqueTargets,
              topStaleNotes,
              resultMetadata: {
                topOrphans: linkScanExact
                  ? exactResultMetadata(orphans.length, topOrphans.length)
                  : limitReachedMetadata(orphans.length > topOrphans.length),
                topBrokenLinks: linkScanExact
                  ? exactResultMetadata(brokenLinks.length, topBrokenLinks.length)
                  : limitReachedMetadata(brokenLinks.length > topBrokenLinks.length),
                topUniqueUnresolvedTargetStrings: linkScanExact
                  ? exactResultMetadata(uniqueTargets.length, topUniqueTargets.length)
                  : limitReachedMetadata(uniqueTargets.length > topUniqueTargets.length),
                topStaleNotes: inventoryExact
                  ? exactResultMetadata(staleNotes.length, topStaleNotes.length)
                  : limitReachedMetadata(staleNotes.length > topStaleNotes.length),
              },
              ...partialCompletenessMetadata(
                backlinkScan.scanned,
                backlinkScan.skipped,
                backlinkScan.reasons
              )
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Vault health error: ${error}` }],
          isError: true
        };
      }
    },

    get_orphan_notes: async (args: {
      vault?: string;
      exclude_patterns?: string[];
      limit?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const limit = args.limit || 50;

        const inventory = await collectFiles(vault.path, vault.path);
        const files = inventory.files;
        const backlinkScan = await buildBacklinkIndex(vault.path, inventory);
        const { backlinkCounts } = backlinkScan;

        const allOrphans = files
          .filter(f => (backlinkCounts.get(f.relativePath) || 0) === 0)
          .filter(f => !matchesExclude(f.relativePath, args.exclude_patterns));
        const orphans = allOrphans.slice(0, limit);

        // Enrich with titles
        const enriched = await Promise.all(orphans.map(async f => {
          try {
            const parsed = await parseMarkdownFile(f.relativePath, vault.path);
            return {
              path: f.relativePath,
              title: extractTitle(parsed),
              lastModified: f.mtime.toISOString()
            };
          } catch {
            return {
              path: f.relativePath,
              title: path.basename(f.relativePath, '.md'),
              lastModified: f.mtime.toISOString()
            };
          }
        }));
        const metadata = backlinkScan.skipped === 0
          ? exactResultMetadata(allOrphans.length, enriched.length)
          : {
              ...limitReachedMetadata(allOrphans.length > enriched.length),
              ...partialCompletenessMetadata(
                backlinkScan.scanned,
                backlinkScan.skipped,
                backlinkScan.reasons
              ),
            };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              orphanCount: enriched.length,
              ...metadata,
              orphans: enriched
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Orphan notes error: ${error}` }],
          isError: true
        };
      }
    },

    get_broken_links: async (args: {
      vault?: string;
      limit?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const limit = args.limit || 50;

        const inventory = await collectFiles(vault.path, vault.path);
        const backlinkScan = await buildBacklinkIndex(vault.path, inventory);
        const { brokenLinks } = backlinkScan;
        const uniqueTargets = uniqueUnresolvedTargetStrings(brokenLinks);
        const returnedBrokenLinks = brokenLinks.slice(0, limit);
        const returnedUniqueTargets = uniqueTargets.slice(0, limit);
        const scanExact = backlinkScan.skipped === 0;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              brokenLinkCount: brokenLinks.length,
              brokenLinkOccurrenceCount: brokenLinks.length,
              uniqueUnresolvedTargetStringCount: uniqueTargets.length,
              brokenLinks: returnedBrokenLinks,
              uniqueUnresolvedTargetStrings: returnedUniqueTargets,
              resultMetadata: {
                brokenLinks: scanExact
                  ? exactResultMetadata(brokenLinks.length, returnedBrokenLinks.length)
                  : limitReachedMetadata(brokenLinks.length > returnedBrokenLinks.length),
                uniqueUnresolvedTargetStrings: scanExact
                  ? exactResultMetadata(uniqueTargets.length, returnedUniqueTargets.length)
                  : limitReachedMetadata(uniqueTargets.length > returnedUniqueTargets.length),
              },
              ...partialCompletenessMetadata(
                backlinkScan.scanned,
                backlinkScan.skipped,
                backlinkScan.reasons
              )
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Broken links error: ${error}` }],
          isError: true
        };
      }
    },

    get_stale_notes: async (args: {
      vault?: string;
      days?: number;
      type_filter?: string;
      exclude_patterns?: string[];
      limit?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const days = args.days || 90;
        const limit = args.limit || 50;
        const returnLimit = Math.max(0, Math.ceil(limit));
        const staleThreshold = Date.now() - (days * 24 * 60 * 60 * 1000);

        const inventory = await collectFiles(vault.path, vault.path);
        const files = inventory.files;

        // Filter stale files
        const staleFiles = files
          .filter(f => f.mtime.getTime() < staleThreshold)
          .filter(f => !matchesExclude(f.relativePath, args.exclude_patterns));

        // Enrich with frontmatter and optionally filter by type
        const results: Array<{
          path: string;
          title: string;
          type?: string;
          lastModified: string;
          daysSinceModified: number;
        }> = [];

        let parseSkipped = 0;
        for (const file of staleFiles) {
          try {
            const parsed = await parseMarkdownFile(file.relativePath, vault.path);

            // Filter by type if specified
            if (args.type_filter) {
              const noteType = String(parsed.frontmatter.type || '').toLowerCase();
              if (noteType !== args.type_filter.toLowerCase()) continue;
            }

            results.push({
              path: file.relativePath,
              title: extractTitle(parsed),
              type: parsed.frontmatter.type as string | undefined,
              lastModified: file.mtime.toISOString(),
              daysSinceModified: Math.floor((Date.now() - file.mtime.getTime()) / (24 * 60 * 60 * 1000))
            });
          } catch {
            // Skip unparseable files unless no type filter
            if (!args.type_filter) {
              results.push({
                path: file.relativePath,
                title: path.basename(file.relativePath, '.md'),
                lastModified: file.mtime.toISOString(),
                daysSinceModified: Math.floor((Date.now() - file.mtime.getTime()) / (24 * 60 * 60 * 1000))
              });
            } else {
              parseSkipped += 1;
            }
          }
        }

        // Sort by stalest first
        results.sort((a, b) => b.daysSinceModified - a.daysSinceModified);
        const limited = results.slice(0, returnLimit);
        const skipped = inventory.skipped + parseSkipped;
        const reasons = [
          ...inventory.reasons,
          ...(parseSkipped > 0 ? ['file_unparseable' as const] : []),
        ];
        const metadata = skipped === 0
          ? exactResultMetadata(results.length, limited.length)
          : {
              ...limitReachedMetadata(results.length > limited.length),
              ...partialCompletenessMetadata(files.length - parseSkipped, skipped, reasons),
            };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              daysThreshold: days,
              typeFilter: args.type_filter || null,
              staleCount: limited.length,
              ...metadata,
              staleNotes: limited
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Stale notes error: ${error}` }],
          isError: true
        };
      }
    }
  };
}
