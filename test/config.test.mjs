/**
 * L0 baseline tests for dist/config.js
 * Tests: loadConfig() multi-mode, single-mode, resolveVault() unknown vault, resolvePathInVault() security
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadConfig, resolveVault, resolvePathInVault } from '../dist/config.js';
import { createTempVault, cleanup } from './helpers.mjs';

// --- helpers to safely save/restore env vars ---
function withEnv(vars, fn) {
  const saved = {};
  const toDelete = [];
  for (const [k, v] of Object.entries(vars)) {
    if (k in process.env) {
      saved[k] = process.env[k];
    } else {
      toDelete.push(k);
    }
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (toDelete.includes(k)) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig() — multi-vault mode
// ─────────────────────────────────────────────────────────────────────────────

test('loadConfig() multi mode — returns mode:"multi" with correct vaults array', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'note.md': '# Hello' });

    const vaultsMap = JSON.stringify({ 'MyVault': vaultDir });

    withEnv(
      { OBSIDIAN_VAULTS: vaultsMap, OBSIDIAN_VAULT_PATH: '' },
      () => {
        // OBSIDIAN_VAULT_PATH must be absent (not empty) for single-mode fallback to be avoided
        delete process.env.OBSIDIAN_VAULT_PATH;

        const config = loadConfig();

        assert.equal(config.mode, 'multi');
        assert.equal(config.vaults.length, 1);
        assert.equal(config.vaults[0].name, 'MyVault');
        assert.equal(config.vaults[0].path, vaultDir);
      }
    );
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('loadConfig() multi mode — multiple vaults all present in result', () => {
  let vault1, vault2;
  try {
    vault1 = createTempVault({ 'a.md': 'A' });
    vault2 = createTempVault({ 'b.md': 'B' });

    const vaultsMap = JSON.stringify({ Alpha: vault1, Beta: vault2 });

    const savedVaults = process.env.OBSIDIAN_VAULTS;
    const savedVaultPath = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULTS = vaultsMap;
    delete process.env.OBSIDIAN_VAULT_PATH;

    try {
      const config = loadConfig();

      assert.equal(config.mode, 'multi');
      assert.equal(config.vaults.length, 2);

      const names = config.vaults.map(v => v.name);
      assert.ok(names.includes('Alpha'), 'Alpha vault should be present');
      assert.ok(names.includes('Beta'), 'Beta vault should be present');

      const alpha = config.vaults.find(v => v.name === 'Alpha');
      assert.equal(alpha.path, vault1);

      const beta = config.vaults.find(v => v.name === 'Beta');
      assert.equal(beta.path, vault2);
    } finally {
      if (savedVaults !== undefined) {
        process.env.OBSIDIAN_VAULTS = savedVaults;
      } else {
        delete process.env.OBSIDIAN_VAULTS;
      }
      if (savedVaultPath !== undefined) {
        process.env.OBSIDIAN_VAULT_PATH = savedVaultPath;
      } else {
        delete process.env.OBSIDIAN_VAULT_PATH;
      }
    }
  } finally {
    if (vault1) cleanup(vault1);
    if (vault2) cleanup(vault2);
  }
});

test('loadConfig() multi mode — includes ollama defaults when not overridden', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});
    const vaultsMap = JSON.stringify({ TestVault: vaultDir });

    const savedVaults = process.env.OBSIDIAN_VAULTS;
    const savedVaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const savedOllamaHost = process.env.OLLAMA_HOST;
    const savedOllamaModel = process.env.OLLAMA_EMBEDDING_MODEL;

    process.env.OBSIDIAN_VAULTS = vaultsMap;
    delete process.env.OBSIDIAN_VAULT_PATH;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_EMBEDDING_MODEL;

    try {
      const config = loadConfig();
      assert.equal(config.ollama.host, 'http://localhost:11434');
      assert.equal(config.ollama.model, 'nomic-embed-text');
    } finally {
      if (savedVaults !== undefined) process.env.OBSIDIAN_VAULTS = savedVaults; else delete process.env.OBSIDIAN_VAULTS;
      if (savedVaultPath !== undefined) process.env.OBSIDIAN_VAULT_PATH = savedVaultPath; else delete process.env.OBSIDIAN_VAULT_PATH;
      if (savedOllamaHost !== undefined) process.env.OLLAMA_HOST = savedOllamaHost; else delete process.env.OLLAMA_HOST;
      if (savedOllamaModel !== undefined) process.env.OLLAMA_EMBEDDING_MODEL = savedOllamaModel; else delete process.env.OLLAMA_EMBEDDING_MODEL;
    }
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig() — single-vault mode
// ─────────────────────────────────────────────────────────────────────────────

test('loadConfig() single mode — returns mode:"single" with correct vault path', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'readme.md': '# Vault' });

    const savedVaults = process.env.OBSIDIAN_VAULTS;
    const savedVaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const savedVaultName = process.env.OBSIDIAN_VAULT_NAME;

    delete process.env.OBSIDIAN_VAULTS;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;
    process.env.OBSIDIAN_VAULT_NAME = 'SingleVault';

    try {
      const config = loadConfig();

      assert.equal(config.mode, 'single');
      assert.equal(config.vaults.length, 1);
      assert.equal(config.vaults[0].path, vaultDir);
      assert.equal(config.vaults[0].name, 'SingleVault');
    } finally {
      if (savedVaults !== undefined) process.env.OBSIDIAN_VAULTS = savedVaults; else delete process.env.OBSIDIAN_VAULTS;
      if (savedVaultPath !== undefined) process.env.OBSIDIAN_VAULT_PATH = savedVaultPath; else delete process.env.OBSIDIAN_VAULT_PATH;
      if (savedVaultName !== undefined) process.env.OBSIDIAN_VAULT_NAME = savedVaultName; else delete process.env.OBSIDIAN_VAULT_NAME;
    }
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('loadConfig() single mode — uses default name "Vault" when OBSIDIAN_VAULT_NAME not set', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});

    const savedVaults = process.env.OBSIDIAN_VAULTS;
    const savedVaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const savedVaultName = process.env.OBSIDIAN_VAULT_NAME;

    delete process.env.OBSIDIAN_VAULTS;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;
    delete process.env.OBSIDIAN_VAULT_NAME;

    try {
      const config = loadConfig();
      assert.equal(config.vaults[0].name, 'Vault');
    } finally {
      if (savedVaults !== undefined) process.env.OBSIDIAN_VAULTS = savedVaults; else delete process.env.OBSIDIAN_VAULTS;
      if (savedVaultPath !== undefined) process.env.OBSIDIAN_VAULT_PATH = savedVaultPath; else delete process.env.OBSIDIAN_VAULT_PATH;
      if (savedVaultName !== undefined) process.env.OBSIDIAN_VAULT_NAME = savedVaultName; else delete process.env.OBSIDIAN_VAULT_NAME;
    }
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('loadConfig() single mode — throws when OBSIDIAN_VAULT_PATH is not set', () => {
  const savedVaults = process.env.OBSIDIAN_VAULTS;
  const savedVaultPath = process.env.OBSIDIAN_VAULT_PATH;

  delete process.env.OBSIDIAN_VAULTS;
  delete process.env.OBSIDIAN_VAULT_PATH;

  try {
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('OBSIDIAN_VAULT_PATH'), `Expected OBSIDIAN_VAULT_PATH in message, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    if (savedVaults !== undefined) process.env.OBSIDIAN_VAULTS = savedVaults; else delete process.env.OBSIDIAN_VAULTS;
    if (savedVaultPath !== undefined) process.env.OBSIDIAN_VAULT_PATH = savedVaultPath; else delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveVault()
// ─────────────────────────────────────────────────────────────────────────────

test('resolveVault() — returns primary vault when no vault name supplied', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});
    const config = {
      mode: 'multi',
      vaults: [
        { name: 'Primary', path: vaultDir },
        { name: 'Secondary', path: '/some/other/path' },
      ],
      ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
      disabledTools: new Set(),
    };

    const vault = resolveVault(config, undefined);
    assert.equal(vault.name, 'Primary');
    assert.equal(vault.path, vaultDir);
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolveVault() — returns correct vault when name matches', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Alpha', path: '/tmp/alpha' },
      { name: 'Beta', path: '/tmp/beta' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  const vault = resolveVault(config, 'Beta');
  assert.equal(vault.name, 'Beta');
  assert.equal(vault.path, '/tmp/beta');
});

test('resolveVault() — name matching is case-insensitive', () => {
  const config = {
    mode: 'multi',
    vaults: [{ name: 'MyVault', path: '/tmp/myvault' }],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  const vault = resolveVault(config, 'myvault');
  assert.equal(vault.name, 'MyVault');
});

test('resolveVault() — throws on unknown vault name', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Alpha', path: '/tmp/alpha' },
      { name: 'Beta', path: '/tmp/beta' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  assert.throws(
    () => resolveVault(config, 'Gamma'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('Gamma') || err.message.toLowerCase().includes('unknown'),
        `Expected error about unknown vault, got: ${err.message}`
      );
      return true;
    }
  );
});

test('resolveVault() — error message on unknown vault lists available vaults', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Alpha', path: '/tmp/alpha' },
      { name: 'Beta', path: '/tmp/beta' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  assert.throws(
    () => resolveVault(config, 'NoSuchVault'),
    (err) => {
      assert.ok(err instanceof Error);
      // The real error includes Available: Alpha, Beta
      assert.ok(err.message.includes('Alpha') && err.message.includes('Beta'),
        `Expected available vaults listed in error, got: ${err.message}`);
      return true;
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePathInVault() — security checks
// ─────────────────────────────────────────────────────────────────────────────

test('resolvePathInVault() — rejects absolute paths', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});

    assert.throws(
      () => resolvePathInVault(vaultDir, '/etc/passwd'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('Absolute'),
          `Expected "Absolute" in error message, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — rejects ../ path traversal', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});

    assert.throws(
      () => resolvePathInVault(vaultDir, '../secret.md'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('traversal') || err.message.toLowerCase().includes('outside'),
          `Expected traversal/outside in error message, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — rejects nested ../ traversal', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'sub/file.md': 'content' });

    assert.throws(
      () => resolvePathInVault(vaultDir, 'sub/../../outside.md'),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — resolves a normal relative path inside the vault', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'notes/hello.md': '# Hello' });

    const resolved = resolvePathInVault(vaultDir, 'notes/hello.md');

    // Result should be an absolute path
    assert.ok(path.isAbsolute(resolved), 'Resolved path should be absolute');

    // Result should be inside the vault
    const vaultPrefix = vaultDir.endsWith(path.sep) ? vaultDir : vaultDir + path.sep;
    assert.ok(
      resolved === vaultDir || resolved.startsWith(vaultPrefix),
      `Resolved path "${resolved}" should be inside vault "${vaultDir}"`
    );

    // Result should match the expected full path
    assert.equal(resolved, path.join(vaultDir, 'notes/hello.md'));
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — resolves a simple filename at vault root', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'readme.md': '# Readme' });

    const resolved = resolvePathInVault(vaultDir, 'readme.md');

    assert.equal(resolved, path.join(vaultDir, 'readme.md'));
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — resolves a deeply nested path inside the vault', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({ 'a/b/c/deep.md': 'deep content' });

    const resolved = resolvePathInVault(vaultDir, 'a/b/c/deep.md');

    assert.equal(resolved, path.join(vaultDir, 'a/b/c/deep.md'));
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});

test('resolvePathInVault() — resolves a non-existent file path that is still within the vault', () => {
  let vaultDir;
  try {
    vaultDir = createTempVault({});

    // File doesn't exist yet — should still resolve without throwing (needed for create operations)
    const resolved = resolvePathInVault(vaultDir, 'new-note.md');

    assert.equal(resolved, path.join(vaultDir, 'new-note.md'));
  } finally {
    if (vaultDir) cleanup(vaultDir);
  }
});
