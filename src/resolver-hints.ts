/**
 * Resolver-hint utilities for Obsidian MCP
 *
 * Provides hint constants and fuzzy-match helpers so that vault/note resolution
 * failures surface actionable suggestions instead of bare "not found" messages.
 *
 * Zero intra-project imports — safe to import from config.ts without creating cycles.
 */

// ─── Hint constants ────────────────────────────────────────────────────────────

/**
 * Injected into unknown-vault errors to guide the AI toward the orientation tool.
 * Named constant so tests can assert on it structurally.
 */
export const VAULT_NOT_FOUND_HINT =
  'Call get_started to see all configured vault names, then retry with the correct vault.';

/**
 * Injected into note/path not-found errors to guide the AI toward the search tools.
 * Named constant so tests can assert on it structurally.
 */
export const NOTE_NOT_FOUND_HINT =
  'Use find_note_by_name to locate a note by title across all vaults, ' +
  'or use search_content to search by text content.';

// ─── Structured error response helper ─────────────────────────────────────────

/**
 * If the caught error carries `closest_matches` + `hint` (as attached by resolveVault),
 * returns a structured ToolResponse so the caller sees actionable JSON instead of a
 * plain error string. Falls back to a generic message for ordinary errors.
 *
 * Mirrors the shape of the ENOENT note-not-found branch in the read_file handler.
 */
export function formatVaultError(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const err = error as Error & { closest_matches?: string[]; hint?: string };
  if (err instanceof Error && Array.isArray(err.closest_matches) && err.hint) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: err.message,
          closest_matches: err.closest_matches,
          hint: err.hint
        }, null, 2)
      }],
      isError: true
    };
  }
  // Generic fallback for non-vault errors
  return {
    content: [{ type: 'text', text: String(error) }],
    isError: true
  };
}

// ─── Fuzzy match helpers ───────────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings (O(m*n) DP).
 * Both strings are compared case-insensitively.
 */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  // dp[i][j] = edit distance between s[0..i-1] and t[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s[i - 1] === t[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Return up to `limit` candidates from `names` that are closest to `query`.
 *
 * A candidate is included if it passes at least one of:
 *  - case-insensitive substring: query contains candidate or candidate contains query
 *  - edit distance ≤ maxDistance (tightened so noise is filtered out)
 *
 * Results are sorted by edit distance ascending (closest first).
 *
 * @param query       - The user-supplied (possibly misspelled) name.
 * @param names       - The pool of candidate names to match against.
 * @param limit       - Maximum number of suggestions to return (default 3).
 * @param maxDistance - Maximum edit distance to include (default 3).
 */
export function closestMatches(
  query: string,
  names: string[],
  limit = 3,
  maxDistance = 3
): string[] {
  const q = query.toLowerCase();

  const scored = names
    .map(name => {
      const n = name.toLowerCase();
      const dist = editDistance(q, n);
      const substring = q.includes(n) || n.includes(q);
      return { name, dist, substring };
    })
    .filter(({ dist, substring }) => substring || dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist);

  return scored.slice(0, limit).map(s => s.name);
}
