/**
 * Behavior tests for the get_started tool
 *
 * Verifies that:
 *  - Dynamic fields: vault names, total tool count, category names + counts
 *  - Static guidance: resolver-first phrase, same-vault [[wikilink]] syntax,
 *    cross-vault obsidian:// URI syntax, CLI-tier phrase
 *
 * Run: node --test test/get-started.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ---------------------------------------------------------------------------
// Fixtures — two named vaults (both pointing at same temp dir for simplicity)
// ---------------------------------------------------------------------------

let vaultDir;
let handlers;

before(() => {
  vaultDir = createTempVault({});

  process.env.OBSIDIAN_VAULTS = JSON.stringify({ Alpha: vaultDir, Beta: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  handlers = createAllHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('get_started returns a non-error response', async () => {
  const res = await handlers.get_started({});
  assert.equal(typeof res, 'object', 'response is an object');
  assert.ok(Array.isArray(res.content), 'content is an array');
  assert.ok(res.content.length > 0, 'content is non-empty');
  assert.equal(typeof res.content[0].text, 'string', 'content[0].text is a string');
  assert.equal(res.isError, false, `isError is false — got: ${res.content[0]?.text}`);
});

test('get_started response is valid JSON', async () => {
  const res = await handlers.get_started({});
  assert.doesNotThrow(
    () => JSON.parse(res.content[0].text),
    'response text must be valid JSON'
  );
});

test('get_started dynamic: vaultNames contains both configured vaults', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);

  assert.ok(Array.isArray(payload.vaultNames), 'vaultNames is an array');
  assert.ok(payload.vaultNames.includes('Alpha'), 'vaultNames includes Alpha');
  assert.ok(payload.vaultNames.includes('Beta'), 'vaultNames includes Beta');
  assert.equal(payload.vaultNames.length, 2, 'vaultNames has exactly 2 entries');
});

test('get_started dynamic: totalToolCount is a positive integer', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);

  assert.equal(typeof payload.totalToolCount, 'number', 'totalToolCount is a number');
  assert.ok(payload.totalToolCount > 0, 'totalToolCount is positive');
  assert.equal(
    payload.totalToolCount,
    Math.floor(payload.totalToolCount),
    'totalToolCount is an integer'
  );
});

test('get_started dynamic: categories is a non-empty array with name and count', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);

  assert.ok(Array.isArray(payload.categories), 'categories is an array');
  assert.ok(payload.categories.length > 0, 'categories is non-empty');

  for (const cat of payload.categories) {
    assert.equal(typeof cat.category, 'string', `category entry has string category: ${JSON.stringify(cat)}`);
    assert.ok(cat.category.length > 0, 'category name is non-empty');
    assert.equal(typeof cat.count, 'number', `category entry has numeric count: ${JSON.stringify(cat)}`);
    assert.ok(cat.count > 0, `category count is positive: ${JSON.stringify(cat)}`);
  }
});

test('get_started dynamic: category counts sum to totalToolCount', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);

  const sum = payload.categories.reduce((acc, cat) => acc + cat.count, 0);
  assert.equal(
    sum,
    payload.totalToolCount,
    `category counts (${sum}) must sum to totalToolCount (${payload.totalToolCount})`
  );
});

test('get_started dynamic: "Getting Started" category present with count >= 1', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);

  const gsCat = payload.categories.find(c => c.category === 'Getting Started');
  assert.ok(gsCat, 'Getting Started category must be present');
  assert.ok(gsCat.count >= 1, 'Getting Started category must have at least 1 tool');
});

test('get_started static guidance: resolver-first phrase present', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);
  const text = JSON.stringify(payload.guidance);

  assert.ok(
    text.includes('resolver') || text.includes('follow_link') || text.includes('resolve_wikilink'),
    'guidance must mention resolver-first tools'
  );
});

test('get_started static guidance: same-vault wikilink syntax present', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);
  const text = JSON.stringify(payload.guidance);

  assert.ok(
    text.includes('[['),
    'guidance must mention [[wikilink]] syntax'
  );
});

test('get_started static guidance: cross-vault obsidian:// URI syntax present', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);
  const text = JSON.stringify(payload.guidance);

  assert.ok(
    text.includes('obsidian://open?vault='),
    'guidance must mention obsidian://open?vault= URI syntax for cross-vault links'
  );
});

test('get_started static guidance: CLI-tier mention present', async () => {
  const res = await handlers.get_started({});
  const payload = JSON.parse(res.content[0].text);
  const text = JSON.stringify(payload.guidance);

  assert.ok(
    text.includes('Obsidian') && text.includes('CLI'),
    'guidance must mention CLI tier and Obsidian requirement'
  );
});
