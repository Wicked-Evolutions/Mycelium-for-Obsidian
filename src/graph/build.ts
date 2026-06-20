/**
 * buildVaultGraph — provider-agnostic normalization of a ProviderResult into a
 * BaseGraph (unique source→target edges + count, plus in/out degree maps).
 *
 * The degree maps are computed on the BASE (unpruned) graph; exclusion pruning
 * happens later (in signals.ts) before PageRank/leveling. Raw degree always
 * comes from here so excluded nodes can still report their base degree.
 */

import { Config } from '../config.js';
import { GraphProvider, BaseGraph, GraphEdge, ProviderResult } from './types.js';
import { FilesystemProvider } from './providers.js';

/**
 * Build a BaseGraph from an explicit provider. Used directly by the
 * provider-contract test (bypasses any cache) so both providers can be compared
 * on identical edge shape.
 *
 * If the provider is the Obsidian provider and it throws (Obsidian not actually
 * reachable, eval error), we transparently fall back to the filesystem provider
 * so the graph is always built.
 */
export async function buildVaultGraph(
  vaultPath: string,
  provider: GraphProvider,
  config?: Config,
  vaultName?: string
): Promise<BaseGraph> {
  let result: ProviderResult;
  let usedProvider: 'obsidian' | 'filesystem' = provider.name;

  try {
    result = await provider.build(vaultPath);
  } catch (err) {
    if (provider.name === 'obsidian') {
      // Graceful degradation: Obsidian unreachable / eval failed → filesystem.
      const fs = new FilesystemProvider();
      result = await fs.build(vaultPath);
      usedProvider = 'filesystem';
    } else {
      throw err;
    }
  }

  // The optional plumbing args (config, vaultName) are kept for caller symmetry
  // with provider re-selection; not needed once a provider is chosen.
  void config;
  void vaultName;

  return normalize(result, usedProvider);
}

/**
 * Normalize a ProviderResult (resolvedLinks adjacency) into a BaseGraph.
 */
export function normalize(
  result: ProviderResult,
  provider: 'obsidian' | 'filesystem'
): BaseGraph {
  const nodeSet = new Set<string>(result.nodes);
  const edges: GraphEdge[] = [];
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  // Ensure every node has a degree entry (0 default).
  for (const n of nodeSet) {
    inDegree.set(n, 0);
    outDegree.set(n, 0);
  }

  for (const [source, targets] of result.resolvedLinks) {
    // A source that appears in resolvedLinks but not in the node set still
    // contributes edges; register it as a node too.
    if (!nodeSet.has(source)) {
      nodeSet.add(source);
      if (!inDegree.has(source)) inDegree.set(source, 0);
      if (!outDegree.has(source)) outDegree.set(source, 0);
    }
    let outCount = 0;
    for (const [target, count] of targets) {
      if (target === source) continue; // no self-edges
      if (!nodeSet.has(target)) {
        nodeSet.add(target);
        if (!inDegree.has(target)) inDegree.set(target, 0);
        if (!outDegree.has(target)) outDegree.set(target, 0);
      }
      edges.push({ source, target, count });
      inDegree.set(target, (inDegree.get(target) || 0) + 1);
      outCount += 1;
    }
    outDegree.set(source, outCount);
  }

  return {
    nodes: [...nodeSet],
    edges,
    inDegree,
    outDegree,
    provider
  };
}
