import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import * as realFs from 'node:fs/promises';
import { cleanup, createTempVault } from './helpers.mjs';

const readFailures = new Set([
  '00-SearchReadFail.md',
  '00-LinkReadFail.md',
  '00-CrossReadFail.md',
]);
const parserReadFailures = new Set([
  '00-QueryParseFail.md',
  '00-StaleParseFail.md',
]);

await mock.module('fs/promises', {
  namedExports: {
    ...realFs,
    readdir: async (target, options) => {
      if (path.basename(String(target)).endsWith('UnreadableDir')) {
        throw Object.assign(new Error('injected directory failure'), { code: 'EACCES' });
      }
      const entries = await realFs.readdir(target, options);
      return entries.sort((left, right) => {
        const leftName = typeof left === 'string' ? left : left.name;
        const rightName = typeof right === 'string' ? right : right.name;
        return leftName.localeCompare(rightName);
      });
    },
    readFile: async (target, options) => {
      if (readFailures.has(path.basename(String(target)))) {
        throw Object.assign(new Error('injected read failure'), { code: 'EACCES' });
      }
      return realFs.readFile(target, options);
    },
    open: async (target, flags, mode) => {
      const handle = await realFs.open(target, flags, mode);
      if (!parserReadFailures.has(path.basename(String(target)))) return handle;
      return {
        stat: handle.stat.bind(handle),
        readFile: async () => {
          throw Object.assign(new Error('injected parser read failure'), { code: 'EACCES' });
        },
        close: handle.close.bind(handle),
      };
    },
    stat: async (target, options) => {
      if (path.basename(String(target)) === '00-NoMetadata.md') {
        throw Object.assign(new Error('injected stat failure'), { code: 'EIO' });
      }
      const stats = await realFs.stat(target, options);
      if (path.basename(String(target)) === '00-Oversized.md') {
        return { ...stats, size: 50 * 1024 * 1024 + 1 };
      }
      return stats;
    },
  },
});

const { loadConfig } = await import('../dist/config.js');
const { createFileHandlers } = await import('../dist/tools/files.js');
const { createQueryHandlers } = await import('../dist/tools/query.js');
const { createAnalyticsHandlers } = await import('../dist/tools/analytics.js');
const { createCrossVaultHandlers } = await import('../dist/tools/crossvault.js');
const metadata = await import('../dist/result-metadata.js');

const vaultsToClean = [];

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  for (const vault of vaultsToClean) cleanup(vault);
});

function configFor(vaults) {
  process.env.OBSIDIAN_VAULTS = JSON.stringify(vaults);
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  return loadConfig();
}

function makeVault(files) {
  const vault = createTempVault(files);
  vaultsToClean.push(vault);
  return vault;
}

function payload(response) {
  assert.equal(response.isError, false, response.content[0]?.text);
  return JSON.parse(response.content[0].text);
}

test('metadata helper keeps exact fields atomic and partial reasons bounded', () => {
  assert.deepEqual(metadata.exactResultMetadata(5, 2), {
    total: 5,
    returned: 2,
    truncated: true,
    has_more: true,
  });
  assert.deepEqual(metadata.exactResultMetadata(2, 2), {
    total: 2,
    returned: 2,
    truncated: false,
    has_more: false,
  });
  assert.throws(() => metadata.exactResultMetadata(1, 2), RangeError);
  assert.throws(() => metadata.exactResultMetadata(-1, 0), RangeError);
  assert.deepEqual(metadata.limitReachedMetadata(false), {});
  assert.deepEqual(metadata.limitReachedMetadata(true), { limit_reached: true });

  const partial = metadata.partialCompletenessMetadata(3, 4, [
    'file_unreadable',
    'file_unreadable',
    'not-an-allowed-reason',
    'directory_unavailable',
  ]);
  assert.deepEqual(partial, {
    completeness: {
      state: 'partial',
      scanned: 3,
      skipped: 4,
      reasons: ['file_unreadable', 'directory_unavailable'],
    },
  });

  const bounded = metadata.partialCompletenessMetadata(1, 9, [
    'directory_unavailable',
    'file_metadata_unavailable',
    'file_unreadable',
    'file_unparseable',
    'file_too_large',
    'vault_unavailable',
    'vault_unindexed',
    'vault_search_failed',
    'scan_failure',
  ]);
  assert.equal(bounded.completeness.reasons.length, 8);
  assert.deepEqual(bounded.completeness.reasons, [
    'directory_unavailable',
    'file_metadata_unavailable',
    'file_unreadable',
    'file_unparseable',
    'file_too_large',
    'vault_unavailable',
    'vault_unindexed',
    'vault_search_failed',
  ]);
});

test('search_content distinguishes exact-at-limit, a qualifying sentinel, and scan failures', async () => {
  const exactVault = makeVault({
    '10-One.md': 'needle',
    '20-Two.md': 'needle',
    '30-No.md': 'other',
  });
  const exactHandlers = createFileHandlers(configFor({ Exact: exactVault }));
  const exact = payload(await exactHandlers.search_content({
    vault: 'Exact', query: 'needle', maxResults: 2,
  }));
  assert.deepEqual(
    { total: exact.total, returned: exact.returned, truncated: exact.truncated, has_more: exact.has_more },
    { total: 2, returned: 2, truncated: false, has_more: false },
  );
  assert.equal('limit_reached' in exact, false);

  const partialVault = makeVault({
    '00-SearchReadFail.md': 'needle',
    '00-NoMetadata.md': 'needle',
    '00-Oversized.md': 'needle',
    '00-UnreadableDir/Hidden.md': 'needle',
    '10-One.md': 'needle',
    '20-Two.md': 'needle',
    '30-Three.md': 'needle',
  });
  const partialHandlers = createFileHandlers(configFor({ Partial: partialVault }));
  const partial = payload(await partialHandlers.search_content({
    vault: 'Partial', query: 'needle', maxResults: 1,
  }));
  assert.equal(partial.resultCount, 1);
  assert.equal(partial.limit_reached, true);
  assert.equal('total' in partial, false);
  assert.deepEqual(partial.completeness, {
    state: 'partial',
    scanned: 2,
    skipped: 4,
    reasons: [
      'file_metadata_unavailable',
      'file_too_large',
      'file_unreadable',
      'directory_unavailable',
    ],
  });

  const noLimitVault = makeVault({
    '00-SearchReadFail.md': 'needle',
    '10-One.md': 'needle',
  });
  const noLimitHandlers = createFileHandlers(configFor({ PartialOnly: noLimitVault }));
  const partialOnly = payload(await noLimitHandlers.search_content({
    vault: 'PartialOnly', query: 'needle', maxResults: 10,
  }));
  assert.equal('limit_reached' in partialOnly, false);
  assert.equal(partialOnly.completeness.state, 'partial');

  const fractionalVault = makeVault({
    '10-One.md': 'needle',
    '20-Two.md': 'needle',
    '30-Three.md': 'needle',
  });
  const fractionalHandlers = createFileHandlers(configFor({ Fractional: fractionalVault }));
  const fractional = payload(await fractionalHandlers.search_content({
    vault: 'Fractional', query: 'needle', maxResults: 1.5,
  }));
  assert.equal(fractional.resultCount, 2);
  assert.deepEqual(fractional.results.map(row => row.path), ['10-One.md', '20-Two.md']);
  assert.equal(fractional.limit_reached, true);
});

test('single-vault scanner roots remain errors while descendant failures are partial', async () => {
  const vault = makeVault({
    '00-AnalyticsUnreadableDir/Hidden.md': '[[Hidden]]',
    '00-NoMetadata.md': '[[NoMetadata]]',
    '10-Good.md': '[[Missing]]',
  });
  const config = configFor({ RootErrors: vault });
  const fileHandlers = createFileHandlers(config);
  const missingSearch = await fileHandlers.search_content({
    vault: 'RootErrors', query: 'needle', directory: 'does-not-exist',
  });
  assert.equal(missingSearch.isError, true);

  const analyticsHandlers = createAnalyticsHandlers(config);
  const partial = payload(await analyticsHandlers.get_broken_links({
    vault: 'RootErrors', limit: 10,
  }));
  assert.deepEqual(partial.completeness, {
    state: 'partial',
    scanned: 1,
    skipped: 2,
    reasons: ['directory_unavailable', 'file_metadata_unavailable'],
  });

  const missingConfig = configFor({ MissingAnalytics: path.join(vault, 'missing-vault-root') });
  const missingAnalytics = await createAnalyticsHandlers(missingConfig)
    .get_vault_health({ vault: 'MissingAnalytics' });
  assert.equal(missingAnalytics.isError, true);
});

test('query_notes preserves observed compatibility counts and withholds exact totals after parse or subtree failure', async () => {
  const vault = makeVault({
    '00-QueryParseFail.md': '---\n: invalid\n---\n',
    '00-UnreadableDir/Hidden.md': '---\ntype: PROJECT\n---\n',
    '10-One.md': '---\ntype: PROJECT\n---\n# One',
    '20-Two.md': '---\ntype: PROJECT\n---\n# Two',
  });
  const handlers = createQueryHandlers(configFor({ Query: vault }));
  const result = payload(await handlers.query_notes({
    vault: 'Query',
    where: [{ field: 'type', op: 'equals', value: 'PROJECT' }],
    limit: 1,
  }));
  assert.equal(result.totalMatches, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.limit_reached, true);
  assert.equal('total' in result, false);
  assert.deepEqual(result.completeness, {
    state: 'partial',
    scanned: 2,
    skipped: 2,
    reasons: ['directory_unavailable', 'file_unparseable'],
  });
});

test('analytics exposes component metadata and counts a valid stale fallback as scanned', async () => {
  const vault = makeVault({
    '00-LinkReadFail.md': '[[Missing-A]]',
    '00-StaleParseFail.md': '---\n: invalid\n---\n# fallback title',
    '10-Good.md': '[[Missing-B]]',
  });
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  fsSync.utimesSync(path.join(vault, '00-StaleParseFail.md'), old, old);
  fsSync.utimesSync(path.join(vault, '10-Good.md'), old, old);
  const handlers = createAnalyticsHandlers(configFor({ Analytics: vault }));

  const broken = payload(await handlers.get_broken_links({ vault: 'Analytics', limit: 1 }));
  assert.equal(broken.completeness.state, 'partial');
  assert.equal(broken.completeness.skipped, 1);
  assert.equal('total' in broken.resultMetadata.brokenLinks, false);

  const staleFallback = payload(await handlers.get_stale_notes({
    vault: 'Analytics', days: 90, limit: 10,
  }));
  assert.equal('completeness' in staleFallback, false);
  assert.equal(staleFallback.total, 2);
  assert.ok(staleFallback.staleNotes.some(note => note.path === '00-StaleParseFail.md'));

  const staleFractional = payload(await handlers.get_stale_notes({
    vault: 'Analytics', days: 90, limit: 1.5,
  }));
  assert.equal(staleFractional.staleNotes.length, 2);

  const staleFiltered = payload(await handlers.get_stale_notes({
    vault: 'Analytics', days: 90, type_filter: 'PROJECT', limit: 10,
  }));
  assert.ok(staleFiltered.completeness, JSON.stringify(staleFiltered));
  assert.equal(staleFiltered.completeness.state, 'partial');
  assert.equal(staleFiltered.completeness.skipped, 1);
  assert.deepEqual(staleFiltered.completeness.reasons, ['file_unparseable']);

  const health = payload(await handlers.get_vault_health({ vault: 'Analytics', stale_days: 90 }));
  assert.equal(health.completeness.state, 'partial');
  assert.equal('total' in health.resultMetadata.topBrokenLinks, false);
  assert.equal(typeof health.resultMetadata.topStaleNotes.total, 'number');
});

test('analytics never resolves a wikilink through an external Markdown symlink', {
  skip: process.platform === 'win32',
}, async () => {
  const vault = makeVault({
    'Folder/Source.md': '[[Outside]]',
  });
  const outside = makeVault({
    'Outside.md': '# Outside',
  });
  fsSync.symlinkSync(
    path.join(outside, 'Outside.md'),
    path.join(vault, 'Folder', 'Outside.md'),
  );

  const handlers = createAnalyticsHandlers(configFor({ Symlink: vault }));
  const broken = payload(await handlers.get_broken_links({ vault: 'Symlink', limit: 10 }));
  assert.ok(broken.brokenLinks.some(link => (
    link.source === 'Folder/Source.md' && link.target === 'Outside'
  )));
});

test('search_all_vaults isolates vault failures and requires a matching sentinel', async () => {
  const good = makeVault({
    '00-CrossReadFail.md': 'needle',
    '10-One.md': 'needle',
    '20-Two.md': 'needle',
    '30-Three.md': 'needle',
    '40-No.md': 'other',
  });
  const missing = path.join(good, 'does-not-exist');
  const handlers = createCrossVaultHandlers(configFor({ Good: good, Missing: missing }));
  const result = payload(await handlers.search_all_vaults({
    query: 'needle', maxResultsPerVault: 1,
  }));

  assert.equal(result.totalResults, 1);
  assert.equal(result.limit_reached, true);
  assert.equal(result.completeness.state, 'partial');
  assert.deepEqual(result.completeness.reasons, ['file_unreadable', 'vault_unavailable']);
  const goodResult = result.results.find(entry => entry.vault === 'Good');
  const missingResult = result.results.find(entry => entry.vault === 'Missing');
  assert.equal(goodResult.limit_reached, true);
  assert.equal(goodResult.completeness.state, 'partial');
  assert.equal(missingResult.completeness.state, 'partial');
  assert.equal(missingResult.completeness.reasons[0], 'vault_unavailable');

  const fractional = payload(await handlers.search_all_vaults({
    query: 'needle', maxResultsPerVault: 1.5,
  }));
  const fractionalGood = fractional.results.find(entry => entry.vault === 'Good');
  assert.deepEqual(fractionalGood.results.map(row => row.path), ['10-One.md', '20-Two.md']);
  assert.equal(fractionalGood.limit_reached, true);
});
