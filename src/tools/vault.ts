import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import {
  GraphDecisionState,
  GraphTargetReadiness,
  ToolRequestContext,
  ToolResponse
} from '../types/index.js';
import {
  abortableDelay,
  canonicalizeVaultPath,
  dispatchOpenVault,
  inspectRegisteredVault,
  isAbortError,
  OPEN_VAULT_POLL_MS,
  OPEN_VAULT_TIMEOUT_MS,
  probeExactRegisteredVault,
  RegisteredVaultTarget,
  throwIfAborted
} from '../cli/vault-target.js';
import { computeGraphDigest } from '../graph/digest.js';
import { buildVaultGraph } from '../graph/build.js';
import { ObsidianProvider } from '../graph/providers.js';
import { BaseGraph, GraphProviderState } from '../graph/types.js';
import {
  invalidatePreparedExactGraph,
  replacePreparedExactGraph,
  withPreparedGraphLock
} from '../graph/prepared.js';

export const vaultTools: Tool[] = [
  {
    name: 'open_vault',
    description:
      'Explicitly open one configured Obsidian vault if needed and prepare a session-only exact base-graph snapshot. This is the only app-opening step in exact graph analysis; it never ranks notes, opens multiple vaults, accepts arbitrary URIs, or closes windows.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Configured vault name. Required; no default is inferred.'
        }
      },
      required: ['vault'],
      additionalProperties: false
    }
  }
];

interface OpenVaultDependencies {
  canonicalize?: typeof canonicalizeVaultPath;
  inspect?: typeof inspectRegisteredVault;
  dispatch?: typeof dispatchOpenVault;
  probeExact?: typeof probeExactRegisteredVault;
  digest?: typeof computeGraphDigest;
  buildExact?: (
    vaultName: string,
    canonicalPath: string,
    vaultId: string,
    signal?: AbortSignal
  ) => Promise<BaseGraph>;
  delay?: typeof abortableDelay;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

interface ExactWaitResult {
  readiness: GraphTargetReadiness;
  target?: RegisteredVaultTarget;
}

function jsonResponse(payload: Record<string, unknown>, isError = false): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

function decisionState(
  targetReadiness: GraphTargetReadiness,
  probeInvoked: boolean,
  openInvoked: boolean
): GraphDecisionState {
  return {
    requestedMode: 'exact',
    targetReadiness,
    probeInvoked,
    openInvoked,
    analysisInvoked: false
  };
}

function readinessFromTarget(target: RegisteredVaultTarget): GraphTargetReadiness {
  if (target.status === 'open') return 'open_unprepared';
  return target.status;
}

export function createVaultHandlers(
  config: Config,
  dependencies: OpenVaultDependencies = {}
) {
  const canonicalize = dependencies.canonicalize ?? canonicalizeVaultPath;
  const inspect = dependencies.inspect ?? inspectRegisteredVault;
  const dispatch = dependencies.dispatch ?? dispatchOpenVault;
  const probeExact = dependencies.probeExact ?? probeExactRegisteredVault;
  const digest = dependencies.digest ?? computeGraphDigest;
  const delay = dependencies.delay ?? abortableDelay;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? OPEN_VAULT_TIMEOUT_MS;
  const pollMs = dependencies.pollMs ?? OPEN_VAULT_POLL_MS;

  const buildExact = dependencies.buildExact ?? (async (
    vaultName: string,
    canonicalPath: string,
    vaultId: string,
    signal?: AbortSignal
  ): Promise<BaseGraph> => {
    const state: GraphProviderState = {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: false
    };
    return buildVaultGraph(
      canonicalPath,
      new ObsidianProvider(config, vaultName, {
        registeredVaultId: vaultId,
        expectedCanonicalPath: canonicalPath
      }),
      config,
      vaultName,
      state,
      undefined,
      { allowFallback: false, signal }
    );
  });

  async function waitForExactTarget(
    vaultName: string,
    expectedPath: string,
    expectedId: string,
    signal: AbortSignal | undefined,
    deadline: number
  ): Promise<ExactWaitResult> {
    let lastReadiness: GraphTargetReadiness = 'loading';
    while (now() < deadline) {
      throwIfAborted(signal);
      const target = await inspect(config, vaultName);
      if (
        (target.status !== 'open' && target.status !== 'closed') ||
        target.canonicalPath !== expectedPath ||
        target.vaultId !== expectedId
      ) {
        return {
          readiness: target.status === 'ambiguous'
            ? 'ambiguous'
            : target.status === 'unregistered'
              ? 'unregistered'
              : target.status === 'unsupported_platform'
                ? 'unsupported_platform'
                : target.status === 'probe_failed'
                  ? 'probe_failed'
                  : 'stale',
          target
        };
      }

      if (target.status === 'open') {
        const exact = await probeExact(expectedId, expectedPath, signal);
        if (exact.status === 'ready') return { readiness: 'exact_ready', target };
        if (exact.status === 'cli_unavailable') {
          return { readiness: 'cli_unavailable', target };
        }
        if (exact.status === 'identity_mismatch') {
          return { readiness: 'stale', target };
        }
        lastReadiness = exact.status === 'probe_failed' ? 'probe_failed' : 'loading';
      }
      await delay(pollMs, signal);
    }
    return { readiness: lastReadiness };
  }

  return {
    open_vault: async (
      args: { vault?: string },
      context?: ToolRequestContext
    ): Promise<ToolResponse> => {
      const signal = context?.signal;
      let readiness: GraphTargetReadiness = 'probe_failed';
      let probeInvoked = false;
      let openInvoked = false;

      try {
        if (!args.vault) {
          return jsonResponse({
            error: 'missing_vault',
            message: 'open_vault requires one explicit configured vault.',
            availableVaults: config.vaults.map((vault) => vault.name)
          }, true);
        }

        const vault = resolveVault(config, args.vault);
        if (config.disabledTools.has('eval_obsidian')) {
          readiness = 'eval_disabled';
          return jsonResponse({
            vault: vault.name,
            status: 'exact_unavailable',
            decisionState: decisionState(readiness, false, false),
            message: 'Exact graph preparation is unavailable because eval_obsidian is disabled.'
          });
        }

        let canonicalPath: string;
        try {
          canonicalPath = await canonicalize(vault.path);
        } catch {
          throwIfAborted(signal);
          readiness = 'probe_failed';
          probeInvoked = true;
          return jsonResponse({
            vault: vault.name,
            status: 'exact_unavailable',
            decisionState: decisionState(readiness, probeInvoked, false),
            message: 'The configured vault path could not be verified.'
          });
        }

        return await withPreparedGraphLock(canonicalPath, signal, async () => {
          throwIfAborted(signal);
          invalidatePreparedExactGraph(canonicalPath);

          let target = await inspect(config, vault.name);
          throwIfAborted(signal);
          probeInvoked = target.probeInvoked;
          readiness = readinessFromTarget(target);
          if (
            (target.status !== 'open' && target.status !== 'closed') ||
            target.canonicalPath !== canonicalPath ||
            !target.vaultId
          ) {
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, false),
              message: targetDiagnostic(target)
            });
          }

          const targetId = target.vaultId;
          if (target.status === 'closed') {
            // Recheck immediately before URI dispatch. External app state cannot
            // be made atomic, but this narrows the observable race.
            target = await inspect(config, vault.name);
            throwIfAborted(signal);
            probeInvoked = probeInvoked || target.probeInvoked;
            if (
              (target.status !== 'open' && target.status !== 'closed') ||
              target.canonicalPath !== canonicalPath ||
              target.vaultId !== targetId
            ) {
              readiness = target.status === 'ambiguous' ? 'ambiguous' : 'stale';
              return jsonResponse({
                vault: vault.name,
                status: 'exact_unavailable',
                decisionState: decisionState(readiness, probeInvoked, false),
                message: 'The registered vault identity changed before opening. No vault was opened.'
              });
            }
            if (target.status === 'closed') {
              await dispatch(targetId, {
                signal,
                onDispatch: () => { openInvoked = true; }
              });
            }
          }

          const wait = await waitForExactTarget(
            vault.name,
            canonicalPath,
            targetId,
            signal,
            now() + timeoutMs
          );
          readiness = wait.readiness;
          probeInvoked = probeInvoked || wait.target?.probeInvoked === true;
          if (readiness !== 'exact_ready') {
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, openInvoked),
              message: preparationDiagnostic(readiness)
            });
          }

          const beforeDigest = await digest(canonicalPath, signal);
          const verifiedBefore = await inspect(config, vault.name);
          throwIfAborted(signal);
          probeInvoked = true;
          if (
            verifiedBefore.status !== 'open' ||
            verifiedBefore.canonicalPath !== canonicalPath ||
            verifiedBefore.vaultId !== targetId
          ) {
            readiness = 'stale';
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, openInvoked),
              message: 'The vault identity or readiness changed before exact snapshot capture.'
            });
          }

          let graph: BaseGraph;
          try {
            graph = await buildExact(vault.name, canonicalPath, targetId, signal);
          } catch (error) {
            throwIfAborted(signal);
            if (isAbortError(error)) throw error;
            readiness = 'probe_failed';
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, openInvoked),
              message: 'Obsidian could not produce an exact graph snapshot. No approximation was stored.'
            });
          }
          if (!isAuthoritativeExactGraph(graph)) {
            readiness = 'probe_failed';
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, openInvoked),
              message: 'Exact graph preparation did not return Obsidian-authoritative data.'
            });
          }

          const afterDigest = await digest(canonicalPath, signal);
          const verifiedAfter = await inspect(config, vault.name);
          throwIfAborted(signal);
          probeInvoked = true;
          if (
            beforeDigest !== afterDigest ||
            verifiedAfter.canonicalPath !== canonicalPath ||
            verifiedAfter.vaultId !== targetId
          ) {
            readiness = 'stale';
            return jsonResponse({
              vault: vault.name,
              status: 'exact_unavailable',
              decisionState: decisionState(readiness, probeInvoked, openInvoked),
              message: 'The vault changed during exact snapshot capture. Run open_vault again.'
            });
          }

          const capturedAt = new Date(now()).toISOString();
          graph.cacheIdentity = `prepared:${targetId}:${afterDigest}:${capturedAt}`;
          replacePreparedExactGraph({
            canonicalPath,
            vaultId: targetId,
            digest: afterDigest,
            capturedAt,
            graph
          });
          readiness = 'prepared';
          return jsonResponse({
            vault: vault.name,
            status: 'prepared',
            snapshotPrepared: true,
            snapshotCapturedAt: capturedAt,
            decisionState: decisionState(readiness, probeInvoked, openInvoked),
            message: 'The exact Obsidian base graph is prepared for side-effect-free analysis.'
          });
        });
      } catch (error) {
        if (isAbortError(error)) {
          return jsonResponse({
            vault: args.vault ?? null,
            status: 'cancelled',
            decisionState: decisionState(readiness, probeInvoked, openInvoked),
            message: openInvoked
              ? 'The request was cancelled after the open request was dispatched. The opened window was not closed.'
              : 'The request was cancelled before an open request was dispatched.'
          }, true);
        }
        return jsonResponse({
          vault: args.vault ?? null,
          status: 'exact_unavailable',
          decisionState: decisionState(readiness, probeInvoked, openInvoked),
          message: 'Exact graph preparation failed safely. No approximation was stored.'
        }, true);
      }
    }
  };
}

function targetDiagnostic(target: RegisteredVaultTarget): string {
  if (target.status === 'unregistered') {
    return 'This configured vault is not registered in Obsidian. No vault was opened.';
  }
  if (target.status === 'ambiguous') {
    return 'More than one Obsidian registration resolves to this configured vault. No vault was opened.';
  }
  if (target.status === 'unsupported_platform') {
    return 'Opening a vault is not supported on this platform.';
  }
  return 'The Obsidian vault registry could not be verified. No vault was opened.';
}

function preparationDiagnostic(readiness: GraphTargetReadiness): string {
  if (readiness === 'cli_unavailable') {
    return 'The Obsidian CLI is unavailable, so an exact snapshot could not be prepared.';
  }
  if (readiness === 'loading') {
    return 'Obsidian did not become exact-ready before the bounded timeout.';
  }
  if (readiness === 'stale') {
    return 'The registered vault identity changed during preparation. No snapshot was stored.';
  }
  return 'The target vault could not be prepared for exact analysis.';
}

function isAuthoritativeExactGraph(graph: BaseGraph): boolean {
  return (
    graph.provider === 'obsidian' &&
    graph.providerState.selectedProvider === 'obsidian' &&
    graph.providerState.approximate === false &&
    graph.providerState.exactProviderAvailability === 'available' &&
    graph.providerState.exactProviderInvoked === true &&
    graph.providerState.degradationReason === undefined &&
    graph.providerFallbackReason === undefined
  );
}
