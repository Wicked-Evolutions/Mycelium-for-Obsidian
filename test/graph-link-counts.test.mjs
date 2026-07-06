/**
 * L4 vault-level link-count aggregates (issue #37).
 *
 * The three provider-independent counts surfaced by analyze_link_hierarchy:
 *   resolvedEdgeCount       — RESOLVED same-vault occurrences forming edges
 *   unresolvedLinkCount     — UNRESOLVED same-vault occurrences (with multiplicity)
 *   distinctUnresolvedTargets — UNIQUE unresolved same-vault target keys
 *
 * Verifies (with --experimental-test-module-mocks):
 *   (1) Obsidian provider reads app.metadataCache.unresolvedLinks (MOCKED eval)
 *       and aggregates the counts.
 *   (2) Filesystem provider derives the same counts from resolution misses on a
 *       fixture that has BOTH resolved and unresolved links.
 *   (3) Provider parity: for equivalent content both providers yield the SAME
 *       count shape.
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
// The Obsidian provider's eval aggregates unresolvedLinks INSIDE Obsidian, so
// the mock returns the already-aggregated { unresolvedCount, unresolvedDistinct }
// alongside { nodes, links } — exactly the JSON the real eval string produces.
// ---------------------------------------------------------------------------
let mockNodes = [];
let mockLinks = {};
let mockUnresolvedCount = 0;
let mockUnresolvedDistinct = 0;

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
          unresolvedCount: mockUnresolvedCount,
          unresolvedDistinct: mockUnresolvedDistinct,
        }),
      isCliAvailable: async () => true,
    },
  });
}

const { loadConfig } = await import('../dist/config.js');
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
    mockUnresolvedCount = 3;
    mockUnresolvedDistinct = 2;
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

  test('Obsidian provider aggregates metadataCache.unresolvedLinks (mocked eval)', async () => {
    const g = await buildVaultGraph(dir, new ObsidianProvider(config, undefined));
    assert.equal(g.provider, 'obsidian');
    assert.equal(g.resolvedEdgeCount, 2, 'resolvedEdgeCount from filtered resolvedLinks');
    assert.equal(g.unresolvedLinkCount, 3, 'unresolvedLinkCount = sum of unresolvedLinks counts');
    assert.equal(g.distinctUnresolvedTargets, 2, 'distinctUnresolvedTargets = unique target keys');
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
});
