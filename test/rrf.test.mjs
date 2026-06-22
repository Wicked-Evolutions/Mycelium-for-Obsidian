/**
 * rrf.test.mjs — offline tests for src/embeddings/rrf.ts
 *
 * Pure functions, no Ollama. Values hand-computed against the standard RRF
 * formula 1/(k+rank) with k=60 (the module const).
 *
 * Run: node --test test/rrf.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, RRF_K } from '../dist/embeddings/rrf.js';

const approx = (a, b, eps = 1e-12) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

describe('RRF_K constant', () => {
  test('is 60', () => {
    assert.equal(RRF_K, 60);
  });
});

describe('reciprocalRankFusion', () => {
  test('single signal: score = 1/(k+rank), order preserved', () => {
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['a', 'b', 'c'] },
    ]);
    assert.deepEqual(fused.map(r => r.id), ['a', 'b', 'c']);
    approx(fused[0].fusionScore, 1 / (RRF_K + 1));
    approx(fused[1].fusionScore, 1 / (RRF_K + 2));
    approx(fused[2].fusionScore, 1 / (RRF_K + 3));
  });

  test('two signals: a appears in both, sums both terms', () => {
    // bm25:        a@1, b@2
    // embeddings:  b@1, a@2
    // a = 1/61 + 1/62 ; b = 1/62 + 1/61  → equal scores → tie-break by id asc
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['a', 'b'] },
      { name: 'embeddings', ranked: ['b', 'a'] },
    ]);
    const expected = 1 / (RRF_K + 1) + 1 / (RRF_K + 2);
    approx(fused[0].fusionScore, expected);
    approx(fused[1].fusionScore, expected);
    // deterministic tie-break: 'a' before 'b'
    assert.deepEqual(fused.map(r => r.id), ['a', 'b']);
  });

  test('union-safe: doc absent from a signal contributes 0 (not 1/(k+0))', () => {
    // bm25 only has 'x'; embeddings only has 'y'
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['x'] },
      { name: 'embeddings', ranked: ['y'] },
    ]);
    const byId = Object.fromEntries(fused.map(r => [r.id, r]));
    // x: present in bm25@1, absent in embeddings
    approx(byId.x.fusionScore, 1 / (RRF_K + 1));
    assert.equal(byId.x.perSignal.bm25.rank, 1);
    assert.equal(byId.x.perSignal.embeddings.rank, null);
    assert.equal(byId.x.perSignal.embeddings.term, 0);
    // y: symmetric
    approx(byId.y.fusionScore, 1 / (RRF_K + 1));
    assert.equal(byId.y.perSignal.embeddings.rank, 1);
    assert.equal(byId.y.perSignal.bm25.rank, null);
  });

  test('doc in both signals outranks docs in one (the RRF win condition)', () => {
    // shared 'a' is rank 3 in both; 'top' is rank 1 in bm25 only.
    // a = 1/63 + 1/63 = 2/63 ≈ 0.03175
    // top = 1/61 ≈ 0.01639  → a wins.
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['top', 'mid', 'a'] },
      { name: 'embeddings', ranked: ['e1', 'e2', 'a'] },
    ]);
    assert.equal(fused[0].id, 'a', 'doc present in both signals ranks first');
    approx(fused[0].fusionScore, 2 / (RRF_K + 3));
  });

  test('perSignal terms reconstruct fusionScore exactly', () => {
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['a', 'b'] },
      { name: 'embeddings', ranked: ['b', 'a'] },
    ]);
    for (const r of fused) {
      const sum = Object.values(r.perSignal).reduce((acc, ps) => acc + ps.term, 0);
      approx(sum, r.fusionScore);
    }
  });

  test('duplicate id within a signal keeps best (earliest) rank', () => {
    const fused = reciprocalRankFusion([
      { name: 'bm25', ranked: ['a', 'b', 'a'] },
    ]);
    const a = fused.find(r => r.id === 'a');
    assert.equal(a.perSignal.bm25.rank, 1, 'first occurrence wins');
    // 'a' and 'b' only — no duplicate row
    assert.equal(fused.length, 2);
  });

  test('empty input → empty output', () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
    assert.deepEqual(reciprocalRankFusion([{ name: 'bm25', ranked: [] }]), []);
  });
});
