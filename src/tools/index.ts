/**
 * Tool aggregator for Obsidian MCP
 * Combines all tool definitions and handlers
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { injectVaultEnum } from './schema-helpers.js';

// Import tool definitions and handler creators
import { fileTools, createFileHandlers } from './files.js';
import { wikilinkTools, createWikilinkHandlers } from './wikilinks.js';
import { semanticTools, createSemanticHandlers } from './semantic.js';
import { crossVaultTools, createCrossVaultHandlers } from './crossvault.js';
import { sectionTools, createSectionHandlers } from './sections.js';
import { queryTools, createQueryHandlers } from './query.js';
import { analyticsTools, createAnalyticsHandlers } from './analytics.js';
import { fsPromotedTools, createFsPromotedHandlers } from './fs-promoted.js';
import { cliTools, createCliHandlers } from './cli-tools.js';

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
  ...fsPromotedTools,
  ...cliTools
];

/**
 * All tool definitions, filtered by OBSIDIAN_DISABLED_TOOLS env var
 */
export let allTools: Tool[] = rawTools;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => Promise<ToolResponse>;

/**
 * Create all tool handlers for a given config, excluding disabled tools
 */
export function createAllHandlers(config: Config): Record<string, AnyHandler> {
  const handlers = {
    ...createFileHandlers(config),
    ...createWikilinkHandlers(config),
    ...createSemanticHandlers(config),
    ...createCrossVaultHandlers(config),
    ...createSectionHandlers(config),
    ...createQueryHandlers(config),
    ...createAnalyticsHandlers(config),
    ...createFsPromotedHandlers(config),
    ...createCliHandlers(config)
  } as Record<string, AnyHandler>;

  // Filter out disabled tools
  if (config.disabledTools.size > 0) {
    allTools = rawTools.filter(t => !config.disabledTools.has(t.name));
    for (const name of config.disabledTools) {
      delete handlers[name];
    }
  }

  // Inject the operator's actual vault names as an enum into every vault param.
  // This replaces the stale "Platform/Helena" example text with the real values
  // from the runtime config — giving the AI concrete, accurate choices.
  const vaultNames = config.vaults.map(v => v.name);
  injectVaultEnum(allTools, vaultNames);

  return handlers;
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): Tool | undefined {
  return allTools.find(t => t.name === name);
}
