/**
 * reranker-llm.test.mjs — PR-C (#27): the LLM-as-reranker BACKEND + the
 * zero-valid-scores SEAM hardening.
 *
 * Everything here is HEADLESS — the `/api/generate` call is INJECTED (a fake
 * `generate` fn), so there is NO live LLM. Coverage:
 *
 *   SEAM hardening (pure applyRerank):
 *     - a backend returning a non-empty array whose ids DON'T join any candidate
 *       → rerankerAvailable:false (NOT a fake success with all-null scores).
 *     - a backend returning all-NaN/invalid scores → rerankerAvailable:false.
 *     - one valid joined score still succeeds (the PR-B partial contract holds).
 *
 *   LLM backend (createLlmReranker with a fake generate):
 *     - VALID JSON scores → applyRerank re-sorts top-K by score,
 *       reranker_score populated, rerankerAvailable:true.
 *     - malformed/unparseable output → graceful fallback (empty scores →
 *       seam degrade rerankerAvailable:false, ordering unchanged), never throws.
 *     - zero-valid-scores (out-of-range indices) → [] → seam degrade.
 *     - untrusted-wrap: the prompt sent to generate wraps each passage in
 *       UNTRUSTED_BEGIN/END.
 *     - candidate cap: only the top-K candidates reach the LLM.
 *
 *   Registry: RERANKER_BACKEND=llm resolves the llm backend (default still none).
 *
 * Run: node --test test/reranker-llm.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRerank,
  getReranker,
  getActiveRerankerName,
} from '../dist/embeddings/reranker.js';
import {
  createLlmReranker,
  buildRerankPrompt,
  RERANK_TOP_K,
} from '../dist/embeddings/reranker-llm.js';
import { UNTRUSTED_BEGIN, UNTRUSTED_END } from '../dist/tools/safety.js';

// Shared fixture rows in a known fusion order (a, b, c).
const rows = [
  { id: 'a.md:', text: 'alpha passage about cats', fusion: 0.033 },
  { id: 'b.md:', text: 'beta passage about dogs', fusion: 0.022 },
  { id: 'c.md:', text: 'gamma passage about birds', fusion: 0.016 },
];
const getId = (r) => r.id;
const getText = (r) => r.text;
const getFusion = (r) => r.fusion;

// ---------------------------------------------------------------------------
// SEAM hardening (GPT-5.5): zero valid scores joined → degrade, NOT fake success
// ---------------------------------------------------------------------------

describe('applyRerank seam hardening (zero valid scores → unavailable)', () => {
  test('non-empty array whose ids do NOT join any candidate → rerankerAvailable:false', async () => {
    const hallucinator = {
      name: 'hallucinator',
      available() { return true; },
      async rerank(query, candidates) {
        // Returns scores for ids that are NOT in the candidate set.
        return [
          { id: 'ghost-1', reranker_score: 0.99 },
          { id: 'ghost-2', reranker_score: 0.88 },
        ];
      },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, hallucinator);
    assert.equal(out.rerankerAvailable, false, 'zero joins → NOT reported as a successful rerank');
    assert.equal(out.scores.size, 0, 'no scores joined');
    assert.equal(typeof out.rerankerUnavailableReason, 'string', 'reason present');
    assert.deepEqual(out.results, rows, 'ordering unchanged (no fake reorder)');
  });

  test('all-invalid scores (NaN) → rerankerAvailable:false', async () => {
    const garbage = {
      name: 'garbage',
      available() { return true; },
      async rerank(query, candidates) {
        return candidates.map((c) => ({ id: c.id, reranker_score: NaN }));
      },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, garbage);
    assert.equal(out.rerankerAvailable, false, 'all-NaN → unavailable');
    assert.deepEqual(out.results, rows, 'ordering unchanged');
  });

  test('one valid joined score still succeeds (PR-B partial contract preserved)', async () => {
    const partial = {
      name: 'partial',
      available() { return true; },
      async rerank() {
        return [
          { id: 'b.md:', reranker_score: 0.99 }, // joins
          { id: 'ghost', reranker_score: 0.5 },  // does not join
        ];
      },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, partial);
    assert.equal(out.rerankerAvailable, true, 'one real joined score is still a real rerank');
    assert.deepEqual(out.results.map(getId), ['b.md:', 'a.md:', 'c.md:'], 'b promoted; a,c keep fusion order');
  });
});

// ---------------------------------------------------------------------------
// LLM backend — fake generate (headless, no live LLM)
// ---------------------------------------------------------------------------

describe('createLlmReranker (mocked generate)', () => {
  test('VALID JSON scores → seam re-sorts top-K and populates reranker_score', async () => {
    // Score passage 3 (c) highest, then 1 (a), then 2 (b) → order [c, a, b].
    const generate = async () =>
      JSON.stringify([
        { id: 1, score: 0.5 },
        { id: 2, score: 0.1 },
        { id: 3, score: 0.9 },
      ]);
    const backend = createLlmReranker({ generate });

    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, true, 'working backend → available');
    assert.deepEqual(out.results.map(getId), ['c.md:', 'a.md:', 'b.md:'], 're-sorted by LLM score DESC');
    assert.equal(out.scores.get('c.md:'), 0.9);
    assert.equal(out.scores.get('a.md:'), 0.5);
    assert.equal(out.scores.get('b.md:'), 0.1);
  });

  test('tolerates prose / code fences around the JSON array', async () => {
    const generate = async () =>
      'Sure! Here are the scores:\n```json\n[{"id":1,"score":0.2},{"id":2,"score":0.8},{"id":3,"score":0.4}]\n```\nDone.';
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, true, 'parsed despite surrounding prose');
    assert.deepEqual(out.results.map(getId), ['b.md:', 'c.md:', 'a.md:'], 'order by score DESC');
  });

  test('malformed / unparseable output → graceful fallback (ordering unchanged)', async () => {
    const generate = async () => 'the model rambled and never produced JSON at all';
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, false, 'unparseable → unavailable');
    assert.equal(out.scores.size, 0, 'no scores');
    assert.equal(typeof out.rerankerUnavailableReason, 'string', 'reason present');
    assert.deepEqual(out.results, rows, 'ordering unchanged on malformed output');
  });

  test('(P2) scores outside [0,1] are rejected — a 99 cannot dominate', async () => {
    // The prompt contract is 0..1; a model emitting 99 / -4 violated it. Those
    // must NOT join (so they can't dominate ordering); only the in-range score does.
    const generate = async () =>
      JSON.stringify([
        { id: 1, score: 0.7 }, // in range → joins
        { id: 2, score: 99 },  // out of range → rejected
        { id: 3, score: -4 },  // out of range → rejected
      ]);
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, true, 'one in-range score is a real (partial) rerank');
    assert.equal(out.scores.get('a.md:'), 0.7, 'in-range score joined');
    assert.equal(out.scores.has('b.md:'), false, 'score 99 rejected — did not join');
    assert.equal(out.scores.has('c.md:'), false, 'score -4 rejected — did not join');
  });

  test('(P2) ALL scores out of [0,1] → zero valid → rerankerAvailable:false', async () => {
    const generate = async () =>
      JSON.stringify([
        { id: 1, score: 99 },
        { id: 2, score: -1 },
        { id: 3, score: 1.5 },
      ]);
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, false, 'all out-of-range → degrade, not fake success');
    assert.equal(out.scores.size, 0, 'no scores joined');
    assert.deepEqual(out.results, rows, 'ordering unchanged');
  });

  test('generate throwing → graceful fallback, never throws', async () => {
    const generate = async () => { throw new Error('connection refused'); };
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, false, 'throw → degrade');
    assert.deepEqual(out.results, rows, 'ordering unchanged');
  });

  test('zero-valid-scores (all indices out of range) → rerankerAvailable:false', async () => {
    // Valid JSON, finite scores, but every index is out of the 1..K window →
    // nothing joins → the GPT-5.5 hardening case.
    const generate = async () =>
      JSON.stringify([
        { id: 99, score: 0.9 },
        { id: 0, score: 0.8 },
        { id: -1, score: 0.7 },
      ]);
    const backend = createLlmReranker({ generate });
    const out = await applyRerank('q', rows, getId, getText, getFusion, backend);
    assert.equal(out.rerankerAvailable, false, 'zero joins → NOT a successful rerank');
    assert.equal(out.scores.size, 0, 'no scores joined');
    assert.deepEqual(out.results, rows, 'ordering unchanged');
  });

  test('backend layer itself returns [] for out-of-range indices (independent of the seam)', async () => {
    // Pin the backend's OWN zero-join defence (the spec demands hardening in
    // BOTH the seam AND the backend) — call rerank() directly, not via applyRerank.
    const generate = async () =>
      JSON.stringify([{ id: 99, score: 0.9 }, { id: 0, score: 0.8 }]);
    const backend = createLlmReranker({ generate });
    const candidates = rows.map((r) => ({ id: r.id, text: r.text, fusionScore: r.fusion }));
    const scored = await backend.rerank('q', candidates);
    assert.deepEqual(scored, [], 'backend drops every out-of-range index on its own');
  });

  test('untrusted-wrap: the prompt wraps EACH passage in UNTRUSTED markers', async () => {
    let seenPrompt = null;
    const generate = async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify([{ id: 1, score: 1 }]);
    };
    const backend = createLlmReranker({ generate });
    await applyRerank('q', rows, getId, getText, getFusion, backend);

    assert.ok(seenPrompt, 'generate received a prompt');
    // One BEGIN/END pair per passage (3 rows).
    const begins = seenPrompt.split(UNTRUSTED_BEGIN).length - 1;
    const ends = seenPrompt.split(UNTRUSTED_END).length - 1;
    assert.equal(begins, 3, 'one UNTRUSTED_BEGIN per passage');
    assert.equal(ends, 3, 'one UNTRUSTED_END per passage');
    // Each passage text sits between the markers (spot-check the first).
    const a = seenPrompt.indexOf(UNTRUSTED_BEGIN);
    const aText = seenPrompt.indexOf('alpha passage about cats');
    const aEnd = seenPrompt.indexOf(UNTRUSTED_END);
    assert.ok(a < aText && aText < aEnd, 'passage text is enclosed by the markers');
  });

  test('candidate cap: only the top-K candidates are sent to the LLM', async () => {
    // Build K+5 fusion-ordered rows; backend topK forced small to assert the cap.
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}.md:`,
      text: `passage number ${i}`,
      fusion: 1 - i * 0.01,
    }));
    let seenPrompt = null;
    const generate = async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify([{ id: 1, score: 1 }]);
    };
    const backend = createLlmReranker({ generate, topK: 3 });
    await applyRerank('q', many, (r) => r.id, (r) => r.text, (r) => r.fusion, backend);

    assert.ok(seenPrompt, 'prompt captured');
    // Exactly 3 passages → 3 marker pairs; the tail (n3..n7) must be absent.
    assert.equal(seenPrompt.split(UNTRUSTED_BEGIN).length - 1, 3, 'only top-K=3 passages sent');
    assert.ok(seenPrompt.includes('passage number 0'), 'top candidate present');
    assert.ok(seenPrompt.includes('passage number 2'), 'third candidate present');
    assert.ok(!seenPrompt.includes('passage number 3'), 'fourth candidate (beyond cap) NOT sent');
    assert.ok(!seenPrompt.includes('passage number 7'), 'last candidate (beyond cap) NOT sent');
  });

  test('default top-K window constant is a positive integer', () => {
    assert.ok(Number.isInteger(RERANK_TOP_K) && RERANK_TOP_K > 0, 'RERANK_TOP_K sane');
  });
});

// ---------------------------------------------------------------------------
// Registry: RERANKER_BACKEND=llm resolves the llm backend
// ---------------------------------------------------------------------------

describe('reranker registry — llm backend', () => {
  test('buildRerankPrompt is deterministic and order-stable', () => {
    const p = buildRerankPrompt('find cats', rows.map((r) => ({ id: r.id, text: r.text, fusionScore: r.fusion })));
    assert.ok(p.includes('Passage 1:') && p.includes('Passage 3:'), 'numbered windows');
    assert.ok(p.includes('STRICT JSON'), 'demands strict JSON');
    assert.ok(p.includes('find cats'), 'query embedded');
  });

  test('RERANKER_BACKEND=llm resolves the llm backend (registered for side-effect)', async () => {
    // Importing semantic.js registers the llm backend.
    await import('../dist/tools/semantic.js');
    const prev = process.env.RERANKER_BACKEND;
    process.env.RERANKER_BACKEND = 'llm';
    try {
      const active = getReranker(getActiveRerankerName());
      assert.equal(active.name, 'llm', 'RERANKER_BACKEND=llm → llm backend');
      assert.equal(active.available(), true, 'llm backend reports available');
    } finally {
      if (prev === undefined) delete process.env.RERANKER_BACKEND;
      else process.env.RERANKER_BACKEND = prev;
    }
  });

  test('default (no env) still resolves to none — default-OFF preserved', () => {
    const prev = process.env.RERANKER_BACKEND;
    delete process.env.RERANKER_BACKEND;
    try {
      assert.equal(getReranker(getActiveRerankerName()).name, 'none', 'default backend is none');
    } finally {
      if (prev !== undefined) process.env.RERANKER_BACKEND = prev;
    }
  });
});
