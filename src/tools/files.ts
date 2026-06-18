/**
 * File operation tools for Obsidian MCP
 * Phase 1: Core CRUD operations
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault, resolvePathInVault } from '../config.js';
import { FileEntry, ToolResponse, SearchResult, SearchMatch } from '../types/index.js';
import {
  parseMarkdownFile,
  createMarkdownFile,
  updateFrontmatter,
  fileExists,
  extractTitle
} from '../parsers/markdown.js';
import { vaultParam } from './schema-helpers.js';
import { closestMatches, NOTE_NOT_FOUND_HINT } from '../resolver-hints.js';

/**
 * Tool definitions for file operations
 */
export const fileTools: Tool[] = [
  {
    name: 'list_files',
    description: 'List files and folders in an Obsidian vault directory. Returns name, path, type (file/folder), size, and modification date.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        directory: {
          type: 'string',
          description: 'Relative path from vault root. Empty or "/" for vault root.'
        },
        pattern: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.md", "PROJECT*")'
        },
        recursive: {
          type: 'boolean',
          description: 'Include files in subdirectories',
          default: false
        }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read a markdown file from the Obsidian vault. Returns parsed frontmatter (YAML) and content separately.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path from vault root (e.g., "01 Evergreen Notes/My Note.md")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'create_file',
    description: 'Create a new markdown file in the vault. Will create parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path for the new file (e.g., "03 Projects/New Project.md")'
        },
        content: {
          type: 'string',
          description: 'Markdown content for the file'
        },
        frontmatter: {
          type: 'object',
          description: 'Optional YAML frontmatter as key-value pairs'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'update_file',
    description: 'Replace the entire content of a markdown file. Preserves frontmatter unless new frontmatter is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        content: {
          type: 'string',
          description: 'New markdown content'
        },
        frontmatter: {
          type: 'object',
          description: 'Optional new frontmatter (replaces existing if provided)'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the vault. Use with caution!',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file to delete'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'get_frontmatter',
    description: 'Get only the YAML frontmatter from a file, without loading full content.',
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
    name: 'update_frontmatter',
    description: 'Update specific frontmatter fields without changing file content. Merges with existing frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        updates: {
          type: 'object',
          description: 'Frontmatter fields to update or add'
        }
      },
      required: ['path', 'updates']
    }
  },
  {
    name: 'search_content',
    description: 'Search for text or regex pattern across vault files. Returns matching files with line numbers and context.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for'
        },
        directory: {
          type: 'string',
          description: 'Limit search to a specific directory'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search',
          default: false
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of files to return',
          default: 20
        }
      },
      required: ['query']
    }
  },
  {
    name: 'move_note',
    description: 'Move/rename a note and update all wikilinks pointing to it across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        from_path: {
          type: 'string',
          description: 'Current relative path of the file'
        },
        to_path: {
          type: 'string',
          description: 'New relative path for the file'
        }
      },
      required: ['from_path', 'to_path']
    }
  }
];

/**
 * Handler functions for file tools
 */
export function createFileHandlers(config: Config) {
  return {
    list_files: async (args: {
      vault?: string;
      directory?: string;
      pattern?: string;
      recursive?: boolean;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const dir = args.directory || '';
        const targetPath = dir ? resolvePathInVault(vault.path, dir) : vault.path;

        const entries = await listDirectory(targetPath, vault.path, args.recursive || false);

        // Filter by pattern if provided
        let filtered = entries;
        if (args.pattern) {
          const regex = globToRegex(args.pattern);
          filtered = entries.filter(e => regex.test(e.name));
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error listing files: ${error}` }],
          isError: true
        };
      }
    },

    read_file: async (args: { vault?: string; path: string }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const parsed = await parseMarkdownFile(args.path, vault.path);
        const title = extractTitle(parsed);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              path: parsed.path,
              title,
              frontmatter: parsed.frontmatter,
              content: parsed.content
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        // On ENOENT, augment the error with closest-match suggestions
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            const vault = resolveVault(config, args.vault);
            const noteNames = await collectNoteBasenames(vault.path);
            const query = path.basename(args.path, '.md');
            const suggestions = closestMatches(query, noteNames);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: `File not found: ${args.path}`,
                  closest_matches: suggestions,
                  hint: NOTE_NOT_FOUND_HINT
                }, null, 2)
              }],
              isError: true
            };
          } catch {
            // Fall through to generic error if vault resolution also fails
          }
        }
        return {
          content: [{ type: 'text', text: `Error reading file: ${error}` }],
          isError: true
        };
      }
    },

    create_file: async (args: {
      vault?: string;
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);

        // Check if file already exists
        if (await fileExists(args.path, vault.path)) {
          return {
            content: [{ type: 'text', text: `File already exists: ${args.path}` }],
            isError: true
          };
        }

        const parsed = await createMarkdownFile(
          args.path,
          vault.path,
          args.content,
          args.frontmatter || {}
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              created: true,
              path: parsed.path,
              frontmatter: parsed.frontmatter
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error creating file: ${error}` }],
          isError: true
        };
      }
    },

    update_file: async (args: {
      vault?: string;
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);

        // Read existing file to preserve frontmatter if not provided
        let finalFrontmatter = args.frontmatter;
        if (!finalFrontmatter) {
          try {
            const existing = await parseMarkdownFile(args.path, vault.path);
            finalFrontmatter = existing.frontmatter;
          } catch {
            finalFrontmatter = {};
          }
        }

        // Create/update file
        const parsed = await createMarkdownFile(
          args.path,
          vault.path,
          args.content,
          finalFrontmatter
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated: true,
              path: parsed.path
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error updating file: ${error}` }],
          isError: true
        };
      }
    },

    delete_file: async (args: { vault?: string; path: string }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const absolutePath = resolvePathInVault(vault.path, args.path);
        await fs.unlink(absolutePath);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ deleted: true, path: args.path }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error deleting file: ${error}` }],
          isError: true
        };
      }
    },

    get_frontmatter: async (args: { vault?: string; path: string }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const parsed = await parseMarkdownFile(args.path, vault.path);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              path: parsed.path,
              frontmatter: parsed.frontmatter
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error getting frontmatter: ${error}` }],
          isError: true
        };
      }
    },

    update_frontmatter: async (args: {
      vault?: string;
      path: string;
      updates: Record<string, unknown>;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const parsed = await updateFrontmatter(args.path, vault.path, args.updates);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated: true,
              path: parsed.path,
              frontmatter: parsed.frontmatter
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error updating frontmatter: ${error}` }],
          isError: true
        };
      }
    },

    search_content: async (args: {
      vault?: string;
      query: string;
      directory?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const searchDir = args.directory
          ? resolvePathInVault(vault.path, args.directory)
          : vault.path;

        const flags = args.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(args.query, flags);
        const maxResults = args.maxResults || 20;

        const results = await searchFiles(searchDir, vault.path, regex, maxResults);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              resultCount: results.length,
              results
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error searching: ${error}` }],
          isError: true
        };
      }
    },

    move_note: async (args: {
      vault?: string;
      from_path: string;
      to_path: string;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const fromAbsolute = resolvePathInVault(vault.path, args.from_path);
        const toAbsolute = resolvePathInVault(vault.path, args.to_path);

        // Verify source exists
        if (!(await fileExists(args.from_path, vault.path))) {
          return {
            content: [{ type: 'text', text: `Source file not found: ${args.from_path}` }],
            isError: true
          };
        }

        // Verify destination doesn't exist
        if (await fileExists(args.to_path, vault.path)) {
          return {
            content: [{ type: 'text', text: `Destination already exists: ${args.to_path}` }],
            isError: true
          };
        }

        // Create destination directory if needed
        const destDir = path.dirname(toAbsolute);
        await fs.mkdir(destDir, { recursive: true });

        // Update wikilinks BEFORE moving the file.
        // If we crash after move but before link update, all links are broken.
        // If we crash after link update but before move, links point to new name
        // but old file still exists — easier to recover from.
        const oldName = path.basename(args.from_path, '.md');
        const newName = path.basename(args.to_path, '.md');
        let updatedFiles = 0;

        if (oldName !== newName) {
          updatedFiles = await updateWikilinksInVault(vault.path, oldName, newName);
        }

        // Move the file (after links are updated)
        await fs.rename(fromAbsolute, toAbsolute);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              moved: true,
              from: args.from_path,
              to: args.to_path,
              wikilinksUpdated: updatedFiles
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error moving note: ${error}` }],
          isError: true
        };
      }
    }
  };
}

/**
 * Helper: Collect all note basenames (without .md) from a vault for fuzzy matching.
 * Caps at 2000 entries to keep the search fast in very large vaults.
 */
async function collectNoteBasenames(
  vaultPath: string,
  results: string[] = [],
  dirPath?: string
): Promise<string[]> {
  const MAX_NOTES = 2000;
  if (results.length >= MAX_NOTES) return results;

  const searchDir = dirPath || vaultPath;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(searchDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= MAX_NOTES) break;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(searchDir, entry.name);

    if (entry.isDirectory()) {
      await collectNoteBasenames(vaultPath, results, fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(path.basename(entry.name, '.md'));
    }
  }

  return results;
}

/**
 * Helper: Update wikilinks across vault when a note is renamed
 */
async function updateWikilinksInVault(
  vaultPath: string,
  oldName: string,
  newName: string,
  dirPath?: string
): Promise<number> {
  const searchDir = dirPath || vaultPath;
  let updatedCount = 0;
  const entries = await fs.readdir(searchDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(searchDir, entry.name);

    if (entry.isDirectory()) {
      updatedCount += await updateWikilinksInVault(vaultPath, oldName, newName, fullPath);
    } else if (entry.name.endsWith('.md')) {
      const content = await fs.readFile(fullPath, 'utf-8');
      // Match [[oldName]], [[oldName|alias]], [[path/oldName]], [[path/oldName|alias]]
      const regex = new RegExp(
        `\\[\\[([^\\]]*?\\/)?${escapeRegex(oldName)}(\\|[^\\]]*)?\\]\\]`,
        'g'
      );

      if (regex.test(content)) {
        const updated = content.replace(regex, (match, pathPrefix, alias) => {
          return `[[${pathPrefix || ''}${newName}${alias || ''}]]`;
        });
        await fs.writeFile(fullPath, updated, 'utf-8');
        updatedCount++;
      }
    }
  }

  return updatedCount;
}

/**
 * Helper: Escape string for use in regex
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Helper: List directory contents
 */
async function listDirectory(
  dirPath: string,
  vaultPath: string,
  recursive: boolean,
  results: FileEntry[] = []
): Promise<FileEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(vaultPath, fullPath);
    const stats = await fs.stat(fullPath);

    results.push({
      name: entry.name,
      path: relativePath,
      isDirectory: entry.isDirectory(),
      modified: stats.mtime,
      size: stats.size
    });

    if (recursive && entry.isDirectory()) {
      await listDirectory(fullPath, vaultPath, true, results);
    }
  }

  return results;
}

/**
 * Helper: Search files for content
 */
async function searchFiles(
  dirPath: string,
  vaultPath: string,
  regex: RegExp,
  maxResults: number,
  results: SearchResult[] = []
): Promise<SearchResult[]> {
  if (results.length >= maxResults) return results;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await searchFiles(fullPath, vaultPath, regex, maxResults, results);
    } else if (entry.name.endsWith('.md')) {
      // Skip files larger than 50 MB to prevent OOM
      const stat = await fs.stat(fullPath);
      if (stat.size > 50 * 1024 * 1024) continue;
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
 * Helper: Find regex matches in content with context
 */
function findMatches(content: string, regex: RegExp): SearchMatch[] {
  const lines = content.split('\n');
  const matches: SearchMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    regex.lastIndex = 0; // Reset regex state

    while ((match = regex.exec(line)) !== null) {
      matches.push({
        lineNumber: i + 1,
        lineContent: line.trim(),
        matchStart: match.index,
        matchEnd: match.index + match[0].length
      });

      // Prevent infinite loops with zero-length matches
      if (match[0].length === 0) break;
    }
  }

  return matches;
}

/**
 * Helper: Convert glob pattern to regex
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
