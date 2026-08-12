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
import { envFlag, optionalVaultSkipReason, withTemporaryEnv } from './support.mjs';
import { cleanup, createTempVault } from '../helpers.mjs';

const LINKED = process.env.LIVE_TEST_VAULT;
const DIRECTORY = process.env.LIVE_TEST_DIRECTORY?.trim() || undefined;
const skip = optionalVaultSkipReason()
  || (!envFlag(process.env.LIVE_OLLAMA) ? 'set LIVE_OLLAMA=1 (+ Ollama running) to run the semantic live e2e' : false);

const { loadConfig } = await import('../../dist/config.js');
const { createAllHandlers } = await import('../../dist/tools/index.js');

async function makeHandlers() {
  return withTemporaryEnv(
    { OBSIDIAN_DISABLED_TOOLS: undefined },
    () => createAllHandlers(loadConfig()),
  );
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

describe('live: semantic search via real Ollama', { skip }, () => {
  let handlers;
  before(async () => { handlers = await makeHandlers(); });

  test('index_vault then semantic_search returns ranked hits with the graph block', async () => {
    // index_vault writes ONLY the derived semantic index (no note mutation).
    const indexSummary = parse(await handlers.index_vault({
      vault: LINKED,
      ...(DIRECTORY ? { directory: DIRECTORY } : {}),
    }));
    assert.ok(indexSummary.totalFiles > 0, 'the semantic live target must contain Markdown files');
    assert.equal(indexSummary.errors, 0, 'index_vault must complete without per-file errors');
    assert.equal(
      indexSummary.indexedFiles + indexSummary.skipped + indexSummary.errors,
      indexSummary.totalFiles,
      'index_vault file accounting must reconcile exactly',
    );

    const status = parse(await handlers.index_status({ vault: LINKED }));
    assert.equal(status.ollama?.available, true, 'Ollama must be reachable during the live lane');
    assert.equal(status.ollama?.hasModel, true, 'the configured embedding model must be installed');
    assert.ok(
      typeof status.ollama?.model === 'string' && status.ollama.model.length > 0,
      'the live receipt must identify a configured embedding model',
    );

    const out = parse(await handlers.semantic_search({ vault: LINKED, query: 'the main idea', limit: 5 }));
    assert.ok(Array.isArray(out.results), 'results must be an array');
    assert.ok(out.results.length > 0, 'expected at least one semantic hit on a non-empty vault');
    assert.equal(out.indexCompatibility?.state, 'complete', 'the live index must use one exact model/dimension cohort');
    assert.equal(out.indexCompatibility?.reindexRequired, false, 'the live index must not require migration');

    const hit = out.results[0];
    // Real semantic_search response contract (RRF fusion output — semantic.ts):
    assert.ok(typeof hit.path === 'string' && hit.path.length > 0, 'each hit carries a path');
    assert.equal(typeof hit.similarity, 'number', 'each hit carries a numeric similarity');
    assert.equal(typeof hit.fusionScore, 'number', 'each hit carries a numeric fusionScore');
    assert.equal(hit.fusionMethod, 'rrf', 'fusion method is rrf');
    // Convergence (#24) additive contract: the graph block key is always present (null if unjoined).
    assert.ok('graph' in hit, 'each hit carries the additive graph block (null when unjoined)');
  });

  test('a synthetic long note indexes completely through real Ollama', async () => {
    const vault = createTempVault({
      'Long.md': '# Long context fixture\n\n' +
        'context boundary evidence remains searchable without truncation. '.repeat(2_000),
    });
    const name = 'LongContextFixture';

    try {
      const longHandlers = await withTemporaryEnv({
        OBSIDIAN_VAULTS: JSON.stringify({ [name]: vault }),
        OBSIDIAN_DISABLED_TOOLS: undefined,
      }, async () => createAllHandlers(loadConfig()));
      const indexed = parse(await longHandlers.index_vault({ vault: name, force: true }));
      assert.equal(indexed.totalFiles, 1);
      assert.equal(indexed.errors, 0);
      assert.equal(indexed.indexedFiles, 1);
      assert.ok(indexed.indexedSections > 1, 'the oversized source must be split, not truncated');

      const out = parse(await longHandlers.semantic_search({
        vault: name,
        query: 'context boundary evidence',
        limit: 3,
      }));
      assert.ok(out.results.some(result => result.path === 'Long.md'));
      assert.equal(out.indexCompatibility?.state, 'complete');
      assert.equal(out.indexCompatibility?.reindexRequired, false);
    } finally {
      const { getSharedStorage } = await import('../../dist/embeddings/storage.js');
      try {
        getSharedStorage(vault).close();
      } catch {
        // The temporary directory cleanup remains authoritative.
      }
      cleanup(vault);
    }
  });
});
