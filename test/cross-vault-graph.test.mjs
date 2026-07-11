import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeclaredCrossVaultGraphBuilder,
  DECLARED_GRAPH_MAX_EDGES,
  DECLARED_GRAPH_MAX_SUBPATHS,
  normalizeVaultRelativePath,
} from '../dist/graph/cross-vault.js';
import { FilesystemProvider, buildVaultGraph } from '../dist/graph/index.js';
import { createTempVault, cleanup } from './helpers.mjs';

function observation(overrides = {}) {
  return {
    status: 'valid',
    relationshipType: 'cross_vault',
    source: { vault: 'Source', path: 'From.md' },
    target: { vault: 'Destination', path: 'Folder/Target.md', exists: true },
    diagnostics: [],
    physicalVaultAlias: false,
    ...overrides,
  };
}

test('aggregates canonical/noncanonical declarations into one note-level edge', () => {
  const builder = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  builder.observe(observation());
  builder.observe(observation({ status: 'noncanonical', subpath: 'Heading' }));
  builder.observe(observation({ subpath: '^block' }));

  const graph = builder.build();
  assert.equal(graph.totalObservedDeclarations, 3);
  assert.equal(graph.totalEligibleDeclarations, 3);
  assert.equal(graph.totalUniqueEdges, 1);
  assert.equal(graph.rankingApplied, false);
  assert.equal(graph.observationProvider, 'filesystem');
  assert.equal(graph.subpathValidation, 'not_performed');
  assert.deepEqual(graph.vaultBoundaries, ['Destination', 'Source']);

  const [edge] = graph.edges;
  assert.deepEqual(edge.source, { vault: 'Source', path: 'From.md' });
  assert.deepEqual(edge.target, { vault: 'Destination', path: 'Folder/Target.md' });
  assert.equal(edge.canonicalUri, 'obsidian://open?vault=Destination&file=Folder%2FTarget');
  assert.deepEqual(edge.declarations, { total: 3, canonical: 2, noncanonical: 1 });
  assert.deepEqual(edge.subpaths.values, [
    { subpath: null, count: 1 },
    { subpath: 'Heading', count: 1 },
    { subpath: '^block', count: 1 },
  ]);
});

test('excludes every ineligible status and physical-vault aliases with exact counts', () => {
  const builder = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  for (const status of [
    'malformed', 'unsupported', 'unknown_vault', 'ambiguous_vault',
    'invalid_path', 'missing_destination', 'same_vault_reference',
  ]) {
    builder.observe(observation({ status }));
  }
  builder.observe(observation({ diagnostics: [{ severity: 'error' }] }));
  builder.observe(observation({ physicalVaultAlias: true }));
  builder.observe(observation({ physicalIdentityUnavailable: true }));
  builder.observe(observation({ sourceVaultAmbiguous: true }));

  const graph = builder.build();
  assert.equal(graph.totalObservedDeclarations, 11);
  assert.equal(graph.totalEligibleDeclarations, 0);
  assert.equal(graph.totalUniqueEdges, 0);
  assert.equal(graph.excluded.total, 11);
  assert.deepEqual(graph.excluded.byStatus, {
    ambiguous_vault: 1,
    error_diagnostic: 1,
    invalid_path: 1,
    malformed: 1,
    missing_destination: 1,
    physical_identity_unavailable: 1,
    physical_vault_alias: 1,
    same_vault_reference: 1,
    source_vault_ambiguous: 1,
    unknown_vault: 1,
    unsupported: 1,
  });
});

test('normalizes Windows-native relative paths without changing POSIX names', () => {
  assert.equal(normalizeVaultRelativePath('Folder\\Nested\\Note.md', '\\'), 'Folder/Nested/Note.md');
  assert.equal(normalizeVaultRelativePath('Folder/Note.md', '/'), 'Folder/Note.md');
  assert.equal(normalizeVaultRelativePath('Literal\\Name.md', '/'), 'Literal\\Name.md');
});

test('full-scan composition is independent from diagnostic-record caps', () => {
  const builder = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  for (let i = 0; i < 100; i++) builder.observe(observation({ status: 'malformed' }));
  builder.observe(observation());
  const graph = builder.build();
  assert.equal(graph.totalObservedDeclarations, 101);
  assert.equal(graph.totalEligibleDeclarations, 1);
  assert.equal(graph.totalUniqueEdges, 1);
  assert.equal(graph.excluded.byStatus.malformed, 100);
});

test('bounds unique edges deterministically and reports exact totals', () => {
  const observations = Array.from({ length: DECLARED_GRAPH_MAX_EDGES + 1 }, (_, i) =>
    observation({
      source: { vault: 'Source', path: `From-${String(i).padStart(3, '0')}.md` },
      target: { vault: 'Destination', path: `Target-${String(i).padStart(3, '0')}.md`, exists: true },
    })
  );

  const first = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  const second = new DeclaredCrossVaultGraphBuilder(['Destination', 'Source']);
  for (const item of observations) first.observe(item);
  for (const item of [...observations].reverse()) second.observe(item);

  const a = first.build();
  const b = second.build();
  assert.deepEqual(a, b);
  assert.equal(a.totalUniqueEdges, DECLARED_GRAPH_MAX_EDGES + 1);
  assert.equal(a.returnedEdges, DECLARED_GRAPH_MAX_EDGES);
  assert.equal(a.truncated, true);
});

test('one thousand duplicate declarations remain one logical edge', () => {
  const builder = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  for (let i = 0; i < 1000; i++) builder.observe(observation());
  const graph = builder.build();
  assert.equal(graph.totalEligibleDeclarations, 1000);
  assert.equal(graph.totalUniqueEdges, 1);
  assert.equal(graph.edges[0].declarations.total, 1000);
});

test('identical relative paths in different vaults remain distinct identities', () => {
  const builder = new DeclaredCrossVaultGraphBuilder(['A', 'B', 'C']);
  builder.observe(observation({
    source: { vault: 'A', path: 'Alpha.md' },
    target: { vault: 'B', path: 'Alpha.md', exists: true },
  }));
  builder.observe(observation({
    source: { vault: 'C', path: 'Alpha.md' },
    target: { vault: 'B', path: 'Alpha.md', exists: true },
  }));
  const graph = builder.build();
  assert.equal(graph.totalUniqueEdges, 2);
  assert.deepEqual(graph.edges.map(edge => edge.source.vault), ['A', 'C']);
  assert.ok(!JSON.stringify(graph).includes('/Users/'));
});

test('bounds subpath metadata deterministically while retaining exact totals', () => {
  const observations = Array.from({ length: DECLARED_GRAPH_MAX_SUBPATHS + 1 }, (_, i) =>
    observation({ subpath: `Heading-${String(i).padStart(2, '0')}` })
  );
  const forward = new DeclaredCrossVaultGraphBuilder(['Source', 'Destination']);
  const reverse = new DeclaredCrossVaultGraphBuilder(['Destination', 'Source']);
  for (const item of observations) forward.observe(item);
  for (const item of [...observations].reverse()) reverse.observe(item);

  const a = forward.build().edges[0].subpaths;
  const b = reverse.build().edges[0].subpaths;
  assert.deepEqual(a, b);
  assert.equal(a.totalUnique, DECLARED_GRAPH_MAX_SUBPATHS + 1);
  assert.equal(a.returned, DECLARED_GRAPH_MAX_SUBPATHS);
  assert.equal(a.truncated, true);
});

test('native BaseGraph is unchanged by obsidian open URI declarations', async () => {
  const withoutUri = createTempVault({
    'Source.md': 'Native edge: [[Local Target]]',
    'Local Target.md': 'Target',
  });
  const withUri = createTempVault({
    'Source.md': [
      'Native edge: [[Local Target]]',
      '[Remote](obsidian://open?vault=Destination&file=Folder%2FRemote)',
    ].join('\n'),
    'Local Target.md': 'Target',
  });

  try {
    const provider = new FilesystemProvider();
    const baseline = await buildVaultGraph(withoutUri, provider);
    const declared = await buildVaultGraph(withUri, provider);
    const shape = graph => ({
      nodes: [...graph.nodes].sort(),
      edges: graph.edges
        .map(edge => [edge.source, edge.target, edge.count])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      inDegree: [...graph.inDegree].sort(),
      outDegree: [...graph.outDegree].sort(),
    });
    assert.deepEqual(shape(declared), shape(baseline));
  } finally {
    cleanup(withoutUri);
    cleanup(withUri);
  }
});
