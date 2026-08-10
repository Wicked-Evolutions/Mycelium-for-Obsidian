/**
 * Bridge maxBuffer regression (issue #32).
 *
 * ROOT CAUSE: execCli ran execFile('obsidian', …) with no maxBuffer → Node's
 * 1 MB stdout default. The Obsidian graph eval payload (~1.17 MB on a real
 * vault) overran it → ENOBUFS → the graph layer silently degraded to filesystem.
 *
 * Verifies (with --experimental-test-module-mocks):
 *   (1) OBSIDIAN_CLI_MAX_BUFFER === 256 MB and is importable.
 *   (2) execCli passes maxBuffer === OBSIDIAN_CLI_MAX_BUFFER to execFile.
 *   (3) A >1 MB stdout payload resolves (no ENOBUFS) when the buffer is honored.
 *
 * Mocks node:child_process execFile so we capture the options arg without a real
 * Obsidian. Without the experimental flag, mock.module is undefined → skip.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const canMock = typeof mock.module === 'function';

// Capture the options passed to execFile and the callback we drive.
let capturedOptions = null;
let stdoutToReturn = '';
let stderrToReturn = '';
let errorToReturn = null;
let execPlan = [];
let capturedFiles = [];

if (canMock) {
  await mock.module('node:child_process', {
    namedExports: {
      execFile: (file, _args, options, cb) => {
        capturedFiles.push(file);
        capturedOptions = options;
        // Simulate a successful CLI invocation returning a (possibly huge) payload.
        // The real Node execFile would throw ENOBUFS if stdoutToReturn exceeds
        // options.maxBuffer; our mock instead just hands it back, and we assert the
        // option that WOULD prevent that throw is present and large.
        const action = execPlan.shift();
        queueMicrotask(() => cb(
          action?.error ?? errorToReturn,
          action?.stdout ?? stdoutToReturn,
          action?.stderr ?? stderrToReturn
        ));
        return { pid: 1234 };
      },
    },
  });
}

// Import AFTER the mock is registered.
const bridge = await import('../dist/cli/bridge.js');
const {
  execCli,
  obsidianCliCandidatesForPlatform,
  probeObsidianCli,
  OBSIDIAN_CLI_MAX_BUFFER,
} = bridge;

function resetExecResult() {
  stdoutToReturn = '';
  stderrToReturn = '';
  errorToReturn = null;
  execPlan = [];
  capturedFiles = [];
}

describe('bridge maxBuffer (#32)', { skip: !canMock ? 'requires --experimental-test-module-mocks' : false }, () => {
  test('OBSIDIAN_CLI_MAX_BUFFER is exported and equals 256 MB', () => {
    assert.equal(OBSIDIAN_CLI_MAX_BUFFER, 256 * 1024 * 1024);
  });

  test('execCli passes maxBuffer === OBSIDIAN_CLI_MAX_BUFFER to execFile', async () => {
    resetExecResult();
    capturedOptions = null;
    stdoutToReturn = 'ok';
    const out = await execCli(['version']);
    assert.equal(out, 'ok');
    assert.ok(capturedOptions, 'execFile must receive an options object');
    assert.equal(
      capturedOptions.maxBuffer,
      OBSIDIAN_CLI_MAX_BUFFER,
      'execCli must pass the raised maxBuffer'
    );
    // Must be well above Node's 1 MB default (the bug).
    assert.ok(capturedOptions.maxBuffer > 1024 * 1024);
  });

  test('a >1 MB stdout payload no longer throws (buffer honored)', async () => {
    resetExecResult();
    // 1.17 MB — the real-vault graph payload size that overran the 1 MB default.
    stdoutToReturn = 'x'.repeat(1_172_413);
    const out = await execCli(['vault=v', 'eval', 'code=1']);
    assert.equal(out.length, 1_172_413, 'large payload returned intact, no ENOBUFS');
  });

  test('macOS candidates prefer the bundled CLI and never use the bare GUI name', () => {
    const candidates = obsidianCliCandidatesForPlatform('darwin');
    assert.equal(candidates[0], '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli');
    assert.ok(!candidates.includes('obsidian'));
  });

  test('macOS falls through a missing bundled path to obsidian-cli', {
    skip: process.platform !== 'darwin' ? 'macOS executable layout only' : false,
  }, async () => {
    resetExecResult();
    execPlan = [
      { error: Object.assign(new Error('missing bundled CLI'), { code: 'ENOENT' }) },
      { stdout: '1.13.3' },
    ];
    assert.equal(await execCli(['version']), '1.13.3');
    assert.deepEqual(capturedFiles.slice(0, 2), [
      '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',
      'obsidian-cli',
    ]);
  });

  test('probe classifies only ENOENT as CLI unavailable', async () => {
    resetExecResult();
    errorToReturn = Object.assign(new Error('spawn obsidian ENOENT /private/path'), {
      code: 'ENOENT',
    });
    assert.deepEqual(await probeObsidianCli(), { status: 'cli_unavailable' });
  });

  test('probe classifies the app-down sentinel without exposing stderr', async () => {
    resetExecResult();
    errorToReturn = new Error('command failed');
    stderrToReturn = 'ECONNREFUSED /private/vault/path';
    assert.deepEqual(await probeObsidianCli(), { status: 'obsidian_unavailable' });
  });

  test('probe classifies the supported CLI app-down diagnostic from stdout or stderr', async () => {
    const diagnostic = 'The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.';
    for (const channel of ['stdout', 'stderr']) {
      resetExecResult();
      if (channel === 'stdout') stdoutToReturn = `Error: ${diagnostic}`;
      else stderrToReturn = diagnostic;
      assert.deepEqual(await probeObsidianCli(), { status: 'obsidian_unavailable' });
    }
  });

  test('probe maps timeout, permission, and unknown failures to unknown', async () => {
    for (const code of ['ETIMEDOUT', 'EACCES', 'EOTHER']) {
      resetExecResult();
      errorToReturn = Object.assign(new Error(`failure ${code} /private/path`), { code });
      assert.deepEqual(await probeObsidianCli(), { status: 'unknown' });
    }
  });
});
