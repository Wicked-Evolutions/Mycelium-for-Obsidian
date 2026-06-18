/**
 * Tests for src/tools/schema-helpers.ts
 *
 * Verifies that:
 *  - vaultParam has the correct shape and exact description
 *  - limitParam(n) returns the correct shape with the given default
 *  - limitParam(n, desc) honours the description override
 *  - limitParam calls are pure — each call returns a new object
 *  - The fragments, when spread into a schema, produce JSON that is
 *    byte-for-byte identical to the inline definitions they replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { vaultParam, limitParam, vaultParamWithEnum, injectVaultEnum } = await import('../dist/tools/schema-helpers.js');

// ---------------------------------------------------------------------------
// vaultParam
// ---------------------------------------------------------------------------

test('vaultParam has type "string"', () => {
  assert.equal(vaultParam.type, 'string');
});

test('vaultParam description matches canonical text', () => {
  assert.equal(
    vaultParam.description,
    'Vault name (e.g., "Platform", "Helena"). Defaults to first vault if omitted.'
  );
});

test('vaultParam has no extra keys', () => {
  const keys = Object.keys(vaultParam).sort();
  assert.deepEqual(keys, ['description', 'type']);
});

// ---------------------------------------------------------------------------
// limitParam — default description
// ---------------------------------------------------------------------------

test('limitParam(50) returns correct shape', () => {
  const p = limitParam(50);
  assert.deepEqual(p, {
    type: 'number',
    description: 'Maximum results',
    default: 50
  });
});

test('limitParam(20) returns correct shape', () => {
  const p = limitParam(20);
  assert.deepEqual(p, {
    type: 'number',
    description: 'Maximum results',
    default: 20
  });
});

// ---------------------------------------------------------------------------
// limitParam — description override
// ---------------------------------------------------------------------------

test('limitParam(20, "Maximum results to return") honours override', () => {
  const p = limitParam(20, 'Maximum results to return');
  assert.deepEqual(p, {
    type: 'number',
    description: 'Maximum results to return',
    default: 20
  });
});

// ---------------------------------------------------------------------------
// Purity — each call returns a new object (mutation safety)
// ---------------------------------------------------------------------------

test('limitParam returns a new object on each call', () => {
  const a = limitParam(50);
  const b = limitParam(50);
  assert.notEqual(a, b, 'limitParam must return a new object each time');
});

// ---------------------------------------------------------------------------
// Schema equivalence — fragments reproduce what inline literals produced
// ---------------------------------------------------------------------------

test('vaultParam JSON matches inline vault param literal', () => {
  // This is the exact literal that existed in every tool file before the refactor.
  const inlineLiteral = {
    type: 'string',
    description: 'Vault name (e.g., "Platform", "Helena"). Defaults to first vault if omitted.'
  };
  assert.deepEqual(vaultParam, inlineLiteral);
});

test('limitParam(50) JSON matches analytics.ts inline limit literal', () => {
  // Exact literal from get_orphan_notes / get_broken_links / get_stale_notes.
  const inlineLiteral = {
    type: 'number',
    description: 'Maximum results',
    default: 50
  };
  assert.deepEqual(limitParam(50), inlineLiteral);
});

test('limitParam(20, ...) JSON matches query.ts inline limit literal', () => {
  // Exact literal from query_notes.
  const inlineLiteral = {
    type: 'number',
    description: 'Maximum results to return',
    default: 20
  };
  assert.deepEqual(limitParam(20, 'Maximum results to return'), inlineLiteral);
});

// ---------------------------------------------------------------------------
// vaultParamWithEnum — dynamic vault name injection
// ---------------------------------------------------------------------------

test('vaultParamWithEnum returns type "string"', () => {
  const p = vaultParamWithEnum(['Alpha', 'Beta']);
  assert.equal(p.type, 'string');
});

test('vaultParamWithEnum includes the provided names in enum', () => {
  const names = ['00 Influencentricity OS', '04 Helena Willow Brand'];
  const p = vaultParamWithEnum(names);
  assert.deepEqual(p.enum, names);
});

test('vaultParamWithEnum description contains the vault names', () => {
  const names = ['Alpha', 'Beta'];
  const p = vaultParamWithEnum(names);
  assert.ok(
    p.description.includes('Alpha') && p.description.includes('Beta'),
    `description should mention vault names, got: "${p.description}"`
  );
});

test('vaultParamWithEnum does NOT mutate vaultParam', () => {
  const before = { ...vaultParam };
  vaultParamWithEnum(['X', 'Y']);
  assert.deepEqual(vaultParam, before, 'vaultParam must not be mutated by vaultParamWithEnum');
  assert.equal('enum' in vaultParam, false, 'vaultParam must not gain an enum property');
});

test('vaultParamWithEnum returns a new object on each call', () => {
  const a = vaultParamWithEnum(['A']);
  const b = vaultParamWithEnum(['A']);
  assert.notEqual(a, b, 'vaultParamWithEnum must return a new object each time');
});

// ---------------------------------------------------------------------------
// injectVaultEnum — vault enum injection into tool list
// ---------------------------------------------------------------------------

test('injectVaultEnum replaces vault property in tools that have one', () => {
  const tools = [
    { inputSchema: { properties: { vault: { ...vaultParam }, path: { type: 'string' } } } },
    { inputSchema: { properties: { vault: { ...vaultParam } } } }
  ];
  const names = ['Vault A', 'Vault B'];
  injectVaultEnum(tools, names);
  for (const tool of tools) {
    assert.deepEqual(tool.inputSchema.properties.vault.enum, names);
  }
});

test('injectVaultEnum leaves tools without a vault property untouched', () => {
  const tool = { inputSchema: { properties: { query: { type: 'string' } } } };
  const before = JSON.stringify(tool);
  injectVaultEnum([tool], ['A', 'B']);
  assert.equal(JSON.stringify(tool), before, 'tool without vault must not be changed');
});

test('injectVaultEnum does NOT mutate the shared vaultParam singleton', () => {
  const tools = [
    { inputSchema: { properties: { vault: vaultParam } } }
  ];
  const before = { ...vaultParam };
  injectVaultEnum(tools, ['X']);
  // The tool's vault property is now a new object (replaced), not the singleton
  assert.notEqual(tools[0].inputSchema.properties.vault, vaultParam,
    'tool vault property should be replaced, not the shared singleton');
  assert.deepEqual(vaultParam, before, 'shared vaultParam must remain unchanged');
});

test('injectVaultEnum with empty names array is a no-op', () => {
  const tool = { inputSchema: { properties: { vault: { ...vaultParam } } } };
  const before = JSON.stringify(tool);
  injectVaultEnum([tool], []);
  assert.equal(JSON.stringify(tool), before, 'empty names should result in no change');
});
