/**
 * Cross-vault intelligence tools for Obsidian MCP
 * Phase 4: Unified ecosystem search and discovery
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../config.js';
import { ToolResponse, SearchMatch, VaultConfig } from '../types/index.js';
import { parseMarkdownFile, extractTitle } from '../parsers/markdown.js';
import { extractWikilinks } from '../parsers/wikilink.js';
import {
  generateEmbedding,
  checkOllamaAvailability,
  cosineSimilarity,
  OllamaConfig
} from '../embeddings/ollama.js';
import { getSharedStorage } from '../embeddings/storage.js';
import { withAnnotations, ToolAnnotations } from './safety.js';
import { annotateCrossVault } from './graph-annotate.js';

/**
 * Tool definitions for cross-vault operations
 */
const rawCrossVaultTools: Tool[] = [
  {
    name: 'search_all_vaults',
    description: 'Search for text or regex pattern across ALL configured vaults. Returns results grouped by vault.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search',
          default: false
        },
        maxResultsPerVault: {
          type: 'number',
          description: 'Maximum results per vault',
          default: 10
        }
      },
      required: ['query']
    }
  },
  {
    name: 'semantic_search_all',
    description: 'Semantic search across ALL configured vaults. Finds content by meaning across your entire knowledge ecosystem.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query'
        },
        limit: {
          type: 'number',
          description: 'Maximum total results',
          default: 10
        },
        minSimilarity: {
          type: 'number',
          description: 'Minimum similarity score (0-1)',
          default: 0.3
        }
      },
      required: ['query']
    }
  },
  {
    name: 'find_note_by_name',
    description: 'Find a note by name across all vaults. Useful when you know the note name but not which vault it is in.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Note name to search for (partial match supported)'
        },
        exactMatch: {
          type: 'boolean',
          description: 'Require exact name match (excluding .md extension)',
          default: false
        }
      },
      required: ['name']
    }
  },
  {
    name: 'get_ecosystem_stats',
    description: 'Get statistics about the entire knowledge ecosystem across all vaults.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_cross_vault_links',
    description: 'Find notes that could potentially link to content in other vaults based on wikilink targets.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Optional: only check unresolved links from this vault'
        }
      }
    }
  }
];

/** Per-tool annotations — all cross-vault tools are read-only. */
const crossVaultAnnotations: Record<string, ToolAnnotations> = {
  search_all_vaults: { readOnlyHint: true },
  semantic_search_all: { readOnlyHint: true },
  find_note_by_name: { readOnlyHint: true },
  get_ecosystem_stats: { readOnlyHint: true },
  get_cross_vault_links: { readOnlyHint: true },
};

export const crossVaultTools: Tool[] = withAnnotations(rawCrossVaultTools, crossVaultAnnotations);

/**
 * Get storage instance for a vault (shared singleton per vault path)
 */
function getStorage(vault: VaultConfig) {
  return getSharedStorage(vault.path);
}

/**
 * Handler functions for cross-vault tools
 */
export function createCrossVaultHandlers(config: Config) {
  const ollamaConfig: OllamaConfig = {
    host: config.ollama.host,
    model: config.ollama.model
  };

  return {
    search_all_vaults: async (args: {
      query: string;
      caseSensitive?: boolean;
      maxResultsPerVault?: number;
    }): Promise<ToolResponse> => {
      try {
        const flags = args.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(args.query, flags);
        const maxPerVault = args.maxResultsPerVault || 10;

        const vaultResults: Array<{
          vault: string;
          vaultPath: string;
          results: Array<{ path: string; matches: SearchMatch[] }>;
        }> = [];

        for (const vault of config.vaults) {
          const results = await searchVault(vault.path, regex, maxPerVault);
          vaultResults.push({
            vault: vault.name,
            vaultPath: vault.path,
            results
          });
        }

        const totalResults = vaultResults.reduce((sum, v) => sum + v.results.length, 0);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              vaultsSearched: config.vaults.length,
              totalResults,
              results: vaultResults
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Cross-vault search error: ${error}` }],
          isError: true
        };
      }
    },

    semantic_search_all: async (args: {
      query: string;
      limit?: number;
      minSimilarity?: number;
    }): Promise<ToolResponse> => {
      try {
        // Check Ollama availability
        const ollama = await checkOllamaAvailability(ollamaConfig);
        if (!ollama.available || !ollama.hasModel) {
          return {
            content: [{ type: 'text', text: `Ollama not ready: ${ollama.error}` }],
            isError: true
          };
        }

        // Generate query embedding
        const queryResult = await generateEmbedding(args.query, ollamaConfig);
        const limit = args.limit || 10;
        const minSimilarity = args.minSimilarity || 0.3;

        // Collect results from all vaults
        const allResults: Array<{
          vault: string;
          path: string;
          title: string;
          similarity: number;
          preview: string;
        }> = [];

        for (const vault of config.vaults) {
          const storage = getStorage(vault);
          const stats = storage.getStats();

          if (stats.totalEmbeddings === 0) {
            continue; // Skip unindexed vaults
          }

          const vaultResults = storage.search(queryResult.embedding, limit * 2, minSimilarity);

          for (const r of vaultResults) {
            try {
              const parsed = await parseMarkdownFile(r.filePath, vault.path);
              allResults.push({
                vault: vault.name,
                path: r.filePath,
                title: extractTitle(parsed),
                similarity: Math.round(r.similarity * 1000) / 1000,
                preview: parsed.content.slice(0, 150) + (parsed.content.length > 150 ? '...' : '')
              });
            } catch {
              allResults.push({
                vault: vault.name,
                path: r.filePath,
                title: path.basename(r.filePath, '.md'),
                similarity: Math.round(r.similarity * 1000) / 1000,
                preview: ''
              });
            }
          }
        }

        // Sort by similarity and limit
        allResults.sort((a, b) => b.similarity - a.similarity);
        const topResults = allResults.slice(0, limit);

        // Count indexed vaults
        const indexedVaults = config.vaults.filter(v => {
          const s = getStorage(v);
          return s.getStats().totalEmbeddings > 0;
        }).length;

        // ---------------------------------------------------------------
        // PR-A (#25): graph-aware annotation, cross-vault.
        //
        // Calls getGraphSignals ONCE PER VAULT THAT HAS HITS (a cost-minimizer
        // that skips hit-less vaults), each per-vault build try/caught so one
        // vault's failure can't blank the others. ORDERING IS UNCHANGED (still
        // similarity desc — the sliced `topResults` order is preserved exactly);
        // per-hit `graph: null` semantics are identical to single-vault.
        // `graphAvailable` is a PER-VAULT MAP (provider surfaced per vault).
        // This does NOT add RRF/fusion to cross-vault (no scope creep).
        // ---------------------------------------------------------------
        const annotated = await annotateCrossVault({ config, results: topResults });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              vaultsSearched: config.vaults.length,
              vaultsIndexed: indexedVaults,
              resultCount: annotated.results.length,
              graphByVault: annotated.graphByVault,
              results: annotated.results
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Cross-vault semantic search error: ${error}` }],
          isError: true
        };
      }
    },

    find_note_by_name: async (args: {
      name: string;
      exactMatch?: boolean;
    }): Promise<ToolResponse> => {
      try {
        const searchName = args.name.toLowerCase();
        const matches: Array<{
          vault: string;
          path: string;
          title: string;
          modified: string;
        }> = [];

        for (const vault of config.vaults) {
          await findNotesByName(
            vault.path,
            vault.path,
            vault.name,
            searchName,
            args.exactMatch || false,
            matches
          );
        }

        // Sort by name relevance (exact matches first)
        matches.sort((a, b) => {
          const aExact = path.basename(a.path, '.md').toLowerCase() === searchName;
          const bExact = path.basename(b.path, '.md').toLowerCase() === searchName;
          if (aExact && !bExact) return -1;
          if (!aExact && bExact) return 1;
          return a.path.localeCompare(b.path);
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              searchName: args.name,
              exactMatch: args.exactMatch || false,
              foundCount: matches.length,
              matches
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Find note error: ${error}` }],
          isError: true
        };
      }
    },

    get_ecosystem_stats: async (): Promise<ToolResponse> => {
      try {
        const vaultStats: Array<{
          vault: string;
          totalFiles: number;
          totalEmbeddings: number;
          indexedPercent: number;
        }> = [];

        let totalFiles = 0;
        let totalEmbeddings = 0;

        for (const vault of config.vaults) {
          const files = await countMarkdownFiles(vault.path, vault.path);
          const storage = getStorage(vault);
          const stats = storage.getStats();

          totalFiles += files;
          totalEmbeddings += stats.totalEmbeddings;

          vaultStats.push({
            vault: vault.name,
            totalFiles: files,
            totalEmbeddings: stats.totalEmbeddings,
            indexedPercent: files > 0 ? Math.round((stats.totalEmbeddings / files) * 100) : 0
          });
        }

        // Check Ollama
        const ollama = await checkOllamaAvailability(ollamaConfig);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vaultCount: config.vaults.length,
              totalFiles,
              totalEmbeddings,
              overallIndexedPercent: totalFiles > 0 ? Math.round((totalEmbeddings / totalFiles) * 100) : 0,
              vaults: vaultStats,
              ollama: {
                available: ollama.available,
                model: ollamaConfig.model,
                hasModel: ollama.hasModel
              }
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Ecosystem stats error: ${error}` }],
          isError: true
        };
      }
    },

    get_cross_vault_links: async (args: {
      vault?: string;
    }): Promise<ToolResponse> => {
      try {
        // Build index of all note names across all vaults
        const noteIndex = new Map<string, { vault: string; path: string }[]>();

        for (const vault of config.vaults) {
          await buildNoteIndex(vault.path, vault.path, vault.name, noteIndex);
        }

        // Find unresolved links that could be in other vaults
        const potentialCrossLinks: Array<{
          sourceVault: string;
          sourcePath: string;
          unresolvedLink: string;
          potentialTargets: Array<{ vault: string; path: string }>;
        }> = [];

        const vaultsToCheck = args.vault
          ? config.vaults.filter(v => v.name.toLowerCase() === args.vault?.toLowerCase())
          : config.vaults;

        for (const vault of vaultsToCheck) {
          await findUnresolvedLinks(
            vault.path,
            vault.path,
            vault.name,
            noteIndex,
            potentialCrossLinks
          );
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalPotentialLinks: potentialCrossLinks.length,
              links: potentialCrossLinks.slice(0, 50) // Limit output
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Cross-vault links error: ${error}` }],
          isError: true
        };
      }
    }
  };
}

/**
 * Helper: Search a single vault for regex matches
 */
async function searchVault(
  vaultPath: string,
  regex: RegExp,
  maxResults: number,
  results: Array<{ path: string; matches: SearchMatch[] }> = [],
  currentDir?: string
): Promise<Array<{ path: string; matches: SearchMatch[] }>> {
  const dirPath = currentDir || vaultPath;

  if (results.length >= maxResults) return results;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await searchVault(vaultPath, regex, maxResults, results, fullPath);
    } else if (entry.name.endsWith('.md')) {
      const content = await fs.readFile(fullPath, 'utf-8');
      const matches = findMatches(content, regex);

      if (matches.length > 0) {
        results.push({
          path: path.relative(vaultPath, fullPath),
          matches
        });
      }
    }
  }

  return results;
}

/**
 * Helper: Find regex matches with context
 */
function findMatches(content: string, regex: RegExp): SearchMatch[] {
  const lines = content.split('\n');
  const matches: SearchMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    regex.lastIndex = 0;

    while ((match = regex.exec(line)) !== null) {
      matches.push({
        lineNumber: i + 1,
        lineContent: line.trim(),
        matchStart: match.index,
        matchEnd: match.index + match[0].length
      });

      if (match[0].length === 0) break;
    }
  }

  return matches;
}

/**
 * Helper: Find notes by name in a vault
 */
async function findNotesByName(
  dirPath: string,
  vaultPath: string,
  vaultName: string,
  searchName: string,
  exactMatch: boolean,
  matches: Array<{ vault: string; path: string; title: string; modified: string }>
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await findNotesByName(fullPath, vaultPath, vaultName, searchName, exactMatch, matches);
    } else if (entry.name.endsWith('.md')) {
      const baseName = path.basename(entry.name, '.md').toLowerCase();

      const isMatch = exactMatch
        ? baseName === searchName
        : baseName.includes(searchName);

      if (isMatch) {
        const stats = await fs.stat(fullPath);
        const relativePath = path.relative(vaultPath, fullPath);

        let title = path.basename(entry.name, '.md');
        try {
          const parsed = await parseMarkdownFile(relativePath, vaultPath);
          title = extractTitle(parsed);
        } catch {
          // Use filename as title
        }

        matches.push({
          vault: vaultName,
          path: relativePath,
          title,
          modified: stats.mtime.toISOString()
        });
      }
    }
  }
}

/**
 * Helper: Count markdown files in a vault
 */
async function countMarkdownFiles(
  dirPath: string,
  vaultPath: string
): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      count += await countMarkdownFiles(fullPath, vaultPath);
    } else if (entry.name.endsWith('.md')) {
      count++;
    }
  }

  return count;
}

/**
 * Helper: Build index of all note names
 */
async function buildNoteIndex(
  dirPath: string,
  vaultPath: string,
  vaultName: string,
  index: Map<string, { vault: string; path: string }[]>
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await buildNoteIndex(fullPath, vaultPath, vaultName, index);
    } else if (entry.name.endsWith('.md')) {
      const baseName = path.basename(entry.name, '.md').toLowerCase();
      const relativePath = path.relative(vaultPath, fullPath);

      if (!index.has(baseName)) {
        index.set(baseName, []);
      }
      index.get(baseName)!.push({ vault: vaultName, path: relativePath });
    }
  }
}

/**
 * Helper: Find unresolved links that could be in other vaults
 */
async function findUnresolvedLinks(
  dirPath: string,
  vaultPath: string,
  vaultName: string,
  noteIndex: Map<string, { vault: string; path: string }[]>,
  results: Array<{
    sourceVault: string;
    sourcePath: string;
    unresolvedLink: string;
    potentialTargets: Array<{ vault: string; path: string }>;
  }>
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await findUnresolvedLinks(fullPath, vaultPath, vaultName, noteIndex, results);
    } else if (entry.name.endsWith('.md')) {
      const content = await fs.readFile(fullPath, 'utf-8');
      const links = extractWikilinks(content);
      const relativePath = path.relative(vaultPath, fullPath);

      for (const link of links) {
        // Check if link resolves locally
        const linkName = path.basename(link.target).toLowerCase();
        const localMatches = noteIndex.get(linkName)?.filter(m => m.vault === vaultName) || [];

        if (localMatches.length === 0) {
          // Check if it exists in other vaults
          const otherVaultMatches = noteIndex.get(linkName)?.filter(m => m.vault !== vaultName) || [];

          if (otherVaultMatches.length > 0) {
            results.push({
              sourceVault: vaultName,
              sourcePath: relativePath,
              unresolvedLink: link.target,
              potentialTargets: otherVaultMatches
            });
          }
        }
      }
    }
  }
}
