/**
 * L4 — analyze_link_hierarchy.
 *
 * Orientation leveling: builds the vault link graph (Obsidian eval-bridge
 * primary, filesystem fallback), prunes declared exclusions BEFORE ranking,
 * computes unique degree + in/out ratio + PageRank, and assigns L0..L5 levels
 * via percentile banding (leaf floor at in-degree 0). Surfaces signals +
 * contributor breakdown so the user can declare exclusions and re-rank.
 *
 * Levels are STRUCTURAL ORIENTATION, not importance.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import {
  GraphDecisionState,
  GraphProviderMode,
  GraphTargetReadiness,
  ToolRequestContext,
  ToolResponse
} from '../types/index.js';
import { formatVaultError, VAULT_NOT_FOUND_HINT } from '../resolver-hints.js';
import { limitParam } from './schema-helpers.js';
import {
  getFilesystemGraphSignals,
  getGraphSignalsFromBase,
  invalidateGraphCache
} from '../graph/signals.js';
import { GraphSignals, NodeSignals } from '../graph/types.js';
import {
  canonicalizeVaultPath,
  abortableYield,
  inspectRegisteredVault,
  isAbortError,
  RegisteredVaultTarget,
  throwIfAborted
} from '../cli/vault-target.js';
import { computeGraphDigest } from '../graph/digest.js';
import {
  getPreparedExactGraph,
  PreparedExactGraphSnapshot,
  withPreparedGraphLock
} from '../graph/prepared.js';

const LEVELS_NOTE = 'levels are structural orientation, not importance.';

export const graphTools: Tool[] = [
  {
    name: 'analyze_link_hierarchy',
    description:
      'Orientation leveling over one explicit vault link graph. Exact mode (default) is side-effect-free and ranks only a prepared Obsidian base-graph snapshot; use open_vault separately to open/prepare when needed. Filesystem mode is an explicit approximation and never contacts Obsidian. No silent opening or provider fallback occurs.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Configured vault name. Required; no default is inferred.'
        },
        providerMode: {
          type: 'string',
          enum: ['exact', 'filesystem'],
          default: 'exact',
          description:
            'exact (default) consumes a prepared Obsidian snapshot without contacting Obsidian; filesystem explicitly selects approximate file-based analysis.'
        },
        scope: {
          type: 'string',
          description:
            'Directory prefix to filter the OUTPUT only (e.g., "03 Projects"). Ranking always uses the whole-vault graph minus exclusions.'
        },
        limit: limitParam(50, 'Maximum ranked nodes to return in the detail list'),
        compact: {
          type: 'boolean',
          description: 'Omit the per-node contributor breakdown for a smaller response',
          default: false
        },
        exclude: {
          type: 'object',
          description:
            'Declared exclusion that PRUNES notes before ranking (reuses query_notes filter shape). Default (if omitted): mycelium_exclude == true OR node_type in [generated, archive, index, log]. Pass {"where": []} to disable defaults and rank everything.',
          properties: {
            where: {
              type: 'array',
              description:
                'Filter conditions (field, op, value). A note is excluded when it matches ALL conditions. Operators match query_notes.',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string', description: 'Frontmatter field name' },
                  op: {
                    type: 'string',
                    description:
                      'Operator: equals, not_equals, contains, not_contains, in, not_in, exists, not_exists, greater_than, less_than'
                  },
                  value: { description: 'Value to compare against (not needed for exists/not_exists)' }
                },
                required: ['field', 'op']
              }
            }
          }
        }
      },
      // #33-B: the authoritative orientation map REQUIRES an explicit vault so it
      // never silently ranks the default vault. get_vault_health stays defaulted.
      required: ['vault']
    }
  }
];

export const CLOSED_VAULT_DECISION_MESSAGE =
  'That vault is not currently open. What would you like me to do?\n' +
  '1. Analyze it approximately from the files.\n' +
  '2. Open it and analyze the exact Obsidian graph.';

interface GraphHandlerDependencies {
  canonicalize?: typeof canonicalizeVaultPath;
  inspect?: typeof inspectRegisteredVault;
  getSnapshot?: typeof getPreparedExactGraph;
  digest?: typeof computeGraphDigest;
  rankExact?: typeof getGraphSignalsFromBase;
  rankFilesystem?: typeof getFilesystemGraphSignals;
}

interface AnalyzeArgs {
  vault?: string;
  providerMode?: GraphProviderMode;
  scope?: string;
  limit?: number;
  compact?: boolean;
  exclude?: { where?: import('../graph/exclude.js').ExcludeInput['where'] };
}

export function createGraphHandlers(
  config: Config,
  dependencies: GraphHandlerDependencies = {}
) {
  const canonicalize = dependencies.canonicalize ?? canonicalizeVaultPath;
  const inspect = dependencies.inspect ?? inspectRegisteredVault;
  const getSnapshot = dependencies.getSnapshot ?? getPreparedExactGraph;
  const digest = dependencies.digest ?? computeGraphDigest;
  const rankExact = dependencies.rankExact ?? getGraphSignalsFromBase;
  const rankFilesystem = dependencies.rankFilesystem ?? getFilesystemGraphSignals;

  return {
    analyze_link_hierarchy: async (
      args: AnalyzeArgs,
      context?: ToolRequestContext
    ): Promise<ToolResponse> => {
      const mode = args.providerMode ?? 'exact';
      let decision = makeDecision(mode, mode === 'filesystem' ? 'not_probed' : 'probe_failed');

      try {
        if (!args.vault) return missingVaultResponse(config);
        if (mode !== 'exact' && mode !== 'filesystem') {
          return jsonResponse({
            error: 'invalid_provider_mode',
            message: 'providerMode must be "exact" or "filesystem".'
          }, true);
        }

        const vault = resolveVault(config, args.vault);
        const signal = context?.signal;

        if (mode === 'filesystem') {
          decision = makeDecision('filesystem', 'not_probed', false, false, true);
          const result = await rankFilesystem(
            config,
            vault.name,
            args.exclude,
            signal
          );
          return await renderGraphResult(result, args, decision, undefined, signal);
        }

        if (config.disabledTools.has('eval_obsidian')) {
          decision = makeDecision('exact', 'eval_disabled');
          return decisionRequiredResponse(
            vault.name,
            decision,
            'Exact graph preparation is unavailable because eval_obsidian is disabled.',
            false
          );
        }

        const canonicalPath = await canonicalize(vault.path);
        return await withPreparedGraphLock(canonicalPath, signal, async () => {
          const snapshot = getSnapshot(canonicalPath);
          if (!snapshot) {
            const target = await inspect(config, vault.name);
            throwIfAborted(signal);
            decision = makeDecision(
              'exact',
              readinessWithoutSnapshot(target),
              target.probeInvoked
            );
            return noSnapshotResponse(
              vault.name,
              target,
              decision,
              preparationBlockedReason(config)
            );
          }

          const targetBefore = await inspect(config, vault.name);
          throwIfAborted(signal);
          decision = makeDecision('exact', 'prepared', targetBefore.probeInvoked);
          if (!snapshotIdentityMatches(snapshot, targetBefore, canonicalPath)) {
            invalidateGraphCache(canonicalPath);
            decision = {
              ...decision,
              targetReadiness: readinessForInvalidSnapshot(targetBefore)
            };
            return exactUnavailableResponse(
              vault.name,
              decision,
              'The prepared exact snapshot no longer matches this registered vault. A fresh exact snapshot is required.',
              preparationBlockedReason(config)
            );
          }

          const beforeDigest = await digest(canonicalPath, signal);
          if (beforeDigest !== snapshot.digest) {
            invalidateGraphCache(canonicalPath);
            decision = { ...decision, targetReadiness: 'stale' };
            return exactUnavailableResponse(
              vault.name,
              decision,
              'The vault changed after the exact snapshot was prepared. A fresh exact snapshot is required.',
              preparationBlockedReason(config)
            );
          }

          decision = { ...decision, analysisInvoked: true };
          const result = await rankExact(
            vault.name,
            canonicalPath,
            snapshot.graph,
            args.exclude,
            signal
          );

          decision = {
            ...decision,
            targetReadiness: 'prepared'
          };
          const rendered = await renderGraphResult(
            result,
            args,
            decision,
            snapshot.capturedAt,
            signal
          );

          // Rendering can yield for large responses. Verify external identity
          // first and content last, then return without any further async work.
          const targetAfter = await inspect(config, vault.name);
          const afterDigest = await digest(canonicalPath, signal);
          throwIfAborted(signal);
          if (
            beforeDigest !== afterDigest ||
            !snapshotIdentityMatches(snapshot, targetAfter, canonicalPath)
          ) {
            invalidateGraphCache(canonicalPath);
            decision = {
              ...decision,
              targetReadiness: 'stale',
              probeInvoked: decision.probeInvoked || targetAfter.probeInvoked
            };
            return exactUnavailableResponse(
              vault.name,
              decision,
              'The vault or its registration changed during analysis. The result was discarded; a fresh exact snapshot is required.',
              preparationBlockedReason(config)
            );
          }

          return rendered;
        });
      } catch (error) {
        const err = error as Error & { closest_matches?: string[]; hint?: string };
        if (err instanceof Error && Array.isArray(err.closest_matches) && err.hint) {
          return formatVaultError(error);
        }
        if (isAbortError(error)) {
          return jsonResponse({
            vault: args.vault ?? null,
            status: 'cancelled',
            decisionState: decision,
            message: 'Link hierarchy analysis was cancelled. No vault was opened and no fallback ran.'
          }, true);
        }
        return jsonResponse({
          vault: args.vault ?? null,
          status: mode === 'exact' ? 'exact_unavailable' : 'analysis_failed',
          decisionState: decision,
          message: mode === 'exact'
            ? 'Exact link hierarchy analysis failed safely. No filesystem fallback ran.'
            : 'Filesystem link hierarchy analysis failed.'
        }, true);
      }
    }
  };
}

async function renderGraphResult(
  result: GraphSignals,
  args: AnalyzeArgs,
  decision: GraphDecisionState,
  snapshotCapturedAt?: string,
  signal?: AbortSignal
): Promise<ToolResponse> {
  if (result.totalNodes === 0) {
    return jsonResponse({
      vault: result.vault,
      status: 'complete',
      provider: result.provider,
      providerState: result.providerState,
      decisionState: decision,
      ...(snapshotCapturedAt ? { snapshotCapturedAt } : {}),
      emptyVault: true,
      totalNodes: 0,
      message: 'This vault has 0 notes. Pick another configured vault.'
    });
  }

  const compact = args.compact === true;
  const base = result.baseGraph;
  const contributorsOf = new Map<string, Array<{ source: string; count: number }>>();
  if (!compact) {
    for (let index = 0; index < base.edges.length; index += 1) {
      if (signal && index % 512 === 0) await abortableYield(signal);
      const edge = base.edges[index];
      const sourceSignal = result.signals.get(edge.source);
      if (sourceSignal?.excluded) continue;
      const contributors = contributorsOf.get(edge.target) ?? [];
      contributors.push({ source: edge.source, count: edge.count });
      contributorsOf.set(edge.target, contributors);
    }
  }

  const ranked: Array<{ path: string; sig: NodeSignals }> = [];
  const levelsForHistogram = new Map<string, number>();
  let signalIndex = 0;
  for (const [nodePath, nodeSignal] of result.signals) {
    if (signalIndex % 512 === 0) await abortableYield(signal);
    signalIndex += 1;
    if (!nodeSignal.excluded && nodeSignal.level !== null) {
      levelsForHistogram.set(nodePath, nodeSignal.level);
    }
    if (!nodeSignal.excluded) ranked.push({ path: nodePath, sig: nodeSignal });
  }
  await abortableYield(signal);
  ranked.sort((left, right) => (right.sig.pagerank ?? 0) - (left.sig.pagerank ?? 0));
  await abortableYield(signal);

  const scoped: Array<{ path: string; sig: NodeSignals }> = [];
  for (let index = 0; index < ranked.length; index += 1) {
    if (signal && index % 512 === 0) await abortableYield(signal);
    const entry = ranked[index];
    if (!args.scope || entry.path.startsWith(args.scope)) scoped.push(entry);
  }
  const limit = args.limit ?? 50;
  const detail: Array<Record<string, unknown>> = [];
  const returned = scoped.slice(0, limit);
  for (let index = 0; index < returned.length; index += 1) {
    if (index % 32 === 0) await abortableYield(signal);
    const entry = returned[index];
    const node: Record<string, unknown> = {
      path: entry.path,
      level: entry.sig.level,
      pagerank: entry.sig.pagerank,
      degree: entry.sig.inDegree + entry.sig.outDegree,
      inDegree: entry.sig.inDegree,
      outDegree: entry.sig.outDegree,
      inOutRatio: Number(entry.sig.inOutRatio.toFixed(4)),
      archived: entry.sig.archived,
      excluded: entry.sig.excluded
    };
    if (!compact) {
      const contributorRows = [];
      const contributors = contributorsOf.get(entry.path) ?? [];
      for (let contributorIndex = 0; contributorIndex < contributors.length; contributorIndex += 1) {
        if (contributorIndex % 256 === 0) {
          await abortableYield(signal);
        }
        const contributor = contributors[contributorIndex];
        contributorRows.push({
          source: contributor.source,
          edgeCount: contributor.count,
          pagerankShare: result.signals.get(contributor.source)?.pagerank ?? null
        });
      }
      contributorRows.sort(
        (left, right) => (right.pagerankShare ?? 0) - (left.pagerankShare ?? 0)
      );
      node.topContributors = contributorRows.slice(0, 5);
    }
    detail.push(node);
  }

  const histogram = await renderLevelHistogram(
    levelsForHistogram,
    result.excludedCount,
    signal
  );

  return jsonResponse({
    vault: result.vault,
    status: 'complete',
    provider: result.provider,
    providerState: result.providerState,
    decisionState: decision,
    ...(snapshotCapturedAt ? { snapshotCapturedAt } : {}),
    ...(result.providerFallbackReason
      ? { providerFallbackReason: result.providerFallbackReason }
      : {}),
    totalNodes: result.totalNodes,
    resolvedEdgeCount: result.resolvedEdgeCount,
    unresolvedLinkCount: result.unresolvedLinkCount,
    distinctUnresolvedTargets: result.distinctUnresolvedTargets,
    rankedNodes: ranked.length,
    excludedNodes: result.excludedCount,
    smallVault: result.smallVault,
    scope: args.scope || null,
    returned: detail.length,
    activeExclude: result.activeExclude,
    usedDefaultExclude: result.usedDefaultExclude,
    levelBands: {
      L0: '>= p99 (top hubs)',
      L1: 'p95-p99',
      L2: 'p80-p95',
      L3: 'p50-p80',
      L4: '< p50',
      L5: 'post-exclusion in-degree 0 (leaf floor)'
    },
    histogram,
    nodes: detail,
    note: LEVELS_NOTE
  });
}

async function renderLevelHistogram(
  levels: Map<string, number>,
  excludedCount: number,
  signal?: AbortSignal
): Promise<Array<{ level: number | 'excluded'; count: number }>> {
  const counts = new Map<number, number>();
  let index = 0;
  for (const level of levels.values()) {
    if (signal && index % 512 === 0) await abortableYield(signal);
    index += 1;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const histogram: Array<{ level: number | 'excluded'; count: number }> = [];
  for (let level = 0; level <= 5; level += 1) {
    histogram.push({ level, count: counts.get(level) ?? 0 });
  }
  if (excludedCount > 0) histogram.push({ level: 'excluded', count: excludedCount });
  return histogram;
}

function makeDecision(
  requestedMode: GraphProviderMode,
  targetReadiness: GraphTargetReadiness,
  probeInvoked = false,
  openInvoked = false,
  analysisInvoked = false
): GraphDecisionState {
  return {
    requestedMode,
    targetReadiness,
    probeInvoked,
    openInvoked,
    analysisInvoked
  };
}

function jsonResponse(payload: Record<string, unknown>, isError = false): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

function missingVaultResponse(config: Config): ToolResponse {
  const availableNames = config.vaults.map((vault) => vault.name);
  const error = new Error(
    `Missing required "vault". Available: ${availableNames.join(', ')}.`
  ) as Error & { closest_matches: string[]; hint: string };
  error.closest_matches = [];
  error.hint = VAULT_NOT_FOUND_HINT;
  return formatVaultError(error);
}

function readinessWithoutSnapshot(target: RegisteredVaultTarget): GraphTargetReadiness {
  if (target.status === 'open') return 'open_unprepared';
  return target.status;
}

function noSnapshotResponse(
  vault: string,
  target: RegisteredVaultTarget,
  decision: GraphDecisionState,
  preparationBlocked?: string
): ToolResponse {
  if (target.status === 'closed') {
    if (preparationBlocked) {
      return decisionRequiredResponse(
        vault,
        decision,
        `That vault is not currently open. Exact graph preparation is unavailable because ${preparationBlocked} You can analyze it approximately from the files.`,
        false
      );
    }
    return decisionRequiredResponse(vault, decision, CLOSED_VAULT_DECISION_MESSAGE, true);
  }
  if (target.status === 'open') {
    return decisionRequiredResponse(
      vault,
      decision,
      preparationBlocked
        ? `That vault is open, but no exact graph snapshot is prepared. Exact preparation is unavailable because ${preparationBlocked} You can analyze it approximately from the files.`
        : 'That vault is open, but no exact graph snapshot is prepared. Run open_vault to prepare it, or explicitly choose filesystem analysis.',
      preparationBlocked === undefined
    );
  }
  const message = target.status === 'unregistered'
    ? 'That configured vault is not registered in Obsidian. You can analyze it approximately from the files.'
    : target.status === 'ambiguous'
      ? 'The configured path matches more than one Obsidian registration. Resolve the registration ambiguity or choose filesystem analysis.'
      : target.status === 'unsupported_platform'
        ? 'Exact vault preparation is unsupported on this platform. You can choose filesystem analysis.'
        : 'Obsidian readiness could not be verified. You can choose filesystem analysis or repair the local Obsidian registration.';
  return decisionRequiredResponse(vault, decision, message, false);
}

function preparationBlockedReason(config: Config): string | undefined {
  if (config.readOnly) return 'open_vault is blocked by read-only mode.';
  if (config.disabledTools.has('open_vault')) {
    return 'open_vault is disabled in this server configuration.';
  }
  return undefined;
}

function decisionRequiredResponse(
  vault: string,
  decision: GraphDecisionState,
  message: string,
  includeOpenAction: boolean
): ToolResponse {
  const actions: Array<Record<string, unknown>> = [
    {
      label: 'Analyze approximately from the files',
      tool: 'analyze_link_hierarchy',
      arguments: { vault, providerMode: 'filesystem' }
    }
  ];
  if (includeOpenAction) {
    actions.push({
      label: 'Open it and prepare the exact Obsidian graph',
      tool: 'open_vault',
      arguments: { vault }
    });
  }
  return jsonResponse({
    vault,
    status: 'decision_required',
    decisionState: decision,
    message,
    actions
  });
}

function exactUnavailableResponse(
  vault: string,
  decision: GraphDecisionState,
  message: string,
  preparationBlocked?: string
): ToolResponse {
  const actions: Array<Record<string, unknown>> = [];
  if (!preparationBlocked) {
    actions.push({
      label: 'Prepare a fresh exact snapshot',
      tool: 'open_vault',
      arguments: { vault }
    });
  }
  actions.push({
    label: 'Analyze approximately from the files',
    tool: 'analyze_link_hierarchy',
    arguments: { vault, providerMode: 'filesystem' }
  });
  return jsonResponse({
    vault,
    status: 'exact_unavailable',
    decisionState: decision,
    message: preparationBlocked
      ? `${message} Exact preparation is currently unavailable because ${preparationBlocked}`
      : message,
    actions
  });
}

function snapshotIdentityMatches(
  snapshot: PreparedExactGraphSnapshot,
  target: RegisteredVaultTarget,
  canonicalPath: string
): boolean {
  return (
    (target.status === 'open' || target.status === 'closed') &&
    target.canonicalPath === canonicalPath &&
    snapshot.canonicalPath === canonicalPath &&
    target.vaultId === snapshot.vaultId
  );
}

function readinessForInvalidSnapshot(target: RegisteredVaultTarget): GraphTargetReadiness {
  if (target.status === 'ambiguous') return 'ambiguous';
  if (target.status === 'unregistered') return 'unregistered';
  if (target.status === 'unsupported_platform') return 'unsupported_platform';
  if (target.status === 'probe_failed') return 'probe_failed';
  return 'stale';
}
