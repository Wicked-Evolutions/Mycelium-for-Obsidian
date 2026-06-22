/**
 * eval-metrics.test.mjs — offline tests for src/eval/metrics.ts
 *
 * Pure functions, no Ollama, no I/O. Values are hand-computed.
 *
 * Run: node --test test/eval-metrics.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  dcgAtK,
  idealDcgAtK,
  ndcgAtK,
  meanReciprocalRank,
  evaluate,
} from '../dist/eval/metrics.js';

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

describe('recallAtK', () => {
  test('all relevant in top-K → 1', () => {
    assert.equal(recallAtK(['a', 'b', 'c'], ['a', 'b'], 3), 1);
  });
  test('half relevant in top-K → 0.5', () => {
    // relevant {a,b}; topK=2 = [a, x] → 1 hit / 2 relevant = 0.5
    assert.equal(recallAtK(['a', 'x', 'b'], ['a', 'b'], 2), 0.5);
  });
  test('empty relevant set → 0 (no NaN)', () => {
    assert.equal(recallAtK(['a', 'b'], [], 2), 0);
  });
  test('k<=0 → 0', () => {
    assert.equal(recallAtK(['a'], ['a'], 0), 0);
  });
  test('duplicate in ranking counts once', () => {
    // relevant {a}; topK=3 = [a, a, b] → still 1 hit / 1 relevant = 1
    assert.equal(recallAtK(['a', 'a', 'b'], ['a'], 3), 1);
  });
});

describe('precisionAtK', () => {
  test('1 relevant of 2 retrieved → 0.5', () => {
    assert.equal(precisionAtK(['a', 'x'], ['a'], 2), 0.5);
  });
  test('k<=0 → 0', () => {
    assert.equal(precisionAtK(['a'], ['a'], 0), 0);
  });
});

describe('reciprocalRank', () => {
  test('first relevant at rank 1 → 1', () => {
    assert.equal(reciprocalRank(['a', 'b'], ['a']), 1);
  });
  test('first relevant at rank 2 → 1/2', () => {
    approx(reciprocalRank(['x', 'a', 'b'], ['a']), 0.5);
  });
  test('no relevant in ranking → 0', () => {
    assert.equal(reciprocalRank(['x', 'y'], ['a']), 0);
  });
  test('empty relevant → 0', () => {
    assert.equal(reciprocalRank(['x'], []), 0);
  });
});

describe('dcg / idcg / ndcg', () => {
  test('dcg with hit at rank 1 = 1/log2(2) = 1', () => {
    approx(dcgAtK(['a', 'x'], ['a'], 2), 1);
  });
  test('dcg with hit at rank 2 = 1/log2(3)', () => {
    approx(dcgAtK(['x', 'a'], ['a'], 2), 1 / Math.log2(3));
  });
  test('idcg for 2 relevant @K=3 = 1/log2(2) + 1/log2(3)', () => {
    approx(idealDcgAtK(['a', 'b'], 3), 1 + 1 / Math.log2(3));
  });
  test('ndcg perfect ranking → 1', () => {
    // relevant {a,b}, ranking puts both first
    approx(ndcgAtK(['a', 'b', 'x'], ['a', 'b'], 3), 1);
  });
  test('ndcg with IDCG=0 (empty relevant) → 0, not NaN', () => {
    const v = ndcgAtK(['a'], [], 3);
    assert.ok(!Number.isNaN(v), 'must not be NaN');
    assert.equal(v, 0);
  });
  test('ndcg k<=0 → 0', () => {
    assert.equal(ndcgAtK(['a'], ['a'], 0), 0);
  });
  test('ndcg sub-optimal ranking is between 0 and 1', () => {
    // relevant {a}; ranking [x, a] → dcg=1/log2(3), idcg=1 → < 1
    const v = ndcgAtK(['x', 'a'], ['a'], 2);
    assert.ok(v > 0 && v < 1, `expected 0<v<1; got ${v}`);
    approx(v, 1 / Math.log2(3));
  });
});

describe('meanReciprocalRank', () => {
  test('averages RR across queries', () => {
    const queries = [
      { query: 'q1', ranked: ['a', 'b'], relevant: ['a'] },     // RR=1
      { query: 'q2', ranked: ['x', 'b'], relevant: ['b'] },     // RR=1/2
      { query: 'q3', ranked: ['x', 'y'], relevant: ['z'] },     // RR=0
    ];
    approx(meanReciprocalRank(queries), (1 + 0.5 + 0) / 3);
  });
  test('empty query set → 0', () => {
    assert.equal(meanReciprocalRank([]), 0);
  });
});

describe('evaluate (aggregate)', () => {
  test('empty queries → all zeros with k echoed', () => {
    const s = evaluate([], 5);
    assert.equal(s.count, 0);
    assert.equal(s.recallAtK, 0);
    assert.equal(s.ndcgAtK, 0);
    assert.equal(s.mrr, 0);
    assert.equal(s.k, 5);
  });

  test('aggregates over the gold fixture deterministically', async () => {
    const { GOLD_QUERIES } = await import('./fixtures/eval-gold.mjs');
    const s = evaluate(GOLD_QUERIES, 2);
    assert.equal(s.count, GOLD_QUERIES.length);
    // Every metric must be a finite number in [0,1].
    for (const key of ['recallAtK', 'precisionAtK', 'ndcgAtK', 'mrr']) {
      assert.ok(Number.isFinite(s[key]), `${key} finite`);
      assert.ok(s[key] >= 0 && s[key] <= 1, `${key} in [0,1]; got ${s[key]}`);
    }
    // MRR hand-check: RRs are 1, 1/2, 1, 0 → mean = 2.5/4 = 0.625
    approx(s.mrr, (1 + 0.5 + 1 + 0) / 4);
  });
});
