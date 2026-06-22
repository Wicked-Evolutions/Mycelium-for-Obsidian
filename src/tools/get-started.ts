/**
 * get_started tool for Obsidian MCP
 *
 * Returns a combined orientation response:
 *  - DYNAMIC (from config at call time): vault names, total tool count, categories with counts
 *  - STATIC guidance: resolver-first workflow, wikilink syntax, CLI vs filesystem tiers
 *
 * Dependency: imports categories.ts only (never index.ts — avoids circular import).
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { categorySummary, CLI_TIER_LABEL } from './categories.js';
import { withAnnotations, ToolAnnotations } from './safety.js';

// We need access to allTools at call time to count/categorize. Because importing
// allTools from index.ts would create a cycle (index.ts → get-started.ts →
// index.ts), we instead accept it as a parameter injected by the handler factory.
// The factory is called from createAllHandlers() in index.ts after allTools is
// stable, so the count is accurate at the time of each tool call.

const rawGetStartedTools: Tool[] = [
  {
    name: 'get_started',
    description:
      'Orientation guide for this Obsidian MCP instance. Returns configured vault names, total tool count, tool categories with counts, and static guidance on resolver-first workflow, wikilink syntax, and CLI vs filesystem tiers. Call this first in a new session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/** get_started is a read-only orientation guide. */
const getStartedAnnotations: Record<string, ToolAnnotations> = {
  get_started: { readOnlyHint: true },
};

export const getStartedTools: Tool[] = withAnnotations(rawGetStartedTools, getStartedAnnotations);

/**
 * Static orientation guidance included in every get_started response.
 * Kept as a constant so tests can assert on key phrases.
 */
export const STATIC_GUIDANCE = {
  resolverFirstWorkflow: [
    'Prefer resolver tools before read tools when navigating by title.',
    'Use follow_link to resolve a [[wikilink]] and read its content in one step.',
    'Use find_note_by_name when you know the note title but not which vault it lives in.',
    'Use resolve_wikilink to get the file path of a [[wikilink]] without reading the full file.',
  ].join(' '),

  wikilinkSyntax: [
    'Same-vault links use standard Obsidian wikilink syntax: [[Note Title]] or [[Note Title|Alias]].',
    'Cross-vault links in note bodies use the Obsidian URI scheme:',
    'obsidian://open?vault=VaultName&file=Path%2FTo%2FNote',
    '(URL-encode the vault name and path; omit the .md extension).',
  ].join(' '),

  tiers: [
    `Filesystem tier (no Obsidian required): all tools except the "${CLI_TIER_LABEL}" category.`,
    `CLI tier (requires Obsidian 1.12+ running with CLI enabled): "${CLI_TIER_LABEL}" tools.`,
    'If a CLI-tier tool returns an error about Obsidian not available, ensure Obsidian is open.',
  ].join(' '),
};

/**
 * Create the get_started handler.
 *
 * @param config    - Runtime config (vault names sourced from here).
 * @param getTools  - Callback returning the current allTools array (avoids circular import).
 */
export function createGetStartedHandlers(
  config: Config,
  getTools: () => Tool[]
): Record<string, (args: Record<string, unknown>) => Promise<ToolResponse>> {
  return {
    get_started: async (_args: Record<string, unknown>): Promise<ToolResponse> => {
      const tools = getTools();
      const vaultNames = config.vaults.map(v => v.name);
      const totalToolCount = tools.length;
      const categories = categorySummary(tools);

      const payload = {
        vaultNames,
        totalToolCount,
        categories,
        guidance: STATIC_GUIDANCE,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: false,
      };
    },
  };
}
