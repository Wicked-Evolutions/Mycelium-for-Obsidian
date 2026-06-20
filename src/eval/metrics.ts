/**
 * Retrieval evaluation metrics — pure functions, no I/O.
 *
 * These are the baselines used to gate any ranking change (e.g. switching the
 * weighted-linear blend to RRF). All functions are deterministic and operate on
 * a ranked list of result ids plus a set of relevant ids.
 *
 * Conventions:
 *  - `ranked` is an ordered array of result identifiers, best-first (rank 1 = index 0).
 *  - `relevant` is the set of ids considered correct for the query.
 *  - `k` is a 1-based cutoff; values <= 0 are treated as the empty prefix.
 *  - Empty relevant set → metrics return 0 (a query with no answer cannot be
 *    scored as a hit; this is the conventional, NaN-free choice).
 */

/** Normalize a relevant collection into a Set for O(1) membership tests. */
function toSet(relevant: Iterable<string>): Set<string> {
  return relevant instanceof Set ? relevant : new Set(relevant);
}

/** Take the first `k` items of a ranked list (k<=0 → empty). */
function topK<T>(ranked: T[], k: number): T[] {
  if (k <= 0) return [];
  return ranked.slice(0, k);
}

/**
 * Recall@K = |relevant ∩ topK| / |relevant|.
 * Returns 0 when there are no relevant items.
 */
export function recallAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  const rel = toSet(relevant);
  if (rel.size === 0) return 0;
  const seen = new Set<string>();
  let hits = 0;
  for (const id of topK(ranked, k)) {
    if (seen.has(id)) continue;       // a doc counts once even if duplicated in the ranking
    seen.add(id);
    if (rel.has(id)) hits++;
  }
  return hits / rel.size;
}

/**
 * Precision@K = |relevant ∩ topK| / K.
 * Returns 0 when k<=0.
 */
export function precisionAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  if (k <= 0) return 0;
  const rel = toSet(relevant);
  const seen = new Set<string>();
  let hits = 0;
  for (const id of topK(ranked, k)) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (rel.has(id)) hits++;
  }
  return hits / k;
}

/**
 * Mean Reciprocal Rank for a single query: 1 / (rank of first relevant hit).
 * Returns 0 when no relevant item appears in the ranking.
 * (For a single query this is just the Reciprocal Rank; averaging across
 * queries is done by `meanReciprocalRank`.)
 */
export function reciprocalRank(ranked: string[], relevant: Iterable<string>): number {
  const rel = toSet(relevant);
  if (rel.size === 0) return 0;
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Discounted Cumulative Gain at K with binary relevance.
 * DCG = Σ rel_i / log2(i + 1), i is the 1-based rank position.
 */
export function dcgAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  const rel = toSet(relevant);
  let dcg = 0;
  const prefix = topK(ranked, k);
  for (let i = 0; i < prefix.length; i++) {
    if (rel.has(prefix[i])) {
      dcg += 1 / Math.log2(i + 2); // i is 0-based → rank = i+1 → log2((i+1)+1)
    }
  }
  return dcg;
}

/**
 * Ideal DCG at K: DCG of the best possible ordering given binary relevance.
 * With binary gains the ideal ranking front-loads min(|relevant|, k) relevant
 * items.
 */
export function idealDcgAtK(relevant: Iterable<string>, k: number): number {
  const rel = toSet(relevant);
  const n = Math.min(rel.size, Math.max(k, 0));
  let idcg = 0;
  for (let i = 0; i < n; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg;
}

/**
 * Normalized DCG at K = DCG@K / IDCG@K.
 * Returns 0 when IDCG is 0 (no relevant items, or k<=0) — never NaN.
 */
export function ndcgAtK(ranked: string[], relevant: Iterable<string>, k: number): number {
  const idcg = idealDcgAtK(relevant, k);
  if (idcg === 0) return 0;
  return dcgAtK(ranked, relevant, k) / idcg;
}

/**
 * A single gold query: a ranked candidate list paired with its relevant ids.
 * `ranked` is the system output under evaluation; `relevant` is ground truth.
 */
export interface GoldQuery {
  query: string;
  ranked: string[];
  relevant: string[];
}

export interface EvalSummary {
  count: number;
  recallAtK: number;
  precisionAtK: number;
  ndcgAtK: number;
  mrr: number;
  k: number;
}

/**
 * Mean Reciprocal Rank across a set of queries.
 */
export function meanReciprocalRank(queries: GoldQuery[]): number {
  if (queries.length === 0) return 0;
  let total = 0;
  for (const q of queries) total += reciprocalRank(q.ranked, q.relevant);
  return total / queries.length;
}

/**
 * Aggregate all metrics across a set of gold queries at a fixed cutoff K.
 * Each metric is the unweighted mean over queries.
 */
export function evaluate(queries: GoldQuery[], k: number): EvalSummary {
  if (queries.length === 0) {
    return { count: 0, recallAtK: 0, precisionAtK: 0, ndcgAtK: 0, mrr: 0, k };
  }
  let recall = 0;
  let precision = 0;
  let ndcg = 0;
  let mrr = 0;
  for (const q of queries) {
    recall += recallAtK(q.ranked, q.relevant, k);
    precision += precisionAtK(q.ranked, q.relevant, k);
    ndcg += ndcgAtK(q.ranked, q.relevant, k);
    mrr += reciprocalRank(q.ranked, q.relevant);
  }
  const n = queries.length;
  return {
    count: n,
    recallAtK: recall / n,
    precisionAtK: precision / n,
    ndcgAtK: ndcg / n,
    mrr: mrr / n,
    k
  };
}
