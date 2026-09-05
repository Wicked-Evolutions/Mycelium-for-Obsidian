import type { DeclaredCrossVaultGraph, VaultNodeRef } from '../graph/types.js';
import type { ObsidianUriDiagnostic } from '../parsers/obsidian-uri.js';
import { exactResultMetadata } from '../result-metadata.js';

interface CrossVaultLinksPayload {
  totalPotentialLinks: number;
  links: readonly {
    sourceVault: string;
    sourcePath: string;
    unresolvedLink: string;
    potentialTargets: readonly VaultNodeRef[];
  }[];
  nativeUriInventory: {
    records: readonly Record<string, unknown>[];
    [key: string]: unknown;
  };
  declaredCrossVaultGraph: DeclaredCrossVaultGraph;
}

/** Project an existing successful payload; scanning, validation and errors stay with the caller. */
export function compactCrossVaultLinks(payload: CrossVaultLinksPayload) {
  return {
    ...payload,
    links: payload.links.map(link => {
      const potentialTargets = link.potentialTargets.slice(0, 5);
      return {
        ...link,
        potentialTargets,
        potentialTargetsMetadata: exactResultMetadata(link.potentialTargets.length, potentialTargets.length),
      };
    }),
    nativeUriInventory: {
      ...payload.nativeUriInventory,
      records: payload.nativeUriInventory.records.map(record => {
        const { raw, canonicalUri, label, diagnostics, ...identity } = record;
        return {
          ...identity,
          // The existing inventory supplies parser diagnostics; retain severity without prose.
          diagnostics: (diagnostics as ObsidianUriDiagnostic[]).map(({ code, severity }) => ({ code, severity })),
        };
      }),
    },
    declaredCrossVaultGraph: {
      ...payload.declaredCrossVaultGraph,
      edges: payload.declaredCrossVaultGraph.edges.map(({ canonicalUri, subpaths, ...edge }) => ({
        ...edge,
        subpaths: { totalUnique: subpaths.totalUnique },
      })),
    },
  };
}
