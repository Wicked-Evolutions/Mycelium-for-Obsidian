/**
 * providerFallbackReason RESPONSE surfacing (issue #32).
 *
 * Confirms the additive `providerFallbackReason` reaches all THREE surfaces ONLY
 * on the attempted-Obsidian→filesystem fallback path, and is ABSENT on the
 * normal-filesystem and normal-obsidian-success paths:
 *   (a) analyze_link_hierarchy output      — handler (real getGraphSignals)
 *   (b) semantic_search graph metadata      — attachGraphSignals (injected signals)
 *   (c) semantic_search_all per-vault map    — annotateCrossVault (injected signals)
 *
 * Surfaces (b)/(c) use the injectable getSignals seam (no Ollama / no real graph
 * build). Surface (a) drives the real graph layer with the BRIDGE MOCKED so the
 * Obsidian provider is selected (isCliAvailable:true) and then throws.
 *
 * The handler path requires --experimental-test-module-mocks; the (b)/(c) cases
 * are pure and always run.
 */

import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

const canMock = typeof mock.module === 'function';

// ── Bridge mock (handler-level surface a) ────────────────────────────────────
let isCliAvailableReturn = true;
let evalShouldThrow = false;
let mockNodes = [];
let mockLinks = {};

const BRIDGE_SPECIFIER = new URL('../dist/cli/bridge.js', import.meta.url).href;

if (canMock) {
  await mock.module(BRIDGE_SPECIFIER, {
    namedExports: {
      execCli: async () => '',
      execCliForVault: async () => '',
      evalInObsidian: async () => {
        if (evalShouldThrow) {
          // ENOBUFS-style, multiline, with absolute paths — exactly what the #32
          // bug surfaced from execCli when the eval payload overran maxBuffer.
          throw new Error(
            'CLI error: spawn maxBuffer length exceeded (ENOBUFS) at /Users/wicked/dist/cli/bridge.js:48\n' +
              'stderr: /home/secret/vault leaked content'
          );
        }
        return JSON.stringify({ nodes: mockNodes, links: mockLinks });
      },
      isCliAvailable: async () => isCliAvailableReturn,
      OBSIDIAN_CLI_MAX_BUFFER: 256 * 1024 * 1024,
    },
  });
}

const { loadConfig } = await import('../dist/config.js');
const { createAllHandlers } = await import('../dist/tools/index.js');
const graphMod = await import('../dist/graph/index.js');
const { attachGraphSignals, annotateCrossVault } = await import('../dist/tools/graph-annotate.js');

function buildVault() {
  return {
    'Hub.md': 'See [[A]] and [[B]].',
    'A.md': 'Back to [[Hub]].',
    'B.md': 'Back to [[Hub]] and [[A]].',
  };
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

// ── (a) analyze_link_hierarchy ───────────────────────────────────────────────
describe('surface (a) analyze_link_hierarchy (#32)', { skip: !canMock ? 'requires --experimental-test-module-mocks' : false }, () => {
  let dir;
  before(() => {
    graphMod.clearGraphCaches();
    dir = createTempVault(buildVault());
    process.env.OBSIDIAN_VAULT_PATH = dir;
    process.env.OBSIDIAN_DISABLED_TOOLS = ''; // eval enabled → Obsidian selectable
    delete process.env.OBSIDIAN_VAULTS;
    mockNodes = ['Hub.md', 'A.md', 'B.md'];
    mockLinks = { 'Hub.md': { 'A.md': 1, 'B.md': 1 }, 'A.md': { 'Hub.md': 1 }, 'B.md': { 'Hub.md': 1, 'A.md': 1 } };
  });
  after(() => {
    if (dir) cleanup(dir);
    graphMod.clearGraphCaches();
  });

  test('Obsidian attempted+threw → provider:filesystem + providerFallbackReason present/sanitized', async () => {
    graphMod.clearGraphCaches();
    isCliAvailableReturn = true;
    evalShouldThrow = true;
    const h = createAllHandlers(loadConfig());
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.provider, 'filesystem');
    assert.ok(p.providerFallbackReason, 'reason present on fallback');
    assert.match(p.providerFallbackReason, /Obsidian/);
    assert.ok(!p.providerFallbackReason.includes('/Users'), 'no path leak');
    assert.ok(!p.providerFallbackReason.includes('/home'), 'no path leak');
    assert.ok(p.providerFallbackReason.length <= 280, 'bounded');
  });

  test('Obsidian success → NO providerFallbackReason', async () => {
    graphMod.clearGraphCaches();
    isCliAvailableReturn = true;
    evalShouldThrow = false;
    const h = createAllHandlers(loadConfig());
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.provider, 'obsidian');
    assert.equal(p.providerFallbackReason, undefined, 'absent on obsidian success');
  });

  test('normal filesystem (no Obsidian attempt) → NO providerFallbackReason', async () => {
    graphMod.clearGraphCaches();
    isCliAvailableReturn = false; // CLI down → filesystem selected normally
    evalShouldThrow = false;
    const h = createAllHandlers(loadConfig());
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.provider, 'filesystem');
    assert.equal(p.providerFallbackReason, undefined, 'absent on normal filesystem');
  });
});

// ── (b) semantic_search graph metadata (attachGraphSignals) ──────────────────
function fakeSignals(provider, providerFallbackReason) {
  return {
    vault: 'V',
    provider,
    ...(providerFallbackReason ? { providerFallbackReason } : {}),
    signals: new Map(),
    activeExclude: [],
    usedDefaultExclude: true,
    excludedCount: 0,
    totalNodes: 0,
    smallVault: true,
  };
}

describe('surface (b) attachGraphSignals (#32)', () => {
  test('fallback signals → graphAvailable:true + providerFallbackReason present', async () => {
    const out = await attachGraphSignals({
      config: {},
      vault: 'V',
      results: [{ path: 'X.md' }],
      getSignals: async () =>
        fakeSignals('filesystem', 'Obsidian graph provider failed: ENOBUFS; used filesystem approximation'),
    });
    assert.equal(out.graphAvailable, true);
    assert.equal(out.provider, 'filesystem');
    assert.match(out.providerFallbackReason, /Obsidian/);
  });

  test('obsidian-success signals → NO providerFallbackReason', async () => {
    const out = await attachGraphSignals({
      config: {},
      vault: 'V',
      results: [{ path: 'X.md' }],
      getSignals: async () => fakeSignals('obsidian', undefined),
    });
    assert.equal(out.graphAvailable, true);
    assert.equal(out.provider, 'obsidian');
    assert.equal(out.providerFallbackReason, undefined);
  });
});

// ── (c) semantic_search_all per-vault map (annotateCrossVault) ───────────────
describe('surface (c) annotateCrossVault per-vault map (#32)', () => {
  test('one vault fell back, one succeeded → only the fallback vault carries the reason', async () => {
    const out = await annotateCrossVault({
      config: {},
      results: [
        { path: 'A.md', vault: 'Fellback' },
        { path: 'B.md', vault: 'Clean' },
      ],
      getSignals: async (_config, vaultName) =>
        vaultName === 'Fellback'
          ? fakeSignals('filesystem', 'Obsidian graph provider failed: boom; used filesystem approximation')
          : fakeSignals('obsidian', undefined),
    });

    assert.equal(out.graphByVault.Fellback.graphAvailable, true);
    assert.equal(out.graphByVault.Fellback.provider, 'filesystem');
    assert.match(out.graphByVault.Fellback.providerFallbackReason, /Obsidian/);

    assert.equal(out.graphByVault.Clean.graphAvailable, true);
    assert.equal(out.graphByVault.Clean.provider, 'obsidian');
    assert.equal(out.graphByVault.Clean.providerFallbackReason, undefined);
  });
});
