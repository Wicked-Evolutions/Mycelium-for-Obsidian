/**
 * Cross-vault intelligence tools for Obsidian MCP
 * Phase 4: Unified ecosystem search and discovery
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  Config,
  resolvePathInVault,
  verifyPathAfterOpen,
  verifyFileHandleInVault
} from '../config.js';
import { ToolResponse, SearchMatch, VaultConfig } from '../types/index.js';
import { parseMarkdownFile, extractTitle } from '../parsers/markdown.js';
import { extractWikilinks } from '../parsers/wikilink.js';
import {
  extractObsidianUris,
  serializeObsidianUri,
  ObsidianUriOccurrence,
  ObsidianUriDiagnostic
} from '../parsers/obsidian-uri.js';
import {
  generateEmbedding,
  checkOllamaAvailability,
  cosineSimilarity,
  OllamaConfig
} from '../embeddings/ollama.js';
import { getSharedStorage } from '../embeddings/storage.js';
import { calculateIndexCoverage, coveragePercent, ratio } from '../embeddings/index-stats.js';
import { withAnnotations, ToolAnnotations } from './safety.js';
import { annotateCrossVault } from './graph-annotate.js';
import { DeclaredCrossVaultGraphBuilder, normalizeVaultRelativePath } from '../graph/cross-vault.js';
import { recoveryResponse } from '../tool-outcomes.js';
import {
  CompletenessReason,
  exactResultMetadata,
  limitReachedMetadata,
  partialCompletenessMetadata,
} from '../result-metadata.js';

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
    description: 'Find legacy unresolved-wikilink candidates, inventory labeled Markdown links to native obsidian://open note URIs, and compose eligible declarations into a typed read-only cross-vault graph overlay. Per-vault ranking is unchanged.',
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
        const maxPerVault = Math.max(0, Math.ceil(args.maxResultsPerVault || 10));

        const vaultResults: Array<{
          vault: string;
          vaultPath: string;
          results: Array<{ path: string; matches: SearchMatch[] }>;
          total?: number;
          returned?: number;
          truncated?: boolean;
          has_more?: boolean;
          limit_reached?: true;
          completeness?: {
            state: 'partial';
            scanned: number;
            skipped: number;
            reasons: CompletenessReason[];
          };
        }> = [];
        let scanned = 0;
        let skipped = 0;
        const reasons: CompletenessReason[] = [];
        let anyLimitReached = false;
        let allExact = true;
        let exactTotal = 0;

        for (const vault of config.vaults) {
          const scan = await searchVault(vault.path, regex, maxPerVault);
          const results = scan.results.slice(0, maxPerVault);
          const exact = !scan.limitReached && scan.skipped === 0;
          const metadata = exact
            ? exactResultMetadata(scan.results.length, results.length)
            : {
                ...limitReachedMetadata(scan.limitReached),
                ...partialCompletenessMetadata(scan.scanned, scan.skipped, scan.reasons),
              };
          vaultResults.push({
            vault: vault.name,
            vaultPath: vault.path,
            ...metadata,
            results,
          });
          scanned += scan.scanned;
          skipped += scan.skipped;
          reasons.push(...scan.reasons);
          anyLimitReached ||= scan.limitReached;
          allExact &&= exact;
          exactTotal += scan.results.length;
        }

        const totalResults = vaultResults.reduce((sum, v) => sum + v.results.length, 0);
        const metadata = allExact
          ? exactResultMetadata(exactTotal, totalResults)
          : {
              ...limitReachedMetadata(anyLimitReached),
              ...partialCompletenessMetadata(scanned, skipped, reasons),
            };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              vaultsSearched: config.vaults.length,
              totalResults,
              ...metadata,
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
          return recoveryResponse({
            status: 'unavailable',
            code: ollama.available ? 'model_unavailable' : 'ollama_unavailable',
            message: ollama.available
              ? 'The configured embedding model is not available in Ollama.'
              : 'The Ollama embedding service is not available.',
            hint: ollama.available
              ? `Install the configured ${ollamaConfig.model} model in Ollama, then retry.`
              : 'Start Ollama and verify the configured host, then retry.',
            retryable: true,
            sideEffects: { state: 'none' }
          });
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
        const resultMetadataByVault: Array<{
          vault: string;
          state: 'searched' | 'unindexed' | 'failed';
          limit_reached?: true;
          completeness?: {
            state: 'partial';
            scanned: number;
            skipped: number;
            reasons: CompletenessReason[];
          };
        }> = [];
        let searchedVaults = 0;
        let skippedVaults = 0;
        let indexedVaults = 0;
        let anyProviderLimitReached = false;
        const semanticReasons: CompletenessReason[] = [];

        for (const vault of config.vaults) {
          try {
            const storage = getStorage(vault);
            const stats = storage.getStats();

            if (stats.totalEmbeddings === 0) {
              skippedVaults += 1;
              semanticReasons.push('vault_unindexed');
              resultMetadataByVault.push({
                vault: vault.name,
                state: 'unindexed',
                ...partialCompletenessMetadata(0, 1, ['vault_unindexed']),
              });
              continue;
            }

            indexedVaults += 1;
            const historicalCap = limit * 2;
            const fetched = storage.search(
              queryResult.embedding,
              historicalCap + 1,
              minSimilarity
            );
            const providerLimitReached = fetched.length > historicalCap;
            const vaultResults = fetched.slice(0, historicalCap);
            anyProviderLimitReached ||= providerLimitReached;

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

            searchedVaults += 1;
            resultMetadataByVault.push({
              vault: vault.name,
              state: 'searched',
              ...limitReachedMetadata(providerLimitReached),
            });
          } catch {
            skippedVaults += 1;
            semanticReasons.push('vault_search_failed');
            resultMetadataByVault.push({
              vault: vault.name,
              state: 'failed',
              ...partialCompletenessMetadata(0, 1, ['vault_search_failed']),
            });
          }
        }

        // Sort by similarity and limit
        allResults.sort((a, b) => b.similarity - a.similarity);
        const topResults = allResults.slice(0, limit);

        const globalLimitReached = allResults.length > limit;

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
              ...limitReachedMetadata(anyProviderLimitReached || globalLimitReached),
              ...partialCompletenessMetadata(
                searchedVaults,
                skippedVaults,
                semanticReasons
              ),
              resultMetadataByVault,
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
        }> = [];

        let totalFiles = 0;
        let totalEmbeddings = 0;
        let totalIndexedFilePathCount = 0;
        let totalCurrentIndexedFiles = 0;
        let totalStaleIndexedFiles = 0;
        let totalCurrentEmbeddingChunks = 0;
        let totalStaleEmbeddingChunks = 0;

        for (const vault of config.vaults) {
          const files = await collectMarkdownFilePaths(vault.path, vault.path);
          const storage = getStorage(vault);
          const coverage = calculateIndexCoverage(
            vault.path,
            files,
            storage.getPathStats(),
            { staleSampleLimit: 0 }
          );

          totalFiles += coverage.currentMarkdownFiles;
          totalEmbeddings += coverage.embeddingChunks;
          totalIndexedFilePathCount += coverage.indexedFilePathCount;
          totalCurrentIndexedFiles += coverage.currentIndexedFiles;
          totalStaleIndexedFiles += coverage.staleIndexedFiles;
          totalCurrentEmbeddingChunks += coverage.currentEmbeddingChunks;
          totalStaleEmbeddingChunks += coverage.staleEmbeddingChunks;

          vaultStats.push({
            vault: vault.name,
            totalFiles: coverage.currentMarkdownFiles,
            totalEmbeddings: coverage.embeddingChunks,
            indexedPercent: coverage.fileCoveragePercent,
            currentMarkdownFiles: coverage.currentMarkdownFiles,
            indexedFilePathCount: coverage.indexedFilePathCount,
            currentIndexedFiles: coverage.currentIndexedFiles,
            staleIndexedFiles: coverage.staleIndexedFiles,
            embeddingChunks: coverage.embeddingChunks,
            currentEmbeddingChunks: coverage.currentEmbeddingChunks,
            staleEmbeddingChunks: coverage.staleEmbeddingChunks,
            fileCoveragePercent: coverage.fileCoveragePercent,
            embeddingChunksPerCurrentIndexedFile: coverage.embeddingChunksPerCurrentIndexedFile,
            embeddingChunksPerCurrentMarkdownFile: coverage.embeddingChunksPerCurrentMarkdownFile
          });
        }

        const overallFileCoveragePercent = coveragePercent(totalCurrentIndexedFiles, totalFiles);

        // Check Ollama
        const ollama = await checkOllamaAvailability(ollamaConfig);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vaultCount: config.vaults.length,
              totalFiles,
              totalEmbeddings,
              overallIndexedPercent: overallFileCoveragePercent,
              totalMarkdownFiles: totalFiles,
              totalIndexedFilePathCount,
              totalCurrentIndexedFiles,
              totalStaleIndexedFiles,
              totalEmbeddingChunks: totalEmbeddings,
              totalCurrentEmbeddingChunks,
              totalStaleEmbeddingChunks,
              overallFileCoveragePercent,
              embeddingChunksPerCurrentIndexedFile: ratio(totalCurrentEmbeddingChunks, totalCurrentIndexedFiles),
              embeddingChunksPerCurrentMarkdownFile: ratio(totalCurrentEmbeddingChunks, totalFiles),
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

        const { nativeUriInventory, declaredCrossVaultGraph } = await inventoryNativeUris(config, vaultsToCheck);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalPotentialLinks: potentialCrossLinks.length,
              links: potentialCrossLinks.slice(0, 50), // Limit output
              nativeUriInventory,
              declaredCrossVaultGraph
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

type NativeUriStatus = 'valid' | 'noncanonical' | 'malformed' | 'unsupported' |
  'unknown_vault' | 'ambiguous_vault' | 'invalid_path' | 'missing_destination' | 'same_vault_reference';

function parserStatus(uri: ObsidianUriOccurrence): NativeUriStatus | undefined {
  const codes = new Set(uri.diagnostics.map(d => d.code));
  if (codes.has('malformed_uri') || codes.has('malformed_percent_encoding') || codes.has('missing_query') || codes.has('missing_vault') || codes.has('missing_file') || codes.has('duplicate_query_param') || codes.has('invalid_subpath')) return 'malformed';
  if (codes.has('invalid_path')) return 'invalid_path';
  if (codes.has('unsupported_action') || codes.has('unsupported_shorthand') || codes.has('path_override') || codes.has('fragment') || codes.has('unknown_query_param') || codes.has('non_markdown_target')) return 'unsupported';
  return undefined;
}

async function markdownFiles(vaultPath: string, current = vaultPath, files: string[] = []): Promise<string[]> {
  const relativeDirectory = path.relative(vaultPath, current);
  const safeDirectory = resolvePathInVault(vaultPath, relativeDirectory);
  await verifyPathAfterOpen(safeDirectory, vaultPath);
  const entries = await fs.readdir(safeDirectory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(safeDirectory, entry.name);
    if (entry.isDirectory()) await markdownFiles(vaultPath, full, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(normalizeVaultRelativePath(path.relative(vaultPath, full)));
    }
  }
  return files;
}

/**
 * Inventory official cross-vault URIs independently of the legacy wikilink
 * candidate algorithm. It intentionally retains every source occurrence.
 */
async function inventoryNativeUris(config: Config, sourceVaults: VaultConfig[]) {
  const records: Array<Record<string, unknown>> = [];
  const counts: Record<NativeUriStatus, number> = {
    valid: 0, noncanonical: 0, malformed: 0, unsupported: 0,
    unknown_vault: 0, ambiguous_vault: 0, invalid_path: 0,
    missing_destination: 0, same_vault_reference: 0,
  };
  let totalFound = 0;
  const graphBuilder = new DeclaredCrossVaultGraphBuilder(config.vaults.map(vault => vault.name));
  const vaultNameCounts = new Map<string, number>();
  for (const vault of config.vaults) {
    const key = vault.name.toLowerCase();
    vaultNameCounts.set(key, (vaultNameCounts.get(key) || 0) + 1);
  }
  const physicalVaultPaths = new Map<VaultConfig, string>();
  for (const vault of config.vaults) {
    try {
      physicalVaultPaths.set(vault, await fs.realpath(vault.path));
    } catch {
      // A later scan/open will surface the inaccessible vault through the tool error.
    }
  }

  for (const sourceVault of sourceVaults) {
    for (const sourcePath of await markdownFiles(sourceVault.path)) {
      const sourceAbsolute = resolvePathInVault(sourceVault.path, sourcePath);
      let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let content: string;
      try {
        sourceHandle = await fs.open(sourceAbsolute, 'r');
        await verifyFileHandleInVault(sourceHandle, sourceAbsolute, sourceVault.path);
        content = await sourceHandle.readFile('utf8');
      } finally {
        await sourceHandle?.close();
      }
      for (const uri of extractObsidianUris(content)) {
        totalFound++;
        const diagnostics: ObsidianUriDiagnostic[] = [...uri.diagnostics];
        const parsedStatus = parserStatus(uri);
        let status: NativeUriStatus = parsedStatus || 'malformed';
        let destinationVault: VaultConfig | undefined;
        let destinationPath: string | undefined;
        let actualDestinationPath: string | undefined;
        let destinationExists: boolean | undefined;
        let canonicalUri = uri.canonicalUri;
        let relationshipType: 'cross_vault' | 'same_vault' | 'unknown' = 'unknown';
        let physicalVaultAlias = false;
        let physicalIdentityUnavailable = false;
        const sourceVaultAmbiguous = (vaultNameCounts.get(sourceVault.name.toLowerCase()) || 0) > 1;
        const matchingVaults = uri.vault
          ? config.vaults.filter(v => v.name.toLowerCase() === uri.vault!.toLowerCase())
          : [];
        if (!parsedStatus) {
          if (matchingVaults.length === 0) {
            status = 'unknown_vault';
            diagnostics.push({
              code: 'unknown_vault',
              severity: 'error',
              message: `Destination vault is not configured: ${uri.vault || '(missing)'}.`
            });
          } else if (matchingVaults.length > 1) {
            status = 'ambiguous_vault';
            diagnostics.push({
              code: 'ambiguous_vault',
              severity: 'error',
              message: `More than one configured vault matches ${uri.vault}.`
            });
          }
          else {
            destinationVault = matchingVaults[0];
            const sameVault = destinationVault === sourceVault;
            relationshipType = sameVault ? 'same_vault' : 'cross_vault';

            if (!uri.file) status = 'malformed';
            else {
              canonicalUri = serializeObsidianUri({
                vault: destinationVault.name,
                file: uri.file,
                subpath: uri.subpath
              });
              const noncanonical = uri.noncanonical || canonicalUri !== uri.raw;
              if (canonicalUri !== uri.raw && !diagnostics.some(d => d.code === 'noncanonical_uri')) {
                diagnostics.push({
                  code: 'noncanonical_uri',
                  severity: 'warning',
                  message: 'URI differs from the stable configured-vault serialization.'
                });
              }
              if (sameVault) {
                diagnostics.push({
                  code: 'same_vault_reference',
                  severity: 'warning',
                  message: 'This URI points into its source vault; use a native wikilink for same-vault note relationships.'
                });
              }

              // Obsidian's extensionless Markdown form maps to this exact path,
              // not to a basename search or fuzzy resolution.
              destinationPath = /\.md$/i.test(uri.file) ? uri.file : `${uri.file}.md`;
              try {
                const destination = resolvePathInVault(destinationVault.path, destinationPath);
                let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
                try {
                  handle = await fs.open(destination, 'r');
                  const verifiedRealDestination = await verifyFileHandleInVault(
                    handle,
                    destination,
                    destinationVault.path
                  );
                  const stat = await handle.stat();
                  destinationExists = stat.isFile();
                  if (destinationExists) {
                    const realDestinationVault = physicalVaultPaths.get(destinationVault);
                    if (realDestinationVault) {
                      actualDestinationPath = normalizeVaultRelativePath(
                        path.relative(realDestinationVault, verifiedRealDestination)
                      );
                    }
                  }
                } catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  if (code === 'ENOENT' || code === 'ENOTDIR') destinationExists = false;
                  else throw error;
                } finally {
                  await handle?.close();
                }
                if (!destinationExists) {
                  status = 'missing_destination';
                  diagnostics.push({
                    code: 'missing_destination',
                    severity: 'error',
                    message: 'The configured destination note does not exist at the explicit vault-relative path.'
                  });
                }
                else if (sameVault) status = 'same_vault_reference';
                else status = noncanonical ? 'noncanonical' : 'valid';
                const sourcePhysical = physicalVaultPaths.get(sourceVault);
                const destinationPhysical = physicalVaultPaths.get(destinationVault);
                physicalIdentityUnavailable = !sourcePhysical || !destinationPhysical;
                physicalVaultAlias = !!sourcePhysical && !!destinationPhysical
                  && sourcePhysical === destinationPhysical;
              } catch (error) {
                if (!(error instanceof Error) || !/path traversal|absolute paths|symlink escape/i.test(error.message)) {
                  throw error;
                }
                destinationExists = false;
                status = 'invalid_path';
              }
            }
          }
        }
        counts[status]++;
        graphBuilder.observe({
          status,
          relationshipType,
          source: { vault: sourceVault.name, path: sourcePath },
          ...(destinationVault && actualDestinationPath && destinationExists !== undefined ? {
            target: {
              vault: destinationVault.name,
              path: actualDestinationPath,
              exists: destinationExists
            }
          } : {}),
          ...(uri.subpath ? { subpath: uri.subpath } : {}),
          diagnostics,
          physicalVaultAlias,
          physicalIdentityUnavailable,
          sourceVaultAmbiguous
        });
        if (records.length < 100) {
          records.push({
            status,
            sourceVault: sourceVault.name,
            sourcePath,
            raw: uri.raw,
            label: uri.label,
            offset: uri.offset,
            line: uri.line,
            column: uri.column,
            vault: uri.vault,
            file: uri.file,
            ...(uri.subpath ? { subpath: uri.subpath } : {}),
            ...(canonicalUri ? { canonicalUri } : {}),
            relationshipType,
            ...(destinationVault ? {
              destination: {
                vault: destinationVault.name,
                ...(destinationPath ? { path: destinationPath } : {}),
                ...(destinationExists !== undefined ? { exists: destinationExists } : {})
              }
            } : {}),
            diagnostics,
          });
        }
      }
    }
  }
  return {
    nativeUriInventory: {
      scannedVaults: sourceVaults.map(v => v.name),
      totalFound,
      returnedCount: records.length,
      maxReturned: 100,
      truncated: totalFound > records.length,
      summary: counts,
      records,
    },
    declaredCrossVaultGraph: graphBuilder.build()
  };
}

/**
 * Helper: Search a single vault for regex matches
 */
interface VaultTextSearchScan {
  results: Array<{ path: string; matches: SearchMatch[] }>;
  scanned: number;
  skipped: number;
  reasons: CompletenessReason[];
  limitReached: boolean;
}

async function searchVault(
  vaultPath: string,
  regex: RegExp,
  maxResults: number
): Promise<VaultTextSearchScan> {
  const scan: VaultTextSearchScan = {
    results: [],
    scanned: 0,
    skipped: 0,
    reasons: [],
    limitReached: false,
  };

  const scanDirectory = async (dirPath: string, root: boolean): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      scan.skipped += 1;
      scan.reasons.push(root ? 'vault_unavailable' : 'directory_unavailable');
      return;
    }

    for (const entry of entries) {
      if (scan.limitReached) return;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(fullPath, false);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        scan.skipped += 1;
        scan.reasons.push('file_unreadable');
        continue;
      }

      const matches = findMatches(content, regex);
      scan.scanned += 1;
      if (matches.length === 0) continue;

      scan.results.push({
        path: path.relative(vaultPath, fullPath),
        matches
      });
      if (scan.results.length > maxResults) {
        scan.limitReached = true;
      }
    }
  };

  await scanDirectory(vaultPath, true);
  return scan;
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
 * Helper: Collect markdown file paths in a vault
 */
async function collectMarkdownFilePaths(
  dirPath: string,
  vaultPath: string,
  files: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectMarkdownFilePaths(fullPath, vaultPath, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(path.relative(vaultPath, fullPath));
    }
  }

  return files;
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
