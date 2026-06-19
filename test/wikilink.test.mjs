/**
 * L0 baseline tests for wikilink parsing, resolution, follow_link,
 * get_outlinks, and get_backlinks.
 *
 * Vault layout used across all tests:
 *   Note A.md  — links to [[Note B]] and [[Note C]]
 *   Note B.md  — links to [[Note C]]
 *   Note C.md  — links to [[Note A]]
 *
 * Expected graph (directed):
 *   A → B, A → C, B → C, C → A
 *
 * Backlinks-to-A : only C (B does not link A) → backlinkCount === 1
 * Outlinks-from-A : 2 (B and C), both exists:true
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempVault, cleanup } from './helpers.mjs';
import {
  extractWikilinks,
  resolveWikilink,
  buildFileIndex,
  resolveAllWikilinks,
  parseCrossVaultLink,
  getWikilinkLineNumber,
  getWikilinkContext,
} from '../dist/parsers/wikilink.js';
import { createWikilinkHandlers } from '../dist/tools/wikilinks.js';

// ─── Shared vault ────────────────────────────────────────────────────────────

let vaultDir;

before(() => {
  vaultDir = createTempVault({
    'Note A.md': [
      '# Note A',
      '',
      'This links to [[Note B]] and also [[Note C]].',
      'Some more text here.',
    ].join('\n'),

    'Note B.md': [
      '# Note B',
      '',
      'See [[Note C]] for more details.',
    ].join('\n'),

    'Note C.md': [
      '# Note C',
      '',
      'Back to [[Note A]].',
    ].join('\n'),
  });
});

after(() => {
  cleanup(vaultDir);
});

// Build a minimal config object matching what createWikilinkHandlers expects.
function makeConfig(vaultPath) {
  return {
    mode: 'single',
    vaults: [{ name: 'Test', path: vaultPath }],
    ollama: { host: '', model: '' },
    disabledTools: new Set(),
  };
}

// Convenience: parse the JSON payload out of a handler ToolResponse.
function payload(res) {
  assert.equal(res.isError, false, `handler returned isError:true — ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

// ─── Parser: extractWikilinks ────────────────────────────────────────────────

test('extractWikilinks — basic [[link]]', () => {
  const links = extractWikilinks('Hello [[World]] and [[Foo|Bar]].');
  assert.equal(links.length, 2);

  const [first, second] = links;
  assert.equal(first.raw, '[[World]]');
  assert.equal(first.target, 'World');
  assert.equal(first.alias, undefined);
  assert.equal(first.exists, false);

  assert.equal(second.raw, '[[Foo|Bar]]');
  assert.equal(second.target, 'Foo');
  assert.equal(second.alias, 'Bar');
});

test('extractWikilinks — cross-vault syntax strips vault prefix from target', () => {
  const links = extractWikilinks('See [[MyVault:Some Note]].');
  assert.equal(links.length, 1);
  // target should be the note part only (cross-vault prefix stripped)
  assert.equal(links[0].target, 'Some Note');
});

test('extractWikilinks — empty content returns empty array', () => {
  assert.deepEqual(extractWikilinks(''), []);
  assert.deepEqual(extractWikilinks('No links here at all.'), []);
});

// ─── Parser: parseCrossVaultLink ─────────────────────────────────────────────

test('parseCrossVaultLink — detects vault prefix', () => {
  const result = parseCrossVaultLink('MyVault:My Note');
  assert.equal(result.vault, 'MyVault');
  assert.equal(result.note, 'My Note');
});

test('parseCrossVaultLink — plain link returns no vault', () => {
  const result = parseCrossVaultLink('My Note');
  assert.equal(result.vault, undefined);
  assert.equal(result.note, 'My Note');
});

// ─── Parser: resolveWikilink ─────────────────────────────────────────────────

test('resolveWikilink — resolves by exact filename in vault (no index)', async () => {
  const resolved = await resolveWikilink('Note A', vaultDir);
  assert.ok(resolved, 'expected a resolved path');
  assert.ok(resolved.endsWith('Note A.md'), `expected Note A.md, got ${resolved}`);
});

test('resolveWikilink — resolves faster with fileIndex', async () => {
  const index = await buildFileIndex(vaultDir);
  const resolved = await resolveWikilink('Note B', vaultDir, index);
  assert.ok(resolved, 'expected a resolved path');
  assert.ok(resolved.endsWith('Note B.md'));
});

test('resolveWikilink — returns null for non-existent note', async () => {
  const result = await resolveWikilink('Does Not Exist', vaultDir);
  assert.equal(result, null);
});

test('resolveWikilink — accepts .md extension in target', async () => {
  const resolved = await resolveWikilink('Note C.md', vaultDir);
  assert.ok(resolved);
  assert.ok(resolved.endsWith('Note C.md'));
});

// ─── Parser: resolveAllWikilinks ─────────────────────────────────────────────

test('resolveAllWikilinks — marks existing links exists:true with resolved path', async () => {
  const content = '[[Note A]] and [[Phantom Note]]';
  const links = await resolveAllWikilinks(content, vaultDir);
  assert.equal(links.length, 2);

  const [noteA, phantom] = links;
  assert.equal(noteA.exists, true);
  assert.ok(noteA.resolved, 'Note A should have a resolved path');

  assert.equal(phantom.exists, false);
  assert.equal(phantom.resolved, undefined);
});

// ─── Parser: getWikilinkLineNumber / getWikilinkContext ──────────────────────

test('getWikilinkLineNumber — finds correct 1-indexed line', () => {
  const content = 'Line 1\nLine 2 [[Target]]\nLine 3';
  assert.equal(getWikilinkLineNumber(content, '[[Target]]'), 2);
});

test('getWikilinkLineNumber — returns 0 when not found', () => {
  assert.equal(getWikilinkLineNumber('no links', '[[Missing]]'), 0);
});

test('getWikilinkContext — returns surrounding text', () => {
  const content = 'Some text [[Target]] more text';
  const ctx = getWikilinkContext(content, '[[Target]]', 20);
  assert.ok(ctx.includes('[[Target]]'), 'context should contain the wikilink');
  assert.ok(ctx.includes('Some text'), 'context should include preceding text');
});

// ─── buildFileIndex ───────────────────────────────────────────────────────────

test('buildFileIndex — indexes all .md files', async () => {
  const index = await buildFileIndex(vaultDir);
  assert.equal(index.size, 3);
  assert.ok(index.has('note a.md'), 'index should have lowercase key');
  assert.ok(index.has('note b.md'));
  assert.ok(index.has('note c.md'));
});

// ─── Handler: resolve_wikilink ───────────────────────────────────────────────

test('resolve_wikilink handler — finds existing note', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.resolve_wikilink({ link: 'Note B' });
  const data = payload(res);

  assert.equal(data.exists, true);
  assert.equal(data.link, 'Note B');
  // resolved is relative to vault root
  assert.equal(data.resolved, 'Note B.md');
});

test('resolve_wikilink handler — returns exists:false for missing note', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.resolve_wikilink({ link: 'Nonexistent' });
  const data = payload(res);

  assert.equal(data.exists, false);
  assert.equal(data.resolved, null);
});

// ─── Handler: follow_link ────────────────────────────────────────────────────

test('follow_link handler — returns content of linked note', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.follow_link({ link: 'Note C' });
  const data = payload(res);

  assert.equal(data.found, true);
  assert.equal(data.link, 'Note C');
  // path should be the relative path within the vault
  assert.equal(data.path, 'Note C.md');
  // title extracted from H1
  assert.equal(data.title, 'Note C');
  // content should include the body (without frontmatter)
  assert.ok(data.content.includes('Back to [[Note A]]'));
});

test('follow_link handler — returns found:false for missing note', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.follow_link({ link: 'Ghost Note' });
  const data = payload(res);

  assert.equal(data.found, false);
  assert.equal(data.link, 'Ghost Note');
});

// ─── Handler: get_outlinks ───────────────────────────────────────────────────

test('get_outlinks handler — Note A has 2 outlinks, both resolved', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_outlinks({ path: 'Note A.md' });
  const data = payload(res);

  assert.equal(data.file, 'Note A.md');
  assert.equal(data.linkCount, 2, 'Note A should have exactly 2 outlinks');

  const targets = data.links.map(l => l.target);
  assert.ok(targets.includes('Note B'), 'should include Note B');
  assert.ok(targets.includes('Note C'), 'should include Note C');

  // All links should be resolved and exist
  for (const link of data.links) {
    assert.equal(link.exists, true, `link to ${link.target} should exist`);
    assert.ok(link.resolved, `link to ${link.target} should have a resolved path`);
  }
});

test('get_outlinks handler — Note B has 1 outlink to Note C', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_outlinks({ path: 'Note B.md' });
  const data = payload(res);

  assert.equal(data.linkCount, 1);
  assert.equal(data.links[0].target, 'Note C');
  assert.equal(data.links[0].exists, true);
  assert.equal(data.links[0].resolved, 'Note C.md');
});

test('get_outlinks handler — resolveLinks:false skips resolution', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_outlinks({ path: 'Note A.md', resolveLinks: false });
  const data = payload(res);

  assert.equal(data.linkCount, 2);
  for (const link of data.links) {
    assert.equal(link.exists, false, 'links should be unresolved when resolveLinks is false');
    assert.equal(link.resolved, undefined);
  }
});

// ─── Handler: get_backlinks ───────────────────────────────────────────────────

test('get_backlinks handler — Note A has exactly 1 backlink (from Note C only)', async () => {
  // A→B,C  B→C  C→A
  // Only C links back to A; B does not → backlinkCount must be 1
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_backlinks({ path: 'Note A.md' });
  const data = payload(res);

  assert.equal(data.target, 'Note A.md');
  assert.equal(data.backlinkCount, 1, 'exactly one note (C) links to A');
  assert.equal(data.backlinks[0].sourcePath, 'Note C.md');
});

test('get_backlinks handler — self-references are excluded', async () => {
  // Verify A is not listed as its own backlink
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_backlinks({ path: 'Note A.md' });
  const data = payload(res);

  const sources = data.backlinks.map(b => b.sourcePath);
  assert.ok(!sources.includes('Note A.md'), 'Note A should not backlink itself');
});

test('get_backlinks handler — Note C has 2 backlinks (A and B both link C)', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_backlinks({ path: 'Note C.md' });
  const data = payload(res);

  assert.equal(data.backlinkCount, 2, 'both A and B link to C');
  const sources = data.backlinks.map(b => b.sourcePath).sort();
  assert.deepEqual(sources, ['Note A.md', 'Note B.md']);
});

test('get_backlinks handler — note with no backlinks returns empty array', async () => {
  // Note B is linked from A but let us test a fresh vault note
  // Create a fresh vault with an isolated note
  const isolatedVault = createTempVault({
    'Lonely.md': '# Lonely\nNo one links here.',
    'Linker.md': '# Linker\nLinks to [[Lonely]].',
  });
  after(() => cleanup(isolatedVault));

  const handlers = createWikilinkHandlers(makeConfig(isolatedVault));

  // Linker.md has no backlinks
  const res = await handlers.get_backlinks({ path: 'Linker.md' });
  const data = payload(res);
  assert.equal(data.backlinkCount, 0);
  assert.deepEqual(data.backlinks, []);
});

test('get_backlinks handler — backlink entry includes lineNumber and context', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.get_backlinks({ path: 'Note A.md', includeContext: true });
  const data = payload(res);

  assert.equal(data.backlinkCount, 1);
  const entry = data.backlinks[0];
  assert.ok(typeof entry.lineNumber === 'number' && entry.lineNumber > 0, 'lineNumber should be positive');
  assert.ok(typeof entry.context === 'string' && entry.context.length > 0, 'context should be non-empty');
  assert.ok(entry.context.includes('[[Note A]]'), 'context should contain the wikilink');
});

// ─── Handler: rebuild_link_index ─────────────────────────────────────────────

test('rebuild_link_index handler — returns rebuilt:true and correct file count', async () => {
  const handlers = createWikilinkHandlers(makeConfig(vaultDir));
  const res = await handlers.rebuild_link_index({});
  const data = payload(res);

  assert.equal(data.rebuilt, true);
  assert.equal(data.vault, 'Test');
  assert.equal(data.fileCount, 3);
});
