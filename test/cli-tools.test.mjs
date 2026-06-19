/**
 * CLI-tools test suite — cli-tools.test.mjs
 *
 * Two layers:
 *  (1) MOCKED-BRIDGE unit tests — require --experimental-test-module-mocks.
 *      Stub execCli / execCliForVault / evalInObsidian / isCliAvailable so
 *      every handler can be invoked without Obsidian, and assert that each
 *      tool builds the correct CLI request, parses the response, and handles
 *      the Error:-prefixed-stdout failure path. Also covers withCliCheck gate.
 *      These tests skip (not fail) when the flag is absent.
 *
 *  (2) LIVE-INTEGRATION suite — uses the REAL bridge (active when the mock flag
 *      is NOT passed). Checks isCliAvailable(); if Obsidian is not running the
 *      entire suite is skipped with a clear message. When live, makes read-only
 *      calls via real handlers and spot-checks output shape.
 *
 * Full unit coverage (mock layer):
 *   node --experimental-test-module-mocks --test test/cli-tools.test.mjs
 *
 * Bare run (definition + live integration when Obsidian is up):
 *   node --test test/cli-tools.test.mjs
 *
 * Without the experimental flag, mock.module is undefined and the mock layer
 * is skipped; the live layer runs using the real bridge.
 */

import { test, describe, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTempVault, cleanup } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Detect whether --experimental-test-module-mocks is in effect.
// ---------------------------------------------------------------------------
const canMock = typeof mock.module === 'function';

// ---------------------------------------------------------------------------
// BRIDGE MOCK STUBS
// Set up BEFORE importing cli-tools so the loader intercepts the specifier.
// Only activated when the experimental flag is present.
// ---------------------------------------------------------------------------

/** Last args passed to execCli (captured by mock). */
let lastExecCliArgs = null;
/** Last call captured from execCliForVault. */
let lastExecCliForVaultCall = null;
/** Last call captured from evalInObsidian. */
let lastEvalCall = null;

/** What execCli / execCliForVault resolves to (or throws if starts with Error:). */
let mockCliResult = 'mock-output';
/** What evalInObsidian resolves to (or throws if starts with Error:). */
let mockEvalResult = 'mock-eval-result';
/** Controls isCliAvailable() return value in mock context. */
let mockIsCliAvailable = true;

function resetMockState() {
  lastExecCliArgs = null;
  lastExecCliForVaultCall = null;
  lastEvalCall = null;
  mockCliResult = 'mock-output';
  mockEvalResult = 'mock-eval-result';
  mockIsCliAvailable = true;
}

const BRIDGE_SPECIFIER = new URL('../dist/cli/bridge.js', import.meta.url).href;

if (canMock) {
  await mock.module(BRIDGE_SPECIFIER, {
    namedExports: {
      execCli: async (args, _timeoutMs) => {
        lastExecCliArgs = args;
        if (typeof mockCliResult === 'string' && mockCliResult.startsWith('Error:')) {
          throw new Error(mockCliResult);
        }
        return mockCliResult;
      },
      execCliForVault: async (config, mcpVaultName, command, args = [], _timeoutMs) => {
        lastExecCliForVaultCall = { config, mcpVaultName, command, args };
        if (typeof mockCliResult === 'string' && mockCliResult.startsWith('Error:')) {
          throw new Error(mockCliResult);
        }
        return mockCliResult;
      },
      evalInObsidian: async (config, mcpVaultName, code, _timeoutMs) => {
        lastEvalCall = { config, mcpVaultName, code };
        if (typeof mockEvalResult === 'string' && mockEvalResult.startsWith('Error:')) {
          throw new Error(mockEvalResult);
        }
        return mockEvalResult;
      },
      isCliAvailable: async () => mockIsCliAvailable,
    }
  });
}

// ---------------------------------------------------------------------------
// Import modules under test — AFTER conditional mock.module so the stub
// (if registered) is already in the loader cache.
// ---------------------------------------------------------------------------

const { createCliHandlers, cliTools } = await import('../dist/tools/cli-tools.js');
const { loadConfig } = await import('../dist/config.js');

// When mock is active, also import the real bridge for the live suite
// availability check (via a separate real import that bypasses the mock cache).
// When mock is NOT active, the bridge import above is already real.
const { isCliAvailable: realIsCliAvailableFromBridge } = canMock
  // We cannot re-import the real module when mock has replaced it in the loader.
  // Instead, probe Obsidian directly via child_process when canMock is true.
  // When canMock is false, the real bridge is what cli-tools already loaded.
  ? { isCliAvailable: null }
  : await import('../dist/cli/bridge.js');

// ---------------------------------------------------------------------------
// Shared test vault / config
// ---------------------------------------------------------------------------

let vaultDir;
let config;
let handlers;

before(() => {
  vaultDir = createTempVault({});
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  config = loadConfig();
  handlers = createCliHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertOk(res, label) {
  assert.equal(typeof res, 'object', `${label}: response is an object`);
  assert.ok(Array.isArray(res.content), `${label}: content is an array`);
  assert.ok(res.content.length > 0, `${label}: content is non-empty`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: content[0].text is a string`);
  assert.equal(res.isError, false, `${label}: isError is false — got: ${res.content[0].text}`);
}

function assertError(res, label) {
  assert.equal(typeof res, 'object', `${label}: response is an object`);
  assert.ok(Array.isArray(res.content), `${label}: content is an array`);
  assert.ok(res.content.length > 0, `${label}: content is non-empty`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: content[0].text is a string`);
  assert.equal(res.isError, true, `${label}: isError is true — got: ${res.content[0].text}`);
}

// ============================================================================
// TOOL DEFINITION TESTS — always run (no mock needed)
// ============================================================================

describe('cliTools definitions', () => {
  test('cliTools is a non-empty array', () => {
    assert.ok(Array.isArray(cliTools), 'cliTools must be an array');
    assert.ok(cliTools.length > 0, 'cliTools must not be empty');
  });

  test('every cliTool has name, description, and inputSchema with type "object"', () => {
    for (const t of cliTools) {
      assert.equal(typeof t.name, 'string', `${t.name}: name is a string`);
      assert.ok(t.name.length > 0, `tool name must be non-empty`);
      assert.equal(typeof t.description, 'string', `${t.name}: description is a string`);
      assert.ok(t.description.length > 0, `${t.name}: description must be non-empty`);
      assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name}: inputSchema is an object`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema.type is "object"`);
    }
  });

  test('cliTools contains all 28 expected tool names', () => {
    const expected = [
      'eval_obsidian', 'list_commands', 'execute_command',
      'query_base', 'create_base_item', 'list_base_views',
      'enable_plugin', 'disable_plugin',
      'enable_snippet', 'disable_snippet', 'set_theme',
      'sync_status', 'sync_history', 'sync_read_version',
      'list_versions', 'read_version', 'diff_versions', 'restore_version',
      'list_files_with_history',
      'list_recents',
      'vault_search',
      'list_known_vaults',
      'create_from_template', 'list_templates', 'read_template',
      'get_hotkey', 'list_hotkeys',
      'list_enabled_snippets',
    ];
    const actual = cliTools.map(t => t.name);
    for (const name of expected) {
      assert.ok(actual.includes(name), `cliTools must include "${name}"`);
    }
    assert.equal(actual.length, expected.length, `cliTools must have exactly ${expected.length} tools`);
  });

  test('cliTools tool names are unique', () => {
    const names = cliTools.map(t => t.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, 'cliTools must not have duplicate names');
  });

  test('CLI-requiring tools have descriptions mentioning "Requires Obsidian running"', () => {
    for (const t of cliTools) {
      assert.ok(
        t.description.includes('Requires Obsidian running'),
        `${t.name}: description should mention "Requires Obsidian running"`
      );
    }
  });
});

// ============================================================================
// LAYER 1 — MOCKED-BRIDGE UNIT TESTS (skip without experimental flag)
// ============================================================================

const MOCK_SKIP = canMock ? false : 'requires --experimental-test-module-mocks flag';

// withCliCheck gate
describe('withCliCheck gate', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('when CLI unavailable, eval_obsidian returns isError:true without calling bridge', async () => {
    mockIsCliAvailable = false;
    const res = await handlers.eval_obsidian({ vault: 'TestVault', code: '1+1' });
    assertError(res, 'eval_obsidian CLI unavailable');
    assert.ok(res.content[0].text.includes('not available'), 'error message mentions "not available"');
    assert.equal(lastEvalCall, null, 'evalInObsidian must not be called when CLI unavailable');
  });

  test('when CLI unavailable, list_commands returns isError:true without calling bridge', async () => {
    mockIsCliAvailable = false;
    const res = await handlers.list_commands({ vault: 'TestVault' });
    assertError(res, 'list_commands CLI unavailable');
    assert.equal(lastExecCliForVaultCall, null, 'execCliForVault must not be called');
  });

  test('when CLI unavailable, enable_plugin returns isError:true without calling bridge', async () => {
    mockIsCliAvailable = false;
    const res = await handlers.enable_plugin({ vault: 'TestVault', id: 'my-plugin' });
    assertError(res, 'enable_plugin CLI unavailable');
    assert.equal(lastExecCliForVaultCall, null, 'execCliForVault must not be called');
  });
});

// eval_obsidian
describe('eval_obsidian', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('passes code to evalInObsidian and returns result', async () => {
    mockEvalResult = '42';
    const res = await handlers.eval_obsidian({ vault: 'TestVault', code: '21+21' });
    assertOk(res, 'eval_obsidian');
    assert.equal(res.content[0].text, '42', 'eval result should be returned as-is');
    assert.equal(lastEvalCall?.code, '21+21', 'evalInObsidian called with correct code');
    assert.equal(lastEvalCall?.mcpVaultName, 'TestVault', 'evalInObsidian called with correct vault');
  });

  test('propagates eval errors as thrown exceptions', async () => {
    mockEvalResult = 'Error: ReferenceError: foo is not defined';
    await assert.rejects(
      () => handlers.eval_obsidian({ vault: 'TestVault', code: 'foo' }),
      /ReferenceError/,
      'eval error should propagate'
    );
  });
});

// list_commands
describe('list_commands', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with command "commands" and no filter by default', async () => {
    mockCliResult = 'editor:toggle-bold\napp:open-settings';
    const res = await handlers.list_commands({ vault: 'TestVault' });
    assertOk(res, 'list_commands');
    assert.equal(lastExecCliForVaultCall?.command, 'commands', 'command must be "commands"');
    assert.deepEqual(lastExecCliForVaultCall?.args, [], 'args must be empty when no filter');
    assert.ok(res.content[0].text.includes('editor:toggle-bold'), 'response must echo CLI output');
  });

  test('passes filter arg when provided', async () => {
    mockCliResult = 'editor:toggle-bold';
    await handlers.list_commands({ vault: 'TestVault', filter: 'editor' });
    assert.ok(
      lastExecCliForVaultCall?.args.includes('filter=editor'),
      'filter arg must be passed as "filter=editor"'
    );
  });

  test('returns fallback text when CLI returns empty string', async () => {
    mockCliResult = '';
    const res = await handlers.list_commands({ vault: 'TestVault' });
    assertOk(res, 'list_commands empty');
    assert.equal(res.content[0].text, 'No commands found.', 'fallback text for empty result');
  });
});

// execute_command
describe('execute_command', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with command "command" and id arg', async () => {
    mockCliResult = '';
    const res = await handlers.execute_command({ vault: 'TestVault', id: 'editor:toggle-bold' });
    assertOk(res, 'execute_command');
    assert.equal(lastExecCliForVaultCall?.command, 'command', 'command must be "command"');
    assert.ok(
      lastExecCliForVaultCall?.args.includes('id=editor:toggle-bold'),
      'id arg must be passed'
    );
    assert.ok(
      res.content[0].text.includes('editor:toggle-bold'),
      'confirmation message should include command id'
    );
  });
});

// query_base
describe('query_base', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with base:query and file/path/view/format args', async () => {
    mockCliResult = '[{"name":"task1"}]';
    const res = await handlers.query_base({
      vault: 'TestVault',
      file: 'Tasks',
      path: 'Bases/Tasks.base',
      view: 'Table',
      format: 'json',
    });
    assertOk(res, 'query_base');
    assert.equal(lastExecCliForVaultCall?.command, 'base:query');
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('file=Tasks'), 'file arg must be passed');
    assert.ok(args.includes('path=Bases/Tasks.base'), 'path arg must be passed');
    assert.ok(args.includes('view=Table'), 'view arg must be passed');
    assert.ok(args.includes('format=json'), 'format arg must be passed');
  });

  test('returns fallback text when CLI returns empty string', async () => {
    mockCliResult = '';
    const res = await handlers.query_base({ vault: 'TestVault' });
    assertOk(res, 'query_base empty');
    assert.equal(res.content[0].text, 'No results.', 'fallback for empty result');
  });
});

// create_base_item
describe('create_base_item', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with base:create and all optional args', async () => {
    mockCliResult = '';
    const res = await handlers.create_base_item({
      vault: 'TestVault',
      file: 'Tasks',
      view: 'Table',
      name: 'New Task',
      content: 'Initial content',
    });
    assertOk(res, 'create_base_item');
    assert.equal(lastExecCliForVaultCall?.command, 'base:create');
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('file=Tasks'), 'file arg must be passed');
    assert.ok(args.includes('view=Table'), 'view arg must be passed');
    assert.ok(args.includes('name=New Task'), 'name arg must be passed');
    assert.ok(args.includes('content=Initial content'), 'content arg must be passed');
  });

  test('returns fixed confirmation message', async () => {
    mockCliResult = '';
    const res = await handlers.create_base_item({ vault: 'TestVault', name: 'X' });
    assertOk(res, 'create_base_item confirm');
    assert.equal(res.content[0].text, 'Base item created.', 'confirmation message');
  });
});

// list_base_views
describe('list_base_views', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with base:views and file/path args', async () => {
    mockCliResult = 'Table\nGallery';
    const res = await handlers.list_base_views({
      vault: 'TestVault',
      file: 'Tasks',
      path: 'Bases/Tasks.base',
    });
    assertOk(res, 'list_base_views');
    assert.equal(lastExecCliForVaultCall?.command, 'base:views');
    assert.ok(lastExecCliForVaultCall.args.includes('file=Tasks'), 'file arg must be passed');
    assert.ok(lastExecCliForVaultCall.args.includes('path=Bases/Tasks.base'), 'path arg must be passed');
    assert.ok(res.content[0].text.includes('Table'), 'output echoed');
  });

  test('returns fallback text when CLI returns empty string', async () => {
    mockCliResult = '';
    const res = await handlers.list_base_views({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No views found.', 'fallback for empty result');
  });
});

// enable_plugin / disable_plugin
describe('enable_plugin', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with plugin:enable and id arg', async () => {
    mockCliResult = '';
    const res = await handlers.enable_plugin({ vault: 'TestVault', id: 'dataview' });
    assertOk(res, 'enable_plugin');
    assert.equal(lastExecCliForVaultCall?.command, 'plugin:enable');
    assert.ok(lastExecCliForVaultCall.args.includes('id=dataview'), 'id arg must be passed');
    assert.ok(res.content[0].text.includes('dataview'), 'confirmation mentions plugin id');
    assert.ok(res.content[0].text.includes('enabled'), 'confirmation says enabled');
  });
});

describe('disable_plugin', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with plugin:disable and id arg', async () => {
    mockCliResult = '';
    const res = await handlers.disable_plugin({ vault: 'TestVault', id: 'dataview' });
    assertOk(res, 'disable_plugin');
    assert.equal(lastExecCliForVaultCall?.command, 'plugin:disable');
    assert.ok(lastExecCliForVaultCall.args.includes('id=dataview'), 'id arg must be passed');
    assert.ok(res.content[0].text.includes('disabled'), 'confirmation says disabled');
  });
});

// enable_snippet / disable_snippet
describe('enable_snippet', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with snippet:enable and name arg', async () => {
    mockCliResult = '';
    const res = await handlers.enable_snippet({ vault: 'TestVault', name: 'my-styles' });
    assertOk(res, 'enable_snippet');
    assert.equal(lastExecCliForVaultCall?.command, 'snippet:enable');
    assert.ok(lastExecCliForVaultCall.args.includes('name=my-styles'), 'name arg must be passed');
    assert.ok(res.content[0].text.includes('my-styles'), 'confirmation mentions snippet name');
  });
});

describe('disable_snippet', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with snippet:disable and name arg', async () => {
    mockCliResult = '';
    const res = await handlers.disable_snippet({ vault: 'TestVault', name: 'my-styles' });
    assertOk(res, 'disable_snippet');
    assert.equal(lastExecCliForVaultCall?.command, 'snippet:disable');
    assert.ok(lastExecCliForVaultCall.args.includes('name=my-styles'), 'name arg must be passed');
  });
});

// set_theme
describe('set_theme', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with theme:set and name arg', async () => {
    mockCliResult = '';
    const res = await handlers.set_theme({ vault: 'TestVault', name: 'Minimal' });
    assertOk(res, 'set_theme');
    assert.equal(lastExecCliForVaultCall?.command, 'theme:set');
    assert.ok(lastExecCliForVaultCall.args.includes('name=Minimal'), 'name arg must be passed');
    assert.ok(res.content[0].text.includes('Minimal'), 'confirmation mentions theme name');
  });

  test('confirmation uses "default" when name is empty string', async () => {
    mockCliResult = '';
    const res = await handlers.set_theme({ vault: 'TestVault', name: '' });
    assertOk(res, 'set_theme empty name');
    assert.ok(res.content[0].text.includes('default'), 'confirmation says default');
  });
});

// sync_status / sync_history / sync_read_version
describe('sync_status', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with sync:status', async () => {
    mockCliResult = 'active';
    const res = await handlers.sync_status({ vault: 'TestVault' });
    assertOk(res, 'sync_status');
    assert.equal(lastExecCliForVaultCall?.command, 'sync:status');
    assert.ok(res.content[0].text.includes('active'), 'output echoed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.sync_status({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'Sync status unavailable.', 'fallback for empty');
  });
});

describe('sync_history', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with sync:history and file arg', async () => {
    mockCliResult = 'v1 2024-01-01';
    const res = await handlers.sync_history({ vault: 'TestVault', file: 'Note.md' });
    assertOk(res, 'sync_history');
    assert.equal(lastExecCliForVaultCall?.command, 'sync:history');
    assert.ok(lastExecCliForVaultCall.args.includes('file=Note.md'), 'file arg must be passed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.sync_history({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No sync history.', 'fallback for empty');
  });
});

describe('sync_read_version', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with sync:read, file, and version args', async () => {
    mockCliResult = '# Old content';
    const res = await handlers.sync_read_version({
      vault: 'TestVault',
      file: 'Note.md',
      version: 3,
    });
    assertOk(res, 'sync_read_version');
    assert.equal(lastExecCliForVaultCall?.command, 'sync:read');
    assert.ok(lastExecCliForVaultCall.args.includes('file=Note.md'), 'file arg must be passed');
    assert.ok(lastExecCliForVaultCall.args.includes('version=3'), 'version arg must be passed');
  });
});

// list_versions / read_version / diff_versions / restore_version
describe('list_versions', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with "diff" command and optional filter', async () => {
    mockCliResult = 'v1\nv2';
    const res = await handlers.list_versions({
      vault: 'TestVault',
      file: 'Note.md',
      filter: 'local',
    });
    assertOk(res, 'list_versions');
    assert.equal(lastExecCliForVaultCall?.command, 'diff');
    assert.ok(lastExecCliForVaultCall.args.includes('file=Note.md'), 'file arg must be passed');
    assert.ok(lastExecCliForVaultCall.args.includes('filter=local'), 'filter arg must be passed');
  });

  test('omits filter arg when not provided', async () => {
    mockCliResult = 'v1';
    await handlers.list_versions({ vault: 'TestVault', file: 'Note.md' });
    assert.ok(
      !lastExecCliForVaultCall.args.some(a => a.startsWith('filter=')),
      'filter arg must not be passed when absent'
    );
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_versions({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No versions found.', 'fallback for empty');
  });
});

describe('read_version', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with history:read and version arg', async () => {
    mockCliResult = '# Version 2 content';
    const res = await handlers.read_version({ vault: 'TestVault', file: 'Note.md', version: 2 });
    assertOk(res, 'read_version');
    assert.equal(lastExecCliForVaultCall?.command, 'history:read');
    assert.ok(lastExecCliForVaultCall.args.includes('version=2'), 'version arg must be passed');
    assert.ok(lastExecCliForVaultCall.args.includes('file=Note.md'), 'file arg must be passed');
  });
});

describe('diff_versions', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with "diff" command and from/to/filter args', async () => {
    mockCliResult = '-old line\n+new line';
    const res = await handlers.diff_versions({
      vault: 'TestVault',
      file: 'Note.md',
      from: 1,
      to: 2,
      filter: 'local',
    });
    assertOk(res, 'diff_versions');
    assert.equal(lastExecCliForVaultCall?.command, 'diff');
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('file=Note.md'), 'file arg must be passed');
    assert.ok(args.includes('from=1'), 'from arg must be passed');
    assert.ok(args.includes('to=2'), 'to arg must be passed');
    assert.ok(args.includes('filter=local'), 'filter arg must be passed');
  });

  test('omits from/to when not provided', async () => {
    mockCliResult = 'diff output';
    await handlers.diff_versions({ vault: 'TestVault', file: 'Note.md' });
    const args = lastExecCliForVaultCall.args;
    assert.ok(!args.some(a => a.startsWith('from=')), 'from must not appear when absent');
    assert.ok(!args.some(a => a.startsWith('to=')), 'to must not appear when absent');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.diff_versions({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No versions to diff.', 'fallback for empty');
  });
});

describe('restore_version', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with history:restore and version arg', async () => {
    mockCliResult = '';
    const res = await handlers.restore_version({ vault: 'TestVault', file: 'Note.md', version: 5 });
    assertOk(res, 'restore_version');
    assert.equal(lastExecCliForVaultCall?.command, 'history:restore');
    assert.ok(lastExecCliForVaultCall.args.includes('version=5'), 'version arg must be passed');
    assert.ok(res.content[0].text.includes('5'), 'confirmation mentions version number');
  });
});

// list_files_with_history
describe('list_files_with_history', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with history:list', async () => {
    mockCliResult = 'Note.md\nDaily/2024-01-01.md';
    const res = await handlers.list_files_with_history({ vault: 'TestVault' });
    assertOk(res, 'list_files_with_history');
    assert.equal(lastExecCliForVaultCall?.command, 'history:list');
    assert.ok(res.content[0].text.includes('Note.md'), 'output echoed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_files_with_history({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No files with history.', 'fallback for empty');
  });
});

// list_recents
describe('list_recents', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with recents command', async () => {
    mockCliResult = 'Note.md\nDaily/2024-01-01.md';
    const res = await handlers.list_recents({ vault: 'TestVault' });
    assertOk(res, 'list_recents');
    assert.equal(lastExecCliForVaultCall?.command, 'recents');
    assert.ok(res.content[0].text.includes('Note.md'), 'output echoed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_recents({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No recent files.', 'fallback for empty');
  });
});

// vault_search
describe('vault_search', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('uses search:context command by default (context not explicitly false)', async () => {
    mockCliResult = 'results here';
    await handlers.vault_search({ vault: 'TestVault', query: 'alpha' });
    assert.equal(lastExecCliForVaultCall?.command, 'search:context', 'default command is search:context');
  });

  test('uses plain search command when context is false', async () => {
    mockCliResult = 'results here';
    await handlers.vault_search({ vault: 'TestVault', query: 'alpha', context: false });
    assert.equal(lastExecCliForVaultCall?.command, 'search', 'command is search when context=false');
  });

  test('passes query, folder (as path=), limit, and format args', async () => {
    mockCliResult = '[]';
    await handlers.vault_search({
      vault: 'TestVault',
      query: 'alpha',
      folder: 'Notes',
      limit: 10,
      format: 'json',
    });
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('query=alpha'), 'query arg must be passed');
    assert.ok(args.includes('path=Notes'), 'folder becomes path= arg');
    assert.ok(args.includes('limit=10'), 'limit arg must be passed');
    assert.ok(args.includes('format=json'), 'format arg must be passed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.vault_search({ vault: 'TestVault', query: 'nothing' });
    assert.equal(res.content[0].text, 'No results found.', 'fallback for empty');
  });
});

// list_known_vaults — calls execCli directly, NOT execCliForVault
describe('list_known_vaults', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCli with ["vaults", "verbose"] and does NOT call execCliForVault', async () => {
    mockCliResult = 'Vault1 /path/to/vault1\nVault2 /path/to/vault2';
    const res = await handlers.list_known_vaults({});
    assertOk(res, 'list_known_vaults');
    assert.deepEqual(
      lastExecCliArgs,
      ['vaults', 'verbose'],
      'execCli must be called with ["vaults", "verbose"]'
    );
    assert.equal(lastExecCliForVaultCall, null, 'execCliForVault must NOT be called');
    assert.ok(res.content[0].text.includes('Vault1'), 'output echoed');
  });

  test('returns fallback text when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_known_vaults({});
    assert.equal(res.content[0].text, 'No vaults found.', 'fallback for empty');
  });
});

// create_from_template
describe('create_from_template', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with create command and all optional args', async () => {
    mockCliResult = '';
    const res = await handlers.create_from_template({
      vault: 'TestVault',
      template: 'Daily Note',
      name: 'My Note',
      path: 'Notes/My Note',
      content: 'extra',
      overwrite: true,
    });
    assertOk(res, 'create_from_template');
    assert.equal(lastExecCliForVaultCall?.command, 'create');
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('template=Daily Note'), 'template arg must be passed');
    assert.ok(args.includes('name=My Note'), 'name arg must be passed');
    assert.ok(args.includes('path=Notes/My Note'), 'path arg must be passed');
    assert.ok(args.includes('content=extra'), 'content arg must be passed');
    assert.ok(args.includes('overwrite'), 'overwrite flag must be passed');
    assert.ok(res.content[0].text.includes('Daily Note'), 'confirmation mentions template name');
  });

  test('omits optional args when not provided', async () => {
    mockCliResult = '';
    await handlers.create_from_template({ vault: 'TestVault', template: 'Weekly' });
    const args = lastExecCliForVaultCall.args;
    assert.ok(!args.some(a => a.startsWith('name=')), 'name must not appear when absent');
    assert.ok(!args.some(a => a.startsWith('path=')), 'path must not appear when absent');
    assert.ok(!args.some(a => a.startsWith('content=')), 'content must not appear when absent');
    assert.ok(!args.includes('overwrite'), 'overwrite must not appear when absent');
  });
});

// list_templates
describe('list_templates', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with templates command', async () => {
    mockCliResult = 'Daily Note\nWeekly Review';
    const res = await handlers.list_templates({ vault: 'TestVault' });
    assertOk(res, 'list_templates');
    assert.equal(lastExecCliForVaultCall?.command, 'templates');
    assert.ok(res.content[0].text.includes('Daily Note'), 'output echoed');
  });

  test('returns fallback when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_templates({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No templates found.', 'fallback for empty');
  });
});

// read_template
describe('read_template', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with template:read and name arg', async () => {
    mockCliResult = '# {{title}}\n{{date}}';
    const res = await handlers.read_template({ vault: 'TestVault', name: 'Daily Note' });
    assertOk(res, 'read_template');
    assert.equal(lastExecCliForVaultCall?.command, 'template:read');
    assert.ok(lastExecCliForVaultCall.args.includes('name=Daily Note'), 'name arg must be passed');
    assert.ok(!lastExecCliForVaultCall.args.includes('resolve'), 'resolve must not appear when absent');
  });

  test('passes resolve flag and title arg when provided', async () => {
    mockCliResult = '# My Note\n2024-01-01';
    await handlers.read_template({
      vault: 'TestVault',
      name: 'Daily Note',
      resolve: true,
      title: 'My Note',
    });
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('resolve'), 'resolve flag must be passed');
    assert.ok(args.includes('title=My Note'), 'title arg must be passed');
  });

  test('returns fallback when empty', async () => {
    mockCliResult = '';
    const res = await handlers.read_template({ vault: 'TestVault', name: 'Missing' });
    assert.equal(res.content[0].text, 'Template not found.', 'fallback for empty');
  });
});

// get_hotkey
describe('get_hotkey', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with hotkey command and id arg', async () => {
    mockCliResult = 'Ctrl+B';
    const res = await handlers.get_hotkey({ vault: 'TestVault', id: 'editor:toggle-bold' });
    assertOk(res, 'get_hotkey');
    assert.equal(lastExecCliForVaultCall?.command, 'hotkey');
    assert.ok(lastExecCliForVaultCall.args.includes('id=editor:toggle-bold'), 'id arg must be passed');
    assert.ok(!lastExecCliForVaultCall.args.includes('verbose'), 'verbose must not appear when absent');
  });

  test('passes verbose flag when true', async () => {
    mockCliResult = 'Ctrl+B (default)';
    await handlers.get_hotkey({ vault: 'TestVault', id: 'editor:toggle-bold', verbose: true });
    assert.ok(lastExecCliForVaultCall.args.includes('verbose'), 'verbose flag must be passed');
  });

  test('returns fallback when empty', async () => {
    mockCliResult = '';
    const res = await handlers.get_hotkey({ vault: 'TestVault', id: 'editor:toggle-bold' });
    assert.equal(res.content[0].text, 'No hotkey assigned.', 'fallback for empty');
  });
});

// list_hotkeys
describe('list_hotkeys', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with hotkeys command with no args by default', async () => {
    mockCliResult = 'editor:toggle-bold\tCtrl+B';
    const res = await handlers.list_hotkeys({ vault: 'TestVault' });
    assertOk(res, 'list_hotkeys');
    assert.equal(lastExecCliForVaultCall?.command, 'hotkeys');
    assert.deepEqual(lastExecCliForVaultCall.args, [], 'args must be empty by default');
  });

  test('passes verbose, all, and format args when provided', async () => {
    mockCliResult = '...';
    await handlers.list_hotkeys({
      vault: 'TestVault',
      verbose: true,
      all: true,
      format: 'json',
    });
    const args = lastExecCliForVaultCall.args;
    assert.ok(args.includes('verbose'), 'verbose flag must be passed');
    assert.ok(args.includes('all'), 'all flag must be passed');
    assert.ok(args.includes('format=json'), 'format arg must be passed');
  });

  test('returns fallback when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_hotkeys({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No hotkeys configured.', 'fallback for empty');
  });
});

// list_enabled_snippets
describe('list_enabled_snippets', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('calls execCliForVault with snippets:enabled', async () => {
    mockCliResult = 'my-styles\ndark-mode';
    const res = await handlers.list_enabled_snippets({ vault: 'TestVault' });
    assertOk(res, 'list_enabled_snippets');
    assert.equal(lastExecCliForVaultCall?.command, 'snippets:enabled');
    assert.ok(res.content[0].text.includes('my-styles'), 'output echoed');
  });

  test('returns fallback when empty', async () => {
    mockCliResult = '';
    const res = await handlers.list_enabled_snippets({ vault: 'TestVault' });
    assert.equal(res.content[0].text, 'No snippets enabled.', 'fallback for empty');
  });
});

// Error:-prefixed stdout failure path
describe('Error:-prefixed stdout failure path', { skip: MOCK_SKIP }, () => {
  beforeEach(() => resetMockState());

  test('list_commands propagates CLI "Error:" prefix as thrown exception', async () => {
    mockCliResult = 'Error: vault "Bogus" not found';
    await assert.rejects(
      () => handlers.list_commands({ vault: 'TestVault' }),
      /vault "Bogus" not found/,
      'Error: prefix should cause bridge rejection to propagate'
    );
  });

  test('enable_plugin propagates CLI "Error:" prefix as thrown exception', async () => {
    mockCliResult = 'Error: plugin "bad-id" is not installed';
    await assert.rejects(
      () => handlers.enable_plugin({ vault: 'TestVault', id: 'bad-id' }),
      /bad-id/,
      'Error: prefix should propagate'
    );
  });

  test('vault_search propagates CLI "Error:" prefix as thrown exception', async () => {
    mockCliResult = 'Error: invalid query syntax';
    await assert.rejects(
      () => handlers.vault_search({ vault: 'TestVault', query: '[[bad' }),
      /invalid query/,
      'Error: prefix should propagate'
    );
  });

  test('list_known_vaults propagates "Error:" prefix from execCli', async () => {
    mockCliResult = 'Error: Obsidian not running';
    await assert.rejects(
      () => handlers.list_known_vaults({}),
      /Obsidian not running/,
      'Error: prefix in execCli output should propagate'
    );
  });
});

// ============================================================================
// LAYER 2 — LIVE-INTEGRATION (skippable)
//
// Active only when the mock flag is NOT in effect (so the real bridge is wired
// into createCliHandlers). Checks isCliAvailable() first; skips if Obsidian is
// not running.
//
// IMPORTANT: describe() callback must be SYNCHRONOUS — Node's test runner does
// not await an async describe body, so async top-level awaits inside describe
// cause subtests to be registered too late and get cancelled. We probe
// isCliAvailable() at the top level (above) and pass the resolved boolean in.
// ============================================================================

// Probe CLI availability at the top level so we have a sync value for describe.
// When canMock is true the bridge is mocked; use a direct execFile probe instead.
const isLiveCli = await (async () => {
  if (canMock) {
    // bridge is mocked — use raw child_process to check real Obsidian
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('obsidian', ['version'], {
        timeout: 5000,
        env: { ...process.env, PATH: `${process.env.PATH}:/Applications/Obsidian.app/Contents/MacOS` }
      });
      return true;
    } catch {
      return false;
    }
  } else {
    // real bridge loaded — ask it
    return realIsCliAvailableFromBridge();
  }
})();

const LIVE_SKIP_REASON = canMock
  ? 'live integration uses real handlers — run under bare node --test (no mock flag)'
  : isLiveCli
    ? false
    : 'Obsidian 1.12+ is not running or CLI is not enabled. Start Obsidian to run live tests.';

describe('live integration (skippable — requires Obsidian running)', { skip: LIVE_SKIP_REASON }, () => {
  // Synchronous describe body: tests registered immediately, no async registration.
  // Actual test bodies are async (the handler calls are async).

  // list_known_vaults is vault-agnostic (calls execCli directly) — safest live test.
  test('live: list_known_vaults returns a non-error response with content', async () => {
    const res = await handlers.list_known_vaults({});
    assertOk(res, 'live list_known_vaults');
    const lines = res.content[0].text.split('\n').filter(l => l.trim().length > 0);
    assert.ok(lines.length > 0, 'list_known_vaults must return at least one vault line');
  });

  test('live: list_commands returns a non-error response or throws an Error (vault may be unknown to Obsidian)', async () => {
    // TestVault maps to the temp dir folder name which Obsidian may not recognise.
    // Either a valid ToolResponse or a thrown Error is acceptable.
    try {
      const res = await handlers.list_commands({ vault: 'TestVault' });
      assert.equal(typeof res, 'object', 'response is an object');
      assert.ok(Array.isArray(res.content), 'content is an array');
      assert.ok(res.content.length > 0, 'content is non-empty');
      assert.equal(typeof res.content[0].text, 'string', 'content[0].text is a string');
    } catch (err) {
      assert.ok(err instanceof Error, 'thrown value must be an Error instance');
    }
  });
});
