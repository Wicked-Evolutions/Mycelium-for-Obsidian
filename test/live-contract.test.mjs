import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  envFlag,
  validateRequiredLiveEnvironment,
  withTemporaryEnv,
} from './live/support.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const preflight = path.join(repoRoot, 'test', 'live', 'preflight.mjs');
const graphLive = path.join(repoRoot, 'test', 'live', 'graph.live.mjs');
const semanticLive = path.join(repoRoot, 'test', 'live', 'semantic.live.mjs');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function validEnv(overrides = {}) {
  return {
    LIVE_TEST_VAULT: 'ExampleVault',
    OBSIDIAN_VAULTS: JSON.stringify({ ExampleVault: '/absolute/example' }),
    LIVE_OLLAMA: '1',
    ...overrides,
  };
}

test('envFlag accepts only explicit true values', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'On']) assert.equal(envFlag(value), true, value);
  for (const value of [undefined, '', '0', 'false', 'no', 'off', 'enabled']) assert.equal(envFlag(value), false, value);
});

test('strict live environment accepts a selected mapped vault and explicit Ollama opt-in', () => {
  assert.deepEqual(validateRequiredLiveEnvironment(validEnv()), {
    vaultName: 'ExampleVault',
    ollamaEnabled: true,
  });
});

test('strict live environment rejects incomplete or malformed prerequisites without leaking values', () => {
  const privateVault = 'PrivateVaultDoNotEcho';
  const privatePath = '/private/path/do-not-echo';
  const cases = [
    validEnv({ LIVE_TEST_VAULT: '' }),
    validEnv({ OBSIDIAN_VAULTS: '{bad json' }),
    validEnv({ OBSIDIAN_VAULTS: '[]' }),
    validEnv({ LIVE_TEST_VAULT: 'toString', OBSIDIAN_VAULTS: '{}' }),
    validEnv({ LIVE_TEST_VAULT: ' ExampleVault ' }),
    validEnv({
      LIVE_TEST_VAULT: privateVault,
      OBSIDIAN_VAULTS: JSON.stringify({ [privateVault]: ' ' }),
    }),
    validEnv({
      LIVE_TEST_VAULT: privateVault,
      OBSIDIAN_VAULTS: JSON.stringify({ [privateVault]: privatePath }),
      LIVE_OLLAMA: 'false',
    }),
  ];

  for (const env of cases) {
    assert.throws(
      () => validateRequiredLiveEnvironment(env),
      error => {
        assert.match(error.message, /NOT RUN/);
        assert.doesNotMatch(error.message, new RegExp(privateVault));
        assert.doesNotMatch(error.message, new RegExp(privatePath));
        return true;
      },
    );
  }
});

test('withTemporaryEnv restores prior values after a synchronous throw', async () => {
  process.env.LIVE_SUPPORT_EXISTING = 'before';
  await assert.rejects(
    withTemporaryEnv({ LIVE_SUPPORT_EXISTING: 'during' }, () => {
      assert.equal(process.env.LIVE_SUPPORT_EXISTING, 'during');
      throw new Error('sync failure');
    }),
    /sync failure/,
  );
  assert.equal(process.env.LIVE_SUPPORT_EXISTING, 'before');
  delete process.env.LIVE_SUPPORT_EXISTING;
});

test('withTemporaryEnv restores absence after an asynchronous rejection', async () => {
  delete process.env.LIVE_SUPPORT_ABSENT;
  await assert.rejects(
    withTemporaryEnv({ LIVE_SUPPORT_ABSENT: 'during' }, async () => {
      assert.equal(process.env.LIVE_SUPPORT_ABSENT, 'during');
      await Promise.resolve();
      throw new Error('async failure');
    }),
    /async failure/,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'LIVE_SUPPORT_ABSENT'), false);
});

test('preflight exits nonzero with a sanitized NOT RUN receipt', () => {
  const secret = 'SecretVaultName';
  const result = spawnSync(process.execPath, [preflight], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      LIVE_TEST_VAULT: secret,
      OBSIDIAN_VAULTS: JSON.stringify({ [secret]: '/secret/path' }),
      LIVE_OLLAMA: 'false',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live release gate NOT RUN/);
  assert.doesNotMatch(result.stderr, /SecretVaultName|\/secret\/path/);
});

test('optional live suites skip cleanly when only LIVE_TEST_VAULT is set', () => {
  const env = { ...process.env, LIVE_TEST_VAULT: 'ExampleVault' };
  delete env.OBSIDIAN_VAULTS;
  delete env.OBSIDIAN_VAULT_PATH;
  delete env.LIVE_OLLAMA;
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--test', graphLive, semanticLive],
    { cwd: repoRoot, encoding: 'utf8', env },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /# SKIP set a valid LIVE_TEST_VAULT and OBSIDIAN_VAULTS map/);
  assert.match(output, /# cancelled 0/);
  assert.doesNotMatch(output, /hookFailed|Invalid OBSIDIAN_VAULTS JSON/);
});

test('live scripts pin graph consent before semantic work without a glob', () => {
  for (const name of ['test:live', 'test:live:optional']) {
    const script = packageJson.scripts[name];
    const graphIndex = script.indexOf('test/live/graph.live.mjs');
    const semanticIndex = script.indexOf('test/live/semantic.live.mjs');
    assert.ok(graphIndex >= 0, `${name} names the graph live file`);
    assert.ok(semanticIndex > graphIndex, `${name} runs graph before semantic`);
    assert.match(script, /--test-concurrency=1/);
    assert.doesNotMatch(script, /test\/live\/\*\.live\.mjs/);
  }
});
