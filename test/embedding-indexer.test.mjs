import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { chunkMarkdownForEmbedding } from '../dist/embeddings/chunking.js';
import {
  deleteIndexedFile,
  deleteStaleIndexedFiles,
  indexMarkdownFile,
  withVaultIndexLock,
} from '../dist/embeddings/indexer.js';
import { EmbeddingStorage } from '../dist/embeddings/storage.js';
import { pinVaultRootSync } from '../dist/embeddings/vault-root.js';
import { cleanup, createTempVault } from './helpers.mjs';

const vaults = [];

afterEach(() => {
  for (const vault of vaults.splice(0)) cleanup(vault);
});

function makeVault(files) {
  const vault = createTempVault(files);
  vaults.push(vault);
  return vault;
}

function profile(overrides = {}) {
  return {
    name: 'nomic-embed-text:latest',
    digest: 'sha256:test-model',
    contextLength: 2048,
    maxInputBytes: 96,
    ...overrides,
  };
}

function storageFor(vault) {
  return new EmbeddingStorage(path.join(vault, '.mcp-obsidian', 'embeddings.db'));
}

function rootFor(vault) {
  return pinVaultRootSync(vault);
}

const stableModelIdentity = async () => {};

function generator(calls, implementation) {
  return async (text, config) => {
    calls.push(text);
    if (implementation) await implementation(text, calls.length);
    return {
      embedding: [calls.length, 0.5],
      model: config.model,
      digest: config.modelDigest,
    };
  };
}

test('chunker bounds UTF-8 prompts, preserves source, and emits stable unique IDs', () => {
  const source = [
    'frontmatter: tiny',
    '# Repeated',
    'First paragraph with multibyte text: r\u00e4ksm\u00f6rg\u00e5s and \ud83c\udf31. '.repeat(4),
    '# Repeated',
    'Second paragraph. '.repeat(20),
    '# !!!',
    'Punctuation heading body. '.repeat(10),
  ].join('\n');

  const first = chunkMarkdownForEmbedding(source, 96);
  const second = chunkMarkdownForEmbedding(source, 96);

  assert.ok(first.length > 4, 'long source is split into multiple chunks');
  assert.deepEqual(first, second, 'chunk boundaries and IDs are deterministic');
  assert.equal(first.map(chunk => chunk.sourceText).join(''), source);
  assert.ok(first.every(chunk => Buffer.byteLength(chunk.embeddingText, 'utf8') <= 96));
  assert.ok(first.every(chunk => chunk.blockId !== null && chunk.blockId.length > 0));
  assert.equal(new Set(first.map(chunk => chunk.blockId)).size, first.length);
});

test('short headingless content preserves the historical null block ID', () => {
  const chunks = chunkMarkdownForEmbedding('A short headingless note.', 96);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].blockId, null);
  assert.equal(chunks[0].sourceText, 'A short headingless note.');
});

test('heading-dense and unbroken Unicode sources remain linear and lossless', () => {
  const headingDense = Array.from(
    { length: 2_000 },
    (_, index) => `# Heading ${index}\nbody ${index}\n`,
  ).join('');
  const headingChunks = chunkMarkdownForEmbedding(headingDense, 96);
  assert.equal(headingChunks.map(chunk => chunk.sourceText).join(''), headingDense);
  assert.equal(headingChunks[0].startLine, 1);
  assert.equal(headingChunks.at(-1).startLine, 3_999);

  const unbroken = '🌱'.repeat(1_000);
  const tokenChunks = chunkMarkdownForEmbedding(unbroken, 95);
  assert.equal(tokenChunks.map(chunk => chunk.sourceText).join(''), unbroken);
  assert.ok(tokenChunks.length > 1);
  assert.ok(tokenChunks.every(chunk => Buffer.byteLength(chunk.embeddingText, 'utf8') <= 95));
});

test('provider failure leaves prior embeddings and FTS content untouched', async () => {
  const vault = makeVault({ 'Long.md': 'new source '.repeat(80) });
  const storage = storageFor(vault);
  storage.store('Long.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old searchable text');
  let calls = 0;

  try {
    await assert.rejects(
      indexMarkdownFile({
        vaultRoot: rootFor(vault),
        filePath: 'Long.md',
        storage,
        ollama: { host: 'http://unused', model: 'nomic-embed-text' },
        profile: profile(),
        force: true,
      }, {
        generateEmbedding: async (_text, config) => {
          calls += 1;
          if (calls === 2) throw new Error('injected provider failure');
          return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
        },
        assertModelIdentity: stableModelIdentity,
      }),
      /injected provider failure/,
    );

    assert.equal(storage.get('Long.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Long.md'), 'old searchable text');
    assert.deepEqual(storage.getPathStats(), [{ filePath: 'Long.md', embeddingChunks: 1 }]);
  } finally {
    storage.close();
  }
});

test('mixed provider dimensions reject the complete file before replacement', async () => {
  const vault = makeVault({ 'Mixed.md': 'new source '.repeat(80) });
  const storage = storageFor(vault);
  storage.store('Mixed.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old searchable text');
  let calls = 0;

  try {
    await assert.rejects(
      indexMarkdownFile({
        vaultRoot: rootFor(vault),
        filePath: 'Mixed.md',
        storage,
        ollama: { host: 'http://unused', model: 'nomic-embed-text' },
        profile: profile(),
        force: true,
      }, {
        generateEmbedding: async (_text, config) => {
          calls += 1;
          return {
            embedding: calls === 1 ? [1, 0] : [1, 0, 0],
            model: config.model,
            digest: config.modelDigest,
          };
        },
        assertModelIdentity: stableModelIdentity,
      }),
      /dimensions changed while indexing one file/i,
    );

    assert.equal(calls, 2);
    assert.equal(storage.get('Mixed.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Mixed.md'), 'old searchable text');
  } finally {
    storage.close();
  }
});

test('a producer retag between chunks never enters the exact model cohort', async () => {
  const vault = makeVault({ 'Retagged.md': 'new source '.repeat(80) });
  const storage = storageFor(vault);
  storage.store(
    'Retagged.md', [9, 9], 'old-hash',
    { modelIdentity: 'old@digest' }, null, 'old searchable text',
  );
  let calls = 0;

  try {
    await assert.rejects(indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Retagged.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        calls += 1;
        return {
          embedding: [calls, 1],
          model: config.model,
          digest: calls === 1 ? config.modelDigest : 'sha256:replacement',
        };
      },
      assertModelIdentity: stableModelIdentity,
    }), /model identity changed/i);

    assert.equal(calls, 2);
    assert.equal(storage.get('Retagged.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Retagged.md'), 'old searchable text');
  } finally {
    storage.close();
  }
});

test('a model retag before commit preserves the previous file index', async () => {
  const vault = makeVault({ 'Retagged.md': 'replacement source' });
  const storage = storageFor(vault);
  storage.store(
    'Retagged.md', [9, 9], 'old-hash',
    { modelIdentity: 'old@digest' }, null, 'old searchable text',
  );

  try {
    await assert.rejects(indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Retagged.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => ({
        embedding: [1, 0], model: config.model, digest: config.modelDigest,
      }),
      assertModelIdentity: async () => {
        throw new Error('Ollama embedding model identity changed during the operation.');
      },
    }), /model identity changed/i);

    assert.equal(storage.get('Retagged.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Retagged.md'), 'old searchable text');
  } finally {
    storage.close();
  }
});

test('a cache candidate is not reported exact after its model tag changes', async () => {
  const vault = makeVault({ 'Cached.md': 'stable cached source' });
  const storage = storageFor(vault);
  let providerCalls = 0;
  const generateEmbedding = async (_text, config) => {
    providerCalls += 1;
    return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
  };
  const options = {
    vaultRoot: rootFor(vault),
    filePath: 'Cached.md',
    storage,
    ollama: { host: 'http://unused', model: 'nomic-embed-text' },
    profile: profile({ maxInputBytes: 512 }),
    force: false,
  };

  try {
    await indexMarkdownFile(options, {
      generateEmbedding,
      assertModelIdentity: stableModelIdentity,
    });
    assert.equal(providerCalls, 1);
    const before = storage.get('Cached.md');

    await assert.rejects(indexMarkdownFile(options, {
      generateEmbedding,
      assertModelIdentity: async () => {
        throw new Error('Ollama embedding model identity changed during the operation.');
      },
    }), /model identity changed/i);

    assert.equal(providerCalls, 1, 'the exact manifest remained a cache candidate');
    assert.equal(storage.get('Cached.md')?.contentHash, before.contentHash);
    assert.equal(storage.getContent('Cached.md'), 'stable cached source');
  } finally {
    storage.close();
  }
});

test('long indexing is complete, bounded, alias-clean, and exactly cacheable', async () => {
  const source = '# Long\n\n' + 'alpha beta gamma delta. '.repeat(80);
  const vault = makeVault({ 'Long.md': source });
  const storage = storageFor(vault);
  storage.store('./Long.md', [8, 8], 'legacy', { modelIdentity: 'legacy@digest' }, null, 'legacy alias');
  const calls = [];

  try {
    const first = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Long.md',
      aliases: ['./Long.md'],
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: false,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });

    assert.equal(first.status, 'indexed');
    assert.ok(first.sections > 1);
    assert.ok(calls.every(text => Buffer.byteLength(text, 'utf8') <= 96));
    assert.equal(storage.get('./Long.md'), null, 'legacy alias rows are removed atomically');
    assert.deepEqual(storage.getPathStats(), [{ filePath: 'Long.md', embeddingChunks: first.sections }]);
    assert.equal(first.chunks.map(chunk => chunk.sourceText).join(''), source);
    for (const chunk of first.chunks) {
      assert.equal(storage.getContent('Long.md', chunk.blockId), chunk.embeddingText);
    }

    const callCount = calls.length;
    const cached = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Long.md',
      aliases: ['./Long.md'],
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: false,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });
    assert.equal(cached.status, 'skipped');
    assert.equal(calls.length, callCount, 'an exact complete manifest skips provider calls');

    const firstChunk = cached.chunks[0];
    const stored = storage.get('Long.md', firstChunk.blockId);
    storage.store(
      'Long.md',
      stored.embedding,
      stored.contentHash,
      stored.metadata,
      firstChunk.blockId,
      'tampered FTS content',
    );
    const repaired = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Long.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: false,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });
    assert.equal(repaired.status, 'indexed');
    assert.ok(calls.length > callCount, 'FTS drift invalidates the complete-manifest cache');

    const repairedCallCount = calls.length;
    const changedModel = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Long.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ digest: 'sha256:replacement' }),
      force: false,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });
    assert.equal(changedModel.status, 'indexed');
    assert.ok(calls.length > repairedCallCount, 'model digest changes invalidate the cache');
  } finally {
    storage.close();
  }
});

test('indexing invokes the exact model name represented by the cached digest', async () => {
  const vault = makeVault({ 'Exact.md': 'exact model source' });
  const storage = storageFor(vault);
  const models = [];

  try {
    await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Exact.md',
      storage,
      ollama: { host: 'http://unused', model: 'demo' },
      profile: profile({ name: 'demo:latest', digest: 'sha256:latest' }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        models.push(config.model);
        return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
      },
      assertModelIdentity: stableModelIdentity,
    });
    assert.deepEqual(models, ['demo:latest']);
    assert.equal(storage.get('Exact.md')?.metadata.modelIdentity, 'demo:latest@sha256:latest');
  } finally {
    storage.close();
  }
});

test('a source change during a cache hit is re-read and indexed instead of skipped', async () => {
  const initial = 'initial cache source';
  const replacement = 'replacement cache source';
  const vault = makeVault({ 'Cached.md': initial });
  const storage = storageFor(vault);
  const calls = [];

  try {
    await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Cached.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });

    const matchesManifest = storage.matchesFileManifest.bind(storage);
    let changed = false;
    storage.matchesFileManifest = (...args) => {
      const matches = matchesManifest(...args);
      if (matches && !changed) {
        changed = true;
        fs.writeFileSync(path.join(vault, 'Cached.md'), replacement, 'utf8');
      }
      return matches;
    };

    const result = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Cached.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ maxInputBytes: 512 }),
      force: false,
    }, { generateEmbedding: generator(calls), assertModelIdentity: stableModelIdentity });

    assert.equal(result.status, 'indexed');
    assert.equal(calls.length, 2, 'the changed cache candidate is regenerated once');
    assert.equal(storage.getContent('Cached.md'), replacement);
  } finally {
    storage.close();
  }
});

test('source changes during embedding are retried once before commit', async () => {
  const initial = 'initial source '.repeat(12);
  const replacement = 'replacement source '.repeat(12);
  const vault = makeVault({ 'Changing.md': initial });
  const storage = storageFor(vault);
  const calls = [];

  try {
    const result = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Changing.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: generator(calls, async (_text, callNumber) => {
        if (callNumber === 1) {
          fs.writeFileSync(path.join(vault, 'Changing.md'), replacement, 'utf8');
        }
      }),
      assertModelIdentity: stableModelIdentity,
    });

    assert.equal(result.status, 'indexed');
    assert.equal(calls.length, 2, 'the changed first attempt is discarded and retried');
    assert.equal(result.chunks.map(chunk => chunk.sourceText).join(''), replacement);
    assert.equal(storage.getContent('Changing.md'), replacement);
  } finally {
    storage.close();
  }
});

test('a second source change exhausts the retry without replacing prior rows', async () => {
  const vault = makeVault({ 'Changing.md': 'first source '.repeat(12) });
  const storage = storageFor(vault);
  storage.store('Changing.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old content');
  let generation = 0;

  try {
    await assert.rejects(indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Changing.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        generation += 1;
        fs.writeFileSync(
          path.join(vault, 'Changing.md'),
          `${generation === 1 ? 'second' : 'third'} source `.repeat(12),
          'utf8',
        );
        return {
          embedding: [generation, 1],
          model: config.model,
          digest: config.modelDigest,
        };
      },
      assertModelIdentity: stableModelIdentity,
    }), /changed during embedding twice/);
    assert.equal(generation, 2);
    assert.equal(storage.get('Changing.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Changing.md'), 'old content');
  } finally {
    storage.close();
  }
});

test('SQLite replacement rolls embeddings and FTS back together on insertion failure', () => {
  const vault = makeVault();
  const storage = storageFor(vault);
  storage.store('Atomic.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old content');

  try {
    storage.db.exec(`
      CREATE TRIGGER fail_atomic_embedding
      BEFORE INSERT ON embeddings
      WHEN NEW.block_id = 'fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected transaction failure');
      END;
    `);
    assert.throws(() => storage.replaceFileEmbeddings('Atomic.md', [], [
      {
        blockId: 'first', contentHash: 'first-hash', embedding: [1, 0],
        metadata: { modelIdentity: 'new@digest' }, content: 'first content',
      },
      {
        blockId: 'fail', contentHash: 'fail-hash', embedding: [0, 1],
        metadata: { modelIdentity: 'new@digest' }, content: 'fail content',
      },
    ]), /injected transaction failure/);
    assert.equal(storage.get('Atomic.md')?.contentHash, 'old-hash');
    assert.equal(storage.getContent('Atomic.md'), 'old content');
    assert.deepEqual(storage.getPathStats(), [{ filePath: 'Atomic.md', embeddingChunks: 1 }]);
  } finally {
    storage.close();
  }
});

test('same-file indexing is serialized and empty content clears stale rows', async () => {
  const vault = makeVault({ 'Serial.md': 'serial content '.repeat(8), 'Empty.md': '   \n' });
  const storage = storageFor(vault);
  storage.store('Empty.md', [7, 7], 'stale', { modelIdentity: 'old@digest' }, null, 'stale');
  let active = 0;
  let maxActive = 0;
  const slowGenerate = async (_text, config) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { embedding: [1, 1], model: config.model, digest: config.modelDigest };
  };

  try {
    await Promise.all([
      indexMarkdownFile({
        vaultRoot: rootFor(vault), filePath: 'Serial.md', storage,
        ollama: { host: 'http://unused', model: 'nomic-embed-text' },
        profile: profile({ maxInputBytes: 512 }), force: true,
      }, { generateEmbedding: slowGenerate, assertModelIdentity: stableModelIdentity }),
      indexMarkdownFile({
        vaultRoot: rootFor(vault), filePath: 'Serial.md', storage,
        ollama: { host: 'http://unused', model: 'nomic-embed-text' },
        profile: profile({ maxInputBytes: 512 }), force: true,
      }, { generateEmbedding: slowGenerate, assertModelIdentity: stableModelIdentity }),
    ]);
    assert.equal(maxActive, 1);

    const emptied = await indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Empty.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: false,
    }, { generateEmbedding: slowGenerate, assertModelIdentity: stableModelIdentity });
    assert.equal(emptied.status, 'indexed');
    assert.equal(emptied.sections, 0);
    assert.equal(storage.get('Empty.md'), null);
    assert.equal(storage.getContent('Empty.md'), null);
  } finally {
    storage.close();
  }
});

test('verified file handles reject symlink escapes without touching the index', async (t) => {
  const outside = makeVault({ 'Outside.md': 'outside source' });
  const vault = makeVault({ 'Safe.md': 'safe source' });
  try {
    fs.symlinkSync(path.join(outside, 'Outside.md'), path.join(vault, 'Escape.md'));
  } catch {
    t.skip('filesystem does not support symlink fixtures');
    return;
  }
  const storage = storageFor(vault);
  storage.store('Escape.md', [3, 3], 'old', { modelIdentity: 'old@digest' }, null, 'old');

  try {
    await assert.rejects(indexMarkdownFile({
      vaultRoot: rootFor(vault),
      filePath: 'Escape.md',
      storage,
      ollama: { host: 'http://unused', model: 'nomic-embed-text' },
      profile: profile(),
      force: true,
    }), /symlink|outside vault/i);
    assert.equal(storage.get('Escape.md')?.contentHash, 'old');
  } finally {
    storage.close();
  }
});

test('a configured vault symlink swap cannot redirect a pinned indexing operation', async (t) => {
  const vaultA = makeVault({ 'Note.md': 'source from vault A' });
  const vaultB = makeVault({ 'Note.md': 'source from vault B' });
  const configured = `${vaultA}-configured-link-${Date.now()}`;
  vaults.push(configured);
  try {
    fs.symlinkSync(vaultA, configured, 'dir');
  } catch {
    t.skip('filesystem does not support directory symlink fixtures');
    return;
  }

  const vaultRoot = rootFor(configured);
  const storage = storageFor(vaultRoot.path);
  let swapped = false;
  try {
    const result = await indexMarkdownFile({
      vaultRoot,
      filePath: 'Note.md',
      storage,
      ollama: { host: 'http://unused', model: 'demo' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        if (!swapped) {
          fs.unlinkSync(configured);
          fs.symlinkSync(vaultB, configured, 'dir');
          swapped = true;
        }
        return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
      },
      assertModelIdentity: stableModelIdentity,
    });

    assert.equal(result.chunks.map(chunk => chunk.sourceText).join(''), 'source from vault A');
    assert.equal(storage.getContent('Note.md'), 'source from vault A');
    assert.equal(fs.existsSync(path.join(vaultB, '.mcp-obsidian', 'embeddings.db')), false);
  } finally {
    storage.close();
  }
});

test('a pinned root identity replacement aborts without replacing prior rows', async () => {
  const vaultA = makeVault({ 'Note.md': 'source from vault A' });
  const vaultB = makeVault({ 'Note.md': 'source from vault B' });
  const movedA = `${vaultA}-moved-${Date.now()}`;
  vaults.push(movedA);
  const vaultRoot = rootFor(vaultA);
  const storage = storageFor(vaultA);
  storage.store('Note.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old content');
  let swapped = false;

  try {
    await assert.rejects(indexMarkdownFile({
      vaultRoot,
      filePath: 'Note.md',
      storage,
      ollama: { host: 'http://unused', model: 'demo' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        if (!swapped) {
          fs.renameSync(vaultA, movedA);
          fs.renameSync(vaultB, vaultA);
          swapped = true;
        }
        return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
      },
      assertModelIdentity: stableModelIdentity,
    }), /pinned vault root identity changed/i);
    assert.throws(() => storage.get('Note.md'), /pinned vault root identity changed/i);
  } finally {
    storage.close();
  }

  const movedStorage = storageFor(movedA);
  try {
    assert.equal(movedStorage.get('Note.md')?.contentHash, 'old-hash');
    assert.equal(movedStorage.getContent('Note.md'), 'old content');
  } finally {
    movedStorage.close();
  }
});

test('watcher-style deletion shares the file lock and removes embeddings with FTS', async () => {
  const vault = makeVault({ 'Race.md': 'source being indexed' });
  const vaultRoot = rootFor(vault);
  const storage = storageFor(vault);
  storage.store('Race.md', [9, 9], 'old-hash', { modelIdentity: 'old@digest' }, null, 'old content');
  let releaseEmbedding;
  let signalStarted;
  const embeddingStarted = new Promise(resolve => { signalStarted = resolve; });
  const holdEmbedding = new Promise(resolve => { releaseEmbedding = resolve; });

  try {
    const indexing = indexMarkdownFile({
      vaultRoot,
      filePath: 'Race.md',
      storage,
      ollama: { host: 'http://unused', model: 'demo' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => {
        signalStarted();
        await holdEmbedding;
        return { embedding: [1, 0], model: config.model, digest: config.modelDigest };
      },
      assertModelIdentity: stableModelIdentity,
    });
    await embeddingStarted;
    fs.unlinkSync(path.join(vault, 'Race.md'));
    const indexingFailure = assert.rejects(indexing, /ENOENT|no such file/i);
    const deletion = deleteIndexedFile({ vaultRoot, filePath: 'Race.md', storage });
    releaseEmbedding();

    await indexingFailure;
    assert.equal(await deletion, true);
    assert.equal(storage.get('Race.md'), null);
    assert.equal(storage.getContent('Race.md'), null);

    storage.store('Gone.md', [8, 8], 'gone-hash', {}, null, 'gone content');
    assert.equal(await deleteStaleIndexedFiles(vaultRoot, storage), 1);
    assert.equal(storage.get('Gone.md'), null);
    assert.equal(storage.getContent('Gone.md'), null);
  } finally {
    storage.close();
  }
});

test('single-file indexing waits for a full-vault batch and persists after it', async () => {
  const vault = makeVault({ 'Queued.md': 'queued source content' });
  const vaultRoot = rootFor(vault);
  const storage = storageFor(vault);
  let releaseBatch;
  let signalBatchStarted;
  const batchStarted = new Promise(resolve => { signalBatchStarted = resolve; });
  const holdBatch = new Promise(resolve => { releaseBatch = resolve; });
  let queuedFinished = false;

  try {
    const batch = withVaultIndexLock(vaultRoot, () => storage.runBatch(async () => {
      storage.store('Batch.md', [1, 0], 'batch-hash', {}, null, 'batch content');
      signalBatchStarted();
      await holdBatch;
    }));
    await batchStarted;

    const queued = indexMarkdownFile({
      vaultRoot,
      filePath: 'Queued.md',
      storage,
      ollama: { host: 'http://unused', model: 'demo' },
      profile: profile({ maxInputBytes: 512 }),
      force: true,
    }, {
      generateEmbedding: async (_text, config) => ({
        embedding: [0, 1],
        model: config.model,
        digest: config.modelDigest,
      }),
      assertModelIdentity: stableModelIdentity,
    }).then(result => {
      queuedFinished = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(queuedFinished, false, 'the queued writer cannot enter the active vault batch');

    releaseBatch();
    await batch;
    const queuedResult = await queued;
    assert.equal(queuedResult.status, 'indexed');

    storage.close();
    const reopened = storageFor(vault);
    try {
      assert.equal(reopened.getContent('Batch.md'), 'batch content');
      assert.equal(reopened.getContent('Queued.md'), 'queued source content');
    } finally {
      reopened.close();
    }
  } finally {
    if (!storage.isClosed()) storage.close();
  }
});

test('an inherited stale async context cannot bypass the current vault lock owner', async () => {
  const vault = makeVault({ 'Note.md': '# Note' });
  const vaultRoot = rootFor(vault);
  let releaseDetached;
  let releaseCurrent;
  let signalCurrentStarted;
  const detachedGate = new Promise(resolve => { releaseDetached = resolve; });
  const currentGate = new Promise(resolve => { releaseCurrent = resolve; });
  const currentStarted = new Promise(resolve => { signalCurrentStarted = resolve; });
  let detachedEntered = false;
  let detached;

  await withVaultIndexLock(vaultRoot, async () => {
    detached = (async () => {
      await detachedGate;
      await withVaultIndexLock(vaultRoot, async () => {
        detachedEntered = true;
      });
    })();
  });

  const current = withVaultIndexLock(vaultRoot, async () => {
    signalCurrentStarted();
    await currentGate;
  });
  await currentStarted;
  releaseDetached();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(detachedEntered, false);

  releaseCurrent();
  await current;
  await detached;
  assert.equal(detachedEntered, true);
});
