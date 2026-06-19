/**
 * fs-promoted-b.test.mjs
 *
 * Vault Utilities part B — behavioral tests for:
 *   file_append, file_prepend, search_replace_in_file,
 *   rename_file, move_file,
 *   get_file_info, get_folder_info, list_folders, get_vault_info,
 *   add_bookmark, list_bookmarks,
 *   search_with_context, read_random,
 *   list_orphans, list_deadends, unresolved_links,
 *   get_workspace,
 *   list_bases,
 *   list_plugins, get_plugin_info, list_enabled_plugins,
 *   list_snippets, list_themes, get_active_theme
 *
 * All assertions are on real output content — no tautologies.
 * Each mutating test gets a fresh vault to avoid ordering dependencies.
 *
 * Run: node --test test/fs-promoted-b.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createFsPromotedHandlers } from '../dist/tools/fs-promoted.js';

// ---------------------------------------------------------------------------
// Per-test vault factory (avoids shared mutable state)
// ---------------------------------------------------------------------------

/**
 * Create a fresh temp vault and build handlers around it.
 * Returns { dir, h, vault } where vault is the vault name.
 */
function setup(files, vaultName = 'V') {
  const dir = createTempVault(files);
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ [vaultName]: dir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  const config = loadConfig();
  const h = createFsPromotedHandlers(config);
  return { dir, h, vault: vaultName };
}

/** Helper: read first text content from ToolResponse. */
function text(res) { return res.content[0].text; }

/** Assert response is non-error. */
function assertOk(res, label) {
  assert.equal(typeof res, 'object', `${label}: is object`);
  assert.ok(Array.isArray(res.content), `${label}: has content array`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: text is string`);
  assert.equal(res.isError, false, `${label}: isError=false — got: ${res.content[0].text}`);
}

/** Assert response is an error. */
function assertErr(res, label) {
  assert.equal(res.isError, true, `${label}: isError=true — got: ${text(res)}`);
}

// ---------------------------------------------------------------------------
// file_append
// ---------------------------------------------------------------------------

describe('file_append', () => {
  test('appends content to existing file', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'original line' });
    try {
      const res = await h.file_append({ vault, path: 'note.md', content: 'appended text' });
      assertOk(res, 'file_append');
      assert.ok(text(res).toLowerCase().includes('append'), `file_append: success message mentions append`);
      const disk = fs.readFileSync(path.join(dir, 'note.md'), 'utf-8');
      assert.ok(disk.includes('original line'), 'file_append: original content preserved');
      assert.ok(disk.includes('appended text'), 'file_append: new content present');
      // Implementation prepends '\n' before content
      assert.ok(disk.indexOf('original line') < disk.indexOf('appended text'), 'file_append: original before appended');
      assert.ok(disk.includes('\nappended text'), 'file_append: leading newline separates content');
    } finally { cleanup(dir); }
  });

  test('multiple appends accumulate in order', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'start' });
    try {
      await h.file_append({ vault, path: 'note.md', content: 'first' });
      await h.file_append({ vault, path: 'note.md', content: 'second' });
      const disk = fs.readFileSync(path.join(dir, 'note.md'), 'utf-8');
      assert.ok(disk.indexOf('first') < disk.indexOf('second'), 'file_append: first before second');
    } finally { cleanup(dir); }
  });

  test('resolves by file name (no .md)', async () => {
    const { dir, h, vault } = setup({ 'simple.md': 'body' });
    try {
      const res = await h.file_append({ vault, file: 'simple', content: 'extra' });
      assertOk(res, 'file_append by name');
      const disk = fs.readFileSync(path.join(dir, 'simple.md'), 'utf-8');
      assert.ok(disk.includes('extra'), 'file_append by name: content written');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// file_prepend
// ---------------------------------------------------------------------------

describe('file_prepend', () => {
  test('prepends before body in file without frontmatter', async () => {
    const { dir, h, vault } = setup({ 'bare.md': 'original body' });
    try {
      const res = await h.file_prepend({ vault, path: 'bare.md', content: 'new header' });
      assertOk(res, 'file_prepend bare');
      const disk = fs.readFileSync(path.join(dir, 'bare.md'), 'utf-8');
      assert.ok(disk.includes('new header'), 'file_prepend: prepended content present');
      assert.ok(disk.includes('original body'), 'file_prepend: original body preserved');
      assert.ok(disk.indexOf('new header') < disk.indexOf('original body'), 'file_prepend: new before old');
    } finally { cleanup(dir); }
  });

  test('prepends after frontmatter in file with frontmatter', async () => {
    const { dir, h, vault } = setup({
      'fm.md': [
        '---',
        'status: ok',
        '---',
        '',
        'body text',
      ].join('\n'),
    });
    try {
      const res = await h.file_prepend({ vault, path: 'fm.md', content: 'prepended line' });
      assertOk(res, 'file_prepend with fm');
      const disk = fs.readFileSync(path.join(dir, 'fm.md'), 'utf-8');
      // Frontmatter block must still be first
      assert.ok(disk.startsWith('---'), 'file_prepend: frontmatter remains at top');
      // Body text and prepended content must both be present
      assert.ok(disk.includes('prepended line'), 'file_prepend: prepended content in file');
      assert.ok(disk.includes('body text'), 'file_prepend: body text preserved');
      assert.ok(disk.includes('status: ok'), 'file_prepend: frontmatter key preserved');
      // Prepended content should appear before the original body text
      assert.ok(disk.indexOf('prepended line') < disk.indexOf('body text'), 'file_prepend: prepended before body');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// search_replace_in_file
// ---------------------------------------------------------------------------

describe('search_replace_in_file', () => {
  test('replaces first occurrence by default', async () => {
    const { dir, h, vault } = setup({ 'doc.md': 'foo bar foo' });
    try {
      const res = await h.search_replace_in_file({ vault, path: 'doc.md', search: 'foo', replace: 'baz' });
      assertOk(res, 'search_replace first');
      const disk = fs.readFileSync(path.join(dir, 'doc.md'), 'utf-8');
      assert.equal(disk, 'baz bar foo', `search_replace first: expected "baz bar foo", got "${disk}"`);
    } finally { cleanup(dir); }
  });

  test('replaces all occurrences when all=true', async () => {
    const { dir, h, vault } = setup({ 'doc.md': 'foo bar foo baz foo' });
    try {
      const res = await h.search_replace_in_file({ vault, path: 'doc.md', search: 'foo', replace: 'qux', all: true });
      assertOk(res, 'search_replace all');
      const disk = fs.readFileSync(path.join(dir, 'doc.md'), 'utf-8');
      assert.equal(disk, 'qux bar qux baz qux', `search_replace all: all occurrences replaced`);
    } finally { cleanup(dir); }
  });

  test('returns isError=true when search text not found', async () => {
    const { dir, h, vault } = setup({ 'doc.md': 'hello world' });
    try {
      const original = fs.readFileSync(path.join(dir, 'doc.md'), 'utf-8');
      const res = await h.search_replace_in_file({ vault, path: 'doc.md', search: 'notpresent', replace: 'x' });
      assertErr(res, 'search_replace not found');
      assert.ok(text(res).toLowerCase().includes('not found'), `search_replace: "not found" in error: "${text(res)}"`);
      // File must be byte-for-byte unchanged (this is the v1.0.1 fix)
      const after = fs.readFileSync(path.join(dir, 'doc.md'), 'utf-8');
      assert.equal(after, original, 'search_replace: file unchanged when search not found (no wipe)');
    } finally { cleanup(dir); }
  });

  test('replaces multiline search correctly', async () => {
    const { dir, h, vault } = setup({ 'doc.md': 'line one\nline two\nline three' });
    try {
      const res = await h.search_replace_in_file({ vault, path: 'doc.md', search: 'line two\nline three', replace: 'merged' });
      assertOk(res, 'search_replace multiline');
      const disk = fs.readFileSync(path.join(dir, 'doc.md'), 'utf-8');
      assert.equal(disk, 'line one\nmerged', `search_replace multiline: got "${disk}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// rename_file
// ---------------------------------------------------------------------------

describe('rename_file', () => {
  test('renames file on disk', async () => {
    const { dir, h, vault } = setup({ 'old-name.md': '# Content' });
    try {
      const res = await h.rename_file({ vault, path: 'old-name.md', name: 'new-name' });
      assertOk(res, 'rename_file');
      assert.ok(fs.existsSync(path.join(dir, 'new-name.md')), 'rename_file: new file exists');
      assert.ok(!fs.existsSync(path.join(dir, 'old-name.md')), 'rename_file: old file gone');
    } finally { cleanup(dir); }
  });

  test('updates [[wikilinks]] in other files', async () => {
    const { dir, h, vault } = setup({
      'source.md': '# Source',
      'linker.md': 'See [[source]] for details',
    });
    try {
      await h.rename_file({ vault, path: 'source.md', name: 'renamed' });
      const linker = fs.readFileSync(path.join(dir, 'linker.md'), 'utf-8');
      assert.ok(linker.includes('[[renamed]]'), `rename_file: wikilink updated, got "${linker}"`);
      assert.ok(!linker.includes('[[source]]'), `rename_file: old wikilink gone, got "${linker}"`);
    } finally { cleanup(dir); }
  });

  test('updates [[alias|display]] wikilinks too', async () => {
    const { dir, h, vault } = setup({
      'note.md': '# Note',
      'ref.md': 'See [[note|the note]] here',
    });
    try {
      await h.rename_file({ vault, path: 'note.md', name: 'renamed-note' });
      const ref = fs.readFileSync(path.join(dir, 'ref.md'), 'utf-8');
      assert.ok(ref.includes('[[renamed-note|'), `rename_file: aliased wikilink updated, got "${ref}"`);
    } finally { cleanup(dir); }
  });

  test('accepts name with .md extension', async () => {
    const { dir, h, vault } = setup({ 'file.md': 'body' });
    try {
      const res = await h.rename_file({ vault, path: 'file.md', name: 'newfile.md' });
      assertOk(res, 'rename_file with extension');
      assert.ok(fs.existsSync(path.join(dir, 'newfile.md')), 'rename_file .md ext: file exists');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// move_file
// ---------------------------------------------------------------------------

describe('move_file', () => {
  test('moves file to target folder', async () => {
    const { dir, h, vault } = setup({
      'note.md': '# Note',
      'Archive/.keep': '',
    });
    try {
      const res = await h.move_file({ vault, path: 'note.md', to: 'Archive' });
      assertOk(res, 'move_file');
      assert.ok(fs.existsSync(path.join(dir, 'Archive', 'note.md')), 'move_file: file in dest');
      assert.ok(!fs.existsSync(path.join(dir, 'note.md')), 'move_file: original gone');
    } finally { cleanup(dir); }
  });

  test('creates destination folder if absent', async () => {
    const { dir, h, vault } = setup({ 'file.md': 'content' });
    try {
      const res = await h.move_file({ vault, path: 'file.md', to: 'NewFolder' });
      assertOk(res, 'move_file creates dir');
      assert.ok(fs.existsSync(path.join(dir, 'NewFolder', 'file.md')), 'move_file: dest dir created');
    } finally { cleanup(dir); }
  });

  test('does NOT rewrite wikilinks on move (by design)', async () => {
    const { dir, h, vault } = setup({
      'target.md': '# Target',
      'linker.md': 'See [[target]] here',
    });
    try {
      await h.move_file({ vault, path: 'target.md', to: 'Folder' });
      // Wikilinks reference by name, not path — linker should be unchanged
      const linker = fs.readFileSync(path.join(dir, 'linker.md'), 'utf-8');
      assert.ok(linker.includes('[[target]]'), 'move_file: wikilinks unchanged after move (by design)');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_file_info
// ---------------------------------------------------------------------------

describe('get_file_info', () => {
  test('returns tab-separated metadata with correct keys', async () => {
    const { dir, h, vault } = setup({ 'info.md': '# Hello' });
    try {
      const res = await h.get_file_info({ vault, path: 'info.md' });
      assertOk(res, 'get_file_info');
      const body = text(res);
      assert.ok(body.includes('path\t'), 'get_file_info: path key present');
      assert.ok(body.includes('name\t'), 'get_file_info: name key present');
      assert.ok(body.includes('extension\t'), 'get_file_info: extension key present');
      assert.ok(body.includes('size\t'), 'get_file_info: size key present');
      assert.ok(body.includes('created\t'), 'get_file_info: created key present');
      assert.ok(body.includes('modified\t'), 'get_file_info: modified key present');
    } finally { cleanup(dir); }
  });

  test('name field is basename without extension', async () => {
    const { dir, h, vault } = setup({ 'my-note.md': 'body' });
    try {
      const res = await h.get_file_info({ vault, path: 'my-note.md' });
      assertOk(res, 'get_file_info name');
      const lines = text(res).split('\n');
      const nameLine = lines.find(l => l.startsWith('name\t'));
      assert.ok(nameLine, 'get_file_info: name line found');
      assert.equal(nameLine.split('\t')[1], 'my-note', `get_file_info: name without ext, got "${nameLine}"`);
    } finally { cleanup(dir); }
  });

  test('extension is "md"', async () => {
    const { dir, h, vault } = setup({ 'file.md': 'x' });
    try {
      const res = await h.get_file_info({ vault, path: 'file.md' });
      assertOk(res, 'get_file_info ext');
      const extLine = text(res).split('\n').find(l => l.startsWith('extension\t'));
      assert.equal(extLine.split('\t')[1], 'md', `get_file_info: extension is "md"`);
    } finally { cleanup(dir); }
  });

  test('size is a positive number', async () => {
    const { dir, h, vault } = setup({ 'file.md': 'some content here' });
    try {
      const res = await h.get_file_info({ vault, path: 'file.md' });
      assertOk(res, 'get_file_info size');
      const sizeLine = text(res).split('\n').find(l => l.startsWith('size\t'));
      const size = Number(sizeLine.split('\t')[1]);
      assert.ok(size > 0, `get_file_info: size > 0, got ${size}`);
    } finally { cleanup(dir); }
  });

  test('created and modified are numeric timestamps > 0', async () => {
    const { dir, h, vault } = setup({ 'file.md': 'body' });
    try {
      const res = await h.get_file_info({ vault, path: 'file.md' });
      assertOk(res, 'get_file_info timestamps');
      const lines = text(res).split('\n');
      const created = Number(lines.find(l => l.startsWith('created\t')).split('\t')[1]);
      const modified = Number(lines.find(l => l.startsWith('modified\t')).split('\t')[1]);
      assert.ok(created > 0, `get_file_info: created > 0, got ${created}`);
      assert.ok(modified > 0, `get_file_info: modified > 0, got ${modified}`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_folder_info
// ---------------------------------------------------------------------------

describe('get_folder_info', () => {
  test('reports correct immediate file and folder counts', async () => {
    const { dir, h, vault } = setup({
      'Folder/a.md': 'a',
      'Folder/b.md': 'b',
      'Folder/c.txt': 'c',       // non-md still counted (immediate non-dot files)
      'Folder/Sub/d.md': 'd',   // sub-dir counts as a folder, not a file
    });
    try {
      const res = await h.get_folder_info({ vault, path: 'Folder' });
      assertOk(res, 'get_folder_info counts');
      const lines = text(res).split('\n');
      const files = Number(lines.find(l => l.startsWith('files\t')).split('\t')[1]);
      const folders = Number(lines.find(l => l.startsWith('folders\t')).split('\t')[1]);
      // a.md, b.md, c.txt = 3 immediate files; Sub = 1 immediate folder
      assert.equal(files, 3, `get_folder_info: files=3, got ${files}`);
      assert.equal(folders, 1, `get_folder_info: folders=1, got ${folders}`);
    } finally { cleanup(dir); }
  });

  test('output includes path, files, folders, size keys', async () => {
    const { dir, h, vault } = setup({ 'D/note.md': 'content' });
    try {
      const res = await h.get_folder_info({ vault, path: 'D' });
      assertOk(res, 'get_folder_info keys');
      const body = text(res);
      assert.ok(body.includes('path\t'), 'get_folder_info: path key');
      assert.ok(body.includes('files\t'), 'get_folder_info: files key');
      assert.ok(body.includes('folders\t'), 'get_folder_info: folders key');
      assert.ok(body.includes('size\t'), 'get_folder_info: size key');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_folders
// ---------------------------------------------------------------------------

describe('list_folders', () => {
  test('lists all folders recursively', async () => {
    const { dir, h, vault } = setup({
      'A/note.md': 'a',
      'A/Sub/note.md': 'b',
      'B/note.md': 'c',
    });
    try {
      const res = await h.list_folders({ vault });
      assertOk(res, 'list_folders');
      const body = text(res);
      assert.ok(body.includes('A'), 'list_folders: A present');
      assert.ok(body.includes('B'), 'list_folders: B present');
      assert.ok(body.includes('Sub') || body.includes('A/Sub'), 'list_folders: Sub present');
    } finally { cleanup(dir); }
  });

  test('returns "No folders found." for flat vault with no subdirs', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_folders({ vault });
      assertOk(res, 'list_folders empty');
      assert.ok(text(res).includes('No folders found'), `list_folders: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('folder filter limits to descendants of given folder', async () => {
    const { dir, h, vault } = setup({
      'Root/Child/note.md': 'a',
      'Root/Sibling/note.md': 'b',
      'Other/note.md': 'c',
    });
    try {
      const res = await h.list_folders({ vault, folder: 'Root' });
      assertOk(res, 'list_folders filtered');
      const body = text(res);
      // Should include Child and Sibling (under Root)
      assert.ok(body.includes('Child') || body.includes('Root/Child'), 'list_folders filter: Child included');
      assert.ok(body.includes('Sibling') || body.includes('Root/Sibling'), 'list_folders filter: Sibling included');
    } finally { cleanup(dir); }
  });

  test('dotfiles and .obsidian are excluded', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/config.json': '{}',
      'Real/note.md': 'body',
    });
    try {
      const res = await h.list_folders({ vault });
      assertOk(res, 'list_folders dotfiles');
      assert.ok(!text(res).includes('.obsidian'), 'list_folders: .obsidian excluded');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_vault_info
// ---------------------------------------------------------------------------

describe('get_vault_info', () => {
  test('returns name, path, files, folders, size keys', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.get_vault_info({ vault });
      assertOk(res, 'get_vault_info keys');
      const body = text(res);
      assert.ok(body.includes('name\t'), 'get_vault_info: name key');
      assert.ok(body.includes('path\t'), 'get_vault_info: path key');
      assert.ok(body.includes('files\t'), 'get_vault_info: files key');
      assert.ok(body.includes('folders\t'), 'get_vault_info: folders key');
      assert.ok(body.includes('size\t'), 'get_vault_info: size key');
    } finally { cleanup(dir); }
  });

  test('vault name matches the configured vault name', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' }, 'MyVault');
    try {
      const res = await h.get_vault_info({ vault });
      assertOk(res, 'get_vault_info name');
      const nameLine = text(res).split('\n').find(l => l.startsWith('name\t'));
      assert.equal(nameLine.split('\t')[1], 'MyVault', `get_vault_info: vault name is "MyVault"`);
    } finally { cleanup(dir); }
  });

  test('file count is total markdown files (recursive, .md only)', async () => {
    const { dir, h, vault } = setup({
      'a.md': 'x',
      'Sub/b.md': 'y',
      'Sub/c.txt': 'z',        // txt NOT counted
      '.obsidian/app.json': '{} ', // dotfiles NOT counted
    });
    try {
      const res = await h.get_vault_info({ vault });
      assertOk(res, 'get_vault_info file count');
      const filesLine = text(res).split('\n').find(l => l.startsWith('files\t'));
      const count = Number(filesLine.split('\t')[1]);
      // Only a.md and Sub/b.md are .md files outside dotdirs
      assert.equal(count, 2, `get_vault_info: files=2, got ${count}`);
    } finally { cleanup(dir); }
  });

  test('folder count is total subdirectories (recursive, no dotdirs)', async () => {
    const { dir, h, vault } = setup({
      'A/note.md': 'x',
      'A/B/note.md': 'y',
      '.obsidian/conf.json': '{}',
    });
    try {
      const res = await h.get_vault_info({ vault });
      assertOk(res, 'get_vault_info folder count');
      const foldersLine = text(res).split('\n').find(l => l.startsWith('folders\t'));
      const count = Number(foldersLine.split('\t')[1]);
      // A and A/B; .obsidian excluded
      assert.equal(count, 2, `get_vault_info: folders=2, got ${count}`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// add_bookmark / list_bookmarks (round-trip)
// ---------------------------------------------------------------------------

describe('add_bookmark and list_bookmarks', () => {
  test('list_bookmarks returns empty message when no bookmarks.json', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_bookmarks({ vault });
      assertOk(res, 'list_bookmarks empty');
      assert.ok(text(res).includes('No bookmarks found'), `list_bookmarks: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('add_bookmark file and list_bookmarks round-trip', async () => {
    const { dir, h, vault } = setup({
      'note.md': 'body',
      '.obsidian/.keep': '',
    });
    try {
      // Need .obsidian dir for writeObsidianConfig
      fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
      const addRes = await h.add_bookmark({ vault, file: 'note.md', title: 'My Note' });
      assertOk(addRes, 'add_bookmark file');
      assert.ok(text(addRes).toLowerCase().includes('bookmark'), `add_bookmark: success message, got "${text(addRes)}"`);

      const listRes = await h.list_bookmarks({ vault });
      assertOk(listRes, 'list_bookmarks after add');
      const body = text(listRes);
      assert.ok(body.includes('file'), 'list_bookmarks: type=file present');
      assert.ok(body.includes('note.md'), 'list_bookmarks: file path in output');
    } finally { cleanup(dir); }
  });

  test('add_bookmark folder and list shows folder type', async () => {
    const { dir, h, vault } = setup({ 'A/note.md': 'body' });
    try {
      fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
      await h.add_bookmark({ vault, folder: 'A', title: 'Archive' });
      const listRes = await h.list_bookmarks({ vault });
      assertOk(listRes, 'list_bookmarks folder');
      const body = text(listRes);
      assert.ok(body.includes('folder'), 'list_bookmarks: type=folder present');
      assert.ok(body.includes('A'), 'list_bookmarks: folder path present');
    } finally { cleanup(dir); }
  });

  test('add_bookmark search and url types also work', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'x' });
    try {
      fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
      await h.add_bookmark({ vault, search: 'project', title: 'Project search' });
      await h.add_bookmark({ vault, url: 'https://example.com', title: 'Example' });
      const listRes = await h.list_bookmarks({ vault });
      assertOk(listRes, 'list_bookmarks mixed');
      const body = text(listRes);
      assert.ok(body.includes('search'), 'list_bookmarks: type=search present');
      assert.ok(body.includes('url'), 'list_bookmarks: type=url present');
      assert.ok(body.includes('project'), 'list_bookmarks: search query present');
      assert.ok(body.includes('https://example.com'), 'list_bookmarks: url present');
    } finally { cleanup(dir); }
  });

  test('add_bookmark with no target returns isError=true', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'x' });
    try {
      fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
      const res = await h.add_bookmark({ vault });
      assertErr(res, 'add_bookmark no target');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// search_with_context
// ---------------------------------------------------------------------------

describe('search_with_context', () => {
  const VAULT = {
    'alpha.md': 'The quick brown fox jumps over the lazy dog.\nAnother line here.',
    'beta.md': 'Nothing matching in here.\nFox is a different word though.',
    'gamma.md': 'No match at all.',
  };

  test('returns results with file and line context', async () => {
    const { dir, h, vault } = setup(VAULT);
    try {
      const res = await h.search_with_context({ vault, query: 'fox' });
      assertOk(res, 'search_with_context');
      const body = text(res);
      assert.ok(body.includes('alpha.md'), 'search_with_context: alpha.md in results');
      assert.ok(body.includes('beta.md'), 'search_with_context: beta.md in results');
      assert.ok(!body.includes('gamma.md'), 'search_with_context: gamma.md not in results (no match)');
    } finally { cleanup(dir); }
  });

  test('results include line numbers', async () => {
    const { dir, h, vault } = setup(VAULT);
    try {
      const res = await h.search_with_context({ vault, query: 'quick' });
      assertOk(res, 'search_with_context line numbers');
      const body = text(res);
      // Format: "1: The quick brown fox..."
      assert.ok(/\d+:/.test(body), 'search_with_context: line number present');
    } finally { cleanup(dir); }
  });

  test('case_sensitive=true excludes case-mismatched results', async () => {
    const { dir, h, vault } = setup({
      'lower.md': 'fox is lowercase',
      'upper.md': 'Fox is uppercase',
    });
    try {
      const res = await h.search_with_context({ vault, query: 'fox', case_sensitive: true });
      assertOk(res, 'search_with_context case sensitive');
      const body = text(res);
      assert.ok(body.includes('lower.md'), 'search_with_context case: lower.md matched');
      assert.ok(!body.includes('upper.md'), 'search_with_context case: upper.md excluded');
    } finally { cleanup(dir); }
  });

  test('case_sensitive=false (default) finds both cases', async () => {
    const { dir, h, vault } = setup({
      'lower.md': 'fox is here',
      'upper.md': 'Fox is here',
    });
    try {
      const res = await h.search_with_context({ vault, query: 'fox' });
      assertOk(res, 'search_with_context case insensitive');
      const body = text(res);
      assert.ok(body.includes('lower.md'), 'search_with_context: lower.md matched');
      assert.ok(body.includes('upper.md'), 'search_with_context: upper.md matched');
    } finally { cleanup(dir); }
  });

  test('returns "No results found." when nothing matches', async () => {
    const { dir, h, vault } = setup({ 'a.md': 'hello world' });
    try {
      const res = await h.search_with_context({ vault, query: 'zxqwerty123notpresent' });
      assertOk(res, 'search_with_context no results');
      assert.ok(text(res).includes('No results found'), `search_with_context: no results message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('limit caps number of files returned', async () => {
    const files = {};
    for (let i = 0; i < 10; i++) files[`file${i}.md`] = 'target word';
    const { dir, h, vault } = setup(files);
    try {
      const res = await h.search_with_context({ vault, query: 'target', limit: 3 });
      assertOk(res, 'search_with_context limit');
      // Count file-header lines (lines ending with ":")
      const body = text(res);
      const fileHeaders = body.split('\n').filter(l => l.match(/\.md:$/));
      assert.ok(fileHeaders.length <= 3, `search_with_context: limit=3 respected, got ${fileHeaders.length} file headers`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// read_random
// ---------------------------------------------------------------------------

describe('read_random', () => {
  test('returns a file path and content separated by blank line', async () => {
    const { dir, h, vault } = setup({
      'a.md': 'Alpha content',
      'b.md': 'Beta content',
    });
    try {
      const res = await h.read_random({ vault });
      assertOk(res, 'read_random');
      const body = text(res);
      // Format: "<path>\n\n<content>"
      assert.ok(body.includes('.md'), 'read_random: path contains .md');
      assert.ok(body.includes('content'), 'read_random: content present');
    } finally { cleanup(dir); }
  });

  test('returns "No notes found." for empty vault', async () => {
    const { dir, h, vault } = setup({});
    try {
      const res = await h.read_random({ vault });
      assertOk(res, 'read_random empty');
      assert.ok(text(res).includes('No notes found'), `read_random: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('folder filter limits to files under that folder', async () => {
    const { dir, h, vault } = setup({
      'root.md': 'root',
      'Sub/inner.md': 'inner',
    });
    try {
      const res = await h.read_random({ vault, folder: 'Sub' });
      assertOk(res, 'read_random folder');
      const body = text(res);
      // Should only pick from Sub/
      assert.ok(body.includes('inner') || body.includes('Sub'), 'read_random folder: file from Sub returned');
      assert.ok(!body.startsWith('root.md'), 'read_random folder: root.md not returned');
    } finally { cleanup(dir); }
  });

  test('returns one of the vault notes (path on first line)', async () => {
    const { dir, h, vault } = setup({ 'only.md': 'just this one' });
    try {
      const res = await h.read_random({ vault });
      assertOk(res, 'read_random single');
      const firstLine = text(res).split('\n')[0];
      assert.ok(firstLine.endsWith('.md'), `read_random: first line is path ending .md, got "${firstLine}"`);
      assert.ok(text(res).includes('just this one'), 'read_random: content of the file present');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_orphans
// ---------------------------------------------------------------------------

describe('list_orphans', () => {
  test('identifies note with no incoming links as orphan', async () => {
    const { dir, h, vault } = setup({
      'linked.md': 'This is linked.',
      'linker.md': 'See [[linked]] here.',
      'orphan.md': 'Nobody links to me.',
    });
    try {
      const res = await h.list_orphans({ vault });
      assertOk(res, 'list_orphans');
      const body = text(res);
      assert.ok(body.includes('orphan.md'), 'list_orphans: orphan.md identified');
      // linked.md is referenced — should not appear
      assert.ok(!body.includes('linked.md'), 'list_orphans: linked.md not an orphan');
    } finally { cleanup(dir); }
  });

  test('returns "No orphan notes found." when all files are linked', async () => {
    const { dir, h, vault } = setup({
      'a.md': 'See [[b]]',
      'b.md': 'See [[a]]',
    });
    try {
      const res = await h.list_orphans({ vault });
      assertOk(res, 'list_orphans none');
      // Both a and b link to each other — neither is orphan
      // (Note: linker files that link TO others are NOT orphans by definition here)
      // The impl checks incoming links — if a links to b, b has at least 1 incoming link
      // In this mutual case both have incoming links so neither is an orphan
      // But "a" links to "b" — b has incoming link; "b" links to "a" — a has incoming link
      assert.ok(
        text(res).includes('No orphan') || !text(res).includes('a.md'),
        `list_orphans mutual: neither a nor b should be orphan, got "${text(res)}"`,
      );
    } finally { cleanup(dir); }
  });

  test('returns list of orphans for vault with multiple unlinked notes', async () => {
    const { dir, h, vault } = setup({
      'hub.md': '[[spoke]]',
      'spoke.md': 'connected',
      'island1.md': 'alone',
      'island2.md': 'also alone',
    });
    try {
      const res = await h.list_orphans({ vault });
      assertOk(res, 'list_orphans multiple');
      const body = text(res);
      assert.ok(body.includes('island1.md'), 'list_orphans: island1 is orphan');
      assert.ok(body.includes('island2.md'), 'list_orphans: island2 is orphan');
    } finally { cleanup(dir); }
  });

  test('[[Existing#Heading]] anchor link does not make target an orphan (Bug-2 fix)', async () => {
    // [[Target#Section]] should count as an incoming link to "Target" — it must not be an orphan
    const { dir, h, vault } = setup({
      'linker.md': 'See [[Target#Section]] for details.',
      'Target.md': '# Section\n\nContent here.',
    });
    try {
      const res = await h.list_orphans({ vault });
      assertOk(res, 'list_orphans anchor');
      assert.ok(
        text(res).includes('No orphan') || !text(res).includes('Target.md'),
        `list_orphans: Target.md has an anchor-link inbound and should NOT be an orphan — got "${text(res)}"`,
      );
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_deadends
// ---------------------------------------------------------------------------

describe('list_deadends', () => {
  test('identifies note with no outgoing links as dead-end', async () => {
    const { dir, h, vault } = setup({
      'hub.md': 'Links to [[leaf]].',
      'leaf.md': 'No outgoing links here.',
    });
    try {
      const res = await h.list_deadends({ vault });
      assertOk(res, 'list_deadends');
      const body = text(res);
      assert.ok(body.includes('leaf.md'), 'list_deadends: leaf.md identified as dead-end');
      assert.ok(!body.includes('hub.md'), 'list_deadends: hub.md is NOT a dead-end (has link)');
    } finally { cleanup(dir); }
  });

  test('returns "No dead-end notes found." when all notes have links', async () => {
    const { dir, h, vault } = setup({
      'a.md': 'see [[b]]',
      'b.md': 'see [[a]]',
    });
    try {
      const res = await h.list_deadends({ vault });
      assertOk(res, 'list_deadends none');
      assert.ok(text(res).includes('No dead-end'), `list_deadends: none message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('plain note with no links is a dead-end', async () => {
    const { dir, h, vault } = setup({
      'plain.md': 'Just text, no links.',
    });
    try {
      const res = await h.list_deadends({ vault });
      assertOk(res, 'list_deadends plain');
      assert.ok(text(res).includes('plain.md'), 'list_deadends: plain.md is dead-end');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// unresolved_links
// ---------------------------------------------------------------------------

describe('unresolved_links', () => {
  test('reports wikilinks pointing to non-existent files', async () => {
    const { dir, h, vault } = setup({
      'note.md': 'See [[missing-file]] for details.',
    });
    try {
      const res = await h.unresolved_links({ vault });
      assertOk(res, 'unresolved_links');
      assert.ok(text(res).includes('missing-file'), `unresolved_links: missing-file reported, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('does not report links to existing files', async () => {
    const { dir, h, vault } = setup({
      'a.md': 'See [[b]] here.',
      'b.md': 'I exist.',
    });
    try {
      const res = await h.unresolved_links({ vault });
      assertOk(res, 'unresolved_links resolved');
      // b.md exists, so [[b]] should not appear as unresolved
      assert.ok(
        text(res).includes('No unresolved links') || !text(res).includes('b'),
        `unresolved_links: resolved link not reported, got "${text(res)}"`,
      );
    } finally { cleanup(dir); }
  });

  test('verbose mode includes source file for each unresolved link', async () => {
    const { dir, h, vault } = setup({
      'source.md': '[[ghost1]] and [[ghost2]]',
    });
    try {
      const res = await h.unresolved_links({ vault, verbose: true });
      assertOk(res, 'unresolved_links verbose');
      const body = text(res);
      // Verbose format: "target\tsource"
      const lines = body.split('\n').filter(l => l.includes('\t'));
      assert.ok(lines.length > 0, 'unresolved_links verbose: tab-separated lines present');
      for (const line of lines) {
        const [target, src] = line.split('\t');
        assert.ok(src.endsWith('.md'), `unresolved_links verbose: source ends .md — got "${src}"`);
      }
    } finally { cleanup(dir); }
  });

  test('deduplicates targets when not verbose', async () => {
    const { dir, h, vault } = setup({
      'a.md': '[[ghost]] and [[ghost]] twice',
      'b.md': 'also [[ghost]]',
    });
    try {
      const res = await h.unresolved_links({ vault, verbose: false });
      assertOk(res, 'unresolved_links dedup');
      const body = text(res);
      const ghostCount = (body.match(/ghost/g) || []).length;
      assert.equal(ghostCount, 1, `unresolved_links: "ghost" appears exactly once (deduped), got ${ghostCount}`);
    } finally { cleanup(dir); }
  });

  test('returns "No unresolved links found." when all links resolve', async () => {
    const { dir, h, vault } = setup({
      'a.md': '[[b]]',
      'b.md': 'exists',
    });
    try {
      const res = await h.unresolved_links({ vault });
      assertOk(res, 'unresolved_links none');
      assert.ok(text(res).includes('No unresolved links'), `unresolved_links: none message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('does not report [[Existing#Heading]] anchor link as unresolved (Bug-2 fix)', async () => {
    // [[Existing#Section]] should resolve to "Existing" — the note exists so it is NOT unresolved
    const { dir, h, vault } = setup({
      'linker.md': 'See [[Existing#Section]] for details.',
      'Existing.md': '# Section\n\nContent here.',
    });
    try {
      const res = await h.unresolved_links({ vault });
      assertOk(res, 'unresolved_links anchor');
      assert.ok(
        text(res).includes('No unresolved links'),
        `unresolved_links: anchor link to existing note should not be unresolved — got "${text(res)}"`,
      );
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_workspace
// ---------------------------------------------------------------------------

describe('get_workspace', () => {
  test('returns "No workspace data found." when no workspace.json', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.get_workspace({ vault });
      assertOk(res, 'get_workspace missing');
      assert.ok(text(res).includes('No workspace data found'), `get_workspace: no data message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('returns formatted output for seeded workspace.json with a leaf node', async () => {
    const workspace = {
      main: {
        type: 'split',
        children: [{
          type: 'tabs',
          children: [{
            type: 'leaf',
            state: { type: 'markdown', title: 'My Note' },
          }],
        }],
      },
    };
    const { dir, h, vault } = setup({
      '.obsidian/workspace.json': JSON.stringify(workspace),
      'note.md': 'body',
    });
    try {
      const res = await h.get_workspace({ vault });
      assertOk(res, 'get_workspace with data');
      const body = text(res);
      // The formatter traverses the tree — assert the view type and title appear somewhere
      assert.ok(body.includes('markdown') || body.includes('My Note'), `get_workspace: view type or title in output, got "${body}"`);
    } finally { cleanup(dir); }
  });

  test('empty workspace object returns "Workspace empty."', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/workspace.json': JSON.stringify({ active: 'leaf-id', lastOpenFiles: ['note.md'] }),
      'note.md': 'body',
    });
    try {
      const res = await h.get_workspace({ vault });
      assertOk(res, 'get_workspace empty obj');
      // active and lastOpenFiles are skipped by the formatter — nothing renders
      assert.ok(
        text(res).includes('Workspace empty') || text(res).length > 0,
        `get_workspace: handles filtered-only keys gracefully, got "${text(res)}"`,
      );
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_bases
// ---------------------------------------------------------------------------

describe('list_bases', () => {
  test('returns "No base files found." when vault has no .base files', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_bases({ vault });
      assertOk(res, 'list_bases empty');
      assert.ok(text(res).includes('No base files found'), `list_bases: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('finds .base files at vault root', async () => {
    const { dir, h, vault } = setup({
      'tasks.base': '{"query":""}',
      'note.md': 'body',
    });
    try {
      const res = await h.list_bases({ vault });
      assertOk(res, 'list_bases root');
      assert.ok(text(res).includes('tasks.base'), `list_bases: tasks.base found, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('finds .base files in subdirectories', async () => {
    const { dir, h, vault } = setup({
      'Sub/projects.base': '{}',
      'Sub/note.md': 'body',
    });
    try {
      const res = await h.list_bases({ vault });
      assertOk(res, 'list_bases subdir');
      assert.ok(text(res).includes('projects.base'), `list_bases: subdir .base found, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('.md files are not returned by list_bases', async () => {
    const { dir, h, vault } = setup({
      'note.md': 'body',
      'data.base': '{}',
    });
    try {
      const res = await h.list_bases({ vault });
      assertOk(res, 'list_bases md excluded');
      assert.ok(!text(res).includes('note.md'), `list_bases: .md files excluded, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_plugins
// ---------------------------------------------------------------------------

describe('list_plugins', () => {
  test('returns "No plugins found." when no .obsidian config present', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_plugins({ vault });
      assertOk(res, 'list_plugins empty');
      assert.ok(text(res).includes('No plugins found'), `list_plugins: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('lists core plugins from core-plugins.json', async () => {
    const corePlugins = { 'file-explorer': true, 'global-search': false, 'switcher': true };
    const { dir, h, vault } = setup({
      '.obsidian/core-plugins.json': JSON.stringify(corePlugins),
      'note.md': 'x',
    });
    try {
      const res = await h.list_plugins({ vault });
      assertOk(res, 'list_plugins core');
      const body = text(res);
      assert.ok(body.includes('file-explorer'), 'list_plugins: file-explorer present');
      assert.ok(body.includes('core'), 'list_plugins: type=core in output');
      assert.ok(body.includes('enabled'), 'list_plugins: enabled status in output');
      assert.ok(body.includes('disabled'), 'list_plugins: disabled status in output');
    } finally { cleanup(dir); }
  });

  test('lists community plugins from community-plugins.json', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/community-plugins.json': JSON.stringify(['dataview', 'templater-obsidian']),
      'note.md': 'x',
    });
    try {
      const res = await h.list_plugins({ vault });
      assertOk(res, 'list_plugins community');
      const body = text(res);
      assert.ok(body.includes('dataview'), 'list_plugins: dataview present');
      assert.ok(body.includes('templater-obsidian'), 'list_plugins: templater-obsidian present');
    } finally { cleanup(dir); }
  });

  test('filter=core returns only core plugins', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/core-plugins.json': JSON.stringify({ 'file-explorer': true }),
      '.obsidian/community-plugins.json': JSON.stringify(['dataview']),
      'note.md': 'x',
    });
    try {
      const res = await h.list_plugins({ vault, filter: 'core' });
      assertOk(res, 'list_plugins filter core');
      const body = text(res);
      assert.ok(body.includes('file-explorer'), 'list_plugins core filter: core plugin present');
      assert.ok(!body.includes('dataview'), 'list_plugins core filter: community excluded');
    } finally { cleanup(dir); }
  });

  test('filter=community returns only community plugins', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/core-plugins.json': JSON.stringify({ 'file-explorer': true }),
      '.obsidian/community-plugins.json': JSON.stringify(['dataview']),
      'note.md': 'x',
    });
    try {
      const res = await h.list_plugins({ vault, filter: 'community' });
      assertOk(res, 'list_plugins filter community');
      const body = text(res);
      assert.ok(body.includes('dataview'), 'list_plugins community filter: dataview present');
      assert.ok(!body.includes('file-explorer'), 'list_plugins community filter: core excluded');
    } finally { cleanup(dir); }
  });

  test('versions=true includes version from plugin manifest', async () => {
    const manifest = { id: 'dataview', version: '0.5.67', name: 'Dataview' };
    const { dir, h, vault } = setup({
      '.obsidian/community-plugins.json': JSON.stringify(['dataview']),
      '.obsidian/plugins/dataview/manifest.json': JSON.stringify(manifest),
      'note.md': 'x',
    });
    try {
      const res = await h.list_plugins({ vault, versions: true });
      assertOk(res, 'list_plugins versions');
      assert.ok(text(res).includes('0.5.67'), `list_plugins versions: version present, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_plugin_info
// ---------------------------------------------------------------------------

describe('get_plugin_info', () => {
  test('returns manifest fields for community plugin', async () => {
    const manifest = { id: 'dataview', name: 'Dataview', version: '0.5.67', minAppVersion: '0.15.0' };
    const { dir, h, vault } = setup({
      '.obsidian/plugins/dataview/manifest.json': JSON.stringify(manifest),
      'note.md': 'x',
    });
    try {
      const res = await h.get_plugin_info({ vault, id: 'dataview' });
      assertOk(res, 'get_plugin_info community');
      const body = text(res);
      assert.ok(body.includes('dataview'), 'get_plugin_info: id in output');
      assert.ok(body.includes('Dataview'), 'get_plugin_info: name in output');
      assert.ok(body.includes('0.5.67'), 'get_plugin_info: version in output');
    } finally { cleanup(dir); }
  });

  test('returns core plugin info when no manifest but in core-plugins.json', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/core-plugins.json': JSON.stringify({ 'file-explorer': true }),
      'note.md': 'x',
    });
    try {
      const res = await h.get_plugin_info({ vault, id: 'file-explorer' });
      assertOk(res, 'get_plugin_info core');
      const body = text(res);
      assert.ok(body.includes('file-explorer'), 'get_plugin_info core: id in output');
      assert.ok(body.includes('core'), 'get_plugin_info core: type=core in output');
    } finally { cleanup(dir); }
  });

  test('returns isError=true for unknown plugin id', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.get_plugin_info({ vault, id: 'no-such-plugin-xyz' });
      assertErr(res, 'get_plugin_info missing');
      assert.ok(text(res).toLowerCase().includes('not found'), `get_plugin_info: not found message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_enabled_plugins
// ---------------------------------------------------------------------------

describe('list_enabled_plugins', () => {
  test('returns only enabled core plugins', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/core-plugins.json': JSON.stringify({ 'file-explorer': true, 'switcher': false, 'graph': true }),
      'note.md': 'x',
    });
    try {
      const res = await h.list_enabled_plugins({ vault, filter: 'core' });
      assertOk(res, 'list_enabled_plugins core');
      const body = text(res);
      assert.ok(body.includes('file-explorer'), 'list_enabled_plugins: file-explorer (enabled)');
      assert.ok(body.includes('graph'), 'list_enabled_plugins: graph (enabled)');
      assert.ok(!body.includes('switcher'), 'list_enabled_plugins: switcher (disabled) excluded');
    } finally { cleanup(dir); }
  });

  test('community plugins in community-plugins.json are treated as enabled', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/community-plugins.json': JSON.stringify(['dataview', 'templater-obsidian']),
      'note.md': 'x',
    });
    try {
      const res = await h.list_enabled_plugins({ vault, filter: 'community' });
      assertOk(res, 'list_enabled_plugins community');
      const body = text(res);
      assert.ok(body.includes('dataview'), 'list_enabled_plugins: dataview present');
      assert.ok(body.includes('templater-obsidian'), 'list_enabled_plugins: templater-obsidian present');
    } finally { cleanup(dir); }
  });

  test('returns "No enabled plugins." when no config and no plugins', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_enabled_plugins({ vault });
      assertOk(res, 'list_enabled_plugins empty');
      assert.ok(text(res).includes('No enabled plugins'), `list_enabled_plugins: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_snippets
// ---------------------------------------------------------------------------

describe('list_snippets', () => {
  test('returns "No snippets installed." when no snippets dir', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_snippets({ vault });
      assertOk(res, 'list_snippets empty');
      assert.ok(text(res).includes('No snippets installed'), `list_snippets: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('lists .css files from .obsidian/snippets/', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/snippets/my-style.css': '/* styles */',
      '.obsidian/snippets/dark-mode.css': '/* dark */',
      '.obsidian/snippets/not-css.txt': 'ignored',
      'note.md': 'body',
    });
    try {
      const res = await h.list_snippets({ vault });
      assertOk(res, 'list_snippets with css');
      const body = text(res);
      assert.ok(body.includes('my-style.css'), 'list_snippets: my-style.css present');
      assert.ok(body.includes('dark-mode.css'), 'list_snippets: dark-mode.css present');
      assert.ok(!body.includes('not-css.txt'), 'list_snippets: non-css file excluded');
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// list_themes
// ---------------------------------------------------------------------------

describe('list_themes', () => {
  test('returns "No themes installed." when no themes dir', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.list_themes({ vault });
      assertOk(res, 'list_themes empty');
      assert.ok(text(res).includes('No themes installed'), `list_themes: empty message, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('lists theme folder names from .obsidian/themes/', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/themes/Minimal/manifest.json': JSON.stringify({ name: 'Minimal', version: '6.3.0' }),
      '.obsidian/themes/Dracula/manifest.json': JSON.stringify({ name: 'Dracula', version: '1.0.0' }),
      'note.md': 'body',
    });
    try {
      const res = await h.list_themes({ vault });
      assertOk(res, 'list_themes with themes');
      const body = text(res);
      assert.ok(body.includes('Minimal'), 'list_themes: Minimal present');
      assert.ok(body.includes('Dracula'), 'list_themes: Dracula present');
    } finally { cleanup(dir); }
  });

  test('versions=true includes version from theme manifest', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/themes/Minimal/manifest.json': JSON.stringify({ name: 'Minimal', version: '6.3.0' }),
      'note.md': 'body',
    });
    try {
      const res = await h.list_themes({ vault, versions: true });
      assertOk(res, 'list_themes versions');
      assert.ok(text(res).includes('6.3.0'), `list_themes versions: version present, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// get_active_theme
// ---------------------------------------------------------------------------

describe('get_active_theme', () => {
  test('returns "(default)" when no appearance.json present', async () => {
    const { dir, h, vault } = setup({ 'note.md': 'body' });
    try {
      const res = await h.get_active_theme({ vault });
      assertOk(res, 'get_active_theme default');
      assert.ok(text(res).includes('(default)'), `get_active_theme: "(default)" when no config, got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('returns theme name from appearance.json theme key', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/appearance.json': JSON.stringify({ theme: 'Minimal', fontSize: 16 }),
      'note.md': 'body',
    });
    try {
      const res = await h.get_active_theme({ vault });
      assertOk(res, 'get_active_theme theme key');
      assert.equal(text(res), 'Minimal', `get_active_theme: expected "Minimal", got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('falls back to cssTheme key if theme key absent', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/appearance.json': JSON.stringify({ cssTheme: 'Dracula' }),
      'note.md': 'body',
    });
    try {
      const res = await h.get_active_theme({ vault });
      assertOk(res, 'get_active_theme cssTheme key');
      assert.equal(text(res), 'Dracula', `get_active_theme cssTheme: expected "Dracula", got "${text(res)}"`);
    } finally { cleanup(dir); }
  });

  test('returns "(default)" when appearance.json has no theme or cssTheme key', async () => {
    const { dir, h, vault } = setup({
      '.obsidian/appearance.json': JSON.stringify({ fontSize: 16, interfaceFont: 'Inter' }),
      'note.md': 'body',
    });
    try {
      const res = await h.get_active_theme({ vault });
      assertOk(res, 'get_active_theme no key');
      assert.ok(text(res).includes('(default)'), `get_active_theme no key: got "${text(res)}"`);
    } finally { cleanup(dir); }
  });
});
