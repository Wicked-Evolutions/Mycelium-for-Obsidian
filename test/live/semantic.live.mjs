/**
 * LIVE e2e — semantic search against REAL Ollama embeddings.
 *
 * Architecture A (handler-level): real built handlers, no mocks. Indexes the
 * vault (writes only the DERIVED semantic DB — never mutates notes) then queries
 * with real embeddings.
 *
 * GATED: skips unless LIVE_TEST_VAULT AND LIVE_OLLAMA are set (needs Ollama up).
 * Indexing embeds every note — point LIVE_TEST_VAULT at a small/medium vault for
 * this lane. Full procedure in docs/live-e2e.md.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const LINKED = process.env.LIVE_TEST_VAULT;
const skip = !LINKED
  ? 'set LIVE_TEST_VAULT to run — see docs/live-e2e.md'
  : (!process.env.LIVE_OLLAMA ? 'set LIVE_OLLAMA=1 (+ Ollama running) to run the semantic live e2e' : false);

const { loadConfig } = await import('../../dist/config.js');
const { createAllHandlers } = await import('../../dist/tools/index.js');

function makeHandlers() {
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  return createAllHandlers(loadConfig());
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

describe('live: semantic search via real Ollama', { skip }, () => {
  let handlers;
  before(() => { handlers = makeHandlers(); });

  test('index_vault then semantic_search returns ranked hits with the graph block', async () => {
    // index_vault writes ONLY the derived semantic index (no note mutation).
    const idx = await handlers.index_vault({ vault: LINKED });
    assert.equal(idx.isError, false, `index_vault errored: ${idx.content?.[0]?.text}`);

    const out = parse(await handlers.semantic_search({ vault: LINKED, query: 'the main idea', limit: 5 }));
    assert.ok(Array.isArray(out.results), 'results must be an array');
    assert.ok(out.results.length > 0, 'expected at least one semantic hit on a non-empty vault');

    const hit = out.results[0];
    assert.equal(typeof hit.score, 'number', 'each hit carries a numeric score');
    assert.ok(typeof hit.filePath === 'string' && hit.filePath.length > 0, 'each hit carries a filePath');
    // Convergence (#24) additive contract: the graph block key is always present (null if unjoined).
    assert.ok('graph' in hit, 'each hit carries the additive graph block (null when unjoined)');
  });
});
