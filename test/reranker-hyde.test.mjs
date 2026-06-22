/**
 * reranker-hyde.test.mjs — PR-B (#27): reranker SEAM + HyDE for semantic_search.
 *
 * Coverage:
 *   PURE (headless, always-run):
 *     - applyRerank with the `none` backend is a HARD NO-OP (no reorder, empty
 *       scores, rerankerAvailable:false + reason) — the default-OFF golden at
 *       the pure level (rerank-off is a verbatim pass-through).
 *     - applyRerank with a FAKE deterministic backend re-sorts by reranker_score
 *       and populates the score map.
 *     - graceful degrade: a throwing / malformed backend → input UNCHANGED,
 *       rerankerAvailable:false + reason, never throws.
 *     - storage.getContent round-trips the full passage text by (file,block).
 *   HANDLER (Ollama-gated via t.skip):
 *     - default-OFF GOLDEN: rerank omitted + no hypotheticalAnswer → NO
 *       rerankerAvailable/rerankerBackend keys, every reranker_score === null,
 *       order === fusionScore-desc order (the pre-#27 contract).
 *     - rerank ON with an injected FAKE backend → top-K re-sorted by
 *       reranker_score, reranker_score populated, rerankerAvailable:true.
 *     - graceful degrade: rerank ON with the `none` backend → reranker_score:null,
 *       ordering unchanged, rerankerAvailable:false + reason, isError:false.
 *     - HyDE: hypotheticalAnswer drives EMBEDDINGS while BM25 stays on the
 *       original query; compose-with-expand preserves the collapse rule.
 *
 * Run: node --test test/reranker-hyde.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createSemanticHandlers } from '../dist/tools/semantic.js';
import { checkOllamaAvailability } from '../dist/embeddings/ollama.js';
import { EmbeddingStorage } from '../dist/embeddings/storage.js';
import {
  applyRerank,
  noneReranker,
  getReranker,
  registerReranker,
  getActiveRerankerName,
} from '../dist/embeddings/reranker.js';

// ---------------------------------------------------------------------------
// PURE tests — headless, always run (no Ollama)
// ---------------------------------------------------------------------------

describe('applyRerank (pure, headless)', () => {
  // Three fixture rows in a known fusion order (a, b, c).
  const rows = [
    { id: 'a.md:', text: 'alpha passage about cats', fusion: 0.033 },
    { id: 'b.md:', text: 'beta passage about dogs', fusion: 0.022 },
    { id: 'c.md:', text: 'gamma passage about birds', fusion: 0.016 },
  ];
  const getId = (r) => r.id;
  const getText = (r) => r.text;
  const getFusion = (r) => r.fusion;

  test('none backend is a HARD NO-OP (no reorder, empty scores, unavailable)', async () => {
    const out = await applyRerank('q', rows, getId, getText, getFusion, noneReranker);
    assert.equal(out.rerankerAvailable, false, 'none reports unavailable');
    assert.equal(out.scores.size, 0, 'no scores produced');
    assert.equal(typeof out.rerankerUnavailableReason, 'string', 'reason present');
    // Verbatim pass-through: same items, same order.
    assert.deepEqual(out.results, rows, 'order is unchanged (verbatim no-op)');
  });

  test('fake deterministic backend re-sorts by reranker_score and populates scores', async () => {
    // Score c > a > b so the expected new order is [c, a, b].
    const fake = {
      name: 'fake',
      available() { return true; },
      async rerank(query, candidates) {
        const scoreMap = { 'a.md:': 0.5, 'b.md:': 0.1, 'c.md:': 0.9 };
        return candidates.map((c) => ({ id: c.id, reranker_score: scoreMap[c.id] }));
      },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, fake);
    assert.equal(out.rerankerAvailable, true, 'fake reports available');
    assert.deepEqual(out.results.map(getId), ['c.md:', 'a.md:', 'b.md:'], 're-sorted by score DESC');
    assert.equal(out.scores.get('c.md:'), 0.9);
    assert.equal(out.scores.get('a.md:'), 0.5);
    assert.equal(out.scores.get('b.md:'), 0.1);
  });

  test('fake backend receives the REAL passage text AND the real fusionScore', async () => {
    let seenTexts = null;
    let seenFusion = null;
    const spy = {
      name: 'spy',
      available() { return true; },
      async rerank(query, candidates) {
        seenTexts = candidates.map((c) => c.text);
        seenFusion = candidates.map((c) => c.fusionScore);
        return candidates.map((c) => ({ id: c.id, reranker_score: 1 }));
      },
    };
    await applyRerank('q', rows, getId, getText, getFusion, spy);
    assert.deepEqual(seenTexts, rows.map(getText), 'backend got full passage text via getText');
    // The seam must hand the REAL RRF total, not a placeholder 0 (PR-C contract).
    assert.deepEqual(seenFusion, rows.map(getFusion), 'backend got the real fusionScore per candidate');
  });

  test('graceful degrade: a THROWING backend leaves input unchanged, never throws', async () => {
    const boom = {
      name: 'boom',
      available() { return true; },
      async rerank() { throw new Error('backend exploded'); },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, boom);
    assert.equal(out.rerankerAvailable, false, 'degraded to unavailable');
    assert.equal(out.scores.size, 0, 'no scores');
    assert.ok(/exploded/.test(out.rerankerUnavailableReason), 'reason carries the cause');
    assert.deepEqual(out.results, rows, 'ordering unchanged on failure');
  });

  test('graceful degrade: malformed (non-array) output → unchanged', async () => {
    const malformed = {
      name: 'bad',
      available() { return true; },
      async rerank() { return { not: 'an array' }; },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, malformed);
    assert.equal(out.rerankerAvailable, false, 'degraded');
    assert.deepEqual(out.results, rows, 'ordering unchanged');
  });

  test('unscored candidates sink below scored ones, stable on ties', async () => {
    // Only score 'b' — a and c are unscored and keep their relative fusion order.
    const partial = {
      name: 'partial',
      available() { return true; },
      async rerank(query, candidates) {
        return [{ id: 'b.md:', reranker_score: 0.99 }];
      },
    };
    const out = await applyRerank('q', rows, getId, getText, getFusion, partial);
    assert.deepEqual(out.results.map(getId), ['b.md:', 'a.md:', 'c.md:'], 'b first; a,c keep fusion order');
  });
});

describe('reranker registry (pure)', () => {
  test('default backend is "none" and is unavailable', () => {
    const def = getReranker(getActiveRerankerName());
    // No RERANKER_BACKEND env in headless test → resolves to "none".
    assert.equal(def.name, 'none', 'active backend is none by default');
    assert.equal(def.available(), false, 'none is unavailable');
  });

  test('unknown backend name falls back to none', () => {
    assert.equal(getReranker('does-not-exist').name, 'none', 'unknown → none');
  });

  test('registered backend is retrievable by name', () => {
    const stub = { name: 'reg-stub', available() { return true; }, async rerank() { return []; } };
    registerReranker(stub);
    assert.equal(getReranker('reg-stub').name, 'reg-stub', 'registered backend resolvable');
  });
});

// ---------------------------------------------------------------------------
// storage.getContent — headless (no Ollama; writes the FTS row directly)
// ---------------------------------------------------------------------------

describe('storage.getContent (passage text by file+block)', () => {
  let dir;
  let store;

  before(() => {
    dir = createTempVault({ 'Dummy.md': '# Dummy' });
    store = new EmbeddingStorage(path.join(dir, '.mcp-obsidian', 'embeddings.db'));
  });
  after(() => {
    if (store) store.close();
    if (dir) cleanup(dir);
  });

  test('round-trips full passage text by (file_path, blockId)', () => {
    const emb = [0.1, 0.2, 0.3];
    store.store('Note.md', emb, 'hash1', { chunked: true }, 'block-7', 'The full passage text here.');
    assert.equal(store.getContent('Note.md', 'block-7'), 'The full passage text here.');
  });

  test('whole-file block (null/empty) round-trips', () => {
    const emb = [0.4, 0.5, 0.6];
    store.store('Whole.md', emb, 'hash2', {}, null, 'Whole file content.');
    assert.equal(store.getContent('Whole.md'), 'Whole file content.');
    assert.equal(store.getContent('Whole.md', ''), 'Whole file content.');
  });

  test('absent row returns null (never throws)', () => {
    assert.equal(store.getContent('Missing.md', 'nope'), null);
  });
});

// ---------------------------------------------------------------------------
// HANDLER tests — Ollama-gated
// ---------------------------------------------------------------------------

const VAULT_FILES = {
  'Marketing.md': [
    '# Marketing Strategy',
    '',
    'Our marketing plan focuses on social media channels and brand awareness.',
    'Key metrics include engagement rate and conversion funnel.',
  ].join('\n'),
  'Engineering.md': [
    '# Engineering Notes',
    '',
    'The system architecture uses microservices with a REST API layer.',
    'Performance is measured via latency and throughput benchmarks.',
  ].join('\n'),
  // A note whose ONLY lexical hook for the HyDE probe is gardening — the
  // original query (below) shares no BM25 terms with it, so it can surface
  // only via an embedding driven by a gardening-flavoured hypothetical.
  'Gardening.md': [
    '# Garden Journal',
    '',
    'Composting kitchen scraps enriches the soil for tomato seedlings in spring.',
    'Mulching retains moisture during dry summer weeks.',
  ].join('\n'),
};

let ollamaAvailable = false;
let vaultDir;
let config;
let handlers;

before(async () => {
  vaultDir = createTempVault(VAULT_FILES);
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ RrVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  delete process.env.RERANKER_BACKEND;

  config = loadConfig();
  handlers = createSemanticHandlers(config);

  try {
    const result = await checkOllamaAvailability({
      host: config.ollama.host,
      model: config.ollama.model,
    });
    ollamaAvailable = result.available && result.hasModel;
  } catch {
    ollamaAvailable = false;
  }
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

function parseJson(res) {
  assert.ok(Array.isArray(res.content), 'content is an array');
  assert.equal(typeof res.content[0].text, 'string', 'text is a string');
  return JSON.parse(res.content[0].text);
}

describe('semantic_search rerank + HyDE (Ollama-gated)', () => {
  test('default-OFF GOLDEN: no rerank keys, all reranker_score null, fusionScore order', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }
    await handlers.index_vault({ vault: 'RrVault', force: true });

    const res = await handlers.semantic_search({
      vault: 'RrVault',
      query: 'marketing strategy brand awareness',
      limit: 5,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);

    // No rerank requested → ZERO rerank keys (byte-identical-to-pre-#27 contract).
    assert.ok(!('rerankerAvailable' in data), 'no rerankerAvailable key when rerank omitted');
    assert.ok(!('rerankerBackend' in data), 'no rerankerBackend key when rerank omitted');
    assert.ok(!('rerankerUnavailableReason' in data), 'no rerank reason when rerank omitted');

    // Every hit's reranker_score stays the literal null; order is fusionScore-desc.
    let prevFusion = Infinity;
    for (const r of data.results) {
      assert.equal(r.reranker_score, null, 'reranker_score is null when rerank off');
      assert.ok(r.fusionScore <= prevFusion + 1e-12, 'results ordered by fusionScore DESC');
      prevFusion = r.fusionScore;
    }
  });

  test('rerank ON with injected FAKE backend re-sorts top-K by reranker_score', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }
    await handlers.index_vault({ vault: 'RrVault', force: true });

    // Baseline (rerank off) to learn the fusion order of paths. A low
    // minSimilarity widens the candidate floor so the tiny vault yields >=2 hits.
    const base = parseJson(await handlers.semantic_search({
      vault: 'RrVault', query: 'system architecture microservices', limit: 5, minSimilarity: 0.2,
    }));
    const basePaths = base.results.map((r) => r.path);
    assert.ok(basePaths.length >= 2, `need >=2 hits to prove a reorder; got ${JSON.stringify(basePaths)}`);

    // FAKE backend: score each candidate by the REVERSE of the order it was
    // handed in (which is the fusion order). The last fusion candidate gets the
    // highest score → the reranked top-K must be the EXACT reverse of fusion
    // order. This is robust regardless of which paths survive the candidate
    // floor (no dependency on basePaths matching the rerank candidate set).
    let seenCandidatePaths = null;
    let sawRealText = false;
    const fake = {
      name: 'fake-e2e',
      available() { return true; },
      async rerank(query, candidates) {
        seenCandidatePaths = candidates.map((c) => c.id.slice(0, c.id.lastIndexOf(':')));
        // Proves the handler's getContent → backend real-passage wiring works
        // end-to-end (not the 200-char preview, not an empty string).
        sawRealText = candidates.some((c) => typeof c.text === 'string' && c.text.length > 0);
        // index 0 (top fusion) → lowest score; index n-1 (last) → highest.
        return candidates.map((c, i) => ({ id: c.id, reranker_score: i }));
      },
    };

    const res = await handlers.semantic_search({
      vault: 'RrVault',
      query: 'system architecture microservices',
      limit: 5,
      minSimilarity: 0.2,
      rerank: true,
      _rerankerBackend: fake,
    });
    assert.equal(res.isError, false, `rerank search failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(data.rerankerAvailable, true, 'rerankerAvailable true with working backend');
    assert.equal(data.rerankerBackend, 'fake-e2e', 'backend name surfaced');
    assert.ok(seenCandidatePaths && seenCandidatePaths.length >= 2, 'backend saw >=2 candidates');
    assert.equal(sawRealText, true, 'backend received real passage text from content_fts (not empty/preview)');

    // Every hit carries a numeric reranker_score (the fake scored them all).
    for (const r of data.results) {
      assert.equal(typeof r.reranker_score, 'number', 'reranker_score populated');
    }
    // Ordering: results sorted by reranker_score DESC.
    let prev = Infinity;
    for (const r of data.results) {
      assert.ok(r.reranker_score <= prev + 1e-12, 'sorted by reranker_score DESC');
      prev = r.reranker_score;
    }
    // The reorder actually happened: the reranked order is the EXACT reverse of
    // the fusion order the backend was handed.
    const rerankedPaths = data.results.map((r) => r.path);
    assert.deepEqual(
      rerankedPaths,
      [...seenCandidatePaths].reverse(),
      'top-K re-sorted to the reverse of fusion order',
    );
  });

  test('graceful degrade: rerank ON with none backend → null scores, order unchanged', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }
    await handlers.index_vault({ vault: 'RrVault', force: true });

    const base = parseJson(await handlers.semantic_search({
      vault: 'RrVault', query: 'marketing strategy brand awareness', limit: 5,
    }));

    // rerank requested but backend is the real `none` (unavailable).
    const res = await handlers.semantic_search({
      vault: 'RrVault',
      query: 'marketing strategy brand awareness',
      limit: 5,
      rerank: true,
      _rerankerBackend: noneReranker,
    });
    assert.equal(res.isError, false, 'degrade path is not an error');
    const data = parseJson(res);

    assert.equal(data.rerankerAvailable, false, 'rerankerAvailable:false on none');
    assert.equal(typeof data.rerankerUnavailableReason, 'string', 'reason present on degrade');
    for (const r of data.results) {
      assert.equal(r.reranker_score, null, 'reranker_score stays null when unavailable');
    }
    // Ordering unchanged vs baseline.
    assert.deepEqual(
      data.results.map((r) => r.path),
      base.results.map((r) => r.path),
      'ordering unchanged when backend unavailable',
    );
  });

  test('HyDE: hypotheticalAnswer drives EMBEDDINGS while BM25 stays on the query', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }
    await handlers.index_vault({ vault: 'RrVault', force: true });

    // Query shares no lexical terms with Gardening.md → BM25 alone won't surface it.
    const query = 'database indexing performance tuning';
    const hypothetical =
      'Composting kitchen scraps and mulching enriches garden soil for tomato seedlings in spring.';

    const withHyde = parseJson(await handlers.semantic_search({
      vault: 'RrVault',
      query,
      hypotheticalAnswer: hypothetical,
      limit: 5,
    }));

    // The hypothetical is gardening-flavoured → its embedding should surface
    // Gardening.md even though the BM25 query is about databases.
    const paths = withHyde.results.map((r) => r.path);
    assert.ok(paths.includes('Gardening.md'), `HyDE surfaces Gardening.md via embeddings; got ${JSON.stringify(paths)}`);

    // TEETH: prove it surfaced via EMBEDDINGS, not a BM25 leak of the hypothetical.
    // per_signal.embeddings.rank is non-null (the embedding ranked it) while
    // per_signal.bm25.rank is null (BM25 ran ONLY on the database query, which
    // shares no terms with the gardening note). This locks "BM25 stays on the
    // original query" against a future bm25Texts=embeddingTexts regression that
    // queriesUsed alone would NOT catch.
    const g = withHyde.results.find((r) => r.path === 'Gardening.md');
    assert.notEqual(g.per_signal.embeddings.rank, null, 'Gardening surfaced via the embeddings signal');
    assert.equal(g.per_signal.bm25.rank, null, 'BM25 never matched the hypothetical (stayed on the original query)');

    // BM25 stays on the ORIGINAL query: queriesUsed reflects only the user query
    // (the hypothetical is an embeddings variant, never a reported query).
    assert.deepEqual(withHyde.queriesUsed, [query], 'queriesUsed is the original query only (BM25 untouched)');
  });

  test('HyDE + expand=true: hypothetical is one more embeddings variant (no error)', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }
    await handlers.index_vault({ vault: 'RrVault', force: true });

    const res = await handlers.semantic_search({
      vault: 'RrVault',
      query: 'marketing strategy',
      hypotheticalAnswer: 'A plan for brand awareness across social media channels.',
      expand: true,
      limit: 5,
    });
    assert.equal(res.isError, false, `HyDE+expand failed: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.equal(data.searchType, 'hybrid+expansion', 'searchType reflects expansion');
    // queriesUsed reflects the BM25/expansion variants (hypothetical excluded).
    assert.ok(Array.isArray(data.queriesUsed), 'queriesUsed present');
    assert.equal(data.queriesUsed[0], 'marketing strategy', 'original query leads queriesUsed');
    assert.ok(Array.isArray(data.results), 'results present');
  });
});
