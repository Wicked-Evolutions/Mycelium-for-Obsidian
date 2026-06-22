/**
 * Frontmatter query engine for Obsidian MCP
 * Enables Dataview-like queries without requiring the Obsidian app
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Config, resolveVault, resolvePathInVault } from '../config.js';
import { ToolResponse } from '../types/index.js';
import { parseMarkdownFile, extractTitle } from '../parsers/markdown.js';
import { vaultParam, limitParam } from './schema-helpers.js';
import { withAnnotations, ToolAnnotations } from './safety.js';

/**
 * Supported filter operators
 */
export type FilterOp = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'in' | 'not_in' | 'exists' | 'not_exists' | 'greater_than' | 'less_than';

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: unknown;
}

/**
 * Tool definitions
 */
const rawQueryTools: Tool[] = [
  {
    name: 'query_notes',
    description: 'Query vault notes by frontmatter fields. Like Dataview but without needing Obsidian. Filter by type, status, tags, dates, or any frontmatter field.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
        from: {
          type: 'string',
          description: 'Directory prefix filter (e.g., "03 Projects", "05 Resources/AI Context")'
        },
        where: {
          type: 'array',
          description: 'Filter conditions. Each has field, op (equals/not_equals/contains/in/exists/not_exists/greater_than/less_than), and value.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Frontmatter field name (e.g., "type", "status", "tags")' },
              op: { type: 'string', description: 'Operator: equals, not_equals, contains, not_contains, in, not_in, exists, not_exists, greater_than, less_than' },
              value: { description: 'Value to compare against (not needed for exists/not_exists)' }
            },
            required: ['field', 'op']
          }
        },
        fields: {
          type: 'array',
          description: 'Which frontmatter fields to return (default: all)',
          items: { type: 'string' }
        },
        sort_by: {
          type: 'string',
          description: 'Frontmatter field to sort by. Prefix with "-" for descending (e.g., "-updated", "title")'
        },
        limit: limitParam(20, 'Maximum results to return')
      }
    }
  }
];

/** query_notes is a read-only query over frontmatter. */
const queryAnnotations: Record<string, ToolAnnotations> = {
  query_notes: { readOnlyHint: true },
};

export const queryTools: Tool[] = withAnnotations(rawQueryTools, queryAnnotations);

/**
 * Apply a single filter condition to a frontmatter value.
 *
 * Exported so the graph exclusion layer (src/graph/exclude.ts) reuses the
 * EXACT operator semantics of query_notes rather than re-implementing them.
 */
export function matchesCondition(frontmatter: Record<string, unknown>, condition: FilterCondition): boolean {
  const fieldValue = frontmatter[condition.field];

  switch (condition.op) {
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;

    case 'not_exists':
      return fieldValue === undefined || fieldValue === null;

    case 'equals':
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(condition.value);
      }
      return String(fieldValue).toLowerCase() === String(condition.value).toLowerCase();

    case 'not_equals':
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(condition.value);
      }
      return String(fieldValue).toLowerCase() !== String(condition.value).toLowerCase();

    case 'contains':
      if (Array.isArray(fieldValue)) {
        return fieldValue.some(v => String(v).toLowerCase().includes(String(condition.value).toLowerCase()));
      }
      return String(fieldValue || '').toLowerCase().includes(String(condition.value).toLowerCase());

    case 'not_contains':
      if (Array.isArray(fieldValue)) {
        return !fieldValue.some(v => String(v).toLowerCase().includes(String(condition.value).toLowerCase()));
      }
      return !String(fieldValue || '').toLowerCase().includes(String(condition.value).toLowerCase());

    case 'in': {
      const allowed = Array.isArray(condition.value) ? condition.value : [condition.value];
      return allowed.some(v => String(v).toLowerCase() === String(fieldValue).toLowerCase());
    }

    case 'not_in': {
      const disallowed = Array.isArray(condition.value) ? condition.value : [condition.value];
      return !disallowed.some(v => String(v).toLowerCase() === String(fieldValue).toLowerCase());
    }

    case 'greater_than': {
      if (fieldValue === undefined || fieldValue === null) return false;
      // Use numeric comparison when both values are numbers
      const gtA = Number(fieldValue);
      const gtB = Number(condition.value);
      if (!isNaN(gtA) && !isNaN(gtB)) return gtA > gtB;
      return String(fieldValue) > String(condition.value);
    }

    case 'less_than': {
      if (fieldValue === undefined || fieldValue === null) return false;
      const ltA = Number(fieldValue);
      const ltB = Number(condition.value);
      if (!isNaN(ltA) && !isNaN(ltB)) return ltA < ltB;
      return String(fieldValue) < String(condition.value);
    }

    default:
      return true;
  }
}

/**
 * Project frontmatter to only requested fields
 */
function projectFields(
  frontmatter: Record<string, unknown>,
  fields?: string[]
): Record<string, unknown> {
  if (!fields || fields.length === 0) return frontmatter;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in frontmatter) {
      result[field] = frontmatter[field];
    }
  }
  return result;
}

/**
 * Handler functions
 */
export function createQueryHandlers(config: Config) {
  return {
    query_notes: async (args: {
      vault?: string;
      from?: string;
      where?: FilterCondition[];
      fields?: string[];
      sort_by?: string;
      limit?: number;
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const searchDir = args.from
          ? resolvePathInVault(vault.path, args.from)
          : vault.path;
        const limit = args.limit || 20;

        // Collect all markdown files
        const files = await collectMarkdownFiles(searchDir, vault.path);

        // Parse and filter
        const results: Array<{
          path: string;
          title: string;
          frontmatter: Record<string, unknown>;
        }> = [];

        for (const filePath of files) {
          try {
            const parsed = await parseMarkdownFile(filePath, vault.path);

            // Apply all conditions
            if (args.where && args.where.length > 0) {
              const allMatch = args.where.every(cond => matchesCondition(parsed.frontmatter, cond));
              if (!allMatch) continue;
            }

            results.push({
              path: filePath,
              title: extractTitle(parsed),
              frontmatter: projectFields(parsed.frontmatter, args.fields)
            });
          } catch {
            // Skip files that can't be parsed
          }
        }

        // Sort
        if (args.sort_by) {
          const descending = args.sort_by.startsWith('-');
          const sortField = descending ? args.sort_by.slice(1) : args.sort_by;

          results.sort((a, b) => {
            const aVal = String(a.frontmatter[sortField] || '');
            const bVal = String(b.frontmatter[sortField] || '');
            const cmp = aVal.localeCompare(bVal);
            return descending ? -cmp : cmp;
          });
        }

        // Limit
        const limited = results.slice(0, limit);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              vault: vault.name,
              from: args.from || '/',
              totalMatches: results.length,
              returned: limited.length,
              results: limited
            }, null, 2)
          }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query error: ${error}` }],
          isError: true
        };
      }
    }
  };
}

/**
 * Helper: Collect all markdown files recursively
 */
async function collectMarkdownFiles(
  dirPath: string,
  vaultPath: string,
  files: string[] = []
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await collectMarkdownFiles(fullPath, vaultPath, files);
      } else if (entry.name.endsWith('.md')) {
        files.push(path.relative(vaultPath, fullPath));
      }
    }
  } catch {
    // Directory doesn't exist or is inaccessible
  }

  return files;
}
