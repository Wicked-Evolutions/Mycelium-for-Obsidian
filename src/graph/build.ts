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
  let providerFallbackReason: string | undefined;

  try {
    result = await provider.build(vaultPath);
  } catch (err) {
    if (provider.name === 'obsidian') {
      // Graceful degradation: Obsidian unreachable / eval failed → filesystem.
      // Capture a SANITIZED reason so the silent degrade (issue #32) becomes
      // observable. This branch is the ONLY place providerFallbackReason is set:
      // a filesystem provider selected normally never reaches here.
      const fs = new FilesystemProvider();
      result = await fs.build(vaultPath);
      usedProvider = 'filesystem';
      providerFallbackReason = sanitizeFallbackReason(err);
    } else {
      throw err;
    }
  }

  // The optional plumbing args (config, vaultName) are kept for caller symmetry
  // with provider re-selection; not needed once a provider is chosen.
  void config;
  void vaultName;

  const graph = normalize(result, usedProvider);
  if (providerFallbackReason) {
    graph.providerFallbackReason = providerFallbackReason;
  }
  return graph;
}

/** Max length of the sanitized fallback reason (bounded payload). */
const MAX_FALLBACK_REASON_LEN = 200;

/**
 * Build a short, safe, path-free reason for an Obsidian→filesystem degrade.
 *
 * The raw error can carry the full CLI/eval error (with stderr) and may embed
 * absolute filesystem paths or large payload fragments. We take the FIRST LINE
 * only, REDACT any absolute path, and TRUNCATE to a bounded length, then wrap
 * it so the message always mentions the Obsidian failure and the fallback.
 */
export function sanitizeFallbackReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // First line only — the CLI error appends `\n${stderr}`.
  const firstLine = raw.split('\n')[0] ?? '';
  // Redact absolute POSIX paths (/Users/…, /home/…, /var/…, any leading-slash
  // segment run) so no filesystem path leaks into the response.
  const noPaths = firstLine.replace(/\/(?:[^\s/]+\/)*[^\s/]*/g, '[path]');
  const collapsed = noPaths.replace(/\s+/g, ' ').trim();
  const truncated =
    collapsed.length > MAX_FALLBACK_REASON_LEN
      ? collapsed.slice(0, MAX_FALLBACK_REASON_LEN - 1).trimEnd() + '…'
      : collapsed;
  const short = truncated.length > 0 ? truncated : 'unknown error';
  return `Obsidian graph provider failed: ${short}; used filesystem approximation`;
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
