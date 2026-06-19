/**
 * Cross-vault tool tests — crossvault.test.mjs
 *
 * Covers: search_all_vaults, find_note_by_name, get_cross_vault_links,
 *         get_ecosystem_stats, semantic_search_all
 *
 * Multi-vault fixture layout:
 *
 *   VaultA/
 *     Alpha.md           — contains "unique-alpha-term"
 *     Sub/AlphaSub.md    — contains "unique-alpha-term" in subdirectory
 *
 *   VaultB/
 *     Beta.md            — contains "unique-beta-term"
 *     Alpha.md           — same name as VaultA/Alpha.md (for find_note_by_name)
 *     CrossLinker.md     — links [[RemoteNote]] that only exists in VaultA
 *
 *   VaultA/
 *     RemoteNote.md      — exists so CrossLinker in VaultB can detect potential cross-vault link
 *
 * semantic_search_all and get_ecosystem_stats (embedding path) are SKIP-gated
 * on Ollama availability.
 *
 * Run: node --test test/crossvault.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createCrossVaultHandlers } from '../dist/tools/crossvault.js';
import { checkOllamaAvailability } from '../dist/embeddings/ollama.js';

// ─── Vault fixtures ──────────────────────────────────────────────────────────

const VAULT_A_FILES = {
  'Alpha.md': [
    '# Alpha',
    '',
    'This note contains unique-alpha-term.',
    'See also [[AlphaSub]] and [[CrossLink]].',
  ].join('\n'),

  'Sub/AlphaSub.md': [
    '# AlphaSub',
    '',
    'Another unique-alpha-term in a subdirectory.',
  ].join('\n'),

  'RemoteNote.md': [
    '# Remote Note',
    '',
    'This note lives in VaultA and is referenced from VaultB.',
  ].join('\n'),

  'CaseSensitive.md': [
    '# CaseSensitive',
    '',
    'Contains UNIQUE-ALPHA-TERM (uppercase) and unique-alpha-term (lowercase).',
  ].join('\n'),
};

const VAULT_B_FILES = {
  'Beta.md': [
    '# Beta',
    '',
    'unique-beta-term appears here only.',
  ].join('\n'),

  'Alpha.md': [
    '# Alpha (VaultB copy)',
    '',
    'This is a different note with the same filename as VaultA/Alpha.md.',
  ].join('\n'),

  'CrossLinker.md': [
    '# CrossLinker',
    '',
    'This note references [[RemoteNote]] which only exists in VaultA.',
    'It also references [[NonExistentAnywhere]] which is nowhere.',
  ].join('\n'),
};

// ─── Setup / teardown ────────────────────────────────────────────────────────

let vaultA;
let vaultB;
let handlers;
let ollamaReady = false;

before(async () => {
  vaultA = createTempVault(VAULT_A_FILES);
  vaultB = createTempVault(VAULT_B_FILES);

  process.env.OBSIDIAN_VAULTS = JSON.stringify({
    VaultA: vaultA,
    VaultB: vaultB,
  });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;

  const config = loadConfig();
  handlers = createCrossVaultHandlers(config);

  // Probe Ollama availability once for skip-gating
  try {
    const ollamaConfig = {
      host: process.env.OLLAMA_HOST || 'http://localhost:11434',
      model: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
    };
    const probe = await checkOllamaAvailability(ollamaConfig);
    ollamaReady = probe.available && probe.hasModel;
  } catch {
    ollamaReady = false;
  }
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultA) cleanup(vaultA);
  if (vaultB) cleanup(vaultB);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Assert non-error ToolResponse with text content; returns the parsed JSON payload. */
function payload(res, label = '') {
  assert.equal(
    typeof res, 'object',
    `${label}: response is an object`,
  );
  assert.ok(Array.isArray(res.content), `${label}: content is an array`);
  assert.ok(res.content.length > 0, `${label}: content is non-empty`);
  assert.equal(
    res.isError, false,
    `${label}: isError is false — got: ${res.content[0]?.text}`,
  );
  return JSON.parse(res.content[0].text);
}

// ─── search_all_vaults ────────────────────────────────────────────────────────

describe('search_all_vaults', () => {
  test('returns non-error response with expected shape', async () => {
    const res = await handlers.search_all_vaults({ query: 'unique-alpha-term' });
    const data = payload(res, 'search_all_vaults basic shape');

    assert.equal(typeof data.query, 'string', 'echoes query');
    assert.equal(data.query, 'unique-alpha-term');
    assert.equal(typeof data.vaultsSearched, 'number', 'vaultsSearched is a number');
    assert.equal(data.vaultsSearched, 2, 'searched both vaults');
    assert.equal(typeof data.totalResults, 'number', 'totalResults is a number');
    assert.ok(Array.isArray(data.results), 'results is an array');
  });

  test('finds term that exists only in VaultA, not VaultB', async () => {
    const res = await handlers.search_all_vaults({ query: 'unique-alpha-term' });
    const data = payload(res, 'search_all_vaults alpha-only');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    const vaultBEntry = data.results.find(r => r.vault === 'VaultB');

    assert.ok(vaultAEntry, 'VaultA entry present');
    assert.ok(vaultAEntry.results.length >= 1, 'VaultA has at least 1 match');

    // unique-alpha-term does not appear in any VaultB file
    assert.ok(vaultBEntry, 'VaultB entry present (but zero results)');
    assert.equal(vaultBEntry.results.length, 0, 'VaultB has no matches for unique-alpha-term');
  });

  test('finds term that exists only in VaultB', async () => {
    const res = await handlers.search_all_vaults({ query: 'unique-beta-term' });
    const data = payload(res, 'search_all_vaults beta-only');

    const vaultBEntry = data.results.find(r => r.vault === 'VaultB');
    assert.ok(vaultBEntry, 'VaultB entry present');
    assert.ok(vaultBEntry.results.length >= 1, 'VaultB has at least 1 match');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    assert.equal(vaultAEntry.results.length, 0, 'VaultA has no matches for unique-beta-term');
  });

  test('result entries include path and matches arrays', async () => {
    const res = await handlers.search_all_vaults({ query: 'unique-alpha-term' });
    const data = payload(res, 'search_all_vaults match shape');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    const firstFile = vaultAEntry.results[0];

    assert.equal(typeof firstFile.path, 'string', 'result.path is a string');
    assert.ok(Array.isArray(firstFile.matches), 'result.matches is an array');

    const firstMatch = firstFile.matches[0];
    assert.equal(typeof firstMatch.lineNumber, 'number', 'match.lineNumber is a number');
    assert.ok(firstMatch.lineNumber >= 1, 'lineNumber is 1-based');
    assert.equal(typeof firstMatch.lineContent, 'string', 'match.lineContent is a string');
    assert.ok(
      firstMatch.lineContent.includes('unique-alpha-term'),
      `lineContent contains the search term — got: ${firstMatch.lineContent}`,
    );
  });

  test('case-insensitive search (default) matches mixed-case occurrences', async () => {
    const res = await handlers.search_all_vaults({
      query: 'unique-alpha-term',
      caseSensitive: false,
    });
    const data = payload(res, 'search_all_vaults case-insensitive');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    // CaseSensitive.md has both upper and lowercase versions
    const caseFile = vaultAEntry.results.find(r => r.path.includes('CaseSensitive'));
    assert.ok(caseFile, 'CaseSensitive.md matched (has uppercase variant)');
    // Should have 2 matches: one uppercase, one lowercase
    assert.equal(caseFile.matches.length, 2, 'two matches in CaseSensitive.md (upper + lower)');
  });

  test('case-sensitive search only matches exact case', async () => {
    const res = await handlers.search_all_vaults({
      query: 'unique-alpha-term',
      caseSensitive: true,
    });
    const data = payload(res, 'search_all_vaults case-sensitive');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    const caseFile = vaultAEntry.results.find(r => r.path.includes('CaseSensitive'));
    assert.ok(caseFile, 'CaseSensitive.md still matched (has lowercase)');
    // With case sensitivity, only the lowercase occurrence matches — not UNIQUE-ALPHA-TERM.
    // The lineContent field contains the full line, but there should be exactly 1 match
    // (the lowercase one at a later offset) rather than 2 (as in case-insensitive mode).
    assert.equal(caseFile.matches.length, 1, 'only one match (lowercase) with caseSensitive:true');
    // matchStart should point to the lowercase occurrence (later in the string than pos 0)
    // — the uppercase UNIQUE-ALPHA-TERM starts at index 9; lowercase unique-alpha-term at 43
    assert.ok(
      caseFile.matches[0].matchStart > 20,
      `matchStart (${caseFile.matches[0].matchStart}) should point to the lowercase occurrence, not the uppercase one`,
    );
  });

  test('maxResultsPerVault limits results per vault', async () => {
    // VaultA has at least 2 files with unique-alpha-term (Alpha.md + Sub/AlphaSub.md + CaseSensitive.md)
    const res = await handlers.search_all_vaults({
      query: 'unique-alpha-term',
      maxResultsPerVault: 1,
    });
    const data = payload(res, 'search_all_vaults maxResultsPerVault');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    assert.ok(
      vaultAEntry.results.length <= 1,
      `VaultA results should be <= 1 (got ${vaultAEntry.results.length})`,
    );
  });

  test('query with no matches returns zero totalResults', async () => {
    const res = await handlers.search_all_vaults({ query: 'zzz-no-such-term-anywhere-xyz' });
    const data = payload(res, 'search_all_vaults no matches');

    assert.equal(data.totalResults, 0, 'totalResults is 0 when nothing found');
    for (const vaultResult of data.results) {
      assert.equal(vaultResult.results.length, 0, `${vaultResult.vault} has 0 results`);
    }
  });

  test('regex pattern works across vaults', async () => {
    // Match "unique-alpha-term" or "unique-beta-term" with a regex alternation
    const res = await handlers.search_all_vaults({
      query: 'unique-(alpha|beta)-term',
    });
    const data = payload(res, 'search_all_vaults regex');

    assert.ok(data.totalResults >= 2, `expected at least 2 total results (got ${data.totalResults})`);
    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    const vaultBEntry = data.results.find(r => r.vault === 'VaultB');
    assert.ok(vaultAEntry.results.length >= 1, 'VaultA matched regex');
    assert.ok(vaultBEntry.results.length >= 1, 'VaultB matched regex');
  });

  test('result vaultPath fields are absolute paths', async () => {
    const res = await handlers.search_all_vaults({ query: 'unique-alpha-term' });
    const data = payload(res, 'search_all_vaults vaultPath');

    for (const vaultResult of data.results) {
      assert.ok(
        vaultResult.vaultPath.startsWith('/'),
        `vaultPath should be absolute — got: ${vaultResult.vaultPath}`,
      );
    }
  });

  test('subdirectory files are found', async () => {
    // Sub/AlphaSub.md contains unique-alpha-term
    const res = await handlers.search_all_vaults({ query: 'unique-alpha-term' });
    const data = payload(res, 'search_all_vaults subdirectory');

    const vaultAEntry = data.results.find(r => r.vault === 'VaultA');
    const paths = vaultAEntry.results.map(r => r.path);
    const subFile = paths.find(p => p.includes('AlphaSub'));
    assert.ok(subFile, `Sub/AlphaSub.md should be in results — got paths: ${paths.join(', ')}`);
  });
});

// ─── find_note_by_name ────────────────────────────────────────────────────────

describe('find_note_by_name', () => {
  test('returns non-error response with expected shape', async () => {
    const res = await handlers.find_note_by_name({ name: 'Alpha' });
    const data = payload(res, 'find_note_by_name shape');

    assert.equal(typeof data.searchName, 'string', 'searchName present');
    assert.equal(typeof data.exactMatch, 'boolean', 'exactMatch present');
    assert.equal(typeof data.foundCount, 'number', 'foundCount is a number');
    assert.ok(Array.isArray(data.matches), 'matches is an array');
  });

  test('finds a note present in only one vault', async () => {
    const res = await handlers.find_note_by_name({ name: 'Beta' });
    const data = payload(res, 'find_note_by_name VaultB-only');

    assert.equal(data.foundCount, 1, 'Beta.md exists in exactly one vault');
    assert.equal(data.matches[0].vault, 'VaultB', 'found in VaultB');
    assert.ok(
      data.matches[0].path.endsWith('Beta.md'),
      `path ends with Beta.md — got: ${data.matches[0].path}`,
    );
  });

  test('finds same-named notes across both vaults', async () => {
    // Alpha.md exists in both VaultA and VaultB
    const res = await handlers.find_note_by_name({ name: 'Alpha' });
    const data = payload(res, 'find_note_by_name cross-vault duplicate');

    assert.ok(data.foundCount >= 2, `expected >= 2 matches for Alpha (got ${data.foundCount})`);

    const vaultNames = data.matches.map(m => m.vault);
    assert.ok(vaultNames.includes('VaultA'), 'VaultA Alpha found');
    assert.ok(vaultNames.includes('VaultB'), 'VaultB Alpha found');
  });

  test('match entries include vault, path, title, modified fields', async () => {
    const res = await handlers.find_note_by_name({ name: 'Beta' });
    const data = payload(res, 'find_note_by_name match shape');

    const match = data.matches[0];
    assert.equal(typeof match.vault, 'string', 'match.vault is a string');
    assert.equal(typeof match.path, 'string', 'match.path is a string');
    assert.equal(typeof match.title, 'string', 'match.title is a string');
    assert.equal(typeof match.modified, 'string', 'match.modified is a string');
    // modified should be an ISO date string
    assert.ok(
      !isNaN(Date.parse(match.modified)),
      `match.modified should be a valid date — got: ${match.modified}`,
    );
  });

  test('partial name match finds notes containing the substring', async () => {
    // "lpha" should match Alpha.md in both vaults (partial, case-insensitive)
    const res = await handlers.find_note_by_name({ name: 'lpha', exactMatch: false });
    const data = payload(res, 'find_note_by_name partial');

    assert.ok(data.foundCount >= 2, `expected >= 2 partial matches (got ${data.foundCount})`);
    const paths = data.matches.map(m => m.path);
    assert.ok(
      paths.some(p => p.toLowerCase().includes('alpha')),
      'at least one match contains "alpha" in path',
    );
  });

  test('exactMatch:true does not return notes whose names only partially match', async () => {
    // "Alph" is a partial name — should not match "Alpha.md" with exactMatch:true
    const res = await handlers.find_note_by_name({ name: 'Alph', exactMatch: true });
    const data = payload(res, 'find_note_by_name exactMatch no partial');

    assert.equal(data.foundCount, 0, 'exactMatch:true should not match partial "Alph"');
  });

  test('exactMatch:true finds notes with exact name', async () => {
    const res = await handlers.find_note_by_name({ name: 'RemoteNote', exactMatch: true });
    const data = payload(res, 'find_note_by_name exactMatch hit');

    assert.equal(data.foundCount, 1, 'exactly one note named RemoteNote');
    assert.equal(data.matches[0].vault, 'VaultA');
    assert.ok(
      data.matches[0].path.endsWith('RemoteNote.md'),
      `path ends with RemoteNote.md — got: ${data.matches[0].path}`,
    );
  });

  test('returns empty matches for a name that does not exist anywhere', async () => {
    const res = await handlers.find_note_by_name({ name: 'zzz-nonexistent-note-xyz' });
    const data = payload(res, 'find_note_by_name no match');

    assert.equal(data.foundCount, 0, 'no matches for nonexistent name');
    assert.deepEqual(data.matches, [], 'matches array is empty');
  });

  test('exact-match results are sorted first when mixed with partial matches', async () => {
    // "Alpha" exactly matches "Alpha.md" in both vaults, AlphaSub.md is a partial match
    const res = await handlers.find_note_by_name({ name: 'Alpha', exactMatch: false });
    const data = payload(res, 'find_note_by_name sort order');

    // Exact-name matches (path.basename == "Alpha.md") should precede partial (AlphaSub.md)
    const exactMatches = data.matches.filter(
      m => m.path.split('/').pop() === 'Alpha.md',
    );
    const partialMatches = data.matches.filter(
      m => m.path.split('/').pop() !== 'Alpha.md',
    );

    if (partialMatches.length > 0 && exactMatches.length > 0) {
      const lastExactIdx = data.matches.findLastIndex(
        m => m.path.split('/').pop() === 'Alpha.md',
      );
      const firstPartialIdx = data.matches.findIndex(
        m => m.path.split('/').pop() !== 'Alpha.md',
      );
      assert.ok(
        lastExactIdx < firstPartialIdx,
        'all exact matches appear before partial matches in sorted output',
      );
    }
  });

  test('subdirectory notes are discoverable by name', async () => {
    const res = await handlers.find_note_by_name({ name: 'AlphaSub' });
    const data = payload(res, 'find_note_by_name subdirectory');

    assert.ok(data.foundCount >= 1, 'AlphaSub found');
    assert.ok(
      data.matches[0].path.includes('AlphaSub'),
      `path includes AlphaSub — got: ${data.matches[0].path}`,
    );
  });
});

// ─── get_cross_vault_links ────────────────────────────────────────────────────

describe('get_cross_vault_links', () => {
  test('returns non-error response with expected shape', async () => {
    const res = await handlers.get_cross_vault_links({});
    const data = payload(res, 'get_cross_vault_links shape');

    assert.equal(
      typeof data.totalPotentialLinks, 'number',
      'totalPotentialLinks is a number',
    );
    assert.ok(Array.isArray(data.links), 'links is an array');
  });

  test('detects [[RemoteNote]] in VaultB as potential cross-vault link to VaultA', async () => {
    const res = await handlers.get_cross_vault_links({});
    const data = payload(res, 'get_cross_vault_links RemoteNote');

    // CrossLinker.md in VaultB links [[RemoteNote]] which only exists in VaultA
    const remoteLink = data.links.find(
      l => l.sourceVault === 'VaultB' && l.unresolvedLink === 'RemoteNote',
    );
    assert.ok(
      remoteLink,
      `expected a link entry for VaultB→RemoteNote, got links: ${JSON.stringify(data.links.map(l => l.unresolvedLink))}`,
    );

    assert.ok(
      Array.isArray(remoteLink.potentialTargets),
      'potentialTargets is an array',
    );
    assert.ok(
      remoteLink.potentialTargets.length >= 1,
      'at least one potential target (RemoteNote in VaultA)',
    );
    assert.equal(
      remoteLink.potentialTargets[0].vault,
      'VaultA',
      'potential target is in VaultA',
    );
  });

  test('link entries include sourceVault, sourcePath, unresolvedLink, potentialTargets', async () => {
    const res = await handlers.get_cross_vault_links({});
    const data = payload(res, 'get_cross_vault_links entry shape');

    if (data.links.length === 0) {
      // No links found — still a valid (non-error) response
      return;
    }

    const link = data.links[0];
    assert.equal(typeof link.sourceVault, 'string', 'link.sourceVault is a string');
    assert.equal(typeof link.sourcePath, 'string', 'link.sourcePath is a string');
    assert.equal(typeof link.unresolvedLink, 'string', 'link.unresolvedLink is a string');
    assert.ok(Array.isArray(link.potentialTargets), 'link.potentialTargets is an array');
    if (link.potentialTargets.length > 0) {
      assert.equal(
        typeof link.potentialTargets[0].vault, 'string',
        'target.vault is a string',
      );
      assert.equal(
        typeof link.potentialTargets[0].path, 'string',
        'target.path is a string',
      );
    }
  });

  test('vault filter restricts source vault', async () => {
    const resAll = await handlers.get_cross_vault_links({});
    const dataAll = payload(resAll, 'get_cross_vault_links all');

    const resB = await handlers.get_cross_vault_links({ vault: 'VaultB' });
    const dataB = payload(resB, 'get_cross_vault_links VaultB filter');

    // Filtered results should only contain links whose sourceVault is VaultB
    for (const link of dataB.links) {
      assert.equal(
        link.sourceVault, 'VaultB',
        `with vault filter, sourceVault should be VaultB — got: ${link.sourceVault}`,
      );
    }

    // Filtered count should be <= unfiltered count
    assert.ok(
      dataB.totalPotentialLinks <= dataAll.totalPotentialLinks,
      'filtered result count is <= unfiltered',
    );
  });

  test('fully resolved local links are not reported as potential cross-vault links', async () => {
    // Alpha.md in VaultA links [[AlphaSub]] and [[CrossLink]] — AlphaSub exists locally
    const res = await handlers.get_cross_vault_links({ vault: 'VaultA' });
    const data = payload(res, 'get_cross_vault_links no local-resolved');

    // [[AlphaSub]] resolves locally in VaultA, so it must NOT appear as a cross-vault candidate
    const alphaSubLink = data.links.find(
      l => l.sourceVault === 'VaultA' && l.unresolvedLink === 'AlphaSub',
    );
    assert.equal(
      alphaSubLink,
      undefined,
      '[[AlphaSub]] is resolved locally and should not be a cross-vault candidate',
    );
  });

  test('[[NonExistentAnywhere]] is not reported because it has no target in any vault', async () => {
    const res = await handlers.get_cross_vault_links({});
    const data = payload(res, 'get_cross_vault_links NonExistentAnywhere excluded');

    // A link that exists nowhere should not appear — potentialTargets would be empty
    const nowhereLink = data.links.find(l => l.unresolvedLink === 'NonExistentAnywhere');
    assert.equal(
      nowhereLink,
      undefined,
      '[[NonExistentAnywhere]] has no target in any vault so it must not appear',
    );
  });
});

// ─── get_ecosystem_stats (non-embedding path) ────────────────────────────────

describe('get_ecosystem_stats — structural fields (no embedding dependency)', () => {
  test('returns non-error response', async () => {
    const res = await handlers.get_ecosystem_stats();
    payload(res, 'get_ecosystem_stats non-error');
  });

  test('response contains top-level vaultCount matching config', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats vaultCount');

    assert.equal(typeof data.vaultCount, 'number', 'vaultCount is a number');
    assert.equal(data.vaultCount, 2, 'two vaults in config');
  });

  test('totalFiles counts actual .md files in both vaults', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats totalFiles');

    // VaultA: Alpha.md, Sub/AlphaSub.md, RemoteNote.md, CaseSensitive.md = 4
    // VaultB: Beta.md, Alpha.md, CrossLinker.md = 3
    // Total = 7
    assert.equal(typeof data.totalFiles, 'number', 'totalFiles is a number');
    assert.equal(data.totalFiles, 7, `expected 7 total .md files, got ${data.totalFiles}`);
  });

  test('vaults array has one entry per vault with expected fields', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats vaults array');

    assert.ok(Array.isArray(data.vaults), 'vaults is an array');
    assert.equal(data.vaults.length, 2, 'two vault entries');

    for (const vaultStat of data.vaults) {
      assert.equal(typeof vaultStat.vault, 'string', 'vaultStat.vault is a string');
      assert.equal(typeof vaultStat.totalFiles, 'number', 'vaultStat.totalFiles is a number');
      assert.equal(typeof vaultStat.totalEmbeddings, 'number', 'vaultStat.totalEmbeddings is a number');
      assert.equal(
        typeof vaultStat.indexedPercent, 'number',
        'vaultStat.indexedPercent is a number',
      );
    }
  });

  test('per-vault file counts are correct', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats per-vault counts');

    const vaultAStat = data.vaults.find(v => v.vault === 'VaultA');
    const vaultBStat = data.vaults.find(v => v.vault === 'VaultB');

    assert.ok(vaultAStat, 'VaultA entry present');
    assert.ok(vaultBStat, 'VaultB entry present');

    assert.equal(vaultAStat.totalFiles, 4, 'VaultA has 4 .md files');
    assert.equal(vaultBStat.totalFiles, 3, 'VaultB has 3 .md files');
  });

  test('indexedPercent is 0 when no embeddings exist (fresh vault)', async () => {
    // Fresh temp vaults have no index files, so totalEmbeddings should be 0
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats indexedPercent zero');

    for (const vaultStat of data.vaults) {
      assert.equal(
        vaultStat.indexedPercent, 0,
        `${vaultStat.vault} should have 0% indexed (no index built)`,
      );
    }

    assert.equal(
      data.overallIndexedPercent, 0,
      'overall indexed percent should be 0 with no embeddings',
    );
  });

  test('ollama field is present with availability status', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats ollama field');

    assert.ok(data.ollama !== undefined, 'ollama field exists');
    assert.equal(typeof data.ollama.available, 'boolean', 'ollama.available is a boolean');
    assert.equal(typeof data.ollama.model, 'string', 'ollama.model is a string');
    assert.equal(typeof data.ollama.hasModel, 'boolean', 'ollama.hasModel is a boolean');
  });

  test('totalEmbeddings sums per-vault embedding counts', async () => {
    const res = await handlers.get_ecosystem_stats();
    const data = payload(res, 'get_ecosystem_stats totalEmbeddings sum');

    const sumFromVaults = data.vaults.reduce((acc, v) => acc + v.totalEmbeddings, 0);
    assert.equal(
      data.totalEmbeddings, sumFromVaults,
      `totalEmbeddings (${data.totalEmbeddings}) should equal sum of per-vault embeddings (${sumFromVaults})`,
    );
  });
});

// ─── semantic_search_all — SKIP-gated on Ollama availability ─────────────────

describe('semantic_search_all', () => {
  test('returns non-error response shape when Ollama is available (skip if not)', async (t) => {
    if (!ollamaReady) {
      t.skip('Ollama not available or model not loaded — skipping semantic_search_all tests');
      return;
    }

    const res = await handlers.semantic_search_all({ query: 'notes about vault alpha content' });
    const data = payload(res, 'semantic_search_all shape');

    assert.equal(typeof data.query, 'string', 'echoes query');
    assert.equal(typeof data.vaultsSearched, 'number', 'vaultsSearched is a number');
    assert.equal(typeof data.vaultsIndexed, 'number', 'vaultsIndexed is a number');
    assert.equal(typeof data.resultCount, 'number', 'resultCount is a number');
    assert.ok(Array.isArray(data.results), 'results is an array');
  });

  test('result entries contain expected fields (skip if Ollama unavailable)', async (t) => {
    if (!ollamaReady) {
      t.skip('Ollama not available — skipping semantic_search_all entry-shape test');
      return;
    }

    const res = await handlers.semantic_search_all({ query: 'alpha vault content' });
    const data = payload(res, 'semantic_search_all entry shape');

    if (data.results.length === 0) {
      // No indexed content — valid but unverifiable beyond shape
      assert.equal(data.vaultsIndexed, 0, 'if no results, vaultsIndexed should be 0');
      return;
    }

    const first = data.results[0];
    assert.equal(typeof first.vault, 'string', 'result.vault is a string');
    assert.equal(typeof first.path, 'string', 'result.path is a string');
    assert.equal(typeof first.title, 'string', 'result.title is a string');
    assert.equal(typeof first.similarity, 'number', 'result.similarity is a number');
    assert.ok(first.similarity >= 0 && first.similarity <= 1, 'similarity is in [0,1]');
    assert.equal(typeof first.preview, 'string', 'result.preview is a string');
  });

  test('results are sorted by similarity descending (skip if Ollama unavailable)', async (t) => {
    if (!ollamaReady) {
      t.skip('Ollama not available — skipping semantic_search_all sort-order test');
      return;
    }

    const res = await handlers.semantic_search_all({ query: 'alpha vault content', limit: 5 });
    const data = payload(res, 'semantic_search_all sort order');

    if (data.results.length < 2) return; // Not enough results to verify ordering

    for (let i = 1; i < data.results.length; i++) {
      assert.ok(
        data.results[i - 1].similarity >= data.results[i].similarity,
        `results should be sorted descending — position ${i - 1} (${data.results[i - 1].similarity}) >= position ${i} (${data.results[i].similarity})`,
      );
    }
  });

  test('returns error-like response when Ollama is not available (skip if it is available)', async (t) => {
    if (ollamaReady) {
      t.skip('Ollama IS available — skipping unavailable-path test');
      return;
    }

    // With Ollama unavailable, the handler should return isError:true (not throw)
    const res = await handlers.semantic_search_all({ query: 'anything' });
    assert.equal(typeof res, 'object', 'response is an object');
    assert.ok(Array.isArray(res.content), 'content is an array');
    // The error message should reference Ollama
    assert.ok(
      res.isError === true || (typeof res.content[0].text === 'string' && res.content[0].text.toLowerCase().includes('ollama')),
      `expected error about Ollama unavailability — got: ${res.content[0]?.text}`,
    );
  });
});
