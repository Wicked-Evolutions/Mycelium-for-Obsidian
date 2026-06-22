/**
 * Declared exclusion that PRUNES before ranking (Layer 2).
 *
 * Reuses the query_notes filter shape (FilterCondition[]) and the EXACT operator
 * semantics via the exported matchesCondition. The default exclusion is:
 *   mycelium_exclude == true  OR  node_type in [generated, archive, index, log]
 *
 * The default is documented and never silent — every response echoes the
 * predicate actually applied (activeExclude), including defaults.
 *
 * NOTE on semantics: query_notes ANDs its conditions. The DEFAULT exclusion is
 * an OR of two predicates, which a flat FilterCondition[] (AND) cannot express.
 * So the default is implemented as a dedicated OR matcher, while a CALLER-
 * supplied exclude.where is treated as query_notes does (a note is excluded if
 * it matches ALL supplied conditions). activeExclude echoes whichever applied.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { FilterCondition, matchesCondition } from '../tools/query.js';
import { parseMarkdownFile } from '../parsers/markdown.js';

export const DEFAULT_NODE_TYPES = ['generated', 'archive', 'index', 'log'];

/**
 * The default exclusion predicate, echoed verbatim via activeExclude.
 * (mycelium_exclude == true) OR (node_type in [...]).
 */
export const DEFAULT_EXCLUDE: FilterCondition[] = [
  { field: 'mycelium_exclude', op: 'equals', value: true },
  { field: 'node_type', op: 'in', value: DEFAULT_NODE_TYPES }
];

export interface ExcludeInput {
  where?: FilterCondition[];
}

export interface ResolvedExclude {
  /** The predicate actually applied (defaults included). */
  activeExclude: FilterCondition[];
  /** Whether the default was used (no caller override). */
  usedDefault: boolean;
  /** Predicate evaluator over a frontmatter object. */
  matches: (frontmatter: Record<string, unknown>) => boolean;
}

/**
 * Resolve the exclude input into an evaluable predicate + the echo payload.
 *
 * - No caller `where` (undefined): use DEFAULT_EXCLUDE with OR semantics.
 * - Caller `where: []` (explicit empty): exclude NOTHING (opt out of defaults).
 * - Caller `where: [...]`: AND semantics (query_notes parity); a note is
 *   excluded when it matches ALL conditions.
 */
export function resolveExclude(input?: ExcludeInput): ResolvedExclude {
  if (!input || input.where === undefined) {
    return {
      activeExclude: DEFAULT_EXCLUDE,
      usedDefault: true,
      matches: (fm) => DEFAULT_EXCLUDE.some((c) => matchesCondition(fm, c))
    };
  }

  const where = input.where;
  if (where.length === 0) {
    return {
      activeExclude: [],
      usedDefault: false,
      matches: () => false
    };
  }

  return {
    activeExclude: where,
    usedDefault: false,
    matches: (fm) => where.every((c) => matchesCondition(fm, c))
  };
}

/**
 * Evaluate the exclusion predicate against every node in the vault, returning
 * the set of EXCLUDED node paths (vault-relative, with .md). Reads frontmatter
 * for each node path.
 */
export async function computeExcludedSet(
  vaultPath: string,
  nodes: string[],
  resolved: ResolvedExclude
): Promise<Set<string>> {
  const excluded = new Set<string>();
  // If the predicate can never match (empty caller where), short-circuit.
  if (resolved.activeExclude.length === 0) return excluded;

  for (const rel of nodes) {
    let frontmatter: Record<string, unknown> = {};
    try {
      const parsed = await parseMarkdownFile(rel, vaultPath);
      frontmatter = parsed.frontmatter || {};
    } catch {
      // Unparseable / missing file: treat as no frontmatter → not excluded.
      frontmatter = {};
    }
    if (resolved.matches(frontmatter)) {
      excluded.add(rel);
    }
  }

  return excluded;
}

/**
 * Convenience: read frontmatter for a single node (used in contributor breakdown
 * property summaries). Returns {} on any failure.
 */
export async function readFrontmatter(
  vaultPath: string,
  rel: string
): Promise<Record<string, unknown>> {
  try {
    const abs = path.join(vaultPath, rel);
    await fs.access(abs);
    const parsed = await parseMarkdownFile(rel, vaultPath);
    return parsed.frontmatter || {};
  } catch {
    return {};
  }
}
