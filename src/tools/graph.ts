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
import { ToolResponse } from '../types/index.js';
import { vaultParam, limitParam } from './schema-helpers.js';
import { getGraphSignals, getBaseGraph } from '../graph/signals.js';
import { levelHistogram } from '../graph/levels.js';
import { NodeSignals } from '../graph/types.js';

const LEVELS_NOTE = 'levels are structural orientation, not importance.';

export const graphTools: Tool[] = [
  {
    name: 'analyze_link_hierarchy',
    description:
      'Orientation leveling over the vault link graph. Ranks notes by PageRank + degree on the wikilink graph (Obsidian-authoritative when running, filesystem fallback otherwise), prunes declared/generated/index/archive notes before ranking, and assigns structural levels L0 (top hubs) to L5 (leaves). Returns a level histogram, per-node signals, and a contributor breakdown. Levels are structural orientation, not importance.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        vault: vaultParam,
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
      }
    }
  }
];

export function createGraphHandlers(config: Config) {
  return {
    analyze_link_hierarchy: async (args: {
      vault?: string;
      scope?: string;
      limit?: number;
      compact?: boolean;
      exclude?: { where?: import('../graph/exclude.js').ExcludeInput['where'] };
    }): Promise<ToolResponse> => {
      try {
        const vault = resolveVault(config, args.vault);
        const limit = args.limit ?? 50;
        const compact = args.compact === true;

        const result = await getGraphSignals(config, args.vault, args.exclude);
        const base = await getBaseGraph(config, args.vault, vault.path);

        // Build reverse adjacency (target → contributors) for the breakdown,
        // restricted to ranked (non-excluded) sources.
        const contributorsOf = new Map<string, Array<{ source: string; count: number }>>();
        if (!compact) {
          for (const e of base.edges) {
            const srcSig = result.signals.get(e.source);
            if (srcSig && srcSig.excluded) continue; // excluded contributors don't count
            const arr = contributorsOf.get(e.target) || [];
            arr.push({ source: e.source, count: e.count });
            contributorsOf.set(e.target, arr);
          }
        }

        // Ranked nodes (non-excluded), sorted by PageRank desc.
        const ranked: Array<{ path: string; sig: NodeSignals }> = [];
        const levelsForHist = new Map<string, number>();
        for (const [path, sig] of result.signals) {
          if (!sig.excluded && sig.level !== null) {
            levelsForHist.set(path, sig.level);
          }
          if (!sig.excluded) {
            ranked.push({ path, sig });
          }
        }
        ranked.sort((a, b) => (b.sig.pagerank ?? 0) - (a.sig.pagerank ?? 0));

        // Scope filters OUTPUT only.
        const scoped = args.scope
          ? ranked.filter((r) => r.path.startsWith(args.scope as string))
          : ranked;

        const detail = scoped.slice(0, limit).map((r) => {
          const entry: Record<string, unknown> = {
            path: r.path,
            level: r.sig.level,
            pagerank: r.sig.pagerank,
            degree: r.sig.inDegree + r.sig.outDegree,
            inDegree: r.sig.inDegree,
            outDegree: r.sig.outDegree,
            inOutRatio: Number(r.sig.inOutRatio.toFixed(4)),
            archived: r.sig.archived,
            excluded: r.sig.excluded
          };

          if (!compact) {
            const contribs = (contributorsOf.get(r.path) || [])
              .map((c) => {
                const cSig = result.signals.get(c.source);
                return {
                  source: c.source,
                  edgeCount: c.count,
                  pagerankShare: cSig?.pagerank ?? null
                };
              })
              .sort((a, b) => (b.pagerankShare ?? 0) - (a.pagerankShare ?? 0))
              .slice(0, 5);
            entry.topContributors = contribs;
          }

          return entry;
        });

        const histogram = levelHistogram(levelsForHist, result.excludedCount);

        const payload = {
          vault: result.vault,
          provider: result.provider,
          // Observability for the silent Obsidian→filesystem degrade (#32):
          // present ONLY on the attempted-then-failed Obsidian path.
          ...(result.providerFallbackReason
            ? { providerFallbackReason: result.providerFallbackReason }
            : {}),
          totalNodes: result.totalNodes,
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
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Link hierarchy error: ${error}` }],
          isError: true
        };
      }
    }
  };
}
