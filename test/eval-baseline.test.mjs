/**
 * eval-baseline.test.mjs — Ollama-gated end-to-end retrieval baseline.
 *
 * Indexes a tiny labelled vault, runs the live `semantic_search` (now RRF-fused),
 * and scores its output against a hand-labelled gold set using the pure metrics
 * in src/eval/metrics.ts. This is the harness that gates ranking changes: it
 * proves the wired RRF pipeline produces sane Recall@K / NDCG@K / MRR on a known
 * corpus, and — critically — that the minSimilarity fix did NOT collapse results.
 *
 * Skip-gating mirrors semantic.test.mjs: Ollama is probed in before(); each test
 * calls `t.skip(); return` when it is unavailable. The always-run portion only
 * asserts the additive response contract on shape (fusionScore ordering, the new
 * fields) without requiring a live model — but since search needs Ollama to embed
 * the query, the contract assertions are themselves gated. The metric functions
 * are exercised offline in eval-metrics.test.mjs regardless.
 *
 * Run: node --test test/eval-baseline.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createSemanticHandlers } from '../dist/tools/semantic.js';
import { checkOllamaAvailability } from '../dist/embeddings/ollama.js';
import { recallAtK, ndcgAtK, reciprocalRank } from '../dist/eval/metrics.js';

// A small, well-separated corpus with unambiguous topical answers.
const VAULT_FILES = {
  'Marketing.md': [
    '# Marketing Strategy',
    '',
    'Our marketing plan focuses on social media channels and brand awareness.',
    'Key metrics include engagement rate and the conversion funnel.',
  ].join('\n'),
  'Engineering.md': [
    '# Engineering Notes',
    '',
    'The system architecture uses microservices with a REST API layer.',
    'Performance is measured via latency and throughput benchmarks.',
  ].join('\n'),
  'Cooking.md': [
    '# Cooking Recipes',
    '',
    'A good risotto needs slow-added stock and constant stirring.',
    'Finish with parmesan and a knob of butter for creaminess.',
  ].join('\n'),
};

// Gold labels: query → the single correct doc.
const GOLD = [
  { query: 'marketing strategy and brand awareness on social media', relevant: ['Marketing.md'] },
  { query: 'system architecture microservices REST API latency', relevant: ['Engineering.md'] },
  { query: 'how to cook a creamy risotto with parmesan', relevant: ['Cooking.md'] },
];

let ollamaAvailable = false;
let vaultDir;
let handlers;

before(async () => {
  vaultDir = createTempVault(VAULT_FILES);
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ EvalVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  const config = loadConfig();
  handlers = createSemanticHandlers(config);
  try {
    const r = await checkOllamaAvailability({ host: config.ollama.host, model: config.ollama.model });
    ollamaAvailable = r.available && r.hasModel;
  } catch {
    ollamaAvailable = false;
  }
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

function parseJson(res) {
  return JSON.parse(res.content[0].text);
}

describe('eval baseline (Ollama-gated)', () => {
  test('additive response contract: fusion fields present and ordered by fusionScore', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const idx = await handlers.index_vault({ vault: 'EvalVault', force: true });
    assert.equal(idx.isError, false, `index_vault failed: ${idx.content[0].text}`);

    const res = await handlers.semantic_search({
      vault: 'EvalVault',
      query: 'marketing strategy and brand awareness on social media',
      limit: 5,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.ok(Array.isArray(data.results) && data.results.length > 0, 'non-empty results');

    let prevFusion = Infinity;
    for (const r of data.results) {
      // Existing contract preserved.
      assert.equal(typeof r.similarity, 'number', 'similarity number');
      assert.equal(typeof r.semanticScore, 'number', 'semanticScore number');
      assert.equal(typeof r.keywordScore, 'number', 'keywordScore number');
      // Additive fusion contract.
      assert.equal(typeof r.fusionScore, 'number', 'fusionScore number');
      assert.equal(r.fusionMethod, 'rrf', 'fusionMethod is "rrf"');
      assert.equal(typeof r.per_signal, 'object', 'per_signal object');
      assert.ok('bm25' in r.per_signal && 'embeddings' in r.per_signal, 'per_signal has both signals');
      assert.ok(
        r.per_signal.bm25.rank === null || typeof r.per_signal.bm25.rank === 'number',
        'bm25 rank null or number',
      );
      assert.equal(typeof r.rrf_term, 'object', 'rrf_term object');
      assert.equal(r.rrf_term.k, 60, 'rrf_term.k is 60');
      assert.equal(r.reranker_score, null, 'reranker_score is null (hook only)');
      // Ordering by fusionScore (descending).
      assert.ok(r.fusionScore <= prevFusion + 1e-12, 'results ordered by fusionScore desc');
      prevFusion = r.fusionScore;
      // rrf_term contributions reconstruct fusionScore.
      assert.ok(
        Math.abs((r.rrf_term.bm25 + r.rrf_term.embeddings) - r.fusionScore) <= 1e-9,
        'rrf_term contributions sum to fusionScore',
      );
    }
  });

  test('minSimilarity does NOT collapse fused results (the named blocker)', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    await handlers.index_vault({ vault: 'EvalVault', force: true });

    // A default-ish floor that, under the OLD post-fusion filter, would wipe
    // every fused row (fused totals ~0.016–0.033 < minSimilarity*0.7).
    const res = await handlers.semantic_search({
      vault: 'EvalVault',
      query: 'system architecture microservices REST API latency',
      minSimilarity: 0.5,
      limit: 5,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.ok(data.results.length > 0, 'fused results survive the minSimilarity floor');
  });

  test('baseline retrieval quality meets a sane floor on the gold set', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    await handlers.index_vault({ vault: 'EvalVault', force: true });

    const K = 3;
    let recall = 0, ndcg = 0, mrr = 0;
    for (const g of GOLD) {
      const res = await handlers.semantic_search({ vault: 'EvalVault', query: g.query, limit: 5 });
      assert.equal(res.isError, false, `search failed for "${g.query}": ${res.content[0].text}`);
      const ranked = parseJson(res).results.map(r => r.path);
      recall += recallAtK(ranked, g.relevant, K);
      ndcg += ndcgAtK(ranked, g.relevant, K);
      mrr += reciprocalRank(ranked, g.relevant);
    }
    const n = GOLD.length;
    recall /= n; ndcg /= n; mrr /= n;

    // Sanity floors — on a 3-doc well-separated corpus the correct answer should
    // be retrievable within top-3 for every query.
    assert.ok(recall >= 0.99, `Recall@${K} floor; got ${recall.toFixed(3)}`);
    assert.ok(ndcg > 0, `NDCG@${K} > 0; got ${ndcg.toFixed(3)}`);
    assert.ok(mrr > 0, `MRR > 0; got ${mrr.toFixed(3)}`);
  });
});
