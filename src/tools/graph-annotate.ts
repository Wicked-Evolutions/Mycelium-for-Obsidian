/**
 * graph-annotate — Convergence (issue #23) Level A + Level B.
 *
 * Wires the two pillars together: enrich each `semantic_search` hit with the
 * structural graph signals from `getGraphSignals` (Track A). The AI sees a hit's
 * structural role (level, pagerank, in/out degree, excluded flag) ALONGSIDE its
 * relevance — a compass, not a re-ranker.
 *
 * RATIFIED CONTRACT (GPT-5.5 gate):
 *   - Level A (annotate): attach a nested ADDITIVE `graph` block to each hit —
 *     { level, pagerank, inDegree, outDegree, inOutRatio, archived, excluded }
 *     | null. RAW signals only — NO interpreted prose / orientation_note.
 *   - Level B (FLAG-ONLY): the `excluded` flag comes from the SAME single
 *     getGraphSignals(config, vault, undefined) call (DEFAULT_EXCLUDE — so
 *     `level` means the same as in analyze_link_hierarchy). NO demote, NO hide,
 *     NO reorder — ordering stays `fusionScore`.
 *   - One call, guarded: getGraphSignals is called ONCE in try/catch. On GLOBAL
 *     failure → results un-annotated + graphAvailable:false + reason; NEVER
 *     isError. Per-hit MISS (path not in map) → that hit's `graph: null`
 *     (the key is INCLUDED, never omitted).
 *   - Join on VAULT-RELATIVE path (with .md), NFC-normalized on BOTH sides
 *     (macOS NFD-vs-NFC guard).
 *
 * Pure + dependency-injectable so it is testable WITHOUT Ollama or a real graph
 * build (`annotateWithGraph` is sync map-over only; `attachGraphSignals` accepts
 * an injectable `getSignals`).
 */

import type { Config } from '../config.js';
import type { GraphSignals, NodeSignals } from '../graph/types.js';
import { getGraphSignals as defaultGetGraphSignals } from '../graph/signals.js';
import type { FilterCondition } from './query.js';

/**
 * The additive per-hit graph block. Mirrors NodeSignals exactly (raw signals
 * only — no interpreted prose). `null` when the hit's path is not present in the
 * signals map (a per-hit MISS); the key is always included.
 */
export type GraphBlock = NodeSignals | null;

/** A search hit must at minimum carry a vault-relative `path` (with .md). */
interface PathBearing {
  path: string;
}

/**
 * Build an NFC-keyed lookup index from a signals map. macOS hands filesystem
 * paths in NFD while the Obsidian eval provider's resolvedLinks are NFC — so we
 * normalize BOTH the map keys (here) and the hit path (at lookup) to NFC, making
 * the join resolve regardless of which side carried which form.
 */
function buildNfcIndex(signalsMap: Map<string, NodeSignals>): Map<string, NodeSignals> {
  const idx = new Map<string, NodeSignals>();
  for (const [key, sig] of signalsMap) {
    idx.set(key.normalize('NFC'), sig);
  }
  return idx;
}

/**
 * PURE Level-A/B annotation: map over `results` IN ORDER and attach a `graph`
 * block to each. NEVER reorders, filters, or mutates the input array — returns a
 * NEW array with the SAME length and the SAME path order (byte-identical paths).
 *
 * Join key: each hit's vault-relative `.path`, NFC-normalized, looked up against
 * an NFC-normalized index of `signalsMap` keys. A miss yields `graph: null`.
 */
export function annotateWithGraph<T extends PathBearing>(
  results: T[],
  signalsMap: Map<string, NodeSignals>
): Array<T & { graph: GraphBlock }> {
  const nfcIndex = buildNfcIndex(signalsMap);
  return results.map((r) => {
    const sig = nfcIndex.get(r.path.normalize('NFC'));
    return { ...r, graph: sig ?? null };
  });
}

/** Top-level fields the search response echoes alongside the annotated results. */
export interface GraphAttachMeta {
  /** Always present. False when the single getGraphSignals call failed. */
  graphAvailable: boolean;
  /** Why graph signals are unavailable (only when graphAvailable is false). */
  graphUnavailableReason?: string;
  /** The exclusion predicate actually applied (only when available). */
  activeExclude?: FilterCondition[];
  /** Whether DEFAULT_EXCLUDE was used (only when available). */
  usedDefaultExclude?: boolean;
}

export interface GraphAttachResult<T> extends GraphAttachMeta {
  /** Same length + order as the input results. Annotated iff graphAvailable. */
  results: Array<T & { graph?: GraphBlock }>;
}

/**
 * Guarded, ONE-CALL orchestration consumed by `semantic_search`.
 *
 * Calls getGraphSignals ONCE (DEFAULT_EXCLUDE — `undefined` exclude → same as
 * analyze_link_hierarchy) inside try/catch:
 *   - SUCCESS → annotate every hit (Level A + B) and echo activeExclude +
 *     usedDefaultExclude; graphAvailable:true.
 *   - FAILURE → return results UN-annotated (no `graph` key), graphAvailable:false
 *     + a reason. NEVER throws — the caller stays isError:false.
 *
 * `getSignals` is injectable purely for testing the failure path without Ollama
 * or a real graph build; production uses the real getGraphSignals.
 */
export async function attachGraphSignals<T extends PathBearing>(opts: {
  config: Config;
  vault?: string;
  results: T[];
  getSignals?: (
    config: Config,
    vaultName?: string,
    exclude?: undefined
  ) => Promise<GraphSignals>;
}): Promise<GraphAttachResult<T>> {
  const { config, vault, results } = opts;
  const getSignals = opts.getSignals ?? defaultGetGraphSignals;

  try {
    // ONE call, DEFAULT_EXCLUDE (undefined) → Level A + Level B from one map.
    const signals = await getSignals(config, vault, undefined);
    const annotated = annotateWithGraph(results, signals.signals);
    return {
      results: annotated,
      graphAvailable: true,
      activeExclude: signals.activeExclude,
      usedDefaultExclude: signals.usedDefaultExclude
    };
  } catch (err) {
    // GLOBAL failure → un-annotated, never an error. Ordering untouched.
    return {
      results,
      graphAvailable: false,
      graphUnavailableReason: `graph signals unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
}
