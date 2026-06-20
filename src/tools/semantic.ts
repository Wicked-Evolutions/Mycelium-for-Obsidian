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
import { vaultParam } from './schema-helpers.js';
import { withAnnotations, ToolAnnotations } from './safety.js';

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

          // Semantic search
          const semResults = store.search(
            queryResult.embedding,
            limit * 2,  // Get extra for merging
            minSimilarity * 0.7  // Lower threshold for variants
          );
          allSemanticResults.push(...semResults);

          // Keyword search
          const kwResults = store.keywordSearch(q, limit * 2);
          allKeywordResults.push(...kwResults);
        }

        // Use collected results for merging
        const semanticResults = allSemanticResults;
        const keywordResults = allKeywordResults;

        // Merge results with weighted scoring
        // Semantic weight: 0.7, Keyword weight: 0.3
        const scoreMap = new Map<string, {
          filePath: string;
          blockId: string | null;
          semanticScore: number;
          keywordScore: number;
          combinedScore: number;
          metadata: Record<string, unknown>;
        }>();

        // Normalize keyword scores (BM25 scores vary widely)
        const maxKeywordScore = Math.max(...keywordResults.map(r => r.score), 1);

        // Add semantic results
        for (const r of semanticResults) {
          const key = `${r.filePath}:${r.blockId || ''}`;
          scoreMap.set(key, {
            filePath: r.filePath,
            blockId: r.blockId,
            semanticScore: r.similarity,
            keywordScore: 0,
            combinedScore: r.similarity * 0.7,
            metadata: r.metadata
          });
        }

        // Merge keyword results
        for (const r of keywordResults) {
          const key = `${r.filePath}:${r.blockId || ''}`;
          const normalizedScore = r.score / maxKeywordScore;  // Normalize to 0-1
          const existing = scoreMap.get(key);

          if (existing) {
            existing.keywordScore = normalizedScore;
            existing.combinedScore = existing.semanticScore * 0.7 + normalizedScore * 0.3;
          } else {
            // Keyword-only result - still include if score is good
            scoreMap.set(key, {
              filePath: r.filePath,
              blockId: r.blockId,
              semanticScore: 0,
              keywordScore: normalizedScore,
              combinedScore: normalizedScore * 0.3,
              metadata: {}
            });
          }
        }

        // Sort by combined score, filter by threshold, deduplicate by file
        const sortedResults = Array.from(scoreMap.values())
          .filter(r => r.combinedScore >= minSimilarity * 0.7 || r.semanticScore >= minSimilarity)
          .sort((a, b) => b.combinedScore - a.combinedScore);

        // Deduplicate by file path, keeping highest combined score
        const seen = new Set<string>();
        const results = sortedResults.filter(r => {
          if (seen.has(r.filePath)) return false;
          seen.add(r.filePath);
          return true;
        }).slice(0, limit);

        // Enrich results with file titles
        const enrichedResults = await Promise.all(results.map(async r => {
          try {
            const parsed = await parseMarkdownFile(r.filePath, vault.path);
            return {
              path: r.filePath,
              title: extractTitle(parsed),
              similarity: Math.round(r.combinedScore * 1000) / 1000,
              semanticScore: Math.round(r.semanticScore * 1000) / 1000,
              keywordScore: Math.round(r.keywordScore * 1000) / 1000,
              preview: parsed.content.slice(0, 200) + (parsed.content.length > 200 ? '...' : '')
            };
          } catch {
            return {
              path: r.filePath,
              title: path.basename(r.filePath, '.md'),
              similarity: Math.round(r.combinedScore * 1000) / 1000,
              semanticScore: Math.round(r.semanticScore * 1000) / 1000,
              keywordScore: Math.round(r.keywordScore * 1000) / 1000,
              preview: ''
            };
          }
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              queriesUsed: queries,  // Show expanded queries if any
              resultCount: enrichedResults.length,
              searchType: args.expand ? 'hybrid+expansion' : 'hybrid',
              results: enrichedResults
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
