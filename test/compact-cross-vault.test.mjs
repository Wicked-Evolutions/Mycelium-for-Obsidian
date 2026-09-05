import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactCrossVaultLinks } from '../dist/tools/compact-cross-vault.js';
import {
  DeclaredCrossVaultGraphBuilder,
  DECLARED_GRAPH_MAX_EDGES,
  DECLARED_GRAPH_MAX_SUBPATHS,
} from '../dist/graph/cross-vault.js';

const source = { vault: 'Source | biome', path: `Folder/${'Long identity '.repeat(40)}\u00e9.md` };
const target = { vault: 'Destination | biome', path: `Other/${'Full identity '.repeat(40)}e\u0301.md` };
const unresolvedLink = `${'Unresolved target '.repeat(50)}#Heading|display`;

function potentialLink(count = 8) {
  return {
    sourceVault: source.vault,
    sourcePath: source.path,
    unresolvedLink,
    potentialTargets: Array.from({ length: count }, (_, i) => ({
      vault: i % 3 === 0 ? target.vault : `Vault ${count - i}`,
      path: target.path,
    })),
  };
}

function uriRecord(overrides = {}) {
  return {
    status: 'noncanonical',
    sourceVault: source.vault,
    sourcePath: source.path,
    raw: `obsidian://open?file=${'verbose%20'.repeat(500)}&vault=Destination`,
    label: 'untrusted display label '.repeat(100),
    offset: 0,
    line: 1,
    column: 1,
    vault: target.vault,
    file: target.path,
    subpath: '#Unverified heading',
    canonicalUri: `obsidian://open?vault=Destination&file=${'repeated%20'.repeat(500)}`,
    relationshipType: 'cross_vault',
    destination: { ...target, exists: true },
    diagnostics: [{
      code: 'noncanonical_uri', severity: 'warning', message: 'Diagnostic prose '.repeat(100),
    }],
    ...overrides,
  };
}

function graphFixture(edgeCount = 1, subpathCount = 1) {
  const builder = new DeclaredCrossVaultGraphBuilder([source.vault, target.vault]);
  for (let edge = 0; edge < edgeCount; edge++) {
    for (let subpath = 0; subpath < subpathCount; subpath++) {
      builder.observe({
        status: subpath % 2 === 0 ? 'valid' : 'noncanonical',
        relationshipType: 'cross_vault',
        source: { vault: source.vault, path: `${edge}/${source.path}` },
        target: { ...target, exists: true },
        subpath: subpath === 0 ? undefined : `#Heading ${subpath}`,
        diagnostics: [], physicalVaultAlias: false,
      });
    }
  }
  builder.observe({
    status: 'missing_destination', relationshipType: 'cross_vault', source,
    target: { ...target, exists: false },
    diagnostics: [{ severity: 'error' }], physicalVaultAlias: false,
  });
  return builder.build();
}

function fixture(overrides = {}) {
  return {
    totalPotentialLinks: 1,
    links: [potentialLink()],
    nativeUriInventory: {
      scannedVaults: [source.vault, target.vault],
      totalFound: 1, returnedCount: 1, maxReturned: 100, truncated: false,
      summary: { noncanonical: 1 },
      records: [uriRecord()],
    },
    declaredCrossVaultGraph: graphFixture(),
    ...overrides,
  };
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function without(object, field) {
  const copy = { ...object };
  delete copy[field];
  return copy;
}

for (const count of [0, 1, 5, 6, 200]) {
  test(`potential target count ${count} retains first five occurrences with exact metadata`, () => {
    const link = potentialLink(count);
    const result = compactCrossVaultLinks(fixture({ links: [link] })).links[0];
    assert.equal(result.sourceVault, link.sourceVault);
    assert.equal(result.sourcePath, link.sourcePath);
    assert.equal(result.unresolvedLink, link.unresolvedLink);
    assert.deepEqual(result.potentialTargets, link.potentialTargets.slice(0, 5));
    assert.deepEqual(result.potentialTargetsMetadata, {
      total: count, returned: Math.min(count, 5), truncated: count > 5, has_more: count > 5,
    });
    assert.equal('destination' in result, false, 'candidates are not promoted to validated destinations');
    assert.equal('type' in result, false, 'candidates are not promoted to graph declarations');
  });
}

test('native records preserve source coordinates, target identity, relationship and diagnostic severity', () => {
  const records = [
    uriRecord(),
    uriRecord({
      status: 'missing_destination', offset: 21, line: 2, column: 5,
      destination: { ...target, exists: false },
      diagnostics: [
        { code: 'noncanonical_uri', severity: 'warning', message: 'Warning prose' },
        { code: 'missing_destination', severity: 'error', message: 'Error prose' },
        { code: 'missing_destination', severity: 'error', message: 'Duplicate diagnostic' },
      ],
    }),
    uriRecord({ status: 'same_vault_reference', relationshipType: 'same_vault' }),
    uriRecord({
      status: 'malformed', relationshipType: 'unknown', vault: undefined,
      file: undefined, destination: undefined, diagnostics: [],
    }),
  ];
  const input = fixture();
  input.nativeUriInventory.records = records;
  const result = compactCrossVaultLinks(input).nativeUriInventory.records;
  assert.equal(result.length, records.length);
  records.forEach((record, i) => {
    const { raw, canonicalUri, label, diagnostics, ...preserved } = record;
    assert.deepEqual(result[i], {
      ...preserved, diagnostics: diagnostics.map(({ code, severity }) => ({ code, severity })),
    });
    assert.equal('raw' in result[i], false);
    assert.equal('canonicalUri' in result[i], false);
    assert.equal('label' in result[i], false);
    assert.ok(result[i].diagnostics.every(diagnostic => !('message' in diagnostic)));
  });
  assert.equal(result[0].offset, 0, 'zero-based offset is not dropped');
  assert.equal(result[1].destination.exists, false, 'missing target is not marked resolved');
  assert.equal(result[3].destination, undefined, 'an unresolved target is never invented');
});

test('all native validation statuses and inventory caveats pass through unchanged', () => {
  const statuses = [
    'valid', 'noncanonical', 'malformed', 'unsupported', 'unknown_vault',
    'ambiguous_vault', 'invalid_path', 'missing_destination', 'same_vault_reference',
  ];
  const input = fixture();
  input.nativeUriInventory = {
    ...input.nativeUriInventory,
    totalFound: statuses.length, returnedCount: statuses.length,
    summary: Object.fromEntries(statuses.map(status => [status, 1])),
    destinationValidation: 'configured_vault_exact_path', subpathValidation: 'not_performed',
    records: statuses.map(status => uriRecord({
      status, subpathValidation: 'not_performed',
      diagnostics: [{ code: status, severity: 'error', message: 'Omitted prose' }],
    })),
  };
  const result = compactCrossVaultLinks(input);
  assert.deepEqual(without(result.nativeUriInventory, 'records'), without(input.nativeUriInventory, 'records'));
  assert.deepEqual(result.nativeUriInventory.records.map(record => record.status), statuses);
  assert.ok(result.nativeUriInventory.records.every(record => record.subpathValidation === 'not_performed'));
});

test('graph compaction retains full edge identity, declaration counts and exact unique subpath totals', () => {
  const input = fixture({ declaredCrossVaultGraph: graphFixture(3, DECLARED_GRAPH_MAX_SUBPATHS + 7) });
  const graph = input.declaredCrossVaultGraph;
  graph.edges.reverse();
  const result = compactCrossVaultLinks(input).declaredCrossVaultGraph;
  assert.deepEqual(without(result, 'edges'), without(graph, 'edges'));
  assert.deepEqual(result.edges, graph.edges.map(edge => ({
    type: edge.type, source: edge.source, target: edge.target,
    declarations: edge.declarations, subpaths: { totalUnique: DECLARED_GRAPH_MAX_SUBPATHS + 7 },
  })));
  assert.equal(result.subpathValidation, 'not_performed');
  assert.equal(result.authority, 'source_note_declaration');
  assert.equal(result.rankingApplied, false);
  assert.ok(result.edges.every(edge => !('canonicalUri' in edge)));
  assert.ok(result.edges.every(edge => !('values' in edge.subpaths)));
});

test('duplicate links, candidates, URI occurrences and edges are never deduplicated or sorted', () => {
  const input = fixture();
  const link = potentialLink(8);
  input.links = [link, { ...link, sourceVault: 'Earlier alphabetically' }, link];
  const record = uriRecord();
  input.nativeUriInventory.records = [record, uriRecord({ offset: 4 }), record];
  const edge = input.declaredCrossVaultGraph.edges[0];
  input.declaredCrossVaultGraph.edges = [edge, { ...edge, source: target, target: source }, edge];
  const result = compactCrossVaultLinks(input);
  assert.deepEqual(result.links.map(row => row.sourceVault), input.links.map(row => row.sourceVault));
  assert.deepEqual(result.links[0].potentialTargets, link.potentialTargets.slice(0, 5));
  assert.deepEqual(result.links[0].potentialTargets[0], result.links[0].potentialTargets[3]);
  assert.deepEqual(result.nativeUriInventory.records.map(row => row.offset), [0, 4, 0]);
  assert.deepEqual(result.declaredCrossVaultGraph.edges.map(row => [row.source, row.target]),
    input.declaredCrossVaultGraph.edges.map(row => [row.source, row.target]));
});

test('saturated nested fixtures preserve global counts and exclusions without mutating frozen input', () => {
  const input = fixture({
    totalPotentialLinks: 83,
    links: Array.from({ length: 50 }, () => potentialLink(45)),
    declaredCrossVaultGraph: graphFixture(DECLARED_GRAPH_MAX_EDGES + 5, DECLARED_GRAPH_MAX_SUBPATHS + 5),
  });
  input.nativeUriInventory = {
    ...input.nativeUriInventory,
    totalFound: 301, returnedCount: 100, truncated: true,
    summary: { noncanonical: 301 },
    records: Array.from({ length: 100 }, (_, offset) => uriRecord({ offset })),
  };
  const before = structuredClone(input);
  freeze(input);
  const result = compactCrossVaultLinks(input);
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
  assert.notEqual(result.links, input.links);
  assert.notEqual(result.nativeUriInventory.records, input.nativeUriInventory.records);
  assert.notEqual(result.declaredCrossVaultGraph.edges, input.declaredCrossVaultGraph.edges);
  assert.equal(result.totalPotentialLinks, 83);
  assert.equal(result.links.length, 50);
  assert.ok(result.links.every(link => link.potentialTargets.length === 5));
  assert.deepEqual(without(result.nativeUriInventory, 'records'), without(input.nativeUriInventory, 'records'));
  assert.deepEqual(without(result.declaredCrossVaultGraph, 'edges'), without(input.declaredCrossVaultGraph, 'edges'));
  assert.equal(result.declaredCrossVaultGraph.edges.length, DECLARED_GRAPH_MAX_EDGES);
  assert.equal(result.declaredCrossVaultGraph.totalUniqueEdges, DECLARED_GRAPH_MAX_EDGES + 5);
  assert.equal(result.declaredCrossVaultGraph.excluded.byStatus.missing_destination, 1);
  assert.ok(result.links.every(link => link.sourcePath === source.path && link.unresolvedLink === unresolvedLink));
  assert.ok(result.nativeUriInventory.records.every(record => record.destination.path === target.path));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(input)) / 2);
});

test('empty collections stay empty without invented diagnostics or changed authority', () => {
  const input = fixture({ totalPotentialLinks: 0, links: [], declaredCrossVaultGraph: graphFixture(0) });
  input.nativeUriInventory = {
    scannedVaults: [], totalFound: 0, returnedCount: 0, maxReturned: 100,
    truncated: false, summary: {}, records: [],
  };
  const result = compactCrossVaultLinks(input);
  assert.deepEqual(result, input);
});

test('projection errors propagate unchanged instead of fabricating an empty success', () => {
  const failure = new Error('Inventory scan failed');
  const input = fixture();
  Object.defineProperty(input, 'nativeUriInventory', { enumerable: true, get: () => { throw failure; } });
  assert.throws(() => compactCrossVaultLinks(input), error => error === failure);
});
