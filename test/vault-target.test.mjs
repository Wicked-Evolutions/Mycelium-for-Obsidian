import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOpenVaultCommand,
  dispatchOpenVault,
  inspectRegisteredVault,
  isValidObsidianVaultId,
} from '../dist/cli/vault-target.js';
import {
  clearPreparedExactGraphs,
  withPreparedGraphLock,
} from '../dist/graph/prepared.js';

const roots = [];

afterEach(() => {
  clearPreparedExactGraphs();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mycelium-target-'));
  roots.push(root);
  const vault = join(root, 'Caf\u00e9 Vault');
  mkdirSync(vault);
  const registry = join(root, 'obsidian.json');
  const config = {
    mode: 'single',
    vaults: [{ name: 'Project', path: vault }],
    ollama: { host: 'http://localhost:11434', model: 'test' },
    disabledTools: new Set(),
    readOnly: false,
    wrapUntrusted: false,
  };
  return { root, vault, registry, config };
}

function writeRegistry(registry, vaults) {
  writeFileSync(registry, JSON.stringify({ vaults }), 'utf8');
}

describe('canonical Obsidian registry identity', () => {
  test('resolves one canonical path to one valid registered ID', async () => {
    const { vault, registry, config } = fixture();
    writeRegistry(registry, {
      a1b2c3d4e5f60718: { path: vault, open: true },
    });

    const target = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(target.status, 'open');
    assert.equal(target.vaultId, 'a1b2c3d4e5f60718');
    assert.equal(target.probeInvoked, true);
  });

  test('canonicalizes symlink aliases and Unicode paths', async () => {
    const { root, vault, registry, config } = fixture();
    const alias = join(root, 'Unicode Alias');
    symlinkSync(vault, alias);
    config.vaults[0].path = alias;
    writeRegistry(registry, {
      abcdef0123456789: { path: vault },
    });

    const target = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(target.status, 'closed');
    assert.equal(target.vaultId, 'abcdef0123456789');
  });

  test('does not confuse duplicate basenames at different paths', async () => {
    const { root, registry, config } = fixture();
    const other = join(root, 'other', 'Caf\u00e9 Vault');
    mkdirSync(other, { recursive: true });
    writeRegistry(registry, {
      abcdef0123456789: { path: other, open: true },
    });

    const target = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(target.status, 'unregistered');
    assert.equal(target.vaultId, undefined);
  });

  test('fails closed for duplicate or malformed matching registrations', async () => {
    const { vault, registry, config } = fixture();
    writeRegistry(registry, {
      aaaaaaaaaaaaaaaa: { path: vault },
      bbbbbbbbbbbbbbbb: { path: vault },
    });
    const duplicate = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(duplicate.status, 'ambiguous');
    assert.equal(duplicate.vaultId, undefined);

    writeRegistry(registry, { 'not-an-id': { path: vault, open: true } });
    const malformed = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(malformed.status, 'probe_failed');
    assert.equal(malformed.reason, 'invalid_registration');
    assert.equal(malformed.vaultId, undefined);

    writeRegistry(registry, {
      abcdef0123456789: { path: vault, open: true },
      'not-an-id': { path: vault },
    });
    const mixed = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(mixed.status, 'probe_failed', 'any malformed matching registration fails closed');
    assert.equal(mixed.vaultId, undefined);

    writeRegistry(registry, {
      abcdef0123456789: { path: vault, open: 'yes' },
    });
    const malformedOpen = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(malformedOpen.status, 'probe_failed');
    assert.equal(malformedOpen.reason, 'invalid_registration');
    assert.equal(malformedOpen.vaultId, undefined);
  });

  test('reports missing or invalid registry without exposing a target', async () => {
    const { registry, config } = fixture();
    const missing = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(missing.status, 'probe_failed');
    assert.equal(missing.reason, 'registry_unavailable');

    writeFileSync(registry, '{', 'utf8');
    const invalid = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(invalid.status, 'probe_failed');
    assert.equal(invalid.reason, 'registry_invalid');

    writeFileSync(registry, ' '.repeat((4 * 1024 * 1024) + 1), 'utf8');
    const oversized = await inspectRegisteredVault(config, 'Project', {
      registryPath: registry,
      platform: 'darwin',
    });
    assert.equal(oversized.status, 'probe_failed');
    assert.equal(oversized.reason, 'registry_invalid');
  });
});

describe('allowlisted exact-ID open commands', () => {
  const id = 'abcdef0123456789';

  test('builds deterministic shell-free argv on macOS, Linux, and Windows', () => {
    assert.deepEqual(buildOpenVaultCommand(id, 'darwin'), {
      executable: 'open',
      args: [`obsidian://open?vault=${id}`],
      uri: `obsidian://open?vault=${id}`,
    });
    assert.deepEqual(buildOpenVaultCommand(id, 'linux'), {
      executable: 'xdg-open',
      args: [`obsidian://open?vault=${id}`],
      uri: `obsidian://open?vault=${id}`,
    });
    assert.deepEqual(buildOpenVaultCommand(id, 'win32'), {
      executable: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', `obsidian://open?vault=${id}`],
      uri: `obsidian://open?vault=${id}`,
    });
  });

  test('rejects arbitrary names, paths, and URI fragments', () => {
    for (const value of ['Vault', '../Vault', `${id}&file=Secret`, 'obsidian://open']) {
      assert.equal(isValidObsidianVaultId(value), false);
      assert.throws(() => buildOpenVaultCommand(value, 'darwin'));
    }
  });

  test('reports dispatch only after the allowlisted process spawns', async () => {
    let captured;
    let dispatched = false;
    await dispatchOpenVault(id, {
      platform: 'linux',
      onDispatch: () => { dispatched = true; },
      runner: async (executable, args, options) => {
        captured = { executable, args };
        assert.equal(dispatched, false);
        options.onSpawn();
      },
    });
    assert.equal(dispatched, true);
    assert.deepEqual(captured, {
      executable: 'xdg-open',
      args: [`obsidian://open?vault=${id}`],
    });
  });
});

describe('per-vault graph serialization', () => {
  test('serializes the same vault while allowing different vaults concurrently', async () => {
    let releaseA;
    const holdA = new Promise((resolve) => { releaseA = resolve; });
    const events = [];

    const first = withPreparedGraphLock('/vault/a', undefined, async () => {
      events.push('a1-start');
      await holdA;
      events.push('a1-end');
    });
    const second = withPreparedGraphLock('/vault/a', undefined, async () => {
      events.push('a2-start');
    });
    const other = withPreparedGraphLock('/vault/b', undefined, async () => {
      events.push('b-start');
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes('a1-start'));
    assert.ok(events.includes('b-start'));
    assert.ok(!events.includes('a2-start'));
    releaseA();
    await Promise.all([first, second, other]);
    assert.ok(events.indexOf('a2-start') > events.indexOf('a1-end'));
  });

  test('cancels a queued same-vault operation without entering it', async () => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const first = withPreparedGraphLock('/vault/a', undefined, () => hold);
    const controller = new AbortController();
    let entered = false;
    const queued = withPreparedGraphLock('/vault/a', controller.signal, async () => {
      entered = true;
    });
    controller.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(entered, false);

    let thirdEntered = false;
    const third = withPreparedGraphLock('/vault/a', undefined, async () => {
      thirdEntered = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      thirdEntered,
      false,
      'cancelling one waiter must not let a later request bypass the active holder',
    );

    release();
    await Promise.all([first, third]);
    assert.equal(thirdEntered, true);
  });
});
