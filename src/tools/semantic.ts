/**
 * Semantic search tools for Obsidian MCP
 * Phase 3: Embedding-based search via Ollama
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault, resolvePathInVault } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { parseMarkdownFile, extractTitle, extractSections } from '../parsers/markdown.js';
import {
  generateEmbedding,
  checkOllamaAvailability,
  OllamaConfig
} from '../embeddings/ollama.js';
import { getSharedStorage } from '../embeddings/storage.js';
import { reciprocalRankFusion, RRF_K } from '../embeddings/rrf.js';
import { vaultParam } from './schema-helpers.js';
import { withAnnotations, ToolAnnotations } from './safety.js';
import { attachGraphSignals } from './graph-annotate.js';

/**
 * Get storage instance for a vault (shared singleton per vault path)
 */
function getStorage(vaultPath: string) {
  return getSharedStorage(vaultPath);
}

/**
 * Generate content hash for change detection
 */
function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Expand query into multiple variants using Ollama
 * Returns original query plus up to 3 alternative phrasings
 */
async function expandQuery(query: string, ollamaConfig: OllamaConfig): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaConfig.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',  // Fast model for expansion
        prompt: `Generate 2 alternative search queries for: "${query}"

Rules:
- Each alternative should capture the same intent differently
- Use different keywords and phrasings
- Output ONLY the queries, one per line, no numbering or explanations

Alternative queries:`,
        stream: false
      })
    });

    if (!response.ok) {
      return [query];  // Fallback to original
    }

    const data = await response.json() as { response: string };
    const alternatives = data.response
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 3 && line.length < 200)
      .slice(0, 2);

    return [query, ...alternatives];
  } catch {
    return [query];  // Fallback to original on error
  }
}

/**
 * Tool definitions for semantic search
 */
const rawSemanticTools: Tool[] = [
  {
    name: 'semantic_search',
    description: 'Search vault using hybrid semantic + keyword search. Finds content by meaning and exact matches. Requires indexed vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        query: {
          type: 'string',
          description: 'Natural language query (e.g., "notes about marketing strategy")'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 10
        },
        minSimilarity: {
          type: 'number',
          description: 'Minimum similarity score (0-1)',
          default: 0.5
        },
        expand: {
          type: 'boolean',
          description: 'Expand query into multiple variants for better recall',
          default: false
        }
      },
      required: ['query']
    }
  },
  {
    name: 'index_vault',
    description: 'Build or rebuild the semantic search index. Processes all markdown files and generates embeddings. May take a while for large vaults.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        force: {
          type: 'boolean',
          description: 'Re-index all files even if unchanged',
          default: false
        },
        directory: {
          type: 'string',
          description: 'Only index files in this directory'
        }
      }
    }
  },
  {
    name: 'index_file',
    description: 'Index a single file for semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'get_similar',
    description: 'Find files similar to a given file based on semantic similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the reference file'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 5
        }
      },
      required: ['path']
    }
  },
  {
    name: 'index_status',
    description: 'Get status of the semantic search index.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam
      }
    }
  }
];

/**
 * Per-tool annotations. index_vault/index_file write the DERIVED semantic index
 * (SQLite embeddings), not vault notes → readOnlyHint:false + idempotentHint:true,
 * exempt from the read-only guard via DERIVED_INDEX_EXEMPT.
 */
const semanticAnnotations: Record<string, ToolAnnotations> = {
  semantic_search: { readOnlyHint: true },
  index_vault: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  index_file: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  get_similar: { readOnlyHint: true },
  index_status: { readOnlyHint: true },
};

export const semanticTools: Tool[] = withAnnotations(rawSemanticTools, semanticAnnotations);

/**
 * Handler functions for semantic tools
 */
export function createSemanticHandlers(config: Config) {
  const ollamaConfig: OllamaConfig = {
    host: config.ollama.host,
    model: config.ollama.model
  };

  return {
    semantic_search: async (args: {
      vault?: string;
      query: string;
      limit?: number;
      minSimilarity?: number;
      expand?: boolean;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);

        // Check Ollama availability
        const ollama = await checkOllamaAvailability(ollamaConfig);
        if (!ollama.available || !ollama.hasModel) {
          return {
            content: [{ type: 'text', text: `Ollama not ready: ${ollama.error}` }],
            isError: true
          };
        }

        const store = getStorage(vault.path);
        const stats = store.getStats();

        if (stats.totalEmbeddings === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'No indexed content. Run index_vault first.',
                indexed: 0
              }, null, 2)
            }],
            isError: false
          };
        }

        const limit = args.limit || 10;
        const minSimilarity = args.minSimilarity || 0.5;

        // Optionally expand query into multiple variants
        const queries = args.expand
          ? await expandQuery(args.query, ollamaConfig)
          : [args.query];

        // Collect results from all query variants
        const allSemanticResults: Array<{
          filePath: string;
          blockId: string | null;
          similarity: number;
          metadata: Record<string, unknown>;
        }> = [];
        const allKeywordResults: Array<{
          filePath: string;
          blockId: string | null;
          score: number;
        }> = [];

        for (const q of queries) {
          // Generate embedding for this query variant
          const queryResult = await generateEmbedding(q, ollamaConfig);

          // Semantic search. `minSimilarity` acts ONLY as the embeddings
          // candidate-floor here (a cosine cutoff on which docs enter fusion);
          // it is deliberately NOT re-applied to the fused RRF totals later,
          // which live in a much smaller numeric range (~0.016–0.033) and would
          // be silently collapsed by any post-fusion minSimilarity gate.
          const semResults = store.search(
            queryResult.embedding,
            limit * 2,  // Get extra candidates for fusion
            minSimilarity  // Embeddings candidate-floor (cosine cutoff)
          );
          allSemanticResults.push(...semResults);

          // Keyword search
          const kwResults = store.keywordSearch(q, limit * 2);
          allKeywordResults.push(...kwResults);
        }

        // ---------------------------------------------------------------
        // Fusion via Reciprocal Rank Fusion (RRF, k=60 const).
        //
        // Each candidate is keyed by `${filePath}:${blockId}`. We first collapse
        // the (possibly multi-variant, when expand=true) raw lists into exactly
        // ONE embeddings ranking and ONE bm25 ranking — unique docs, best signal
        // value first — then RRF the two. This avoids double-counting a doc that
        // appears across query variants and keeps each per-signal rank unambiguous.
        //
        // `similarity`/`semanticScore`/`keywordScore` keep their existing numeric
        // meanings (the 0.7/0.3 weighted blend is reported as `similarity` for
        // back-compat, now informational); results are ORDERED by `fusionScore`.
        // ---------------------------------------------------------------

        // Per-candidate accumulators: best semantic similarity and best (max)
        // keyword score seen across all query variants.
        const bestSemantic = new Map<string, number>();
        const bestKeyword = new Map<string, number>();
        const candidate = new Map<string, {
          filePath: string;
          blockId: string | null;
          metadata: Record<string, unknown>;
        }>();

        for (const r of allSemanticResults) {
          const key = `${r.filePath}:${r.blockId || ''}`;
          if (!candidate.has(key)) {
            candidate.set(key, { filePath: r.filePath, blockId: r.blockId, metadata: r.metadata });
          }
          const prev = bestSemantic.get(key);
          if (prev === undefined || r.similarity > prev) bestSemantic.set(key, r.similarity);
        }

        for (const r of allKeywordResults) {
          const key = `${r.filePath}:${r.blockId || ''}`;
          if (!candidate.has(key)) {
            candidate.set(key, { filePath: r.filePath, blockId: r.blockId, metadata: {} });
          }
          const prev = bestKeyword.get(key);
          if (prev === undefined || r.score > prev) bestKeyword.set(key, r.score);
        }

        // Normalize keyword (BM25) scores to 0-1 for the informational keywordScore.
        const maxKeywordScore = Math.max(...bestKeyword.values(), 1);

        // Build the two single rankings (best value first → 1-based rank order).
        const embeddingsRanking = Array.from(bestSemantic.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([key]) => key);
        const bm25Ranking = Array.from(bestKeyword.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([key]) => key);

        const fused = reciprocalRankFusion([
          { name: 'bm25', ranked: bm25Ranking },
          { name: 'embeddings', ranked: embeddingsRanking },
        ]);

        // Map fused rows back to enriched candidates. fusionScore order is the
        // canonical ordering; minSimilarity is NOT re-applied here (it was the
        // embeddings candidate-floor in store.search above). Dedup by file,
        // keeping the first (highest-fusionScore) occurrence, then slice to limit.
        const seen = new Set<string>();
        const results: Array<{
          filePath: string;
          blockId: string | null;
          semanticScore: number;
          keywordScore: number;
          combinedScore: number;
          fusionScore: number;
          perSignal: Record<string, { rank: number | null; term: number }>;
          metadata: Record<string, unknown>;
        }> = [];

        for (const row of fused) {
          const c = candidate.get(row.id);
          if (!c) continue;
          if (seen.has(c.filePath)) continue;
          seen.add(c.filePath);

          const semanticScore = bestSemantic.get(row.id) ?? 0;
          const rawKeyword = bestKeyword.get(row.id) ?? 0;
          const keywordScore = rawKeyword / maxKeywordScore; // 0-1, informational
          const combinedScore = semanticScore * 0.7 + keywordScore * 0.3; // legacy blend

          results.push({
            filePath: c.filePath,
            blockId: c.blockId,
            semanticScore,
            keywordScore,
            combinedScore,
            fusionScore: row.fusionScore,
            perSignal: row.perSignal,
            metadata: c.metadata,
          });

          if (results.length >= limit) break;
        }

        // Enrich results with file titles.
        // Response contract: `similarity`/`semanticScore`/`keywordScore` keep their
        // existing numeric meanings (back-compat). Additive fusion fields:
        //   fusionScore     — RRF total (results are ordered by this)
        //   fusionMethod    — "rrf"
        //   per_signal      — {bm25, embeddings} 1-based ranks (null if absent)
        //   rrf_term        — per-signal 1/(k+rank) contributions + k (reconstructs fusionScore)
        //   reranker_score  — null (clean hook; cross-encoder reranker not built)
        const round3 = (n: number) => Math.round(n * 1000) / 1000;
        const enrichedResults = await Promise.all(results.map(async r => {
          const bm25 = r.perSignal.bm25 ?? { rank: null, term: 0 };
          const embeddings = r.perSignal.embeddings ?? { rank: null, term: 0 };
          const fusionFields = {
            similarity: round3(r.combinedScore),
            semanticScore: round3(r.semanticScore),
            keywordScore: round3(r.keywordScore),
            fusionScore: r.fusionScore,
            fusionMethod: 'rrf' as const,
            per_signal: {
              bm25: { rank: bm25.rank },
              embeddings: { rank: embeddings.rank },
            },
            rrf_term: {
              k: RRF_K,
              bm25: bm25.term,
              embeddings: embeddings.term,
            },
            reranker_score: null,
          };
          try {
            const parsed = await parseMarkdownFile(r.filePath, vault.path);
            return {
              path: r.filePath,
              title: extractTitle(parsed),
              ...fusionFields,
              preview: parsed.content.slice(0, 200) + (parsed.content.length > 200 ? '...' : '')
            };
          } catch {
            return {
              path: r.filePath,
              title: path.basename(r.filePath, '.md'),
              ...fusionFields,
              preview: ''
            };
          }
        }));

        // ---------------------------------------------------------------
        // Convergence (#23): graph-aware annotation (Level A + Level B).
        //
        // ONE guarded getGraphSignals(config, vault, undefined) call (DEFAULT_EXCLUDE
        // — so `level` means the same as analyze_link_hierarchy) enriches each hit
        // with a nested additive `graph` block (raw signals only). Ordering NEVER
        // changes (still fusionScore); zero new input params, zero existing-field
        // churn. On global graph-build failure the hits are returned un-annotated
        // with graphAvailable:false + a reason — search NEVER errors on this.
        //
        // Join is on the VAULT-RELATIVE path (with .md), NFC-normalized both sides.
        // A per-hit miss (path not in the map) yields that hit's `graph: null`.
        // ---------------------------------------------------------------
        const graphAttach = await attachGraphSignals({
          config,
          vault: args.vault,
          results: enrichedResults
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              queriesUsed: queries,  // Show expanded queries if any
              resultCount: graphAttach.results.length,
              searchType: args.expand ? 'hybrid+expansion' : 'hybrid',
              graphAvailable: graphAttach.graphAvailable,
              ...(graphAttach.graphAvailable
                ? {
                    activeExclude: graphAttach.activeExclude,
                    usedDefaultExclude: graphAttach.usedDefaultExclude
                  }
                : { graphUnavailableReason: graphAttach.graphUnavailableReason }),
              results: graphAttach.results
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Semantic search error: ${error}` }],
          isError: true
        };
      }
    },

    index_vault: async (args: {
      vault?: string;
      force?: boolean;
      directory?: string;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);

        // Check Ollama availability
        const ollama = await checkOllamaAvailability(ollamaConfig);
        if (!ollama.available || !ollama.hasModel) {
          return {
            content: [{ type: 'text', text: `Ollama not ready: ${ollama.error}` }],
            isError: true
          };
        }

        const store = getStorage(vault.path);
        const searchDir = args.directory
          ? resolvePathInVault(vault.path, args.directory)
          : vault.path;

        let indexedSections = 0;
        let indexedFiles = 0;
        let skipped = 0;
        let errors = 0;

        // Collect all markdown files
        const files = await collectMarkdownFiles(searchDir, vault.path);

        for (const filePath of files) {
          try {
            // Skip files larger than 50 MB to prevent OOM during indexing
            const fileStat = await fs.stat(path.join(vault.path, filePath));
            if (fileStat.size > 50 * 1024 * 1024) {
              skipped++;
              continue;
            }

            const content = await fs.readFile(path.join(vault.path, filePath), 'utf-8');

            // Skip empty or nearly empty files
            const trimmedContent = content.trim();
            if (trimmedContent.length < 10) {
              skipped++;
              continue;
            }

            // Extract sections for heading-based chunking
            const sections = extractSections(trimmedContent);

            // If no sections found (no headings), index whole file
            if (sections.length === 0) {
              const contentHash = hashContent(content);

              // Skip if already indexed and unchanged
              if (!args.force && store.isUpToDate(filePath, contentHash)) {
                skipped++;
                continue;
              }

              const result = await generateEmbedding(content, ollamaConfig);
              if (result.embedding && result.embedding.length > 0) {
                store.store(filePath, result.embedding, contentHash, {
                  indexedAt: new Date().toISOString(),
                  chunked: false
                }, null, content);  // Pass content for FTS
                indexedSections++;
                indexedFiles++;
              }
              continue;
            }

            // Delete old embeddings for this file before re-indexing sections
            if (args.force) {
              store.delete(filePath);
            }

            let fileIndexed = false;

            // Index each section separately
            for (const section of sections) {
              // Skip very short sections
              if (section.content.length < 20 && !section.heading) {
                continue;
              }

              // Create section content with heading for context
              const sectionText = section.heading
                ? `${section.heading}\n\n${section.content}`
                : section.content;

              const sectionHash = hashContent(sectionText);

              // Skip if this section is unchanged
              if (!args.force && store.isUpToDate(filePath, sectionHash, section.blockId)) {
                continue;
              }

              // Generate embedding for section
              const result = await generateEmbedding(sectionText, ollamaConfig);

              if (!result.embedding || result.embedding.length === 0) {
                continue;
              }

              // Store with blockId for section-level tracking
              store.store(filePath, result.embedding, sectionHash, {
                indexedAt: new Date().toISOString(),
                heading: section.heading,
                level: section.level,
                startLine: section.startLine,
                chunked: true
              }, section.blockId, sectionText);  // Pass content for FTS

              indexedSections++;
              fileIndexed = true;
            }

            if (fileIndexed) {
              indexedFiles++;
            } else {
              // All sections were up-to-date or skipped (short/empty) — count as skipped
              // so that: indexedFiles + skipped + errors === totalFiles
              skipped++;
            }

            // Log progress every 10 files
            if (indexedFiles > 0 && indexedFiles % 10 === 0) {
              console.error(`[mcp-obsidian] Indexed ${indexedFiles} files (${indexedSections} sections)...`);
            }
          } catch (err) {
            console.error(`[mcp-obsidian] Error indexing ${filePath}:`, err);
            errors++;
          }
        }

        // Clean up stale embeddings for deleted/renamed files
        const staleRemoved = store.deleteStale(vault.path);
        if (staleRemoved > 0) {
          console.error(`[mcp-obsidian] Removed ${staleRemoved} stale embedding(s) for deleted files`);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              indexedFiles,
              indexedSections,
              skipped,
              errors,
              staleRemoved,
              totalFiles: files.length
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Index error: ${error}` }],
          isError: true
        };
      }
    },

    index_file: async (args: { vault?: string; path: string }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);

        // Check Ollama availability
        const ollama = await checkOllamaAvailability(ollamaConfig);
        if (!ollama.available || !ollama.hasModel) {
          return {
            content: [{ type: 'text', text: `Ollama not ready: ${ollama.error}` }],
            isError: true
          };
        }

        const store = getStorage(vault.path);
        const absolutePath = resolvePathInVault(vault.path, args.path);

        const content = await fs.readFile(absolutePath, 'utf-8');

        // Delete old embeddings for this file
        store.delete(args.path);

        // Extract sections for heading-based chunking
        const sections = extractSections(content.trim());

        let indexedSections = 0;

        if (sections.length === 0) {
          // No headings - index whole file
          const contentHash = hashContent(content);
          const result = await generateEmbedding(content, ollamaConfig);

          if (result.embedding && result.embedding.length > 0) {
            store.store(args.path, result.embedding, contentHash, {
              indexedAt: new Date().toISOString(),
              chunked: false
            }, null, content);  // Pass content for FTS
            indexedSections = 1;
          }
        } else {
          // Index each section
          for (const section of sections) {
            if (section.content.length < 20 && !section.heading) {
              continue;
            }

            const sectionText = section.heading
              ? `${section.heading}\n\n${section.content}`
              : section.content;

            const sectionHash = hashContent(sectionText);
            const result = await generateEmbedding(sectionText, ollamaConfig);

            if (result.embedding && result.embedding.length > 0) {
              store.store(args.path, result.embedding, sectionHash, {
                indexedAt: new Date().toISOString(),
                heading: section.heading,
                level: section.level,
                startLine: section.startLine,
                chunked: true
              }, section.blockId, sectionText);  // Pass content for FTS
              indexedSections++;
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              indexed: true,
              path: args.path,
              sections: indexedSections
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Index file error: ${error}` }],
          isError: true
        };
      }
    },

    get_similar: async (args: {
      vault?: string;
      path: string;
      limit?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const store = getStorage(vault.path);

        // Get embedding for reference file
        const stored = store.get(args.path);

        if (!stored) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'File not indexed. Run index_file first.',
                path: args.path
              }, null, 2)
            }],
            isError: false
          };
        }

        // Handle empty embeddings
        if (!stored.embedding || stored.embedding.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'File has empty embedding (likely empty/minimal content). Try re-indexing.',
                path: args.path
              }, null, 2)
            }],
            isError: false
          };
        }

        // Search for similar (excluding self)
        const results = store.search(stored.embedding, (args.limit || 5) + 1, 0)
          .filter(r => r.filePath !== args.path)
          .slice(0, args.limit || 5);

        // Enrich results
        const enrichedResults = await Promise.all(results.map(async r => {
          try {
            const parsed = await parseMarkdownFile(r.filePath, vault.path);
            return {
              path: r.filePath,
              title: extractTitle(parsed),
              similarity: Math.round(r.similarity * 1000) / 1000
            };
          } catch {
            return {
              path: r.filePath,
              title: path.basename(r.filePath, '.md'),
              similarity: Math.round(r.similarity * 1000) / 1000
            };
          }
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              referencePath: args.path,
              similarFiles: enrichedResults
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Get similar error: ${error}` }],
          isError: true
        };
      }
    },

    index_status: async (args: { vault?: string }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const store = getStorage(vault.path);
        const stats = store.getStats();

        // Check Ollama
        const ollama = await checkOllamaAvailability(ollamaConfig);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              totalEmbeddings: stats.totalEmbeddings,
              uniqueFiles: stats.uniqueFiles,
              lastUpdated: stats.lastUpdated
                ? new Date(stats.lastUpdated).toISOString()
                : null,
              ollama: {
                available: ollama.available,
                model: ollamaConfig.model,
                hasModel: ollama.hasModel,
                error: ollama.error
              }
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Index status error: ${error}` }],
          isError: true
        };
      }
    }
  };
}

/**
 * Helper: Collect all markdown files recursively
 */
async function collectMarkdownFiles(
  dirPath: string,
  vaultPath: string,
  files: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectMarkdownFiles(fullPath, vaultPath, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(path.relative(vaultPath, fullPath));
    }
  }

  return files;
}
