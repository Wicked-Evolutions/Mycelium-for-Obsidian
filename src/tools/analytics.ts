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
  resolveWikilink,
  buildFileIndex,
  buildMultiFileIndex
} from '../parsers/wikilink.js';
import { vaultParam, limitParam } from './schema-helpers.js';

/**
 * Tool definitions
 */
export const analyticsTools: Tool[] = [
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

/**
 * Collect all markdown files with metadata
 */
async function collectFiles(
  dirPath: string,
  vaultPath: string,
  files: Array<{ relativePath: string; mtime: Date }> = []
): Promise<Array<{ relativePath: string; mtime: Date }>> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, vaultPath, files);
    } else if (entry.name.endsWith('.md')) {
      const stats = await fs.stat(fullPath);
      files.push({
        relativePath: path.relative(vaultPath, fullPath),
        mtime: stats.mtime
      });
    }
  }

  return files;
}

/**
 * Build a reverse link index: for each note, which notes link TO it
 */
async function buildBacklinkIndex(
  vaultPath: string
): Promise<{ backlinkCounts: Map<string, number>; brokenLinks: Array<{ source: string; target: string; lineNumber: number }> }> {
  // Use multi-candidate index so duplicate-basename links credit the same-folder note
  const multiIndex = await buildMultiFileIndex(vaultPath);
  const backlinkCounts = new Map<string, number>();
  const brokenLinks: Array<{ source: string; target: string; lineNumber: number }> = [];

  // Initialize all files with 0 backlinks (derive from multi-index)
  for (const paths of multiIndex.values()) {
    for (const filePath of paths) {
      const rel = path.relative(vaultPath, filePath);
      if (!backlinkCounts.has(rel)) {
        backlinkCounts.set(rel, 0);
      }
    }
  }

  // Scan all files for outgoing links
  const files = await collectFiles(vaultPath, vaultPath);

  for (const file of files) {
    try {
      const sourceAbsPath = path.join(vaultPath, file.relativePath);
      const content = await fs.readFile(sourceAbsPath, 'utf-8');
      const links = extractWikilinks(content);

      for (const link of links) {
        // Pass sourcePath so same-folder notes win the tiebreak when basenames collide
        const resolved = await resolveWikilink(link.target, vaultPath, undefined, sourceAbsPath, multiIndex);

        if (resolved) {
          const relTarget = path.relative(vaultPath, resolved);
          backlinkCounts.set(relTarget, (backlinkCounts.get(relTarget) || 0) + 1);
        } else {
          // Broken link — find line number
          const lines = content.split('\n');
          let lineNum = 0;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(link.raw)) {
              lineNum = i + 1;
              break;
            }
          }
          brokenLinks.push({
            source: file.relativePath,
            target: link.target,
            lineNumber: lineNum
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { backlinkCounts, brokenLinks };
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
        const files = await collectFiles(vault.path, vault.path);

        // Build backlink index (also finds broken links)
        const { backlinkCounts, brokenLinks } = await buildBacklinkIndex(vault.path);

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

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              totalFiles: files.length,
              orphanNotes: orphans.length,
              brokenLinks: brokenLinks.length,
              staleNotes: staleNotes.length,
              staleDaysThreshold: staleDays,
              topOrphans: orphans.slice(0, 10),
              topBrokenLinks: brokenLinks.slice(0, 10),
              topStaleNotes: staleNotes.slice(0, 10)
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

        const files = await collectFiles(vault.path, vault.path);
        const { backlinkCounts } = await buildBacklinkIndex(vault.path);

        const orphans = files
          .filter(f => (backlinkCounts.get(f.relativePath) || 0) === 0)
          .filter(f => !matchesExclude(f.relativePath, args.exclude_patterns))
          .slice(0, limit);

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

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              orphanCount: enriched.length,
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

        const { brokenLinks } = await buildBacklinkIndex(vault.path);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              brokenLinkCount: brokenLinks.length,
              brokenLinks: brokenLinks.slice(0, limit)
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
        const staleThreshold = Date.now() - (days * 24 * 60 * 60 * 1000);

        const files = await collectFiles(vault.path, vault.path);

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

        for (const file of staleFiles) {
          if (results.length >= limit) break;

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
            }
          }
        }

        // Sort by stalest first
        results.sort((a, b) => b.daysSinceModified - a.daysSinceModified);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              daysThreshold: days,
              typeFilter: args.type_filter || null,
              staleCount: results.length,
              staleNotes: results
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
