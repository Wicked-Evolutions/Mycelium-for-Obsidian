/**
 * Analytics tool tests — analytics.test.mjs
 *
 * Covers: get_vault_health, get_orphan_notes, get_broken_links, get_stale_notes
 * Uses purpose-built temp vaults with known orphans, broken links, and stale notes.
 *
 * Run: node --test test/analytics.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAnalyticsHandlers } from '../dist/tools/analytics.js';

// ---------------------------------------------------------------------------
// Fixture layout
//
// links vault:
//   Root.md          — root-level file (no inbound links), links to Hub
//   Sub/Hub.md       — has inbound link from Root, links to Sub/Linked
//   Sub/Linked.md    — has inbound link from Hub (NOT an orphan)
//   Sub/Orphan.md    — zero inbound links (orphan, in subfolder)
//   Sub/Broken.md    — has a [[DefinitelyMissing123]] broken link
//
// stale vault:
//   Fresh.md                — written now, NOT stale
//   Old/StaleNote.md        — backdated 200 days
//   Old/StaleProject.md     — backdated 200 days, type: PROJECT in frontmatter
//   Excluded/Stale.md       — backdated 200 days but excluded by pattern
// ---------------------------------------------------------------------------

let linkVaultDir;
let staleVaultDir;
let linkHandlers;
let staleHandlers;

// How many ms to backdate "stale" files
const STALE_BACKDATE_MS = 200 * 24 * 60 * 60 * 1000; // 200 days in the past

before(() => {
  // ---- links vault ----
  linkVaultDir = createTempVault({
    'Root.md': '# Root\n\n[[Hub]]\n',
    'Sub/Hub.md': '# Hub\n\n[[Linked]]\n',
    'Sub/Linked.md': '# Linked\n\nNo outbound links here.\n',
    'Sub/Orphan.md': '# Orphan\n\nNothing links to me.\n',
    'Sub/Broken.md': '# Broken\n\n[[DefinitelyMissing123]]\n',
  });

  // ---- stale vault ----
  staleVaultDir = createTempVault({
    'Fresh.md': '# Fresh\n\nWritten just now.\n',
    'Old/StaleNote.md': '# Stale Note\n\nI am old.\n',
    'Old/StaleProject.md': [
      '---',
      'type: PROJECT',
      '---',
      '',
      '# Stale Project',
      '',
      'An old project note.',
    ].join('\n'),
    'Excluded/Stale.md': '# Excluded Stale\n\nShould be excluded by pattern.\n',
  });

  // Backdate stale files in staleVaultDir
  const past = new Date(Date.now() - STALE_BACKDATE_MS);
  for (const rel of ['Old/StaleNote.md', 'Old/StaleProject.md', 'Excluded/Stale.md']) {
    const abs = path.join(staleVaultDir, rel);
    fs.utimesSync(abs, past, past);
  }

  // Register both vaults under distinct names
  process.env.OBSIDIAN_VAULTS = JSON.stringify({
    LinkVault: linkVaultDir,
    StaleVault: staleVaultDir,
  });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  linkHandlers = createAnalyticsHandlers(config);
  staleHandlers = createAnalyticsHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (linkVaultDir) cleanup(linkVaultDir);
  if (staleVaultDir) cleanup(staleVaultDir);
});

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

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

function parseResult(res) {
  return JSON.parse(res.content[0].text);
}

// ---------------------------------------------------------------------------
// get_orphan_notes
// ---------------------------------------------------------------------------

describe('get_orphan_notes', () => {
  test('returns non-error ToolResponse with correct shape', async () => {
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault' });
    assertNonError(res, 'get_orphan_notes');
    const data = parseResult(res);
    assert.ok('orphanCount' in data, 'get_orphan_notes: has orphanCount');
    assert.ok(Array.isArray(data.orphans), 'get_orphan_notes: has orphans array');
    // Each orphan entry has path, title, lastModified
    for (const o of data.orphans) {
      assert.equal(typeof o.path, 'string', 'orphan entry has path');
      assert.equal(typeof o.title, 'string', 'orphan entry has title');
      assert.equal(typeof o.lastModified, 'string', 'orphan entry has lastModified');
    }
  });

  test('Sub/Orphan.md is listed as orphan', async () => {
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault' });
    const data = parseResult(res);
    const paths = data.orphans.map(o => o.path);
    assert.ok(
      paths.some(p => p.includes('Orphan.md')),
      `get_orphan_notes: Orphan.md found in [${paths.join(', ')}]`,
    );
  });

  test('Sub/Linked.md is NOT listed as orphan (it has inbound links)', async () => {
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault' });
    const data = parseResult(res);
    const paths = data.orphans.map(o => o.path);
    assert.ok(
      !paths.some(p => p.includes('Linked.md')),
      `get_orphan_notes: Linked.md should NOT be an orphan but found in [${paths.join(', ')}]`,
    );
  });

  test('Root.md (root-level file) IS listed by get_orphan_notes (no /-filter)', async () => {
    // get_orphan_notes does NOT filter root-level files — that's get_vault_health's behavior
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault' });
    const data = parseResult(res);
    const paths = data.orphans.map(o => o.path);
    assert.ok(
      paths.some(p => p.includes('Root.md')),
      `get_orphan_notes: Root.md (root-level orphan) should appear in [${paths.join(', ')}]`,
    );
  });

  test('orphanCount matches orphans array length', async () => {
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.equal(
      data.orphanCount,
      data.orphans.length,
      'get_orphan_notes: orphanCount equals orphans.length',
    );
  });

  test('exclude_patterns removes matching files', async () => {
    const res = await linkHandlers.get_orphan_notes({
      vault: 'LinkVault',
      exclude_patterns: ['Sub/'],
    });
    const data = parseResult(res);
    const paths = data.orphans.map(o => o.path);
    // Sub/Orphan.md starts with "Sub/" and should be excluded
    assert.ok(
      !paths.some(p => p.startsWith('Sub/')),
      `get_orphan_notes with exclude "Sub/": no Sub/ paths expected, got [${paths.join(', ')}]`,
    );
  });

  test('limit caps results', async () => {
    const res = await linkHandlers.get_orphan_notes({ vault: 'LinkVault', limit: 1 });
    const data = parseResult(res);
    assert.ok(
      data.orphans.length <= 1,
      `get_orphan_notes limit=1: expected at most 1 result, got ${data.orphans.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// get_broken_links
// ---------------------------------------------------------------------------

describe('get_broken_links', () => {
  test('returns non-error ToolResponse with correct shape', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    assertNonError(res, 'get_broken_links');
    const data = parseResult(res);
    assert.ok('brokenLinkCount' in data, 'has brokenLinkCount');
    assert.ok(Array.isArray(data.brokenLinks), 'has brokenLinks array');
  });

  test('detects the broken link to DefinitelyMissing123', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.ok(
      data.brokenLinkCount >= 1,
      `get_broken_links: expected at least 1 broken link, got ${data.brokenLinkCount}`,
    );
    // At least one broken link entry points to DefinitelyMissing123
    const broken = data.brokenLinks.find(b => b.target === 'DefinitelyMissing123');
    assert.ok(
      broken !== undefined,
      `get_broken_links: expected a broken link with target "DefinitelyMissing123", got [${data.brokenLinks.map(b => b.target).join(', ')}]`,
    );
  });

  test('broken link entry has source, target (without .md), and lineNumber', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    const data = parseResult(res);
    const broken = data.brokenLinks.find(b => b.target === 'DefinitelyMissing123');
    assert.ok(broken, 'DefinitelyMissing123 broken link entry found');
    assert.equal(typeof broken.source, 'string', 'broken link entry has source');
    assert.equal(typeof broken.target, 'string', 'broken link entry has target');
    assert.equal(typeof broken.lineNumber, 'number', 'broken link entry has lineNumber');
    // Target is the raw wikilink text, without .md
    assert.equal(broken.target, 'DefinitelyMissing123', 'target is stored without .md extension');
  });

  test('source of the broken link is Sub/Broken.md', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    const data = parseResult(res);
    const broken = data.brokenLinks.find(b => b.target === 'DefinitelyMissing123');
    assert.ok(
      broken.source.includes('Broken.md'),
      `broken link source should be Broken.md, got "${broken.source}"`,
    );
  });

  test('[[Hub]] link (resolved) does NOT produce a broken link', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    const data = parseResult(res);
    const hubBroken = data.brokenLinks.find(b => b.target === 'Hub');
    assert.equal(
      hubBroken,
      undefined,
      'Hub is a real file — its wikilink should NOT appear as broken',
    );
  });

  test('brokenLinkCount matches brokenLinks array length', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.equal(
      data.brokenLinkCount,
      data.brokenLinks.length,
      'brokenLinkCount equals brokenLinks.length',
    );
  });

  test('limit caps brokenLinks array', async () => {
    const res = await linkHandlers.get_broken_links({ vault: 'LinkVault', limit: 1 });
    const data = parseResult(res);
    assert.ok(
      data.brokenLinks.length <= 1,
      `get_broken_links limit=1: expected at most 1, got ${data.brokenLinks.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// get_stale_notes
// ---------------------------------------------------------------------------

describe('get_stale_notes', () => {
  test('returns non-error ToolResponse with correct shape', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    assertNonError(res, 'get_stale_notes');
    const data = parseResult(res);
    assert.ok('daysThreshold' in data, 'has daysThreshold');
    assert.ok('staleCount' in data, 'has staleCount');
    assert.ok(Array.isArray(data.staleNotes), 'has staleNotes array');
  });

  test('Fresh.md is NOT in stale results (days=90)', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    const paths = data.staleNotes.map(n => n.path);
    assert.ok(
      !paths.some(p => p.includes('Fresh.md')),
      `get_stale_notes: Fresh.md should not appear in stale list, got [${paths.join(', ')}]`,
    );
  });

  test('Old/StaleNote.md IS in stale results (backdated 200 days, threshold 90)', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    const paths = data.staleNotes.map(n => n.path);
    assert.ok(
      paths.some(p => p.includes('StaleNote.md')),
      `get_stale_notes: StaleNote.md should appear, got [${paths.join(', ')}]`,
    );
  });

  test('each stale note has required fields with correct types', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    assert.ok(data.staleNotes.length > 0, 'at least one stale note to inspect');
    for (const note of data.staleNotes) {
      assert.equal(typeof note.path, 'string', 'stale note has path string');
      assert.equal(typeof note.title, 'string', 'stale note has title string');
      assert.equal(typeof note.lastModified, 'string', 'stale note has lastModified string');
      assert.equal(typeof note.daysSinceModified, 'number', 'stale note has daysSinceModified number');
    }
  });

  test('daysSinceModified is approximately 200 for backdated files', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    const staleNote = data.staleNotes.find(n => n.path.includes('StaleNote.md'));
    assert.ok(staleNote, 'StaleNote.md found in results');
    assert.ok(
      staleNote.daysSinceModified >= 195 && staleNote.daysSinceModified <= 205,
      `daysSinceModified should be ~200, got ${staleNote.daysSinceModified}`,
    );
  });

  test('results are sorted stalest-first', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    for (let i = 1; i < data.staleNotes.length; i++) {
      assert.ok(
        data.staleNotes[i - 1].daysSinceModified >= data.staleNotes[i].daysSinceModified,
        `stale notes not sorted stalest-first at index ${i}`,
      );
    }
  });

  test('type_filter returns only notes with matching frontmatter type', async () => {
    const res = await staleHandlers.get_stale_notes({
      vault: 'StaleVault',
      days: 90,
      type_filter: 'PROJECT',
    });
    const data = parseResult(res);
    assert.equal(
      data.typeFilter,
      'PROJECT',
      `typeFilter echoed back as "PROJECT", got "${data.typeFilter}"`,
    );
    assert.equal(
      data.staleCount,
      1,
      `type_filter=PROJECT: expected 1 result, got ${data.staleCount}`,
    );
    assert.ok(
      data.staleNotes[0].path.includes('StaleProject.md'),
      `type_filter result should be StaleProject.md, got "${data.staleNotes[0].path}"`,
    );
  });

  test('type_filter is case-insensitive', async () => {
    const res = await staleHandlers.get_stale_notes({
      vault: 'StaleVault',
      days: 90,
      type_filter: 'project',
    });
    const data = parseResult(res);
    assert.equal(
      data.staleCount,
      1,
      `type_filter=project (lowercase): expected 1 result, got ${data.staleCount}`,
    );
  });

  test('exclude_patterns omits matching paths from stale results', async () => {
    const res = await staleHandlers.get_stale_notes({
      vault: 'StaleVault',
      days: 90,
      exclude_patterns: ['Excluded/'],
    });
    const data = parseResult(res);
    const paths = data.staleNotes.map(n => n.path);
    assert.ok(
      !paths.some(p => p.startsWith('Excluded/')),
      `get_stale_notes with exclude "Excluded/": no Excluded/ paths expected, got [${paths.join(', ')}]`,
    );
    // Old/* should still appear
    assert.ok(
      paths.some(p => p.startsWith('Old/')),
      `get_stale_notes with exclude "Excluded/": Old/ paths should still appear, got [${paths.join(', ')}]`,
    );
  });

  test('daysThreshold echoes the requested days value', async () => {
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 60 });
    const data = parseResult(res);
    assert.equal(data.daysThreshold, 60, 'daysThreshold echoes requested days value');
  });

  test('staleCount with very low days threshold catches all files', async () => {
    // days=0 means everything stale (threshold is Date.now() - 0 = now)
    // But files written in before() are fresh-ish, so not all may qualify.
    // Use a ridiculously low threshold: notes older than 100 days, and only the backdated ones qualify
    const res = await staleHandlers.get_stale_notes({ vault: 'StaleVault', days: 90 });
    const data = parseResult(res);
    // We backdated 3 files: StaleNote.md, StaleProject.md, Excluded/Stale.md
    // All 3 should appear (no exclude)
    assert.equal(
      data.staleCount,
      3,
      `Expected 3 stale files (the 3 backdated ones), got ${data.staleCount}. Notes: [${data.staleNotes.map(n => n.path).join(', ')}]`,
    );
  });
});

// ---------------------------------------------------------------------------
// get_vault_health
// ---------------------------------------------------------------------------

describe('get_vault_health', () => {
  test('returns non-error ToolResponse with correct shape', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    assertNonError(res, 'get_vault_health');
    const data = parseResult(res);
    for (const key of [
      'vault', 'totalFiles', 'orphanNotes', 'brokenLinks', 'staleNotes',
      'staleDaysThreshold', 'topOrphans', 'topBrokenLinks', 'topStaleNotes',
    ]) {
      assert.ok(key in data, `get_vault_health: response has key "${key}"`);
    }
  });

  test('totalFiles equals the count of .md files in the vault', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    // 5 markdown files in linkVaultDir
    assert.equal(data.totalFiles, 5, `totalFiles: expected 5, got ${data.totalFiles}`);
  });

  test('brokenLinks count matches broken link fixture', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    // Sub/Broken.md has exactly one broken link
    assert.equal(
      data.brokenLinks,
      1,
      `get_vault_health: brokenLinks count expected 1, got ${data.brokenLinks}`,
    );
  });

  test('get_vault_health skips root-level files from orphanNotes — Root.md excluded', async () => {
    // get_vault_health filters with .filter(f => f.relativePath.includes('/'))
    // Root.md has no '/' in its path, so it is excluded from orphan count
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    const rootInOrphans = data.topOrphans.some(p => p.includes('Root.md'));
    assert.equal(
      rootInOrphans,
      false,
      `get_vault_health: Root.md (root-level) should NOT appear in topOrphans, got [${data.topOrphans.join(', ')}]`,
    );
  });

  test('Sub/Orphan.md appears in topOrphans', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.ok(
      data.topOrphans.some(p => p.includes('Orphan.md')),
      `get_vault_health: Orphan.md should appear in topOrphans, got [${data.topOrphans.join(', ')}]`,
    );
  });

  test('DefinitelyMissing123 appears in topBrokenLinks targets', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.ok(
      Array.isArray(data.topBrokenLinks),
      'topBrokenLinks is an array',
    );
    assert.ok(
      data.topBrokenLinks.some(b => b.target === 'DefinitelyMissing123'),
      `get_vault_health: DefinitelyMissing123 should be in topBrokenLinks, got [${JSON.stringify(data.topBrokenLinks)}]`,
    );
  });

  test('staleDaysThreshold uses default of 90 when stale_days not provided', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.equal(data.staleDaysThreshold, 90, 'staleDaysThreshold defaults to 90');
  });

  test('staleDaysThreshold honours custom stale_days argument', async () => {
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault', stale_days: 30 });
    const data = parseResult(res);
    assert.equal(data.staleDaysThreshold, 30, 'staleDaysThreshold echoes stale_days=30');
  });

  test('orphanNotes count is correct (only subfolder orphans counted)', async () => {
    // Subfolder files: Hub.md (has inbound from Root), Linked.md (has inbound from Hub),
    // Orphan.md (0 inbound), Broken.md (0 inbound) → 2 orphans
    const res = await linkHandlers.get_vault_health({ vault: 'LinkVault' });
    const data = parseResult(res);
    assert.equal(
      data.orphanNotes,
      2,
      `get_vault_health: expected 2 orphanNotes (Orphan.md + Broken.md), got ${data.orphanNotes}. topOrphans: [${data.topOrphans.join(', ')}]`,
    );
  });

  test('get_vault_health on stale vault reports stale notes', async () => {
    const res = await staleHandlers.get_vault_health({ vault: 'StaleVault', stale_days: 90 });
    const data = parseResult(res);
    // 3 backdated files exist in StaleVault
    assert.equal(
      data.staleNotes,
      3,
      `get_vault_health StaleVault: expected 3 stale notes, got ${data.staleNotes}`,
    );
    // Fresh.md should NOT appear in stale
    assert.ok(
      !data.topStaleNotes.some(n => n.path && n.path.includes('Fresh.md')),
      'Fresh.md should not appear in topStaleNotes',
    );
  });
});

// ---------------------------------------------------------------------------
// Bug-1: duplicate-basename collision in buildBacklinkIndex
//
// Vault layout (deliberately making B/ walk after A/ so readdir order ≠ correct answer):
//   A/Note.md  — has NO inbound links → should be orphan
//   B/Note.md  — linked by B/Linker.md → should NOT be orphan
//   B/Linker.md — contains [[Note]] — same folder as B/Note.md, so tiebreak wins B/
//
// Pre-fix: buildFileIndex keeps only the first occurrence (A/Note.md), so [[Note]]
// always credits A/Note.md.  B/Note.md gets 0 backlinks and is mislabelled orphan.
// A/Note.md gets 1 backlink and is NOT an orphan, despite having no real inbound link.
// Post-fix: same-folder tiebreak credits B/Note.md; A/Note.md stays at 0 (orphan).
// ---------------------------------------------------------------------------

describe('Bug-1 fix: duplicate-basename backlink resolution', () => {
  let dupVaultDir;
  let dupHandlers;

  before(() => {
    dupVaultDir = createTempVault({
      'A/Note.md': '# Note in A\n\nNo one links here.',
      'B/Note.md': '# Note in B\n\nLinked by Linker.',
      'B/Linker.md': '# Linker\n\nSee [[Note]] for details.',
    });

    process.env.OBSIDIAN_VAULTS = JSON.stringify({ DupVault: dupVaultDir });
    delete process.env.OBSIDIAN_DISABLED_TOOLS;
    const cfg = loadConfig();
    dupHandlers = createAnalyticsHandlers(cfg);
  });

  after(() => {
    delete process.env.OBSIDIAN_VAULTS;
    if (dupVaultDir) cleanup(dupVaultDir);
  });

  test('[[Note]] in B/Linker.md credits B/Note.md, not A/Note.md', async () => {
    const res = await dupHandlers.get_broken_links({ vault: 'DupVault' });
    assertNonError(res, 'dup-basename get_broken_links');
    const data = parseResult(res);
    // [[Note]] should resolve to B/Note.md (same folder as linker) — NOT a broken link
    assert.equal(
      data.brokenLinkCount,
      0,
      `Bug-1: [[Note]] in B/Linker.md should resolve to B/Note.md — got broken links: [${(data.brokenLinks || []).map(b => b.target).join(', ')}]`,
    );
  });

  test('A/Note.md has zero backlinks (is an orphan); B/Note.md has one backlink (is not)', async () => {
    const res = await dupHandlers.get_orphan_notes({ vault: 'DupVault' });
    assertNonError(res, 'dup-basename get_orphan_notes');
    const data = parseResult(res);
    const orphanPaths = data.orphans.map(o => o.path);
    assert.ok(
      orphanPaths.some(p => p.includes('A/Note.md') || p.includes('A\\Note.md')),
      `Bug-1: A/Note.md should be an orphan (no inbound links) — orphans: [${orphanPaths.join(', ')}]`,
    );
    assert.ok(
      !orphanPaths.some(p => p.includes('B/Note.md') || p.includes('B\\Note.md')),
      `Bug-1: B/Note.md should NOT be an orphan (linked by B/Linker.md) — orphans: [${orphanPaths.join(', ')}]`,
    );
  });
});
