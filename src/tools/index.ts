/**
 * Tool aggregator for Obsidian MCP
 * Combines all tool definitions and handlers
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import { ToolRequestContext, ToolResponse } from '../types/index.js';
import { injectVaultEnum } from './schema-helpers.js';
import { formatVaultError } from '../resolver-hints.js';
import {
  applyReadOnlyGuard,
  applyUntrustedWrapper,
  DERIVED_INDEX_EXEMPT,
  isMutating
} from './safety.js';
import { invalidateGraphCache } from '../graph/signals.js';
import { canonicalizeVaultPath } from '../cli/vault-target.js';
import { withPreparedGraphLock } from '../graph/prepared.js';

// Import tool definitions and handler creators
import { fileTools, createFileHandlers } from './files.js';
import { wikilinkTools, createWikilinkHandlers } from './wikilinks.js';
import { semanticTools, createSemanticHandlers } from './semantic.js';
import { crossVaultTools, createCrossVaultHandlers } from './crossvault.js';
import { sectionTools, createSectionHandlers } from './sections.js';
import { queryTools, createQueryHandlers } from './query.js';
import { analyticsTools, createAnalyticsHandlers } from './analytics.js';
import { graphTools, createGraphHandlers } from './graph.js';
import { vaultTools, createVaultHandlers } from './vault.js';
import { fsPromotedTools, createFsPromotedHandlers } from './fs-promoted.js';
import { cliTools, createCliHandlers } from './cli-tools.js';
import { getStartedTools, createGetStartedHandlers } from './get-started.js';
import { discoverToolsTools, createDiscoverToolsHandlers } from './discover-tools.js';

/**
 * All tool definitions (unfiltered)
 */
const rawTools: readonly Tool[] = [
  ...fileTools,
  ...wikilinkTools,
  ...semanticTools,
  ...crossVaultTools,
  ...sectionTools,
  ...queryTools,
  ...analyticsTools,
  ...graphTools,
  ...vaultTools,
  ...fsPromotedTools,
  ...cliTools,
  ...getStartedTools,
  ...discoverToolsTools,
];

/**
 * All tool definitions, filtered by OBSIDIAN_DISABLED_TOOLS env var
 */
export let allTools: Tool[] = rawTools.map((tool) => structuredClone(tool));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (
  args: any,
  context?: ToolRequestContext
) => Promise<ToolResponse>;

/**
 * Wraps a handler so that if `args.vault` names an unknown vault, the handler
 * returns a structured JSON error (with `closest_matches` and `hint`) instead of
 * propagating the thrown Error or letting it collapse into a bare string message.
 *
 * Cross-vault tools (which accept no `vault` param) pass through unchanged.
 */
function withVaultGuard(config: Config, handler: AnyHandler): AnyHandler {
  return async (
    args: Record<string, unknown>,
    context?: ToolRequestContext
  ): Promise<ToolResponse> => {
    if (args && typeof args.vault === 'string' && args.vault) {
      try {
        resolveVault(config, args.vault);
      } catch (err) {
        return formatVaultError(err);
      }
    }
    return handler(args, context);
  };
}

/**
 * Apply withVaultGuard to every handler in a map.
 */
function guardAll(config: Config, map: Record<string, AnyHandler>): Record<string, AnyHandler> {
  const out: Record<string, AnyHandler> = {};
  for (const [name, handler] of Object.entries(map)) {
    out[name] = withVaultGuard(config, handler);
  }
  return out;
}

/**
 * Create all tool handlers for a given config, excluding disabled tools
 */
export function createAllHandlers(
  config: Config,
  dependencies: { canonicalize?: typeof canonicalizeVaultPath } = {}
): Record<string, AnyHandler> {
  const enabledTools = rawTools
    .filter((tool) => !config.disabledTools.has(tool.name))
    .map((tool) => structuredClone(tool));
  const handlers = guardAll(config, {
    ...createFileHandlers(config),
    ...createWikilinkHandlers(config),
    ...createSemanticHandlers(config),
    ...createCrossVaultHandlers(config),
    ...createSectionHandlers(config),
    ...createQueryHandlers(config),
    ...createAnalyticsHandlers(config),
    ...createGraphHandlers(config),
    ...createVaultHandlers(config),
    ...createFsPromotedHandlers(config),
    ...createCliHandlers(config),
    ...createGetStartedHandlers(config, () => enabledTools),
    ...createDiscoverToolsHandlers(() => enabledTools),
  } as Record<string, AnyHandler>);

  for (const name of config.disabledTools) {
    delete handlers[name];
  }

  // --- Track C safety wrappers (distinct region, AFTER the disabledTools filter) ---
  // Read-only mode: refuse vault-content mutators (refuse-and-stay-listed — the
  // tool remains in allTools, but its handler returns a structured refusal).
  // Derived-index tools (index_vault/index_file/rebuild_link_index) are exempt.
  let wrappedHandlers = applyReadOnlyGuard(config.readOnly, enabledTools, handlers);
  wrappedHandlers = applyPreparedSnapshotInvalidation(
    config,
    enabledTools,
    wrappedHandlers,
    dependencies.canonicalize
  );
  // Opt-in untrusted-content markers on reader output (default OFF).
  wrappedHandlers = applyUntrustedWrapper(config.wrapUntrusted, enabledTools, wrappedHandlers);

  // Inject the operator's actual vault names as an enum into every vault param.
  // This replaces the stale "Platform/Helena" example text with the real values
  // from the runtime config — giving the AI concrete, accurate choices.
  const vaultNames = config.vaults.map(v => v.name);
  injectVaultEnum(enabledTools, vaultNames);

  // Retain the historical exported surface for the active server instance while
  // keeping every factory's wrappers and orientation handlers instance-local.
  allTools = enabledTools;

  return wrappedHandlers;
}

/** Serialize mutators and evict exact snapshots after every attempted mutation. */
export function applyPreparedSnapshotInvalidation(
  config: Config,
  tools: Tool[],
  handlers: Record<string, AnyHandler>,
  canonicalize: typeof canonicalizeVaultPath = canonicalizeVaultPath
): Record<string, AnyHandler> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const out: Record<string, AnyHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    const tool = byName.get(name);
    if (
      !tool ||
      config.readOnly ||
      !isMutating(tool) ||
      DERIVED_INDEX_EXEMPT.has(name) ||
      name === 'open_vault'
    ) {
      out[name] = handler;
      continue;
    }
    out[name] = async (args: unknown, context?: ToolRequestContext) => {
      const request = args && typeof args === 'object'
        ? args as Record<string, unknown>
        : {};
      const requestedVault = typeof request.vault === 'string' && request.vault
        ? request.vault
        : undefined;

      let vault;
      try {
        vault = resolveVault(config, requestedVault);
      } catch {
        return handler(args, context);
      }

      let canonicalPath: string;
      try {
        canonicalPath = await canonicalize(vault.path);
      } catch {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'vault_identity_unavailable',
              tool: name,
              message: 'Mutation refused because the configured vault identity could not be canonicalized safely.'
            }, null, 2)
          }],
          isError: true
        };
      }

      return withPreparedGraphLock(canonicalPath, context?.signal, async () => {
        try {
          return await handler(args, context);
        } finally {
          invalidateGraphCache(vault.path);
          if (canonicalPath !== vault.path) invalidateGraphCache(canonicalPath);
        }
      });
    };
  }
  return out;
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): Tool | undefined {
  return allTools.find(t => t.name === name);
}
