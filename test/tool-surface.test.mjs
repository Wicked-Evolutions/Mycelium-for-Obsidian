/**
 * L0 baseline: tool surface contract tests
 *
 * Verifies that:
 *  - allTools is non-empty and every entry has the required shape
 *  - every tool name maps to a handler in createAllHandlers(loadConfig())
 *  - OBSIDIAN_DISABLED_TOOLS removes a named tool from BOTH allTools and handlers
 *  - the {name, description} snapshot matches the built dist/ exactly
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
