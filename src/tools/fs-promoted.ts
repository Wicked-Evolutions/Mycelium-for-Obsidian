/**
 * Filesystem-promoted tools for Obsidian MCP
 * These were originally CLI-only but can be fully implemented
 * using filesystem access — no Obsidian app required.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault, resolvePathInVault, verifyPathAfterOpen } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { parseMarkdownFile } from '../parsers/markdown.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { vaultParam } from './schema-helpers.js';
import { buildFileIndex } from '../parsers/wikilink.js';
import { closestMatches, noteNotFoundHint, formatVaultError } from '../resolver-hints.js';

const ok = (text: string): ToolResponse => ({
  content: [{ type: 'text', text }],
  isError: false
});

const err = (text: string): ToolResponse => ({
  content: [{ type: 'text', text }],
  isError: true
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Read a JSON file from .obsidian/ config directory */
async function readObsidianConfig(vaultPath: string, configFile: string): Promise<any> {
  const configPath = path.join(vaultPath, '.obsidian', configFile);
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Write a JSON file to .obsidian/ config directory */
async function writeObsidianConfig(vaultPath: string, configFile: string, data: any): Promise<void> {
  const configPath = path.join(vaultPath, '.obsidian', configFile);
  await fs.writeFile(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Get the daily note path for today */
function getDailyNotePath(vaultPath: string, config: any): string {
  const folder = config?.folder || '';
  const format = config?.format || 'YYYY-MM-DD';
  const now = new Date();
  const dateStr = formatDate(now, format);
  return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
}

/** Simple date formatter for Obsidian's moment.js-compatible format strings */
function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return format
    .replace('YYYY', date.getFullYear().toString())
    .replace('YY', (date.getFullYear() % 100).toString().padStart(2, '0'))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

/** Recursively list all markdown files in a directory */
async function listMarkdownFiles(dirPath: string, basePath: string = ''): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...await listMarkdownFiles(path.join(dirPath, entry.name), relPath));
      } else if (entry.name.endsWith('.md')) {
        files.push(relPath);
      }
    }
  } catch { /* directory doesn't exist */ }
  return files;
}

/** Recursively list all folders */
async function listAllFolders(dirPath: string, basePath: string = ''): Promise<string[]> {
  const folders: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
        folders.push(relPath);
        folders.push(...await listAllFolders(path.join(dirPath, entry.name), relPath));
      }
    }
  } catch { /* directory doesn't exist */ }
  return folders;
}

/** Read file safely within vault */
async function readVaultFile(vaultPath: string, filePath: string): Promise<string> {
  const absPath = resolvePathInVault(vaultPath, filePath);
  const content = await fs.readFile(absPath, 'utf-8');
  await verifyPathAfterOpen(absPath, vaultPath);
  return content;
}

/** Write file safely within vault using atomic temp file */
async function writeVaultFile(vaultPath: string, filePath: string, content: string): Promise<void> {
  const absPath = resolvePathInVault(vaultPath, filePath);
  const tmpPath = absPath + '.tmp.' + Date.now();
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, absPath);
}

/** Parse frontmatter from raw content */
function parseFrontmatter(content: string): { data: Record<string, any>; content: string } {
  const parsed = matter(content);
  return { data: parsed.data, content: parsed.content };
}

// ─── Tool Definitions ────────────────────────────────────────────────

export const fsPromotedTools: Tool[] = [
  // ── Daily Notes ──
  {
    name: 'daily_read',
    description: "Read today's daily note contents.",
    inputSchema: { type: 'object', properties: { vault: vaultParam } }
  },
  {
    name: 'daily_append',
    description: "Append content to today's daily note. Creates the note if it doesn't exist.",
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam, content: { type: 'string', description: 'Content to append' } },
      required: ['content']
    }
  },
  {
    name: 'daily_prepend',
    description: "Prepend content to today's daily note. Creates the note if it doesn't exist.",
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam, content: { type: 'string', description: 'Content to prepend' } },
      required: ['content']
    }
  },
  {
    name: 'daily_path',
    description: "Get today's daily note path (even if it hasn't been created yet).",
    inputSchema: { type: 'object', properties: { vault: vaultParam } }
  },

  // ── Tasks ──
  {
    name: 'list_tasks',
    description: 'List tasks across the vault or from a specific file. Filter by done/todo.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'Filter by file name' },
        path: { type: 'string', description: 'Filter by file path' },
        filter: { type: 'string', enum: ['todo', 'done', 'all'], description: 'Filter tasks (default: all)' },
        verbose: { type: 'boolean', description: 'Group by file with line numbers' }
      }
    }
  },
  {
    name: 'update_task',
    description: 'Toggle or set the status of a task by file and line number.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name containing the task' },
        path: { type: 'string', description: 'File path containing the task' },
        line: { type: 'number', description: 'Line number of the task' },
        action: { type: 'string', enum: ['toggle', 'done', 'todo'], description: 'Action to perform' }
      },
      required: ['line', 'action']
    }
  },

  // ── Tags ──
  {
    name: 'list_tags',
    description: 'List all tags in the vault with occurrence counts.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        sort: { type: 'string', enum: ['name', 'count'], description: 'Sort order (default: name)' }
      }
    }
  },
  {
    name: 'get_tag_info',
    description: 'Get details about a specific tag: occurrence count and which files use it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Tag name (with or without #)' }
      },
      required: ['name']
    }
  },

  // ── Properties (vault-wide) ──
  {
    name: 'list_properties',
    description: 'List all frontmatter properties used across the vault with counts.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        sort: { type: 'string', enum: ['name', 'count'], description: 'Sort order (default: name)' }
      }
    }
  },
  {
    name: 'get_property_values',
    description: 'Get all unique values used for a specific frontmatter property across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Property name (e.g., "status", "type", "domain")' }
      },
      required: ['name']
    }
  },
  {
    name: 'property_read',
    description: 'Read a single frontmatter property value from a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        name: { type: 'string', description: 'Property name' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' }
      },
      required: ['name']
    }
  },
  {
    name: 'property_set',
    description: 'Set a single frontmatter property on a file. Does not touch file content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        name: { type: 'string', description: 'Property name' },
        value: { type: 'string', description: 'Property value' }
      },
      required: ['name', 'value']
    }
  },
  {
    name: 'property_remove',
    description: 'Remove a single frontmatter property from a file. Does not touch file content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        name: { type: 'string', description: 'Property name to remove' }
      },
      required: ['name']
    }
  },

  // ── Structure ──
  {
    name: 'get_outline',
    description: 'Get the heading structure (outline) of a file as a tree.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' }
      }
    }
  },
  {
    name: 'word_count',
    description: 'Count words and characters in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' }
      }
    }
  },
  {
    name: 'list_aliases',
    description: 'List aliases in the vault or for a specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        verbose: { type: 'boolean', description: 'Include file paths' }
      }
    }
  },

  // ── File Operations ──
  {
    name: 'file_append',
    description: 'Append content to end of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to append' }
      },
      required: ['content']
    }
  },
  {
    name: 'file_prepend',
    description: 'Prepend content to start of a file (after frontmatter).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to prepend' }
      },
      required: ['content']
    }
  },
  {
    name: 'search_replace_in_file',
    description: 'Replace specific text in a file. Only changes the matched text — does NOT replace the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        search: { type: 'string', description: 'Exact text to find' },
        replace: { type: 'string', description: 'Replacement text' },
        all: { type: 'boolean', description: 'Replace all occurrences (default: first only)' }
      },
      required: ['search', 'replace']
    }
  },
  {
    name: 'rename_file',
    description: 'Rename a file and update all wikilinks pointing to it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'Current file name' },
        path: { type: 'string', description: 'Current file path' },
        name: { type: 'string', description: 'New file name' }
      },
      required: ['name']
    }
  },
  {
    name: 'move_file',
    description: 'Move a file and update all wikilinks pointing to it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        to: { type: 'string', description: 'Destination folder or path' }
      },
      required: ['to']
    }
  },

  // ── Metadata ──
  {
    name: 'get_file_info',
    description: 'Get file metadata — name, path, size, created/modified dates.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' }
      }
    }
  },
  {
    name: 'get_folder_info',
    description: 'Get folder metadata — file count, folder count, size.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        path: { type: 'string', description: 'Folder path' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_folders',
    description: 'List folders in the vault, optionally filtered by parent folder.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        folder: { type: 'string', description: 'Filter by parent folder' }
      }
    }
  },
  {
    name: 'get_vault_info',
    description: 'Get vault metadata — name, path, file count, folder count, size.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },

  // ── Bookmarks ──
  {
    name: 'add_bookmark',
    description: 'Add a bookmark to a file, folder, search query, or URL.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        file: { type: 'string', description: 'File path to bookmark' },
        subpath: { type: 'string', description: 'Subpath (heading or block) within file' },
        folder: { type: 'string', description: 'Folder to bookmark' },
        search: { type: 'string', description: 'Search query to bookmark' },
        url: { type: 'string', description: 'URL to bookmark' },
        title: { type: 'string', description: 'Bookmark title' }
      }
    }
  },
  {
    name: 'list_bookmarks',
    description: 'List all bookmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        verbose: { type: 'boolean', description: 'Include bookmark types' }
      }
    }
  },

  // ── Search ──
  {
    name: 'search_with_context',
    description: 'Search vault for text with matching line context.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        query: { type: 'string', description: 'Search query' },
        folder: { type: 'string', description: 'Limit to folder' },
        limit: { type: 'number', description: 'Max files' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive search' }
      },
      required: ['query']
    }
  },

  // ── Plugins (read-only) ──
  {
    name: 'list_plugins',
    description: 'List installed Obsidian plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        filter: { type: 'string', enum: ['core', 'community'], description: 'Filter by plugin type' },
        versions: { type: 'boolean', description: 'Include version numbers' }
      }
    }
  },
  {
    name: 'get_plugin_info',
    description: 'Get detailed info about a specific plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        id: { type: 'string', description: 'Plugin ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_enabled_plugins',
    description: 'List only enabled plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        filter: { type: 'string', enum: ['core', 'community'], description: 'Filter by plugin type' },
        versions: { type: 'boolean', description: 'Include version numbers' }
      }
    }
  },

  // ── Snippets & Themes (read-only) ──
  {
    name: 'list_snippets',
    description: 'List installed CSS snippets.',
    inputSchema: { type: 'object', properties: { vault: vaultParam } }
  },
  {
    name: 'list_themes',
    description: 'List installed themes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        versions: { type: 'boolean', description: 'Include version numbers' }
      }
    }
  },
  {
    name: 'get_active_theme',
    description: 'Get the active theme name.',
    inputSchema: { type: 'object', properties: { vault: vaultParam } }
  },

  // ── Other ──
  {
    name: 'read_random',
    description: 'Read a random note from the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        folder: { type: 'string', description: 'Limit to folder' }
      }
    }
  },
  {
    name: 'list_orphans',
    description: 'List files with no incoming links (orphan notes).',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },
  {
    name: 'list_deadends',
    description: 'List files with no outgoing links (dead-end notes).',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  },
  {
    name: 'unresolved_links',
    description: 'List broken/unresolved wikilinks across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        verbose: { type: 'boolean', description: 'Include source files' }
      }
    }
  },
  {
    name: 'get_workspace',
    description: 'Get the workspace tree showing open panes and layout (from last saved state).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam
      }
    }
  },
  {
    name: 'list_bases',
    description: 'List all .base files in the vault.',
    inputSchema: {
      type: 'object',
      properties: { vault: vaultParam }
    }
  }
];

// ─── Handler Implementations ──────────────────────────────────────────

export function createFsPromotedHandlers(config: Config) {
  /**
   * Build a structured not-found error for an expected-existing note.
   *
   * The message NEVER contains an absolute filesystem path — only the note
   * name the caller supplied. Attaches `closest_matches` (nearest note
   * basenames by edit distance, from the vault-wide index) and `hint`
   * ("Did you mean: X?" + generic guidance) so that callers can render it
   * via formatVaultError() with the same structured shape that read_file /
   * follow_link / resolve_wikilink already return.
   */
  const noteNotFoundError = async (
    vaultPath: string,
    requested: string
  ): Promise<Error & { closest_matches: string[]; hint: string }> => {
    const query = path.basename(requested, '.md');
    let suggestions: string[] = [];
    try {
      const fileIndex = await buildFileIndex(vaultPath);
      // index values are absolute paths; derive proper-cased basenames
      const noteNames = Array.from(fileIndex.values()).map(p => path.basename(p, '.md'));
      suggestions = closestMatches(query, noteNames);
    } catch {
      // If the index can't be built, fall back to no suggestions.
    }
    const error = new Error(`${query} not found`) as Error & {
      closest_matches: string[];
      hint: string;
    };
    error.closest_matches = suggestions;
    error.hint = noteNotFoundHint(suggestions);
    return error;
  };

  /** Resolve file path from file name or path args.
   * When args.file has no directory component and the literal path doesn't exist
   * in the vault root, performs a vault-wide basename search (Obsidian semantics:
   * first match by name). Returns a vault-relative path.
   *
   * When `mustExist` is true (the default for read/stat/rename tools), a note
   * that cannot be resolved anywhere in the vault throws a STRUCTURED
   * not-found error (closest_matches + hint, no absolute path) instead of
   * falling back to a literal path that later surfaces a raw ENOENT leak.
   * Pass `mustExist: false` for create-capable tools (e.g. file_append) that
   * legitimately tolerate a not-yet-existing target.
   */
  const resolveFile = async (
    vault: { path: string },
    args: any,
    mustExist = true
  ): Promise<string> => {
    if (args.path) {
      if (mustExist) {
        try {
          await fs.access(resolvePathInVault(vault.path, args.path));
        } catch {
          throw await noteNotFoundError(vault.path, args.path);
        }
      }
      return args.path;
    }
    if (args.file) {
      const withExt = args.file.endsWith('.md') ? args.file : args.file + '.md';

      // If the caller supplied a path (contains a separator), trust it
      if (withExt.includes('/') || withExt.includes('\\')) {
        if (mustExist) {
          try {
            await fs.access(resolvePathInVault(vault.path, withExt));
          } catch {
            throw await noteNotFoundError(vault.path, withExt);
          }
        }
        return withExt;
      }

      // Bare filename: check root first, then do a vault-wide lookup
      try {
        await fs.access(path.join(vault.path, withExt));
        return withExt; // found at root
      } catch {
        // Not at root — search the whole vault by basename (preserves Bug-4 fix)
        const fileIndex = await buildFileIndex(vault.path);
        const found = fileIndex.get(withExt.toLowerCase());
        if (found) {
          return path.relative(vault.path, found);
        }
        if (mustExist) {
          // Not found anywhere — surface a structured not-found (no abs path)
          throw await noteNotFoundError(vault.path, withExt);
        }
        // Tolerant callers (create-capable) get the literal back.
        return withExt;
      }
    }
    throw new Error('Either file or path parameter is required');
  };

  const handlers: Record<string, (args: any) => Promise<ToolResponse>> = {

    // ── Daily Notes ──
    daily_read: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const dailyConfig = await readObsidianConfig(vault.path, 'daily-notes.json');
        const notePath = getDailyNotePath(vault.path, dailyConfig);
        const content = await readVaultFile(vault.path, notePath);
        return ok(content || '(Daily note is empty)');
      } catch (e: any) {
        if (e.code === 'ENOENT') return ok('(Daily note does not exist yet)');
        return err(`Error reading daily note: ${e.message}`);
      }
    },

    daily_append: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const dailyConfig = await readObsidianConfig(vault.path, 'daily-notes.json');
        const notePath = getDailyNotePath(vault.path, dailyConfig);
        const absPath = resolvePathInVault(vault.path, notePath);
        try {
          // Create parent directories if needed
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          try {
            await fs.access(absPath);
          } catch {
            // File doesn't exist — create it
            await fs.writeFile(absPath, '', 'utf-8');
          }
          await fs.appendFile(absPath, '\n' + args.content, 'utf-8');
        } catch (e: any) {
          // Defensive: any ENOENT here would embed the absolute filesystem path
          // in its message. Sanitize to the vault-relative note path.
          if (e?.code === 'ENOENT') {
            return err(`Cannot append — parent folder does not exist: ${notePath}`);
          }
          throw e;
        }
        return ok('Content appended to daily note.');
      } catch (e: any) {
        return err(`Error appending to daily note: ${e.message}`);
      }
    },

    daily_prepend: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const dailyConfig = await readObsidianConfig(vault.path, 'daily-notes.json');
        const notePath = getDailyNotePath(vault.path, dailyConfig);
        const absPath = resolvePathInVault(vault.path, notePath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        let existing = '';
        try {
          existing = await fs.readFile(absPath, 'utf-8');
        } catch { /* file doesn't exist */ }
        const { data, content } = parseFrontmatter(existing);
        const hasFrontmatter = Object.keys(data).length > 0;
        const newContent = hasFrontmatter
          ? matter.stringify(args.content + '\n' + content, data)
          : args.content + '\n' + existing;
        await writeVaultFile(vault.path, notePath, newContent);
        return ok('Content prepended to daily note.');
      } catch (e: any) {
        return err(`Error prepending to daily note: ${e.message}`);
      }
    },

    daily_path: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const dailyConfig = await readObsidianConfig(vault.path, 'daily-notes.json');
        return ok(getDailyNotePath(vault.path, dailyConfig));
      } catch (e: any) {
        return err(`Error getting daily path: ${e.message}`);
      }
    },

    // ── Tasks ──
    list_tasks: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filterType = args.filter || 'all';
        let files: string[];

        if (args.path) {
          files = [args.path];
        } else if (args.file) {
          files = [args.file.endsWith('.md') ? args.file : args.file + '.md'];
        } else {
          files = await listMarkdownFiles(vault.path);
        }

        const tasks: string[] = [];
        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const match = line.match(/^(\s*[-*]\s+)\[(.)\]\s+(.*)/);
              if (!match) continue;
              const isDone = match[2] === 'x' || match[2] === 'X';
              if (filterType === 'todo' && isDone) continue;
              if (filterType === 'done' && !isDone) continue;
              if (args.verbose) {
                tasks.push(`${file}:${i + 1}\t[${match[2]}] ${match[3]}`);
              } else {
                tasks.push(`[${match[2]}] ${match[3]}`);
              }
            }
          } catch { /* skip files that can't be read */ }
        }
        return ok(tasks.length > 0 ? tasks.join('\n') : 'No tasks found.');
      } catch (e: any) {
        return err(`Error listing tasks: ${e.message}`);
      }
    },

    update_task: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        if (!args.path && !args.file) return err('Either file or path parameter is required');
        // Route through the shared resolver so update_task gets the Bug-4
        // vault-wide index lookup AND the structured no-abs-path not-found
        // error (parity with list_aliases / property_read etc.).
        const filePath = await resolveFile(vault, args);

        const content = await readVaultFile(vault.path, filePath);
        const lines = content.split('\n');
        const lineIdx = args.line - 1;
        if (lineIdx < 0 || lineIdx >= lines.length) return err(`Line ${args.line} out of range`);

        const match = lines[lineIdx].match(/^(\s*[-*]\s+)\[(.)\](\s+.*)/);
        if (!match) return err(`Line ${args.line} is not a task`);

        const currentDone = match[2] === 'x' || match[2] === 'X';
        let newStatus: string;
        if (args.action === 'toggle') newStatus = currentDone ? ' ' : 'x';
        else if (args.action === 'done') newStatus = 'x';
        else newStatus = ' ';

        lines[lineIdx] = `${match[1]}[${newStatus}]${match[3]}`;
        await writeVaultFile(vault.path, filePath, lines.join('\n'));
        return ok(`Task ${args.action === 'done' ? 'completed' : args.action === 'todo' ? 'unchecked' : 'toggled'}.`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error updating task: ${e.message}`);
      }
    },

    // ── Tags ──
    list_tags: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const tagCounts: Record<string, number> = {};

        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            // Frontmatter tags
            const { data } = parseFrontmatter(content);
            const fmTags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []);
            for (const tag of fmTags) {
              const t = String(tag).replace(/^#/, '');
              tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
            // Inline tags
            const inlineTags = content.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g) || [];
            for (const match of inlineTags) {
              const t = match.trim().replace(/^#/, '');
              tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
          } catch { /* skip */ }
        }

        const entries = Object.entries(tagCounts);
        if (args.sort === 'count') entries.sort((a, b) => b[1] - a[1]);
        else entries.sort((a, b) => a[0].localeCompare(b[0]));

        return ok(entries.length > 0
          ? entries.map(([tag, count]) => `${tag}\t${count}`).join('\n')
          : 'No tags found.');
      } catch (e: any) {
        return err(`Error listing tags: ${e.message}`);
      }
    },

    get_tag_info: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const targetTag = args.name.replace(/^#/, '');
        const files = await listMarkdownFiles(vault.path);
        const matchingFiles: string[] = [];

        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const { data } = parseFrontmatter(content);
            const fmTags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []);
            const hasFmTag = fmTags.some((t: any) => String(t).replace(/^#/, '') === targetTag);
            const hasInlineTag = content.includes(`#${targetTag}`);
            if (hasFmTag || hasInlineTag) matchingFiles.push(file);
          } catch { /* skip */ }
        }

        return ok(matchingFiles.length > 0
          ? `#${targetTag} (${matchingFiles.length} files):\n${matchingFiles.map(f => `  ${f}`).join('\n')}`
          : `Tag #${targetTag} not found.`);
      } catch (e: any) {
        return err(`Error getting tag info: ${e.message}`);
      }
    },

    // ── Properties ──
    list_properties: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const propCounts: Record<string, number> = {};

        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const { data } = parseFrontmatter(content);
            for (const key of Object.keys(data)) {
              propCounts[key] = (propCounts[key] || 0) + 1;
            }
          } catch { /* skip */ }
        }

        const entries = Object.entries(propCounts);
        if (args.sort === 'count') entries.sort((a, b) => b[1] - a[1]);
        else entries.sort((a, b) => a[0].localeCompare(b[0]));

        return ok(entries.length > 0
          ? entries.map(([prop, count]) => `${prop}\t${count}`).join('\n')
          : 'No properties found.');
      } catch (e: any) {
        return err(`Error listing properties: ${e.message}`);
      }
    },

    get_property_values: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const values = new Set<string>();

        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const { data } = parseFrontmatter(content);
            if (args.name in data) {
              const val = data[args.name];
              if (Array.isArray(val)) val.forEach((v: any) => values.add(String(v)));
              else if (val !== null && val !== undefined) values.add(String(val));
            }
          } catch { /* skip */ }
        }

        const sorted = [...values].sort();
        return ok(sorted.length > 0
          ? `Values for "${args.name}" (${sorted.length} unique):\n${sorted.map(v => `  - ${v}`).join('\n')}`
          : `No values found for property "${args.name}".`);
      } catch (e: any) {
        return err(`Error getting property values: ${e.message}`);
      }
    },

    property_read: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const content = await readVaultFile(vault.path, filePath);
        const { data } = parseFrontmatter(content);
        const val = data[args.name];
        if (val === undefined) return ok('(property not set)');
        return ok(typeof val === 'object' ? JSON.stringify(val) : String(val));
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error reading property: ${e.message}`);
      }
    },

    property_set: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const rawContent = await readVaultFile(vault.path, filePath);
        const parsed = matter(rawContent);
        parsed.data[args.name] = args.value;
        const newContent = matter.stringify(parsed.content, parsed.data);
        await writeVaultFile(vault.path, filePath, newContent);
        return ok(`Property "${args.name}" set to "${args.value}".`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error setting property: ${e.message}`);
      }
    },

    property_remove: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const rawContent = await readVaultFile(vault.path, filePath);
        const parsed = matter(rawContent);
        delete parsed.data[args.name];
        const newContent = matter.stringify(parsed.content, parsed.data);
        await writeVaultFile(vault.path, filePath, newContent);
        return ok(`Property "${args.name}" removed.`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error removing property: ${e.message}`);
      }
    },

    // ── Structure ──
    get_outline: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const content = await readVaultFile(vault.path, filePath);
        const headings: string[] = [];
        for (const line of content.split('\n')) {
          const match = line.match(/^(#{1,6})\s+(.+)/);
          if (match) {
            const indent = '  '.repeat(match[1].length - 1);
            headings.push(`${indent}${match[2].trim()}`);
          }
        }
        return ok(headings.length > 0 ? headings.join('\n') : 'No headings found.');
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error getting outline: ${e.message}`);
      }
    },

    word_count: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const content = await readVaultFile(vault.path, filePath);
        const { content: body } = parseFrontmatter(content);
        const words = body.trim().split(/\s+/).filter(w => w.length > 0).length;
        const chars = body.length;
        return ok(`words\t${words}\ncharacters\t${chars}`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error counting words: ${e.message}`);
      }
    },

    list_aliases: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        if (args.path || args.file) {
          const filePath = await resolveFile(vault, args);
          const content = await readVaultFile(vault.path, filePath);
          const { data } = parseFrontmatter(content);
          const aliases = Array.isArray(data.aliases) ? data.aliases : (data.aliases ? [data.aliases] : []);
          return ok(aliases.length > 0 ? aliases.join('\n') : 'No aliases found.');
        }
        // Vault-wide
        const files = await listMarkdownFiles(vault.path);
        const results: string[] = [];
        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const { data } = parseFrontmatter(content);
            const aliases = Array.isArray(data.aliases) ? data.aliases : (data.aliases ? [data.aliases] : []);
            for (const alias of aliases) {
              results.push(args.verbose ? `${alias}\t${file}` : String(alias));
            }
          } catch { /* skip */ }
        }
        return ok(results.length > 0 ? results.join('\n') : 'No aliases found.');
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error listing aliases: ${e.message}`);
      }
    },

    // ── File Operations ──
    file_append: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        // mustExist=false: fs.appendFile creates the file if it doesn't exist,
        // so this tool legitimately tolerates a not-yet-existing target.
        const filePath = await resolveFile(vault, args, false);
        const absPath = resolvePathInVault(vault.path, filePath);
        try {
          await fs.appendFile(absPath, '\n' + args.content, 'utf-8');
        } catch (e: any) {
          // A missing intermediate parent folder makes fs.appendFile throw an
          // ENOENT whose message embeds the absolute filesystem path. Sanitize:
          // report only the vault-relative path, never the absolute one.
          if (e?.code === 'ENOENT') {
            return err(`Cannot append — parent folder does not exist: ${filePath}`);
          }
          throw e;
        }
        return ok('Content appended to file.');
      } catch (e: any) {
        return err(`Error appending to file: ${e.message}`);
      }
    },

    file_prepend: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const content = await readVaultFile(vault.path, filePath);
        const { data, content: body } = parseFrontmatter(content);
        const hasFrontmatter = Object.keys(data).length > 0;
        const newContent = hasFrontmatter
          ? matter.stringify(args.content + '\n' + body, data)
          : args.content + '\n' + content;
        await writeVaultFile(vault.path, filePath, newContent);
        return ok('Content prepended to file.');
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error prepending to file: ${e.message}`);
      }
    },

    search_replace_in_file: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const content = await readVaultFile(vault.path, filePath);
        if (!content.includes(args.search)) {
          return err('Search text not found in file. No changes made.');
        }
        const newContent = args.all
          ? content.replaceAll(args.search, args.replace)
          : content.replace(args.search, args.replace);
        await writeVaultFile(vault.path, filePath, newContent);
        return ok('Text replaced successfully.');
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error replacing text: ${e.message}`);
      }
    },

    rename_file: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const oldName = path.basename(filePath, '.md');
        const dir = path.dirname(filePath);
        const newName = args.name.endsWith('.md') ? args.name : args.name + '.md';
        const newPath = dir === '.' ? newName : `${dir}/${newName}`;
        const absOld = resolvePathInVault(vault.path, filePath);
        const absNew = resolvePathInVault(vault.path, newPath);
        await fs.rename(absOld, absNew);
        // Update wikilinks in other files
        const allFiles = await listMarkdownFiles(vault.path);
        const newBaseName = path.basename(newPath, '.md');
        for (const f of allFiles) {
          if (f === newPath) continue;
          try {
            const c = await readVaultFile(vault.path, f);
            const updated = c.replaceAll(`[[${oldName}]]`, `[[${newBaseName}]]`)
                            .replaceAll(`[[${oldName}|`, `[[${newBaseName}|`);
            if (updated !== c) await writeVaultFile(vault.path, f, updated);
          } catch { /* skip */ }
        }
        return ok(`File renamed to "${args.name}".`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error renaming file: ${e.message}`);
      }
    },

    move_file: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const oldName = path.basename(filePath, '.md');
        const destPath = args.to.endsWith('.md') ? args.to : `${args.to}/${path.basename(filePath)}`;
        const absOld = resolvePathInVault(vault.path, filePath);
        const absNew = resolvePathInVault(vault.path, destPath);
        await fs.mkdir(path.dirname(absNew), { recursive: true });
        await fs.rename(absOld, absNew);
        // Wikilinks use note names not paths, so they don't change on move (unless renamed)
        return ok(`File moved to "${args.to}".`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error moving file: ${e.message}`);
      }
    },

    // ── Metadata ──
    get_file_info: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const filePath = await resolveFile(vault, args);
        const absPath = resolvePathInVault(vault.path, filePath);
        const stat = await fs.stat(absPath);
        const name = path.basename(filePath, path.extname(filePath));
        const ext = path.extname(filePath).replace('.', '');
        return ok(`path\t${filePath}\nname\t${name}\nextension\t${ext}\nsize\t${stat.size}\ncreated\t${stat.birthtimeMs}\nmodified\t${stat.mtimeMs}`);
      } catch (e: any) {
        if (e?.closest_matches && e?.hint) return formatVaultError(e);
        return err(`Error getting file info: ${e.message}`);
      }
    },

    get_folder_info: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const absPath = resolvePathInVault(vault.path, args.path);
        const entries = await fs.readdir(absPath, { withFileTypes: true });
        let fileCount = 0, folderCount = 0, totalSize = 0;
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) folderCount++;
          else {
            fileCount++;
            const stat = await fs.stat(path.join(absPath, entry.name));
            totalSize += stat.size;
          }
        }
        return ok(`path\t${args.path}\nfiles\t${fileCount}\nfolders\t${folderCount}\nsize\t${totalSize}`);
      } catch (e: any) {
        return err(`Error getting folder info: ${e.message}`);
      }
    },

    list_folders: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const startDir = args.folder
          ? resolvePathInVault(vault.path, args.folder)
          : vault.path;
        const folders = await listAllFolders(startDir, args.folder || '');
        return ok(folders.length > 0 ? folders.join('\n') : 'No folders found.');
      } catch (e: any) {
        return err(`Error listing folders: ${e.message}`);
      }
    },

    get_vault_info: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const folders = await listAllFolders(vault.path);
        let totalSize = 0;
        for (const file of files) {
          try {
            const stat = await fs.stat(resolvePathInVault(vault.path, file));
            totalSize += stat.size;
          } catch { /* skip */ }
        }
        return ok(`name\t${vault.name}\npath\t${vault.path}\nfiles\t${files.length}\nfolders\t${folders.length}\nsize\t${totalSize}`);
      } catch (e: any) {
        return err(`Error getting vault info: ${e.message}`);
      }
    },

    // ── Bookmarks ──
    add_bookmark: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const bookmarks = await readObsidianConfig(vault.path, 'bookmarks.json') || { items: [] };
        const item: any = { ctime: Date.now() };
        if (args.file) { item.type = 'file'; item.path = args.file; }
        else if (args.folder) { item.type = 'folder'; item.path = args.folder; }
        else if (args.search) { item.type = 'search'; item.query = args.search; }
        else if (args.url) { item.type = 'url'; item.url = args.url; }
        else return err('Provide file, folder, search, or url to bookmark');
        if (args.subpath) item.subpath = args.subpath;
        if (args.title) item.title = args.title;
        bookmarks.items.push(item);
        await writeObsidianConfig(vault.path, 'bookmarks.json', bookmarks);
        return ok('Bookmark added.');
      } catch (e: any) {
        return err(`Error adding bookmark: ${e.message}`);
      }
    },

    list_bookmarks: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const bookmarks = await readObsidianConfig(vault.path, 'bookmarks.json');
        if (!bookmarks?.items?.length) return ok('No bookmarks found.');
        const lines = bookmarks.items.map((item: any) => {
          const parts = [item.type, item.path || item.query || item.url || ''];
          if (item.title) parts.push(item.title);
          return parts.join('\t');
        });
        return ok(lines.join('\n'));
      } catch (e: any) {
        return err(`Error listing bookmarks: ${e.message}`);
      }
    },

    // ── Search ──
    search_with_context: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const startDir = args.folder
          ? resolvePathInVault(vault.path, args.folder)
          : vault.path;
        const files = await listMarkdownFiles(startDir, args.folder || '');
        const flags = args.case_sensitive ? '' : 'i';
        const regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        const results: string[] = [];
        const limit = args.limit || 50;

        for (const file of files) {
          if (results.length >= limit) break;
          try {
            const content = await readVaultFile(vault.path, file);
            const lines = content.split('\n');
            const matchLines: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matchLines.push(`${i + 1}: ${lines[i].trim()}`);
              }
            }
            if (matchLines.length > 0) {
              results.push(`${file}:\n${matchLines.join('\n')}`);
            }
          } catch { /* skip */ }
        }
        return ok(results.length > 0 ? results.join('\n\n') : 'No results found.');
      } catch (e: any) {
        return err(`Error searching: ${e.message}`);
      }
    },

    // ── Plugins (read-only from disk) ──
    list_plugins: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const results: string[] = [];

        if (!args.filter || args.filter === 'core') {
          const coreConfig = await readObsidianConfig(vault.path, 'core-plugins.json');
          if (coreConfig) {
            for (const [id, enabled] of Object.entries(coreConfig)) {
              results.push(`${id}\tcore\t${enabled ? 'enabled' : 'disabled'}`);
            }
          }
        }

        if (!args.filter || args.filter === 'community') {
          const communityList = await readObsidianConfig(vault.path, 'community-plugins.json') || [];
          for (const id of communityList) {
            let version = '';
            if (args.versions) {
              const manifest = await readObsidianConfig(vault.path, `plugins/${id}/manifest.json`);
              version = manifest?.version || '';
            }
            results.push(version ? `${id}\t${version}` : id);
          }
        }

        return ok(results.length > 0 ? results.join('\n') : 'No plugins found.');
      } catch (e: any) {
        return err(`Error listing plugins: ${e.message}`);
      }
    },

    get_plugin_info: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const manifest = await readObsidianConfig(vault.path, `plugins/${args.id}/manifest.json`);
        if (!manifest) {
          // Check if it's a core plugin
          const coreConfig = await readObsidianConfig(vault.path, 'core-plugins.json');
          if (coreConfig && args.id in coreConfig) {
            return ok(`id\t${args.id}\ntype\tcore\nenabled\t${coreConfig[args.id]}`);
          }
          return err(`Plugin "${args.id}" not found.`);
        }
        const lines = Object.entries(manifest).map(([k, v]) => `${k}\t${v}`);
        return ok(lines.join('\n'));
      } catch (e: any) {
        return err(`Error getting plugin info: ${e.message}`);
      }
    },

    list_enabled_plugins: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const results: string[] = [];

        if (!args.filter || args.filter === 'core') {
          const coreConfig = await readObsidianConfig(vault.path, 'core-plugins.json');
          if (coreConfig) {
            for (const [id, enabled] of Object.entries(coreConfig)) {
              if (enabled) results.push(`${id}\tcore`);
            }
          }
        }

        if (!args.filter || args.filter === 'community') {
          const communityList = await readObsidianConfig(vault.path, 'community-plugins.json') || [];
          for (const id of communityList) {
            let version = '';
            if (args.versions) {
              const manifest = await readObsidianConfig(vault.path, `plugins/${id}/manifest.json`);
              version = manifest?.version || '';
            }
            results.push(version ? `${id}\t${version}` : String(id));
          }
        }

        return ok(results.length > 0 ? results.join('\n') : 'No enabled plugins.');
      } catch (e: any) {
        return err(`Error listing enabled plugins: ${e.message}`);
      }
    },

    // ── Snippets & Themes (read-only from disk) ──
    list_snippets: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const snippetsDir = path.join(vault.path, '.obsidian', 'snippets');
        try {
          const entries = await fs.readdir(snippetsDir);
          const cssFiles = entries.filter(e => e.endsWith('.css'));
          return ok(cssFiles.length > 0 ? cssFiles.join('\n') : 'No snippets installed.');
        } catch {
          return ok('No snippets installed.');
        }
      } catch (e: any) {
        return err(`Error listing snippets: ${e.message}`);
      }
    },

    list_themes: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const themesDir = path.join(vault.path, '.obsidian', 'themes');
        try {
          const entries = await fs.readdir(themesDir, { withFileTypes: true });
          const themes = entries.filter(e => e.isDirectory()).map(e => e.name);
          if (args.versions) {
            const results: string[] = [];
            for (const theme of themes) {
              const manifest = await readObsidianConfig(vault.path, `themes/${theme}/manifest.json`);
              results.push(manifest?.version ? `${theme}\t${manifest.version}` : theme);
            }
            return ok(results.length > 0 ? results.join('\n') : 'No themes installed.');
          }
          return ok(themes.length > 0 ? themes.join('\n') : 'No themes installed.');
        } catch {
          return ok('No themes installed.');
        }
      } catch (e: any) {
        return err(`Error listing themes: ${e.message}`);
      }
    },

    get_active_theme: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const appearance = await readObsidianConfig(vault.path, 'appearance.json');
        const theme = appearance?.theme || appearance?.cssTheme;
        return ok(theme || '(default)');
      } catch (e: any) {
        return err(`Error getting theme: ${e.message}`);
      }
    },

    // ── Other ──
    read_random: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const startDir = args.folder
          ? resolvePathInVault(vault.path, args.folder)
          : vault.path;
        const files = await listMarkdownFiles(startDir, args.folder || '');
        if (files.length === 0) return ok('No notes found.');
        const pick = files[Math.floor(Math.random() * files.length)];
        const content = await readVaultFile(vault.path, pick);
        return ok(`${pick}\n\n${content}`);
      } catch (e: any) {
        return err(`Error reading random note: ${e.message}`);
      }
    },

    list_orphans: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        // Build set of all link targets
        const linkedTo = new Set<string>();
        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const links = content.match(/\[\[([^\]|]+)/g) || [];
            for (const link of links) {
              // Strip #anchor / ^block-ref and self-anchor links (empty after strip)
              const raw = link.slice(2).trim();
              const target = raw.split('#')[0].split('^')[0].trim();
              if (target) linkedTo.add(target);
            }
          } catch { /* skip */ }
        }
        const orphans = files.filter(f => {
          const name = path.basename(f, '.md');
          return !linkedTo.has(name) && !linkedTo.has(f);
        });
        return ok(orphans.length > 0 ? orphans.join('\n') : 'No orphan notes found.');
      } catch (e: any) {
        return err(`Error listing orphans: ${e.message}`);
      }
    },

    list_deadends: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const deadends: string[] = [];
        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const links = content.match(/\[\[([^\]]+)\]\]/g) || [];
            if (links.length === 0) deadends.push(file);
          } catch { /* skip */ }
        }
        return ok(deadends.length > 0 ? deadends.join('\n') : 'No dead-end notes found.');
      } catch (e: any) {
        return err(`Error listing deadends: ${e.message}`);
      }
    },

    unresolved_links: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const files = await listMarkdownFiles(vault.path);
        const fileNames = new Set(files.map(f => path.basename(f, '.md')));
        const filePaths = new Set(files);
        const unresolved: string[] = [];

        for (const file of files) {
          try {
            const content = await readVaultFile(vault.path, file);
            const links = content.match(/\[\[([^\]|]+)/g) || [];
            for (const link of links) {
              // Strip #anchor / ^block-ref; skip self-anchors (empty after strip)
              const raw = link.slice(2).trim();
              const target = raw.split('#')[0].split('^')[0].trim();
              if (!target) continue;
              if (!fileNames.has(target) && !filePaths.has(target) && !filePaths.has(target + '.md')) {
                if (args.verbose) {
                  unresolved.push(`${target}\t${file}`);
                } else {
                  unresolved.push(target);
                }
              }
            }
          } catch { /* skip */ }
        }
        // Deduplicate if not verbose
        const result = args.verbose ? unresolved : [...new Set(unresolved)];
        return ok(result.length > 0 ? result.join('\n') : 'No unresolved links found.');
      } catch (e: any) {
        return err(`Error listing unresolved links: ${e.message}`);
      }
    },

    get_workspace: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const workspace = await readObsidianConfig(vault.path, 'workspace.json');
        if (!workspace) return ok('No workspace data found.');

        // Format workspace tree
        const formatNode = (node: any, indent: string = ''): string => {
          const lines: string[] = [];
          if (node.type === 'leaf' && node.state) {
            const viewType = node.state.type || 'unknown';
            const title = node.state.title || node.state.state?.file || '';
            lines.push(`${indent}[${viewType}] ${title}`);
          } else if (node.type === 'tabs' || node.type === 'split') {
            if (node.children) {
              for (const child of node.children) {
                lines.push(formatNode(child, indent));
              }
            }
          }
          return lines.join('\n');
        };

        const sections: string[] = [];
        for (const [key, value] of Object.entries(workspace)) {
          if (key === 'lastOpenFiles' || key === 'active' || typeof value !== 'object') continue;
          const content = formatNode(value as any, '    ');
          if (content) sections.push(`${key}\n└── tabs\n${content}`);
        }
        return ok(sections.join('\n') || 'Workspace empty.');
      } catch (e: any) {
        return err(`Error getting workspace: ${e.message}`);
      }
    },

    list_bases: async (args) => {
      try {
        const vault = resolveVault(config, args.vault);
        const allFiles: string[] = [];
        const scan = async (dir: string, base: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) {
              await scan(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name);
            } else if (entry.name.endsWith('.base')) {
              allFiles.push(base ? `${base}/${entry.name}` : entry.name);
            }
          }
        };
        await scan(vault.path, '');
        return ok(allFiles.length > 0 ? allFiles.join('\n') : 'No base files found.');
      } catch (e: any) {
        return err(`Error listing bases: ${e.message}`);
      }
    }
  };

  return handlers;
}
