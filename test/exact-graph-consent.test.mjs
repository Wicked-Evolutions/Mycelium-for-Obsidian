import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLOSED_VAULT_DECISION_MESSAGE,
  createGraphHandlers,
} from '../dist/tools/graph.js';
import { createVaultHandlers } from '../dist/tools/vault.js';
import {
  applyPreparedSnapshotInvalidation,
  createAllHandlers,
} from '../dist/tools/index.js';
import {
  clearPreparedExactGraphs,
  getPreparedExactGraph,
  replacePreparedExactGraph,
  withPreparedGraphLock,
} from '../dist/graph/prepared.js';
import { getGraphSignalsFromBase } from '../dist/graph/signals.js';

const roots = [];

afterEach(() => {
  clearPreparedExactGraphs();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mycelium-consent-'));
  roots.push(root);
  writeFileSync(join(root, 'Hub.md'), '# Hub', 'utf8');
  writeFileSync(join(root, 'Leaf.md'), 'See [[Hub]].', 'utf8');
  const config = {
    mode: 'single',
    vaults: [{ name: 'Project', path: root }],
    ollama: { host: 'http://localhost:11434', model: 'test' },
    disabledTools: new Set(options.disabledTools ?? []),
    readOnly: options.readOnly ?? false,
    wrapUntrusted: false,
  };
  return { root, config };
}

function exactGraph() {
  return {
    nodes: ['Hub.md', 'Leaf.md'],
    edges: [{ source: 'Leaf.md', target: 'Hub.md', count: 1 }],
    inDegree: new Map([['Hub.md', 1], ['Leaf.md', 0]]),
    outDegree: new Map([['Hub.md', 0], ['Leaf.md', 1]]),
    provider: 'obsidian',
    providerState: {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: true,
    },
    cacheIdentity: 'prepared:test',
    resolvedEdgeCount: 1,
    unresolvedLinkCount: 0,
    distinctUnresolvedTargets: 0,
  };
}

function target(root, status = 'open', vaultId = 'abcdef0123456789') {
  return {
    status,
    probeInvoked: true,
    canonicalPath: root,
    vaultId,
  };
}

function parse(response) {
  return JSON.parse(response.content[0].text);
}

describe('analyze_link_hierarchy consent contract', () => {
  test('default exact mode returns the ratified closed-vault decision before graph work', async () => {
    const { root, config } = fixture();
    let digestCalls = 0;
    let rankCalls = 0;
    let filesystemCalls = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'closed'),
      digest: async () => { digestCalls += 1; return 'digest'; },
      rankExact: async () => { rankCalls += 1; throw new Error('must not run'); },
      rankFilesystem: async () => { filesystemCalls += 1; throw new Error('must not run'); },
    });

    const response = await handlers.analyze_link_hierarchy({ vault: 'Project' });
    assert.equal(response.isError, false);
    const body = parse(response);
    assert.equal(body.status, 'decision_required');
    assert.equal(body.message, CLOSED_VAULT_DECISION_MESSAGE);
    assert.equal(Object.hasOwn(body, 'providerState'), false);
    assert.deepEqual(body.decisionState, {
      requestedMode: 'exact',
      targetReadiness: 'closed',
      probeInvoked: true,
      openInvoked: false,
      analysisInvoked: false,
    });
    assert.equal(body.actions.length, 2);
    assert.equal(digestCalls, 0);
    assert.equal(rankCalls, 0);
    assert.equal(filesystemCalls, 0);
  });

  test('open but unprepared returns a choice without digest or ranking', async () => {
    const { root, config } = fixture();
    let graphWork = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      digest: async () => { graphWork += 1; return 'digest'; },
      rankExact: async () => { graphWork += 1; throw new Error('must not run'); },
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'decision_required');
    assert.equal(body.decisionState.targetReadiness, 'open_unprepared');
    assert.match(body.message, /run open_vault/i);
    assert.equal(graphWork, 0);
    assert.equal(Object.hasOwn(body, 'providerState'), false);
  });

  test('disabled exact provider returns a decision without probing', async () => {
    const { config } = fixture({ disabledTools: ['eval_obsidian'] });
    let inspectCalls = 0;
    const handlers = createGraphHandlers(config, {
      inspect: async () => { inspectCalls += 1; throw new Error('must not run'); },
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'decision_required');
    assert.equal(body.decisionState.targetReadiness, 'eval_disabled');
    assert.equal(body.decisionState.probeInvoked, false);
    assert.equal(body.actions.length, 1);
    assert.equal(inspectCalls, 0);
  });

  test('blocked open_vault capability is never offered as an action', async () => {
    for (const options of [
      { readOnly: true },
      { disabledTools: ['open_vault'] },
    ]) {
      const { root, config } = fixture(options);
      const handlers = createGraphHandlers(config, {
        canonicalize: async () => root,
        inspect: async () => target(root, 'closed'),
      });
      const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
      assert.equal(body.status, 'decision_required');
      assert.equal(body.decisionState.targetReadiness, 'closed');
      assert.equal(body.actions.length, 1);
      assert.equal(body.actions[0].arguments.providerMode, 'filesystem');
      assert.doesNotMatch(body.message, /What would you like me to do/);
    }
  });

  test('unregistered target offers approximation only and no graph provenance', async () => {
    const { root, config } = fixture();
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => ({
        status: 'unregistered',
        probeInvoked: true,
        canonicalPath: root,
      }),
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'decision_required');
    assert.equal(body.decisionState.targetReadiness, 'unregistered');
    assert.equal(body.actions.length, 1);
    assert.equal(body.providerState, undefined);
  });

  test('explicit filesystem mode performs no registry or exact-provider probe', async () => {
    const { config } = fixture();
    let inspectCalls = 0;
    const handlers = createGraphHandlers(config, {
      inspect: async () => { inspectCalls += 1; throw new Error('must not run'); },
    });
    const response = await handlers.analyze_link_hierarchy({
      vault: 'Project',
      providerMode: 'filesystem',
    });
    assert.equal(response.isError, false, response.content[0].text);
    const body = parse(response);
    assert.equal(body.status, 'complete');
    assert.equal(body.provider, 'filesystem');
    assert.deepEqual(body.providerState, {
      selectedProvider: 'filesystem',
      approximate: true,
      exactProviderAvailability: 'not_probed',
      exactProviderInvoked: false,
    });
    assert.deepEqual(body.decisionState, {
      requestedMode: 'filesystem',
      targetReadiness: 'not_probed',
      probeInvoked: false,
      openInvoked: false,
      analysisInvoked: true,
    });
    assert.equal(inspectCalls, 0);
  });

  test('valid prepared snapshot ranks exactly without contacting Obsidian', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    let digestCalls = 0;
    let inspectCalls = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => {
        inspectCalls += 1;
        return target(root, 'closed');
      },
      digest: async () => { digestCalls += 1; return 'same'; },
    });

    const response = await handlers.analyze_link_hierarchy({ vault: 'Project' });
    assert.equal(response.isError, false, response.content[0].text);
    const body = parse(response);
    assert.equal(body.status, 'complete');
    assert.equal(body.provider, 'obsidian');
    assert.equal(body.providerState.approximate, false);
    assert.equal(body.snapshotCapturedAt, '2026-08-10T12:00:00.000Z');
    assert.deepEqual(body.decisionState, {
      requestedMode: 'exact',
      targetReadiness: 'prepared',
      probeInvoked: true,
      openInvoked: false,
      analysisInvoked: true,
    });
    assert.equal(digestCalls, 2, 'digest checked before and after ranking');
    assert.equal(inspectCalls, 2, 'identity checked before and after ranking');
  });

  test('stale digest fails before ranking and evicts the snapshot', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    let rankCalls = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root),
      digest: async () => 'new',
      rankExact: async () => { rankCalls += 1; throw new Error('must not run'); },
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.targetReadiness, 'stale');
    assert.equal(body.decisionState.analysisInvoked, false);
    assert.equal(Object.hasOwn(body, 'providerState'), false);
    assert.equal(rankCalls, 0);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('stale snapshots never offer a blocked open_vault action', async () => {
    for (const options of [
      { readOnly: true },
      { disabledTools: ['open_vault'] },
    ]) {
      const { root, config } = fixture(options);
      replacePreparedExactGraph({
        canonicalPath: root,
        vaultId: 'abcdef0123456789',
        digest: 'old',
        capturedAt: '2026-08-10T12:00:00.000Z',
        graph: exactGraph(),
      });
      const handlers = createGraphHandlers(config, {
        canonicalize: async () => root,
        inspect: async () => target(root),
        digest: async () => 'new',
      });

      const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
      assert.equal(body.status, 'exact_unavailable');
      assert.equal(body.actions.length, 1);
      assert.equal(body.actions[0].arguments.providerMode, 'filesystem');
      assert.doesNotMatch(JSON.stringify(body.actions), /open_vault/);
      assert.match(body.message, /currently unavailable/);
      clearPreparedExactGraphs();
    }
  });

  test('post-ranking digest race discards the graph result', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    const digests = ['old', 'changed'];
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root),
      digest: async () => digests.shift(),
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.analysisInvoked, true);
    assert.equal(body.decisionState.targetReadiness, 'stale');
    assert.equal(Object.hasOwn(body, 'providerState'), false);
  });

  test('a vault change during response rendering discards exact output', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    const controller = new AbortController();
    let digestCalls = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root),
      digest: async () => {
        digestCalls += 1;
        return readFileSync(join(root, 'Hub.md'), 'utf8').includes('Changed')
          ? 'changed'
          : 'same';
      },
      rankExact: async (...args) => {
        const result = await getGraphSignalsFromBase(...args);
        setImmediate(() => writeFileSync(join(root, 'Hub.md'), '# Changed', 'utf8'));
        return result;
      },
    });

    const body = parse(await handlers.analyze_link_hierarchy(
      { vault: 'Project' },
      { signal: controller.signal },
    ));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.targetReadiness, 'stale');
    assert.equal(Object.hasOwn(body, 'providerState'), false);
    assert.equal(digestCalls, 2);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('registration identity mismatch fails before digest or ranking', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    let graphWork = 0;
    const handlers = createGraphHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open', '1111111111111111'),
      digest: async () => { graphWork += 1; return 'same'; },
      rankExact: async () => { graphWork += 1; throw new Error('must not run'); },
    });
    const body = parse(await handlers.analyze_link_hierarchy({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.targetReadiness, 'stale');
    assert.equal(graphWork, 0);
  });
});

describe('open_vault exact snapshot preparation', () => {
  test('requires one explicit configured vault and never defaults', async () => {
    const { config } = fixture();
    const response = await createVaultHandlers(config).open_vault({});
    assert.equal(response.isError, true);
    const body = parse(response);
    assert.equal(body.error, 'missing_vault');
    assert.match(body.message, /requires one explicit/);
  });

  test('disabled eval and ambiguous identity perform no dispatch or exact read', async () => {
    const disabled = fixture({ disabledTools: ['eval_obsidian'] });
    let sideEffects = 0;
    const disabledHandlers = createVaultHandlers(disabled.config, {
      inspect: async () => { sideEffects += 1; throw new Error('must not run'); },
      dispatch: async () => { sideEffects += 1; },
      buildExact: async () => { sideEffects += 1; return exactGraph(); },
    });
    const disabledBody = parse(await disabledHandlers.open_vault({ vault: 'Project' }));
    assert.equal(disabledBody.status, 'exact_unavailable');
    assert.equal(disabledBody.decisionState.targetReadiness, 'eval_disabled');
    assert.equal(sideEffects, 0);

    const ambiguous = fixture();
    const ambiguousHandlers = createVaultHandlers(ambiguous.config, {
      canonicalize: async () => ambiguous.root,
      inspect: async () => ({
        status: 'ambiguous',
        probeInvoked: true,
        canonicalPath: ambiguous.root,
      }),
      dispatch: async () => { sideEffects += 1; },
      buildExact: async () => { sideEffects += 1; return exactGraph(); },
    });
    const ambiguousBody = parse(await ambiguousHandlers.open_vault({ vault: 'Project' }));
    assert.equal(ambiguousBody.status, 'exact_unavailable');
    assert.equal(ambiguousBody.decisionState.targetReadiness, 'ambiguous');
    assert.equal(sideEffects, 0);
  });

  test('already-open preparation performs no URI dispatch', async () => {
    const { root, config } = fixture();
    let dispatchCalls = 0;
    let buildCalls = 0;
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      dispatch: async () => { dispatchCalls += 1; },
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => 'same',
      buildExact: async () => { buildCalls += 1; return exactGraph(); },
    });
    const response = await handlers.open_vault({ vault: 'Project' });
    assert.equal(response.isError, false, response.content[0].text);
    const body = parse(response);
    assert.equal(body.status, 'prepared');
    assert.equal(body.decisionState.openInvoked, false);
    assert.equal(body.decisionState.analysisInvoked, false);
    assert.equal(Object.hasOwn(body, 'providerState'), false);
    assert.equal(dispatchCalls, 0);
    assert.equal(buildCalls, 1);
    assert.ok(getPreparedExactGraph(root));
  });

  test('closed preparation dispatches the exact-ID URI once, then stores exact only', async () => {
    const { root, config } = fixture();
    const statuses = ['closed', 'closed', 'open', 'open', 'open'];
    let dispatchCalls = 0;
    let dispatchedId;
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, statuses.shift() ?? 'open'),
      dispatch: async (vaultId, options) => {
        dispatchCalls += 1;
        dispatchedId = vaultId;
        options.onDispatch();
      },
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => 'same',
      buildExact: async () => exactGraph(),
    });
    const body = parse(await handlers.open_vault({ vault: 'Project' }));
    assert.equal(body.status, 'prepared');
    assert.equal(body.decisionState.openInvoked, true);
    assert.equal(dispatchCalls, 1);
    assert.equal(dispatchedId, 'abcdef0123456789');
    assert.equal(getPreparedExactGraph(root).graph.provider, 'obsidian');
  });

  test('failed refresh invalidates the old snapshot and stores no approximation', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => 'same',
      buildExact: async () => { throw new Error('eval failed'); },
    });
    const response = await handlers.open_vault({ vault: 'Project' });
    assert.equal(response.isError, false);
    const body = parse(response);
    assert.equal(body.status, 'exact_unavailable');
    assert.match(body.message, /No approximation was stored/);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('pre/post digest mismatch refuses snapshot replacement', async () => {
    const { root, config } = fixture();
    const digests = ['before', 'after'];
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => digests.shift(),
      buildExact: async () => exactGraph(),
    });
    const body = parse(await handlers.open_vault({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.targetReadiness, 'stale');
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('bounded readiness timeout never stores a snapshot or falls back', async () => {
    const { root, config } = fixture();
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'loading' }),
      timeoutMs: 0,
      now: () => 0,
    });
    const body = parse(await handlers.open_vault({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(body.decisionState.targetReadiness, 'loading');
    assert.equal(body.providerState, undefined);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('non-exact graph data is rejected and never stored', async () => {
    const { root, config } = fixture();
    const approximate = exactGraph();
    approximate.provider = 'filesystem';
    approximate.providerState = {
      selectedProvider: 'filesystem',
      approximate: true,
      exactProviderAvailability: 'not_probed',
      exactProviderInvoked: false,
    };
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => 'same',
      buildExact: async () => approximate,
    });
    const body = parse(await handlers.open_vault({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('internally inconsistent exact provider receipt is rejected', async () => {
    const { root, config } = fixture();
    const inconsistent = exactGraph();
    inconsistent.providerState.exactProviderInvoked = false;
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => 'same',
      buildExact: async () => inconsistent,
    });
    const body = parse(await handlers.open_vault({ vault: 'Project' }));
    assert.equal(body.status, 'exact_unavailable');
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('read-only mode refuses open_vault before handler side effects', async () => {
    const { root, config } = fixture({ readOnly: true });
    const handlers = createAllHandlers(config);
    const response = await handlers.open_vault({ vault: 'Project' });
    assert.equal(response.isError, true);
    const body = parse(response);
    assert.equal(body.error, 'read_only_mode');
    assert.equal(body.tool, 'open_vault');
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('cancellation after URI dispatch is truthful and never stores a snapshot', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });
    const controller = new AbortController();
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'closed'),
      dispatch: async (_vaultId, options) => {
        options.onDispatch();
        controller.abort();
      },
      probeExact: async () => ({ status: 'loading' }),
      pollMs: 1,
    });
    const response = await handlers.open_vault(
      { vault: 'Project' },
      { signal: controller.signal },
    );
    assert.equal(response.isError, true);
    const body = parse(response);
    assert.equal(body.status, 'cancelled');
    assert.equal(body.decisionState.openInvoked, true);
    assert.match(body.message, /was not closed/);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('cancellation after provider readiness never claims a prepared snapshot', async () => {
    const { root, config } = fixture();
    const controller = new AbortController();
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      inspect: async () => target(root, 'open'),
      probeExact: async () => ({ status: 'ready' }),
      digest: async () => {
        controller.abort();
        const error = new Error('cancelled after readiness');
        error.name = 'AbortError';
        throw error;
      },
    });
    const body = parse(await handlers.open_vault(
      { vault: 'Project' },
      { signal: controller.signal },
    ));
    assert.equal(body.status, 'cancelled');
    assert.equal(body.decisionState.targetReadiness, 'exact_ready');
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('cancellation before dispatch reports openInvoked false', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });
    const controller = new AbortController();
    controller.abort();
    let dispatchCalls = 0;
    const handlers = createVaultHandlers(config, {
      canonicalize: async () => root,
      dispatch: async () => { dispatchCalls += 1; },
    });
    const body = parse(await handlers.open_vault(
      { vault: 'Project' },
      { signal: controller.signal },
    ));
    assert.equal(body.status, 'cancelled');
    assert.equal(body.decisionState.openInvoked, false);
    assert.equal(dispatchCalls, 0);
    assert.equal(
      getPreparedExactGraph(root)?.capturedAt,
      '2026-08-10T11:00:00.000Z',
      'a request cancelled before the preparation attempt preserves the prior snapshot',
    );
  });

  test('successful in-process mutator evicts prepared snapshots', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T12:00:00.000Z',
      graph: exactGraph(),
    });
    const handlers = createAllHandlers(config);
    const response = await handlers.create_file({
      vault: 'Project',
      path: 'Changed.md',
      content: '# Changed',
    });
    assert.equal(response.isError, false, response.content[0].text);
    assert.equal(getPreparedExactGraph(root), undefined);
  });

  test('same-vault mutators serialize before newer snapshot preparation', async () => {
    const { root, config } = fixture();
    const disabledHandlers = createAllHandlers({
      ...config,
      disabledTools: new Set(['create_file']),
    });
    assert.equal(disabledHandlers.create_file, undefined);
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'old',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });

    let release;
    const held = withPreparedGraphLock(root, undefined, () => new Promise((resolve) => {
      release = resolve;
    }));
    await new Promise((resolve) => setImmediate(resolve));

    let mutationSettled = false;
    const handlers = createAllHandlers(config);
    assert.equal(typeof handlers.create_file, 'function');
    const mutation = handlers.create_file({
      vault: 'Project',
      path: 'Changed.md',
      content: '# Changed',
    }).finally(() => { mutationSettled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mutationSettled, false, 'mutation waits for the same-vault graph lock');
    assert.equal(existsSync(join(root, 'Changed.md')), false);

    release();
    await Promise.all([held, mutation]);

    await withPreparedGraphLock(root, undefined, async () => {
      replacePreparedExactGraph({
        canonicalPath: root,
        vaultId: 'abcdef0123456789',
        digest: 'new',
        capturedAt: '2026-08-10T12:00:00.000Z',
        graph: exactGraph(),
      });
    });
    assert.equal(existsSync(join(root, 'Changed.md')), true);
    assert.equal(
      getPreparedExactGraph(root)?.capturedAt,
      '2026-08-10T12:00:00.000Z',
      'post-mutation preparation remains available',
    );
  });

  test('mutation is refused when canonical lock identity cannot be established', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });
    let invoked = false;
    const wrapped = applyPreparedSnapshotInvalidation(
      config,
      [{ name: 'test_mutator', annotations: { readOnlyHint: false } }],
      {
        test_mutator: async () => {
          invoked = true;
          return { content: [{ type: 'text', text: '{}' }], isError: false };
        },
      },
      async () => { throw new Error('transient realpath failure'); },
    );

    const response = await wrapped.test_mutator({ vault: 'Project' });
    assert.equal(response.isError, true);
    assert.equal(invoked, false);
    assert.ok(getPreparedExactGraph(root), 'no attempted mutation means no invalidation');
  });

  test('error-after-write mutator still invalidates the prepared snapshot', async () => {
    const { root, config } = fixture();
    replacePreparedExactGraph({
      canonicalPath: root,
      vaultId: 'abcdef0123456789',
      digest: 'same',
      capturedAt: '2026-08-10T11:00:00.000Z',
      graph: exactGraph(),
    });
    const wrapped = applyPreparedSnapshotInvalidation(
      config,
      [{ name: 'partial_mutator', annotations: { readOnlyHint: false } }],
      {
        partial_mutator: async () => {
          writeFileSync(join(root, 'PartiallyChanged.md'), '# Changed', 'utf8');
          return {
            content: [{ type: 'text', text: 'post-write verification failed' }],
            isError: true,
          };
        },
      },
    );

    const response = await wrapped.partial_mutator({ vault: 'Project' });
    assert.equal(response.isError, true);
    assert.equal(existsSync(join(root, 'PartiallyChanged.md')), true);
    assert.equal(getPreparedExactGraph(root), undefined);
  });
});
