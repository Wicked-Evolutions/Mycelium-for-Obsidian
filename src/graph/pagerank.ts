/**
 * Hand-rolled PageRank (no new deps).
 *
 * RATIFIED params: damping 0.85, max 20 iterations, tolerance 1e-7, dangling
 * mass redistributed UNIFORMLY across all nodes. Edges are unweighted unique
 * source→target edges (v1) — occurrence counts are reported separately in the
 * contributor breakdown, not folded into the rank.
 */

export interface PageRankOptions {
  damping?: number;
  maxIterations?: number;
  tolerance?: number;
}

export const PAGERANK_DEFAULTS = {
  damping: 0.85,
  maxIterations: 20,
  tolerance: 1e-7
} as const;

/**
 * Compute PageRank over a directed graph.
 *
 * @param nodes  ordered list of node ids (the ranked node set, post-pruning)
 * @param edges  unique directed edges (source → target); both endpoints must be
 *               in `nodes` (edges touching pruned nodes are dropped by caller)
 */
export function pageRank(
  nodes: string[],
  edges: Array<{ source: string; target: string }>,
  options: PageRankOptions = {}
): Map<string, number> {
  const damping = options.damping ?? PAGERANK_DEFAULTS.damping;
  const maxIterations = options.maxIterations ?? PAGERANK_DEFAULTS.maxIterations;
  const tolerance = options.tolerance ?? PAGERANK_DEFAULTS.tolerance;

  const n = nodes.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node, i));

  // Out-adjacency and out-degree.
  const outLinks: number[][] = Array.from({ length: n }, () => []);
  const outDeg: number[] = new Array(n).fill(0);
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    outLinks[s].push(t);
    outDeg[s] += 1;
  }

  let rank = new Array<number>(n).fill(1 / n);
  const base = (1 - damping) / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Array<number>(n).fill(base);

    // Dangling mass: nodes with no out-links spread their rank uniformly.
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) danglingSum += rank[i];
    }
    const danglingShare = (damping * danglingSum) / n;

    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) continue;
      const share = (damping * rank[i]) / outDeg[i];
      for (const t of outLinks[i]) {
        next[t] += share;
      }
    }
    for (let i = 0; i < n; i++) {
      next[i] += danglingShare;
    }

    // Convergence check (L1 norm).
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (diff < tolerance) break;
  }

  nodes.forEach((node, i) => result.set(node, rank[i]));
  return result;
}
