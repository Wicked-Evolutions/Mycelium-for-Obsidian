/**
 * files.test.mjs — Full behavioral coverage for File Operations (src/tools/files.ts)
 *
 * Tools covered: list_files, read_file, create_file, update_file, delete_file,
 *                get_frontmatter, update_frontmatter, search_content, move_note
 *
 * Run: node --test test/files.test.mjs
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createFileHandlers } from '../dist/tools/files.js';

// ---------------------------------------------------------------------------
// Shared vault state — rebuilt once per describe block that needs it
// ---------------------------------------------------------------------------

const VAULT_NAME = 'TestVault';

/**
 * Build a Config pointing at a temp vault dir, plus the handlers.
 * @param {string} vaultDir
 */
function makeHandlers(vaultDir) {
  const saved = process.env.OBSIDIAN_VAULTS;
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ [VAULT_NAME]: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  const config = loadConfig();
  if (saved === undefined) delete process.env.OBSIDIAN_VAULTS;
  else process.env.OBSIDIAN_VAULTS = saved;
  return createFileHandlers(config);
}

/**
 * Parse the first text content item from a ToolResponse.
 * @param {object} res
 * @returns {unknown}
 */
function parse(res) {
  return JSON.parse(res.content[0].text);
}

/**
 * Assert isError is false and content is parseable.
 */
function assertOk(res, label = '') {
  assert.equal(
    res.isError,
    false,
    `${label}: expected isError=false, got: ${res.content[0]?.text}`,
  );
  assert.ok(res.content.length > 0, `${label}: content is non-empty`);
}

/**
 * Assert isError is true.
 */
function assertErr(res, label = '') {
  assert.equal(
    res.isError,
    true,
    `${label}: expected isError=true, got text: ${res.content[0]?.text}`,
  );
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

describe('list_files', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'Alpha.md': '# Alpha\nHello world',
      'Beta.md': '# Beta\nGoodbye',
      'Sub/Child.md': '# Child',
      'Sub/Grandchild/Deep.md': '# Deep',
      '.obsidian/workspace.json': '{}',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('returns root-level entries as an array', async () => {
    const res = await h.list_files({ vault: VAULT_NAME });
    assertOk(res, 'list_files root');
    const data = parse(res);
    assert.ok(Array.isArray(data), 'result is an array');
    const names = data.map(e => e.name);
    assert.ok(names.includes('Alpha.md'), 'Alpha.md present');
    assert.ok(names.includes('Beta.md'), 'Beta.md present');
    assert.ok(names.includes('Sub'), 'Sub folder present');
  });

  test('hidden files/folders are excluded', async () => {
    const res = await h.list_files({ vault: VAULT_NAME });
    const data = parse(res);
    const names = data.map(e => e.name);
    assert.ok(!names.includes('.obsidian'), '.obsidian hidden folder excluded');
  });

  test('each entry has name, path, isDirectory, size, modified fields', async () => {
    const res = await h.list_files({ vault: VAULT_NAME });
    const data = parse(res);
    const file = data.find(e => e.name === 'Alpha.md');
    assert.ok(file, 'Alpha.md entry found');
    assert.equal(typeof file.name, 'string', 'entry.name is string');
    assert.equal(typeof file.path, 'string', 'entry.path is string');
    assert.equal(typeof file.isDirectory, 'boolean', 'entry.isDirectory is boolean');
    assert.equal(typeof file.size, 'number', 'entry.size is number');
    assert.ok(file.modified !== undefined, 'entry.modified is set');
    // Files have isDirectory=false; folders have isDirectory=true
    const folder = data.find(e => e.name === 'Sub');
    assert.equal(folder.isDirectory, true, 'Sub.isDirectory is true');
    assert.equal(file.isDirectory, false, 'Alpha.md.isDirectory is false');
  });

  test('directory parameter limits listing to a subfolder', async () => {
    const res = await h.list_files({ vault: VAULT_NAME, directory: 'Sub' });
    assertOk(res, 'list_files sub');
    const data = parse(res);
    const names = data.map(e => e.name);
    assert.ok(names.includes('Child.md'), 'Child.md present in Sub');
    assert.ok(!names.includes('Alpha.md'), 'Alpha.md not present in Sub listing');
  });

  test('recursive=true includes nested files', async () => {
    const res = await h.list_files({ vault: VAULT_NAME, recursive: true });
    assertOk(res, 'list_files recursive');
    const data = parse(res);
    const names = data.map(e => e.name);
    assert.ok(names.includes('Child.md'), 'Child.md found recursively');
    assert.ok(names.includes('Deep.md'), 'Deep.md found recursively');
  });

  test('pattern filter returns only matching files', async () => {
    const res = await h.list_files({ vault: VAULT_NAME, pattern: 'A*.md', recursive: false });
    assertOk(res, 'list_files pattern');
    const data = parse(res);
    const names = data.map(e => e.name);
    assert.ok(names.includes('Alpha.md'), 'Alpha.md matches A*.md');
    assert.ok(!names.includes('Beta.md'), 'Beta.md excluded by pattern');
  });

  test('pattern filter is case-insensitive', async () => {
    const res = await h.list_files({ vault: VAULT_NAME, pattern: 'alpha.md' });
    assertOk(res, 'list_files case insensitive');
    const data = parse(res);
    const names = data.map(e => e.name);
    assert.ok(names.includes('Alpha.md'), 'Alpha.md matched case-insensitively');
  });

  test('returns isError=true for non-existent directory', async () => {
    const res = await h.list_files({ vault: VAULT_NAME, directory: 'NoSuchDir' });
    assertErr(res, 'list_files missing dir');
  });

  test('empty vault returns empty array', async () => {
    const emptyDir = createTempVault({});
    const eh = makeHandlers(emptyDir);
    try {
      const res = await eh.list_files({ vault: VAULT_NAME });
      assertOk(res, 'list_files empty vault');
      const data = parse(res);
      assert.ok(Array.isArray(data), 'result is array');
      assert.equal(data.length, 0, 'empty array for empty vault');
    } finally {
      cleanup(emptyDir);
    }
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe('read_file', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'Note.md': [
        '---',
        'title: My Note',
        'tags: [a, b]',
        'status: active',
        '---',
        '',
        '# My Note',
        '',
        'Some content here.',
      ].join('\n'),
      'NoFrontmatter.md': '# No FM\n\nJust content.',
      'Sub/Nested.md': '---\ntitle: Nested\n---\n\nNested content.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('returns path, title, frontmatter, content for a file with frontmatter', async () => {
    const res = await h.read_file({ vault: VAULT_NAME, path: 'Note.md' });
    assertOk(res, 'read_file note');
    const data = parse(res);
    assert.equal(data.path, 'Note.md', 'path matches');
    assert.equal(typeof data.content, 'string', 'content is string');
    assert.ok(data.content.includes('Some content here'), 'content contains body text');
    assert.equal(typeof data.frontmatter, 'object', 'frontmatter is object');
    assert.equal(data.frontmatter.title, 'My Note', 'frontmatter.title correct');
    assert.equal(data.frontmatter.status, 'active', 'frontmatter.status correct');
    assert.ok(Array.isArray(data.frontmatter.tags), 'frontmatter.tags is array');
    assert.equal(data.title, 'My Note', 'title extracted');
  });

  test('frontmatter is empty object when file has none', async () => {
    const res = await h.read_file({ vault: VAULT_NAME, path: 'NoFrontmatter.md' });
    assertOk(res, 'read_file no fm');
    const data = parse(res);
    assert.equal(typeof data.frontmatter, 'object', 'frontmatter is object');
    assert.equal(Object.keys(data.frontmatter).length, 0, 'frontmatter is empty');
  });

  test('reads a nested file with path containing subdirectory', async () => {
    const res = await h.read_file({ vault: VAULT_NAME, path: 'Sub/Nested.md' });
    assertOk(res, 'read_file nested');
    const data = parse(res);
    assert.equal(data.frontmatter.title, 'Nested', 'nested frontmatter title');
    assert.ok(data.content.includes('Nested content'), 'nested content');
  });

  test('returns isError=true and closest_matches for missing file', async () => {
    const res = await h.read_file({ vault: VAULT_NAME, path: 'DoesNotExist.md' });
    assertErr(res, 'read_file missing');
    const data = parse(res);
    assert.ok(typeof data.error === 'string', 'error field is string');
    assert.ok(data.error.includes('DoesNotExist'), 'error names missing file');
    assert.ok(Array.isArray(data.closest_matches), 'closest_matches is array');
  });
});

// ---------------------------------------------------------------------------
// create_file
// ---------------------------------------------------------------------------

describe('create_file', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'Existing.md': '# Existing\n\nAlready here.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('creates a new file and returns created=true with path', async () => {
    const res = await h.create_file({
      vault: VAULT_NAME,
      path: 'NewNote.md',
      content: 'Hello from test',
    });
    assertOk(res, 'create_file new');
    const data = parse(res);
    assert.equal(data.created, true, 'created=true');
    assert.equal(data.path, 'NewNote.md', 'path matches');
    // File must actually exist on disk
    assert.ok(fs.existsSync(path.join(vaultDir, 'NewNote.md')), 'file exists on disk');
  });

  test('file content is readable after creation', async () => {
    await h.create_file({
      vault: VAULT_NAME,
      path: 'ContentCheck.md',
      content: 'Unique string: xyzzy42',
    });
    const res = await h.read_file({ vault: VAULT_NAME, path: 'ContentCheck.md' });
    assertOk(res, 'create then read');
    const data = parse(res);
    assert.ok(data.content.includes('xyzzy42'), 'content round-trips');
  });

  test('creates file with frontmatter that is preserved', async () => {
    const res = await h.create_file({
      vault: VAULT_NAME,
      path: 'WithFM.md',
      content: 'Body text',
      frontmatter: { type: 'project', status: 'active', priority: 1 },
    });
    assertOk(res, 'create with frontmatter');
    const readRes = await h.read_file({ vault: VAULT_NAME, path: 'WithFM.md' });
    const data = parse(readRes);
    assert.equal(data.frontmatter.type, 'project', 'type frontmatter round-trips');
    assert.equal(data.frontmatter.status, 'active', 'status frontmatter round-trips');
    assert.equal(data.frontmatter.priority, 1, 'numeric frontmatter round-trips');
  });

  test('creates parent directories when path has subdirs', async () => {
    const res = await h.create_file({
      vault: VAULT_NAME,
      path: 'NewFolder/SubFolder/Note.md',
      content: 'Deep note',
    });
    assertOk(res, 'create nested dirs');
    assert.ok(
      fs.existsSync(path.join(vaultDir, 'NewFolder', 'SubFolder', 'Note.md')),
      'nested file exists on disk',
    );
  });

  test('returns isError=true when file already exists', async () => {
    const res = await h.create_file({
      vault: VAULT_NAME,
      path: 'Existing.md',
      content: 'Should not overwrite',
    });
    assertErr(res, 'create existing');
    assert.ok(
      res.content[0].text.includes('already exists') || res.content[0].text.includes('Existing'),
      'error mentions file existence',
    );
  });
});

// ---------------------------------------------------------------------------
// update_file
// ---------------------------------------------------------------------------

describe('update_file', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'ToUpdate.md': [
        '---',
        'title: Original',
        'status: draft',
        '---',
        '',
        'Original body.',
      ].join('\n'),
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('replaces content and returns updated=true', async () => {
    const res = await h.update_file({
      vault: VAULT_NAME,
      path: 'ToUpdate.md',
      content: 'Updated body text.',
    });
    assertOk(res, 'update_file');
    const data = parse(res);
    assert.equal(data.updated, true, 'updated=true');
    assert.equal(data.path, 'ToUpdate.md', 'path matches');
  });

  test('preserves existing frontmatter when none is provided', async () => {
    // File was already updated above; we create a fresh one
    const freshDir = createTempVault({
      'FM.md': '---\ntitle: Keep Me\nstatus: active\n---\n\nBody.',
    });
    const fh = makeHandlers(freshDir);
    try {
      await fh.update_file({ vault: VAULT_NAME, path: 'FM.md', content: 'New body only.' });
      const readRes = await fh.read_file({ vault: VAULT_NAME, path: 'FM.md' });
      const data = parse(readRes);
      assert.equal(data.frontmatter.title, 'Keep Me', 'title frontmatter preserved');
      assert.equal(data.frontmatter.status, 'active', 'status frontmatter preserved');
      assert.ok(data.content.includes('New body only'), 'content is updated');
    } finally {
      cleanup(freshDir);
    }
  });

  test('replaces frontmatter when new frontmatter is provided', async () => {
    const freshDir = createTempVault({
      'ReplFM.md': '---\ntitle: Old Title\n---\n\nBody.',
    });
    const fh = makeHandlers(freshDir);
    try {
      await fh.update_file({
        vault: VAULT_NAME,
        path: 'ReplFM.md',
        content: 'Same body.',
        frontmatter: { title: 'New Title', extra: 'yes' },
      });
      const readRes = await fh.read_file({ vault: VAULT_NAME, path: 'ReplFM.md' });
      const data = parse(readRes);
      assert.equal(data.frontmatter.title, 'New Title', 'frontmatter replaced');
      assert.equal(data.frontmatter.extra, 'yes', 'new frontmatter key present');
    } finally {
      cleanup(freshDir);
    }
  });

  test('can create a new file (not just update existing)', async () => {
    // update_file uses createMarkdownFile which creates-or-overwrites
    const res = await h.update_file({
      vault: VAULT_NAME,
      path: 'BrandNew.md',
      content: 'Created via update_file',
    });
    assertOk(res, 'update_file create');
    assert.ok(
      fs.existsSync(path.join(vaultDir, 'BrandNew.md')),
      'file created on disk via update_file',
    );
  });
});

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

describe('delete_file', () => {
  let vaultDir;
  let h;

  // Recreate the vault before each test so deletions don't bleed
  beforeEach(() => {
    if (vaultDir) cleanup(vaultDir);
    vaultDir = createTempVault({
      'ToDelete.md': '# Delete me',
      'Keeper.md': '# Keep me',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => {
    if (vaultDir) cleanup(vaultDir);
  });

  test('deletes file and returns deleted=true', async () => {
    const res = await h.delete_file({ vault: VAULT_NAME, path: 'ToDelete.md' });
    assertOk(res, 'delete_file');
    const data = parse(res);
    assert.equal(data.deleted, true, 'deleted=true');
    assert.equal(data.path, 'ToDelete.md', 'path matches');
    assert.ok(!fs.existsSync(path.join(vaultDir, 'ToDelete.md')), 'file no longer exists on disk');
  });

  test('does not affect other files', async () => {
    await h.delete_file({ vault: VAULT_NAME, path: 'ToDelete.md' });
    assert.ok(fs.existsSync(path.join(vaultDir, 'Keeper.md')), 'Keeper.md still exists');
  });

  test('returns isError=true for non-existent file', async () => {
    const res = await h.delete_file({ vault: VAULT_NAME, path: 'Ghost.md' });
    assertErr(res, 'delete_file missing');
  });

  test('deleted file cannot be read afterwards', async () => {
    await h.delete_file({ vault: VAULT_NAME, path: 'ToDelete.md' });
    const res = await h.read_file({ vault: VAULT_NAME, path: 'ToDelete.md' });
    assertErr(res, 'read after delete');
  });
});

// ---------------------------------------------------------------------------
// get_frontmatter
// ---------------------------------------------------------------------------

describe('get_frontmatter', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'Rich.md': [
        '---',
        'title: Rich Note',
        'tags: [alpha, beta]',
        'priority: 3',
        'done: false',
        '---',
        '',
        '# Rich Note',
        '',
        'Body content is here.',
      ].join('\n'),
      'Empty.md': '# No frontmatter\n\nJust a body.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('returns path and frontmatter without full content', async () => {
    const res = await h.get_frontmatter({ vault: VAULT_NAME, path: 'Rich.md' });
    assertOk(res, 'get_frontmatter rich');
    const data = parse(res);
    assert.equal(data.path, 'Rich.md', 'path matches');
    assert.ok(data.frontmatter !== undefined, 'frontmatter key present');
    // Should NOT include a top-level "content" key (it's frontmatter-only)
    assert.ok(data.content === undefined, 'content key absent from get_frontmatter response');
  });

  test('frontmatter fields have correct types', async () => {
    const res = await h.get_frontmatter({ vault: VAULT_NAME, path: 'Rich.md' });
    const data = parse(res);
    assert.equal(data.frontmatter.title, 'Rich Note', 'title string');
    assert.ok(Array.isArray(data.frontmatter.tags), 'tags is array');
    assert.equal(data.frontmatter.tags[0], 'alpha', 'first tag is alpha');
    assert.equal(data.frontmatter.priority, 3, 'priority is number 3');
    assert.equal(data.frontmatter.done, false, 'done is boolean false');
  });

  test('returns empty frontmatter object for file with no frontmatter', async () => {
    const res = await h.get_frontmatter({ vault: VAULT_NAME, path: 'Empty.md' });
    assertOk(res, 'get_frontmatter empty');
    const data = parse(res);
    assert.equal(typeof data.frontmatter, 'object', 'frontmatter is object');
    assert.equal(Object.keys(data.frontmatter).length, 0, 'frontmatter is empty');
  });

  test('returns isError=true for missing file', async () => {
    const res = await h.get_frontmatter({ vault: VAULT_NAME, path: 'NoSuchFile.md' });
    assertErr(res, 'get_frontmatter missing');
  });
});

// ---------------------------------------------------------------------------
// update_frontmatter
// ---------------------------------------------------------------------------

describe('update_frontmatter', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'FM.md': [
        '---',
        'title: Original',
        'status: draft',
        'count: 1',
        '---',
        '',
        'Body stays intact.',
      ].join('\n'),
      'NoFM.md': '# No FM\n\nSome content.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('merges new fields with existing frontmatter', async () => {
    const res = await h.update_frontmatter({
      vault: VAULT_NAME,
      path: 'FM.md',
      updates: { newField: 'added', status: 'published' },
    });
    assertOk(res, 'update_frontmatter merge');
    const data = parse(res);
    assert.equal(data.updated, true, 'updated=true');
    // Confirm via get_frontmatter
    const fm = parse(await h.get_frontmatter({ vault: VAULT_NAME, path: 'FM.md' }));
    assert.equal(fm.frontmatter.title, 'Original', 'existing title preserved');
    assert.equal(fm.frontmatter.status, 'published', 'status overwritten');
    assert.equal(fm.frontmatter.newField, 'added', 'new field added');
    assert.equal(fm.frontmatter.count, 1, 'count unchanged');
  });

  test('body content is preserved after frontmatter update', async () => {
    await h.update_frontmatter({
      vault: VAULT_NAME,
      path: 'FM.md',
      updates: { extra: 'x' },
    });
    const readRes = await h.read_file({ vault: VAULT_NAME, path: 'FM.md' });
    const data = parse(readRes);
    assert.ok(data.content.includes('Body stays intact'), 'body content preserved');
  });

  test('response includes updated frontmatter object', async () => {
    const res = await h.update_frontmatter({
      vault: VAULT_NAME,
      path: 'FM.md',
      updates: { marker: 'present' },
    });
    assertOk(res, 'update_frontmatter response shape');
    const data = parse(res);
    assert.ok(typeof data.frontmatter === 'object', 'frontmatter in response');
    assert.equal(data.frontmatter.marker, 'present', 'marker present in response');
  });

  test('adds frontmatter to a file that had none', async () => {
    const freshDir = createTempVault({
      'AddFM.md': '# No FM\n\nContent.',
    });
    const fh = makeHandlers(freshDir);
    try {
      const res = await fh.update_frontmatter({
        vault: VAULT_NAME,
        path: 'AddFM.md',
        updates: { injected: true },
      });
      assertOk(res, 'update_frontmatter add to no-fm');
      const fm = parse(await fh.get_frontmatter({ vault: VAULT_NAME, path: 'AddFM.md' }));
      assert.equal(fm.frontmatter.injected, true, 'injected field present');
    } finally {
      cleanup(freshDir);
    }
  });
});

// ---------------------------------------------------------------------------
// search_content
// ---------------------------------------------------------------------------

describe('search_content', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({
      'Alpha.md': '# Alpha\n\nThe quick brown fox jumps.',
      'Beta.md': '# Beta\n\nThe quick Brown fox runs.',
      'Sub/Gamma.md': '# Gamma\n\nNothing here matches.',
      'Sub/Delta.md': '# Delta\n\nAnother mention of fox.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('returns resultCount and results array for a matching query', async () => {
    const res = await h.search_content({ vault: VAULT_NAME, query: 'fox' });
    assertOk(res, 'search_content basic');
    const data = parse(res);
    assert.equal(typeof data.resultCount, 'number', 'resultCount is number');
    assert.ok(data.resultCount >= 3, `resultCount >= 3 (got ${data.resultCount})`);
    assert.ok(Array.isArray(data.results), 'results is array');
    assert.equal(data.query, 'fox', 'query echoed back');
  });

  test('each result has path and matches array with lineNumber and lineContent', async () => {
    const res = await h.search_content({ vault: VAULT_NAME, query: 'fox' });
    const data = parse(res);
    for (const r of data.results) {
      assert.equal(typeof r.path, 'string', 'result.path is string');
      assert.ok(Array.isArray(r.matches), 'result.matches is array');
      for (const m of r.matches) {
        assert.equal(typeof m.lineNumber, 'number', 'match.lineNumber is number');
        assert.ok(m.lineNumber >= 1, 'lineNumber >= 1');
        assert.equal(typeof m.lineContent, 'string', 'match.lineContent is string');
        assert.equal(typeof m.matchStart, 'number', 'match.matchStart is number');
        assert.equal(typeof m.matchEnd, 'number', 'match.matchEnd is number');
      }
    }
  });

  test('case-insensitive search finds both "Brown" and "brown"', async () => {
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: 'brown',
      caseSensitive: false,
    });
    const data = parse(res);
    assert.ok(data.resultCount >= 2, `case-insensitive finds >=2 results (got ${data.resultCount})`);
  });

  test('caseSensitive=true distinguishes case', async () => {
    const resCase = await h.search_content({
      vault: VAULT_NAME,
      query: 'Brown',
      caseSensitive: true,
    });
    assertOk(resCase, 'search caseSensitive');
    const dataCase = parse(resCase);
    // "Brown" with capital B appears only in Beta.md; Alpha.md has lowercase "brown"
    assert.equal(dataCase.resultCount, 1, 'case-sensitive "Brown" matches exactly 1 file');
    assert.ok(
      dataCase.results.some(r => r.path.includes('Beta')),
      'caseSensitive: Beta.md (capital Brown) is found',
    );
    assert.ok(
      !dataCase.results.some(r => r.path.includes('Alpha')),
      'caseSensitive: Alpha.md (lowercase brown) is excluded',
    );
  });

  test('directory parameter scopes search to subdirectory', async () => {
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: 'fox',
      directory: 'Sub',
    });
    assertOk(res, 'search_content directory');
    const data = parse(res);
    for (const r of data.results) {
      assert.ok(r.path.startsWith('Sub'), `path "${r.path}" is under Sub/`);
    }
  });

  test('query with no matches returns resultCount=0 and empty results', async () => {
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: 'zzznomatchzzz',
    });
    assertOk(res, 'search_content no match');
    const data = parse(res);
    assert.equal(data.resultCount, 0, 'resultCount=0 for no-match');
    assert.equal(data.results.length, 0, 'results array is empty');
  });

  test('maxResults caps the number of returned files', async () => {
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: 'fox',
      maxResults: 1,
    });
    assertOk(res, 'search_content maxResults');
    const data = parse(res);
    assert.ok(data.results.length <= 1, 'results capped at maxResults=1');
  });

  test('regex pattern search works', async () => {
    // Matches "quick" followed by " brown" or " Brown"
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: 'quick [Bb]rown',
    });
    assertOk(res, 'search_content regex');
    const data = parse(res);
    assert.ok(data.resultCount >= 2, `regex matches >= 2 files (got ${data.resultCount})`);
  });

  test('returns isError=true for invalid regex pattern', async () => {
    const res = await h.search_content({
      vault: VAULT_NAME,
      query: '[invalid(', // unmatched bracket + paren — invalid regex
    });
    assertErr(res, 'search_content invalid regex');
  });
});

// ---------------------------------------------------------------------------
// move_note
// ---------------------------------------------------------------------------

describe('move_note', () => {
  let vaultDir;
  let h;

  beforeEach(() => {
    if (vaultDir) cleanup(vaultDir);
    vaultDir = createTempVault({
      'OldName.md': '# Old\n\nContent.',
      'Linker.md': '# Linker\n\nSee [[OldName]] and [[OldName|alias]].',
      'Sub/Deep.md': '# Deep\n\nAlso links [[OldName]].',
      'Unrelated.md': '# Unrelated\n\nNo links here.',
    });
    h = makeHandlers(vaultDir);
  });

  after(() => {
    if (vaultDir) cleanup(vaultDir);
  });

  test('moves file and returns moved=true, from, to', async () => {
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    assertOk(res, 'move_note');
    const data = parse(res);
    assert.equal(data.moved, true, 'moved=true');
    assert.equal(data.from, 'OldName.md', 'from path');
    assert.equal(data.to, 'NewName.md', 'to path');
  });

  test('source file no longer exists after move', async () => {
    await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    assert.ok(
      !fs.existsSync(path.join(vaultDir, 'OldName.md')),
      'OldName.md removed from disk',
    );
  });

  test('destination file exists after move', async () => {
    await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    assert.ok(
      fs.existsSync(path.join(vaultDir, 'NewName.md')),
      'NewName.md exists on disk',
    );
  });

  test('destination is readable and has original content', async () => {
    await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    const res = await h.read_file({ vault: VAULT_NAME, path: 'NewName.md' });
    assertOk(res, 'read moved file');
    const data = parse(res);
    assert.ok(data.content.includes('Content'), 'original content preserved');
  });

  test('wikilinks in other notes are updated to new name', async () => {
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    const data = parse(res);
    assert.equal(typeof data.wikilinksUpdated, 'number', 'wikilinksUpdated is number');
    assert.ok(data.wikilinksUpdated >= 2, `>= 2 files had wikilinks updated (got ${data.wikilinksUpdated})`);

    // Linker.md should now contain [[NewName]]
    const linkerText = fs.readFileSync(path.join(vaultDir, 'Linker.md'), 'utf8');
    assert.ok(linkerText.includes('[[NewName]]'), 'bare wikilink updated');
    assert.ok(linkerText.includes('[[NewName|alias]]'), 'aliased wikilink updated');
    assert.ok(!linkerText.includes('[[OldName]]'), 'old bare wikilink removed');
  });

  test('wikilinks in subdirectory notes are also updated', async () => {
    await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    const deepText = fs.readFileSync(path.join(vaultDir, 'Sub', 'Deep.md'), 'utf8');
    assert.ok(deepText.includes('[[NewName]]'), 'Sub/Deep.md wikilink updated');
  });

  test('unrelated files are unchanged', async () => {
    const originalUnrelated = fs.readFileSync(path.join(vaultDir, 'Unrelated.md'), 'utf8');
    await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewName.md',
    });
    const afterUnrelated = fs.readFileSync(path.join(vaultDir, 'Unrelated.md'), 'utf8');
    assert.equal(afterUnrelated, originalUnrelated, 'Unrelated.md content unchanged');
  });

  test('move to a subdirectory creates the target directory', async () => {
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'NewFolder/OldName.md',
    });
    assertOk(res, 'move to new subdir');
    assert.ok(
      fs.existsSync(path.join(vaultDir, 'NewFolder', 'OldName.md')),
      'file exists in new subdirectory',
    );
  });

  test('same-name move (only path changes, not basename) skips wikilink update but succeeds', async () => {
    // Move to a subfolder keeping the same basename — wikilinks reference by name, not path,
    // so they are NOT rewritten (oldName === newName)
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'Sub/OldName.md',
    });
    assertOk(res, 'move same basename');
    const data = parse(res);
    assert.equal(data.moved, true, 'moved=true');
    // wikilinksUpdated should be 0 since name didn't change
    assert.equal(data.wikilinksUpdated, 0, 'no wikilinks updated for same-basename move');
  });

  test('returns isError=true when source does not exist', async () => {
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'NoSuchFile.md',
      to_path: 'Dest.md',
    });
    assertErr(res, 'move_note missing source');
    assert.ok(
      res.content[0].text.includes('NoSuchFile') || res.content[0].text.includes('not found'),
      'error text names missing file',
    );
  });

  test('returns isError=true when destination already exists', async () => {
    const res = await h.move_note({
      vault: VAULT_NAME,
      from_path: 'OldName.md',
      to_path: 'Linker.md', // Linker.md already exists
    });
    assertErr(res, 'move_note dest exists');
    assert.ok(
      res.content[0].text.includes('Linker') || res.content[0].text.includes('already exists'),
      'error text mentions destination',
    );
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: create → read → update → search → move → delete
// ---------------------------------------------------------------------------

describe('full round-trip', () => {
  let vaultDir;
  let h;

  before(() => {
    vaultDir = createTempVault({});
    h = makeHandlers(vaultDir);
  });

  after(() => cleanup(vaultDir));

  test('create → read → update → search → move → delete', async () => {
    // 1. Create
    const created = await h.create_file({
      vault: VAULT_NAME,
      path: 'RoundTrip.md',
      content: 'Initial content: sentinel_value_rt',
      frontmatter: { phase: 'created', version: 1 },
    });
    assertOk(created, 'round-trip: create');

    // 2. Read back
    const read1 = parse(await h.read_file({ vault: VAULT_NAME, path: 'RoundTrip.md' }));
    assert.ok(read1.content.includes('sentinel_value_rt'), 'round-trip: content after create');
    assert.equal(read1.frontmatter.phase, 'created', 'round-trip: frontmatter.phase after create');

    // 3. Update file content
    await h.update_file({
      vault: VAULT_NAME,
      path: 'RoundTrip.md',
      content: 'Updated content: sentinel_value_rt_v2',
    });
    const read2 = parse(await h.read_file({ vault: VAULT_NAME, path: 'RoundTrip.md' }));
    assert.ok(read2.content.includes('sentinel_value_rt_v2'), 'round-trip: content after update');
    // Frontmatter preserved
    assert.equal(read2.frontmatter.phase, 'created', 'round-trip: frontmatter preserved after update');

    // 4. Update frontmatter
    await h.update_frontmatter({
      vault: VAULT_NAME,
      path: 'RoundTrip.md',
      updates: { phase: 'updated', version: 2 },
    });
    const fm = parse(await h.get_frontmatter({ vault: VAULT_NAME, path: 'RoundTrip.md' }));
    assert.equal(fm.frontmatter.phase, 'updated', 'round-trip: phase after fm update');
    assert.equal(fm.frontmatter.version, 2, 'round-trip: version after fm update');

    // 5. Search for content
    const searchRes = parse(
      await h.search_content({ vault: VAULT_NAME, query: 'sentinel_value_rt_v2' }),
    );
    assert.ok(searchRes.resultCount >= 1, 'round-trip: search finds updated content');
    assert.ok(
      searchRes.results.some(r => r.path.includes('RoundTrip')),
      'round-trip: RoundTrip.md found in search',
    );

    // 6. Move to new path
    await h.create_file({
      vault: VAULT_NAME,
      path: 'Referencing.md',
      content: '[[RoundTrip]] is mentioned here.',
    });
    const moved = parse(
      await h.move_note({
        vault: VAULT_NAME,
        from_path: 'RoundTrip.md',
        to_path: 'Archive/RoundTrip.md',
      }),
    );
    assert.equal(moved.moved, true, 'round-trip: moved');
    // Wikilinks in Referencing.md unchanged (same basename)
    assert.equal(moved.wikilinksUpdated, 0, 'round-trip: same basename, no wikilink changes');

    // 7. Delete
    const del = parse(
      await h.delete_file({ vault: VAULT_NAME, path: 'Archive/RoundTrip.md' }),
    );
    assert.equal(del.deleted, true, 'round-trip: deleted');
    assert.ok(
      !fs.existsSync(path.join(vaultDir, 'Archive', 'RoundTrip.md')),
      'round-trip: file gone from disk',
    );
  });
});
