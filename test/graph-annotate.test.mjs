/**
 * graph-annotate.test.mjs — Convergence (#23) PURE unit tests.
 *
 * No Ollama, no real graph build, no temp vault. Exercises the load-bearing
 * path JOIN and the guarded one-call orchestration directly with synthetic
 * signal maps and result arrays.
 *
 * Must-pass coverage (per the ratified build prompt):
 *   1. normal hit            → graph.level !== null && graph.pagerank !== null
 *   2. excluded hit          → graph.excluded === true && graph.level === null
 *                              && graph.pagerank === null
 *   3. NFC vs NFD filename    → join resolves in BOTH directions
 *   4. ordering byte-identical by path before/after annotation
 *   5. getGraphSignals throws → attachGraphSignals returns un-annotated results,
 *                              graphAvailable:false, never throws (caller stays
 *                              isError:false)
 *
 * Run: node --test test/graph-annotate.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { annotateWithGraph, attachGraphSignals, annotateCrossVault } = await import(
  '../dist/tools/graph-annotate.js'
);

// ---------------------------------------------------------------------------
// Synthetic NodeSignals builders (mirror src/graph/types.ts NodeSignals shape)
// ---------------------------------------------------------------------------

function normalSig(overrides = {}) {
  return {
    level: 2,
    inDegree: 5,
    outDegree: 3,
    inOutRatio: 5 / 3,
    pagerank: 0.0123,
    archived: false,
    excluded: false,
    ...overrides,
  };
}

function excludedSig(overrides = {}) {
  // Excluded nodes carry null level/pagerank + raw degree (per getGraphSignals).
  return {
    level: null,
    inDegree: 2,
    outDegree: 4,
    inOutRatio: 2 / 4,
    pagerank: null,
    archived: true,
    excluded: true,
    ...overrides,
  };
}

// A NFD vs NFC clash: "é" composed (NFC, U+00E9) vs decomposed (NFD, e + U+0301).
const NAME_NFC = 'Café'.normalize('NFC');
const NAME_NFD = 'Café'.normalize('NFD');
assert.notEqual(NAME_NFC, NAME_NFD, 'sanity: NFC and NFD byte forms differ');

// ---------------------------------------------------------------------------
// Test 1 — normal hit gets real level + pagerank (join-with-teeth)
// ---------------------------------------------------------------------------

describe('annotateWithGraph — normal hit (join with teeth)', () => {
  test('a known non-excluded path gets non-null level AND pagerank', () => {
    const signalsMap = new Map([['Hub.md', normalSig({ level: 0, pagerank: 0.42 })]]);
    const results = [{ path: 'Hub.md', title: 'Hub' }];

    const out = annotateWithGraph(results, signalsMap);

    assert.equal(out.length, 1, 'same length');
    assert.ok(out[0].graph, 'graph block present (not null)');
    assert.notEqual(out[0].graph.level, null, 'level is NOT null for a normal hit');
    assert.equal(out[0].graph.level, 0, 'level value passed through');
    assert.notEqual(out[0].graph.pagerank, null, 'pagerank is NOT null for a normal hit');
    assert.equal(out[0].graph.pagerank, 0.42, 'pagerank value passed through');
    assert.equal(out[0].graph.excluded, false, 'excluded false for a normal hit');
    // raw signals carried through verbatim (no interpreted prose)
    assert.equal(out[0].graph.inDegree, 5, 'inDegree passed through');
    assert.equal(out[0].graph.outDegree, 3, 'outDegree passed through');
    assert.equal(typeof out[0].graph.inOutRatio, 'number', 'inOutRatio is a number');
    // original fields preserved
    assert.equal(out[0].path, 'Hub.md', 'path preserved');
    assert.equal(out[0].title, 'Hub', 'title preserved');
  });

  test('a per-hit MISS yields graph:null (key present, never omitted)', () => {
    const signalsMap = new Map([['Hub.md', normalSig()]]);
    const results = [{ path: 'NotInGraph.md', title: 'Drift' }];

    const out = annotateWithGraph(results, signalsMap);

    assert.equal(out.length, 1, 'same length');
    assert.ok('graph' in out[0], 'graph key is present');
    assert.equal(out[0].graph, null, 'graph is null on a miss');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — generated/index/archive hit is flagged excluded with null rank
// ---------------------------------------------------------------------------

describe('annotateWithGraph — excluded hit (Level B flag-only)', () => {
  test('an excluded path: graph.excluded===true, level===null, pagerank===null', () => {
    const signalsMap = new Map([
      ['gen/_manifest.md', excludedSig()],
    ]);
    const results = [{ path: 'gen/_manifest.md', title: 'Manifest' }];

    const out = annotateWithGraph(results, signalsMap);

    assert.ok(out[0].graph, 'graph block present (a non-null object, NOT graph:null)');
    assert.equal(out[0].graph.excluded, true, 'excluded === true');
    assert.equal(out[0].graph.level, null, 'level === null for excluded');
    assert.equal(out[0].graph.pagerank, null, 'pagerank === null for excluded');
    assert.equal(out[0].graph.archived, true, 'archived === true for excluded');
    // raw degree STILL reported even when excluded
    assert.equal(out[0].graph.inDegree, 2, 'raw inDegree present for excluded');
    assert.equal(out[0].graph.outDegree, 4, 'raw outDegree present for excluded');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — NFC vs NFD filename join resolves in BOTH directions
// ---------------------------------------------------------------------------

describe('annotateWithGraph — NFC/NFD unicode join', () => {
  test('map key NFD, hit path NFC → join resolves', () => {
    const signalsMap = new Map([[`${NAME_NFD}.md`, normalSig({ level: 1 })]]);
    const results = [{ path: `${NAME_NFC}.md`, title: 'cafe' }];

    const out = annotateWithGraph(results, signalsMap);

    assert.ok(out[0].graph, 'graph block resolved despite NFD-key / NFC-hit clash');
    assert.equal(out[0].graph.level, 1, 'correct signals joined');
  });

  test('map key NFC, hit path NFD → join resolves', () => {
    const signalsMap = new Map([[`${NAME_NFC}.md`, normalSig({ level: 3 })]]);
    const results = [{ path: `${NAME_NFD}.md`, title: 'cafe' }];

    const out = annotateWithGraph(results, signalsMap);

    assert.ok(out[0].graph, 'graph block resolved despite NFC-key / NFD-hit clash');
    assert.equal(out[0].graph.level, 3, 'correct signals joined');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — ordering byte-identical by path before/after annotation
// ---------------------------------------------------------------------------

describe('annotateWithGraph — ordering preserved (no reorder)', () => {
  test('result path order is byte-identical before and after annotation', () => {
    // Deliberately NOT sorted; mixed hits/misses/excluded interleaved.
    const signalsMap = new Map([
      ['b.md', normalSig({ pagerank: 0.9 })],   // high rank, but in the MIDDLE
      ['a.md', excludedSig()],
      ['d.md', normalSig({ pagerank: 0.01 })],  // low rank, but LAST input
    ]);
    const results = [
      { path: 'd.md' },        // low pagerank first
      { path: 'a.md' },        // excluded
      { path: 'miss.md' },     // not in graph
      { path: 'b.md' },        // high pagerank last
    ];
    const before = results.map((r) => r.path);

    const out = annotateWithGraph(results, signalsMap);
    const after = out.map((r) => r.path);

    assert.deepEqual(after, before, 'path order unchanged (no centrality reorder)');
    assert.equal(out.length, results.length, 'no hide/filter — same length');
    // input array not mutated
    assert.equal(results[0].graph, undefined, 'input results not mutated in place');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — getGraphSignals throwing → graceful degrade, never errors
// ---------------------------------------------------------------------------

describe('attachGraphSignals — global failure graceful degrade', () => {
  test('injected throwing getSignals → graphAvailable:false, results un-annotated, no throw', async () => {
    const results = [
      { path: 'Hub.md', title: 'Hub', fusionScore: 0.03 },
      { path: 'Mid.md', title: 'Mid', fusionScore: 0.02 },
    ];

    const throwingGetSignals = async () => {
      throw new Error('graph build exploded');
    };

    // Must NOT throw.
    const out = await attachGraphSignals({
      config: {},               // unused on the failure path
      vault: 'TestVault',
      results,
      getSignals: throwingGetSignals,
    });

    assert.equal(out.graphAvailable, false, 'graphAvailable is false on global failure');
    assert.equal(typeof out.graphUnavailableReason, 'string', 'a reason is provided');
    assert.ok(
      out.graphUnavailableReason.includes('graph build exploded'),
      'reason surfaces the underlying error',
    );
    // results present + un-annotated (no graph key), order intact
    assert.equal(out.results.length, 2, 'all results returned');
    assert.deepEqual(out.results.map((r) => r.path), ['Hub.md', 'Mid.md'], 'order intact');
    for (const r of out.results) {
      assert.ok(!('graph' in r), 'results are un-annotated (no graph key) on failure');
    }
    // No activeExclude / usedDefaultExclude echoed when unavailable
    assert.equal(out.activeExclude, undefined, 'no activeExclude when unavailable');
    assert.equal(out.usedDefaultExclude, undefined, 'no usedDefaultExclude when unavailable');
  });

  test('success path: annotates + echoes activeExclude + usedDefaultExclude', async () => {
    const results = [{ path: 'Hub.md', title: 'Hub' }];
    const fakeSignals = {
      vault: 'TestVault',
      provider: 'filesystem',
      signals: new Map([['Hub.md', normalSig({ level: 0, pagerank: 0.5 })]]),
      activeExclude: [{ field: 'node_type', op: 'in', value: ['generated'] }],
      usedDefaultExclude: true,
      excludedCount: 0,
      totalNodes: 1,
      smallVault: false,
    };

    const out = await attachGraphSignals({
      config: {},
      vault: 'TestVault',
      results,
      getSignals: async () => fakeSignals,
    });

    assert.equal(out.graphAvailable, true, 'graphAvailable true on success');
    assert.ok(out.results[0].graph, 'hit annotated');
    assert.equal(out.results[0].graph.level, 0, 'level joined');
    assert.equal(out.results[0].graph.pagerank, 0.5, 'pagerank joined');
    assert.ok(Array.isArray(out.activeExclude), 'activeExclude echoed');
    assert.equal(out.usedDefaultExclude, true, 'usedDefaultExclude echoed');
    // PR-A (#25): provider surfaced additively on success.
    assert.equal(out.provider, 'filesystem', 'provider surfaced on success');
  });

  test('failure path: provider is OMITTED (genuinely unknown when build threw)', async () => {
    const out = await attachGraphSignals({
      config: {},
      vault: 'TestVault',
      results: [{ path: 'Hub.md' }],
      getSignals: async () => { throw new Error('boom'); },
    });
    assert.equal(out.graphAvailable, false, 'graphAvailable false on failure');
    assert.ok(!('provider' in out), 'provider key omitted on failure (unknown)');
  });
});

// ---------------------------------------------------------------------------
// Provider-key contract — Obsidian-eval provider key form
//
// Both providers emit vault-relative `.md` keys; the Obsidian-eval provider
// keys nodes via `app.vault.getMarkdownFiles().map(f => f.path)` (vault-relative
// with .md, INCLUDING subfolder paths). This is a regression guard that the
// JOIN resolves for that exact key form — with TEETH (level + pagerank non-null),
// and a representative SUBFOLDER path so a flat-name shortcut can't pass it.
// ---------------------------------------------------------------------------

describe('annotateWithGraph — Obsidian-eval provider-key contract (headless, mocked)', () => {
  test('join resolves for getMarkdownFiles().path key form incl. a subfolder path', () => {
    // Mocked eval-provider signals map: keys are EXACTLY the form
    // app.vault.getMarkdownFiles().map(f => f.path) returns — vault-relative .md,
    // forward-slash separators, subfolders included.
    const signalsMap = new Map([
      ['Hub.md', normalSig({ level: 0, pagerank: 0.42 })],
      ['Sub/Folder/Deep Note.md', normalSig({ level: 2, pagerank: 0.07 })],
    ]);
    // Hits as semantic_search_all would emit them: the stored vault-relative path.
    const results = [
      { path: 'Hub.md', title: 'Hub' },
      { path: 'Sub/Folder/Deep Note.md', title: 'Deep Note' },
    ];

    const out = annotateWithGraph(results, signalsMap);

    // Flat path join-with-teeth.
    assert.ok(out[0].graph, 'flat path joined to a graph block');
    assert.notEqual(out[0].graph.level, null, 'flat: level not null');
    assert.equal(out[0].graph.level, 0, 'flat: level value');
    assert.notEqual(out[0].graph.pagerank, null, 'flat: pagerank not null');
    assert.equal(out[0].graph.pagerank, 0.42, 'flat: pagerank value');

    // Subfolder path join-with-teeth (the representative case).
    assert.ok(out[1].graph, 'subfolder path joined to a graph block');
    assert.notEqual(out[1].graph.level, null, 'subfolder: level not null');
    assert.equal(out[1].graph.level, 2, 'subfolder: level value');
    assert.notEqual(out[1].graph.pagerank, null, 'subfolder: pagerank not null');
    assert.equal(out[1].graph.pagerank, 0.07, 'subfolder: pagerank value');
  });
});

// ---------------------------------------------------------------------------
// Cross-vault orchestration (PR-A / #25) — annotateCrossVault
//
// Headless: injects a fake/spy getSignals. No Ollama, no real graph build.
//   1. cost-minimizer  — getSignals called ONLY for vaults WITH hits
//   2. isolation       — one vault's getSignals throws → that vault un-annotated
//                        with its OWN reason, OTHER vaults still annotated
//   3. ordering        — global (similarity-desc) order preserved exactly
//   4. duplicate path  — Alpha.md in two vaults never cross-annotates (identity)
//   5. per-vault map   — graphByVault carries graphAvailable + provider per vault
// ---------------------------------------------------------------------------

describe('annotateCrossVault — cost-minimizer + isolation + per-vault map', () => {
  test('getSignals is called ONCE PER VAULT WITH HITS (hit-less vault → zero calls)', async () => {
    // Two vaults appear in results; a THIRD configured vault has no hits and must
    // never be queried. The spy records every vault name it is called with.
    const calledFor = [];
    const spyGetSignals = async (_config, vaultName) => {
      calledFor.push(vaultName);
      return {
        vault: vaultName,
        provider: 'filesystem',
        signals: new Map([['x.md', normalSig()]]),
        activeExclude: [],
        usedDefaultExclude: true,
        excludedCount: 0,
        totalNodes: 1,
        smallVault: false,
      };
    };

    const results = [
      { vault: 'VaultA', path: 'a1.md', similarity: 0.9 },
      { vault: 'VaultB', path: 'b1.md', similarity: 0.8 },
      { vault: 'VaultA', path: 'a2.md', similarity: 0.7 },
    ];

    const out = await annotateCrossVault({ config: {}, results, getSignals: spyGetSignals });

    // EXACTLY one call per distinct vault WITH hits — VaultA once, VaultB once.
    assert.equal(calledFor.length, 2, 'one getSignals call per vault with hits');
    assert.deepEqual([...calledFor].sort(), ['VaultA', 'VaultB'], 'only hit-bearing vaults queried');
    // A vault that never appears in results (e.g. "VaultC") got ZERO calls — implicit
    // in the count above (it is not in `calledFor`).
    assert.ok(!calledFor.includes('VaultC'), 'hit-less vault never queried');
  });

  test('one vault throwing isolates: that vault un-annotated (own reason), others annotated', async () => {
    const getSignals = async (_config, vaultName) => {
      if (vaultName === 'VaultB') {
        throw new Error('VaultB graph build exploded');
      }
      return {
        vault: vaultName,
        provider: 'obsidian',
        signals: new Map([
          ['a1.md', normalSig({ level: 1, pagerank: 0.3 })],
        ]),
        activeExclude: [],
        usedDefaultExclude: true,
        excludedCount: 0,
        totalNodes: 1,
        smallVault: false,
      };
    };

    const results = [
      { vault: 'VaultA', path: 'a1.md', similarity: 0.9 },
      { vault: 'VaultB', path: 'b1.md', similarity: 0.8 },
    ];

    const out = await annotateCrossVault({ config: {}, results, getSignals });

    // VaultA hit is annotated (its build succeeded).
    const aHit = out.results.find((r) => r.vault === 'VaultA');
    assert.ok('graph' in aHit, 'VaultA hit annotated (graph key present)');
    assert.ok(aHit.graph, 'VaultA graph block present');
    assert.equal(aHit.graph.level, 1, 'VaultA level joined');

    // VaultB hit is UN-annotated (no graph key) — its own failure.
    const bHit = out.results.find((r) => r.vault === 'VaultB');
    assert.ok(!('graph' in bHit), 'VaultB hit un-annotated (no graph key) on its own failure');

    // Per-vault map reflects each vault's own state.
    assert.equal(out.graphByVault.VaultA.graphAvailable, true, 'VaultA graphAvailable true');
    assert.equal(out.graphByVault.VaultA.provider, 'obsidian', 'VaultA provider surfaced');
    assert.equal(out.graphByVault.VaultB.graphAvailable, false, 'VaultB graphAvailable false');
    assert.equal(typeof out.graphByVault.VaultB.graphUnavailableReason, 'string', 'VaultB has a reason');
    assert.ok(
      out.graphByVault.VaultB.graphUnavailableReason.includes('VaultB graph build exploded'),
      'VaultB reason surfaces its OWN underlying error',
    );
    assert.ok(!('provider' in out.graphByVault.VaultB), 'failed vault omits provider (unknown)');
  });

  test('ordering is preserved byte-identical (global similarity-desc untouched)', async () => {
    const getSignals = async (_config, vaultName) => ({
      vault: vaultName,
      provider: 'filesystem',
      signals: new Map([
        ['a1.md', normalSig({ pagerank: 0.01 })],
        ['b1.md', normalSig({ pagerank: 0.99 })],
      ]),
      activeExclude: [],
      usedDefaultExclude: true,
      excludedCount: 0,
      totalNodes: 2,
      smallVault: false,
    });

    // Interleaved vaults; high-pagerank node sits in the MIDDLE of the order.
    const results = [
      { vault: 'VaultA', path: 'a1.md', similarity: 0.9 },
      { vault: 'VaultB', path: 'b1.md', similarity: 0.8 },
      { vault: 'VaultA', path: 'miss.md', similarity: 0.5 },
    ];
    const before = results.map((r) => `${r.vault}:${r.path}`);

    const out = await annotateCrossVault({ config: {}, results, getSignals });
    const after = out.results.map((r) => `${r.vault}:${r.path}`);

    assert.deepEqual(after, before, 'order unchanged (no graph reorder)');
    assert.equal(out.results.length, results.length, 'no hide/filter — same length');
    // miss within a successfully-built vault → graph: null (key present).
    const miss = out.results.find((r) => r.path === 'miss.md');
    assert.ok('graph' in miss, 'miss carries the graph key');
    assert.equal(miss.graph, null, 'miss → graph null (single-vault parity)');
  });

  test('duplicate filename across vaults never cross-annotates (identity merge)', async () => {
    // Alpha.md exists in BOTH vaults; each vault has its OWN signals for Alpha.md.
    const getSignals = async (_config, vaultName) => {
      const level = vaultName === 'VaultA' ? 0 : 5;
      const pagerank = vaultName === 'VaultA' ? 0.9 : 0.1;
      return {
        vault: vaultName,
        provider: 'filesystem',
        signals: new Map([['Alpha.md', normalSig({ level, pagerank })]]),
        activeExclude: [],
        usedDefaultExclude: true,
        excludedCount: 0,
        totalNodes: 1,
        smallVault: false,
      };
    };

    const results = [
      { vault: 'VaultA', path: 'Alpha.md', similarity: 0.9 },
      { vault: 'VaultB', path: 'Alpha.md', similarity: 0.8 },
    ];

    const out = await annotateCrossVault({ config: {}, results, getSignals });

    const a = out.results.find((r) => r.vault === 'VaultA');
    const b = out.results.find((r) => r.vault === 'VaultB');
    assert.equal(a.graph.level, 0, 'VaultA Alpha gets VaultA signals');
    assert.equal(a.graph.pagerank, 0.9, 'VaultA Alpha pagerank from VaultA');
    assert.equal(b.graph.level, 5, 'VaultB Alpha gets VaultB signals (no cross-annotate)');
    assert.equal(b.graph.pagerank, 0.1, 'VaultB Alpha pagerank from VaultB');
  });

  test('empty results → no getSignals calls, empty per-vault map', async () => {
    let calls = 0;
    const out = await annotateCrossVault({
      config: {},
      results: [],
      getSignals: async () => { calls++; return {}; },
    });
    assert.equal(calls, 0, 'no calls for zero results');
    assert.deepEqual(out.results, [], 'empty results passthrough');
    assert.deepEqual(out.graphByVault, {}, 'empty per-vault map');
  });
});
