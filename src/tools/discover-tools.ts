/**
 * discover_tools tool for Obsidian MCP
 *
 * Returns a paginated compact inventory of all registered tools plus a
 * category histogram. Designed for AI orientation: gives a lightweight
 * index of the tool surface without dumping full JSON schemas.
 *
 * Response shape:
 *   {
 *     total: number,          // total tools (all pages)
 *     returned: number,       // tools in this page
 *     offset: number,         // current offset
 *     has_more: boolean,      // whether more tools remain
 *     tools: Array<{ name, category, tier }>,  // compact — NO full schemas
 *     histogram: Array<{ category, count }>,   // full-set counts (not page-scoped)
 *   }
 *
 * Dependency: imports categories.ts only (never index.ts — avoids circular import).
 * The handler factory accepts a getTools() callback injected by index.ts.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolResponse } from '../types/index.js';
import { categorySummary, getToolCategory, CLI_TIER_LABEL } from './categories.js';
import { limitParam } from './schema-helpers.js';
import { withAnnotations, ToolAnnotations } from './safety.js';

const rawDiscoverToolsTools: Tool[] = [
  {
    name: 'discover_tools',
    description:
      'Compact inventory of all registered tools with pagination. Returns name, category, and tier (filesystem/cli) per tool — no full schemas. Also includes a category histogram for the full tool surface. Use this for AI orientation when get_started category counts are not enough detail.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: limitParam(50, 'Maximum number of tools to return per page'),
        offset: {
          type: 'number',
          description: 'Zero-based offset for pagination',
          default: 0,
        },
      },
    },
  },
];

/** discover_tools is a read-only inventory. */
const discoverToolsAnnotations: Record<string, ToolAnnotations> = {
  discover_tools: { readOnlyHint: true },
};

export const discoverToolsTools: Tool[] = withAnnotations(rawDiscoverToolsTools, discoverToolsAnnotations);

/**
 * Derive the tier string for a tool based on its category.
 * CLI-tier tools require Obsidian to be running; filesystem-tier tools do not.
 */
function deriveTier(category: string): 'cli' | 'filesystem' {
  return category === CLI_TIER_LABEL ? 'cli' : 'filesystem';
}

/**
 * Create the discover_tools handler.
 *
 * @param getTools - Callback returning the current allTools array (avoids circular import).
 */
export function createDiscoverToolsHandlers(
  getTools: () => Tool[]
): Record<string, (args: Record<string, unknown>) => Promise<ToolResponse>> {
  return {
    discover_tools: async (args: Record<string, unknown>): Promise<ToolResponse> => {
      const tools = getTools();

      const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 50;
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0;

      const total = tools.length;
      const page = tools.slice(offset, offset + limit);
      const returned = page.length;
      const has_more = offset + returned < total;

      const compactTools = page.map(tool => {
        const category = getToolCategory(tool.name);
        return {
          name: tool.name,
          category,
          tier: deriveTier(category),
        };
      });

      // Histogram is computed over ALL tools (not just the current page)
      const histogram = categorySummary(tools);

      const payload = {
        total,
        returned,
        offset,
        has_more,
        tools: compactTools,
        histogram,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: false,
      };
    },
  };
}
