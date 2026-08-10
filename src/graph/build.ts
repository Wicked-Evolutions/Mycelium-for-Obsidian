/**
 * buildVaultGraph — provider-agnostic normalization of a ProviderResult into a
 * BaseGraph (unique source→target edges + count, plus in/out degree maps).
 *
 * The degree maps are computed on the BASE (unpruned) graph; exclusion pruning
 * happens later (in signals.ts) before PageRank/leveling. Raw degree always
 * comes from here so excluded nodes can still report their base degree.
 */

import { Config } from '../config.js';
import {
  GraphProvider,
  BaseGraph,
  GraphEdge,
  GraphProviderState,
  ProviderResult
} from './types.js';
import { FilesystemProvider } from './providers.js';
import {
  abortableYield,
  isAbortError,
  throwIfAborted
} from '../cli/vault-target.js';

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
  vaultName?: string,
  selectionState?: GraphProviderState,
  reusableFilesystemGraph?: BaseGraph,
  options: { allowFallback?: boolean; signal?: AbortSignal } = {}
): Promise<BaseGraph> {
  let result: ProviderResult;
  let usedProvider: 'obsidian' | 'filesystem' = provider.name;
  let providerFallbackReason: string | undefined;
  let reusedFallback = false;

  try {
    if (provider.name === 'filesystem' && reusableFilesystemGraph) {
      result = await providerResultFromGraph(reusableFilesystemGraph, options.signal);
      reusedFallback = true;
    } else {
      result = await provider.build(vaultPath, { signal: options.signal });
    }
  } catch (err) {
    throwIfAborted(options.signal);
    if (isAbortError(err)) throw err;
    if (provider.name === 'obsidian' && options.allowFallback !== false) {
      // Graceful degradation: Obsidian unreachable / eval failed → filesystem.
      // Capture a SANITIZED reason so the silent degrade (issue #32) becomes
      // observable. This branch is the ONLY place providerFallbackReason is set:
      // a filesystem provider selected normally never reaches here.
      if (reusableFilesystemGraph) {
        result = await providerResultFromGraph(reusableFilesystemGraph, options.signal);
        reusedFallback = true;
      } else {
        const fs = new FilesystemProvider();
        result = await fs.build(vaultPath, { signal: options.signal });
      }
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

  const providerState: GraphProviderState = {
    ...(selectionState ?? defaultProviderState(provider.name)),
    approximate: usedProvider === 'filesystem',
    exactProviderInvoked: provider.name === 'obsidian',
    ...(providerFallbackReason ? { degradationReason: 'eval_failed' as const } : {})
  };
  const graph = reusedFallback
    ? { ...reusableFilesystemGraph!, providerState }
    : await normalize(result, usedProvider, providerState, options.signal);
  throwIfAborted(options.signal);
  if (providerFallbackReason) {
    graph.providerFallbackReason = providerFallbackReason;
  } else {
    delete graph.providerFallbackReason;
  }
  return graph;
}

function defaultProviderState(provider: GraphProvider['name']): GraphProviderState {
  return {
    selectedProvider: provider,
    approximate: provider === 'filesystem',
    exactProviderAvailability: provider === 'obsidian' ? 'available' : 'unknown',
    exactProviderInvoked: false
  };
}

async function providerResultFromGraph(
  graph: BaseGraph,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const resolvedLinks = new Map<string, Map<string, number>>();
  for (let index = 0; index < graph.edges.length; index += 1) {
    if (signal && index % 512 === 0) await abortableYield(signal);
    else throwIfAborted(signal);
    const edge = graph.edges[index];
    let targets = resolvedLinks.get(edge.source);
    if (!targets) {
      targets = new Map();
      resolvedLinks.set(edge.source, targets);
    }
    targets.set(edge.target, edge.count);
  }
  return {
    nodes: graph.nodes,
    resolvedLinks,
    resolvedEdgeCount: graph.resolvedEdgeCount,
    unresolvedLinkCount: graph.unresolvedLinkCount,
    distinctUnresolvedTargets: graph.distinctUnresolvedTargets
  };
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
export async function normalize(
  result: ProviderResult,
  provider: 'obsidian' | 'filesystem',
  providerState: GraphProviderState = defaultProviderState(provider),
  signal?: AbortSignal
): Promise<BaseGraph> {
  throwIfAborted(signal);
  const nodeSet = new Set<string>(result.nodes);
  const edges: GraphEdge[] = [];
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  // Ensure every node has a degree entry (0 default).
  let nodeIndex = 0;
  for (const n of nodeSet) {
    if (signal && nodeIndex % 512 === 0) await abortableYield(signal);
    nodeIndex += 1;
    inDegree.set(n, 0);
    outDegree.set(n, 0);
  }

  let sourceIndex = 0;
  for (const [source, targets] of result.resolvedLinks) {
    if (signal && sourceIndex % 256 === 0) await abortableYield(signal);
    sourceIndex += 1;
    // A source that appears in resolvedLinks but not in the node set still
    // contributes edges; register it as a node too.
    if (!nodeSet.has(source)) {
      nodeSet.add(source);
      if (!inDegree.has(source)) inDegree.set(source, 0);
      if (!outDegree.has(source)) outDegree.set(source, 0);
    }
    let outCount = 0;
    let targetIndex = 0;
    for (const [target, count] of targets) {
      if (signal && targetIndex % 512 === 0) await abortableYield(signal);
      targetIndex += 1;
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
    provider,
    providerState,
    // Vault-level link-resolution aggregates (issue #37). Come from whichever
    // provider actually produced `result` — on the Obsidian→filesystem degrade
    // (#32) these are the FILESYSTEM approximation's counts, matching provider.
    resolvedEdgeCount: result.resolvedEdgeCount,
    unresolvedLinkCount: result.unresolvedLinkCount,
    distinctUnresolvedTargets: result.distinctUnresolvedTargets
  };
}
