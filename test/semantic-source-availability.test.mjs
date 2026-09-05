import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as realFs from 'node:fs/promises';
import { cleanup, createTempVault } from './helpers.mjs';

const readFailures = new Set();
const syncReadFailures = new Set();
const reads = new Map();
let afterRead = async () => {};
let openOverride;
let graphHook = async () => {};
const graphInputs = [];
let openHandles = 0;

await mock.module('fs', {
  defaultExport: { ...fs },
  namedExports: {
    ...fs,
    accessSync: (target, mode) => {
      if (syncReadFailures.has(String(target))) {
        throw Object.assign(new Error('injected synchronous access denial'), { code: 'EACCES' });
      }
      return fs.accessSync(target, mode);
    },
  },
});

await mock.module('fs/promises', {
  namedExports: {
    ...realFs,
    open: async (target, flags, mode) => {
      const handle = await (openOverride?.(target, flags) ?? realFs.open(target, flags, mode));
      openHandles += 1;
      return {
        stat: handle.stat.bind(handle),
        readFile: async options => {
          const key = String(target);
          reads.set(key, (reads.get(key) ?? 0) + 1);
          if (readFailures.has(key)) {
            throw Object.assign(new Error('injected read denial'), { code: 'EACCES' });
          }
          const content = await handle.readFile(options);
          await afterRead(key);
          return content;
        },
        close: async () => {
          await handle.close();
          openHandles -= 1;
        },
      };
    },
  },
});

const ollamaUrl = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const realOllama = await import(ollamaUrl);
const model = { name: 'fixture:latest', digest: 'sha256:fixture' };
const modelIdentity = `${model.name}@${model.digest}`;
await mock.module(ollamaUrl, {
  namedExports: {
    ...realOllama,
    checkOllamaAvailability: async () => ({ available: true, hasModel: true, model }),
    assertOllamaModelIdentity: async () => {},
    generateEmbedding: async () => ({
      embedding: [1, 0], dimensions: 2, model: model.name, digest: model.digest,
    }),
  },
});

const providerState = {
  selectedProvider: 'filesystem', approximate: true,
  exactProviderAvailability: 'disabled', exactProviderInvoked: false,
};
const graphMeta = {
  graphAvailable: true, provider: 'filesystem', providerState,
};
await mock.module(new URL('../dist/tools/graph-annotate.js', import.meta.url).href, {
  namedExports: {
    attachGraphSignals: async ({ results }) => {
      graphInputs.push(results.map(row => row.path));
      await graphHook();
      return {
        ...graphMeta, activeExclude: [], usedDefaultExclude: true,
        results: results.map(row => ({ ...row, graph: null })),
      };
    },
    annotateCrossVault: async ({ results }) => {
      await graphHook();
      return {
        graphByVault: Object.fromEntries(results.map(row => [row.vault, graphMeta])),
        results: results.map(row => ({ ...row, graph: null })),
      };
    },
  },
});

const { getSharedStorage } = await import('../dist/embeddings/storage.js');
const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const { SemanticSources } = await import('../dist/tools/semantic-source.js');
const vaults = [];
const stores = [];

afterEach(() => {
  mock.restoreAll();
  readFailures.clear();
  syncReadFailures.clear();
  reads.clear();
  afterRead = async () => {};
  openOverride = undefined;
  graphHook = async () => {};
  graphInputs.length = 0;
  for (const store of stores.splice(0)) store.close();
  for (const vault of vaults.splice(0)) cleanup(vault);
  assert.equal(openHandles, 0, 'verified-reader handles close on success and failure');
});

function makeVault(files = {}) {
  const vault = fs.realpathSync(createTempVault(files));
  vaults.push(vault);
  return vault;
}

function fixture(files) {
  const vault = makeVault(files);
  const store = getSharedStorage(vault);
  stores.push(store);
  const config = {
    mode: 'multi', vaults: [{ name: 'Fixture', path: vault }],
    ollama: { host: 'http://unused.invalid', model: model.name },
    disabledTools: new Set(), readOnly: true, wrapUntrusted: false,
  };
  return {
    vault, store, config,
    handlers: createSemanticHandlers(config),
    cross: createCrossVaultHandlers(config),
    put: (filePath, embedding = [1, 0], blockId = null, metadata = {}) => {
      store.store(filePath, embedding, 'fixture-hash', {
        modelIdentity, ...metadata,
      }, blockId, `passage for ${filePath}:${blockId ?? ''}`);
    },
  };
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

function assertNoExactTotals(result) {
  for (const key of ['total', 'returned', 'truncated', 'has_more']) {
    assert.equal(key in result, false, `${key} must not imply an exact corpus count`);
  }
}

function assertPartial(result, skipped, reasons = ['file_unreadable']) {
  assert.equal(result.completeness.state, 'partial');
  assert.equal(result.completeness.skipped, skipped);
  assert.deepEqual(result.completeness.reasons, reasons);
  assertNoExactTotals(result);
}

for (const failure of ['missing', 'unreadable', 'directory']) {
  test(`get_similar rejects an indexed ${failure} reference before reading its vector`, async () => {
    const f = fixture({ 'Reference.md': '# Reference', 'Other.md': '# Other' });
    f.put('Reference.md');
    f.put('Other.md');
    const reference = path.join(f.vault, 'Reference.md');
    if (failure !== 'unreadable') fs.unlinkSync(reference);
    if (failure === 'directory') fs.mkdirSync(reference);
    if (failure === 'unreadable') readFailures.add(reference);
    const get = mock.method(f.store, 'get', () => { throw new Error('must not read cached vector'); });
    const search = mock.method(f.store, 'searchCompatible', () => { throw new Error('must not search'); });

    const response = await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md' });
    assert.equal(response.isError, true);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'file_unavailable');
    assert.deepEqual(result.sideEffects, { state: 'none' });
    assert.equal(result.similarFiles, undefined);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(search.mock.callCount(), 0);
  });
}

for (const tool of ['semantic_search', 'semantic_search_all', 'get_similar']) {
  test(`${tool} excludes deleted and unreadable indexed targets without blank success rows`, async () => {
    const f = fixture({
      'Reference.md': '# Reference', 'Deleted.md': '# Deleted',
      'Denied.md': '# Denied', 'Healthy.md': '# Healthy\n\nCurrent text',
    });
    if (tool === 'get_similar') f.put('Reference.md');
    f.put('Deleted.md');
    f.put('Denied.md', [0.9, 0.1]);
    f.put('Healthy.md', [0.8, 0.2]);
    fs.unlinkSync(path.join(f.vault, 'Deleted.md'));
    readFailures.add(path.join(f.vault, 'Denied.md'));
    const response = tool === 'get_similar'
      ? await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 2 })
      : tool === 'semantic_search_all'
        ? await f.cross.semantic_search_all({ query: 'unmatched', limit: 2, minSimilarity: 0 })
        : await f.handlers.semantic_search({ vault: 'Fixture', query: 'unmatched', limit: 2, minSimilarity: 0 });
    const result = payload(response);
    const rows = result.results ?? result.similarFiles;
    assert.deepEqual(rows.map(row => row.path), ['Healthy.md']);
    assert.equal(rows[0].title, 'Healthy');
    if (tool !== 'get_similar') assert.equal(rows[0].preview, '# Healthy\n\nCurrent text');
    if (tool === 'semantic_search_all') {
      assertPartial(result, 1);
      assertPartial(result.resultMetadataByVault[0], 2);
      assert.equal(result.resultMetadataByVault[0].state, 'searched');
    } else {
      assertPartial(result, 2);
    }
    assert.equal(result.limit_reached, undefined);
  });
}

test('semantic_search filters unavailable semantic and keyword-only candidates before reranking', async () => {
  const f = fixture({
    'Missing.md': '# Missing', 'Denied.md': '# Denied',
    'KeywordOnly.md': '# Keyword', 'Healthy.md': '# Healthy',
  });
  f.put('Missing.md');
  f.put('Denied.md');
  f.put('Healthy.md', [0.9, 0.1]);
  fs.unlinkSync(path.join(f.vault, 'Missing.md'));
  fs.unlinkSync(path.join(f.vault, 'KeywordOnly.md'));
  readFailures.add(path.join(f.vault, 'Denied.md'));
  mock.method(f.store, 'keywordSearchCompatible', () => [
    { filePath: 'KeywordOnly.md', blockId: 'keyword', score: 10 },
  ]);
  const input = [];
  const result = payload(await f.handlers.semantic_search({
    vault: 'Fixture', query: 'unmatched', limit: 2, minSimilarity: 0, rerank: true,
    _rerankerBackend: {
      name: 'capture', available: () => true,
      rerank: async (_query, rows) => {
        input.push(...rows);
        return rows.map(row => ({ id: row.id, reranker_score: 1 }));
      },
    },
  }));
  assert.deepEqual(input.map(row => row.id), ['Healthy.md:']);
  assert.deepEqual(result.results.map(row => row.path), ['Healthy.md']);
  assert.equal(result.results[0].per_signal.embeddings.rank, 3, 'source filtering does not rescore fusion');
  assertPartial(result, 3);
});

for (const failure of ['deleted', 'unreadable']) {
  test(`semantic_search revalidates a target made ${failure} during reranking and uses only its bounded reserve`, async () => {
    const f = fixture({ 'A.md': '# A', 'B.md': '# B', 'C.md': '# C' });
    f.put('A.md');
    f.put('B.md', [0.9, 0.1]);
    f.put('C.md', [0.8, 0.2]);
    const input = [];
    const result = payload(await f.handlers.semantic_search({
      vault: 'Fixture', query: 'unmatched', limit: 1, minSimilarity: 0, rerank: true,
      _rerankerBackend: {
        name: 'mutate', available: () => true,
        rerank: async (_query, rows) => {
          input.push(...rows);
          await Promise.resolve();
          if (failure === 'deleted') fs.unlinkSync(path.join(f.vault, 'A.md'));
          else readFailures.add(path.join(f.vault, 'A.md'));
          return rows.map(row => ({ id: row.id, reranker_score: 1 }));
        },
      },
    }));
    assert.deepEqual(input.map(row => row.id), ['A.md:']);
    assert.deepEqual(result.results.map(row => row.path), ['B.md']);
    assert.equal(result.results[0].reranker_score, null, 'reserve was not reranked');
    assert.equal(result.results[0].per_signal.embeddings.rank, 2);
    assert.equal(result.limit_reached, true, 'provider sentinel remains evidence-only');
    assert.equal(reads.has(path.join(f.vault, 'C.md')), false, 'sentinel does not become a reserve');
    assertPartial(result, 1);
  });
}

for (const tool of ['semantic_search', 'semantic_search_all']) {
  test(`${tool} drops targets removed during awaited graph enrichment`, async () => {
    const f = fixture({ 'A.md': '# A', 'B.md': '# B' });
    f.put('A.md');
    f.put('B.md', [0.9, 0.1]);
    graphHook = async () => {
      await Promise.resolve();
      fs.unlinkSync(path.join(f.vault, 'A.md'));
    };
    const result = payload(tool === 'semantic_search'
      ? await f.handlers.semantic_search({ vault: 'Fixture', query: 'unmatched', limit: 2, minSimilarity: 0 })
      : await f.cross.semantic_search_all({ query: 'unmatched', limit: 2, minSimilarity: 0 }));
    assert.deepEqual(result.results.map(row => row.path), ['B.md']);
    assert.equal(result.resultCount, 1);
    assertPartial(result, 1);
    if (tool === 'semantic_search_all') assertPartial(result.resultMetadataByVault[0], 1);
  });
}

test('semantic_search can backfill a graph-time deletion without promoting a provider sentinel', async () => {
  const f = fixture({ 'A.md': '# A', 'B.md': '# B', 'Sentinel.md': '# Sentinel' });
  f.put('A.md');
  f.put('B.md', [0.9, 0.1]);
  f.put('Sentinel.md', [0.8, 0.2]);
  graphHook = async () => {
    graphHook = async () => {};
    fs.unlinkSync(path.join(f.vault, 'A.md'));
  };
  const result = payload(await f.handlers.semantic_search({
    vault: 'Fixture', query: 'unmatched', limit: 1, minSimilarity: 0,
  }));
  assert.deepEqual(result.results.map(row => row.path), ['B.md']);
  assert.deepEqual(graphInputs, [['A.md'], ['B.md']], 'reserve enters graph enrichment only after deletion');
  assert.equal(reads.has(path.join(f.vault, 'Sentinel.md')), false);
  assertPartial(result, 1);
});

for (const rerank of [false, true]) {
  test(`semantic_search keeps healthy graph and reranker inputs at top-K (rerank=${rerank})`, async () => {
    const f = fixture(Object.fromEntries(['A', 'B', 'C', 'D', 'Sentinel'].map(name => [`${name}.md`, `# ${name}`])));
    await f.store.runBatch(async () => {
      for (const name of ['A', 'B', 'C', 'D', 'Sentinel']) f.put(`${name}.md`);
    });
    const rerankerInputs = [];
    const result = payload(await f.handlers.semantic_search({
      vault: 'Fixture', query: 'unmatched', limit: 2, minSimilarity: 0, rerank,
      _rerankerBackend: {
        name: 'capture-top-k', available: () => true,
        rerank: async (_query, rows) => {
          rerankerInputs.push(rows.map(row => row.id));
          return rows.map(row => ({ id: row.id, reranker_score: 1 }));
        },
      },
    }));
    assert.deepEqual(result.results.map(row => row.path), ['A.md', 'B.md']);
    assert.deepEqual(graphInputs, [['A.md', 'B.md']]);
    assert.deepEqual(rerankerInputs, rerank ? [['A.md:', 'B.md:']] : []);
    assert.equal(reads.has(path.join(f.vault, 'Sentinel.md')), false);
    assert.equal(result.limit_reached, true);
  });
}

for (const tool of ['semantic_search', 'semantic_search_all', 'get_similar']) {
  test(`${tool} detects target deletion during the verified Markdown read`, async () => {
    const f = fixture({ 'Reference.md': '# Reference', 'Target.md': '# Target' });
    if (tool === 'get_similar') f.put('Reference.md');
    f.put('Target.md');
    afterRead = async target => {
      if (target === path.join(f.vault, 'Target.md')) fs.unlinkSync(target);
    };
    const result = payload(tool === 'get_similar'
      ? await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md' })
      : tool === 'semantic_search'
        ? await f.handlers.semantic_search({ vault: 'Fixture', query: 'unmatched', minSimilarity: 0 })
        : await f.cross.semantic_search_all({ query: 'unmatched', minSimilarity: 0 }));
    assert.deepEqual(result.results ?? result.similarFiles, []);
    assertPartial(result, 1);
  });
}

for (const failure of ['deleted', 'unreadable']) {
  test(`get_similar rejects a reference made ${failure} during target enrichment`, async () => {
    const f = fixture({ 'Reference.md': '# Reference', 'Target.md': '# Target' });
    f.put('Reference.md');
    f.put('Target.md');
    afterRead = async target => {
      if (target !== path.join(f.vault, 'Target.md')) return;
      afterRead = async () => {};
      const reference = path.join(f.vault, 'Reference.md');
      if (failure === 'deleted') fs.unlinkSync(reference);
      else readFailures.add(reference);
    };
    const response = await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md' });
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).code, 'file_unavailable');
  });
}

test('get_similar returns distinct best-score files beyond many self and duplicate chunks with stable ties', async () => {
  const f = fixture({
    'Reference.md': '# Reference', 'Best.md': '# Best',
    'TieB.md': '# Tie B', 'TieA.md': '# Tie A', 'Last.md': '# Last',
  });
  await f.store.runBatch(async () => {
    for (let i = 0; i < 80; i++) f.put('Reference.md', [1, 0], `self-${i}`);
    f.put('Best.md', [0.7, 0.3], 'weaker-first');
    for (let i = 0; i < 80; i++) f.put('Best.md', [1, 0.01], `best-${i}`);
    f.put('TieB.md', [0.8, 0.2]);
    f.put('TieA.md', [0.8, 0.2]);
    f.put('Last.md', [0.6, 0.4]);
  });
  for (let i = 0; i < 2; i++) {
    const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 3 }));
    assert.deepEqual(result.similarFiles.map(row => row.path), ['Best.md', 'TieB.md', 'TieA.md']);
    assert.equal(result.similarFiles[0].similarity, 1, 'best chunk wins even when inserted later');
    assert.equal(result.limit_reached, true);
    assert.equal(result.completeness, undefined);
    assertNoExactTotals(result);
  }
});

test('get_similar source I/O follows the file limit instead of the compatible vault size', async () => {
  const names = Array.from({ length: 100 }, (_, i) => `Target-${String(i).padStart(3, '0')}.md`);
  const f = fixture({
    'Reference.md': '# Reference',
    ...Object.fromEntries(names.map(name => [name, `# ${name}`])),
  });
  await f.store.runBatch(async () => {
    f.put('Reference.md');
    for (const name of names) f.put(name);
  });
  for (const limit of [2, 5]) {
    reads.clear();
    const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit }));
    assert.deepEqual(result.similarFiles.map(row => row.path), names.slice(0, limit));
    assert.equal(result.limit_reached, true);
    assert.deepEqual([...reads.keys()], ['Reference.md', ...names.slice(0, limit + 1)].map(name => path.join(f.vault, name)));
    assert.ok([...reads.values()].every(count => count === 2), 'only initial validation and retained-pool revalidation');
    assert.equal([...reads.values()].reduce((sum, count) => sum + count, 0), 2 * (limit + 2));
  }
});

test('get_similar replenishes the retained file pool after deletion without reading the unused tail', async () => {
  const f = fixture({ 'Reference.md': '# Reference', 'A.md': '# A', 'B.md': '# B', 'C.md': '# C', 'D.md': '# D' });
  await f.store.runBatch(async () => {
    for (const name of ['Reference', 'A', 'B', 'C', 'D']) f.put(`${name}.md`);
  });
  afterRead = async target => {
    if (target !== path.join(f.vault, 'B.md')) return;
    afterRead = async () => {};
    fs.unlinkSync(path.join(f.vault, 'A.md'));
  };
  const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 1 }));
  assert.deepEqual(result.similarFiles.map(row => row.path), ['B.md']);
  assert.equal(result.limit_reached, true, 'C is the replacement evidence file');
  assert.ok(reads.has(path.join(f.vault, 'C.md')));
  assert.equal(reads.has(path.join(f.vault, 'D.md')), false);
  assertPartial(result, 1);
});

for (const failure of ['deleted', 'unreadable']) {
  test(`get_similar catches a target made ${failure} in the final reference reread`, async () => {
    const f = fixture({ 'Reference.md': '# Reference', 'A.md': '# A', 'B.md': '# B', 'C.md': '# C', 'D.md': '# D' });
    await f.store.runBatch(async () => {
      for (const name of ['Reference', 'A', 'B', 'C', 'D']) f.put(`${name}.md`);
    });
    afterRead = async target => {
      if (target !== path.join(f.vault, 'Reference.md') || reads.get(target) !== 2) return;
      const removed = path.join(f.vault, 'A.md');
      assert.equal(reads.get(removed), 2, 'target refresh already completed before reference reread');
      if (failure === 'deleted') fs.unlinkSync(removed);
      else syncReadFailures.add(removed);
    };
    const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 1 }));
    assert.deepEqual(result.similarFiles.map(row => row.path), ['B.md']);
    assert.equal(result.limit_reached, true, 'C replenishes the evidence slot');
    assert.equal(reads.has(path.join(f.vault, 'D.md')), false);
    assertPartial(result, 1);
  });
}

test('get_similar retains a higher-ranked consumed alias when its chosen pathname disappears during a later read', async () => {
  const f = fixture({ 'Reference.md': '# Reference', 'A.md': '# Shared target', 'B.md': '# B', 'C.md': '# C' });
  fs.linkSync(path.join(f.vault, 'A.md'), path.join(f.vault, 'Alias.md'));
  await f.store.runBatch(async () => {
    f.put('Reference.md');
    f.put('A.md');
    f.put('Alias.md', [0.8, 0.6]);
    f.put('B.md', [0.6, 0.8]);
    f.put('C.md', [0, 1]);
  });
  afterRead = async target => {
    if (target !== path.join(f.vault, 'B.md')) return;
    afterRead = async () => {};
    assert.equal(reads.get(path.join(f.vault, 'Alias.md')), 1, 'alias was already consumed as a duplicate identity');
    fs.unlinkSync(path.join(f.vault, 'A.md'));
  };
  const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 1 }));
  assert.deepEqual(result.similarFiles, [{ path: 'Alias.md', title: 'Shared target', similarity: 0.8 }]);
  assert.equal(result.limit_reached, true, 'B remains the lower-ranked evidence file');
  assert.equal(reads.get(path.join(f.vault, 'Alias.md')), 1, 'fallback needs only the final synchronous availability sweep');
  assert.equal(reads.has(path.join(f.vault, 'C.md')), false);
  assertPartial(result, 1);
});

for (const tool of ['semantic_search', 'semantic_search_all']) {
  test(`${tool} sweeps earlier targets after the final awaited target refresh`, async () => {
    const f = fixture({ 'A.md': '# A', 'B.md': '# B' });
    f.put('A.md');
    f.put('B.md', [0.8, 0.6]);
    afterRead = async target => {
      if (target === path.join(f.vault, 'B.md') && reads.get(target) === 2) {
        assert.equal(reads.get(path.join(f.vault, 'A.md')), 2);
        fs.unlinkSync(path.join(f.vault, 'A.md'));
      }
    };
    const result = payload(tool === 'semantic_search'
      ? await f.handlers.semantic_search({ vault: 'Fixture', query: 'unmatched', limit: 2, minSimilarity: 0 })
      : await f.cross.semantic_search_all({ query: 'unmatched', limit: 2, minSimilarity: 0 }));
    assert.deepEqual(result.results.map(row => row.path), ['B.md']);
    assertPartial(result, 1);
    if (tool === 'semantic_search_all') assertPartial(result.resultMetadataByVault[0], 1);
  });
}

test('get_similar keeps whole-file then first-section reference-vector policy', async () => {
  const f = fixture({ 'Reference.md': '# Reference', 'X.md': '# X', 'Y.md': '# Y' });
  f.put('Reference.md', [0, 1], 'first');
  f.put('Reference.md', [1, 0], 'later');
  f.put('X.md', [1, 0]);
  f.put('Y.md', [0, 1]);
  const section = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 1 }));
  assert.equal(section.similarFiles[0].path, 'Y.md');
  f.put('Reference.md', [1, 0]);
  const whole = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 1 }));
  assert.equal(whole.similarFiles[0].path, 'X.md');
});

test('get_similar excludes physical self aliases and collapses target aliases without Unicode folding distinct files', async () => {
  const nfc = 'Caf\u00e9.md';
  const nfd = 'Cafe\u0301.md';
  const f = fixture({ 'Reference.md': '# Reference', [nfc]: '# NFC', [nfd]: '# NFD', 'Last.md': '# Last' });
  fs.linkSync(path.join(f.vault, 'Reference.md'), path.join(f.vault, 'SelfAlias.md'));
  fs.symlinkSync(nfc, path.join(f.vault, 'TargetAlias.md'));
  for (const file of ['Reference.md', 'SelfAlias.md', nfc, nfd, 'TargetAlias.md', 'Last.md']) f.put(file);
  const distinctUnicode = fs.statSync(path.join(f.vault, nfc)).ino !== fs.statSync(path.join(f.vault, nfd)).ino;
  const result = payload(await f.handlers.get_similar({ vault: 'Fixture', path: 'Reference.md', limit: 10 }));
  assert.deepEqual(result.similarFiles.map(row => row.path), distinctUnicode ? [nfc, nfd, 'Last.md'] : [nfc, 'Last.md']);
  assert.equal(result.limit_reached, undefined);
});

test('semantic source validation rejects directories, traversal, symlink escapes and swapped opened handles', async () => {
  const vault = makeVault({ 'Safe.md': '# Safe' });
  const outside = makeVault({ 'Secret.md': '# Private outside content' });
  fs.mkdirSync(path.join(vault, 'Directory.md'));
  fs.symlinkSync(path.join(outside, 'Secret.md'), path.join(vault, 'Escape.md'));
  const sources = new SemanticSources(vault);
  for (const file of ['Directory.md', '../Outside.md', path.join(vault, 'Safe.md'), 'Escape.md']) {
    assert.equal(await sources.read(file), null);
  }
  const safe = path.join(vault, 'Safe.md');
  openOverride = target => String(target) === safe
    ? realFs.open(path.join(outside, 'Secret.md'), 'r')
    : undefined;
  assert.equal(await sources.read('Safe.md'), null, 'opened handle must match its contained pathname');
  assert.equal(reads.has(safe), false, 'reject before reading the outside handle');
  assertPartial(sources.metadata(), 5);
});

test('verified Markdown reader uses nonblocking open and rejects a non-regular handle after source stat', async () => {
  const vault = makeVault({ 'Swap.md': '# Initially regular' });
  const target = path.join(vault, 'Swap.md');
  let openedFlags;
  openOverride = async (openedPath, flags) => {
    assert.equal(String(openedPath), target);
    openedFlags = flags;
    const handle = await realFs.open(openedPath, flags);
    return {
      // Model a regular-file-to-FIFO swap between the source pre-stat and
      // parser open. Containment still verifies; reading must never begin.
      stat: async options => {
        const stat = await handle.stat(options);
        if (!options?.bigint) stat.isFile = () => false;
        return stat;
      },
      readFile: handle.readFile.bind(handle),
      close: handle.close.bind(handle),
    };
  };
  const sources = new SemanticSources(vault);
  assert.equal(await sources.read('Swap.md'), null);
  assert.equal(openedFlags, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  assert.equal(reads.has(target), false, 'non-regular handle is rejected before readFile');
  assertPartial(sources.metadata(), 1);
});

test('healthy semantic payload keeps scores, graph metadata, preview and default-off fields', async () => {
  const f = fixture({ 'Healthy.md': '---\ntitle: Display Title\n---\n# Heading\n\nCurrent text' });
  f.put('Healthy.md');
  const result = payload(await f.handlers.semantic_search({
    vault: 'Fixture', query: 'unmatched', limit: 3, minSimilarity: 0,
  }));
  assert.deepEqual(result.results, [{
    path: 'Healthy.md', title: 'Display Title', similarity: 0.7, semanticScore: 1, keywordScore: 0,
    fusionScore: 1 / 61, fusionMethod: 'rrf',
    per_signal: { bm25: { rank: null }, embeddings: { rank: 1 } },
    rrf_term: { k: 60, bm25: 0, embeddings: 1 / 61 },
    reranker_score: null, preview: '# Heading\n\nCurrent text', graph: null,
  }]);
  assert.equal(result.resultCount, 1);
  assert.equal(result.searchType, 'hybrid');
  assert.deepEqual(result.queriesUsed, ['unmatched']);
  assert.deepEqual(result.providerState, providerState);
  assert.equal(result.graphAvailable, true);
  assert.equal(result.completeness, undefined);
  assert.equal(result.limit_reached, undefined);
  assert.equal('rerankerAvailable' in result, false);
  assert.equal(result.indexCompatibility.excludedEmbeddingCount, 0);
  assertNoExactTotals(result);

  const cross = payload(await f.cross.semantic_search_all({ query: 'unmatched', minSimilarity: 0 }));
  assert.deepEqual(cross.results, [{
    vault: 'Fixture', path: 'Healthy.md', title: 'Display Title', similarity: 1,
    preview: '# Heading\n\nCurrent text', graph: null,
  }]);
  assert.deepEqual(cross.graphByVault, { Fixture: graphMeta });
  assert.equal(cross.completeness, undefined);
  assert.equal(cross.limit_reached, undefined);
});
