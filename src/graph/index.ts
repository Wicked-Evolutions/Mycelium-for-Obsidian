/**
 * Graph layer for L4 analyze_link_hierarchy — public surface.
 *
 * The reusable hook for later graph-aware search is getGraphSignals; search is
 * NOT wired in this pass.
 */

export * from './types.js';
export { buildVaultGraph, normalize } from './build.js';
export {
  FilesystemProvider,
  ObsidianProvider,
  selectProvider
} from './providers.js';
export {
  resolveExclude,
  computeExcludedSet,
  DEFAULT_EXCLUDE,
  DEFAULT_NODE_TYPES
} from './exclude.js';
export { pageRank, PAGERANK_DEFAULTS } from './pagerank.js';
export { assignLevels, levelHistogram, SMALL_VAULT_THRESHOLD } from './levels.js';
export {
  getGraphSignals,
  getBaseGraph,
  clearGraphCaches,
  invalidateGraphCache
} from './signals.js';
export { computeGraphDigest, hashExclude } from './digest.js';
