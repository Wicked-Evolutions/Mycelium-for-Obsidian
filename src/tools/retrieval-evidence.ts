interface EvidenceCandidate {
  filePath: string;
  blockId: string | null;
}

interface EvidenceRow extends EvidenceCandidate {
  contentHash: string;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface EvidenceStorage {
  get(filePath: string, blockId: string | null): EvidenceRow | null;
  getContent(filePath: string, blockId: string | null): string | null;
  /** Validates authority; null means no published generation is available. */
  getEvidenceGeneration(): string | null;
}

type EvidenceUnavailableReason =
  | 'indexed_content_missing'
  | 'indexed_identity_unverified'
  | 'indexed_generation_unavailable'
  | 'indexed_generation_changed';

export type IndexedEvidence = {
  state: 'available';
  source: 'indexed_embedding_text';
  blockId: string | null;
  contentHash: string;
  modelIdentity: string;
  updatedAt: number;
  heading?: string;
  headingTruncated?: boolean;
  excerpt: string;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  currentSourceVerified: false;
} | {
  state: 'unavailable';
  reason: EvidenceUnavailableReason;
};

/** A private, request-local snapshot; it exposes no mutable row or metadata. */
export type IndexedEvidenceCapture = () => IndexedEvidence;

function unavailable(reason: EvidenceUnavailableReason): IndexedEvidence {
  return { state: 'unavailable', reason };
}

function generationOf(store: EvidenceStorage): string | null {
  try {
    const generation = store.getEvidenceGeneration();
    return typeof generation === 'string' && generation.length > 0 ? generation : null;
  } catch {
    return null;
  }
}

function excerptWindow(content: string, query: string) {
  const points = Array.from(content);
  let matchIndex = -1;
  let matchLength = 0;
  // Whitespace-delimited tokens are literal, case-sensitive substrings, not FTS syntax.
  for (const token of query.split(/\s+/u).filter(Boolean)) {
    const index = content.indexOf(token);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index;
      matchLength = Array.from(token).length;
    }
  }
  const center = matchIndex < 0 ? 0
    : Array.from(content.slice(0, matchIndex)).length + Math.floor(matchLength / 2);
  const start = Math.max(0, Math.min(points.length - 600, center - 300));
  const end = Math.min(points.length, start + 600);
  return {
    excerpt: points.slice(start, end).join(''),
    truncatedBefore: start > 0,
    truncatedAfter: end < points.length,
  };
}

/** Call synchronously when a winning candidate is admitted, before any await. */
export function captureIndexedEvidence(
  store: EvidenceStorage,
  candidate: EvidenceCandidate,
  modelIdentity: string,
  query: string,
  includeEvidence = false,
): IndexedEvidenceCapture | undefined {
  if (!includeEvidence) return undefined;

  const generation = generationOf(store);
  let evidence: IndexedEvidence = unavailable('indexed_generation_unavailable');
  if (generation !== null) {
    try {
      const { filePath, blockId } = candidate;
      const row = store.get(filePath, blockId);
      // get(filePath, null) may return a section: never accept that fallback.
      if (!row || row.filePath !== filePath || row.blockId !== blockId ||
          !modelIdentity || row.metadata?.modelIdentity !== modelIdentity ||
          typeof row.contentHash !== 'string' || row.contentHash.length === 0 ||
          !Number.isFinite(row.updatedAt)) {
        evidence = unavailable('indexed_identity_unverified');
      } else {
        // Copy only primitive evidence fields, not vectors or unrelated metadata.
        const { contentHash, updatedAt } = row;
        const heading = row.metadata.heading;
        const content = store.getContent(filePath, blockId);
        evidence = typeof content !== 'string'
          ? unavailable('indexed_content_missing')
          : {
            state: 'available',
            source: 'indexed_embedding_text',
            blockId,
            contentHash,
            modelIdentity,
            updatedAt,
            ...(typeof heading === 'string' ? {
              heading: Array.from(heading).slice(0, 160).join(''),
              headingTruncated: Array.from(heading).length > 160,
            } : {}),
            ...excerptWindow(content, query),
            currentSourceVerified: false,
          };
      }
    } catch {
      evidence = unavailable('indexed_identity_unverified');
    }
    const after = generationOf(store);
    if (after === null) evidence = unavailable('indexed_generation_unavailable');
    else if (after !== generation) evidence = unavailable('indexed_generation_changed');
  }

  return () => {
    if (evidence.state === 'available') {
      const current = generationOf(store);
      if (current === null) evidence = unavailable('indexed_generation_unavailable');
      else if (current !== generation) evidence = unavailable('indexed_generation_changed');
    }
    // Keep the snapshot private even if a caller mutates a prior finalized result.
    return { ...evidence };
  };
}

/** Call after all awaited enrichment, with no await between this check and emission. */
export function finalizeIndexedEvidence(
  capture: IndexedEvidenceCapture | undefined,
): IndexedEvidence | undefined {
  return capture?.();
}

interface SemanticHit {
  path: string;
  vault?: string;
  title: string;
  similarity: number;
  fusionScore?: number;
  fusionMethod?: string;
  reranker_score?: number | null;
  evidence?: IndexedEvidence;
}

export function compactSemanticHit(hit: SemanticHit): SemanticHit {
  return {
    path: hit.path,
    ...(hit.vault !== undefined ? { vault: hit.vault } : {}),
    title: Array.from(hit.title).slice(0, 160).join(''),
    similarity: hit.similarity,
    ...(hit.fusionScore !== undefined ? { fusionScore: hit.fusionScore } : {}),
    ...(hit.fusionMethod !== undefined ? { fusionMethod: hit.fusionMethod } : {}),
    ...(hit.reranker_score !== undefined ? { reranker_score: hit.reranker_score } : {}),
    ...(hit.evidence !== undefined ? { evidence: hit.evidence } : {}),
  };
}
