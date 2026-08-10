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
import {
  GraphProviderSelection,
  selectProviderWithState
} from './providers.js';
import { computeGraphDigest, hashExclude } from './digest.js';
import { resolveExclude, computeExcludedSet, ExcludeInput } from './exclude.js';
import { pageRank } from './pagerank.js';
import { assignLevels } from './levels.js';

// ─── Caches (module-level, session-scoped) ───────────────────────────────────

interface BaseCacheEntry {
  digest: string;
  decisionKey: string;
  identity: string;
  graph: BaseGraph;
}
const baseCache = new Map<string, BaseCacheEntry>(); // key: vaultPath

interface RankedCacheEntry {
  signals: GraphSignals;
}
const rankedCache = new Map<string, RankedCacheEntry>(); // key: vaultPath|digest|excludeHash
let requestSequence = 0;
const latestSequenceByVault = new Map<string, number>();

interface BaseRequestContext {
  digest: string;
  selection: GraphProviderSelection;
  sequence: number;
}

/**
 * Test/maintenance helper: clear all session caches.
 */
export function clearGraphCaches(): void {
  baseCache.clear();
  rankedCache.clear();
  latestSequenceByVault.clear();
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
  vaultPath: string,
  context?: BaseRequestContext
): Promise<BaseGraph> {
  const sequence = context?.sequence ?? beginGraphRequest(vaultPath);
  const digest = context?.digest ?? await computeGraphDigest(vaultPath);
  const selection = context?.selection ?? await selectProviderWithState(config, vaultName);
  const cached = baseCache.get(vaultPath);
  const exactRetryRequired =
    selection.provider.name === 'obsidian' && cached?.graph.provider === 'filesystem';
  if (
    cached &&
    cached.digest === digest &&
    cached.decisionKey === selection.decisionKey &&
    !exactRetryRequired
  ) {
    return cached.graph;
  }

  const reusableFilesystemGraph =
    cached?.digest === digest && cached.graph.provider === 'filesystem'
      ? cached.graph
      : undefined;
  const built = await buildVaultGraph(
    vaultPath,
    selection.provider,
    config,
    vaultName,
    selection.state,
    reusableFilesystemGraph
  );
  const identity = [
    vaultPath,
    digest,
    selection.decisionKey,
    built.provider,
    built.providerState.degradationReason ?? 'none'
  ].join('|');
  const graph = { ...built, cacheIdentity: identity };

  // Only the newest-started request may replace the shared cache. This prevents
  // a late fallback from poisoning a newer exact-provider result.
  if (latestSequenceByVault.get(vaultPath) === sequence) {
    const previousIdentity = cached?.identity;
    baseCache.set(vaultPath, {
      digest,
      decisionKey: selection.decisionKey,
      identity,
      graph
    });
    if (previousIdentity && previousIdentity !== identity) {
      for (const key of [...rankedCache.keys()]) {
        if (key.startsWith(vaultPath + '|')) rankedCache.delete(key);
      }
    }
  }
  return graph;
}

function beginGraphRequest(vaultPath: string): number {
  const sequence = ++requestSequence;
  latestSequenceByVault.set(vaultPath, sequence);
  return sequence;
}

function withBaseMetadata(signals: GraphSignals, baseGraph: BaseGraph): GraphSignals {
  return {
    ...signals,
    provider: baseGraph.provider,
    providerState: baseGraph.providerState,
    baseGraph,
    ...(baseGraph.providerFallbackReason
      ? { providerFallbackReason: baseGraph.providerFallbackReason }
      : { providerFallbackReason: undefined })
  };
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
  const sequence = beginGraphRequest(vaultPath);

  const digest = await computeGraphDigest(vaultPath);
  const selection = await selectProviderWithState(config, vaultName);
  const excludeHash = hashExclude(exclude?.where);
  const graph = await getBaseGraph(config, vaultName, vaultPath, {
    digest,
    selection,
    sequence
  });
  const rankedKey = `${vaultPath}|${graph.cacheIdentity}|${excludeHash}`;

  const cachedRanked = rankedCache.get(rankedKey);
  if (cachedRanked) return withBaseMetadata(cachedRanked.signals, graph);

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
    providerState: graph.providerState,
    baseGraph: graph,
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
    smallVault,
    // Vault-level link-resolution aggregates (issue #37), carried from the base
    // graph so ranked-cache hits keep them (exclusion-independent).
    resolvedEdgeCount: graph.resolvedEdgeCount,
    unresolvedLinkCount: graph.unresolvedLinkCount,
    distinctUnresolvedTargets: graph.distinctUnresolvedTargets
  };

  if (latestSequenceByVault.get(vaultPath) === sequence) {
    rankedCache.set(rankedKey, { signals });
  }
  return signals;
}
