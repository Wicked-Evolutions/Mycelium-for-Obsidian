/**
 * Hand-rolled PageRank (no new deps).
 *
 * RATIFIED params: damping 0.85, max 20 iterations, tolerance 1e-7, dangling
 * mass redistributed UNIFORMLY across all nodes. Edges are unweighted unique
 * source→target edges (v1) — occurrence counts are reported separately in the
 * contributor breakdown, not folded into the rank.
 */

import { abortableYield, throwIfAborted } from '../cli/vault-target.js';

export interface PageRankOptions {
  damping?: number;
  maxIterations?: number;
  tolerance?: number;
  signal?: AbortSignal;
}

export const PAGERANK_DEFAULTS = {
  damping: 0.85,
  maxIterations: 20,
  tolerance: 1e-7
} as const;

/** Distribute one PageRank iteration with checkpoints inside high-fan-out nodes. */
export async function distributeRank(
  outLinks: readonly number[][],
  outDeg: readonly number[],
  rank: readonly number[],
  next: number[],
  damping: number,
  signal?: AbortSignal
): Promise<void> {
  let visitedTargets = 0;
  for (let i = 0; i < outLinks.length; i++) {
    if (signal && i % 1024 === 0) await abortableYield(signal);
    if (outDeg[i] === 0) continue;
    const share = (damping * rank[i]) / outDeg[i];
    for (const target of outLinks[i]) {
      if (signal && visitedTargets % 1024 === 0) await abortableYield(signal);
      visitedTargets += 1;
      next[target] += share;
    }
  }
}

/**
 * Compute PageRank over a directed graph.
 *
 * @param nodes  ordered list of node ids (the ranked node set, post-pruning)
 * @param edges  unique directed edges (source → target); both endpoints must be
 *               in `nodes` (edges touching pruned nodes are dropped by caller)
 */
export async function pageRank(
  nodes: string[],
  edges: Array<{ source: string; target: string }>,
  options: PageRankOptions = {}
): Promise<Map<string, number>> {
  const damping = options.damping ?? PAGERANK_DEFAULTS.damping;
  const maxIterations = options.maxIterations ?? PAGERANK_DEFAULTS.maxIterations;
  const tolerance = options.tolerance ?? PAGERANK_DEFAULTS.tolerance;
  const signal = options.signal;

  const n = nodes.length;
  const result = new Map<string, number>();
  if (n === 0) return result;
  throwIfAborted(signal);

  const index = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    if (signal && i % 1024 === 0) await abortableYield(signal);
    index.set(nodes[i], i);
  }

  // Out-adjacency and out-degree.
  const outLinks: number[][] = Array.from({ length: n }, () => []);
  const outDeg: number[] = new Array(n).fill(0);
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    if (signal && edgeIndex % 1024 === 0) await abortableYield(signal);
    const e = edges[edgeIndex];
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    outLinks[s].push(t);
    outDeg[s] += 1;
  }

  let rank = new Array<number>(n).fill(1 / n);
  const base = (1 - damping) / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    await abortableYield(signal);
    const next = new Array<number>(n).fill(base);

    // Dangling mass: nodes with no out-links spread their rank uniformly.
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      if (signal && i % 1024 === 0) await abortableYield(signal);
      if (outDeg[i] === 0) danglingSum += rank[i];
    }
    const danglingShare = (damping * danglingSum) / n;

    await distributeRank(outLinks, outDeg, rank, next, damping, signal);
    for (let i = 0; i < n; i++) {
      if (signal && i % 1024 === 0) await abortableYield(signal);
      next[i] += danglingShare;
    }

    // Convergence check (L1 norm).
    let diff = 0;
    for (let i = 0; i < n; i++) {
      if (signal && i % 1024 === 0) await abortableYield(signal);
      diff += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (diff < tolerance) break;
  }

  for (let i = 0; i < nodes.length; i++) {
    if (signal && i % 1024 === 0) await abortableYield(signal);
    result.set(nodes[i], rank[i]);
  }
  return result;
}
