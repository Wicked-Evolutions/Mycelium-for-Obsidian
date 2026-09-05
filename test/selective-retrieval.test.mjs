import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as actualFs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { cleanup, createTempVault } from './helpers.mjs';

const activity = { scans: [], storage: [], provider: [], graph: [], reads: [] };
const scanFailures = new Set();
const storageFailures = new Set();
const readFailures = new Set();
const vaults = [];
const stores = new Set();
let afterRead = async () => {};
let identityHook = async () => {};
let graphHook = async () => {};
let openHandles = 0;

await mock.module('fs/promises', { namedExports: {
  ...actualFs,
  readdir: async (target, options) => {
    activity.scans.push(String(target));
    if (scanFailures.has(String(target))) throw new Error('injected scan failure');
    return actualFs.readdir(target, options);
  },
  open: async (target, flags, mode) => {
    const handle = await actualFs.open(target, flags, mode);
    openHandles += 1;
    return {
      stat: handle.stat.bind(handle),
      readFile: async options => {
        const key = String(target);
        activity.reads.push(key);
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
} });

const model = { name: 'fixture:latest', digest: 'sha256:selective-retrieval' };
const modelIdentity = `${model.name}@${model.digest}`;
const ollamaUrl = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const actualOllama = await import(ollamaUrl);
await mock.module(ollamaUrl, { namedExports: {
  ...actualOllama,
  checkOllamaAvailability: async () => {
    activity.provider.push('availability');
    return { available: true, hasModel: true, model };
  },
  generateEmbedding: async () => {
    activity.provider.push('embedding');
    return { embedding: [1, 0], dimensions: 2, model: model.name, digest: model.digest };
  },
  assertOllamaModelIdentity: async () => {
    activity.provider.push('identity');
    await identityHook();
  },
} });

const storageUrl = new URL('../dist/embeddings/storage.js', import.meta.url).href;
const actualStorage = await import(storageUrl);
await mock.module(storageUrl, { namedExports: {
  ...actualStorage,
  getSharedStorage: root => {
    const vaultPath = typeof root === 'string' ? root : root.path;
    activity.storage.push(vaultPath);
    if (storageFailures.has(vaultPath)) throw new Error('injected storage failure');
    const store = actualStorage.getSharedStorage(root);
    stores.add(store);
    return store;
  },
} });

const providerState = {
  selectedProvider: 'filesystem', approximate: true,
  exactProviderAvailability: 'disabled', exactProviderInvoked: false,
};
const graphReceipt = { graphAvailable: true, provider: 'filesystem', providerState };
await mock.module(new URL('../dist/tools/graph-annotate.js', import.meta.url).href, {
  namedExports: {
    attachGraphSignals: async ({ results }) => {
      activity.graph.push(results.map(row => row.path));
      await graphHook();
      return {
        ...graphReceipt, activeExclude: ['Archive/'], usedDefaultExclude: true,
        results: results.map(row => ({ ...row, graph: { degree: 7 } })),
      };
    },
    annotateCrossVault: async ({ results }) => {
      activity.graph.push(results.map(row => [row.vault, row.path]));
      await graphHook();
      return {
        graphByVault: Object.fromEntries(results.map(row => [row.vault, graphReceipt])),
        results: results.map(row => ({ ...row, graph: { degree: 7 } })),
      };
    },
  },
});

const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const { createAllHandlers } = await import('../dist/tools/index.js');
const { UNTRUSTED_BEGIN, UNTRUSTED_END } = await import('../dist/tools/safety.js');

function resetActivity() {
  for (const entries of Object.values(activity)) entries.length = 0;
}

afterEach(() => {
  mock.restoreAll();
  afterRead = async () => {};
  identityHook = async () => {};
  graphHook = async () => {};
  scanFailures.clear();
  storageFailures.clear();
  readFailures.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const vault of vaults.splice(0)) cleanup(vault);
  resetActivity();
  assert.equal(openHandles, 0, 'all verified-reader handles close');
});

function makeVault(files = {}) {
  const vault = fs.realpathSync(createTempVault(files));
  vaults.push(vault);
  return vault;
}

function fixture(entries = [['Fixture', { 'Note.md': '# Note\nneedle' }]]) {
  const configured = entries.map(([name, files]) => ({ name, path: makeVault(files) }));
  const config = {
    mode: 'multi', vaults: configured,
    ollama: { host: 'http://unused.invalid', model: model.name },
    disabledTools: new Set(), readOnly: true, wrapUntrusted: false,
  };
  const vault = (name = 'Fixture') => configured.find(item => item.name === name).path;
  const store = (name = 'Fixture') => {
    const storage = actualStorage.getSharedStorage(vault(name));
    stores.add(storage);
    return storage;
  };
  return {
    config, vault, store,
    handlers: { ...createSemanticHandlers(config), ...createCrossVaultHandlers(config) },
    put(filePath, {
      vault: name = 'Fixture', embedding = [1, 0], blockId = null,
      content = 'Indexed passage', metadata = {},
    } = {}) {
      const contentHash = createHash('sha256').update(content ?? filePath).digest('hex');
      store(name).store(filePath, embedding, contentHash, { modelIdentity, ...metadata },
        blockId, content ?? undefined);
    },
  };
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

function search(f, tool, options = {}) {
  return f.handlers[tool]({
    ...(tool === 'semantic_search' ? { vault: 'Fixture' } : {}),
    query: 'needle', limit: 2, minSimilarity: 0.3, ...options,
  });
}

function withoutResults(result) {
  const { results, ...receipt } = result;
  return receipt;
}

function assertNoRetrieval() {
  assert.deepEqual(activity, { scans: [], storage: [], provider: [], graph: [], reads: [] });
}

function assertAvailable(evidence, row, { heading = row.metadata.heading } = {}) {
  assert.ok(evidence, 'requested evidence is attached to the hit');
  const { excerpt, truncatedBefore, truncatedAfter, ...identity } = evidence;
  assert.deepEqual(identity, {
    state: 'available', source: 'indexed_embedding_text',
    blockId: row.blockId, contentHash: row.contentHash, modelIdentity,
    updatedAt: row.updatedAt,
    ...(heading === undefined ? {} : { heading, headingTruncated: false }),
    currentSourceVerified: false,
  });
  assert.equal(typeof excerpt, 'string');
  assert.ok(Array.from(excerpt).length <= 600);
  assert.equal(excerpt.isWellFormed(), true);
  assert.equal(typeof truncatedBefore, 'boolean');
  assert.equal(typeof truncatedAfter, 'boolean');
}

for (const tool of ['search_all_vaults', 'semantic_search_all']) {
  test(`${tool} honors omission, explicit all, configured order, duplicates and case variants`, async () => {
    const f = fixture(['Alpha', 'Beta', 'Gamma'].map(name => [name, { 'Note.md': '# Note\nneedle' }]));
    if (tool === 'semantic_search_all') {
      for (const { name } of f.config.vaults) f.put('Note.md', { vault: name });
    }
    const baseline = payload(await search(f, tool, { limit: 10 }));
    for (const [selection, expected] of [
      [undefined, ['Alpha', 'Beta', 'Gamma']],
      [['Gamma', 'Beta', 'Alpha'], ['Alpha', 'Beta', 'Gamma']],
      [['Gamma', 'Alpha'], ['Alpha', 'Gamma']],
      [['Gamma', 'Alpha', 'Gamma', 'Alpha'], ['Alpha', 'Gamma']],
      [['gAMMa', 'ALPHA', 'alpha'], ['Alpha', 'Gamma']],
    ]) {
      resetActivity();
      const result = payload(await search(f, tool, {
        limit: 10, ...(selection === undefined ? {} : { vaults: selection }),
      }));
      assert.equal(result.vaultsSearched, expected.length);
      assert.deepEqual(result.results.map(row => row.vault), expected);
      assert.equal(result.completeness, undefined);
      if (expected.length === 3) assert.deepEqual(result, baseline);
      if (tool === 'semantic_search_all') {
        assert.equal(result.vaultsIndexed, expected.length);
        assert.equal(result.indexCompatibility.totalEmbeddingCount, expected.length);
        assert.deepEqual(result.resultMetadataByVault.map(row => row.vault), expected);
        assert.deepEqual(Object.keys(result.graphByVault), expected);
        assert.deepEqual(activity.storage, expected.map(f.vault));
      } else {
        assert.equal(result.totalResults, expected.length);
        assert.deepEqual(activity.scans, expected.map(f.vault));
        assert.deepEqual(activity.storage, []);
        assert.deepEqual(activity.provider, []);
      }
    }
  });

  for (const [label, selection, ambiguous] of [
    ['unknown after valid', ['Alpha', 'Unknown']],
    ['empty selection', []],
    ['empty name after valid', ['Alpha', '']],
    ['non-string after valid', ['Alpha', 42]],
    ['scalar instead of array', 'Alpha'],
    ['null selection', null],
    ['ambiguous exact spelling', ['Beta', 'Alpha'], true],
    ['ambiguous folded spelling', ['Beta', 'aLpHa'], true],
  ]) {
    test(`${tool} refuses ${label} before any scan, storage or provider call`, async () => {
      const names = ambiguous ? ['Beta', 'Alpha', 'ALPHA'] : ['Alpha', 'Beta'];
      const f = fixture(names.map(name => [name, { 'Note.md': '# Note\nneedle' }]));
      resetActivity();
      const response = await search(f, tool, { vaults: selection });
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent?.code, 'invalid_vault_selection');
      assert.deepEqual(response.structuredContent?.sideEffects, { state: 'none' });
      assertNoRetrieval();
      for (const { path: root } of f.config.vaults) {
        assert.equal(fs.existsSync(path.join(root, '.mcp-obsidian')), false);
      }
    });
  }
}

test('search_all_vaults counts only selected attempts and omits unselected scan failures', async () => {
  const f = fixture(['Healthy', 'Failed', 'Unselected'].map(name => [name, { 'Note.md': 'needle' }]));
  scanFailures.add(f.vault('Failed'));
  scanFailures.add(f.vault('Unselected'));
  const healthy = payload(await search(f, 'search_all_vaults', { vaults: ['healthy'] }));
  assert.equal(healthy.vaultsSearched, 1);
  assert.equal(healthy.completeness, undefined);
  assert.deepEqual(healthy.results.map(row => row.vault), ['Healthy']);
  resetActivity();
  const mixed = payload(await search(f, 'search_all_vaults', { vaults: ['Failed', 'Healthy'] }));
  assert.equal(mixed.vaultsSearched, 2);
  assert.deepEqual(mixed.results.map(row => row.vault), ['Healthy', 'Failed']);
  assert.equal(mixed.completeness.skipped, 1);
  assert.deepEqual(mixed.completeness.reasons, ['vault_unavailable']);
  assert.deepEqual(activity.scans, [f.vault('Healthy'), f.vault('Failed')]);
});

test('semantic_search_all selected counts retain indexed failures, incompatible and unindexed states', async () => {
  const names = ['Healthy', 'Failed', 'Empty', 'Incompatible', 'Unselected'];
  const f = fixture(names.map(name => [name, { 'Note.md': '# Note' }]));
  for (const name of ['Healthy', 'Failed']) f.put('Note.md', { vault: name });
  f.put('Note.md', { vault: 'Incompatible', metadata: { modelIdentity: 'other@sha256:other' } });
  mock.method(f.store('Failed'), 'searchCompatible', () => { throw new Error('injected search failure'); });
  storageFailures.add(f.vault('Unselected'));
  const healthy = payload(await search(f, 'semantic_search_all', { vaults: ['Healthy'] }));
  assert.equal(healthy.vaultsIndexed, 1);
  assert.equal(healthy.completeness, undefined);
  resetActivity();
  const result = payload(await search(f, 'semantic_search_all', {
    vaults: ['Incompatible', 'Empty', 'Failed', 'Healthy'],
  }));
  assert.equal(result.vaultsSearched, 4, 'attempted count includes failed selected vaults');
  assert.equal(result.vaultsIndexed, 3, 'indexed count is not successful-search count');
  assert.deepEqual(result.results.map(row => row.vault), ['Healthy']);
  assert.deepEqual(result.resultMetadataByVault.map(row => [row.vault, row.state]), [
    ['Healthy', 'searched'], ['Failed', 'failed'], ['Empty', 'unindexed'], ['Incompatible', 'incompatible'],
  ]);
  assert.equal(result.completeness.skipped, 3);
  assert.deepEqual(result.completeness.reasons, [
    'vault_search_failed', 'vault_unindexed', 'embedding_index_incompatible',
  ]);
  assert.deepEqual(activity.storage, names.slice(0, 4).map(f.vault));
  assert.deepEqual(Object.keys(result.graphByVault), ['Healthy']);
});

test('selected cross-vault text search still validates in-vault source reads', async () => {
  const f = fixture();
  const outside = makeVault({ 'Private.md': 'needle outside-only-content' });
  fs.symlinkSync(path.join(outside, 'Private.md'), path.join(f.vault(), 'Escape.md'));
  const result = payload(await search(f, 'search_all_vaults', { vaults: ['Fixture'] }));
  assert.deepEqual(result.results[0].results.map(row => row.path), ['Note.md']);
  assert.equal(JSON.stringify(result).includes('outside-only-content'), false);
  assert.equal(result.completeness.skipped, 1);
  assert.deepEqual(result.completeness.reasons, ['file_unreadable']);
});

test('semantic_search omitted, empty and dot directories retain the root response', async () => {
  const f = fixture([['Fixture', { 'Root.md': '# Root', 'Scope/Nested.md': '# Nested' }]]);
  f.put('Root.md');
  f.put('Scope/Nested.md', { embedding: [0.9, 0.1] });
  const baseline = await search(f, 'semantic_search');
  assert.equal(payload(baseline).results.length, 2);
  for (const directory of ['', '.']) {
    assert.deepEqual(await search(f, 'semantic_search', { directory }), baseline);
  }
});

test('semantic_search normalizes nested directories without admitting prefix siblings', async () => {
  const files = ['Root.md', 'Scope/A.md', 'Scope/Nested/B.md', 'Scope/NestedSibling/C.md', 'ScopeSibling/D.md'];
  const f = fixture([['Fixture', Object.fromEntries(files.map(file => [file, '# Note']))]]);
  await f.store().runBatch(async () => { for (const file of files) f.put(file); });
  for (const [directory, expected] of [
    ['Scope', files.slice(1, 4)], ['Scope/', files.slice(1, 4)], ['./Scope', files.slice(1, 4)],
    ['Scope/Nested', [files[2]]], ['Scope/./Nested/', [files[2]]],
  ]) {
    const result = payload(await search(f, 'semantic_search', { directory, limit: 10 }));
    assert.deepEqual(result.results.map(row => row.path), expected, directory);
    assert.equal(result.completeness, undefined);
    assert.equal(result.indexCompatibility.totalEmbeddingCount, files.length);
    assert.equal(result.indexCompatibility.compatibleEmbeddingCount, files.length);
    assert.equal(result.indexCompatibility.excludedEmbeddingCount, 0);
  }
  fs.mkdirSync(path.join(f.vault(), 'Empty'));
  const empty = payload(await search(f, 'semantic_search', { directory: 'Empty' }));
  assert.deepEqual(empty.results, []);
  assert.equal(empty.completeness, undefined);
  assert.equal(empty.limit_reached, undefined);
  assert.equal(empty.indexCompatibility.compatibleEmbeddingCount, files.length);
});

for (const kind of ['missing', 'non-directory', 'parent escape', 'absolute escape', 'symlink escape']) {
  test(`semantic_search rejects a ${kind} directory before retrieval instead of broadening`, async () => {
    const f = fixture();
    const outside = makeVault({ 'Outside.md': '# Outside' });
    fs.symlinkSync(outside, path.join(f.vault(), 'Escape'));
    const directory = {
      missing: 'Missing', 'non-directory': 'Note.md', 'parent escape': '../',
      'absolute escape': outside, 'symlink escape': 'Escape',
    }[kind];
    resetActivity();
    const response = await search(f, 'semantic_search', { directory });
    assert.equal(response.isError, true, response.content[0]?.text);
    assert.equal(response.structuredContent?.code, 'invalid_directory');
    assert.deepEqual(response.structuredContent?.sideEffects, { state: 'none' });
    assertNoRetrieval();
    assert.equal(fs.existsSync(path.join(f.vault(), '.mcp-obsidian')), false);
  });
}

test('semantic_search internal directory aliases select canonical indexed descendants', async () => {
  const files = ['Canonical/Nested/Note.md', 'Canonical/Other.md', 'AliasSibling/Noise.md'];
  const f = fixture([['Fixture', Object.fromEntries(files.map(file => [file, '# Note']))]]);
  await f.store().runBatch(async () => { for (const file of files) f.put(file); });
  fs.symlinkSync(path.join(f.vault(), 'Canonical'), path.join(f.vault(), 'Alias'));
  for (const [directory, canonical, expected] of [
    ['Alias', 'Canonical', files.slice(0, 2)],
    ['Alias/Nested', 'Canonical/Nested', [files[0]]],
  ]) {
    const baseline = payload(await search(f, 'semantic_search', { directory: canonical, limit: 10 }));
    const result = payload(await search(f, 'semantic_search', { directory, limit: 10 }));
    assert.deepEqual(result.results.map(row => row.path), expected);
    assert.deepEqual(result, baseline);
  }
});

test('semantic_search keeps physically distinct NFC and NFD directory siblings separate', async t => {
  const selected = 'Caf\u00e9';
  const sibling = 'Cafe\u0301';
  const f = fixture([['Fixture', {
    [`${selected}/Target.md`]: '# Target',
    [`${sibling}/Other.md`]: '# Other',
  }]]);
  const left = fs.statSync(path.join(f.vault(), selected), { bigint: true });
  const right = fs.statSync(path.join(f.vault(), sibling), { bigint: true });
  if (left.dev === right.dev && left.ino === right.ino) {
    t.skip('Filesystem treats NFC and NFD directory names as the same physical directory; Linux CI exercises distinct siblings.');
    return;
  }
  f.put(`${sibling}/Other.md`, { embedding: [1, 0], content: 'needle needle needle' });
  f.put(`${selected}/Target.md`, { embedding: [0.8, 0.6], content: 'needle' });
  for (const query of ['unmatched', 'needle']) {
    const result = payload(await search(f, 'semantic_search', { directory: selected, query, limit: 1 }));
    assert.deepEqual(result.results.map(row => row.path), [`${selected}/Target.md`]);
    assert.equal(result.limit_reached, undefined);
  }
});

for (const signal of ['vector', 'keyword']) {
  test(`semantic_search scopes ${signal} candidates before eligible caps and excludes no compatible rows`, async () => {
    const eligible = ['Scope/A.md', 'Scope/Nested/B.md', 'Scope/C.md'];
    const excluded = Array.from({ length: 75 }, (_, i) => `ScopeSibling/Outside-${i}.md`);
    const f = fixture([['Fixture', Object.fromEntries(eligible.map(file => [file, '# Current source']))]]);
    const store = f.store();
    await store.runBatch(async () => {
      for (const file of excluded) f.put(file, {
        embedding: signal === 'vector' ? [1, 0] : [0, 1], content: 'needle needle needle',
      });
      for (const [i, file] of eligible.entries()) f.put(file, {
        embedding: signal === 'vector' ? [0.8 - i * 0.1, 0.2 + i * 0.1] : [0, 1],
        content: `needle ${'padding '.repeat(300 + i)}`,
      });
    });
    if (signal === 'keyword') {
      const unscoped = store.keywordSearchCompatible('needle', modelIdentity, 2, 100);
      assert.equal(unscoped.length, 78);
      assert.ok(unscoped.findIndex(row => row.filePath === eligible[0]) > 50,
        'fixture must saturate more than one excluded BM25 batch');
      const outsideScores = unscoped.filter(row => excluded.includes(row.filePath)).map(row => row.score);
      const insideScores = unscoped.filter(row => eligible.includes(row.filePath)).map(row => row.score);
      assert.ok(Math.min(...outsideScores) > Math.max(...insideScores));
    }
    const provider = mock.method(store, signal === 'vector' ? 'searchCompatible' : 'keywordSearchCompatible');
    resetActivity();
    const result = payload(await search(f, 'semantic_search', {
      directory: 'Scope', query: signal === 'vector' ? 'unmatched' : 'needle',
      minSimilarity: signal === 'vector' ? 0.1 : 0.9, limit: 1,
    }));
    assert.deepEqual(result.results.map(row => row.path), [eligible[0]]);
    assert.equal(result.limit_reached, true, 'eligible sentinel survives the provider cap');
    assert.equal(result.completeness, undefined, 'out-of-scope missing files are not failures');
    assert.deepEqual(result.indexCompatibility, {
      state: 'complete', modelIdentity, embeddingDimension: 2, totalEmbeddingCount: 78,
      compatibleEmbeddingCount: 78, excludedEmbeddingCount: 0, excludedFileCount: 0,
      reindexRequired: false,
    });
    assert.equal(provider.mock.callCount(), 1);
    const call = provider.mock.calls[0];
    assert.equal(typeof call.arguments[4], 'function', 'internal includeFile predicate is passed to storage');
    assert.equal(call.arguments[4](eligible[0]), true);
    assert.equal(call.arguments[4](excluded[0]), false);
    const rows = signal === 'vector' ? call.result.results : call.result;
    assert.deepEqual(rows.map(row => row.filePath), eligible);
    assert.equal(result.results[0].per_signal[signal === 'vector' ? 'embeddings' : 'bm25'].rank, 1);
    assert.deepEqual(activity.graph, [[eligible[0]]]);
    assert.ok(activity.reads.every(file => file.startsWith(path.join(f.vault(), 'Scope') + path.sep)));
  });
}

async function evidenceFixture() {
  const title = '\u{10400}'.repeat(161);
  const files = ['Winner.md', 'Runner.md', 'Third.md', 'Fourth.md', 'Sentinel.md'];
  const f = fixture([['Fixture', Object.fromEntries(files.map(file => [file,
    `# ${file === 'Winner.md' ? title : file.slice(0, -3)}\n\nCurrent readable source`,
  ]))]]);
  const passage = `${'\u{10400}'.repeat(750)}needle${'\u{10401}'.repeat(750)}`;
  await f.store().runBatch(async () => {
    f.put('Winner.md', { embedding: [0, 1], content: 'Whole-file decoy' });
    f.put('Winner.md', { embedding: [0, 1], blockId: 'section-1', content: 'Other-block decoy' });
    f.put('Winner.md', {
      blockId: 'section-2', content: passage, metadata: { heading: '## Stored section', startLine: 400 },
    });
    for (const [i, file] of files.slice(1).entries()) {
      f.put(file, { embedding: [0.9 - i * 0.1, 0.1 + i * 0.1] });
    }
  });
  return { f, passage, winner: f.store().get('Winner.md', 'section-2'), runner: f.store().get('Runner.md', null) };
}

for (const tool of ['semantic_search', 'semantic_search_all']) {
  for (const includeEvidence of [false, true]) {
    for (const compact of [false, true]) {
      test(`${tool} wires compact=${compact}, includeEvidence=${includeEvidence} without changing ranking or receipts`, async () => {
        const { f, winner, runner } = await evidenceFixture();
        const baselineResponse = await search(f, tool);
        const baseline = payload(baselineResponse);
        assert.deepEqual(baseline.results.map(row => row.path), ['Winner.md', 'Runner.md']);
        const generation = mock.method(f.store(), 'getEvidenceGeneration');
        const content = mock.method(f.store(), 'getContent');
        const response = await search(f, tool, { includeEvidence, compact });
        const result = payload(response);
        assert.deepEqual(withoutResults(result), withoutResults(baseline));
        assert.equal(result.limit_reached, true);
        if (tool === 'semantic_search') {
          assert.deepEqual(result.providerState, providerState);
          assert.deepEqual(result.activeExclude, ['Archive/']);
        } else {
          assert.deepEqual(result.graphByVault, { Fixture: graphReceipt });
        }
        if (!compact && !includeEvidence) assert.deepEqual(response, baselineResponse);
        for (const [i, hit] of result.results.entries()) {
          const { evidence, ...display } = hit;
          const full = baseline.results[i];
          const projected = Object.fromEntries([
            'path', 'vault', 'title', 'similarity', 'fusionScore', 'fusionMethod', 'reranker_score',
          ].filter(key => key in full).map(key => [key,
            key === 'title' ? Array.from(full.title).slice(0, 160).join('') : full[key],
          ]));
          assert.deepEqual(display, compact ? projected : full);
          if (includeEvidence) assertAvailable(evidence, i === 0 ? winner : runner);
          else assert.equal('evidence' in hit, false);
        }
        if (includeEvidence) {
          const evidence = result.results[0].evidence;
          assert.ok(evidence.excerpt.includes('needle'), 'handler uses the query for a late indexed match');
          assert.equal(evidence.truncatedBefore, true);
          assert.equal(evidence.truncatedAfter, true);
        } else {
          assert.equal(generation.mock.callCount(), 0, 'disabled evidence does not inspect generations');
          assert.equal(content.mock.callCount(), 0, 'disabled evidence does not read indexed passages');
        }
      });
    }
  }

  test(`${tool} missing exact FTS returns unavailable evidence without whole-file or other-block fallback`, async () => {
    const f = fixture();
    f.put('Note.md', { blockId: 'winning-section', content: null });
    f.put('Note.md', { embedding: [0, 1], content: 'Whole-file decoy' });
    f.put('Note.md', { embedding: [0, 1], blockId: 'other-section', content: 'Other-block decoy' });
    assert.equal(f.store().getContent('Note.md', 'winning-section'), null);
    for (const compact of [false, true]) {
      const result = payload(await search(f, tool, { compact, includeEvidence: true }));
      assert.equal(result.resultCount, 1);
      assert.deepEqual(result.results[0].evidence, { state: 'unavailable', reason: 'indexed_content_missing' });
      assert.equal(result.completeness, undefined);
      if (!compact) assert.equal(result.results[0].preview, '# Note\nneedle');
    }
  });

  test(`${tool} readable edited source does not replace indexed evidence or claim freshness`, async () => {
    const f = fixture();
    f.put('Note.md', { blockId: 'stored-section', content: 'Previously indexed needle passage' });
    const row = f.store().get('Note.md', 'stored-section');
    const generation = f.store().getEvidenceGeneration();
    fs.writeFileSync(path.join(f.vault(), 'Note.md'), '# Edited title\n\nEntirely different readable source');
    const result = payload(await search(f, tool, { includeEvidence: true }));
    assert.equal(f.store().getEvidenceGeneration(), generation);
    assert.equal(result.results[0].title, 'Edited title');
    assert.equal(result.results[0].preview, '# Edited title\n\nEntirely different readable source');
    assertAvailable(result.results[0].evidence, row);
    assert.equal(result.results[0].evidence.excerpt, 'Previously indexed needle passage');
    assert.equal(result.results[0].evidence.currentSourceVerified, false);
    assert.equal(result.completeness, undefined);
  });

  for (const compact of [false, true]) {
    test(`${tool} validates missing, unreadable and graph-time deleted sources with evidence and compact=${compact}`, async () => {
      const files = ['Missing.md', 'Denied.md', 'DeletedLater.md', 'Healthy.md'];
      const f = fixture([['Fixture', Object.fromEntries(files.map(file => [file, '# Current source']))]]);
      await f.store().runBatch(async () => { for (const file of files) f.put(file); });
      fs.unlinkSync(path.join(f.vault(), 'Missing.md'));
      readFailures.add(path.join(f.vault(), 'Denied.md'));
      graphHook = async () => {
        graphHook = async () => {};
        await Promise.resolve();
        fs.unlinkSync(path.join(f.vault(), 'DeletedLater.md'));
      };
      const result = payload(await search(f, tool, { limit: 4, compact, includeEvidence: true }));
      assert.deepEqual(result.results.map(row => row.path), ['Healthy.md']);
      assert.equal(result.resultCount, 1);
      assertAvailable(result.results[0].evidence, f.store().get('Healthy.md', null));
      const metadata = tool === 'semantic_search_all' ? result.resultMetadataByVault[0] : result;
      assert.equal(metadata.completeness.state, 'partial');
      assert.equal(metadata.completeness.skipped, 3);
      assert.deepEqual(metadata.completeness.reasons, ['file_unreadable']);
      if (tool === 'semantic_search_all') assert.equal(result.completeness.skipped, 1);
    });
  }

  for (const phase of tool === 'semantic_search'
    ? ['model identity', 'source read', 'graph enrichment', 'reranking']
    : ['source read', 'graph enrichment']) {
    test(`${tool} indexed mutation during awaited ${phase} invalidates admission evidence`, async () => {
      const f = fixture([['Fixture', { 'A.md': '# A', 'B.md': '# B' }]]);
      const indexedText = 'Original indexed passage '.repeat(40);
      f.put('A.md', { blockId: 'winning-section', content: indexedText });
      f.put('B.md', { embedding: [0.9, 0.1], content: 'Original B passage' });
      const before = f.store().getEvidenceGeneration();
      let mutations = 0;
      const mutate = async () => {
        if (mutations) return;
        await Promise.resolve();
        mutations += 1;
        f.put('A.md', { blockId: 'winning-section', content: 'Replacement generation passage' });
      };
      if (phase === 'model identity') identityHook = mutate;
      if (phase === 'source read') afterRead = target => target.endsWith('/A.md') ? mutate() : Promise.resolve();
      if (phase === 'graph enrichment') graphHook = mutate;
      const rerankerInput = [];
      const options = phase === 'reranking' ? {
        rerank: true,
        _rerankerBackend: {
          name: 'fixture-mutate', available: () => true,
          rerank: async (_query, rows) => {
            rerankerInput.push(...rows);
            await mutate();
            return rows.map((row, i) => ({ id: row.id, reranker_score: i }));
          },
        },
      } : {};
      const result = payload(await search(f, tool, {
        query: 'unmatched', includeEvidence: true, compact: true, ...options,
      }));
      assert.equal(mutations, 1, 'the requested await boundary was exercised');
      assert.notEqual(f.store().getEvidenceGeneration(), before);
      assert.deepEqual(result.results.map(row => row.path), phase === 'reranking' ? ['B.md', 'A.md'] : ['A.md', 'B.md']);
      for (const hit of result.results) {
        assert.deepEqual(hit.evidence, { state: 'unavailable', reason: 'indexed_generation_changed' });
      }
      assert.equal(result.completeness, undefined, 'indexed mutation is not a current-source failure');
      if (phase === 'reranking') {
        assert.equal(rerankerInput[0].text, indexedText, 'reranker receives full text, not the evidence window');
        assert.deepEqual(result.results.map(row => row.reranker_score), [1, 0]);
        assert.equal(result.rerankerAvailable, true);
      }
    });
  }
}

test('semantic_search attaches exact keyword-only evidence below the vector similarity floor', async () => {
  const f = fixture([['Fixture', { 'Keyword.md': '# Keyword', 'Vector.md': '# Vector' }]]);
  f.put('Keyword.md', { embedding: [0, 1], blockId: 'keyword-section', content: 'needle keyword-only passage' });
  f.put('Vector.md');
  const result = payload(await search(f, 'semantic_search', { includeEvidence: true, minSimilarity: 0.9 }));
  const keyword = result.results.find(row => row.path === 'Keyword.md');
  assert.ok(keyword, 'BM25-only hit is not removed by the vector floor');
  assert.deepEqual(keyword.per_signal, { bm25: { rank: 1 }, embeddings: { rank: null } });
  assert.equal(keyword.semanticScore, 0);
  assertAvailable(keyword.evidence, f.store().get('Keyword.md', 'keyword-section'));
  assert.equal(keyword.evidence.excerpt, 'needle keyword-only passage');
});

test('semantic_search colon-colliding file/block pairs cannot alias candidates, evidence or reranker inputs', async () => {
  const first = { filePath: 'Part.md', blockId: 'Tail.md:section', content: 'First exact chunk' };
  const second = { filePath: 'Part.md:Tail.md', blockId: 'section', content: 'needle second exact chunk' };
  assert.equal(`${first.filePath}:${first.blockId}`, `${second.filePath}:${second.blockId}`);
  const f = fixture([['Fixture', { [first.filePath]: '# First', [second.filePath]: '# Second' }]]);
  f.put(first.filePath, first);
  f.put(second.filePath, { ...second, embedding: [0.8, 0.2] });
  for (const rerank of [false, true]) {
    const inputs = [];
    const result = payload(await search(f, 'semantic_search', {
      includeEvidence: true, compact: true, rerank,
      _rerankerBackend: {
        name: 'fixture-collision', available: () => true,
        rerank: async (_query, rows) => {
          inputs.push(...rows);
          return rows.map(row => ({ id: row.id, reranker_score: row.text === second.content ? 1 : 0 }));
        },
      },
    }));
    assert.deepEqual(result.results.map(row => row.path), [second.filePath, first.filePath]);
    for (const candidate of [first, second]) {
      const hit = result.results.find(row => row.path === candidate.filePath);
      assertAvailable(hit.evidence, f.store().get(candidate.filePath, candidate.blockId));
      assert.equal(hit.evidence.excerpt, candidate.content);
    }
    if (rerank) {
      assert.equal(new Set(inputs.map(row => row.id)).size, 2, 'opaque reranker IDs stay distinct');
      assert.deepEqual(inputs.map(row => row.text), [second.content, first.content]);
      assert.deepEqual(result.results.map(row => row.reranker_score), [1, 0]);
    }
  }
});

test('semantic_search_all keeps equal paths in distinct selected vaults and finalizes earlier-vault evidence last', async () => {
  const f = fixture(['Alpha', 'Beta', 'Unselected'].map(name => [name, { 'Note.md': '# Note' }]));
  for (const name of ['Alpha', 'Beta']) f.put('Note.md', { vault: name, content: `${name} indexed passage` });
  storageFailures.add(f.vault('Unselected'));
  let mutated = false;
  afterRead = async target => {
    if (target !== path.join(f.vault('Beta'), 'Note.md') || mutated) return;
    await Promise.resolve();
    mutated = true;
    f.put('Note.md', { vault: 'Alpha', content: 'Replacement Alpha passage' });
  };
  const result = payload(await search(f, 'semantic_search_all', {
    vaults: ['Beta', 'Alpha'], compact: true, includeEvidence: true,
  }));
  assert.equal(mutated, true);
  assert.deepEqual(result.results.map(row => [row.vault, row.path]), [['Alpha', 'Note.md'], ['Beta', 'Note.md']]);
  assert.deepEqual(result.results[0].evidence, { state: 'unavailable', reason: 'indexed_generation_changed' });
  assertAvailable(result.results[1].evidence, f.store('Beta').get('Note.md', null));
  assert.equal(result.results[1].evidence.excerpt, 'Beta indexed passage');
  assert.equal(result.vaultsSearched, 2);
  assert.deepEqual(Object.keys(result.graphByVault), ['Alpha', 'Beta']);
  assert.equal(result.completeness, undefined);
});

function linkFixture() {
  return fixture([
    ['Source', { 'From.md': '[[Target]]\n[Declared](obsidian://open?vault=Destination&file=Target)' }],
    ['Destination', { 'Target.md': '# Target' }],
  ]);
}

test('get_cross_vault_links wires optional compact while explicit false retains the full response', async () => {
  const f = linkFixture();
  const full = await f.handlers.get_cross_vault_links({});
  assert.deepEqual(await f.handlers.get_cross_vault_links({ compact: false }), full);
  const fullResult = payload(full);
  const compact = payload(await f.handlers.get_cross_vault_links({ compact: true }));
  assert.equal(fullResult.totalPotentialLinks, 1);
  assert.equal(fullResult.nativeUriInventory.totalFound, 1);
  assert.equal(typeof fullResult.nativeUriInventory.records[0].raw, 'string');
  assert.equal('raw' in compact.nativeUriInventory.records[0], false, 'handler invokes compact projection');
  assert.equal(compact.totalPotentialLinks, fullResult.totalPotentialLinks);
  assert.equal(compact.nativeUriInventory.totalFound, fullResult.nativeUriInventory.totalFound);
});

for (const tool of ['semantic_search', 'semantic_search_all', 'get_cross_vault_links']) {
  test(`${tool} full and compact handler responses retain untrusted-content wrapping`, async () => {
    const f = tool === 'get_cross_vault_links' ? linkFixture() : fixture();
    if (tool !== 'get_cross_vault_links') f.put('Note.md', { content: 'needle indexed passage' });
    const wrapped = createAllHandlers({ ...f.config, wrapUntrusted: true });
    for (const compact of [false, true]) {
      const args = tool === 'get_cross_vault_links' ? { compact }
        : { query: 'needle', compact, includeEvidence: true, ...(tool === 'semantic_search' ? { vault: 'Fixture' } : {}) };
      const expected = payload(await f.handlers[tool](args));
      const response = await wrapped[tool](args);
      assert.equal(response.isError, false, response.content[0]?.text);
      const text = response.content[0].text;
      const marker = `\n${UNTRUSTED_BEGIN}\n`;
      const [notice, rest] = text.split(marker);
      assert.equal(JSON.parse(notice).contentTrust, 'untrusted');
      assert.ok(rest.endsWith(`\n${UNTRUSTED_END}`));
      assert.deepEqual(JSON.parse(rest.slice(0, -(`\n${UNTRUSTED_END}`).length)), expected);
    }
  });
}
