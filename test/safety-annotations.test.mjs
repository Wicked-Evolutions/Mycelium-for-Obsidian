/**
 * Track C — per-tool annotation coverage (derived).
 *
 * Every registered tool MUST carry MCP behaviour-hint annotations in its OWN
 * definition file (cross-track contract: Track A's new tools must self-annotate,
 * or Track C's read-only guard mis-classifies them). This test iterates the live
 * `allTools` surface and asserts each tool is fully classified.
 *
 *  - readOnlyHint  : boolean (required on EVERY tool)
 *  - destructiveHint: boolean when readOnlyHint === false (mutators only)
 *  - idempotentHint : boolean when readOnlyHint === false (mutators only)
 *  - openWorldHint  : true ONLY on arbitrary-code tools (eval_obsidian, execute_command)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { allTools } = await import('../dist/tools/index.js');
const { DERIVED_INDEX_EXEMPT, isMutating } = await import('../dist/tools/safety.js');

// Only these two tools run arbitrary code → openWorldHint:true is allowed.
const OPEN_WORLD_TOOLS = new Set(['eval_obsidian', 'execute_command']);

test('every tool carries an annotations object', () => {
  const missing = allTools.filter(t => !t.annotations || typeof t.annotations !== 'object');
  assert.deepEqual(
    missing.map(t => t.name),
    [],
    `tools missing annotations: ${missing.map(t => t.name).join(', ')}`
  );
});

test('every tool has a boolean readOnlyHint', () => {
  const bad = allTools.filter(t => typeof t.annotations?.readOnlyHint !== 'boolean');
  assert.deepEqual(
    bad.map(t => t.name),
    [],
    `tools without a boolean readOnlyHint: ${bad.map(t => t.name).join(', ')}`
  );
});

test('mutators (readOnlyHint:false) carry boolean destructiveHint and idempotentHint', () => {
  const mutators = allTools.filter(t => t.annotations?.readOnlyHint === false);
  const bad = mutators.filter(
    t =>
      typeof t.annotations?.destructiveHint !== 'boolean' ||
      typeof t.annotations?.idempotentHint !== 'boolean'
  );
  assert.deepEqual(
    bad.map(t => t.name),
    [],
    `mutators missing destructiveHint/idempotentHint: ${bad.map(t => t.name).join(', ')}`
  );
});

test('openWorldHint:true appears ONLY on the arbitrary-code tools', () => {
  const flagged = allTools.filter(t => t.annotations?.openWorldHint === true).map(t => t.name);
  assert.deepEqual(
    flagged.sort(),
    [...OPEN_WORLD_TOOLS].sort(),
    'openWorldHint:true must be restricted to eval_obsidian + execute_command'
  );
});

test('read-only (readOnlyHint:true) tools never carry openWorldHint:true', () => {
  const bad = allTools.filter(
    t => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === true
  );
  assert.deepEqual(bad.map(t => t.name), [], 'read-only tools must not be open-world');
});

test('the derived-index tools are classified mutating-but-exempt', () => {
  for (const name of DERIVED_INDEX_EXEMPT) {
    const tool = allTools.find(t => t.name === name);
    assert.ok(tool, `exempt tool ${name} must exist in allTools`);
    assert.equal(tool.annotations.readOnlyHint, false, `${name} writes derived state → readOnlyHint:false`);
    assert.equal(tool.annotations.idempotentHint, true, `${name} must be idempotentHint:true`);
    // Exempt from the read-only guard despite being a writer.
    assert.equal(isMutating(tool), false, `${name} must be EXEMPT from the read-only guard`);
  }
});

test('isMutating flags vault-content writers and clears readers', () => {
  const createFile = allTools.find(t => t.name === 'create_file');
  const readFile = allTools.find(t => t.name === 'read_file');
  assert.equal(isMutating(createFile), true, 'create_file is a vault-content mutator');
  assert.equal(isMutating(readFile), false, 'read_file is read-only');
});
