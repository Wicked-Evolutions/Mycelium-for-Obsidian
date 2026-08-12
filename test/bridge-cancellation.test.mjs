import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  executeCliProcess,
  OBSIDIAN_CLI_KILL_GRACE_MS,
} from '../dist/cli/bridge.js';

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

test('CLI process execution preserves successful output and ENOENT evidence', async () => {
  const success = await executeCliProcess(
    process.execPath,
    ['--eval', 'process.stdout.write("ok")'],
    1_000,
  );
  assert.equal(success.error, null);
  assert.equal(success.stdout, 'ok');
  assert.equal(success.stderr, '');

  const missing = await executeCliProcess(
    path.join(os.tmpdir(), `missing-mycelium-cli-${process.pid}`),
    [],
    1_000,
  );
  assert.equal(missing.error?.code, 'ENOENT');
});

test('cancellation force-kills a real child that ignores SIGTERM', {
  skip: process.platform === 'win32' ? 'POSIX signal semantics only' : false,
}, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mycelium-cli-cancel-'));
  const readyPath = path.join(temporaryRoot, 'ready');
  const controller = new AbortController();
  let childPid = null;

  const childScript = [
    'import fs from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'fs.writeFileSync(process.argv[1], String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');

  try {
    const execution = executeCliProcess(
      process.execPath,
      ['--input-type=module', '--eval', childScript, readyPath],
      0,
      controller.signal,
    );
    assert.equal(
      await waitFor(() => fs.existsSync(readyPath), 2_000),
      true,
      'child must report ready before cancellation',
    );
    childPid = Number.parseInt(fs.readFileSync(readyPath, 'utf8'), 10);
    assert.equal(Number.isSafeInteger(childPid), true);
    assert.equal(processIsAlive(childPid), true);

    controller.abort();
    const outcome = await execution;
    assert.equal(
      outcome.error?.name === 'AbortError' || outcome.error?.code === 'ABORT_ERR',
      true,
    );
    assert.equal(
      await waitFor(() => !processIsAlive(childPid), OBSIDIAN_CLI_KILL_GRACE_MS + 1_500),
      true,
      'SIGTERM-ignoring child must exit after bounded SIGKILL escalation',
    );
  } finally {
    if (childPid && processIsAlive(childPid)) process.kill(childPid, 'SIGKILL');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
