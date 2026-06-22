/**
 * reranker — the pluggable rerank SEAM (issue #27, PR-B).
 *
 * Reranking is the ONE retrieval stage that REORDERS: it re-sorts the fused
 * top-K by a `reranker_score`. This file wires the seam ONLY — the real
 * LLM-as-reranker backend is PR-C. Here we provide:
 *   - the `Reranker` interface + a `RerankCandidate` shape;
 *   - a backend registry keyed by name;
 *   - the DEFAULT backend `none` = a HARD NO-OP (returns input unchanged,
 *     `reranker_score` stays null, NO reorder; reports unavailable);
 *   - a PURE `applyRerank` that the handler calls and tests drive headless with
 *     a deterministic fake backend (mirrors graph-annotate's pure/orchestration
 *     split so the reorder + degrade paths are testable WITHOUT Ollama).
 *
 * RATIFIED CONTRACT (GPT-5.5 gate, issue #27):
 *   - Per-call `rerank` arg, default OFF. When OFF → seam is never entered →
 *     output byte-identical to pre-PR (reranker_score stays the literal null).
 *   - When ON: pull the candidate passage TEXT for the fused top-K from
 *     content_fts (by file_path+block_id), call the active backend, write
 *     reranker_score, and re-sort the top-K by reranker_score.
 *   - Backend unavailable / `none` → reranker_score:null, ordering UNCHANGED,
 *     rerankerAvailable:false + a reason (mirrors the graphAvailable SHAPE —
 *     {boolean + reason} — but its presence is gated by the caller on the
 *     `rerank` arg, so default-OFF emits ZERO new keys).
 */

/** A candidate passed to a backend: a stable id, its real passage text, and the fused score. */
export interface RerankCandidate {
  /** Stable candidate id — the `${filePath}:${blockId}` key used through fusion. */
  id: string;
  /** The real passage text (full chunk from content_fts), not the 200-char preview. */
  text: string;
  /** The RRF fusion score this candidate carried into the reranker. */
  fusionScore: number;
}

/** A backend's per-candidate verdict: the same id + a relevance score. */
export interface RerankScore {
  id: string;
  reranker_score: number;
}

/**
 * A rerank backend. `rerank` returns a score per candidate (any subset/order —
 * the caller joins by id). `available()` lets the caller distinguish a working
 * backend (→ reorder) from `none`/unavailable (→ graceful degrade) WITHOUT
 * inferring availability from whether scores came back.
 */
export interface Reranker {
  /** Stable backend name (registry key), e.g. "none" or "llm" (PR-C). */
  readonly name: string;
  /** True iff this backend can actually score; `none` is always false. */
  available(): boolean;
  /** Score the candidates. Only called when available() is true. */
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]>;
}

/**
 * The default backend: a HARD NO-OP. Never reorders, never scores. `available()`
 * is false so the caller leaves `reranker_score` null and ordering unchanged.
 */
export const noneReranker: Reranker = {
  name: 'none',
  available() {
    return false;
  },
  async rerank() {
    // Never invoked (available() === false), but keep it a strict no-op anyway.
    return [];
  },
};

/** Backend registry. Default-only in PR-B; PR-C registers the real LLM backend. */
const registry = new Map<string, Reranker>([['none', noneReranker]]);

/** Register (or override) a backend by name. */
export function registerReranker(backend: Reranker): void {
  registry.set(backend.name, backend);
}

/** Look up a backend by name; falls back to `none` when the name is unknown. */
export function getReranker(name?: string): Reranker {
  if (!name) return noneReranker;
  return registry.get(name) ?? noneReranker;
}

/** The active backend name. PR-B: always `none` until PR-C wires a real one. */
export function getActiveRerankerName(): string {
  return process.env.RERANKER_BACKEND || 'none';
}

/** Result of the pure rerank step. Mirrors the graph-annotate pure/orchestration split. */
export interface ApplyRerankResult<T> {
  /** Same items as input. Re-sorted by reranker_score ONLY when the backend reordered. */
  results: T[];
  /** Per-candidate score keyed by candidate id; empty when no reorder happened. */
  scores: Map<string, number>;
  /** True iff a working backend scored and the top-K was re-sorted. */
  rerankerAvailable: boolean;
  /** Why reranking did not happen (only when rerankerAvailable is false). */
  rerankerUnavailableReason?: string;
}

/**
 * PURE rerank step. Takes the already-built (fusion-ordered) top-K, a text
 * lookup, and a backend; returns a possibly-reordered array + a score map.
 *
 * GUARANTEES:
 *   - Backend unavailable (`none`) → input returned UNCHANGED, empty score map,
 *     rerankerAvailable:false + reason. The ONE no-op contract.
 *   - Backend throws / returns malformed → graceful degrade: input UNCHANGED,
 *     rerankerAvailable:false + reason. NEVER throws.
 *   - Backend available + scores → re-sort by reranker_score DESC (stable for
 *     ties: original fusion order preserved), score map populated.
 *
 * `getId`/`getText` adapt arbitrary result rows to candidates so the handler's
 * enriched-result shape and the tests' fixtures share ONE code path.
 */
export async function applyRerank<T>(
  query: string,
  results: T[],
  getId: (r: T) => string,
  getText: (r: T) => string,
  getFusionScore: (r: T) => number,
  backend: Reranker
): Promise<ApplyRerankResult<T>> {
  if (!backend.available()) {
    return {
      results,
      scores: new Map(),
      rerankerAvailable: false,
      rerankerUnavailableReason: `reranker backend "${backend.name}" unavailable (no-op)`,
    };
  }

  const candidates: RerankCandidate[] = results.map((r) => ({
    id: getId(r),
    text: getText(r),
    fusionScore: getFusionScore(r), // the real RRF total — part of the backend contract
  }));

  let scored: RerankScore[];
  try {
    scored = await backend.rerank(query, candidates);
  } catch (err) {
    return {
      results,
      scores: new Map(),
      rerankerAvailable: false,
      rerankerUnavailableReason: `reranker backend "${backend.name}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!Array.isArray(scored)) {
    return {
      results,
      scores: new Map(),
      rerankerAvailable: false,
      rerankerUnavailableReason: `reranker backend "${backend.name}" returned malformed output`,
    };
  }

  const scores = new Map<string, number>();
  for (const s of scored) {
    if (s && typeof s.id === 'string' && typeof s.reranker_score === 'number' && Number.isFinite(s.reranker_score)) {
      scores.set(s.id, s.reranker_score);
    }
  }

  // Stable re-sort by reranker_score DESC. Candidates the backend did not score
  // keep their relative fusion order and sink below scored ones.
  const indexed = results.map((r, i) => ({ r, i, id: getId(r) }));
  indexed.sort((a, b) => {
    const sa = scores.get(a.id);
    const sb = scores.get(b.id);
    const va = sa === undefined ? -Infinity : sa;
    const vb = sb === undefined ? -Infinity : sb;
    if (vb !== va) return vb - va;
    return a.i - b.i; // stable: preserve fusion order on ties
  });

  return {
    results: indexed.map((x) => x.r),
    scores,
    rerankerAvailable: true,
  };
}
