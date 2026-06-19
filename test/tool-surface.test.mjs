/**
 * L0 baseline: tool surface contract tests
 *
 * Verifies that:
 *  - allTools is non-empty and every entry has the required shape
 *  - every tool name maps to a handler in createAllHandlers(loadConfig())
 *  - OBSIDIAN_DISABLED_TOOLS removes a named tool from BOTH allTools and handlers
 *  - the {name, description} snapshot matches the built dist/ exactly
 *  - the {name, description, inputSchema} snapshot matches the built dist/ exactly (gap #2)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Snapshot — contract baseline for {name, description} pairs
// Regenerate by running: node --input-type=module -e "import {allTools} ...".
// DO NOT edit manually; bump when dist/ changes.
// ---------------------------------------------------------------------------
const SNAPSHOT = [
  { name: 'list_files', description: 'List files and folders in an Obsidian vault directory. Returns name, path, type (file/folder), size, and modification date.' },
  { name: 'read_file', description: 'Read a markdown file from the Obsidian vault. Returns parsed frontmatter (YAML) and content separately.' },
  { name: 'create_file', description: 'Create a new markdown file in the vault. Will create parent directories if needed.' },
  { name: 'update_file', description: 'Replace the entire content of a markdown file. Preserves frontmatter unless new frontmatter is provided.' },
  { name: 'delete_file', description: 'Delete a file from the vault. Use with caution!' },
  { name: 'get_frontmatter', description: 'Get only the YAML frontmatter from a file, without loading full content.' },
  { name: 'update_frontmatter', description: 'Update specific frontmatter fields without changing file content. Merges with existing frontmatter.' },
  { name: 'search_content', description: 'Search for text or regex pattern across vault files. Returns matching files with line numbers and context.' },
  { name: 'move_note', description: 'Move/rename a note and update all wikilinks pointing to it across the vault.' },
  { name: 'resolve_wikilink', description: 'Resolve a [[wikilink]] to its actual file path in the vault. Returns null if not found.' },
  { name: 'get_outlinks', description: 'Get all wikilinks FROM a file (outgoing links). Shows which notes this file links to.' },
  { name: 'get_backlinks', description: 'Get all files linking TO a note (incoming links/backlinks). Shows which notes reference this one.' },
  { name: 'follow_link', description: 'Resolve a wikilink and return its content. Combines resolve + read in one operation.' },
  { name: 'rebuild_link_index', description: 'Rebuild the internal file index for faster wikilink resolution. Run after adding many files.' },
  { name: 'semantic_search', description: 'Search vault using hybrid semantic + keyword search. Finds content by meaning and exact matches. Requires indexed vault.' },
  { name: 'index_vault', description: 'Build or rebuild the semantic search index. Processes all markdown files and generates embeddings. May take a while for large vaults.' },
  { name: 'index_file', description: 'Index a single file for semantic search.' },
  { name: 'get_similar', description: 'Find files similar to a given file based on semantic similarity.' },
  { name: 'index_status', description: 'Get status of the semantic search index.' },
  { name: 'search_all_vaults', description: 'Search for text or regex pattern across ALL configured vaults. Returns results grouped by vault.' },
  { name: 'semantic_search_all', description: 'Semantic search across ALL configured vaults. Finds content by meaning across your entire knowledge ecosystem.' },
  { name: 'find_note_by_name', description: 'Find a note by name across all vaults. Useful when you know the note name but not which vault it is in.' },
  { name: 'get_ecosystem_stats', description: 'Get statistics about the entire knowledge ecosystem across all vaults.' },
  { name: 'get_cross_vault_links', description: 'Find notes that could potentially link to content in other vaults based on wikilink targets.' },
  { name: 'append_to_section', description: 'Append content to the end of a markdown section (before the next heading of same or higher level). Useful for adding entries to Progress Logs, adding items to lists, etc. without sending the entire file.' },
  { name: 'prepend_to_section', description: 'Prepend content to the beginning of a markdown section (right after the heading). Useful for adding new items at the top of a section.' },
  { name: 'update_section', description: 'Replace the entire content of a markdown section (between heading and next heading of same or higher level). The heading itself is preserved.' },
  { name: 'query_notes', description: 'Query vault notes by frontmatter fields. Like Dataview but without needing Obsidian. Filter by type, status, tags, dates, or any frontmatter field.' },
  { name: 'get_vault_health', description: 'Comprehensive vault health report: orphan notes, broken links, stale notes, and file stats. Runs all analytics in one pass.' },
  { name: 'get_orphan_notes', description: 'Find notes with zero inbound wikilinks (not linked to by any other note).' },
  { name: 'get_broken_links', description: 'Find all wikilinks that point to non-existent notes.' },
  { name: 'get_stale_notes', description: 'Find notes not modified within a given number of days.' },
  { name: 'daily_read', description: "Read today's daily note contents." },
  { name: 'daily_append', description: "Append content to today's daily note. Creates the note if it doesn't exist." },
  { name: 'daily_prepend', description: "Prepend content to today's daily note. Creates the note if it doesn't exist." },
  { name: 'daily_path', description: "Get today's daily note path (even if it hasn't been created yet)." },
  { name: 'list_tasks', description: 'List tasks across the vault or from a specific file. Filter by done/todo.' },
  { name: 'update_task', description: 'Toggle or set the status of a task by file and line number.' },
  { name: 'list_tags', description: 'List all tags in the vault with occurrence counts.' },
  { name: 'get_tag_info', description: 'Get details about a specific tag: occurrence count and which files use it.' },
  { name: 'list_properties', description: 'List all frontmatter properties used across the vault with counts.' },
  { name: 'get_property_values', description: 'Get all unique values used for a specific frontmatter property across the vault.' },
  { name: 'property_read', description: 'Read a single frontmatter property value from a file.' },
  { name: 'property_set', description: 'Set a single frontmatter property on a file. Does not touch file content.' },
  { name: 'property_remove', description: 'Remove a single frontmatter property from a file. Does not touch file content.' },
  { name: 'get_outline', description: 'Get the heading structure (outline) of a file as a tree.' },
  { name: 'word_count', description: 'Count words and characters in a file.' },
  { name: 'list_aliases', description: 'List aliases in the vault or for a specific file.' },
  { name: 'file_append', description: 'Append content to end of a file.' },
  { name: 'file_prepend', description: 'Prepend content to start of a file (after frontmatter).' },
  { name: 'search_replace_in_file', description: 'Replace specific text in a file. Only changes the matched text — does NOT replace the whole file.' },
  { name: 'rename_file', description: 'Rename a file and update all wikilinks pointing to it.' },
  { name: 'move_file', description: 'Move a file and update all wikilinks pointing to it.' },
  { name: 'get_file_info', description: 'Get file metadata — name, path, size, created/modified dates.' },
  { name: 'get_folder_info', description: 'Get folder metadata — file count, folder count, size.' },
  { name: 'list_folders', description: 'List folders in the vault, optionally filtered by parent folder.' },
  { name: 'get_vault_info', description: 'Get vault metadata — name, path, file count, folder count, size.' },
  { name: 'add_bookmark', description: 'Add a bookmark to a file, folder, search query, or URL.' },
  { name: 'list_bookmarks', description: 'List all bookmarks.' },
  { name: 'search_with_context', description: 'Search vault for text with matching line context.' },
  { name: 'list_plugins', description: 'List installed Obsidian plugins.' },
  { name: 'get_plugin_info', description: 'Get detailed info about a specific plugin.' },
  { name: 'list_enabled_plugins', description: 'List only enabled plugins.' },
  { name: 'list_snippets', description: 'List installed CSS snippets.' },
  { name: 'list_themes', description: 'List installed themes.' },
  { name: 'get_active_theme', description: 'Get the active theme name.' },
  { name: 'read_random', description: 'Read a random note from the vault.' },
  { name: 'list_orphans', description: 'List files with no incoming links (orphan notes).' },
  { name: 'list_deadends', description: 'List files with no outgoing links (dead-end notes).' },
  { name: 'unresolved_links', description: 'List broken/unresolved wikilinks across the vault.' },
  { name: 'get_workspace', description: 'Get the workspace tree showing open panes and layout (from last saved state).' },
  { name: 'list_bases', description: 'List all .base files in the vault.' },
  { name: 'eval_obsidian', description: 'Execute JavaScript inside the Obsidian app and return the result. Access to full app API. Requires Obsidian running.' },
  { name: 'list_commands', description: 'List available Obsidian commands. Requires Obsidian running.' },
  { name: 'execute_command', description: 'Execute an Obsidian command by ID. Requires Obsidian running.' },
  { name: 'query_base', description: 'Query a base and return structured results. Requires Obsidian running.' },
  { name: 'create_base_item', description: 'Create a new item in an Obsidian base/database. Requires Obsidian running.' },
  { name: 'list_base_views', description: 'List views in a base file. Requires Obsidian running.' },
  { name: 'enable_plugin', description: 'Enable an installed plugin. Requires Obsidian running.' },
  { name: 'disable_plugin', description: 'Disable a plugin. Requires Obsidian running.' },
  { name: 'enable_snippet', description: 'Enable a CSS snippet. Requires Obsidian running.' },
  { name: 'disable_snippet', description: 'Disable a CSS snippet. Requires Obsidian running.' },
  { name: 'set_theme', description: 'Set the active theme. Requires Obsidian running.' },
  { name: 'sync_status', description: 'Get Obsidian Sync status (paused/active/connected). Requires Obsidian running.' },
  { name: 'sync_history', description: 'List sync version history for a file. Requires Obsidian running.' },
  { name: 'sync_read_version', description: 'Read a specific sync version of a file. Requires Obsidian running.' },
  { name: 'list_versions', description: 'List version history for a file (from local file recovery and/or sync). Requires Obsidian running.' },
  { name: 'read_version', description: 'Read a specific version of a file from history. Requires Obsidian running.' },
  { name: 'diff_versions', description: 'Diff between two file versions (local or sync). Requires Obsidian running.' },
  { name: 'restore_version', description: 'Restore a file to a previous history version. Requires Obsidian running.' },
  { name: 'list_files_with_history', description: 'List files that have version history. Requires Obsidian running.' },
  { name: 'list_recents', description: 'List recently opened files. Requires Obsidian running.' },
  { name: 'vault_search', description: "Search vault using Obsidian's built-in search engine. Supports operators like file:, tag:, path:. Requires Obsidian running." },
  { name: 'list_known_vaults', description: 'List all vaults known to Obsidian with their paths. Requires Obsidian running.' },
  { name: 'create_from_template', description: 'Create a new file using an Obsidian template. Requires Obsidian running.' },
  { name: 'list_templates', description: 'List available templates in the vault. Requires Obsidian running.' },
  { name: 'read_template', description: 'Read a template with optional variable resolution. Requires Obsidian running.' },
  { name: 'get_hotkey', description: 'Get the hotkey binding for a specific command. Requires Obsidian running.' },
  { name: 'list_hotkeys', description: 'List all hotkey bindings. Requires Obsidian running.' },
  { name: 'list_enabled_snippets', description: 'List enabled CSS snippets. Requires Obsidian running.' },
  { name: 'get_started', description: 'Orientation guide for this Obsidian MCP instance. Returns configured vault names, total tool count, tool categories with counts, and static guidance on resolver-first workflow, wikilink syntax, and CLI vs filesystem tiers. Call this first in a new session.' },
  { name: 'discover_tools', description: 'Compact inventory of all registered tools with pagination. Returns name, category, and tier (filesystem/cli) per tool — no full schemas. Also includes a category histogram for the full tool surface. Use this for AI orientation when get_started category counts are not enough detail.' },
];

// ---------------------------------------------------------------------------
// Schema Snapshot — contract baseline for {name, description, inputSchema} triples
// Extends SNAPSHOT to capture schema internals so param/required changes trip the contract.
// Regenerate: node --input-type=module -e "import {allTools} from './dist/tools/index.js';
//   console.log(JSON.stringify(allTools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})),null,2));"
// DO NOT edit manually; bump when dist/ changes.
// ---------------------------------------------------------------------------
const SCHEMA_SNAPSHOT = [
  {
    name: 'list_files',
    description: 'List files and folders in an Obsidian vault directory. Returns name, path, type (file/folder), size, and modification date.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        directory: { type: 'string', description: 'Relative path from vault root. Empty or "/" for vault root.' },
        pattern: { type: 'string', description: 'Optional glob pattern to filter files (e.g., "*.md", "PROJECT*")' },
        recursive: { type: 'boolean', description: 'Include files in subdirectories', default: false },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a markdown file from the Obsidian vault. Returns parsed frontmatter (YAML) and content separately.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path from vault root (e.g., "01 Evergreen Notes/My Note.md")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new markdown file in the vault. Will create parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path for the new file (e.g., "03 Projects/New Project.md")' },
        content: { type: 'string', description: 'Markdown content for the file' },
        frontmatter: { type: 'object', description: 'Optional YAML frontmatter as key-value pairs' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'update_file',
    description: 'Replace the entire content of a markdown file. Preserves frontmatter unless new frontmatter is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
        content: { type: 'string', description: 'New markdown content' },
        frontmatter: { type: 'object', description: 'Optional new frontmatter (replaces existing if provided)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the vault. Use with caution!',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file to delete' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_frontmatter',
    description: 'Get only the YAML frontmatter from a file, without loading full content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'update_frontmatter',
    description: 'Update specific frontmatter fields without changing file content. Merges with existing frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
        updates: { type: 'object', description: 'Frontmatter fields to update or add' },
      },
      required: ['path', 'updates'],
    },
  },
  {
    name: 'search_content',
    description: 'Search for text or regex pattern across vault files. Returns matching files with line numbers and context.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        query: { type: 'string', description: 'Text or regex pattern to search for' },
        directory: { type: 'string', description: 'Limit search to a specific directory' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search', default: false },
        maxResults: { type: 'number', description: 'Maximum number of files to return', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'move_note',
    description: 'Move/rename a note and update all wikilinks pointing to it across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        from_path: { type: 'string', description: 'Current relative path of the file' },
        to_path: { type: 'string', description: 'New relative path for the file' },
      },
      required: ['from_path', 'to_path'],
    },
  },
  {
    name: 'resolve_wikilink',
    description: 'Resolve a [[wikilink]] to its actual file path in the vault. Returns null if not found.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        link: { type: 'string', description: 'The wikilink target (e.g., "My Note" or "folder/My Note")' },
      },
      required: ['link'],
    },
  },
  {
    name: 'get_outlinks',
    description: 'Get all wikilinks FROM a file (outgoing links). Shows which notes this file links to.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
        resolveLinks: { type: 'boolean', description: 'Resolve each link to its actual file path', default: true },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_backlinks',
    description: 'Get all files linking TO a note (incoming links/backlinks). Shows which notes reference this one.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the target file' },
        includeContext: { type: 'boolean', description: 'Include surrounding text context for each backlink', default: true },
      },
      required: ['path'],
    },
  },
  {
    name: 'follow_link',
    description: 'Resolve a wikilink and return its content. Combines resolve + read in one operation.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        link: { type: 'string', description: 'The wikilink to follow (e.g., "My Note" or "folder/My Note")' },
      },
      required: ['link'],
    },
  },
  {
    name: 'rebuild_link_index',
    description: 'Rebuild the internal file index for faster wikilink resolution. Run after adding many files.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'semantic_search',
    description: 'Search vault using hybrid semantic + keyword search. Finds content by meaning and exact matches. Requires indexed vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        query: { type: 'string', description: 'Natural language query (e.g., "notes about marketing strategy")' },
        limit: { type: 'number', description: 'Maximum results to return', default: 10 },
        minSimilarity: { type: 'number', description: 'Minimum similarity score (0-1)', default: 0.5 },
        expand: { type: 'boolean', description: 'Expand query into multiple variants for better recall', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'index_vault',
    description: 'Build or rebuild the semantic search index. Processes all markdown files and generates embeddings. May take a while for large vaults.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        force: { type: 'boolean', description: 'Re-index all files even if unchanged', default: false },
        directory: { type: 'string', description: 'Only index files in this directory' },
      },
    },
  },
  {
    name: 'index_file',
    description: 'Index a single file for semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_similar',
    description: 'Find files similar to a given file based on semantic similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the reference file' },
        limit: { type: 'number', description: 'Maximum results to return', default: 5 },
      },
      required: ['path'],
    },
  },
  {
    name: 'index_status',
    description: 'Get status of the semantic search index.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'search_all_vaults',
    description: 'Search for text or regex pattern across ALL configured vaults. Returns results grouped by vault.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex pattern to search for' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search', default: false },
        maxResultsPerVault: { type: 'number', description: 'Maximum results per vault', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'semantic_search_all',
    description: 'Semantic search across ALL configured vaults. Finds content by meaning across your entire knowledge ecosystem.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Maximum total results', default: 10 },
        minSimilarity: { type: 'number', description: 'Minimum similarity score (0-1)', default: 0.3 },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_note_by_name',
    description: 'Find a note by name across all vaults. Useful when you know the note name but not which vault it is in.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Note name to search for (partial match supported)' },
        exactMatch: { type: 'boolean', description: 'Require exact name match (excluding .md extension)', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_ecosystem_stats',
    description: 'Get statistics about the entire knowledge ecosystem across all vaults.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_cross_vault_links',
    description: 'Find notes that could potentially link to content in other vaults based on wikilink targets.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Optional: only check unresolved links from this vault' },
      },
    },
  },
  {
    name: 'append_to_section',
    description: 'Append content to the end of a markdown section (before the next heading of same or higher level). Useful for adding entries to Progress Logs, adding items to lists, etc. without sending the entire file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file (e.g., "03 Projects/PROJECT My Project.md")' },
        heading: { type: 'string', description: 'The heading text to find. Can include level (e.g., "## Progress Log") or just text (e.g., "Progress Log")' },
        content: { type: 'string', description: 'Content to append to the section' },
      },
      required: ['path', 'heading', 'content'],
    },
  },
  {
    name: 'prepend_to_section',
    description: 'Prepend content to the beginning of a markdown section (right after the heading). Useful for adding new items at the top of a section.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
        heading: { type: 'string', description: 'The heading text to find. Can include level (e.g., "## Log") or just text (e.g., "Log")' },
        content: { type: 'string', description: 'Content to prepend to the section' },
      },
      required: ['path', 'heading', 'content'],
    },
  },
  {
    name: 'update_section',
    description: 'Replace the entire content of a markdown section (between heading and next heading of same or higher level). The heading itself is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Relative path to the file' },
        heading: { type: 'string', description: 'The heading text to find' },
        content: { type: 'string', description: 'New content to replace the section with' },
      },
      required: ['path', 'heading', 'content'],
    },
  },
  {
    name: 'query_notes',
    description: 'Query vault notes by frontmatter fields. Like Dataview but without needing Obsidian. Filter by type, status, tags, dates, or any frontmatter field.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        from: { type: 'string', description: 'Directory prefix filter (e.g., "03 Projects", "05 Resources/AI Context")' },
        where: {
          type: 'array',
          description: 'Filter conditions. Each has field, op (equals/not_equals/contains/in/exists/not_exists/greater_than/less_than), and value.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Frontmatter field name (e.g., "type", "status", "tags")' },
              op: { type: 'string', description: 'Operator: equals, not_equals, contains, not_contains, in, not_in, exists, not_exists, greater_than, less_than' },
              value: { description: 'Value to compare against (not needed for exists/not_exists)' },
            },
            required: ['field', 'op'],
          },
        },
        fields: { type: 'array', description: 'Which frontmatter fields to return (default: all)', items: { type: 'string' } },
        sort_by: { type: 'string', description: 'Frontmatter field to sort by. Prefix with "-" for descending (e.g., "-updated", "title")' },
        limit: { type: 'number', description: 'Maximum results to return', default: 20 },
      },
    },
  },
  {
    name: 'get_vault_health',
    description: 'Comprehensive vault health report: orphan notes, broken links, stale notes, and file stats. Runs all analytics in one pass.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        stale_days: { type: 'number', description: 'Days threshold for stale note detection', default: 90 },
      },
    },
  },
  {
    name: 'get_orphan_notes',
    description: 'Find notes with zero inbound wikilinks (not linked to by any other note).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        exclude_patterns: { type: 'array', description: 'Directory patterns to exclude (e.g., ["00 Inbox", "05 Resources/Templates"])', items: { type: 'string' } },
        limit: { type: 'number', description: 'Maximum results', default: 50 },
      },
    },
  },
  {
    name: 'get_broken_links',
    description: 'Find all wikilinks that point to non-existent notes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        limit: { type: 'number', description: 'Maximum results', default: 50 },
      },
    },
  },
  {
    name: 'get_stale_notes',
    description: 'Find notes not modified within a given number of days.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        days: { type: 'number', description: 'Days since last modification', default: 90 },
        type_filter: { type: 'string', description: 'Only include notes with this frontmatter type (e.g., "PROJECT")' },
        exclude_patterns: { type: 'array', description: 'Directory patterns to exclude', items: { type: 'string' } },
        limit: { type: 'number', description: 'Maximum results', default: 50 },
      },
    },
  },
  {
    name: 'daily_read',
    description: "Read today's daily note contents.",
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'daily_append',
    description: "Append content to today's daily note. Creates the note if it doesn't exist.",
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        content: { type: 'string', description: 'Content to append' },
      },
      required: ['content'],
    },
  },
  {
    name: 'daily_prepend',
    description: "Prepend content to today's daily note. Creates the note if it doesn't exist.",
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        content: { type: 'string', description: 'Content to prepend' },
      },
      required: ['content'],
    },
  },
  {
    name: 'daily_path',
    description: "Get today's daily note path (even if it hasn't been created yet).",
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks across the vault or from a specific file. Filter by done/todo.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'Filter by file name' },
        path: { type: 'string', description: 'Filter by file path' },
        filter: { type: 'string', enum: ['todo', 'done', 'all'], description: 'Filter tasks (default: all)' },
        verbose: { type: 'boolean', description: 'Group by file with line numbers' },
      },
    },
  },
  {
    name: 'update_task',
    description: 'Toggle or set the status of a task by file and line number.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name containing the task' },
        path: { type: 'string', description: 'File path containing the task' },
        line: { type: 'number', description: 'Line number of the task' },
        action: { type: 'string', enum: ['toggle', 'done', 'todo'], description: 'Action to perform' },
      },
      required: ['line', 'action'],
    },
  },
  {
    name: 'list_tags',
    description: 'List all tags in the vault with occurrence counts.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        sort: { type: 'string', enum: ['name', 'count'], description: 'Sort order (default: name)' },
      },
    },
  },
  {
    name: 'get_tag_info',
    description: 'Get details about a specific tag: occurrence count and which files use it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Tag name (with or without #)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_properties',
    description: 'List all frontmatter properties used across the vault with counts.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        sort: { type: 'string', enum: ['name', 'count'], description: 'Sort order (default: name)' },
      },
    },
  },
  {
    name: 'get_property_values',
    description: 'Get all unique values used for a specific frontmatter property across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Property name (e.g., "status", "type", "domain")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'property_read',
    description: 'Read a single frontmatter property value from a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Property name' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
      },
      required: ['name'],
    },
  },
  {
    name: 'property_set',
    description: 'Set a single frontmatter property on a file. Does not touch file content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        name: { type: 'string', description: 'Property name' },
        value: { type: 'string', description: 'Property value' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'property_remove',
    description: 'Remove a single frontmatter property from a file. Does not touch file content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        name: { type: 'string', description: 'Property name to remove' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_outline',
    description: 'Get the heading structure (outline) of a file as a tree.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
      },
    },
  },
  {
    name: 'word_count',
    description: 'Count words and characters in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
      },
    },
  },
  {
    name: 'list_aliases',
    description: 'List aliases in the vault or for a specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        verbose: { type: 'boolean', description: 'Include file paths' },
      },
    },
  },
  {
    name: 'file_append',
    description: 'Append content to end of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to append' },
      },
      required: ['content'],
    },
  },
  {
    name: 'file_prepend',
    description: 'Prepend content to start of a file (after frontmatter).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to prepend' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_replace_in_file',
    description: 'Replace specific text in a file. Only changes the matched text — does NOT replace the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        search: { type: 'string', description: 'Exact text to find' },
        replace: { type: 'string', description: 'Replacement text' },
        all: { type: 'boolean', description: 'Replace all occurrences (default: first only)' },
      },
      required: ['search', 'replace'],
    },
  },
  {
    name: 'rename_file',
    description: 'Rename a file and update all wikilinks pointing to it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'Current file name' },
        path: { type: 'string', description: 'Current file path' },
        name: { type: 'string', description: 'New file name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'move_file',
    description: 'Move a file and update all wikilinks pointing to it.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        to: { type: 'string', description: 'Destination folder or path' },
      },
      required: ['to'],
    },
  },
  {
    name: 'get_file_info',
    description: 'Get file metadata — name, path, size, created/modified dates.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
      },
    },
  },
  {
    name: 'get_folder_info',
    description: 'Get folder metadata — file count, folder count, size.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        path: { type: 'string', description: 'Folder path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_folders',
    description: 'List folders in the vault, optionally filtered by parent folder.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        folder: { type: 'string', description: 'Filter by parent folder' },
      },
    },
  },
  {
    name: 'get_vault_info',
    description: 'Get vault metadata — name, path, file count, folder count, size.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'add_bookmark',
    description: 'Add a bookmark to a file, folder, search query, or URL.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File path to bookmark' },
        subpath: { type: 'string', description: 'Subpath (heading or block) within file' },
        folder: { type: 'string', description: 'Folder to bookmark' },
        search: { type: 'string', description: 'Search query to bookmark' },
        url: { type: 'string', description: 'URL to bookmark' },
        title: { type: 'string', description: 'Bookmark title' },
      },
    },
  },
  {
    name: 'list_bookmarks',
    description: 'List all bookmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        verbose: { type: 'boolean', description: 'Include bookmark types' },
      },
    },
  },
  {
    name: 'search_with_context',
    description: 'Search vault for text with matching line context.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        query: { type: 'string', description: 'Search query' },
        folder: { type: 'string', description: 'Limit to folder' },
        limit: { type: 'number', description: 'Max files' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive search' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_plugins',
    description: 'List installed Obsidian plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        filter: { type: 'string', enum: ['core', 'community'], description: 'Filter by plugin type' },
        versions: { type: 'boolean', description: 'Include version numbers' },
      },
    },
  },
  {
    name: 'get_plugin_info',
    description: 'Get detailed info about a specific plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        id: { type: 'string', description: 'Plugin ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_enabled_plugins',
    description: 'List only enabled plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        filter: { type: 'string', enum: ['core', 'community'], description: 'Filter by plugin type' },
        versions: { type: 'boolean', description: 'Include version numbers' },
      },
    },
  },
  {
    name: 'list_snippets',
    description: 'List installed CSS snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'list_themes',
    description: 'List installed themes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        versions: { type: 'boolean', description: 'Include version numbers' },
      },
    },
  },
  {
    name: 'get_active_theme',
    description: 'Get the active theme name.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'read_random',
    description: 'Read a random note from the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        folder: { type: 'string', description: 'Limit to folder' },
      },
    },
  },
  {
    name: 'list_orphans',
    description: 'List files with no incoming links (orphan notes).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'list_deadends',
    description: 'List files with no outgoing links (dead-end notes).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'unresolved_links',
    description: 'List broken/unresolved wikilinks across the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        verbose: { type: 'boolean', description: 'Include source files' },
      },
    },
  },
  {
    name: 'get_workspace',
    description: 'Get the workspace tree showing open panes and layout (from last saved state).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'list_bases',
    description: 'List all .base files in the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'eval_obsidian',
    description: 'Execute JavaScript inside the Obsidian app and return the result. Access to full app API. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        code: { type: 'string', description: 'JavaScript code to execute (has access to app, app.vault, app.metadataCache, etc.)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'list_commands',
    description: 'List available Obsidian commands. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        filter: { type: 'string', description: 'Filter by command ID prefix' },
      },
    },
  },
  {
    name: 'execute_command',
    description: 'Execute an Obsidian command by ID. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        id: { type: 'string', description: 'Command ID (e.g., "editor:toggle-bold", "app:open-settings")' },
      },
      required: ['id'],
    },
  },
  {
    name: 'query_base',
    description: 'Query a base and return structured results. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' },
        view: { type: 'string', description: 'View name to query' },
        format: { type: 'string', enum: ['json', 'csv', 'tsv', 'md', 'paths'], description: 'Output format (default: json)' },
      },
    },
  },
  {
    name: 'create_base_item',
    description: 'Create a new item in an Obsidian base/database. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' },
        view: { type: 'string', description: 'View name' },
        name: { type: 'string', description: 'New item name' },
        content: { type: 'string', description: 'Initial content' },
      },
    },
  },
  {
    name: 'list_base_views',
    description: 'List views in a base file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'Base file name' },
        path: { type: 'string', description: 'Base file path' },
      },
    },
  },
  {
    name: 'enable_plugin',
    description: 'Enable an installed plugin. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        id: { type: 'string', description: 'Plugin ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'disable_plugin',
    description: 'Disable a plugin. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        id: { type: 'string', description: 'Plugin ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'enable_snippet',
    description: 'Enable a CSS snippet. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Snippet name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'disable_snippet',
    description: 'Disable a CSS snippet. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Snippet name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_theme',
    description: 'Set the active theme. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Theme name (empty for default)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sync_status',
    description: 'Get Obsidian Sync status (paused/active/connected). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'sync_history',
    description: 'List sync version history for a file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
      },
    },
  },
  {
    name: 'sync_read_version',
    description: 'Read a specific sync version of a file. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number' },
      },
      required: ['version'],
    },
  },
  {
    name: 'list_versions',
    description: 'List version history for a file (from local file recovery and/or sync). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        filter: { type: 'string', enum: ['local', 'sync'], description: 'Filter by version source' },
      },
    },
  },
  {
    name: 'read_version',
    description: 'Read a specific version of a file from history. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number (1 = newest)' },
      },
      required: ['version'],
    },
  },
  {
    name: 'diff_versions',
    description: 'Diff between two file versions (local or sync). Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        from: { type: 'number', description: 'Version number to diff from' },
        to: { type: 'number', description: 'Version number to diff to' },
        filter: { type: 'string', enum: ['local', 'sync'], description: 'Filter by version source' },
      },
    },
  },
  {
    name: 'restore_version',
    description: 'Restore a file to a previous history version. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        file: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        version: { type: 'number', description: 'Version number to restore' },
      },
      required: ['version'],
    },
  },
  {
    name: 'list_files_with_history',
    description: 'List files that have version history. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'list_recents',
    description: 'List recently opened files. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'vault_search',
    description: "Search vault using Obsidian's built-in search engine. Supports operators like file:, tag:, path:. Requires Obsidian running.",
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        query: { type: 'string', description: 'Search query (supports Obsidian search operators)' },
        folder: { type: 'string', description: 'Limit to folder path' },
        limit: { type: 'number', description: 'Max files to return' },
        context: { type: 'boolean', description: 'Include matching line context (default: true)' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format (default: text)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_known_vaults',
    description: 'List all vaults known to Obsidian with their paths. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include vault paths' },
      },
    },
  },
  {
    name: 'create_from_template',
    description: 'Create a new file using an Obsidian template. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'File name' },
        path: { type: 'string', description: 'File path' },
        template: { type: 'string', description: 'Template name to use' },
        content: { type: 'string', description: 'Additional initial content' },
        overwrite: { type: 'boolean', description: 'Overwrite if file exists' },
      },
      required: ['template'],
    },
  },
  {
    name: 'list_templates',
    description: 'List available templates in the vault. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'read_template',
    description: 'Read a template with optional variable resolution. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        name: { type: 'string', description: 'Template name' },
        resolve: { type: 'boolean', description: 'Resolve template variables' },
        title: { type: 'string', description: 'Title for {{title}} variable resolution' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_hotkey',
    description: 'Get the hotkey binding for a specific command. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        id: { type: 'string', description: 'Command ID' },
        verbose: { type: 'boolean', description: 'Show if custom or default' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_hotkeys',
    description: 'List all hotkey bindings. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
        verbose: { type: 'boolean', description: 'Show if custom or default' },
        all: { type: 'boolean', description: 'Include commands without hotkeys' },
        format: { type: 'string', enum: ['json', 'tsv', 'csv'], description: 'Output format (default: tsv)' },
      },
    },
  },
  {
    name: 'list_enabled_snippets',
    description: 'List enabled CSS snippets. Requires Obsidian running.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Defaults to first configured vault if omitted.' },
      },
    },
  },
  {
    name: 'get_started',
    description: 'Orientation guide for this Obsidian MCP instance. Returns configured vault names, total tool count, tool categories with counts, and static guidance on resolver-first workflow, wikilink syntax, and CLI vs filesystem tiers. Call this first in a new session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'discover_tools',
    description: 'Compact inventory of all registered tools with pagination. Returns name, category, and tier (filesystem/cli) per tool — no full schemas. Also includes a category histogram for the full tool surface. Use this for AI orientation when get_started category counts are not enough detail.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of tools to return per page', default: 50 },
        offset: { type: 'number', description: 'Zero-based offset for pagination', default: 0 },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal config pointing at a temp vault with no disabled tools.
 * Must be called after setting process.env.OBSIDIAN_VAULT_PATH.
 */
function makeConfig(vaultPath, disabledList = '') {
  // Set env vars before importing loadConfig (config reads env at call time)
  process.env.OBSIDIAN_VAULT_PATH = vaultPath;
  process.env.OBSIDIAN_DISABLED_TOOLS = disabledList;
  delete process.env.OBSIDIAN_VAULTS; // ensure single-vault mode
}

// ---------------------------------------------------------------------------
// Import modules under test (top-level; module cache shared for whole file)
// The disabled-tools test is last and mutates allTools — ordering matters.
//
// NOTE: allTools is an `export let` that gets reassigned inside createAllHandlers
// when disabled tools are configured. ESM destructured bindings become stale
// after reassignment; use the namespace object (toolsMod.allTools) in any test
// that calls createAllHandlers with a non-empty disabledTools set.
// ---------------------------------------------------------------------------
const { loadConfig } = await import('../dist/config.js');
const toolsMod = await import('../dist/tools/index.js');
const { allTools, createAllHandlers } = toolsMod;

// ---------------------------------------------------------------------------
// Baseline tests (no disabled tools)
// ---------------------------------------------------------------------------

let baseVault;

test('setup: create temp vault', () => {
  baseVault = createTempVault({});
  makeConfig(baseVault);
});

test('allTools is non-empty', () => {
  assert.ok(Array.isArray(allTools), 'allTools must be an array');
  assert.ok(allTools.length > 0, 'allTools must not be empty');
});

test('allTools total count matches snapshot', () => {
  assert.equal(
    allTools.length,
    SNAPSHOT.length,
    `expected ${SNAPSHOT.length} tools but got ${allTools.length}`
  );
});

test('every tool has a non-empty name string', () => {
  for (const tool of allTools) {
    assert.equal(typeof tool.name, 'string', `tool.name must be a string (got ${typeof tool.name})`);
    assert.ok(tool.name.length > 0, 'tool.name must not be empty');
  }
});

test('every tool has a non-empty description string', () => {
  for (const tool of allTools) {
    assert.equal(
      typeof tool.description,
      'string',
      `${tool.name}.description must be a string`
    );
    assert.ok(tool.description.length > 0, `${tool.name}.description must not be empty`);
  }
});

test('every tool has an inputSchema with type "object"', () => {
  for (const tool of allTools) {
    assert.ok(
      tool.inputSchema !== null && typeof tool.inputSchema === 'object',
      `${tool.name}.inputSchema must be an object`
    );
    assert.equal(
      tool.inputSchema.type,
      'object',
      `${tool.name}.inputSchema.type must be "object"`
    );
  }
});

test('tool names are unique', () => {
  const names = allTools.map(t => t.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, 'tool names must be unique');
});

test('every tool name has a handler in createAllHandlers(loadConfig())', () => {
  makeConfig(baseVault, '');
  const config = loadConfig();
  const handlers = createAllHandlers(config);

  const missingHandlers = allTools.filter(t => !(t.name in handlers));
  assert.equal(
    missingHandlers.length,
    0,
    `tools with no handler: ${missingHandlers.map(t => t.name).join(', ')}`
  );
});

test('handlers object has no extra entries beyond allTools names', () => {
  makeConfig(baseVault, '');
  const config = loadConfig();
  const handlers = createAllHandlers(config);

  const toolNames = new Set(allTools.map(t => t.name));
  const extra = Object.keys(handlers).filter(k => !toolNames.has(k));
  assert.equal(
    extra.length,
    0,
    `handlers contains entries not in allTools: ${extra.join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// Snapshot contract test
// ---------------------------------------------------------------------------

test('{name, description} snapshot matches built dist/', () => {
  // Re-read allTools before any disabled-tools mutation
  makeConfig(baseVault, '');
  loadConfig(); // ensure env is clean

  const actual = allTools.map(t => ({ name: t.name, description: t.description }));

  assert.equal(
    actual.length,
    SNAPSHOT.length,
    `snapshot length mismatch: expected ${SNAPSHOT.length}, got ${actual.length}`
  );

  for (let i = 0; i < SNAPSHOT.length; i++) {
    assert.deepEqual(
      actual[i],
      SNAPSHOT[i],
      `snapshot mismatch at index ${i} (tool "${SNAPSHOT[i].name}")`
    );
  }
});

// ---------------------------------------------------------------------------
// Schema snapshot contract test (gap #2)
// ---------------------------------------------------------------------------

test('{name, description, inputSchema} snapshot matches built dist/', () => {
  // The vault param description and enum are dynamically injected by injectVaultEnum
  // inside createAllHandlers (already tested by the L2 guard above). Strip vault from
  // properties before comparing so this snapshot stays stable across vault configurations
  // while still catching changes to all other params, required lists, and schema structure.
  function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = { ...schema };
    if (result.properties && typeof result.properties === 'object') {
      // eslint-disable-next-line no-unused-vars
      const { vault: _vault, ...rest } = result.properties;
      result.properties = rest;
    }
    return result;
  }

  const actual = allTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: normalizeSchema(t.inputSchema),
  }));

  const expected = SCHEMA_SNAPSHOT.map(entry => ({
    name: entry.name,
    description: entry.description,
    inputSchema: normalizeSchema(entry.inputSchema),
  }));

  assert.equal(
    actual.length,
    expected.length,
    `schema snapshot length mismatch: expected ${expected.length}, got ${actual.length}`
  );

  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(
      actual[i],
      expected[i],
      `schema snapshot mismatch at index ${i} (tool "${expected[i].name}")`
    );
  }
});

// ---------------------------------------------------------------------------
// L2 regression guard: injectVaultEnum wiring in createAllHandlers
//
// Verifies that createAllHandlers actually calls injectVaultEnum so that
// vault-bearing tools receive a live .enum on their vault param.
// If the wiring call is deleted/reordered in index.ts this test fails.
// ---------------------------------------------------------------------------

test('createAllHandlers injects vault enum into vault-bearing tools (L2 guard)', () => {
  // Use two named vaults (both pointing at the same temp dir) so the enum
  // is non-trivial — guards against a single-element false positive.
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ Alpha: baseVault, Beta: baseVault });
  delete process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_DISABLED_TOOLS = '';

  const config = loadConfig();
  createAllHandlers(config);

  const expectedVaults = config.vaults.map(v => v.name); // ['Alpha', 'Beta']

  // read_file is a well-known vault-bearing tool. Access via namespace so we
  // always get the live reference (the destructured binding may be stale).
  const readFileTool = toolsMod.getToolByName('read_file');

  assert.ok(readFileTool, 'read_file tool must exist');

  const vaultProp = readFileTool.inputSchema.properties.vault;
  assert.ok(vaultProp, 'read_file must have a vault property in its inputSchema');

  assert.deepEqual(
    vaultProp.enum,
    expectedVaults,
    'read_file.inputSchema.properties.vault.enum must equal config vault names after createAllHandlers'
  );

  // Also verify the vault param description mentions the actual vault names
  // (injected by vaultParamWithEnum — not the static "e.g. Platform, Helena" text).
  for (const name of expectedVaults) {
    assert.ok(
      vaultProp.description.includes(name),
      `vault param description must include vault name "${name}" after injection`
    );
  }

  // Restore to single-vault mode for the disabled-tools test that follows
  delete process.env.OBSIDIAN_VAULTS;
  process.env.OBSIDIAN_VAULT_PATH = baseVault;
});

// ---------------------------------------------------------------------------
// OBSIDIAN_DISABLED_TOOLS test — runs LAST because it mutates allTools
// ---------------------------------------------------------------------------

test('OBSIDIAN_DISABLED_TOOLS removes tool from both allTools and handlers', () => {
  // Pick two real tools to disable
  const toDisable = ['read_file', 'delete_file'];

  makeConfig(baseVault, toDisable.join(','));
  const config = loadConfig();

  assert.deepEqual(
    [...config.disabledTools].sort(),
    [...toDisable].sort(),
    'config.disabledTools must reflect env var'
  );

  const handlers = createAllHandlers(config);

  // Access via namespace object — the destructured `allTools` binding becomes
  // stale after createAllHandlers reassigns the module-level `export let`.
  const currentTools = toolsMod.allTools;

  // allTools must not contain disabled names
  for (const name of toDisable) {
    const inTools = currentTools.some(t => t.name === name);
    assert.equal(inTools, false, `"${name}" must be removed from allTools when disabled`);
  }

  // handlers must not contain disabled names
  for (const name of toDisable) {
    assert.equal(
      name in handlers,
      false,
      `"${name}" must be removed from handlers when disabled`
    );
  }

  // remaining tools should still be present
  const remaining = currentTools.filter(t => !toDisable.includes(t.name));
  assert.ok(remaining.length > 0, 'non-disabled tools must still be present');
  assert.equal(
    currentTools.length,
    SNAPSHOT.length - toDisable.length,
    `allTools should shrink by ${toDisable.length} when ${toDisable.length} tools are disabled`
  );
});

test('cleanup: remove temp vault', () => {
  if (baseVault) cleanup(baseVault);
});
