/**
 * Leveling (L0..L5) over PageRank on the PRUNED graph.
 *
 * RATIFIED bands (corrected — high PageRank → LOW level number):
 *   L0 = PageRank ≥ p99   (top hubs / roots)
 *   L1 = p95 ≤ PR < p99
 *   L2 = p80 ≤ PR < p95
 *   L3 = p50 ≤ PR < p80
 *   L4 = PR < p50
 *   L5 = inDegree 0 (leaf floor — OVERRIDES percentile)
 *
 * Leaf floor wins: a node with zero inbound edges is L5 regardless of PageRank.
 *
 * Small-vault fallback (~≤25 ranked nodes): percentiles over a tiny population
 * are noise, so we fall back to COARSE ABSOLUTE bands relative to the max
 * PageRank in the pruned graph.
 */

export const SMALL_VAULT_THRESHOLD = 25;

const PERCENTILE_CUTS = [
  { level: 0, p: 0.99 },
  { level: 1, p: 0.95 },
  { level: 2, p: 0.8 },
  { level: 3, p: 0.5 }
  // below p50 → L4
];

export interface LevelResult {
  levels: Map<string, number>;
  smallVault: boolean;
}

/**
 * Compute the percentile value at fraction `p` (0..1) over a SORTED-ascending
 * array, using linear interpolation. p99 → the value at the 99th percentile.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Assign levels.
 *
 * @param pagerank  path → pagerank over the pruned graph (ranked nodes only)
 * @param inDegree  path → BASE-graph inbound degree (for leaf-floor detection;
 *                  per the brief the leaf floor is in-degree 0)
 */
export function assignLevels(
  pagerank: Map<string, number>,
  inDegree: Map<string, number>
): LevelResult {
  const levels = new Map<string, number>();
  const rankedNodes = [...pagerank.keys()];
  const n = rankedNodes.length;

  if (n === 0) {
    return { levels, smallVault: false };
  }

  const smallVault = n <= SMALL_VAULT_THRESHOLD;

  if (smallVault) {
    // Coarse absolute bands relative to max PageRank in the pruned graph.
    let maxPr = 0;
    for (const v of pagerank.values()) maxPr = Math.max(maxPr, v);
    for (const node of rankedNodes) {
      if ((inDegree.get(node) || 0) === 0) {
        levels.set(node, 5); // leaf floor
        continue;
      }
      const pr = pagerank.get(node) || 0;
      const ratio = maxPr > 0 ? pr / maxPr : 0;
      // Coarse bands: top → L0, then descending.
      let level: number;
      if (ratio >= 0.75) level = 0;
      else if (ratio >= 0.5) level = 1;
      else if (ratio >= 0.3) level = 2;
      else if (ratio >= 0.15) level = 3;
      else level = 4;
      levels.set(node, level);
    }
    return { levels, smallVault };
  }

  // Percentile banding.
  const sorted = [...pagerank.values()].sort((a, b) => a - b);
  const cuts = PERCENTILE_CUTS.map((c) => ({ level: c.level, value: percentile(sorted, c.p) }));

  for (const node of rankedNodes) {
    if ((inDegree.get(node) || 0) === 0) {
      levels.set(node, 5); // leaf floor overrides percentile
      continue;
    }
    const pr = pagerank.get(node) || 0;
    let level = 4; // default: below p50
    for (const cut of cuts) {
      if (pr >= cut.value) {
        level = cut.level;
        break;
      }
    }
    levels.set(node, level);
  }

  return { levels, smallVault };
}

/**
 * Build a histogram of level → count over the assigned levels, plus an entry
 * for excluded nodes (level null).
 */
export function levelHistogram(
  levels: Map<string, number>,
  excludedCount: number
): Array<{ level: number | 'excluded'; count: number }> {
  const counts = new Map<number, number>();
  for (const lvl of levels.values()) {
    counts.set(lvl, (counts.get(lvl) || 0) + 1);
  }
  const out: Array<{ level: number | 'excluded'; count: number }> = [];
  for (let l = 0; l <= 5; l++) {
    out.push({ level: l, count: counts.get(l) || 0 });
  }
  if (excludedCount > 0) {
    out.push({ level: 'excluded', count: excludedCount });
  }
  return out;
}
