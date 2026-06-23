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
  /**
   * Which provider built the graph: "obsidian" (eval bridge) or "filesystem".
   * Present ONLY on success — on the failure branch the provider is genuinely
   * unknown (the build threw before a provider was selected), so it is omitted.
   */
  provider?: 'obsidian' | 'filesystem';
  /**
   * Present ONLY when the graph built (graphAvailable:true) BUT the Obsidian
   * provider was attempted and degraded to the filesystem approximation (#32).
   * Sits NEXT TO `provider` on the SUCCESS branch — it is NOT graphUnavailable
   * (the graph is usable, just from the fallback provider).
   */
  providerFallbackReason?: string;
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
      provider: signals.provider,
      // Additive (#32): only when the Obsidian provider degraded to filesystem.
      ...(signals.providerFallbackReason
        ? { providerFallbackReason: signals.providerFallbackReason }
        : {}),
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

// ─── Cross-vault orchestration (PR-A / issue #25) ────────────────────────────

/** A cross-vault hit must carry a vault-relative `path` AND its source `vault`. */
interface VaultPathBearing extends PathBearing {
  vault: string;
}

/** Per-vault graph availability — the cross-vault map (NOT a single global flag). */
export interface PerVaultGraphMeta {
  graphAvailable: boolean;
  graphUnavailableReason?: string;
  provider?: 'obsidian' | 'filesystem';
  /**
   * Per-vault Obsidian→filesystem degrade reason (#32). Present ONLY when that
   * vault's graph built via the fallback provider (sits with `provider` on the
   * graphAvailable:true branch).
   */
  providerFallbackReason?: string;
}

export interface CrossVaultGraphResult<T> {
  /**
   * SAME length + SAME order as the input results (global similarity-desc is
   * never touched). Each hit from a vault WITH a successful graph build carries
   * a `graph` block (object | null per the single-vault miss semantics); hits
   * from a vault whose build failed are returned UN-annotated (no `graph` key).
   */
  results: Array<T & { graph?: GraphBlock }>;
  /** Per-vault map: { vaultName → { graphAvailable, graphUnavailableReason?, provider } }. */
  graphByVault: Record<string, PerVaultGraphMeta>;
}

/**
 * Cross-vault graph annotation for `semantic_search_all`.
 *
 * RATIFIED CONTRACT (PR-A, issue #25):
 *   - Calls getGraphSignals (via the guarded `attachGraphSignals`) ONCE PER
 *     VAULT THAT HAS HITS — a cost-minimizer that skips hit-less vaults entirely.
 *   - Each per-vault build is wrapped in try/catch (inherited from
 *     attachGraphSignals) so ONE vault's failure cannot blank the others'.
 *   - Ordering is NEVER changed: the returned array preserves the exact input
 *     order (the caller's similarity-desc slice). Annotated copies are merged
 *     back by OBJECT IDENTITY — never by path — so duplicate filenames across
 *     vaults (e.g. Alpha.md in two vaults) never cross-annotate.
 *   - Per-hit `graph: null` semantics are identical to single-vault (a miss in a
 *     successfully-built vault's signal map → null, key always present).
 *   - `graphAvailable` is surfaced as a PER-VAULT MAP so a degraded vault is
 *     visible; `provider` is surfaced per vault (additive).
 *
 * Pure orchestration over an injectable `getSignals` → fully testable headless
 * (no Ollama, no real graph build).
 */
export async function annotateCrossVault<T extends VaultPathBearing>(opts: {
  config: Config;
  results: T[];
  getSignals?: (
    config: Config,
    vaultName?: string,
    exclude?: undefined
  ) => Promise<GraphSignals>;
}): Promise<CrossVaultGraphResult<T>> {
  const { config, results } = opts;

  // Group hits by source vault, PRESERVING each original object reference so we
  // can merge annotated copies back by identity. Insertion order tracks the
  // first appearance of each vault in the (already similarity-sorted) results.
  const byVault = new Map<string, T[]>();
  for (const r of results) {
    let group = byVault.get(r.vault);
    if (!group) {
      group = [];
      byVault.set(r.vault, group);
    }
    group.push(r);
  }

  const graphByVault: Record<string, PerVaultGraphMeta> = {};
  // identity → annotated copy (only for vaults whose build succeeded).
  const annotatedByRef = new Map<T, T & { graph: GraphBlock }>();

  // One getGraphSignals call per vault WITH hits (hit-less vaults → zero calls).
  for (const [vaultName, group] of byVault) {
    const attach = await attachGraphSignals({
      config,
      vault: vaultName,
      results: group,
      getSignals: opts.getSignals
    });

    graphByVault[vaultName] = {
      graphAvailable: attach.graphAvailable,
      ...(attach.graphAvailable
        ? {
            provider: attach.provider,
            // Additive (#32): per-vault Obsidian→filesystem degrade reason.
            ...(attach.providerFallbackReason
              ? { providerFallbackReason: attach.providerFallbackReason }
              : {})
          }
        : { graphUnavailableReason: attach.graphUnavailableReason })
    };

    if (attach.graphAvailable) {
      // attach.results is index-aligned with `group` (annotateWithGraph maps in
      // order). Pair each original ref to its annotated copy by index.
      for (let i = 0; i < group.length; i++) {
        annotatedByRef.set(group[i], attach.results[i] as T & { graph: GraphBlock });
      }
    }
    // On per-vault failure: leave its hits un-annotated (no map entry → emitted as-is).
  }

  // Rebuild in the ORIGINAL order: annotated copy where the vault built, else
  // the original (un-annotated) reference.
  const merged = results.map((r) => annotatedByRef.get(r) ?? r);

  return { results: merged, graphByVault };
}
