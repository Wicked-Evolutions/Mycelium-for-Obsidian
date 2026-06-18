/**
 * L0 baseline tests for dist/parsers/markdown.js
 *
 * Covers:
 *   - parseMarkdownFile: YAML frontmatter extraction + content
 *   - createMarkdownFile: create a new note with frontmatter
 *   - updateFrontmatter: merge updates and persist to disk
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTempVault, cleanup } from './helpers.mjs';
import {
  parseMarkdownFile,
  createMarkdownFile,
  updateFrontmatter,
} from '../dist/parsers/markdown.js';

// ---------------------------------------------------------------------------
// parseMarkdownFile
// ---------------------------------------------------------------------------

test('parseMarkdownFile: extracts frontmatter and content', async (t) => {
  const vaultRaw = createTempVault({
    'note.md': [
      '---',
      'title: "Hello World"',
      'tags:',
      '  - alpha',
      '  - beta',
      'version: "1.0"',
      '---',
      '',
      '# Hello World',
      '',
      'Body text here.',
    ].join('\n'),
  });

  // macOS /var -> /private/var symlink: resolve vault to real path so that
  // verifyPathAfterOpen never trips the boundary guard.
  const vault = fs.realpathSync(vaultRaw);

  t.after(() => cleanup(vault));

  const parsed = await parseMarkdownFile('note.md', vault);

  // Path fields
  assert.equal(parsed.path, 'note.md');
  assert.equal(parsed.absolutePath, path.join(vault, 'note.md'));

  // Frontmatter — gray-matter preserves quoted strings as strings
  assert.equal(parsed.frontmatter.title, 'Hello World');
  assert.deepEqual(parsed.frontmatter.tags, ['alpha', 'beta']);
  assert.equal(parsed.frontmatter.version, '1.0');

  // Content is trimmed (gray-matter strips leading/trailing whitespace)
  assert.equal(parsed.content, '# Hello World\n\nBody text here.');

  // rawContent should contain the frontmatter delimiters
  assert.ok(parsed.rawContent.includes('---'));
  assert.ok(parsed.rawContent.includes('title:'));
});

test('parseMarkdownFile: note with no frontmatter', async (t) => {
  const vaultRaw = createTempVault({
    'plain.md': '# Just a heading\n\nSome content.\n',
  });
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  const parsed = await parseMarkdownFile('plain.md', vault);

  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.content, '# Just a heading\n\nSome content.');
});

test('parseMarkdownFile: rejects path traversal', async (t) => {
  const vaultRaw = createTempVault({});
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  await assert.rejects(
    () => parseMarkdownFile('../outside.md', vault),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('traversal') || err.message.includes('boundary'),
        `Expected traversal error, got: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// createMarkdownFile
// ---------------------------------------------------------------------------

test('createMarkdownFile: creates file with frontmatter object', async (t) => {
  const vaultRaw = createTempVault({});
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  const fm = { title: 'New Note', status: 'draft' };
  const result = await createMarkdownFile('new.md', vault, 'Content body.', fm);

  // Return value is a ParsedFile
  assert.equal(result.path, 'new.md');
  assert.equal(result.frontmatter.title, 'New Note');
  assert.equal(result.frontmatter.status, 'draft');
  assert.equal(result.content, 'Content body.');

  // File must actually exist on disk
  assert.ok(fs.existsSync(path.join(vault, 'new.md')));

  // Re-parse from disk to confirm round-trip correctness
  const reparsed = await parseMarkdownFile('new.md', vault);
  assert.equal(reparsed.frontmatter.title, 'New Note');
  assert.equal(reparsed.frontmatter.status, 'draft');
  assert.equal(reparsed.content, 'Content body.');
});

test('createMarkdownFile: creates file with no frontmatter', async (t) => {
  const vaultRaw = createTempVault({});
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  await createMarkdownFile('bare.md', vault, 'Just content.', {});

  const parsed = await parseMarkdownFile('bare.md', vault);
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.content, 'Just content.');
});

test('createMarkdownFile: accepts JSON string as frontmatter', async (t) => {
  const vaultRaw = createTempVault({});
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  const result = await createMarkdownFile(
    'json-fm.md',
    vault,
    'Body.',
    JSON.stringify({ title: 'JSON FM', rank: '42' })
  );

  assert.equal(result.frontmatter.title, 'JSON FM');
  assert.equal(result.frontmatter.rank, '42');
});

test('createMarkdownFile: creates nested directories', async (t) => {
  const vaultRaw = createTempVault({});
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  await createMarkdownFile('sub/folder/note.md', vault, 'Deep note.', {});

  assert.ok(fs.existsSync(path.join(vault, 'sub', 'folder', 'note.md')));
});

// ---------------------------------------------------------------------------
// updateFrontmatter
// ---------------------------------------------------------------------------

test('updateFrontmatter: merges new key and preserves existing keys', async (t) => {
  const vaultRaw = createTempVault({
    'update.md': [
      '---',
      'title: "Original"',
      'status: "draft"',
      '---',
      '',
      'Some content.',
    ].join('\n'),
  });
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  const result = await updateFrontmatter('update.md', vault, {
    status: 'published',
    author: 'Jacob',
  });

  // Returned value reflects merge
  assert.equal(result.frontmatter.title, 'Original');     // unchanged key survives
  assert.equal(result.frontmatter.status, 'published');   // updated key
  assert.equal(result.frontmatter.author, 'Jacob');       // new key added

  // Re-parse from disk: the write must have persisted
  const reparsed = await parseMarkdownFile('update.md', vault);
  assert.equal(reparsed.frontmatter.title, 'Original');
  assert.equal(reparsed.frontmatter.status, 'published');
  assert.equal(reparsed.frontmatter.author, 'Jacob');

  // Body content must not be disturbed
  assert.equal(reparsed.content, 'Some content.');
});

test('updateFrontmatter: adding frontmatter to a plain note', async (t) => {
  const vaultRaw = createTempVault({
    'no-fm.md': 'Just a plain note.\n',
  });
  const vault = fs.realpathSync(vaultRaw);
  t.after(() => cleanup(vault));

  await updateFrontmatter('no-fm.md', vault, { tag: 'added' });

  const reparsed = await parseMarkdownFile('no-fm.md', vault);
  assert.equal(reparsed.frontmatter.tag, 'added');
});
