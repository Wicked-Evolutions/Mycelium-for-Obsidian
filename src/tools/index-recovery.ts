import { EmbeddingStorageError } from '../embeddings/storage.js';
import { SecureFilesystemUnavailableError } from '../embeddings/secure-fs.js';
import { recoveryResponse } from '../tool-outcomes.js';
import type { ToolResponse } from '../types/index.js';

export function storageDiagnostic(error: unknown): {
  code: string; message: string; hint: string;
} | undefined {
  if (error instanceof EmbeddingStorageError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  if (error instanceof SecureFilesystemUnavailableError) {
    return {
      code: 'semantic_storage_unavailable',
      message: 'Secure semantic index storage is unavailable on this platform.',
      hint: 'Use a supported runtime with the secure filesystem helper available. Filesystem tools remain usable.',
    };
  }
  return undefined;
}

export function indexRecoveryResponse(error: unknown): ToolResponse | undefined {
  const diagnostic = storageDiagnostic(error);
  if (!diagnostic) return undefined;
  const active = diagnostic.code === 'index_publication_in_progress';
  return recoveryResponse({
    ...diagnostic,
    status: active ? 'conflict' : 'needs_action',
    retryable: active,
    sideEffects: {
      state: error instanceof EmbeddingStorageError && error.noMutation ? 'none' : 'unknown',
    },
  });
}
