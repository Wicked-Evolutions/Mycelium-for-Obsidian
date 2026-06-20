/**
 * L4 graph layer — synthetic-topology + behaviour tests.
 *
 * Exercises the PROVIDER-AGNOSTIC pipeline through the filesystem provider on a
 * synthetic temp vault (no dependency on the real iCloud vault):
 *   - real-spine nodes (a hub linked by many)
 *   - a dense generated cluster with an excludable `_manifest`-analog
 *   - unresolved links, duplicate links, heading/block links, embeds
 *
 * Asserts the BEHAVIOUR: the spine lands in the top bands; the generated cluster
 * is demoted via the `exclude` predicate; defaults are echoed via activeExclude;
 * the WikiLink additive-field contract holds.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

const { loadConfig } = await import('../dist/config.js');
const { createAllHandlers } = await import('../dist/tools/index.js');
const graphMod = await import('../dist/graph/index.js');
const { extractWikilinks } = await import('../dist/parsers/wikilink.js');

// ---------------------------------------------------------------------------
// Synthetic vault topology
// ---------------------------------------------------------------------------
function buildVault() {
  const files = {};
  // Spine: a hub heavily linked by leaves; one mid-tier node linked by some leaves.
  files['Hub.md'] = '# Hub\nReferences [[Mid]] and [[Missing Note]].';
  files['Mid.md'] = '# Mid\nLinks back to [[Hub]] and [[Hub#Intro]].';
  // Many leaves all linking to Hub — gives Hub high in-degree/PageRank.
  for (const leaf of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']) {
    files[`${leaf}.md`] =
      // duplicate link + heading link + an embed, all crediting Hub
      `See [[Hub]] and again [[Hub]] plus [[Hub#Section]] and embed ![[Hub]].\nAlso [[Mid]].`;
  }
  // A dense generated cluster with an excludable manifest analog (node_type: generated).
  files['gen/_wing_manifest.md'] =
    '---\nnode_type: generated\n---\n[[gen/g1]] [[gen/g2]] [[gen/g3]] [[gen/g4]]';
  for (const g of ['g1', 'g2', 'g3', 'g4']) {
    files[`gen/${g}.md`] =
      '---\nnode_type: generated\n---\n' +
      '[[gen/_wing_manifest]] [[gen/g1]] [[gen/g2]] [[gen/g3]] [[gen/g4]]';
  }
  return files;
}

function makeHandlers(vaultPath, disabled = 'eval_obsidian') {
  process.env.OBSIDIAN_VAULT_PATH = vaultPath;
  process.env.OBSIDIAN_DISABLED_TOOLS = disabled;
  delete process.env.OBSIDIAN_VAULTS;
  const config = loadConfig();
  return createAllHandlers(config);
}

function parse(res) {
  assert.equal(res.isError, false, `handler errored: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

// ---------------------------------------------------------------------------
// WikiLink additive contract (unit)
// ---------------------------------------------------------------------------
describe('WikiLink additive extraction contract', () => {
  test('legacy target/raw unchanged; new fields populated', () => {
    const links = extractWikilinks('A [[Note#Heading|alias]] and ![[Embed]] and [[V:Cross#blk]].');
    assert.equal(links.length, 3);

    const [a, b, c] = links;
    // Legacy fields byte-identical to historical semantics.
    assert.equal(a.raw, '[[Note#Heading|alias]]');
    assert.equal(a.target, 'Note#Heading'); // subpath RETAINED in target (legacy)
    assert.equal(a.alias, 'alias');
    // Additive fields.
    assert.equal(a.path, 'Note');           // subpath stripped LOCALLY in path
    assert.equal(a.subpath, 'Heading');
    assert.equal(a.isEmbed, false);
    assert.equal(a.vault, undefined);
    assert.equal(a.rawTarget, 'Note#Heading');

    // Embed.
    assert.equal(b.raw, '[[Embed]]');
    assert.equal(b.isEmbed, true);
    assert.equal(b.path, 'Embed');

    // Cross-vault: legacy target strips vault prefix (retains subpath).
    assert.equal(c.target, 'Cross#blk');
    assert.equal(c.vault, 'V');
    assert.equal(c.rawTarget, 'V:Cross#blk');
    assert.equal(c.path, 'Cross');
    assert.equal(c.subpath, 'blk');
  });
});

// ---------------------------------------------------------------------------
// PageRank unit (deterministic params)
// ---------------------------------------------------------------------------
describe('pageRank', () => {
  test('ratified defaults exist and sum ~= 1', () => {
    assert.equal(graphMod.PAGERANK_DEFAULTS.damping, 0.85);
    assert.equal(graphMod.PAGERANK_DEFAULTS.maxIterations, 20);
    assert.equal(graphMod.PAGERANK_DEFAULTS.tolerance, 1e-7);

    const nodes = ['a', 'b', 'c'];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'b' },
      { source: 'a', target: 'c' },
    ];
    const pr = graphMod.pageRank(nodes, edges);
    const sum = [...pr.values()].reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `pagerank should sum to ~1, got ${sum}`);
    // b has the most inbound → highest rank.
    assert.ok(pr.get('b') > pr.get('a'), 'most-linked node ranks highest');
    assert.ok(pr.get('b') > pr.get('c'), 'most-linked node ranks highest');
  });

  test('empty graph yields empty map', () => {
    assert.equal(graphMod.pageRank([], []).size, 0);
  });
});

// ---------------------------------------------------------------------------
// Leveling unit — band orientation (high PR → low level; leaf floor)
// ---------------------------------------------------------------------------
describe('assignLevels band orientation', () => {
  test('leaf floor (in-degree 0) is L5 regardless of PageRank', () => {
    const pr = new Map([['leaf', 0.9], ['hub', 0.1]]);
    const inDeg = new Map([['leaf', 0], ['hub', 5]]);
    const { levels } = graphMod.assignLevels(pr, inDeg);
    assert.equal(levels.get('leaf'), 5, 'zero in-degree node must be L5 (leaf floor)');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline behaviour
// ---------------------------------------------------------------------------
describe('analyze_link_hierarchy — synthetic topology (filesystem provider)', () => {
  let dir, h;

  before(() => {
    graphMod.clearGraphCaches();
    dir = createTempVault(buildVault());
    h = makeHandlers(dir);
  });

  after(() => {
    if (dir) cleanup(dir);
    graphMod.clearGraphCaches();
  });

  test('uses filesystem provider when eval_obsidian disabled', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.provider, 'filesystem');
  });

  test('default exclusion prunes the generated cluster and echoes activeExclude', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.usedDefaultExclude, true);
    // 5 generated nodes (manifest + g1..g4) pruned.
    assert.equal(p.excludedNodes, 5, `expected 5 excluded, got ${p.excludedNodes}`);
    // activeExclude echoes the OR default (both predicates).
    const fields = p.activeExclude.map((c) => c.field).sort();
    assert.deepEqual(fields, ['mycelium_exclude', 'node_type']);
    // No generated node appears in the ranked detail.
    const paths = p.nodes.map((n) => n.path);
    assert.ok(!paths.some((x) => x.startsWith('gen/')), 'generated cluster must be demoted/pruned');
  });

  test('the spine (Hub + Mid) lands in the top bands', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    const hub = p.nodes.find((n) => n.path === 'Hub.md');
    const mid = p.nodes.find((n) => n.path === 'Mid.md');
    assert.ok(hub && mid, 'Hub and Mid must be present in the ranked output');
    // Both spine nodes are top-band hubs (L0/L1), demoting nothing structural.
    assert.ok(hub.level <= 1, `Hub should be a top hub (L0/L1), got L${hub.level}`);
    assert.ok(mid.level <= 1, `Mid should be a top hub (L0/L1), got L${mid.level}`);
    // The two highest-PageRank ranked nodes are exactly the spine.
    const top2 = p.nodes.slice(0, 2).map((n) => n.path).sort();
    assert.deepEqual(top2, ['Hub.md', 'Mid.md'], 'spine occupies the top-2 by PageRank');
    assert.ok(hub.inDegree >= 8, `Hub should collect many inbound, got ${hub.inDegree}`);
  });

  test('embeds + duplicate + heading links all credit Hub via contributor edge counts', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    const hub = p.nodes.find((n) => n.path === 'Hub.md');
    const fromL1 = hub.topContributors.find((c) => c.source === 'L1.md');
    assert.ok(fromL1, 'L1 must be a contributor to Hub');
    // L1 links Hub 4x: [[Hub]] x2 + [[Hub#Section]] + ![[Hub]] (embed) → count 4.
    assert.equal(fromL1.edgeCount, 4, `expected 4 occurrences crediting Hub, got ${fromL1.edgeCount}`);
  });

  test('leaves with no inbound are L5 (leaf floor)', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    const l1 = p.nodes.find((n) => n.path === 'L1.md');
    assert.ok(l1, 'L1 present');
    assert.equal(l1.level, 5, 'leaf with zero inbound is L5');
  });

  test('excluded nodes can be surfaced with {where: []} (defaults off)', async () => {
    const p = parse(await h.analyze_link_hierarchy({ exclude: { where: [] } }));
    assert.equal(p.usedDefaultExclude, false);
    assert.equal(p.excludedNodes, 0, 'no exclusions when where:[] passed');
    const paths = p.nodes.map((n) => n.path);
    assert.ok(paths.some((x) => x.startsWith('gen/')), 'generated nodes ranked when defaults off');
  });

  test('custom exclude (AND semantics) prunes by frontmatter', async () => {
    const p = parse(
      await h.analyze_link_hierarchy({
        exclude: { where: [{ field: 'node_type', op: 'equals', value: 'generated' }] },
      })
    );
    assert.equal(p.usedDefaultExclude, false);
    assert.equal(p.excludedNodes, 5, 'all node_type:generated pruned');
    assert.deepEqual(p.activeExclude, [{ field: 'node_type', op: 'equals', value: 'generated' }]);
  });

  test('scope filters OUTPUT only, not ranking', async () => {
    const full = parse(await h.analyze_link_hierarchy({}));
    const scoped = parse(await h.analyze_link_hierarchy({ scope: 'Hub' }));
    // Ranking population is identical; only the returned detail is filtered.
    assert.equal(scoped.rankedNodes, full.rankedNodes, 'ranking uses whole graph regardless of scope');
    assert.ok(scoped.nodes.every((n) => n.path.startsWith('Hub')), 'scoped output only includes Hub*');
    assert.ok(scoped.nodes.length < full.nodes.length, 'scope narrows the output');
  });

  test('compact omits contributor breakdown', async () => {
    const p = parse(await h.analyze_link_hierarchy({ compact: true }));
    assert.ok(p.nodes.every((n) => n.topContributors === undefined), 'compact has no topContributors');
  });

  test('response carries the orientation note and level bands', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    assert.equal(p.note, 'levels are structural orientation, not importance.');
    assert.equal(p.levelBands.L0, '>= p99 (top hubs)');
    assert.equal(p.levelBands.L5, 'in-degree 0 (leaf floor)');
  });

  test('histogram counts sum to ranked + excluded', async () => {
    const p = parse(await h.analyze_link_hierarchy({}));
    const sum = p.histogram.reduce((s, b) => s + b.count, 0);
    assert.equal(sum, p.totalNodes, 'histogram (incl. excluded bucket) sums to total nodes');
  });
});

// ---------------------------------------------------------------------------
// getGraphSignals — reusable hook + two-tier cache
// ---------------------------------------------------------------------------
describe('getGraphSignals hook + cache', () => {
  let dir, config;

  before(() => {
    graphMod.clearGraphCaches();
    dir = createTempVault(buildVault());
    process.env.OBSIDIAN_VAULT_PATH = dir;
    process.env.OBSIDIAN_DISABLED_TOOLS = 'eval_obsidian';
    delete process.env.OBSIDIAN_VAULTS;
    config = loadConfig();
  });

  after(() => {
    if (dir) cleanup(dir);
    graphMod.clearGraphCaches();
  });

  test('returns a per-node signal map with excluded nodes nulled', async () => {
    const sig = await graphMod.getGraphSignals(config, undefined);
    const manifest = sig.signals.get('gen/_wing_manifest.md');
    assert.ok(manifest, 'manifest node present in base graph');
    assert.equal(manifest.excluded, true);
    assert.equal(manifest.pagerank, null, 'excluded node pagerank is null');
    assert.equal(manifest.level, null, 'excluded node level is null');
    // raw degree still comes from the base graph.
    assert.ok(manifest.outDegree > 0, 'excluded node keeps base-graph degree');
  });

  test('different exclude hashes produce different ranked results (no stale reuse)', async () => {
    const withDefault = await graphMod.getGraphSignals(config, undefined);
    const withNone = await graphMod.getGraphSignals(config, undefined, { where: [] });
    assert.notEqual(
      withDefault.excludedCount,
      withNone.excludedCount,
      're-rank with a new exclusion must not reuse unpruned signals'
    );
    assert.equal(withNone.excludedCount, 0);
  });
});
