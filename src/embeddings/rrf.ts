/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Fuses multiple ranked lists into one combined ranking using the standard
 * formula from Cormack et al. (2009):
 *
 *     fusionScore(d) = Σ_signals  1 / (k + rank_signal(d))
 *
 * where `rank` is the 1-based position of document `d` in that signal's list.
 * A document absent from a signal's list contributes **0** for that signal
 * (union-safe — it is NOT treated as `1/(k+0)` or any sentinel rank).
 *
 * `k` is fixed as a module constant (60, the value from the original paper).
 * It is deliberately NOT an input argument: exposing it would churn the public
 * tool schema snapshot and is out of scope for this track.
 */

/** Fixed RRF dampening constant (Cormack et al. 2009). Not configurable. */
export const RRF_K = 60;

/** A single ranked signal: an ordered list of document ids, best-first. */
export interface RankedSignal {
  /** Stable signal name, e.g. "bm25" or "embeddings". */
  name: string;
  /** Document ids in rank order (index 0 = rank 1 = best). May contain no duplicates. */
  ranked: string[];
}

/** Per-signal detail for one fused document. */
export interface PerSignalRank {
  /** 1-based rank in this signal's list, or null if the doc was absent. */
  rank: number | null;
  /** This signal's RRF contribution: 1/(k+rank), or 0 if absent. */
  term: number;
}

/** One fused result row. */
export interface FusedResult {
  id: string;
  /** Σ of all per-signal terms. */
  fusionScore: number;
  /** Map of signalName → {rank, term}. Absent signals report {rank:null, term:0}. */
  perSignal: Record<string, PerSignalRank>;
}

/**
 * Build a Map<id, 1-based-rank> from a ranked list. First occurrence wins, so
 * a duplicated id keeps its best (earliest) rank.
 */
function rankIndex(ranked: string[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < ranked.length; i++) {
    if (!idx.has(ranked[i])) idx.set(ranked[i], i + 1); // 1-based
  }
  return idx;
}

/**
 * Reciprocal Rank Fusion over an arbitrary number of ranked signals.
 *
 * Returns a list of fused results sorted by descending `fusionScore`. The union
 * of all ids across all signals is covered; an id missing from a signal
 * contributes 0 (and is reported as `{rank:null, term:0}` in `perSignal`).
 *
 * Ties in fusionScore are broken deterministically by id (ascending) so the
 * output is stable.
 */
export function reciprocalRankFusion(signals: RankedSignal[], k: number = RRF_K): FusedResult[] {
  // Pre-index each signal once.
  const indices = signals.map(s => ({ name: s.name, index: rankIndex(s.ranked) }));

  // Union of all ids across signals.
  const allIds = new Set<string>();
  for (const s of signals) {
    for (const id of s.ranked) allIds.add(id);
  }

  const results: FusedResult[] = [];
  for (const id of allIds) {
    const perSignal: Record<string, PerSignalRank> = {};
    let fusionScore = 0;
    for (const { name, index } of indices) {
      const rank = index.get(id);
      if (rank === undefined) {
        perSignal[name] = { rank: null, term: 0 }; // union-safe: absent → 0
      } else {
        const term = 1 / (k + rank);
        perSignal[name] = { rank, term };
        fusionScore += term;
      }
    }
    results.push({ id, fusionScore, perSignal });
  }

  results.sort((a, b) => {
    if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tie-break
  });

  return results;
}
