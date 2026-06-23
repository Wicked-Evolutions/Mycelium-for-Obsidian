/**
 * getGraphSignals — the reusable, cache-backed interface consumed by
 * analyze_link_hierarchy (and, later, graph-aware search). Search itself is NOT
 * wired this pass — this is the hook.
 *
 * Two-tier session cache (in-memory, no persistence):
 *   (a) BASE graph   — keyed by `vault + graph-version (stat-digest)`.
 *                      Raw edges + degrees; exclusion-independent; built once.
 *   (b) RANKED signals — keyed by `vault + graph-version + exclude-hash`.
 *                      PageRank/levels per exclusion. The rank → declare-
 *                      exclusion → re-rank loop recomputes correctly and never
 *                      reuses unpruned signals.
 */

import { Config, resolveVault } from '../config.js';
import { BaseGraph, GraphSignals, NodeSignals } from './types.js';
import { buildVaultGraph } from './build.js';
import { selectProvider } from './providers.js';
import { computeGraphDigest, hashExclude } from './digest.js';
import { resolveExclude, computeExcludedSet, ExcludeInput } from './exclude.js';
import { pageRank } from './pagerank.js';
import { assignLevels } from './levels.js';

// ─── Caches (module-level, session-scoped) ───────────────────────────────────

interface BaseCacheEntry {
  digest: string;
  graph: BaseGraph;
}
const baseCache = new Map<string, BaseCacheEntry>(); // key: vaultPath

interface RankedCacheEntry {
  signals: GraphSignals;
}
const rankedCache = new Map<string, RankedCacheEntry>(); // key: vaultPath|digest|excludeHash

/**
 * Test/maintenance helper: clear all session caches.
 */
export function clearGraphCaches(): void {
  baseCache.clear();
  rankedCache.clear();
}

/**
 * Invalidate cached signals for a vault path (e.g. after a write-through MCP
 * mutation). The stat-digest would catch it on next read anyway; this is the
 * explicit hook.
 */
export function invalidateGraphCache(vaultPath: string): void {
  baseCache.delete(vaultPath);
  for (const key of [...rankedCache.keys()]) {
    if (key.startsWith(vaultPath + '|')) rankedCache.delete(key);
  }
}

/**
 * Get (or build) the BASE graph for a vault, cached by stat-digest.
 */
export async function getBaseGraph(
  config: Config,
  vaultName: string | undefined,
  vaultPath: string
): Promise<BaseGraph> {
  const digest = await computeGraphDigest(vaultPath);
  const cached = baseCache.get(vaultPath);
  if (cached && cached.digest === digest) {
    return cached.graph;
  }
  const provider = await selectProvider(config, vaultName);
  const graph = await buildVaultGraph(vaultPath, provider, config, vaultName);
  baseCache.set(vaultPath, { digest, graph });
  // Base graph changed → drop any ranked signals for the old digest.
  for (const key of [...rankedCache.keys()]) {
    if (key.startsWith(vaultPath + '|') && !key.startsWith(`${vaultPath}|${digest}|`)) {
      rankedCache.delete(key);
    }
  }
  return graph;
}

/**
 * getGraphSignals(vault, exclude?) — base graph + ranked signals with the
 * two-tier cache.
 */
export async function getGraphSignals(
  config: Config,
  vaultName?: string,
  exclude?: ExcludeInput
): Promise<GraphSignals> {
  const vault = resolveVault(config, vaultName);
  const vaultPath = vault.path;

  const digest = await computeGraphDigest(vaultPath);
  const excludeHash = hashExclude(exclude?.where);
  const rankedKey = `${vaultPath}|${digest}|${excludeHash}`;

  const cachedRanked = rankedCache.get(rankedKey);
  if (cachedRanked) return cachedRanked.signals;

  const graph = await getBaseGraph(config, vaultName, vaultPath);

  // Resolve exclusion predicate, prune.
  const resolved = resolveExclude(exclude);
  const excludedSet = await computeExcludedSet(vaultPath, graph.nodes, resolved);

  // Ranked node set = base nodes minus excluded.
  const rankedNodes = graph.nodes.filter((n) => !excludedSet.has(n));
  const rankedNodeSet = new Set(rankedNodes);

  // Edges among ranked nodes only (prune-before-rank).
  const prunedEdges = graph.edges.filter(
    (e) => rankedNodeSet.has(e.source) && rankedNodeSet.has(e.target)
  );

  // In-degree on the PRUNED graph (for leaf-floor detection in leveling).
  const prunedInDegree = new Map<string, number>();
  for (const n of rankedNodes) prunedInDegree.set(n, 0);
  // Deduplicate source→target before counting unique inbound.
  const seen = new Set<string>();
  for (const e of prunedEdges) {
    const k = `${e.source}\u0000${e.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    prunedInDegree.set(e.target, (prunedInDegree.get(e.target) || 0) + 1);
  }

  // PageRank on unique pruned edges.
  const uniqueEdges: Array<{ source: string; target: string }> = [];
  const edgeSeen = new Set<string>();
  for (const e of prunedEdges) {
    const k = `${e.source}\u0000${e.target}`;
    if (edgeSeen.has(k)) continue;
    edgeSeen.add(k);
    uniqueEdges.push({ source: e.source, target: e.target });
  }
  const pr = pageRank(rankedNodes, uniqueEdges);

  // Levels (leaf floor uses pruned in-degree).
  const { levels, smallVault } = assignLevels(pr, prunedInDegree);

  // Assemble per-node signals (every base node present).
  const signalsMap = new Map<string, NodeSignals>();
  for (const node of graph.nodes) {
    const baseIn = graph.inDegree.get(node) || 0;
    const baseOut = graph.outDegree.get(node) || 0;
    const inOutRatio = baseIn / Math.max(baseOut, 1);
    if (excludedSet.has(node)) {
      signalsMap.set(node, {
        level: null,
        inDegree: baseIn,
        outDegree: baseOut,
        inOutRatio,
        pagerank: null,
        archived: true,
        excluded: true
      });
    } else {
      signalsMap.set(node, {
        level: levels.get(node) ?? null,
        inDegree: baseIn,
        outDegree: baseOut,
        inOutRatio,
        pagerank: pr.get(node) ?? null,
        archived: false,
        excluded: false
      });
    }
  }

  const signals: GraphSignals = {
    vault: vault.name,
    provider: graph.provider,
    // Carry the Obsidian→filesystem degrade reason (issue #32) through the
    // ranked cache so cache hits keep it. Only present when set on the base graph.
    ...(graph.providerFallbackReason
      ? { providerFallbackReason: graph.providerFallbackReason }
      : {}),
    signals: signalsMap,
    activeExclude: resolved.activeExclude,
    usedDefaultExclude: resolved.usedDefault,
    excludedCount: excludedSet.size,
    totalNodes: graph.nodes.length,
    smallVault
  };

  rankedCache.set(rankedKey, { signals });
  return signals;
}
