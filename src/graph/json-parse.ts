import { Worker } from 'worker_threads';
import { createAbortError, throwIfAborted } from '../cli/vault-target.js';

const INLINE_JSON_MAX_CHARS = 256 * 1024;

interface WorkerResult<T> {
  ok: boolean;
  value?: T;
}

/** Keep large exact-provider JSON parsing cancellable by moving it off the event loop. */
export async function parseJsonCancellable<T>(
  raw: string,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  if (raw.length <= INLINE_JSON_MAX_CHARS) {
    return JSON.parse(raw) as T;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let terminating = false;
    const worker = new Worker(new URL('./json-parse-worker.js', import.meta.url), {
      workerData: raw
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      if (settled || terminating) return;
      terminating = true;
      void worker.terminate().then(
        () => finish(() => reject(createAbortError())),
        (error) => finish(() => reject(new Error(
          'JSON parse worker could not be terminated.',
          { cause: error }
        )))
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (result: WorkerResult<T>) => {
      if (terminating) return;
      finish(() => {
        if (result.ok) resolve(result.value as T);
        else reject(new Error('Invalid JSON response.'));
      });
    });
    worker.once('error', (error) => {
      if (!terminating) finish(() => reject(error));
    });
    worker.once('exit', (code) => {
      if (!terminating) {
        finish(() => reject(new Error(
          code === 0
            ? 'JSON parse worker exited without a result.'
            : 'JSON parse worker exited unexpectedly.'
        )));
      }
    });
    if (signal?.aborted) onAbort();
  });
}
