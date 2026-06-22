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

const { annotateWithGraph, attachGraphSignals } = await import(
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
  });
});
