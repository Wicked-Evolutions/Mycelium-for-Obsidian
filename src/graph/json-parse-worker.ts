import { parentPort, workerData } from 'worker_threads';

if (!parentPort || typeof workerData !== 'string') {
  throw new Error('JSON parse worker requires a parent port and string input.');
}

try {
  parentPort.postMessage({ ok: true, value: JSON.parse(workerData) });
} catch {
  parentPort.postMessage({ ok: false });
}
