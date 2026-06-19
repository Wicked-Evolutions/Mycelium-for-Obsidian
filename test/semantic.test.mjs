/**
 * semantic.test.mjs — Test suite for src/tools/semantic.ts
 *
 * Coverage:
 *   - index_status  (always-run: shape + graceful behaviour when unindexed)
 *   - semantic_search  (Ollama-gated via t.skip inside body)
 *   - get_similar     (Ollama-gated via t.skip inside body)
 *   - index_file      (Ollama-gated via t.skip inside body)
 *   - index_vault     (Ollama-gated via t.skip inside body, tiny 2-note vault)
 *
 * Skip-gating: Ollama availability is detected in before() and stored in a
 * shared flag. Each Ollama-dependent test calls `t.skip(); return` at the top
 * if Ollama is absent. The explicit `return` is required because node:test's
 * t.skip() does NOT halt execution — without it the body would continue and
 * fail. The flag is checked at runtime (inside the test function), not at
 * definition time, so it correctly sees the value set by before().
 *
 * Run: node --test test/semantic.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createSemanticHandlers } from '../dist/tools/semantic.js';
import { checkOllamaAvailability } from '../dist/embeddings/ollama.js';
import { EmbeddingStorage } from '../dist/embeddings/storage.js';

// ---------------------------------------------------------------------------
// Vault fixture — 2 notes with meaningful, distinct content
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
};

// ---------------------------------------------------------------------------
// Shared state populated by before()
// ---------------------------------------------------------------------------

let ollamaAvailable = false;   // Set in before(); checked at test runtime via t.skip()
let vaultDir;
let config;
let handlers;

before(async () => {
  vaultDir = createTempVault(VAULT_FILES);

  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  config = loadConfig();
  handlers = createSemanticHandlers(config);

  // Probe Ollama — the flag is read inside each gated test body, not at definition time
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Parse the first text content item of a ToolResponse as JSON. */
function parseJson(res) {
  assert.ok(Array.isArray(res.content), 'content is an array');
  assert.ok(res.content.length > 0, 'content is non-empty');
  assert.equal(typeof res.content[0].text, 'string', 'content[0].text is a string');
  return JSON.parse(res.content[0].text);
}

// ---------------------------------------------------------------------------
// index_status — ALWAYS RUN
// No Ollama required for the always-run assertions; the handler probes Ollama
// and includes the result in its output, but never fails if Ollama is absent.
// ---------------------------------------------------------------------------

describe('index_status (always-run)', () => {
  test('returns a non-error ToolResponse', async () => {
    const res = await handlers.index_status({ vault: 'TestVault' });
    assert.equal(typeof res, 'object', 'response is an object');
    assert.ok(Array.isArray(res.content), 'content is an array');
    assert.equal(res.isError, false, `isError must be false; got: ${res.content[0]?.text}`);
  });

  test('response JSON has required top-level keys', async () => {
    const res = await handlers.index_status({ vault: 'TestVault' });
    const data = parseJson(res);

    assert.equal(typeof data.vault, 'string', 'data.vault is a string');
    assert.equal(data.vault, 'TestVault', 'data.vault matches the vault name');
    assert.equal(typeof data.totalEmbeddings, 'number', 'totalEmbeddings is a number');
    assert.equal(typeof data.uniqueFiles, 'number', 'uniqueFiles is a number');
    assert.ok(
      data.lastUpdated === null || typeof data.lastUpdated === 'string',
      'lastUpdated is null or an ISO string',
    );
  });

  test('response JSON includes ollama sub-object', async () => {
    const res = await handlers.index_status({ vault: 'TestVault' });
    const data = parseJson(res);

    assert.equal(typeof data.ollama, 'object', 'ollama key is an object');
    assert.equal(typeof data.ollama.available, 'boolean', 'ollama.available is a boolean');
    assert.equal(typeof data.ollama.hasModel, 'boolean', 'ollama.hasModel is a boolean');
    assert.equal(typeof data.ollama.model, 'string', 'ollama.model is a string');
    // error key may be present or absent depending on Ollama state — allow both
    if ('error' in data.ollama) {
      assert.ok(
        data.ollama.error === undefined || typeof data.ollama.error === 'string',
        'ollama.error is undefined or string',
      );
    }
  });

  test('fresh (unindexed) vault reports zero embeddings and null lastUpdated', async () => {
    const res = await handlers.index_status({ vault: 'TestVault' });
    const data = parseJson(res);

    assert.equal(data.totalEmbeddings, 0, 'no embeddings in a fresh vault');
    assert.equal(data.uniqueFiles, 0, 'no unique files in a fresh vault');
    assert.equal(data.lastUpdated, null, 'lastUpdated is null when nothing indexed');
  });

  test('works without vault param (falls back to primary vault)', async () => {
    // No `vault` key — should resolve to primary vault (TestVault)
    const res = await handlers.index_status({});
    assert.equal(res.isError, false, `isError must be false; got: ${res.content[0]?.text}`);
    const data = parseJson(res);
    assert.equal(typeof data.vault, 'string', 'data.vault is present');
    assert.equal(typeof data.totalEmbeddings, 'number', 'totalEmbeddings is present');
  });

  test('unknown vault name returns an error response', async () => {
    // resolveVault throws; handler wraps the error as isError:true
    const res = await handlers.index_status({ vault: 'NoSuchVault' });
    assert.equal(res.isError, true, 'isError must be true for unknown vault');
    assert.ok(res.content[0].text.length > 0, 'error message is non-empty');
  });
});

// ---------------------------------------------------------------------------
// semantic_search — OLLAMA-GATED
// ---------------------------------------------------------------------------

describe('semantic_search (Ollama-gated)', () => {
  /**
   * This one is always-run: regardless of Ollama state, calling with an empty
   * index must not throw and must return a well-formed ToolResponse.
   */
  test('does not throw on empty vault (Ollama absent or present)', async () => {
    const res = await handlers.semantic_search({ vault: 'TestVault', query: 'marketing' });
    assert.equal(typeof res, 'object', 'response is an object');
    assert.ok(Array.isArray(res.content), 'content is an array');
    assert.equal(typeof res.content[0].text, 'string', 'text is a string');
    // isError may be true (Ollama absent) or false (empty index message) — both valid
  });

  test('returns "no indexed content" JSON when Ollama ready but vault is empty', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res = await handlers.semantic_search({ vault: 'TestVault', query: 'engineering' });
    assert.equal(res.isError, false, `should not be error; got: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.equal(typeof data.error, 'string', 'error field is a string');
    assert.ok(data.error.toLowerCase().includes('index'), 'error mentions indexing');
    assert.equal(typeof data.indexed, 'number', 'indexed field is a number');
    assert.equal(data.indexed, 0, 'indexed count is 0');
  });

  test('returns structured results after vault is indexed', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    // Index first so there is something to search
    const indexRes = await handlers.index_vault({ vault: 'TestVault', force: true });
    assert.equal(indexRes.isError, false, `index_vault failed: ${indexRes.content[0].text}`);

    const res = await handlers.semantic_search({
      vault: 'TestVault',
      query: 'marketing strategy brand awareness',
      limit: 5,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(typeof data.query, 'string', 'query is echoed back');
    assert.equal(data.query, 'marketing strategy brand awareness', 'query value matches');
    assert.equal(typeof data.resultCount, 'number', 'resultCount is a number');
    assert.ok(Array.isArray(data.results), 'results is an array');
    assert.equal(data.resultCount, data.results.length, 'resultCount matches results array length');

    for (const r of data.results) {
      assert.equal(typeof r.path, 'string', 'result.path is a string');
      assert.equal(typeof r.similarity, 'number', 'result.similarity is a number');
      assert.ok(r.similarity >= 0 && r.similarity <= 1, `similarity in [0,1]; got ${r.similarity}`);
      assert.equal(typeof r.semanticScore, 'number', 'semanticScore is a number');
      assert.equal(typeof r.keywordScore, 'number', 'keywordScore is a number');
      assert.equal(typeof r.title, 'string', 'result.title is a string');
    }
  });

  test('result count respects limit parameter', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res = await handlers.semantic_search({
      vault: 'TestVault',
      query: 'system architecture REST API',
      limit: 1,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.ok(data.results.length <= 1, `results must be <= limit=1; got ${data.results.length}`);
  });

  test('expand=false sets searchType to "hybrid" and queriesUsed has exactly 1 entry', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res = await handlers.semantic_search({
      vault: 'TestVault',
      query: 'microservices latency',
      expand: false,
    });
    assert.equal(res.isError, false, `search failed: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.equal(data.searchType, 'hybrid', 'searchType is "hybrid" when expand=false');
    assert.ok(Array.isArray(data.queriesUsed), 'queriesUsed is an array');
    assert.equal(data.queriesUsed.length, 1, 'only original query when expand=false');
    assert.equal(data.queriesUsed[0], 'microservices latency', 'queriesUsed[0] is the original query');
  });
});

// ---------------------------------------------------------------------------
// get_similar — partially always-run (not-indexed path), rest Ollama-gated
// ---------------------------------------------------------------------------

describe('get_similar (Ollama-gated)', () => {
  test('returns structured "not indexed" JSON when file has no embedding', async () => {
    // get_similar checks the store BEFORE calling Ollama, so this is always-run.
    // Use a path that is definitely not indexed (does not exist in the vault).
    const res = await handlers.get_similar({ vault: 'TestVault', path: 'NeverIndexed.md' });
    assert.equal(res.isError, false, `isError must be false; got: ${res.content[0].text}`);
    const data = parseJson(res);
    assert.equal(typeof data.error, 'string', 'error field is present');
    assert.ok(data.error.toLowerCase().includes('index'), 'error mentions indexing');
    assert.equal(data.path, 'NeverIndexed.md', 'path echoed back');
  });

  test('returns similarFiles array after indexing', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    // Ensure vault is indexed
    await handlers.index_vault({ vault: 'TestVault', force: true });

    const res = await handlers.get_similar({
      vault: 'TestVault',
      path: 'Marketing.md',
      limit: 3,
    });
    assert.equal(res.isError, false, `get_similar failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(data.referencePath, 'Marketing.md', 'referencePath echoed');
    assert.ok(Array.isArray(data.similarFiles), 'similarFiles is an array');

    // Self must be excluded from results
    const resultPaths = data.similarFiles.map(r => r.path);
    assert.ok(!resultPaths.includes('Marketing.md'), 'reference file excluded from results');

    for (const r of data.similarFiles) {
      assert.equal(typeof r.path, 'string', 'similar.path is a string');
      assert.equal(typeof r.similarity, 'number', 'similar.similarity is a number');
      assert.ok(r.similarity >= 0 && r.similarity <= 1, `similarity in [0,1]; got ${r.similarity}`);
      assert.equal(typeof r.title, 'string', 'similar.title is a string');
    }

    // Vault has 2 files; reference is excluded → max 1 similar result
    const vaultFileCount = Object.keys(VAULT_FILES).length;
    assert.ok(
      data.similarFiles.length <= Math.min(3, vaultFileCount - 1),
      `result count bounded by limit and available files; got ${data.similarFiles.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// index_file — OLLAMA-GATED
// ---------------------------------------------------------------------------

describe('index_file (Ollama-gated)', () => {
  test('indexes a single file and returns structured result', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res = await handlers.index_file({ vault: 'TestVault', path: 'Engineering.md' });
    assert.equal(res.isError, false, `index_file failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(data.indexed, true, 'indexed flag is true');
    assert.equal(data.path, 'Engineering.md', 'path echoed back');
    assert.equal(typeof data.sections, 'number', 'sections is a number');
    assert.ok(data.sections >= 1, `at least 1 section indexed; got ${data.sections}`);
  });

  test('after index_file the embedding is persisted in the storage layer', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    await handlers.index_file({ vault: 'TestVault', path: 'Marketing.md' });

    // Verify directly via the storage layer (bypasses the handler)
    const dbPath = path.join(vaultDir, '.mcp-obsidian', 'embeddings.db');
    const store = new EmbeddingStorage(dbPath);
    const stored = store.get('Marketing.md');
    assert.ok(stored !== null, 'embedding stored for Marketing.md');
    assert.ok(Array.isArray(stored.embedding), 'embedding is an array');
    assert.ok(stored.embedding.length > 0, 'embedding has elements');
    store.close();
  });

  test('re-indexing the same file does not produce an error', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res1 = await handlers.index_file({ vault: 'TestVault', path: 'Marketing.md' });
    const res2 = await handlers.index_file({ vault: 'TestVault', path: 'Marketing.md' });
    assert.equal(res1.isError, false, 'first index succeeded');
    assert.equal(res2.isError, false, 're-index succeeded without error');
  });

  test('index_file increases totalEmbeddings seen by index_status', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    // Clear any prior state by using a fresh vault for this test
    const freshDir = createTempVault({ 'Solo.md': '# Solo\n\nA standalone note.' });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ FreshVault: freshDir });
    const freshConfig = loadConfig();
    const freshHandlers = createSemanticHandlers(freshConfig);

    try {
      const before = await freshHandlers.index_status({ vault: 'FreshVault' });
      const beforeData = parseJson(before);
      assert.equal(beforeData.totalEmbeddings, 0, 'starts at 0 embeddings');

      await freshHandlers.index_file({ vault: 'FreshVault', path: 'Solo.md' });

      const after = await freshHandlers.index_status({ vault: 'FreshVault' });
      const afterData = parseJson(after);
      assert.ok(afterData.totalEmbeddings > 0, `totalEmbeddings increased; got ${afterData.totalEmbeddings}`);
      assert.equal(afterData.uniqueFiles, 1, 'one unique file after indexing Solo.md');
    } finally {
      // Restore original vault config
      process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
      cleanup(freshDir);
    }
  });
});

// ---------------------------------------------------------------------------
// index_vault — OLLAMA-GATED (tiny 2-note vault)
// ---------------------------------------------------------------------------

describe('index_vault (Ollama-gated)', () => {
  test('indexes all files and returns a complete summary object', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    const res = await handlers.index_vault({ vault: 'TestVault', force: true });
    assert.equal(res.isError, false, `index_vault failed: ${res.content[0].text}`);
    const data = parseJson(res);

    // Shape checks
    assert.equal(typeof data.vault, 'string', 'vault is a string');
    assert.equal(data.vault, 'TestVault', 'vault name echoed');
    assert.equal(typeof data.indexedFiles, 'number', 'indexedFiles is a number');
    assert.equal(typeof data.indexedSections, 'number', 'indexedSections is a number');
    assert.equal(typeof data.skipped, 'number', 'skipped is a number');
    assert.equal(typeof data.errors, 'number', 'errors is a number');
    assert.equal(typeof data.staleRemoved, 'number', 'staleRemoved is a number');
    assert.equal(typeof data.totalFiles, 'number', 'totalFiles is a number');

    // Semantic checks for a 2-file vault
    assert.equal(data.totalFiles, 2, 'totalFiles matches vault size');
    assert.equal(data.indexedFiles, 2, 'both files indexed');
    assert.equal(data.errors, 0, 'no errors during indexing');
    assert.ok(data.indexedSections >= data.indexedFiles, 'indexedSections >= indexedFiles');
  });

  test('index_status reflects updated counts after index_vault', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    await handlers.index_vault({ vault: 'TestVault', force: true });

    const res = await handlers.index_status({ vault: 'TestVault' });
    const data = parseJson(res);

    assert.ok(
      data.totalEmbeddings > 0,
      `totalEmbeddings > 0 after indexing; got ${data.totalEmbeddings}`,
    );
    assert.equal(data.uniqueFiles, 2, 'uniqueFiles matches vault file count');
    assert.equal(typeof data.lastUpdated, 'string', 'lastUpdated is a string after indexing');
    assert.ok(data.lastUpdated.length > 0, 'lastUpdated is non-empty');
  });

  test('force=false does not re-index unchanged files on second pass', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    // First pass: index everything
    await handlers.index_vault({ vault: 'TestVault', force: true });

    // Second pass without force: unchanged files must not be re-indexed.
    // Bug-2 fix: all files (including section-chunked) must land in exactly one of
    // indexedFiles / skipped / errors, so the accounting invariant always closes.
    const res = await handlers.index_vault({ vault: 'TestVault', force: false });
    assert.equal(res.isError, false, `index_vault (force=false) failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(data.indexedFiles, 0, 'no files re-indexed when content is unchanged');
    assert.equal(data.errors, 0, 'no errors on second pass');
    // totalFiles should still report the correct vault size
    assert.equal(data.totalFiles, 2, 'totalFiles still reflects vault size');
    // Accounting invariant: every file must appear in exactly one bucket
    assert.equal(
      data.indexedFiles + data.skipped + data.errors,
      data.totalFiles,
      `accounting invariant: indexedFiles(${data.indexedFiles}) + skipped(${data.skipped}) + errors(${data.errors}) must equal totalFiles(${data.totalFiles})`,
    );
  });

  test('force=true always re-indexes regardless of content hash', async (t) => {
    if (!ollamaAvailable) { t.skip('Ollama not available'); return; }

    await handlers.index_vault({ vault: 'TestVault', force: true });

    // Second force=true should re-index all files
    const res = await handlers.index_vault({ vault: 'TestVault', force: true });
    assert.equal(res.isError, false, `index_vault (force=true) failed: ${res.content[0].text}`);
    const data = parseJson(res);

    assert.equal(data.indexedFiles, 2, 'both files re-indexed with force=true');
    assert.equal(data.errors, 0, 'no errors on forced re-index');
  });
});
