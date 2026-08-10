import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, createTempVault } from './helpers.mjs';

const canMock = typeof mock.module === 'function';
const BRIDGE_SPECIFIER = new URL('../dist/cli/bridge.js', import.meta.url).href;

let probeStatus = 'available';
let probePlan = [];
let probeCalls = 0;
let evalCalls = 0;
let evalPlan = [];

const exactPayload = JSON.stringify({
  nodes: ['Hub.md', 'Leaf.md'],
  links: { 'Leaf.md': { 'Hub.md': 1 } },
  unresolvedRaw: {},
});

if (canMock) {
  await mock.module(BRIDGE_SPECIFIER, {
    namedExports: {
      execCli: async () => '',
      execCliForVault: async () => '',
      evalInObsidian: async () => {
        evalCalls += 1;
        const action = evalPlan.shift() ?? { type: 'success' };
        if (action.type === 'fail') throw new Error(action.message ?? 'eval failed');
        if (action.type === 'deferred') return action.promise;
        return action.payload ?? exactPayload;
      },
      isCliAvailable: async () => probeStatus === 'available',
      probeObsidianCli: async () => {
        probeCalls += 1;
        const action = probePlan.shift();
        if (action?.type === 'deferred') return action.promise;
        return { status: action?.status ?? probeStatus };
      },
      OBSIDIAN_CLI_MAX_BUFFER: 256 * 1024 * 1024,
    },
  });
}

const { loadConfig } = await import('../dist/config.js');
const { createAllHandlers } = await import('../dist/tools/index.js');
const graphMod = await import('../dist/graph/index.js');

function vaultFiles() {
  return {
    'Hub.md': '# Hub',
    'Leaf.md': 'See [[Hub]].',
  };
}

function configFor(dir, disabled = '') {
  process.env.OBSIDIAN_VAULT_PATH = dir;
  process.env.OBSIDIAN_DISABLED_TOOLS = disabled;
  delete process.env.OBSIDIAN_VAULTS;
  return loadConfig();
}

function parse(res) {
  assert.equal(res.isError, false, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

function expectedState(overrides) {
  return {
    selectedProvider: 'filesystem',
    approximate: true,
    exactProviderAvailability: 'unknown',
    exactProviderInvoked: false,
    ...overrides,
  };
}

describe('Sprint 04 provider state matrix and cache recovery', {
  skip: !canMock ? 'requires --experimental-test-module-mocks' : false,
}, () => {
  let dir;
  let originalFilesystemBuild;
  let filesystemBuilds = 0;

  before(() => {
    dir = createTempVault(vaultFiles());
    originalFilesystemBuild = graphMod.FilesystemProvider.prototype.build;
    graphMod.FilesystemProvider.prototype.build = async function (...args) {
      filesystemBuilds += 1;
      return originalFilesystemBuild.apply(this, args);
    };
  });

  after(() => {
    graphMod.FilesystemProvider.prototype.build = originalFilesystemBuild;
    graphMod.clearGraphCaches();
    if (dir) cleanup(dir);
    delete process.env.OBSIDIAN_DISABLED_TOOLS;
    delete process.env.OBSIDIAN_VAULT_PATH;
  });

  beforeEach(() => {
    graphMod.clearGraphCaches();
    probeStatus = 'available';
    probePlan = [];
    probeCalls = 0;
    evalCalls = 0;
    evalPlan = [];
    filesystemBuilds = 0;
  });

  test('disabled eval selects filesystem without probing or invoking exact', async () => {
    const signals = await graphMod.getGraphSignals(configFor(dir, 'eval_obsidian'), 'Vault');
    assert.equal(probeCalls, 0);
    assert.equal(evalCalls, 0);
    assert.deepEqual(signals.providerState, expectedState({
      exactProviderAvailability: 'disabled',
      degradationReason: 'eval_disabled',
    }));
  });

  for (const [status, reason] of [
    ['cli_unavailable', 'cli_unavailable'],
    ['obsidian_unavailable', 'obsidian_unavailable'],
    ['unknown', 'cli_probe_failed'],
  ]) {
    test(`${status} selects filesystem with explicit non-invocation`, async () => {
      probeStatus = status;
      const signals = await graphMod.getGraphSignals(configFor(dir), 'Vault');
      assert.equal(evalCalls, 0);
      assert.deepEqual(signals.providerState, expectedState({
        exactProviderAvailability: status,
        degradationReason: reason,
      }));
    });
  }

  test('exact provider available at start is invoked and effective', async () => {
    const signals = await graphMod.getGraphSignals(configFor(dir), 'Vault');
    assert.equal(signals.provider, 'obsidian');
    assert.deepEqual(signals.providerState, {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: true,
    });
  });

  test('eval failure reports attempted exact and effective filesystem fallback', async () => {
    evalPlan = [{ type: 'fail', message: 'eval failed /private/path' }];
    const signals = await graphMod.getGraphSignals(configFor(dir), 'Vault');
    assert.equal(signals.provider, 'filesystem');
    assert.deepEqual(signals.providerState, {
      selectedProvider: 'obsidian',
      approximate: true,
      exactProviderAvailability: 'available',
      exactProviderInvoked: true,
      degradationReason: 'eval_failed',
    });
    assert.match(signals.providerFallbackReason, /filesystem approximation/);
    assert.ok(!signals.providerFallbackReason.includes('/private/path'));
  });

  test('same-digest filesystem base and ranked signals recover to exact', async () => {
    const config = configFor(dir);
    probeStatus = 'cli_unavailable';
    const fallback = await graphMod.getGraphSignals(config, 'Vault');
    const fallbackIdentity = fallback.baseGraph.cacheIdentity;
    assert.equal(fallback.provider, 'filesystem');

    probeStatus = 'available';
    const exact = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(exact.provider, 'obsidian');
    assert.notEqual(exact.baseGraph.cacheIdentity, fallbackIdentity);
    assert.notStrictEqual(exact.signals, fallback.signals);
    assert.equal(evalCalls, 1);
  });

  test('eval failure retries exact and recovers without rebuilding filesystem', async () => {
    const config = configFor(dir);
    evalPlan = [{ type: 'fail' }, { type: 'success' }];
    const fallback = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(fallback.provider, 'filesystem');
    assert.equal(filesystemBuilds, 1);

    const exact = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(exact.provider, 'obsidian');
    assert.equal(evalCalls, 2);
    assert.equal(filesystemBuilds, 1);
  });

  test('persistent eval failure retries once per request and reuses fallback work', async () => {
    const config = configFor(dir);
    evalPlan = [{ type: 'fail' }, { type: 'fail' }];
    const first = await graphMod.getGraphSignals(config, 'Vault');
    const second = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(evalCalls, 2);
    assert.equal(filesystemBuilds, 1);
    assert.strictEqual(second.signals, first.signals, 'ranked map reused after retry failed');
    assert.equal(second.providerState.degradationReason, 'eval_failed');
  });

  test('stable exact cache reprobes eligibility without rerunning eval', async () => {
    const config = configFor(dir);
    const first = await graphMod.getGraphSignals(config, 'Vault');
    const second = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(probeCalls, 2);
    assert.equal(evalCalls, 1);
    assert.strictEqual(second.signals, first.signals);
    assert.equal(second.providerState.exactProviderInvoked, true);
  });

  test('stable normal-filesystem cache reprobes without rebuilding', async () => {
    probeStatus = 'cli_unavailable';
    const config = configFor(dir);
    const first = await graphMod.getGraphSignals(config, 'Vault');
    const second = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(probeCalls, 2);
    assert.equal(evalCalls, 0);
    assert.equal(filesystemBuilds, 1);
    assert.strictEqual(second.signals, first.signals);
  });

  test('hierarchy uses one provider decision and surfaces state on empty vaults', async () => {
    const config = configFor(dir);
    const handlers = createAllHandlers(config);
    const out = parse(await handlers.analyze_link_hierarchy({ vault: 'Vault' }));
    assert.equal(probeCalls, 1, 'no second base-graph acquisition');
    assert.equal(out.provider, 'obsidian');
    assert.deepEqual(out.providerState, {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: true,
    });

    const empty = createTempVault({});
    try {
      graphMod.clearGraphCaches();
      probeCalls = 0;
      evalPlan = [{
        type: 'success',
        payload: JSON.stringify({ nodes: [], links: {}, unresolvedRaw: {} }),
      }];
      const emptyHandlers = createAllHandlers(configFor(empty));
      const emptyOut = parse(await emptyHandlers.analyze_link_hierarchy({ vault: 'Vault' }));
      assert.equal(emptyOut.emptyVault, true);
      assert.equal(emptyOut.provider, 'obsidian');
      assert.equal(emptyOut.providerState.exactProviderInvoked, true);
      assert.equal(probeCalls, 1);
    } finally {
      cleanup(empty);
    }
  });

  test('late fallback cannot poison a newer concurrent exact result', async () => {
    let rejectFirst;
    const firstEval = new Promise((_resolve, reject) => { rejectFirst = reject; });
    evalPlan = [
      { type: 'deferred', promise: firstEval },
      { type: 'success' },
    ];
    const config = configFor(dir);

    const older = graphMod.getGraphSignals(config, 'Vault');
    while (evalCalls < 1) await new Promise((resolve) => setImmediate(resolve));
    const newer = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(newer.provider, 'obsidian');

    rejectFirst(new Error('late failure'));
    const olderResult = await older;
    assert.equal(olderResult.provider, 'filesystem');

    const later = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(later.provider, 'obsidian');
    assert.equal(evalCalls, 2, 'later exact read came from the unpoisoned exact cache');
  });

  test('a slow earlier probe cannot supersede a newer exact result', async () => {
    let resolveFirstProbe;
    const firstProbe = new Promise((resolve) => { resolveFirstProbe = resolve; });
    probePlan = [
      { type: 'deferred', promise: firstProbe },
      { status: 'available' },
      { status: 'available' },
    ];
    const config = configFor(dir);

    const older = graphMod.getGraphSignals(config, 'Vault');
    while (probeCalls < 1) await new Promise((resolve) => setImmediate(resolve));
    const newer = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(newer.provider, 'obsidian');

    resolveFirstProbe({ status: 'cli_unavailable' });
    const olderResult = await older;
    assert.equal(olderResult.provider, 'filesystem');

    const later = await graphMod.getGraphSignals(config, 'Vault');
    assert.equal(later.provider, 'obsidian');
    assert.equal(evalCalls, 1, 'later exact read came from the newer exact cache');
  });
});
