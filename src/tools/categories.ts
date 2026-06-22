/**
 * Tool category derivation utility for Obsidian MCP
 *
 * Derives a category name for each tool based on which source module it belongs to.
 * The mapping is explicit: leaf tool module exports are imported here and used to
 * build the lookup table. This file is the single source of category truth and
 * is shared by get_started and discover_tools.
 *
 * Dependency direction: categories.ts → leaf modules only.
 * NEVER import from index.ts or get-started.ts here (would create a cycle).
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { fileTools } from './files.js';
import { wikilinkTools } from './wikilinks.js';
import { semanticTools } from './semantic.js';
import { crossVaultTools } from './crossvault.js';
import { sectionTools } from './sections.js';
import { queryTools } from './query.js';
import { analyticsTools } from './analytics.js';
import { graphTools } from './graph.js';
import { fsPromotedTools } from './fs-promoted.js';
import { cliTools } from './cli-tools.js';

/**
 * Human-readable label for each tool module.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  files: 'File Operations',
  wikilinks: 'Wikilinks',
  semantic: 'Semantic Search',
  crossvault: 'Cross-Vault',
  sections: 'Sections',
  query: 'Frontmatter Queries',
  analytics: 'Analytics',
  graph: 'Graph Orientation',
  'fs-promoted': 'Vault Utilities',
  'cli-tools': 'Obsidian App (CLI)',
  'get-started': 'Getting Started',
};

/**
 * Build a lookup table: tool name → module key.
 * Generated from the actual exported tool arrays so it never drifts.
 */
function buildModuleIndex(): Map<string, string> {
  const index = new Map<string, string>();

  const modules: [string, Tool[]][] = [
    ['files', fileTools],
    ['wikilinks', wikilinkTools],
    ['semantic', semanticTools],
    ['crossvault', crossVaultTools],
    ['sections', sectionTools],
    ['query', queryTools],
    ['analytics', analyticsTools],
    ['graph', graphTools],
    ['fs-promoted', fsPromotedTools],
    ['cli-tools', cliTools],
  ];

  for (const [moduleKey, tools] of modules) {
    for (const tool of tools) {
      index.set(tool.name, moduleKey);
    }
  }

  // Meta-tools registered by name (avoids circular import from index.ts)
  index.set('get_started', 'get-started');
  index.set('discover_tools', 'get-started');

  return index;
}

const MODULE_INDEX: Map<string, string> = buildModuleIndex();

/**
 * Return the category label for a tool by name.
 * Returns "Unknown" if the tool name is not registered.
 */
export function getToolCategory(name: string): string {
  const key = MODULE_INDEX.get(name);
  if (!key) return 'Unknown';
  return CATEGORY_LABELS[key] ?? key;
}

/**
 * Group a list of tools by category.
 * Returns a record of { categoryLabel: tool[] } in stable insertion order.
 *
 * Reusable by discover_tools and any future inventory tool.
 */
export function categorize(tools: Tool[]): Record<string, Tool[]> {
  const groups: Record<string, Tool[]> = {};
  for (const tool of tools) {
    const label = getToolCategory(tool.name);
    if (!groups[label]) {
      groups[label] = [];
    }
    groups[label].push(tool);
  }
  return groups;
}

/**
 * Return category summary: array of { category, count } objects.
 * Used by get_started to report the tool surface without listing every tool.
 */
export function categorySummary(tools: Tool[]): Array<{ category: string; count: number }> {
  const groups = categorize(tools);
  return Object.entries(groups).map(([category, toolList]) => ({
    category,
    count: toolList.length,
  }));
}

/**
 * The CLI-tier category label — tools in this bucket require a running Obsidian instance.
 */
export const CLI_TIER_LABEL = CATEGORY_LABELS['cli-tools'];
