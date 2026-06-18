/**
 * Behavior tests for the discover_tools tool
 *
 * Verifies that:
 *  - compact shape: each entry has name (string), category (string), tier (string)
 *  - no full schemas in the compact entries
 *  - pagination envelope: total, returned, offset, has_more present and correct
 *  - category histogram present and sums match total tool count
 *  - limit and offset parameters work correctly
 *  - discover_tools itself appears in the inventory
 *
 * Run: node --test test/discover-tools.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vaultDir;
let handlers;

before(() => {
  vaultDir = createTempVault({});

  process.env.OBSIDIAN_VAULTS = JSON.stringify({ Alpha: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  handlers = createAllHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callDiscover(args = {}) {
  const res = await handlers.discover_tools(args);
  assert.equal(res.isError, false, `isError must be false — got: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

// ---------------------------------------------------------------------------
// Basic response shape
// ---------------------------------------------------------------------------

test('discover_tools returns a non-error response', async () => {
  const res = await handlers.discover_tools({});
  assert.equal(typeof res, 'object', 'response is an object');
  assert.ok(Array.isArray(res.content), 'content is an array');
  assert.ok(res.content.length > 0, 'content is non-empty');
  assert.equal(typeof res.content[0].text, 'string', 'content[0].text is a string');
  assert.equal(res.isError, false, 'isError must be false');
});

test('discover_tools response is valid JSON', async () => {
  const res = await handlers.discover_tools({});
  assert.doesNotThrow(
    () => JSON.parse(res.content[0].text),
    'response text must be valid JSON'
  );
});

// ---------------------------------------------------------------------------
// Pagination envelope
// ---------------------------------------------------------------------------

test('discover_tools: pagination envelope fields present', async () => {
  const payload = await callDiscover({});

  assert.equal(typeof payload.total, 'number', 'total must be a number');
  assert.equal(typeof payload.returned, 'number', 'returned must be a number');
  assert.equal(typeof payload.offset, 'number', 'offset must be a number');
  assert.equal(typeof payload.has_more, 'boolean', 'has_more must be a boolean');
  assert.ok(Array.isArray(payload.tools), 'tools must be an array');
});

test('discover_tools: total is a positive integer', async () => {
  const payload = await callDiscover({});

  assert.ok(payload.total > 0, 'total must be positive');
  assert.equal(payload.total, Math.floor(payload.total), 'total must be an integer');
});

test('discover_tools: default offset is 0', async () => {
  const payload = await callDiscover({});
  assert.equal(payload.offset, 0, 'default offset must be 0');
});

test('discover_tools: returned equals tools array length', async () => {
  const payload = await callDiscover({});
  assert.equal(
    payload.returned,
    payload.tools.length,
    'returned must equal tools.length'
  );
});

test('discover_tools: has_more is false when all tools fit on one page', async () => {
  // Request more tools than exist — has_more must be false
  const payload = await callDiscover({ limit: 10000 });
  assert.equal(payload.has_more, false, 'has_more must be false when all tools fit');
  assert.equal(payload.returned, payload.total, 'returned must equal total when all fit');
});

// ---------------------------------------------------------------------------
// Pagination mechanics
// ---------------------------------------------------------------------------

test('discover_tools: limit caps the returned count', async () => {
  const payload = await callDiscover({ limit: 5 });
  assert.ok(payload.returned <= 5, `returned (${payload.returned}) must be <= limit (5)`);
});

test('discover_tools: has_more is true when more tools remain', async () => {
  // Only ask for 1 tool — unless there's exactly 1 tool total, has_more should be true
  const payload = await callDiscover({ limit: 1 });
  if (payload.total > 1) {
    assert.equal(payload.has_more, true, 'has_more must be true when more tools remain');
  }
});

test('discover_tools: offset advances the window', async () => {
  const page1 = await callDiscover({ limit: 3, offset: 0 });
  const page2 = await callDiscover({ limit: 3, offset: 3 });

  const names1 = page1.tools.map(t => t.name);
  const names2 = page2.tools.map(t => t.name);

  // No overlap between pages
  const overlap = names1.filter(n => names2.includes(n));
  assert.equal(overlap.length, 0, 'pages must not overlap');
});

test('discover_tools: offset beyond total returns empty tools array', async () => {
  const first = await callDiscover({});
  const beyondEnd = await callDiscover({ offset: first.total + 9999 });

  assert.equal(beyondEnd.returned, 0, 'returned must be 0 when offset exceeds total');
  assert.equal(beyondEnd.tools.length, 0, 'tools array must be empty when offset exceeds total');
  assert.equal(beyondEnd.has_more, false, 'has_more must be false when offset exceeds total');
  assert.equal(beyondEnd.total, first.total, 'total must still reflect the full tool count');
});

// ---------------------------------------------------------------------------
// Compact shape (per-tool entry)
// ---------------------------------------------------------------------------

test('discover_tools: each tool entry has name, category, tier — no extra schema fields', async () => {
  const payload = await callDiscover({ limit: 10000 });

  for (const entry of payload.tools) {
    assert.equal(typeof entry.name, 'string', `name must be a string: ${JSON.stringify(entry)}`);
    assert.ok(entry.name.length > 0, 'name must be non-empty');

    assert.equal(typeof entry.category, 'string', `category must be a string: ${JSON.stringify(entry)}`);
    assert.ok(entry.category.length > 0, 'category must be non-empty');

    assert.equal(typeof entry.tier, 'string', `tier must be a string: ${JSON.stringify(entry)}`);
    assert.ok(
      entry.tier === 'filesystem' || entry.tier === 'cli',
      `tier must be 'filesystem' or 'cli': ${JSON.stringify(entry)}`
    );

    // Compact entries must NOT contain full schema fields
    assert.equal(entry.description, undefined, 'compact entry must not include description');
    assert.equal(entry.inputSchema, undefined, 'compact entry must not include inputSchema');
  }
});

test('discover_tools: discover_tools itself appears in the inventory', async () => {
  const payload = await callDiscover({ limit: 10000 });
  const found = payload.tools.find(t => t.name === 'discover_tools');
  assert.ok(found, 'discover_tools must appear in its own inventory');
  assert.equal(found.category, 'Getting Started', 'discover_tools category must be "Getting Started"');
});

test('discover_tools: get_started appears in the inventory', async () => {
  const payload = await callDiscover({ limit: 10000 });
  const found = payload.tools.find(t => t.name === 'get_started');
  assert.ok(found, 'get_started must appear in the inventory');
  assert.equal(found.category, 'Getting Started', 'get_started category must be "Getting Started"');
});

// ---------------------------------------------------------------------------
// Category histogram
// ---------------------------------------------------------------------------

test('discover_tools: histogram is a non-empty array', async () => {
  const payload = await callDiscover({});

  assert.ok(Array.isArray(payload.histogram), 'histogram must be an array');
  assert.ok(payload.histogram.length > 0, 'histogram must be non-empty');
});

test('discover_tools: each histogram entry has category and count', async () => {
  const payload = await callDiscover({});

  for (const entry of payload.histogram) {
    assert.equal(typeof entry.category, 'string', `histogram entry category must be a string: ${JSON.stringify(entry)}`);
    assert.ok(entry.category.length > 0, 'histogram category must be non-empty');
    assert.equal(typeof entry.count, 'number', `histogram entry count must be a number: ${JSON.stringify(entry)}`);
    assert.ok(entry.count > 0, `histogram count must be positive: ${JSON.stringify(entry)}`);
  }
});

test('discover_tools: histogram counts sum to total', async () => {
  const payload = await callDiscover({});
  const sum = payload.histogram.reduce((acc, entry) => acc + entry.count, 0);

  assert.equal(
    sum,
    payload.total,
    `histogram counts (${sum}) must sum to total (${payload.total})`
  );
});

test('discover_tools: histogram reflects full set even on a partial page', async () => {
  // Get a partial page (limit=1) and a full inventory
  const partial = await callDiscover({ limit: 1 });
  const full = await callDiscover({ limit: 10000 });

  // Histogram should be the same regardless of page size
  assert.deepEqual(
    partial.histogram,
    full.histogram,
    'histogram must reflect full tool set regardless of pagination'
  );
});

test('discover_tools: "Getting Started" category present in histogram', async () => {
  const payload = await callDiscover({});
  const gsCat = payload.histogram.find(c => c.category === 'Getting Started');
  assert.ok(gsCat, 'histogram must include "Getting Started" category');
  assert.ok(gsCat.count >= 2, 'Getting Started must have at least 2 tools (get_started + discover_tools)');
});
