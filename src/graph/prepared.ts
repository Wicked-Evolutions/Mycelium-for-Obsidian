import { BaseGraph } from './types.js';
import { createAbortError, throwIfAborted } from '../cli/vault-target.js';

export interface PreparedExactGraphSnapshot {
  canonicalPath: string;
  vaultId: string;
  digest: string;
  capturedAt: string;
  graph: BaseGraph;
}

const snapshots = new Map<string, PreparedExactGraphSnapshot>();
const lockTails = new Map<string, Promise<void>>();

function cloneBaseGraph(graph: BaseGraph): BaseGraph {
  return {
    ...graph,
    nodes: [...graph.nodes],
    edges: graph.edges.map((edge) => ({ ...edge })),
    inDegree: new Map(graph.inDegree),
    outDegree: new Map(graph.outDegree),
    providerState: { ...graph.providerState }
  };
}

function cloneSnapshot(snapshot: PreparedExactGraphSnapshot): PreparedExactGraphSnapshot {
  return {
    ...snapshot,
    graph: cloneBaseGraph(snapshot.graph)
  };
}

export function replacePreparedExactGraph(
  snapshot: PreparedExactGraphSnapshot
): void {
  snapshots.set(snapshot.canonicalPath, cloneSnapshot(snapshot));
}

export function getPreparedExactGraph(
  canonicalPath: string
): PreparedExactGraphSnapshot | undefined {
  const snapshot = snapshots.get(canonicalPath);
  return snapshot ? cloneSnapshot(snapshot) : undefined;
}

export function invalidatePreparedExactGraph(canonicalPath: string): void {
  snapshots.delete(canonicalPath);
}

export function clearPreparedExactGraphs(): void {
  snapshots.clear();
}

/**
 * Serialize preparation and exact snapshot consumption for one canonical vault.
 * Independent vaults retain independent queues.
 */
export async function withPreparedGraphLock<T>(
  canonicalPath: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  throwIfAborted(signal);

  const previous = lockTails.get(canonicalPath) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => slot);
  lockTails.set(canonicalPath, tail);

  try {
    await waitForTurn(previous, signal);
    throwIfAborted(signal);
    return await operation();
  } finally {
    release();
    void tail.then(() => {
      if (lockTails.get(canonicalPath) === tail) {
        lockTails.delete(canonicalPath);
      }
    });
  }
}

function waitForTurn(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
