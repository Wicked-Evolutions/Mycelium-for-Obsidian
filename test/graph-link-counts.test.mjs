/**
 * L4 vault-level link-count aggregates (issue #37).
 *
 * The three provider-independent counts surfaced by analyze_link_hierarchy:
 *   resolvedEdgeCount       — RESOLVED same-vault occurrences forming edges
 *   unresolvedLinkCount     — UNRESOLVED same-vault occurrences (with multiplicity)
 *   distinctUnresolvedTargets — UNIQUE unresolved same-vault target keys
 *
 * Verifies (with --experimental-test-module-mocks):
 *   (1) normalizeUnresolvedKey — the SHARED helper both providers use — honors
 *       the cross-vault skip + subpath/alias strip contract directly (unit).
 *   (2) Obsidian provider reads app.metadataCache.unresolvedLinks as RAW keys
 *       (MOCKED eval) and normalizes them in TS via the shared helper, so a
 *       cross-vault raw key is SKIPPED and heading variants collapse.
 *   (3) Filesystem provider derives the same counts from resolution misses on a
 *       fixture that has BOTH resolved and unresolved links.
 *   (4) Provider parity: for equivalent content (including a cross-vault link
 *       and a repeated headed link) both providers yield the SAME count shape —
 *       exercising REAL normalization on both sides, not a hand-set count.
 *
 * node --test isolates each file in its own process, so this file's bridge mock
 * does not collide with graph-provider-contract's / fallback-reason-surfaces's.
 */

import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

const canMock = typeof mock.module === 'function';

// ---------------------------------------------------------------------------
// Bridge mock — installed BEFORE importing the graph modules.
// The Obsidian provider's eval returns the unresolved keys aggregated by RAW
// key (verbatim, un-normalized) as `unresolvedRaw`; the provider normalizes
// them in TS. The mock therefore returns { nodes, links, unresolvedRaw } —
// exactly the JSON shape the real eval string now produces.
// ---------------------------------------------------------------------------
let mockNodes = [];
let mockLinks = {};
let mockUnresolvedRaw = {};

const BRIDGE_SPECIFIER = new URL('../dist/cli/bridge.js', import.meta.url).href;

if (canMock) {
  await mock.module(BRIDGE_SPECIFIER, {
    namedExports: {
      execCli: async () => '',
      execCliForVault: async () => '',
      evalInObsidian: async () =>
        JSON.stringify({
          nodes: mockNodes,
          links: mockLinks,
          unresolvedRaw: mockUnresolvedRaw,
        }),
      isCliAvailable: async () => true,
    },
  });
}

const { loadConfig } = await import('../dist/config.js');
const { normalizeUnresolvedKey } = await import('../dist/parsers/wikilink.js');
const graphMod = await import('../dist/graph/index.js');
const { FilesystemProvider, ObsidianProvider, buildVaultGraph } = graphMod;

// A fixture with BOTH resolved and unresolved links:
//   Note1 → Note2 (resolved), Note1 → Ghost + Phantom (unresolved)
//   Note2 → Note1 (resolved), Note2 → Ghost (unresolved)
// So: resolvedEdgeCount 2, unresolvedLinkCount 3 (Ghost×2, Phantom×1),
//     distinctUnresolvedTargets 2 (Ghost, Phantom).
function buildVault() {
  return {
    'Note1.md': 'Links to [[Note2]] and [[Ghost]] and [[Phantom]].',
    'Note2.md': 'Back to [[Note1]] and to [[Ghost]].',
  };
}

// The resolvedLinks Obsidian WOULD produce for the vault above (with .md keys).
function expectedResolvedLinks() {
  return {
    'Note1.md': { 'Note2.md': 1 },
    'Note2.md': { 'Note1.md': 1 },
  };
}

// The RAW unresolvedLinks aggregation Obsidian WOULD produce for that vault
// (keys verbatim, summed across sources): Ghost×2, Phantom×1.
function expectedUnresolvedRaw() {
  return { Ghost: 2, Phantom: 1 };
}

describe('normalizeUnresolvedKey (shared helper)', () => {
  test('cross-vault target → null (skip)', () => {
    assert.equal(normalizeUnresolvedKey('OtherVault:Thing'), null);
  });

  test('heading variants collapse to the bare note key', () => {
    assert.equal(normalizeUnresolvedKey('Ghost#Heading A'), 'Ghost');
    assert.equal(normalizeUnresolvedKey('Ghost#Heading B'), 'Ghost');
    assert.equal(normalizeUnresolvedKey('Ghost#^blockid'), 'Ghost');
  });

  test('alias is stripped (defensive)', () => {
    assert.equal(normalizeUnresolvedKey('Foo|bar'), 'Foo');
  });

  test('a space before a colon is NOT cross-vault → counted verbatim', () => {
    assert.equal(
      normalizeUnresolvedKey('Principle Keywords: Breathe'),
      'Principle Keywords: Breathe'
    );
  });
});

describe('link-count aggregates (#37)', { skip: !canMock ? 'requires --experimental-test-module-mocks' : false }, () => {
  let dir, config;

  before(() => {
    graphMod.clearGraphCaches();
    dir = createTempVault(buildVault());
    process.env.OBSIDIAN_VAULT_PATH = dir;
    process.env.OBSIDIAN_DISABLED_TOOLS = '';
    delete process.env.OBSIDIAN_VAULTS;
    config = loadConfig();
    mockNodes = ['Note1.md', 'Note2.md'];
    mockLinks = expectedResolvedLinks();
    mockUnresolvedRaw = expectedUnresolvedRaw();
  });

  after(() => {
    if (dir) cleanup(dir);
    graphMod.clearGraphCaches();
  });

  test('filesystem provider derives counts from resolution misses', async () => {
    const g = await buildVaultGraph(dir, new FilesystemProvider());
    assert.equal(g.provider, 'filesystem');
    assert.equal(g.resolvedEdgeCount, 2, 'two resolved edges (Note1↔Note2)');
    assert.equal(g.unresolvedLinkCount, 3, 'three unresolved occurrences (Ghost×2, Phantom×1)');
    assert.equal(g.distinctUnresolvedTargets, 2, 'two distinct unresolved targets (Ghost, Phantom)');
  });

  test('Obsidian provider normalizes RAW metadataCache.unresolvedLinks keys (mocked eval)', async () => {
    const g = await buildVaultGraph(dir, new ObsidianProvider(config, undefined));
    assert.equal(g.provider, 'obsidian');
    assert.equal(g.resolvedEdgeCount, 2, 'resolvedEdgeCount from filtered resolvedLinks');
    assert.equal(g.unresolvedLinkCount, 3, 'unresolvedLinkCount = sum of normalized unresolved counts');
    assert.equal(g.distinctUnresolvedTargets, 2, 'distinctUnresolvedTargets = unique normalized keys');
  });

  test('provider parity: both providers yield the same count shape', async () => {
    const fsGraph = await buildVaultGraph(dir, new FilesystemProvider());
    const obsGraph = await buildVaultGraph(dir, new ObsidianProvider(config, undefined));

    const shape = (g) => ({
      resolvedEdgeCount: g.resolvedEdgeCount,
      unresolvedLinkCount: g.unresolvedLinkCount,
      distinctUnresolvedTargets: g.distinctUnresolvedTargets,
    });
    assert.deepEqual(shape(fsGraph), shape(obsGraph), 'count shape must match across providers');
  });

  test('a concept-first vault (edgeless resolved graph) reports 0 resolved edges but unresolved links', async () => {
    // A vault of standalone notes whose only links are [[Concept]] to notes that
    // do not exist → the resolved graph is edgeless, but the counts show WHY.
    const conceptDir = createTempVault({
      'A.md': 'Points at [[Concept One]] and [[Concept Two]].',
      'B.md': 'Points at [[Concept One]] again.',
    });
    try {
      const g = await buildVaultGraph(conceptDir, new FilesystemProvider());
      assert.equal(g.resolvedEdgeCount, 0, 'edgeless resolved graph');
      assert.equal(g.unresolvedLinkCount, 3, 'three unresolved concept-link occurrences');
      assert.equal(g.distinctUnresolvedTargets, 2, 'two distinct concepts');
    } finally {
      cleanup(conceptDir);
    }
  });

  test('Obsidian provider SKIPS a cross-vault raw key and counts the rest', async () => {
    // Feed the eval mock a RAW unresolvedRaw map that includes a cross-vault key.
    // The shared helper must skip "OtherVault:Thing" (cross-vault) while counting
    // "Ghost" (2) and "Principle Keywords: Breathe" (a same-vault title whose
    // colon is preceded by a space → NOT cross-vault). Expect count 3, distinct 2.
    //
    // Fresh temp vault → fresh stat-digest → guaranteed BaseGraph cache MISS, so
    // the mock's unresolvedRaw is actually exercised (the cache key does not
    // include the mock payload). Without the cross-vault skip this would report
    // count 4 / distinct 3 (the pre-fix raw-key aggregation) → this test FAILS
    // against the pre-fix behavior.
    const skipDir = createTempVault({ 'Solo.md': 'A standalone note.' });
    graphMod.clearGraphCaches();
    const savedNodes = mockNodes, savedLinks = mockLinks, savedRaw = mockUnresolvedRaw;
    try {
      mockNodes = ['Solo.md'];
      mockLinks = {};
      mockUnresolvedRaw = {
        'OtherVault:Thing': 1,
        'Ghost': 2,
        'Principle Keywords: Breathe': 1,
      };
      const g = await buildVaultGraph(skipDir, new ObsidianProvider(config, undefined));
      assert.equal(g.provider, 'obsidian');
      assert.equal(g.resolvedEdgeCount, 0, 'no resolved edges');
      assert.equal(g.unresolvedLinkCount, 3, 'cross-vault key skipped; Ghost(2)+Principle(1)=3');
      assert.equal(g.distinctUnresolvedTargets, 2, 'distinct = Ghost, Principle Keywords: Breathe');
    } finally {
      mockNodes = savedNodes;
      mockLinks = savedLinks;
      mockUnresolvedRaw = savedRaw;
      graphMod.clearGraphCaches();
      cleanup(skipDir);
    }
  });

  test('provider parity on a cross-vault + repeated-headed-link set (real normalization both sides)', async () => {
    // Fixture: Note1 links Note2 (resolved), Ghost#Heading A + Ghost#Heading B
    // (unresolved, collapse to Ghost), and OtherVault:Thing (cross-vault → skip).
    // Note2 links Note1 (resolved) and Ghost#Heading A (unresolved).
    // FS: resolvedEdgeCount 2, unresolvedLinkCount 3 (Ghost×3), distinct 1.
    const parityDir = createTempVault({
      'Note1.md':
        'To [[Note2]] and [[Ghost#Heading A]] and [[Ghost#Heading B]] and [[OtherVault:Thing]].',
      'Note2.md': 'Back to [[Note1]] and [[Ghost#Heading A]].',
    });
    graphMod.clearGraphCaches();
    const savedNodes = mockNodes, savedLinks = mockLinks, savedRaw = mockUnresolvedRaw;
    try {
      // What Obsidian WOULD emit for that vault: resolved Note1↔Note2, and RAW
      // unresolved keys (Obsidian strips #/| → "Ghost", summed ×3) plus the
      // cross-vault raw key it records verbatim.
      mockNodes = ['Note1.md', 'Note2.md'];
      mockLinks = { 'Note1.md': { 'Note2.md': 1 }, 'Note2.md': { 'Note1.md': 1 } };
      mockUnresolvedRaw = { 'Ghost': 3, 'OtherVault:Thing': 1 };

      const fsGraph = await buildVaultGraph(parityDir, new FilesystemProvider());
      const obsGraph = await buildVaultGraph(parityDir, new ObsidianProvider(config, undefined));

      const shape = (g) => ({
        resolvedEdgeCount: g.resolvedEdgeCount,
        unresolvedLinkCount: g.unresolvedLinkCount,
        distinctUnresolvedTargets: g.distinctUnresolvedTargets,
      });
      assert.deepEqual(shape(fsGraph), {
        resolvedEdgeCount: 2,
        unresolvedLinkCount: 3,
        distinctUnresolvedTargets: 1,
      }, 'fs: cross-vault skipped, Ghost headings collapse to 1 distinct');
      assert.deepEqual(shape(fsGraph), shape(obsGraph), 'count shape must match across providers');
    } finally {
      mockNodes = savedNodes;
      mockLinks = savedLinks;
      mockUnresolvedRaw = savedRaw;
      graphMod.clearGraphCaches();
      cleanup(parityDir);
    }
  });
});
