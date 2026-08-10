/**
 * LIVE e2e — graph orientation against the REAL Obsidian provider.
 *
 * Architecture A (handler-level): imports the real built handlers (NO mocks) and
 * calls them against a REAL Obsidian installation (CLI enabled) using the actual
 * vault graph. The required target starts CLOSED so the consent transition is
 * proven end to end. This is the pre-release gate the headless
 * CI cannot cover — GitHub has no Obsidian.
 *
 * GATED: skips entirely unless LIVE_TEST_VAULT is set. `test:live` globs only
 * test/live/ so these NEVER run in the headless suite / CI. Full run procedure
 * (env + prereqs) is in docs/live-e2e.md.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { optionalVaultSkipReason, withTemporaryEnv } from './support.mjs';

const LINKED = process.env.LIVE_TEST_VAULT;
const CONCEPT = process.env.LIVE_CONCEPT_VAULT;

const skip = optionalVaultSkipReason();

const { loadConfig } = await import('../../dist/config.js');
const { createAllHandlers } = await import('../../dist/tools/index.js');

async function makeRuntime() {
  // Live path: we WANT the exact Obsidian provider, so do NOT disable eval_obsidian.
  // OBSIDIAN_VAULTS (the real vault map) must be exported by the runbook.
  return withTemporaryEnv(
    { OBSIDIAN_DISABLED_TOOLS: undefined },
    () => {
      const config = loadConfig();
      return { config, handlers: createAllHandlers(config) };
    },
  );
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

describe('live: graph orientation via the real Obsidian provider', { skip }, () => {
  let config;
  let handlers;
  before(async () => {
    const runtime = await makeRuntime();
    config = runtime.config;
    handlers = runtime.handlers;
  });

  test('closed target requires consent, explicit open prepares exact, and repeat preparation does not redispatch', async () => {
    const decision = parse(await handlers.analyze_link_hierarchy({
      vault: LINKED,
      providerMode: 'exact',
      compact: true,
      limit: 5,
    }));
    assert.equal(
      decision.status,
      'decision_required',
      'LIVE_TEST_VAULT must begin closed with no prepared snapshot; close it before running the strict lane',
    );
    assert.equal(decision.decisionState?.targetReadiness, 'closed');
    assert.equal(decision.providerState, undefined, 'no graph provenance before consent');
    assert.equal(decision.decisionState?.openInvoked, false, 'read-only analyzer never opens');
    assert.match(decision.message, /Open it and analyze the exact Obsidian graph/);

    const prepared = parse(await handlers.open_vault({ vault: LINKED }));
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.snapshotPrepared, true);
    assert.equal(prepared.decisionState?.openInvoked, true, 'closed target dispatched exactly one explicit open');
    assert.equal(prepared.providerState, undefined, 'preparation is not a ranked graph result');

    const out = parse(await handlers.analyze_link_hierarchy({
      vault: LINKED,
      providerMode: 'exact',
      compact: true,
      limit: 5,
    }));

    assert.equal(
      out.provider, 'obsidian',
      `expected the prepared Obsidian exact graph, got "${out.provider}". See docs/live-e2e.md`
    );
    assert.deepEqual(out.providerState, {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: true,
    });
    assert.ok(out.resolvedEdgeCount > 0, `expected resolvedEdgeCount > 0 on a linked vault, got ${out.resolvedEdgeCount}`);
    assert.equal(typeof out.unresolvedLinkCount, 'number', 'unresolvedLinkCount must always be present (#37)');
    assert.equal(typeof out.distinctUnresolvedTargets, 'number', 'distinctUnresolvedTargets must always be present (#37)');
    assert.ok(out.totalNodes > 0, 'a linked vault should have nodes');

    const preparedAgain = parse(await handlers.open_vault({ vault: LINKED }));
    assert.equal(preparedAgain.status, 'prepared');
    assert.equal(
      preparedAgain.decisionState?.openInvoked,
      false,
      'already-open target must not dispatch another URI',
    );
  });

  test(
    'concept-first vault → unresolved concept-links surfaced',
    { skip: !CONCEPT ? 'set LIVE_CONCEPT_VAULT to run the concept-link case' : false },
    async () => {
      const prepared = parse(await handlers.open_vault({ vault: CONCEPT }));
      assert.equal(prepared.status, 'prepared');
      const out = parse(await handlers.analyze_link_hierarchy({
        vault: CONCEPT,
        providerMode: 'exact',
        compact: true,
        limit: 5,
      }));
      assert.equal(out.provider, 'obsidian', `expected obsidian provider, got "${out.provider}" (${out.providerFallbackReason ?? 'n/a'})`);
      assert.equal(out.providerState?.approximate, false);
      assert.equal(out.providerState?.exactProviderInvoked, true);
      assert.ok(out.unresolvedLinkCount > 0, `a concept-first vault should have unresolved concept-links, got ${out.unresolvedLinkCount}`);
      assert.ok(out.distinctUnresolvedTargets > 0, `expected distinct unresolved concept targets, got ${out.distinctUnresolvedTargets}`);
    }
  );
});
