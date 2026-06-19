/**
 * sections-query.test.mjs — v1.3.0 test-completeness pass
 *
 * Coverage:
 *   append_to_section   — targeted append, sibling preservation, H1 title untouched,
 *                         nested subsection boundary, not-found error
 *   prepend_to_section  — targeted prepend, previous content pushed down, H1 untouched,
 *                         heading match with level prefix, not-found error
 *   update_section      — targeted replace, heading preserved, siblings untouched,
 *                         H1 stays, not-found error
 *   query_notes         — contains (scalar + array), exists / not_exists,
 *                         from (directory filter), sort_by asc/desc,
 *                         limit (returned vs totalMatches), multi-condition AND
 *
 * Run: node --test test/sections-query.test.mjs
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ---------------------------------------------------------------------------
// Shared vault for query_notes (read-only — never mutated)
// ---------------------------------------------------------------------------

const QUERY_VAULT_FILES = {
  'Projects/Alpha.md': [
    '---',
    'title: Alpha',
    'status: active',
    'priority: 2',
    'tags: [work, urgent]',
    '---',
    '',
    '# Alpha',
  ].join('\n'),

  'Projects/Beta.md': [
    '---',
    'title: Beta',
    'status: done',
    'priority: 10',
    'tags: [personal]',
    '---',
    '',
    '# Beta',
  ].join('\n'),

  'Projects/Gamma.md': [
    '---',
    'title: Gamma',
    'status: active',
    'priority: 1',
    'tags: [work]',
    '---',
    '',
    '# Gamma',
  ].join('\n'),

  // Note with no frontmatter — used for not_exists
  'Notes/Bare.md': '# Just a title\n\nNo frontmatter here.\n',

  // Note in root
  'Root.md': [
    '---',
    'title: Root',
    'status: archive',
    'priority: 5',
    '---',
    '',
    '# Root',
  ].join('\n'),
};

let queryVaultDir;
let queryHandlers;

// ---------------------------------------------------------------------------
// Template file text reused in section tests
// ---------------------------------------------------------------------------

/**
 * A note with H1, H2 sections, and a nested H3 inside one H2.
 */
function makeSectionNote() {
  return [
    '# Title',
    '',
    '## Intro',
    '',
    'Intro content.',
    '',
    '## Log',
    '',
    'First entry.',
    '',
    '### Sub',
    '',
    'Sub content.',
    '',
    '## Footer',
    '',
    'Footer content.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert a ToolResponse is non-error with text content.
 */
function assertNonError(res, label = '') {
  assert.equal(typeof res, 'object', `${label}: response is object`);
  assert.ok(Array.isArray(res.content), `${label}: content is array`);
  assert.ok(res.content.length > 0, `${label}: content non-empty`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: content[0].text is string`);
  assert.equal(res.isError, false, `${label}: isError false — got: ${res.content[0].text}`);
}

/**
 * Assert a ToolResponse carries an error.
 */
function assertIsError(res, label = '') {
  assert.equal(typeof res, 'object', `${label}: response is object`);
  assert.ok(Array.isArray(res.content), `${label}: content is array`);
  assert.equal(res.isError, true, `${label}: isError true`);
}

/**
 * Read a file from a vault dir synchronously.
 */
function readVaultFile(vaultDir, relPath) {
  return fs.readFileSync(path.join(vaultDir, relPath), 'utf8');
}

/**
 * Build a fresh Config + handlers for a single-vault at vaultDir.
 */
function makeHandlers(vaultDir) {
  const savedVaults = process.env.OBSIDIAN_VAULTS;
  const savedDisabled = process.env.OBSIDIAN_DISABLED_TOOLS;

  process.env.OBSIDIAN_VAULTS = JSON.stringify({ V: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  const handlers = createAllHandlers(config);

  // Restore env
  if (savedVaults === undefined) delete process.env.OBSIDIAN_VAULTS;
  else process.env.OBSIDIAN_VAULTS = savedVaults;
  if (savedDisabled === undefined) delete process.env.OBSIDIAN_DISABLED_TOOLS;
  else process.env.OBSIDIAN_DISABLED_TOOLS = savedDisabled;

  return handlers;
}

// ============================================================================
// Section tests — each test creates its own isolated vault
// ============================================================================

describe('append_to_section', () => {

  test('appended content lands inside the target section, before next sibling', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'Second entry.',
      });

      assertNonError(res, 'append_to_section');

      const text = readVaultFile(vaultDir, 'note.md');
      const posLog = text.indexOf('## Log');
      const posNew = text.indexOf('Second entry.');
      const posFooter = text.indexOf('## Footer');

      assert.ok(posLog !== -1, 'Log heading still present');
      assert.ok(posNew !== -1, 'appended content present');
      assert.ok(posFooter !== -1, 'Footer heading still present');

      // Appended content is between Log and Footer
      assert.ok(posNew > posLog, 'new content is after ## Log');
      assert.ok(posNew < posFooter, 'new content is before ## Footer');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('appended content does not clobber sibling section content', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'New log line.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      // Footer content must still be intact
      assert.ok(text.includes('Footer content.'), 'Footer section content preserved');
      // Intro content must still be intact
      assert.ok(text.includes('Intro content.'), 'Intro section content preserved');
      // Original Log content must still be present
      assert.ok(text.includes('First entry.'), 'original Log content preserved');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('H1 title line is unchanged after append to an H2', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Intro',
        content: 'Extra intro text.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      // The first line must still be the H1
      const firstLine = text.split('\n')[0];
      assert.equal(firstLine, '# Title', 'H1 title line is unchanged');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('append to H2 that contains nested H3 — content goes after the H3 (boundary includes subheadings)', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'After sub.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      const posSub = text.indexOf('### Sub');
      const posSubContent = text.indexOf('Sub content.');
      const posAfterSub = text.indexOf('After sub.');
      const posFooter = text.indexOf('## Footer');

      assert.ok(posSub !== -1, '### Sub heading preserved');
      assert.ok(posSubContent !== -1, 'Sub content preserved');
      // Appended content is after the H3's content (the H2 boundary captures H3)
      assert.ok(posAfterSub > posSubContent, 'appended content is after the nested H3 content');
      assert.ok(posAfterSub < posFooter, 'appended content is before ## Footer');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('not-found heading returns isError:true with descriptive message', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: 'Nonexistent Section',
        content: 'This should fail.',
      });

      assertIsError(res, 'append nonexistent section');
      assert.ok(
        res.content[0].text.includes('Nonexistent Section'),
        'error message names the missing section',
      );
    } finally {
      cleanup(vaultDir);
    }
  });

  test('response JSON reports operation as "append"', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.append_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'check.',
      });

      assertNonError(res, 'append operation field');
      const data = JSON.parse(res.content[0].text);
      assert.equal(data.operation, 'append', 'operation field is "append"');
      assert.equal(data.success, true, 'success is true');
    } finally {
      cleanup(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------

describe('prepend_to_section', () => {

  test('prepended content lands immediately after heading, before existing content', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'Newest entry.',
      });

      assertNonError(res, 'prepend_to_section');

      const text = readVaultFile(vaultDir, 'note.md');
      const posLog = text.indexOf('## Log');
      const posNew = text.indexOf('Newest entry.');
      const posOld = text.indexOf('First entry.');

      assert.ok(posLog !== -1, '## Log still present');
      assert.ok(posNew !== -1, 'prepended content present');
      assert.ok(posOld !== -1, 'old content still present');

      // New content comes before old content
      assert.ok(posNew > posLog, 'new content is after heading');
      assert.ok(posNew < posOld, 'new content is before original entry');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('prepend does not clobber sibling sections', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Intro',
        content: 'New intro para.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      assert.ok(text.includes('Footer content.'), 'Footer content preserved');
      assert.ok(text.includes('First entry.'), 'Log content preserved');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('H1 title line is unchanged after prepend to H2', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Intro',
        content: 'prepend test',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      const firstLine = text.split('\n')[0];
      assert.equal(firstLine, '# Title', 'H1 title line is unchanged');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('heading match with level prefix ("## Log") finds correct section', async () => {
    // Both "## Intro" and "## Log" exist — make sure level-prefixed heading picks the right one
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'TOP',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      const posIntro = text.indexOf('## Intro');
      const posLog = text.indexOf('## Log');
      const posTop = text.indexOf('TOP');

      // TOP must be between ## Log and ## Footer (not polluting Intro)
      assert.ok(posTop > posLog, 'prepended into Log, not Intro');
      assert.ok(text.indexOf('Intro content.') > posIntro, 'Intro section content intact');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('not-found heading returns isError:true', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## DoesNotExist',
        content: 'ignored',
      });

      assertIsError(res, 'prepend nonexistent');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('response JSON reports operation as "prepend"', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.prepend_to_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Footer',
        content: 'top of footer',
      });

      assertNonError(res, 'prepend operation field');
      const data = JSON.parse(res.content[0].text);
      assert.equal(data.operation, 'prepend', 'operation field is "prepend"');
    } finally {
      cleanup(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------

describe('update_section', () => {

  test('replaced content appears in the section, old content is gone', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'Brand new log.',
      });

      assertNonError(res, 'update_section');

      const text = readVaultFile(vaultDir, 'note.md');
      assert.ok(text.includes('Brand new log.'), 'new content is in file');
      // Original content should be gone
      assert.ok(!text.includes('First entry.'), 'old section content removed');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('heading line is preserved after replace', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'Replaced.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      assert.ok(text.includes('## Log'), '## Log heading preserved');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('sibling sections are untouched after replace', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Log',
        content: 'Replaced log.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      assert.ok(text.includes('Intro content.'), 'Intro content untouched');
      assert.ok(text.includes('Footer content.'), 'Footer content untouched');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('H1 title is unchanged after replace of an H2 section', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Intro',
        content: 'New intro.',
      });

      const text = readVaultFile(vaultDir, 'note.md');
      const firstLine = text.split('\n')[0];
      assert.equal(firstLine, '# Title', 'H1 title unchanged');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('bare heading text (no level prefix) matches section and replaces', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      // Pass just "Footer" without the ## prefix
      const res = await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: 'Footer',
        content: 'Bare match content.',
      });

      assertNonError(res, 'bare heading match');

      const text = readVaultFile(vaultDir, 'note.md');
      assert.ok(text.includes('Bare match content.'), 'bare-heading match replaced content');
      assert.ok(!text.includes('Footer content.'), 'old footer content removed');
    } finally {
      cleanup(vaultDir);
    }
  });

  test('not-found heading returns isError:true with section name in message', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Missing',
        content: 'irrelevant',
      });

      assertIsError(res, 'update nonexistent');
      assert.ok(
        res.content[0].text.includes('Missing'),
        'error message references the missing heading',
      );
    } finally {
      cleanup(vaultDir);
    }
  });

  test('response JSON reports operation as "replace"', async () => {
    const vaultDir = createTempVault({ 'note.md': makeSectionNote() });
    try {
      const handlers = makeHandlers(vaultDir);
      const res = await handlers.update_section({
        vault: 'V',
        path: 'note.md',
        heading: '## Footer',
        content: 'final.',
      });

      assertNonError(res, 'update operation field');
      const data = JSON.parse(res.content[0].text);
      assert.equal(data.operation, 'replace', 'operation field is "replace"');
      assert.equal(data.success, true, 'success is true');
    } finally {
      cleanup(vaultDir);
    }
  });
});

// ============================================================================
// query_notes tests — shared read-only vault
// ============================================================================

describe('query_notes', () => {

  before(() => {
    queryVaultDir = createTempVault(QUERY_VAULT_FILES);
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ QV: queryVaultDir });
    delete process.env.OBSIDIAN_DISABLED_TOOLS;
    const config = loadConfig();
    queryHandlers = createAllHandlers(config);
  });

  after(() => {
    delete process.env.OBSIDIAN_VAULTS;
    if (queryVaultDir) cleanup(queryVaultDir);
  });

  // ─── contains ────────────────────────────────────────────────────────────

  test('contains on a scalar string field matches substring (case-insensitive)', async () => {
    // status: "active" — "ctiv" is a substring
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      where: [{ field: 'status', op: 'contains', value: 'ctiv' }],
    });

    assertNonError(res, 'contains scalar');
    const data = JSON.parse(res.content[0].text);
    // Alpha and Gamma are both "active"
    assert.ok(data.totalMatches >= 2, `contains scalar: expected >=2, got ${data.totalMatches}`);
    for (const r of data.results) {
      assert.ok(
        String(r.frontmatter.status || '').toLowerCase().includes('ctiv'),
        `contains scalar: result status should contain "ctiv" — got ${r.frontmatter.status}`,
      );
    }
  });

  test('contains on a tags array matches any element by substring', async () => {
    // Alpha has tags: [work, urgent] — "urg" matches "urgent"
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      where: [{ field: 'tags', op: 'contains', value: 'urg' }],
    });

    assertNonError(res, 'contains array');
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.totalMatches, 1, 'only Alpha has a tag containing "urg"');
    assert.ok(
      data.results[0].path.includes('Alpha'),
      `expected Alpha, got ${data.results[0].path}`,
    );
  });

  // ─── exists / not_exists ─────────────────────────────────────────────────

  test('exists returns only notes that have the field', async () => {
    // Bare.md has no frontmatter so "status" does not exist there
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      where: [{ field: 'status', op: 'exists' }],
    });

    assertNonError(res, 'exists');
    const data = JSON.parse(res.content[0].text);
    // Alpha, Beta, Gamma, Root all have status
    assert.ok(data.totalMatches >= 4, `exists: expected >=4, got ${data.totalMatches}`);
    for (const r of data.results) {
      assert.notEqual(
        r.frontmatter.status,
        undefined,
        `exists: result ${r.path} should have status field`,
      );
    }
  });

  test('not_exists returns only notes missing the field', async () => {
    // Bare.md has no frontmatter → status does not exist
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      where: [{ field: 'status', op: 'not_exists' }],
    });

    assertNonError(res, 'not_exists');
    const data = JSON.parse(res.content[0].text);
    assert.ok(data.totalMatches >= 1, 'not_exists: at least one note has no status');
    for (const r of data.results) {
      assert.equal(
        r.frontmatter.status,
        undefined,
        `not_exists: result ${r.path} should NOT have status field`,
      );
    }
  });

  // ─── from (directory prefix) ──────────────────────────────────────────────

  test('from limits results to notes inside the specified directory', async () => {
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      from: 'Projects',
    });

    assertNonError(res, 'from filter');
    const data = JSON.parse(res.content[0].text);
    // Alpha, Beta, Gamma live in Projects/
    assert.equal(data.totalMatches, 3, `from: expected 3 Projects notes, got ${data.totalMatches}`);
    for (const r of data.results) {
      assert.ok(
        r.path.startsWith('Projects'),
        `from: result path "${r.path}" should start with "Projects"`,
      );
    }
  });

  test('from excludes notes in sibling directories', async () => {
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      from: 'Notes',
    });

    assertNonError(res, 'from Notes');
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.totalMatches, 1, 'from Notes: only Bare.md');
    assert.ok(data.results[0].path.includes('Bare'), 'from Notes: result is Bare.md');
  });

  // ─── sort_by ──────────────────────────────────────────────────────────────

  test('sort_by ascending — results ordered by field ascending (lexicographic)', async () => {
    // Projects/ has Alpha, Beta, Gamma — lexicographic ascending = Alpha, Beta, Gamma
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      from: 'Projects',
      sort_by: 'title',
    });

    assertNonError(res, 'sort asc');
    const data = JSON.parse(res.content[0].text);
    const titles = data.results.map(r => r.frontmatter.title);
    assert.deepEqual(
      titles,
      ['Alpha', 'Beta', 'Gamma'],
      `sort asc: expected [Alpha, Beta, Gamma], got ${JSON.stringify(titles)}`,
    );
  });

  test('sort_by descending (prefix "-") — results in reverse order', async () => {
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      from: 'Projects',
      sort_by: '-title',
    });

    assertNonError(res, 'sort desc');
    const data = JSON.parse(res.content[0].text);
    const titles = data.results.map(r => r.frontmatter.title);
    const sortedDesc = [...titles].sort((a, b) => String(b).localeCompare(String(a)));
    assert.deepEqual(titles, sortedDesc, `sort desc: titles should be descending — got ${JSON.stringify(titles)}`);
  });

  // ─── limit ────────────────────────────────────────────────────────────────

  test('limit caps returned results while totalMatches reflects full count', async () => {
    // There are >= 5 notes total across the vault
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      limit: 2,
    });

    assertNonError(res, 'limit');
    const data = JSON.parse(res.content[0].text);
    assert.ok(data.totalMatches > 2, `limit: totalMatches (${data.totalMatches}) should exceed limit`);
    assert.equal(data.results.length, 2, 'limit: exactly 2 results returned');
    assert.equal(data.returned, 2, 'limit: returned field equals 2');
  });

  // ─── multi-condition AND ─────────────────────────────────────────────────

  test('multiple where conditions are ANDed — only notes matching all pass', async () => {
    // status: active AND tags contains "work" → Alpha (active, [work,urgent]) and Gamma (active, [work])
    // Beta is done, Root has no tags
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      where: [
        { field: 'status', op: 'equals', value: 'active' },
        { field: 'tags', op: 'contains', value: 'work' },
      ],
    });

    assertNonError(res, 'multi-condition AND');
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.totalMatches, 2, `AND: expected Alpha+Gamma, got ${data.totalMatches}`);
    const titles = data.results.map(r => r.frontmatter.title).sort();
    assert.deepEqual(titles, ['Alpha', 'Gamma'], `AND: expected Alpha and Gamma — got ${JSON.stringify(titles)}`);
  });

  test('fields projection returns only requested frontmatter keys', async () => {
    const res = await queryHandlers.query_notes({
      vault: 'QV',
      from: 'Projects',
      where: [{ field: 'status', op: 'equals', value: 'active' }],
      fields: ['title', 'status'],
    });

    assertNonError(res, 'fields projection');
    const data = JSON.parse(res.content[0].text);
    for (const r of data.results) {
      const keys = Object.keys(r.frontmatter);
      assert.ok(keys.includes('title'), 'projected frontmatter has "title"');
      assert.ok(keys.includes('status'), 'projected frontmatter has "status"');
      assert.ok(!keys.includes('tags'), 'projected frontmatter omits "tags"');
      assert.ok(!keys.includes('priority'), 'projected frontmatter omits "priority"');
    }
  });
});
