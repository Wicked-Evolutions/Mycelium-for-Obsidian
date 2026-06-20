/**
 * Graph-layer type definitions for L4 analyze_link_hierarchy.
 *
 * The graph is built provider-agnostically (Obsidian eval-bridge primary,
 * filesystem fallback) and normalized to a single edge shape:
 *   one unique `source → target` edge with an occurrence `count`.
 * Paths are vault-relative WITH the `.md` extension (Obsidian resolvedLinks
 * parity) so the two providers yield byte-identical edge shapes.
 */

import { FilterCondition } from '../tools/query.js';

/**
 * A unique directed edge from one note to another, with the number of times
 * the link occurs in the source (embeds counted). Targets that don't resolve
 * to a real note are EXTERNAL (out-only) and are tracked separately.
 */
export interface GraphEdge {
  source: string; // vault-relative path, with .md
  target: string; // vault-relative path, with .md (resolved) — never unresolved
  count: number;  // occurrences in source (embeds included)
}

/**
 * The raw, exclusion-INDEPENDENT graph. This is the expensive part and is
 * cached by `vault + stat-digest` only — it never depends on the exclude
 * predicate.
 */
export interface BaseGraph {
  /** All node paths (vault-relative, with .md). */
  nodes: string[];
  /** Unique resolved edges with counts. */
  edges: GraphEdge[];
  /** node → unique inbound count (distinct sources, base graph). */
  inDegree: Map<string, number>;
  /** node → unique outbound count (distinct resolved targets, base graph). */
  outDegree: Map<string, number>;
  /** Which provider built this graph: "obsidian" (eval) or "filesystem". */
  provider: 'obsidian' | 'filesystem';
}

/**
 * Per-node ranked signals (computed AFTER exclusion pruning).
 */
export interface NodeSignals {
  level: number | null;       // L0..L5; null if excluded
  inDegree: number;           // from BASE graph (raw)
  outDegree: number;          // from BASE graph (raw)
  inOutRatio: number;         // inDegree / max(outDegree, 1)
  pagerank: number | null;    // null if excluded
  archived: boolean;          // matched the exclusion predicate
  excluded: boolean;          // pruned before ranking (== archived)
}

/**
 * Output of getGraphSignals(): the per-node signal map plus metadata.
 */
export interface GraphSignals {
  vault: string;
  provider: 'obsidian' | 'filesystem';
  /** path → signals (every base-graph node present). */
  signals: Map<string, NodeSignals>;
  /** The exclusion predicate that was actually applied (defaults included). */
  activeExclude: FilterCondition[];
  /** Whether the default exclusion was used (no caller override). */
  usedDefaultExclude: boolean;
  /** Count of nodes pruned before ranking. */
  excludedCount: number;
  /** Total node count (base graph). */
  totalNodes: number;
  /** Whether small-vault coarse banding was used instead of percentiles. */
  smallVault: boolean;
}

/**
 * A graph-source provider yields normalized edges + the node set for a vault.
 * Both the filesystem and Obsidian-eval providers implement this.
 */
export interface GraphProvider {
  readonly name: 'obsidian' | 'filesystem';
  build(vaultPath: string): Promise<ProviderResult>;
}

export interface ProviderResult {
  /** All note paths in the vault (vault-relative, with .md). */
  nodes: string[];
  /**
   * resolvedLinks-shape adjacency: source → { target → count }.
   * Targets are resolved vault-relative paths (with .md). Unresolved links
   * are NOT included here (they're out-only and don't create edges).
   */
  resolvedLinks: Map<string, Map<string, number>>;
}
