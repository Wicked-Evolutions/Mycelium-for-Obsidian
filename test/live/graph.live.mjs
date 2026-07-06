/**
 * LIVE e2e — graph orientation against the REAL Obsidian provider.
 *
 * Architecture A (handler-level): imports the real built handlers (NO mocks) and
 * calls them against a REAL, running Obsidian (CLI enabled + the target vault
 * OPEN) using the actual vault graph. This is the pre-release gate the headless
 * CI cannot cover — GitHub has no Obsidian.
 *
 * GATED: skips entirely unless LIVE_TEST_VAULT is set. `test:live` globs only
 * test/live/ so these NEVER run in the headless suite / CI. Full run procedure
 * (env + prereqs) is in docs/live-e2e.md.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const LINKED = process.env.LIVE_TEST_VAULT;
const CONCEPT = process.env.LIVE_CONCEPT_VAULT;

const skip = !LINKED
  ? 'set LIVE_TEST_VAULT (+ OBSIDIAN_VAULTS, Obsidian open on it, CLI enabled) to run — see docs/live-e2e.md'
  : false;

const { loadConfig } = await import('../../dist/config.js');
const { createAllHandlers } = await import('../../dist/tools/index.js');

function makeHandlers() {
  // Live path: we WANT the exact Obsidian provider, so do NOT disable eval_obsidian.
  // OBSIDIAN_VAULTS (the real vault map) must be exported by the runbook.
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  return createAllHandlers(loadConfig());
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

describe('live: graph orientation via the real Obsidian provider', { skip }, () => {
  let handlers;
  before(() => { handlers = makeHandlers(); });

  test('analyze_link_hierarchy on a linked vault → provider "obsidian" with resolved edges', async () => {
    const out = parse(await handlers.analyze_link_hierarchy({ vault: LINKED, compact: true, limit: 5 }));

    assert.equal(
      out.provider, 'obsidian',
      `expected the Obsidian (exact-graph) provider, got "${out.provider}" — reason: ${out.providerFallbackReason ?? 'n/a'}. ` +
      `Is Obsidian running with CLI enabled + "${LINKED}" open? (reconnect the MCP server after an Obsidian restart — see docs/live-e2e.md)`
    );
    assert.ok(out.resolvedEdgeCount > 0, `expected resolvedEdgeCount > 0 on a linked vault, got ${out.resolvedEdgeCount}`);
    assert.equal(typeof out.unresolvedLinkCount, 'number', 'unresolvedLinkCount must always be present (#37)');
    assert.equal(typeof out.distinctUnresolvedTargets, 'number', 'distinctUnresolvedTargets must always be present (#37)');
    assert.ok(out.totalNodes > 0, 'a linked vault should have nodes');
  });

  test(
    'concept-first vault → unresolved concept-links surfaced',
    { skip: !CONCEPT ? 'set LIVE_CONCEPT_VAULT to run the concept-link case' : false },
    async () => {
      const out = parse(await handlers.analyze_link_hierarchy({ vault: CONCEPT, compact: true, limit: 5 }));
      assert.equal(out.provider, 'obsidian', `expected obsidian provider, got "${out.provider}" (${out.providerFallbackReason ?? 'n/a'})`);
      assert.ok(out.unresolvedLinkCount > 0, `a concept-first vault should have unresolved concept-links, got ${out.unresolvedLinkCount}`);
      assert.ok(out.distinctUnresolvedTargets > 0, `expected distinct unresolved concept targets, got ${out.distinctUnresolvedTargets}`);
    }
  );
});
