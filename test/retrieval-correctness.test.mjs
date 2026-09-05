import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { cleanup, createTempVault } from './helpers.mjs';

const ollamaSpecifier = new URL('../dist/embeddings/ollama.js', import.meta.url).href;
const ollama = await import(ollamaSpecifier);
const model = { name: 'fixture-embed:latest', digest: 'sha256:fixture' };
const modelIdentity = `${model.name}@${model.digest}`;

// Keep real vector validation and cosine scoring; only the service calls are mocked.
await mock.module(ollamaSpecifier, {
  namedExports: {
    ...ollama,
    checkOllamaAvailability: async () => ({ available: true, hasModel: true, model }),
    assertOllamaModelIdentity: async () => {},
    generateEmbedding: async () => ({
      embedding: [1, 0], dimensions: 2, model: model.name, digest: model.digest,
    }),
  },
});

await mock.module(new URL('../dist/graph/signals.js', import.meta.url).href, {
  namedExports: {
    getGraphSignals: async () => ({
      signals: new Map(), provider: 'filesystem', activeExclude: [], usedDefaultExclude: false,
    }),
  },
});

const { EmbeddingStorage, getSharedStorage } = await import('../dist/embeddings/storage.js');
const { createSemanticHandlers } = await import('../dist/tools/semantic.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const { createQueryHandlers } = await import('../dist/tools/query.js');

const vaults = [];
const stores = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const vault of vaults.splice(0)) cleanup(vault);
});

function makeVault(files = {}) {
  const vault = fs.realpathSync(createTempVault(files));
  vaults.push(vault);
  return vault;
}

function configFor(namedVaults) {
  return {
    mode: 'multi',
    vaults: Object.entries(namedVaults).map(([name, path]) => ({ name, path })),
    ollama: { host: 'http://fixture.invalid', model: model.name },
    disabledTools: new Set(),
    readOnly: true,
    wrapUntrusted: false,
  };
}

function makeStore(vault = makeVault()) {
  const store = getSharedStorage(vault);
  stores.push(store);
  return store;
}

function seed(store, filePath, content, embedding = [1, 0]) {
  store.store(filePath, embedding, `hash:${filePath}`, { modelIdentity }, null, content);
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

function keywordSearch(store, method, query, limit = 10) {
  return method === 'keywordSearch'
    ? store.keywordSearch(query, limit)
    : store.keywordSearchCompatible(query, modelIdentity, 2, limit);
}

for (const method of ['keywordSearch', 'keywordSearchCompatible']) {
  test(`${method} preserves Unicode letters, marks and numbers with implicit AND`, () => {
    const store = makeStore();
    const terms = [
      ['\u00e5ngstr\u00f6m', 'Swedish.md'],
      ['\u043f\u0440\u0438\u0432\u0435\u0442', 'Cyrillic.md'],
      ['\u6771\u4eac', 'Japanese.md'],
      ['\u0661\u0662\u0663', 'Numbers.md'],
      ['cafe\u0301', 'Decomposed.md'],
      ['\u0939\u093f\u0928\u094d\u0926\u0940', 'Marks.md'],
    ];
    for (const [term, file] of terms) seed(store, file, `marker ${term}`);
    seed(store, 'MarkerOnly.md', 'marker');
    seed(store, 'TermOnly.md', '\u6771\u4eac');

    for (const [term, file] of terms) {
      const results = keywordSearch(store, method, `marker ${term}`);
      assert.deepEqual(results.map(row => row.filePath), [file], term);
      assert.equal(results[0].blockId, null);
      assert.ok(Number.isFinite(results[0].score) && results[0].score > 0);
    }
  });

  test(`${method} binds decomposed marks as a quoted literal`, (t) => {
    let database;
    const store = new EmbeddingStorage(makeVault(), {
      openDatabase: (source) => (database = new Database(source)),
    });
    stores.push(store);
    seed(store, 'Decomposed.md', 'cafe\u0301');
    const prepare = database.prepare;
    const bindings = [];
    t.mock.method(database, 'prepare', function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.includes('content_fts MATCH ?')) {
        const all = statement.all;
        t.mock.method(statement, 'all', function (...args) {
          bindings.push(args[0]);
          return all.apply(this, args);
        });
      }
      return statement;
    });

    assert.equal(keywordSearch(store, method, '"cafe\u0301"')[0]?.filePath, 'Decomposed.md');
    assert.deepEqual(bindings, ['"cafe\u0301"']);
  });

  test(`${method} keeps ASCII, literal operators and hostile punctuation safe`, () => {
    const store = makeStore();
    seed(store, 'Both.md', 'alpha beta');
    seed(store, 'AlphaOnly.md', 'alpha');
    seed(store, 'BetaOnly.md', 'beta');
    seed(store, 'Prefix.md', 'alphabet');
    seed(store, 'Hyphen.md', 'release_candidate-42');
    seed(store, 'Column.md', 'contentalpha');
    seed(store, 'Sql.md', 'alpha DROP TABLE embeddings');
    for (const operator of ['AND', 'OR', 'NOT', 'NEAR']) {
      seed(store, `${operator}.md`, `alpha ${operator} beta`);
      assert.deepEqual(
        keywordSearch(store, method, `alpha ${operator} beta`).map(row => row.filePath),
        [`${operator}.md`],
        `${operator} is a required literal, not an FTS operator`,
      );
    }

    assert.deepEqual(
      keywordSearch(store, method, 'alpha beta').map(row => row.filePath).sort(),
      ['AND.md', 'Both.md', 'NEAR.md', 'NOT.md', 'OR.md'],
    );
    assert.deepEqual(
      keywordSearch(store, method, '"alpha" + (beta) ^*').map(row => row.filePath).sort(),
      keywordSearch(store, method, 'alpha beta').map(row => row.filePath).sort(),
    );
    assert.deepEqual(
      keywordSearch(store, method, 'alpha*').map(row => row.filePath).sort(),
      keywordSearch(store, method, 'alpha').map(row => row.filePath).sort(),
      'wildcards cannot expand the literal',
    );
    assert.deepEqual(keywordSearch(store, method, 'content:alpha').map(row => row.filePath), ['Column.md']);
    assert.deepEqual(keywordSearch(store, method, 'release_candidate-42').map(row => row.filePath), ['Hyphen.md']);
    assert.deepEqual(
      keywordSearch(store, method, 'alpha\"); DROP TABLE embeddings; --').map(row => row.filePath),
      ['Sql.md'],
    );
    assert.equal(store.getStats().totalEmbeddings, 11, 'hostile literals cannot mutate storage');
  });

  test(`${method} retains token and result bounds`, () => {
    const store = makeStore();
    seed(store, 'Short.md', 'x'.repeat(99));
    seed(store, 'Long.md', 'x'.repeat(100));
    seed(store, 'One.md', 'shared');
    seed(store, 'Two.md', 'shared');
    seed(store, 'Three.md', 'shared');

    assert.deepEqual(keywordSearch(store, method, 'x'.repeat(99)).map(row => row.filePath), ['Short.md']);
    for (const query of ['', ' \t\n ', '"\':*(){}+^', 'x'.repeat(100), '\u6771'.repeat(100)]) {
      assert.deepEqual(keywordSearch(store, method, query), [], JSON.stringify(query));
    }
    assert.equal(keywordSearch(store, method, 'shared', 2).length, 2);
    assert.deepEqual(keywordSearch(store, method, 'shared', 0), []);
  });
}

for (const [method, defaultThreshold] of [['semantic_search', 0.5], ['semantic_search_all', 0.3]]) {
  test(`${method} honors zero without changing its omitted threshold`, async (t) => {
    const vault = makeVault({
      'High.md': '# High', 'Mid.md': '# Mid', 'Low.md': '# Low',
      'Zero.md': '# Zero', 'Negative.md': '# Negative',
    });
    const store = makeStore(vault);
    for (const [file, embedding] of [
      ['High.md', [1, 0]], ['Mid.md', [0.4, Math.sqrt(0.84)]],
      ['Low.md', [0.1, Math.sqrt(0.99)]], ['Zero.md', [0, 1]], ['Negative.md', [-1, 0]],
    ]) seed(store, file, 'unrelated content', embedding);

    const search = t.mock.method(store, 'searchCompatible');
    const config = configFor({ Threshold: vault });
    const handlers = method === 'semantic_search'
      ? createSemanticHandlers(config)
      : createCrossVaultHandlers(config);
    const args = { vault: 'Threshold', query: 'unmatched-query' };
    const defaultResult = payload(await handlers[method](args));
    const zeroResult = payload(await handlers[method]({ ...args, minSimilarity: 0 }));
    const highResult = payload(await handlers[method]({ ...args, minSimilarity: 0.9 }));

    assert.deepEqual(search.mock.calls.map(call => call.arguments[3]), [defaultThreshold, 0, 0.9]);
    assert.deepEqual(defaultResult.results.map(row => row.path),
      method === 'semantic_search' ? ['High.md'] : ['High.md', 'Mid.md']);
    assert.deepEqual(zeroResult.results.map(row => row.path), ['High.md', 'Mid.md', 'Low.md', 'Zero.md']);
    assert.deepEqual(highResult.results.map(row => row.path), ['High.md']);
    assert.equal(zeroResult.results.at(-1)[method === 'semantic_search' ? 'semanticScore' : 'similarity'], 0);
    assert.equal(zeroResult.indexCompatibility.compatibleEmbeddingCount, 5);
  });
}

for (const sortBy of ['custom_order', '-custom_order']) {
  test(`query_notes sorts ${sortBy} before projection and limit, preserving metadata`, async () => {
    const vault = makeVault({
      'A.md': '---\ntitle: First file\ncustom_order: z\nvisible_value: first\n---\n# A',
      'B.md': '---\ntitle: Second file\ncustom_order: a\nvisible_value: second\n---\n# B',
      'C.md': '---\ntitle: Third file\ncustom_order: m\nvisible_value: third\n---\n# C',
    });
    const handlers = createQueryHandlers(configFor({ Projection: vault }));
    const args = { vault: 'Projection', sort_by: sortBy, limit: 2 };
    const full = payload(await handlers.query_notes(args));
    const projected = payload(await handlers.query_notes({ ...args, fields: ['visible_value', 'missing_field'] }));
    const expectedPaths = sortBy.startsWith('-') ? ['A.md', 'C.md'] : ['B.md', 'C.md'];

    assert.deepEqual(full.results.map(row => row.path), expectedPaths);
    assert.deepEqual(projected, {
      ...full,
      results: full.results.map(row => ({ ...row, frontmatter: { visible_value: row.frontmatter.visible_value } })),
    });
    assert.equal(projected.totalMatches, 3);
    assert.equal(projected.total, 3);
    assert.equal(projected.returned, 2);
    assert.equal(projected.truncated, true);
    assert.equal(projected.has_more, true);
    assert.deepEqual(payload(await handlers.query_notes({ ...args, fields: [] })), full);
  });
}

test('semantic_search_all ranks full-precision cosine before rounding and limiting', async () => {
  const firstVault = makeVault({ 'Low.md': '# Low' });
  const secondVault = makeVault({ 'High.md': '# High' });
  const lowStore = makeStore(firstVault);
  const highStore = makeStore(secondVault);
  seed(lowStore, 'Low.md', 'low content', [0.8001, Math.sqrt(1 - 0.8001 ** 2)]);
  seed(highStore, 'High.md', 'high content', [0.8004, Math.sqrt(1 - 0.8004 ** 2)]);
  const low = lowStore.searchCompatible([1, 0], modelIdentity).results[0].similarity;
  const high = highStore.searchCompatible([1, 0], modelIdentity).results[0].similarity;
  assert.ok(high > low);
  assert.equal(Math.round(high * 1000), Math.round(low * 1000));
  const handlers = createCrossVaultHandlers(configFor({ First: firstVault, Second: secondVault }));

  const full = payload(await handlers.semantic_search_all({ query: 'topic', limit: 2 }));
  const limited = payload(await handlers.semantic_search_all({ query: 'topic', limit: 1 }));
  assert.deepEqual(full.results.map(row => [row.vault, row.path, row.similarity]), [
    ['Second', 'High.md', 0.8], ['First', 'Low.md', 0.8],
  ]);
  assert.deepEqual(limited.results, [full.results[0]]);
  assert.equal(limited.limit_reached, true);
  assert.equal(full.limit_reached, undefined);
});

test('semantic_search_all preserves configured vault and per-vault ordering on exact ties', async () => {
  const firstVault = makeVault({ 'Z.md': '# Z', 'A.md': '# A' });
  const secondVault = makeVault({ 'B.md': '# B' });
  const first = makeStore(firstVault);
  const second = makeStore(secondVault);
  seed(first, 'Z.md', 'same score', [0.8, 0.6]);
  seed(first, 'A.md', 'same score', [0.8, 0.6]);
  seed(second, 'B.md', 'same score', [0.8, 0.6]);
  const perVault = first.searchCompatible([1, 0], modelIdentity).results.map(row => row.filePath);
  assert.deepEqual(perVault, ['Z.md', 'A.md']);
  const handlers = createCrossVaultHandlers(configFor({ Zulu: firstVault, Alpha: secondVault }));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = payload(await handlers.semantic_search_all({ query: 'topic', limit: 3 }));
    assert.deepEqual(result.results.map(row => [row.vault, row.path]), [
      ['Zulu', 'Z.md'], ['Zulu', 'A.md'], ['Alpha', 'B.md'],
    ]);
  }
});
