export const COMPLETENESS_REASON_LIMIT = 8;

export const COMPLETENESS_REASONS = [
  'directory_unavailable',
  'file_metadata_unavailable',
  'file_unreadable',
  'file_unparseable',
  'file_too_large',
  'vault_unavailable',
  'vault_unindexed',
  'embedding_index_incompatible',
  'vault_search_failed',
  'scan_failure',
] as const;

export type CompletenessReason = typeof COMPLETENESS_REASONS[number];

export interface ExactResultMetadata {
  total: number;
  returned: number;
  truncated: boolean;
  has_more: boolean;
}

export interface PartialCompleteness {
  state: 'partial';
  scanned: number;
  skipped: number;
  reasons: CompletenessReason[];
}

const reasonSet = new Set<string>(COMPLETENESS_REASONS);

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function exactResultMetadata(total: number, returned: number): ExactResultMetadata {
  assertCount('total', total);
  assertCount('returned', returned);
  if (returned > total) {
    throw new RangeError('returned cannot exceed total');
  }
  const truncated = returned < total;
  return { total, returned, truncated, has_more: truncated };
}

export function limitReachedMetadata(limitReached: boolean): { limit_reached: true } | Record<string, never> {
  return limitReached ? { limit_reached: true } : {};
}

export function partialCompletenessMetadata(
  scanned: number,
  skipped: number,
  reasons: readonly CompletenessReason[]
): { completeness: PartialCompleteness } | Record<string, never> {
  assertCount('scanned', scanned);
  assertCount('skipped', skipped);
  if (skipped === 0) return {};

  const bounded = Array.from(new Set(reasons))
    .filter(reason => reasonSet.has(reason))
    .slice(0, COMPLETENESS_REASON_LIMIT) as CompletenessReason[];

  return {
    completeness: {
      state: 'partial',
      scanned,
      skipped,
      reasons: bounded.length > 0 ? bounded : ['scan_failure'],
    },
  };
}
