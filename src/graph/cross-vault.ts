/** Pure, uncached composition of validated native URI declarations. */

import { serializeObsidianUri } from '../parsers/obsidian-uri.js';
import path from 'node:path';
import type {
  DeclaredCrossVaultEdge,
  DeclaredCrossVaultGraph,
  VaultNodeRef
} from './types.js';

export const DECLARED_GRAPH_MAX_EDGES = 100;
export const DECLARED_GRAPH_MAX_SUBPATHS = 20;

export interface CrossVaultGraphObservation {
  status: string;
  relationshipType: 'cross_vault' | 'same_vault' | 'unknown';
  source: VaultNodeRef;
  target?: VaultNodeRef & { exists: boolean };
  subpath?: string;
  diagnostics: Array<{ severity: 'error' | 'warning' }>;
  /** True when distinct configured names resolve to the same physical folder. */
  physicalVaultAlias: boolean;
  /** True when either configured root could not be resolved to physical identity. */
  physicalIdentityUnavailable?: boolean;
  /** True when the source vault name is not unique case-insensitively. */
  sourceVaultAmbiguous?: boolean;
}

interface EdgeAggregate {
  source: VaultNodeRef;
  target: VaultNodeRef;
  total: number;
  canonical: number;
  noncanonical: number;
  subpaths: Map<string, number>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTuple(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const compared = compareText(a[i] ?? '', b[i] ?? '');
    if (compared !== 0) return compared;
  }
  return 0;
}

function observationExclusion(observation: CrossVaultGraphObservation): string | undefined {
  if (observation.sourceVaultAmbiguous) return 'source_vault_ambiguous';
  if (observation.status !== 'valid' && observation.status !== 'noncanonical') {
    return observation.status;
  }
  if (observation.relationshipType !== 'cross_vault') {
    return 'not_cross_vault';
  }
  if (!observation.target || observation.target.exists !== true) {
    return 'missing_destination';
  }
  if (observation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return 'error_diagnostic';
  }
  if (observation.physicalIdentityUnavailable) return 'physical_identity_unavailable';
  if (observation.physicalVaultAlias) return 'physical_vault_alias';
  return undefined;
}

/** Convert a platform-native relative path to Obsidian's slash syntax. */
export function normalizeVaultRelativePath(relativePath: string, separator = path.sep): string {
  return separator === '/' ? relativePath : relativePath.split(separator).join('/');
}

/**
 * Incremental builder so full-scan edge aggregation is independent from the
 * bounded nativeUriInventory diagnostic sample.
 */
export class DeclaredCrossVaultGraphBuilder {
  private readonly aggregates = new Map<string, EdgeAggregate>();
  private readonly excludedByStatus = new Map<string, number>();
  private totalObserved = 0;
  private totalEligible = 0;

  constructor(private readonly configuredVaults: string[]) {}

  observe(observation: CrossVaultGraphObservation): void {
    this.totalObserved++;
    const excluded = observationExclusion(observation);
    if (excluded) {
      this.excludedByStatus.set(excluded, (this.excludedByStatus.get(excluded) || 0) + 1);
      return;
    }

    const target = observation.target!;
    this.totalEligible++;
    const tuple = [
      observation.source.vault,
      observation.source.path,
      target.vault,
      target.path
    ];
    const key = JSON.stringify(tuple);
    let aggregate = this.aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        source: { ...observation.source },
        target: { vault: target.vault, path: target.path },
        total: 0,
        canonical: 0,
        noncanonical: 0,
        subpaths: new Map<string, number>()
      };
      this.aggregates.set(key, aggregate);
    }

    aggregate.total++;
    if (observation.status === 'noncanonical') aggregate.noncanonical++;
    else aggregate.canonical++;
    const subpathKey = observation.subpath ?? '';
    aggregate.subpaths.set(subpathKey, (aggregate.subpaths.get(subpathKey) || 0) + 1);
  }

  build(): DeclaredCrossVaultGraph {
    const allEdges = [...this.aggregates.values()]
      .sort((a, b) => compareTuple(
        [a.source.vault, a.source.path, a.target.vault, a.target.path],
        [b.source.vault, b.source.path, b.target.vault, b.target.path]
      ));

    const returned = allEdges.slice(0, DECLARED_GRAPH_MAX_EDGES).map((aggregate): DeclaredCrossVaultEdge => {
      const allSubpaths = [...aggregate.subpaths.entries()]
        .sort(([a], [b]) => compareText(a, b));
      const subpathValues = allSubpaths.slice(0, DECLARED_GRAPH_MAX_SUBPATHS).map(([subpath, count]) => ({
        subpath: subpath === '' ? null : subpath,
        count
      }));
      return {
        type: 'declared_cross_vault_note_reference',
        source: aggregate.source,
        target: aggregate.target,
        canonicalUri: serializeObsidianUri({
          vault: aggregate.target.vault,
          file: aggregate.target.path
        }),
        declarations: {
          total: aggregate.total,
          canonical: aggregate.canonical,
          noncanonical: aggregate.noncanonical
        },
        subpaths: {
          totalUnique: allSubpaths.length,
          returned: subpathValues.length,
          maxReturned: DECLARED_GRAPH_MAX_SUBPATHS,
          truncated: allSubpaths.length > subpathValues.length,
          values: subpathValues
        }
      };
    });

    const excludedEntries = [...this.excludedByStatus.entries()]
      .sort(([a], [b]) => compareText(a, b));
    const byStatus = Object.fromEntries(excludedEntries);
    const excludedTotal = excludedEntries.reduce((sum, [, count]) => sum + count, 0);

    return {
      schemaVersion: 1,
      kind: 'declared_cross_vault_overlay',
      edgeType: 'declared_cross_vault_note_reference',
      authority: 'source_note_declaration',
      syntax: 'obsidian_open_uri',
      observationProvider: 'filesystem',
      destinationValidation: 'configured_vault_exact_path',
      subpathValidation: 'not_performed',
      rankingApplied: false,
      nodeIdentity: 'structured_vault_and_path',
      vaultBoundaries: [...new Set(this.configuredVaults)].sort(compareText),
      totalObservedDeclarations: this.totalObserved,
      totalEligibleDeclarations: this.totalEligible,
      totalUniqueEdges: allEdges.length,
      returnedEdges: returned.length,
      maxReturned: DECLARED_GRAPH_MAX_EDGES,
      truncated: allEdges.length > returned.length,
      excluded: {
        total: excludedTotal,
        byStatus
      },
      edges: returned
    };
  }
}
