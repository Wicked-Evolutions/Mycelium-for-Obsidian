/**
 * L0 Baseline smoke tests — handler-smoke.test.mjs
 *
 * Verifies that list_files, read_file, search_content, and query_notes
 * return non-error ToolResponses against a real temp vault.
 *
 * Run: node --test test/handler-smoke.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ---------------------------------------------------------------------------
// Fixtures — a tiny vault with two notes
// ---------------------------------------------------------------------------

const NOTE_CONTENT_SEARCHABLE = 'alpha bravo charlie';

const VAULT_FILES = {
  'Note.md': [
    '---',
    'type: note',
    'status: active',
    'tags: [smoke, test]',
    '---',
    '',
    NOTE_CONTENT_SEARCHABLE,
  ].join('\n'),
  'Sub/Another.md': [
    '---',
    'type: reference',
    '---',
    '',
    'delta echo foxtrot',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let vaultDir;
let handlers;

before(() => {
  vaultDir = createTempVault(VAULT_FILES);

  // Set env so loadConfig() picks up the vault
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
  // Ensure no tools are accidentally disabled
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  handlers = createAllHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert a ToolResponse is non-error and has text content.
 * @param {object} res
 * @param {string} label  — shown in assertion messages
 */
function assertNonError(res, label) {
  assert.equal(typeof res, 'object', `${label}: response is an object`);
  assert.ok(Array.isArray(res.content), `${label}: content is an array`);
  assert.ok(res.content.length > 0, `${label}: content is non-empty`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: content[0].text is a string`);
  assert.equal(
    res.isError,
    false,
    `${label}: isError is false — got: ${res.content[0].text}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handler smoke tests', () => {
  test('list_files returns vault root entries without error', async () => {
    const res = await handlers.list_files({ vault: 'TestVault' });
    assertNonError(res, 'list_files');

    // The response text should be parseable JSON containing at least one entry
    const data = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(data), 'list_files: result is an array');
    assert.ok(data.length > 0, 'list_files: at least one entry returned');
    // Note.md must appear at the root
    const names = data.map(e => e.name);
    assert.ok(names.includes('Note.md'), `list_files: Note.md found in [${names.join(', ')}]`);
  });

  test('read_file returns file content without error', async () => {
    const res = await handlers.read_file({ vault: 'TestVault', path: 'Note.md' });
    assertNonError(res, 'read_file');

    const data = JSON.parse(res.content[0].text);
    assert.equal(data.path, 'Note.md', 'read_file: path matches');
    assert.equal(typeof data.content, 'string', 'read_file: content is a string');
    assert.ok(data.content.includes('alpha'), 'read_file: content contains expected text');
    assert.equal(data.frontmatter.type, 'note', 'read_file: frontmatter.type is "note"');
  });

  test('search_content finds a match without error', async () => {
    const res = await handlers.search_content({
      vault: 'TestVault',
      query: 'alpha',
    });
    assertNonError(res, 'search_content');

    const data = JSON.parse(res.content[0].text);
    assert.equal(data.query, 'alpha', 'search_content: query echoed back');
    assert.ok(typeof data.resultCount === 'number', 'search_content: resultCount is a number');
    assert.ok(data.resultCount >= 1, `search_content: at least one result (got ${data.resultCount})`);
    assert.ok(Array.isArray(data.results), 'search_content: results is an array');
  });

  test('query_notes returns results without error', async () => {
    const res = await handlers.query_notes({ vault: 'TestVault' });
    assertNonError(res, 'query_notes');

    const data = JSON.parse(res.content[0].text);
    assert.ok(typeof data.totalMatches === 'number', 'query_notes: totalMatches is a number');
    assert.ok(data.totalMatches >= 2, `query_notes: found all notes (got ${data.totalMatches})`);
    assert.ok(Array.isArray(data.results), 'query_notes: results is an array');
    // Each result should have path, title, frontmatter
    for (const r of data.results) {
      assert.equal(typeof r.path, 'string', 'query_notes: result.path is a string');
      assert.equal(typeof r.frontmatter, 'object', 'query_notes: result.frontmatter is an object');
    }
  });

  test('query_notes with where filter returns only matching notes', async () => {
    const res = await handlers.query_notes({
      vault: 'TestVault',
      where: [{ field: 'type', op: 'equals', value: 'note' }],
    });
    assertNonError(res, 'query_notes with filter');

    const data = JSON.parse(res.content[0].text);
    assert.equal(data.totalMatches, 1, 'query_notes filter: exactly one match for type=note');
    assert.ok(data.results[0].path.includes('Note'), 'query_notes filter: result is Note.md');
  });
});
