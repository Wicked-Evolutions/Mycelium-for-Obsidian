/**
 * L3 Resolver-hints tests
 *
 * Verifies that:
 *  - resolveVault() error includes closest_matches + VAULT_NOT_FOUND_HINT on unknown vault
 *  - read_file handler returns closest_matches + NOTE_NOT_FOUND_HINT on missing note
 *  - follow_link handler returns closest_matches + NOTE_NOT_FOUND_HINT on missing note
 *  - resolve_wikilink handler returns closest_matches + NOTE_NOT_FOUND_HINT on missing note
 *  - fuzzy matching catches near-misses (editDistance, closestMatches)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

import { resolveVault } from '../dist/config.js';
import { VAULT_NOT_FOUND_HINT, NOTE_NOT_FOUND_HINT, closestMatches, editDistance } from '../dist/resolver-hints.js';
import { loadConfig, } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ─── Shared vault setup ───────────────────────────────────────────────────────

let vaultDir;
let handlers;

before(() => {
  vaultDir = createTempVault({
    'Meeting Notes.md': '# Meeting Notes\nSome content.',
    'Project Ideas.md': '# Project Ideas\nMore content.',
    'Daily Log.md': '# Daily Log\nLog entries.',
  });

  process.env.OBSIDIAN_VAULTS = JSON.stringify({
    'Platform': vaultDir,
    'Helena': vaultDir,
  });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  handlers = createAllHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ─── editDistance ─────────────────────────────────────────────────────────────

test('editDistance — identical strings', () => {
  assert.equal(editDistance('hello', 'hello'), 0);
});

test('editDistance — single substitution', () => {
  assert.equal(editDistance('Platform', 'Platfrm'), 1);
});

test('editDistance — empty string', () => {
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
});

test('editDistance — case-insensitive', () => {
  assert.equal(editDistance('Platform', 'platform'), 0);
});

// ─── closestMatches ───────────────────────────────────────────────────────────

test('closestMatches — returns near-miss by edit distance', () => {
  const names = ['Platform', 'Helena', 'Finding'];
  // 'Platfrm' is edit distance 1 from 'Platform'
  const matches = closestMatches('Platfrm', names);
  assert.ok(matches.includes('Platform'), `Expected Platform in ${JSON.stringify(matches)}`);
});

test('closestMatches — returns substring match', () => {
  const names = ['Platform', 'Helena', 'Finding'];
  const matches = closestMatches('Plat', names);
  assert.ok(matches.includes('Platform'), `Expected Platform for substring "Plat" in ${JSON.stringify(matches)}`);
});

test('closestMatches — returns at most limit results', () => {
  const names = ['Alpha', 'Alphaa', 'Alphb', 'Beta', 'Gamma'];
  const matches = closestMatches('Alpha', names, 2);
  assert.ok(matches.length <= 2, `Expected at most 2 matches, got ${matches.length}`);
});

test('closestMatches — returns empty array when no candidates are close', () => {
  const names = ['Platform', 'Helena'];
  // 'ZZZZZ' is far from both
  const matches = closestMatches('ZZZZZ', names, 3, 3);
  assert.equal(matches.length, 0, `Expected no matches for ZZZZZ, got ${JSON.stringify(matches)}`);
});

// ─── VAULT_NOT_FOUND_HINT constant ───────────────────────────────────────────

test('VAULT_NOT_FOUND_HINT is defined and non-empty', () => {
  assert.equal(typeof VAULT_NOT_FOUND_HINT, 'string');
  assert.ok(VAULT_NOT_FOUND_HINT.length > 0);
  // Should mention get_started
  assert.ok(VAULT_NOT_FOUND_HINT.toLowerCase().includes('get_started'),
    `Expected get_started in hint: "${VAULT_NOT_FOUND_HINT}"`);
});

// ─── NOTE_NOT_FOUND_HINT constant ────────────────────────────────────────────

test('NOTE_NOT_FOUND_HINT is defined and non-empty', () => {
  assert.equal(typeof NOTE_NOT_FOUND_HINT, 'string');
  assert.ok(NOTE_NOT_FOUND_HINT.length > 0);
  // Should mention a search tool
  assert.ok(
    NOTE_NOT_FOUND_HINT.toLowerCase().includes('find_note_by_name') ||
    NOTE_NOT_FOUND_HINT.toLowerCase().includes('search_content'),
    `Expected search tool reference in hint: "${NOTE_NOT_FOUND_HINT}"`
  );
});

// ─── resolveVault — unknown vault returns closest_matches + hint ──────────────

test('resolveVault() — unknown vault error includes hint property', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Platform', path: '/tmp/platform' },
      { name: 'Helena', path: '/tmp/helena' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  let caughtErr = null;
  try {
    resolveVault(config, 'Platfrm');
  } catch (e) {
    caughtErr = e;
  }

  assert.ok(caughtErr !== null, 'Expected resolveVault to throw');
  assert.ok(caughtErr instanceof Error);
  // Must still include the "Available:" list (existing contract)
  assert.ok(caughtErr.message.includes('Platform') && caughtErr.message.includes('Helena'),
    `Expected available vaults in message: "${caughtErr.message}"`);
  // New: hint property
  assert.equal(caughtErr.hint, VAULT_NOT_FOUND_HINT,
    `Expected hint property on error`);
});

test('resolveVault() — unknown vault error includes closest_matches with near-miss', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Platform', path: '/tmp/platform' },
      { name: 'Helena', path: '/tmp/helena' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  let caughtErr = null;
  try {
    // 'Platfrm' is edit distance 1 from 'Platform' — should be suggested
    resolveVault(config, 'Platfrm');
  } catch (e) {
    caughtErr = e;
  }

  assert.ok(caughtErr !== null, 'Expected resolveVault to throw');
  assert.ok(Array.isArray(caughtErr.closest_matches),
    `Expected closest_matches array on error, got: ${typeof caughtErr.closest_matches}`);
  assert.ok(caughtErr.closest_matches.includes('Platform'),
    `Expected Platform in closest_matches: ${JSON.stringify(caughtErr.closest_matches)}`);
});

test('resolveVault() — unknown vault with no near-miss has empty closest_matches', () => {
  const config = {
    mode: 'multi',
    vaults: [
      { name: 'Alpha', path: '/tmp/alpha' },
      { name: 'Beta', path: '/tmp/beta' },
    ],
    ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' },
    disabledTools: new Set(),
  };

  let caughtErr = null;
  try {
    resolveVault(config, 'ZZZZZ');
  } catch (e) {
    caughtErr = e;
  }

  assert.ok(caughtErr !== null);
  assert.ok(Array.isArray(caughtErr.closest_matches));
  // ZZZZZ is too far from Alpha/Beta — no suggestions
  assert.equal(caughtErr.closest_matches.length, 0,
    `Expected empty closest_matches for ZZZZZ, got: ${JSON.stringify(caughtErr.closest_matches)}`);
});

// ─── read_file — missing note returns closest_matches + hint ─────────────────

test('read_file handler — missing note returns isError:true with closest_matches and hint', async () => {
  // 'Meting Notes.md' is a near-miss for 'Meeting Notes.md' (edit distance 1)
  const res = await handlers.read_file({ vault: 'Platform', path: 'Meting Notes.md' });

  assert.equal(res.isError, true, 'Expected isError:true for missing file');
  assert.ok(Array.isArray(res.content) && res.content.length > 0);

  const data = JSON.parse(res.content[0].text);
  assert.ok(data.error, `Expected error field, got: ${JSON.stringify(data)}`);
  assert.ok(Array.isArray(data.closest_matches),
    `Expected closest_matches array, got: ${typeof data.closest_matches}`);
  assert.equal(data.hint, NOTE_NOT_FOUND_HINT,
    `Expected NOTE_NOT_FOUND_HINT in hint field`);
});

test('read_file handler — near-miss suggests the correct note', async () => {
  // 'Projct Ideas.md' should suggest 'Project Ideas'
  const res = await handlers.read_file({ vault: 'Platform', path: 'Projct Ideas.md' });

  assert.equal(res.isError, true);
  const data = JSON.parse(res.content[0].text);
  assert.ok(data.closest_matches.includes('Project Ideas'),
    `Expected "Project Ideas" in suggestions: ${JSON.stringify(data.closest_matches)}`);
});

// ─── follow_link — missing note returns closest_matches + hint ───────────────

test('follow_link handler — missing note returns found:false with closest_matches and hint', async () => {
  // 'Meting Notes' is a near-miss for 'Meeting Notes'
  const res = await handlers.follow_link({ vault: 'Platform', link: 'Meting Notes' });

  assert.equal(res.isError, false, 'follow_link missing should be isError:false (not an error)');
  const data = JSON.parse(res.content[0].text);

  assert.equal(data.found, false, `Expected found:false`);
  assert.ok(Array.isArray(data.closest_matches),
    `Expected closest_matches array on follow_link not-found`);
  assert.equal(data.hint, NOTE_NOT_FOUND_HINT,
    `Expected NOTE_NOT_FOUND_HINT in hint field`);
});

test('follow_link handler — near-miss suggests the correct note', async () => {
  const res = await handlers.follow_link({ vault: 'Platform', link: 'Projct Ideas' });
  const data = JSON.parse(res.content[0].text);

  assert.equal(data.found, false);
  assert.ok(data.closest_matches.includes('Project Ideas'),
    `Expected "Project Ideas" in suggestions: ${JSON.stringify(data.closest_matches)}`);
});

// ─── resolve_wikilink — missing note returns closest_matches + hint ──────────

test('resolve_wikilink handler — missing note returns exists:false with closest_matches and hint', async () => {
  const res = await handlers.resolve_wikilink({ vault: 'Platform', link: 'Daly Log' });

  assert.equal(res.isError, false, 'resolve_wikilink missing should be isError:false');
  const data = JSON.parse(res.content[0].text);

  assert.equal(data.exists, false);
  assert.ok(Array.isArray(data.closest_matches),
    `Expected closest_matches array on resolve_wikilink not-found`);
  assert.equal(data.hint, NOTE_NOT_FOUND_HINT);
});

test('resolve_wikilink handler — near-miss suggests the correct note', async () => {
  const res = await handlers.resolve_wikilink({ vault: 'Platform', link: 'Daly Log' });
  const data = JSON.parse(res.content[0].text);

  assert.ok(data.closest_matches.includes('Daily Log'),
    `Expected "Daily Log" in suggestions: ${JSON.stringify(data.closest_matches)}`);
});
