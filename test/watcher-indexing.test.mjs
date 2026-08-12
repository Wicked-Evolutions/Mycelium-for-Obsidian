import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { VaultWatcher } from '../dist/embeddings/watcher.js';
import { getSharedStorage } from '../dist/embeddings/storage.js';
import { pinVaultRootSync } from '../dist/embeddings/vault-root.js';
import { cleanup, createTempVault } from './helpers.mjs';

test('watcher deletion removes embedding and FTS rows without Ollama', async () => {
  const vault = createTempVault({ 'Gone.md': 'temporary source' });
  const vaultRoot = pinVaultRootSync(vault);
  const storage = getSharedStorage(vaultRoot);
  const watcher = new VaultWatcher({
    vaults: [],
    ollama: { host: 'http://ollama.test', model: 'demo' },
    debounceMs: 0,
  });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('Ollama must not be called for deletion');
  };

  try {
    storage.store('Gone.md', [1, 0], 'old', {}, null, 'old searchable content');
    fs.unlinkSync(`${vaultRoot.path}/Gone.md`);
    watcher.queueFile(vaultRoot, 'Gone.md');
    await watcher.processPendingFiles();

    assert.equal(storage.get('Gone.md'), null);
    assert.equal(storage.getContent('Gone.md'), null);
    assert.equal(providerCalls, 0);
  } finally {
    watcher.stop();
    storage.close();
    globalThis.fetch = originalFetch;
    cleanup(vault);
  }
});

test('watcher retains live files for retry while Ollama is unavailable', async () => {
  const vault = createTempVault({ 'Later.md': 'index when Ollama returns' });
  const vaultRoot = pinVaultRootSync(vault);
  const watcher = new VaultWatcher({
    vaults: [],
    ollama: { host: 'http://ollama.test', model: 'demo' },
    debounceMs: 0,
    retryBaseMs: 60_000,
    maxRetries: 2,
  });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('offline');
  };

  try {
    watcher.queueFile(vaultRoot, 'Later.md');
    await watcher.processPendingFiles();

    assert.ok(providerCalls > 0);
    assert.equal(watcher.pendingFiles.size, 1);
    assert.equal(Array.from(watcher.pendingFiles.values())[0].retryCount, 1);
    assert.ok(watcher.processTimer, 'the live file has a bounded retry scheduled');
  } finally {
    watcher.stop();
    globalThis.fetch = originalFetch;
    cleanup(vault);
  }
});

test('watcher retries transient embedding failures and stops at the configured bound', async () => {
  const vault = createTempVault({ 'Retry.md': 'retry this provider request' });
  const vaultRoot = pinVaultRootSync(vault);
  const storage = getSharedStorage(vaultRoot);
  const watcher = new VaultWatcher({
    vaults: [],
    ollama: { host: 'http://ollama.test', model: 'demo' },
    debounceMs: 0,
    retryBaseMs: 60_000,
    maxRetries: 1,
  });
  const originalFetch = globalThis.fetch;
  let embeddingCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({
        models: [{ name: 'demo:latest', digest: 'sha256:latest' }],
      }), { status: 200 });
    }
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({
        model_info: {
          'general.architecture': 'demo',
          'demo.context_length': 2048,
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/api/embeddings')) {
      embeddingCalls += 1;
      return new Response('provider unavailable', { status: 503 });
    }
    throw new Error(`Unexpected watcher request: ${url}`);
  };

  try {
    watcher.queueFile(vaultRoot, 'Retry.md');
    await watcher.processPendingFiles();

    const retry = Array.from(watcher.pendingFiles.values())[0];
    assert.equal(embeddingCalls, 1);
    assert.equal(retry.retryCount, 1);
    assert.ok(retry.availableAt > Date.now());
    assert.equal(storage.get('Retry.md'), null);

    clearTimeout(watcher.processTimer);
    watcher.processTimer = null;
    watcher.processTimerDueAt = null;
    retry.availableAt = Date.now();
    await watcher.processPendingFiles();

    assert.equal(embeddingCalls, 2);
    assert.equal(watcher.pendingFiles.size, 0);
    assert.equal(watcher.processTimer, null);
    assert.equal(storage.get('Retry.md'), null);
  } finally {
    watcher.stop();
    storage.close();
    globalThis.fetch = originalFetch;
    cleanup(vault);
  }
});

test('watcher drains a file queued while another batch is still embedding', async () => {
  const vault = createTempVault({
    'A.md': 'first watcher source',
    'B.md': 'second watcher source',
  });
  const vaultRoot = pinVaultRootSync(vault);
  const storage = getSharedStorage(vaultRoot);
  const watcher = new VaultWatcher({
    vaults: [],
    ollama: { host: 'http://ollama.test', model: 'demo' },
    debounceMs: 5,
  });
  const originalFetch = globalThis.fetch;
  let signalFirstEmbedding;
  let releaseFirstEmbedding;
  let firstEmbedding = true;
  const firstEmbeddingStarted = new Promise(resolve => { signalFirstEmbedding = resolve; });
  const holdFirstEmbedding = new Promise(resolve => { releaseFirstEmbedding = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({
        models: [{ name: 'demo:latest', digest: 'sha256:latest' }],
      }), { status: 200 });
    }
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({
        model_info: {
          'general.architecture': 'demo',
          'demo.context_length': 2048,
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/api/ps')) {
      return new Response(JSON.stringify({
        models: [{ name: 'demo:latest', digest: 'sha256:latest' }],
      }), { status: 200 });
    }
    if (String(url).endsWith('/api/embeddings')) {
      if (firstEmbedding) {
        firstEmbedding = false;
        signalFirstEmbedding();
        await holdFirstEmbedding;
      }
      return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
    }
    throw new Error(`Unexpected watcher request: ${url}`);
  };

  try {
    watcher.queueFile(vaultRoot, 'A.md');
    await firstEmbeddingStarted;
    watcher.queueFile(vaultRoot, 'B.md');
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseFirstEmbedding();

    const deadline = Date.now() + 2_000;
    while (!storage.get('B.md') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(storage.get('A.md'), 'the active batch indexed A');
    assert.ok(storage.get('B.md'), 'the queued event was drained after A completed');
  } finally {
    releaseFirstEmbedding();
    watcher.stop();
    storage.close();
    globalThis.fetch = originalFetch;
    cleanup(vault);
  }
});

test('watcher queue identities cannot collide across colon-bearing vault and file paths', () => {
  const base = createTempVault();
  const plainVault = path.join(base, 'vault');
  const colonVault = path.join(base, 'vault:A');
  fs.mkdirSync(plainVault);
  fs.mkdirSync(colonVault);
  const plainRoot = pinVaultRootSync(plainVault);
  const colonRoot = pinVaultRootSync(colonVault);
  const watcher = new VaultWatcher({
    vaults: [],
    ollama: { host: 'http://ollama.test', model: 'demo' },
    debounceMs: 60_000,
  });

  try {
    watcher.queueFile(colonRoot, 'B.md');
    watcher.queueFile(plainRoot, 'A:B.md');
    assert.equal(watcher.pendingFiles.size, 2);
    assert.deepEqual(
      Array.from(watcher.pendingFiles.values()).map(file => file.filePath).sort(),
      ['A:B.md', 'B.md'],
    );
  } finally {
    watcher.stop();
    cleanup(base);
  }
});
