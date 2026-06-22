/**
 * L4 provider-contract test.
 *
 * Verifies (with --experimental-test-module-mocks):
 *   (1) The Obsidian provider (eval bridge → resolvedLinks, MOCKED) and the
 *       filesystem provider yield the SAME normalized edge shape for the same
 *       synthetic vault.
 *   (2) Provider selection respects OBSIDIAN_DISABLED_TOOLS=eval_obsidian and
 *       isCliAvailable(): a disabled eval tool forces the filesystem fallback,
 *       and evalInObsidian is NEVER called behind a disabled tool.
 *
 * Without the experimental flag, mock.module is undefined → the mocked layer
 * skips (it does not fail).
 */

import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

const canMock = typeof mock.module === 'function';

// ---------------------------------------------------------------------------
// Bridge mock — must be installed BEFORE importing the graph modules.
// ---------------------------------------------------------------------------
let evalCalled = 0;
let isCliAvailableReturn = true;
let mockResolvedLinks = {}; // source(.md) -> { target(.md) -> count }
let mockNodes = [];

const BRIDGE_SPECIFIER = new URL('../dist/cli/bridge.js', import.meta.url).href;

if (canMock) {
  await mock.module(BRIDGE_SPECIFIER, {
    namedExports: {
      execCli: async () => '',
      execCliForVault: async () => '',
      evalInObsidian: async (_config, _vault, _code) => {
        evalCalled += 1;
        // The provider expects a JSON string of { nodes, links }.
        return JSON.stringify({ nodes: mockNodes, links: mockResolvedLinks });
      },
      isCliAvailable: async () => isCliAvailableReturn,
    },
  });
}

// Import AFTER the mock is registered.
const { loadConfig } = await import('../dist/config.js');
const graphMod = await import('../dist/graph/index.js');
const { FilesystemProvider, ObsidianProvider, selectProvider, buildVaultGraph } = graphMod;

// ---------------------------------------------------------------------------
// A synthetic vault whose links are unambiguous (so the fs heuristic and the
// "Obsidian resolvedLinks" agree on the exact same edges).
// ---------------------------------------------------------------------------
function buildVault() {
  return {
    'Hub.md': 'See [[A]] and [[B]] and again [[A]].',
    'A.md': 'Back to [[Hub]].',
    'B.md': 'Back to [[Hub]] and [[A]].',
  };
}

// The resolvedLinks Obsidian WOULD produce for the vault above (with .md keys).
function expectedResolvedLinks() {
  return {
    'Hub.md': { 'A.md': 2, 'B.md': 1 },
    'A.md': { 'Hub.md': 1 },
    'B.md': { 'Hub.md': 1, 'A.md': 1 },
  };
}

/**
 * Normalize a BaseGraph into a comparable edge-shape: a sorted list of
 * "source|target|count" strings + the node set.
 */
function edgeShape(graph) {
  const edges = graph.edges
    .map((e) => `${e.source}|${e.target}|${e.count}`)
    .sort();
  const nodes = [...graph.nodes].sort();
  return { edges, nodes };
}

describe('provider-contract (mocked eval)', { skip: !canMock ? 'requires --experimental-test-module-mocks' : false }, () => {
  let dir, config;

  before(() => {
    graphMod.clearGraphCaches();
    dir = createTempVault(buildVault());
    process.env.OBSIDIAN_VAULT_PATH = dir;
    process.env.OBSIDIAN_DISABLED_TOOLS = '';
    delete process.env.OBSIDIAN_VAULTS;
    config = loadConfig();
    mockResolvedLinks = expectedResolvedLinks();
    mockNodes = ['Hub.md', 'A.md', 'B.md'];
    evalCalled = 0;
    isCliAvailableReturn = true;
  });

  after(() => {
    if (dir) cleanup(dir);
    graphMod.clearGraphCaches();
  });

  test('filesystem and Obsidian providers yield the same edge shape', async () => {
    const fsGraph = await buildVaultGraph(dir, new FilesystemProvider());
    const obsGraph = await buildVaultGraph(dir, new ObsidianProvider(config, undefined));

    assert.equal(fsGraph.provider, 'filesystem');
    assert.equal(obsGraph.provider, 'obsidian');
    assert.ok(evalCalled > 0, 'Obsidian provider must call evalInObsidian');

    assert.deepEqual(
      edgeShape(fsGraph),
      edgeShape(obsGraph),
      'normalized edge shape must match across providers'
    );
  });

  test('selectProvider returns Obsidian when eval enabled + CLI available', async () => {
    isCliAvailableReturn = true;
    process.env.OBSIDIAN_DISABLED_TOOLS = '';
    const cfg = loadConfig();
    const p = await selectProvider(cfg, undefined);
    assert.equal(p.name, 'obsidian');
  });

  test('disabled eval_obsidian forces filesystem fallback (eval NEVER called)', async () => {
    isCliAvailableReturn = true; // CLI is up, but the tool is disabled
    process.env.OBSIDIAN_DISABLED_TOOLS = 'eval_obsidian';
    const cfg = loadConfig();

    const before = evalCalled;
    const p = await selectProvider(cfg, undefined);
    assert.equal(p.name, 'filesystem', 'disabled eval → filesystem provider');

    // Build through it — must not touch the eval bridge.
    await p.build(dir);
    assert.equal(evalCalled, before, 'evalInObsidian must NOT be called behind a disabled tool');
  });

  test('CLI unavailable forces filesystem fallback', async () => {
    isCliAvailableReturn = false;
    process.env.OBSIDIAN_DISABLED_TOOLS = '';
    const cfg = loadConfig();
    const p = await selectProvider(cfg, undefined);
    assert.equal(p.name, 'filesystem', 'no CLI → filesystem provider');
  });

  test('Obsidian provider that throws degrades to filesystem (same nodes)', async () => {
    // Force the eval to throw by returning unparseable output, via build() path.
    const broken = new ObsidianProvider(config, undefined);
    const origBuild = broken.build.bind(broken);
    broken.build = async () => {
      throw new Error('simulated Obsidian failure');
    };
    const graph = await buildVaultGraph(dir, broken);
    assert.equal(graph.provider, 'filesystem', 'failed Obsidian build degrades to filesystem');
    // sanity: still produced the vault nodes
    assert.ok(graph.nodes.includes('Hub.md'));
    void origBuild;
  });
});
