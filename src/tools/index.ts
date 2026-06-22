/**
 * Tool aggregator for Obsidian MCP
 * Combines all tool definitions and handlers
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { injectVaultEnum } from './schema-helpers.js';
import { formatVaultError } from '../resolver-hints.js';
import { applyReadOnlyGuard, applyUntrustedWrapper } from './safety.js';

// Import tool definitions and handler creators
import { fileTools, createFileHandlers } from './files.js';
import { wikilinkTools, createWikilinkHandlers } from './wikilinks.js';
import { semanticTools, createSemanticHandlers } from './semantic.js';
import { crossVaultTools, createCrossVaultHandlers } from './crossvault.js';
import { sectionTools, createSectionHandlers } from './sections.js';
import { queryTools, createQueryHandlers } from './query.js';
import { analyticsTools, createAnalyticsHandlers } from './analytics.js';
import { graphTools, createGraphHandlers } from './graph.js';
import { fsPromotedTools, createFsPromotedHandlers } from './fs-promoted.js';
import { cliTools, createCliHandlers } from './cli-tools.js';
import { getStartedTools, createGetStartedHandlers } from './get-started.js';
import { discoverToolsTools, createDiscoverToolsHandlers } from './discover-tools.js';

/**
 * All tool definitions (unfiltered)
 */
const rawTools: Tool[] = [
  ...fileTools,
  ...wikilinkTools,
  ...semanticTools,
  ...crossVaultTools,
  ...sectionTools,
  ...queryTools,
  ...analyticsTools,
  ...graphTools,
  ...fsPromotedTools,
  ...cliTools,
  ...getStartedTools,
  ...discoverToolsTools,
];

/**
 * All tool definitions, filtered by OBSIDIAN_DISABLED_TOOLS env var
 */
export let allTools: Tool[] = rawTools;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => Promise<ToolResponse>;

/**
 * Wraps a handler so that if `args.vault` names an unknown vault, the handler
 * returns a structured JSON error (with `closest_matches` and `hint`) instead of
 * propagating the thrown Error or letting it collapse into a bare string message.
 *
 * Cross-vault tools (which accept no `vault` param) pass through unchanged.
 */
function withVaultGuard(config: Config, handler: AnyHandler): AnyHandler {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    if (args && typeof args.vault === 'string' && args.vault) {
      try {
        resolveVault(config, args.vault);
      } catch (err) {
        return formatVaultError(err);
      }
    }
    return handler(args);
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
export function createAllHandlers(config: Config): Record<string, AnyHandler> {
  const handlers = guardAll(config, {
    ...createFileHandlers(config),
    ...createWikilinkHandlers(config),
    ...createSemanticHandlers(config),
    ...createCrossVaultHandlers(config),
    ...createSectionHandlers(config),
    ...createQueryHandlers(config),
    ...createAnalyticsHandlers(config),
    ...createGraphHandlers(config),
    ...createFsPromotedHandlers(config),
    ...createCliHandlers(config),
    ...createGetStartedHandlers(config, () => allTools),
    ...createDiscoverToolsHandlers(() => allTools),
  } as Record<string, AnyHandler>);

  // Filter out disabled tools
  if (config.disabledTools.size > 0) {
    allTools = rawTools.filter(t => !config.disabledTools.has(t.name));
    for (const name of config.disabledTools) {
      delete handlers[name];
    }
  }

  // --- Track C safety wrappers (distinct region, AFTER the disabledTools filter) ---
  // Read-only mode: refuse vault-content mutators (refuse-and-stay-listed — the
  // tool remains in allTools, but its handler returns a structured refusal).
  // Derived-index tools (index_vault/index_file/rebuild_link_index) are exempt.
  let wrappedHandlers = applyReadOnlyGuard(config.readOnly, allTools, handlers);
  // Opt-in untrusted-content markers on reader output (default OFF).
  wrappedHandlers = applyUntrustedWrapper(config.wrapUntrusted, allTools, wrappedHandlers);

  // Inject the operator's actual vault names as an enum into every vault param.
  // This replaces the stale "Platform/Helena" example text with the real values
  // from the runtime config — giving the AI concrete, accurate choices.
  const vaultNames = config.vaults.map(v => v.name);
  injectVaultEnum(allTools, vaultNames);

  return wrappedHandlers;
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): Tool | undefined {
  return allTools.find(t => t.name === name);
}
