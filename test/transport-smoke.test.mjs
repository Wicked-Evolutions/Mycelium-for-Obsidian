import assert from 'node:assert/strict';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createHttpServer } from '../dist/http-server.js';
import { createAllHandlers } from '../dist/tools/index.js';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const serverEntry = path.join(repoRoot, 'dist', 'index.js');
const vaultsToClean = [];

afterEach(() => {
  while (vaultsToClean.length > 0) cleanup(vaultsToClean.pop());
});

function isolatedServerEnvironment(overrides) {
  return { ...overrides };
}

function withTimeout(promise, milliseconds, label) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

async function closeServer(server) {
  await withTimeout(new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  }), 2_000, 'HTTP server close');
}

test('stdio transport initializes, exposes surfaces, accepts a large request, and disconnects cleanly', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repoRoot,
    env: isolatedServerEnvironment({
      OBSIDIAN_VAULTS: JSON.stringify({ TransportVault: vaultDir }),
      OBSIDIAN_AUTO_INDEX: 'false',
      OBSIDIAN_DISABLED_TOOLS: '',
      OBSIDIAN_HTTP_SERVER: 'false',
      OBSIDIAN_READ_ONLY: 'false',
      OBSIDIAN_WRAP_UNTRUSTED: 'false',
      HTTP_MODE: 'false',
    }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'transport-smoke', version: '1.0.0' });
  let clientClosed = false;
  let stderr = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => { stderr += chunk; });

  try {
    await client.connect(transport);
    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, 'mcp-obsidian');
    assert.equal(serverVersion?.version, '1.5.0');

    const child = transport._process;
    assert.ok(child, 'stdio client exposes its spawned process during the test');

    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'list_files'));

    const unknown = await client.callTool({
      name: 'read_note',
      arguments: {},
    });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent?.code, 'unknown_tool');
    assert.deepEqual(JSON.parse(unknown.content[0].text), unknown.structuredContent);
    assert.deepEqual(unknown.structuredContent?.closest_matches, [
      'read_file',
      'find_note_by_name',
      'follow_link',
    ]);

    const prototypeName = await client.callTool({
      name: 'toString',
      arguments: {},
    });
    assert.equal(prototypeName.isError, true);
    assert.equal(prototypeName.structuredContent?.code, 'unknown_tool');
    assert.equal(prototypeName.structuredContent?.requested, 'toString');

    const missingRead = await client.callTool({
      name: 'read_file',
      arguments: { vault: 'TransportVault', path: 'Missing.md' },
    });
    assert.equal(missingRead.isError, true);
    assert.equal(missingRead.structuredContent?.code, 'note_not_found');
    assert.deepEqual(JSON.parse(missingRead.content[0].text), missingRead.structuredContent);

    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.length > 0);

    const listed = await client.callTool({
      name: 'list_files',
      arguments: { vault: 'TransportVault' },
    });
    assert.notEqual(listed.isError, true);

    const content = 'a'.repeat(10 * 1024 * 1024);
    const created = await client.callTool({
      name: 'create_file',
      arguments: { vault: 'TransportVault', path: 'Large.md', content },
    });
    assert.notEqual(created.isError, true);
    assert.equal((await stat(path.join(vaultDir, 'Large.md'))).size, content.length);

    const closed = once(child, 'close');
    await client.close();
    clientClosed = true;
    const [exitCode, signal] = await withTimeout(closed, 3_000, 'stdio server exit');
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.match(stderr, /Shutting down \((transport closed|stdin (EOF|closed))/);
    assert.doesNotMatch(stderr, /Shutting down \(SIGTERM\)/);
  } finally {
    if (!clientClosed) await client.close();
  }
});

test('HTTP transport enforces bearer auth and executes an authenticated call', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);

  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-smoke-secret';
    const config = loadConfigFromVault(vaultDir);
    server = createHttpServer({ port: 0, config });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const rejected = await fetch(`${base}/tools`);
    assert.equal(rejected.status, 401);

    const headers = { Authorization: 'Bearer transport-smoke-secret' };
    const tools = await fetch(`${base}/tools`, { headers });
    assert.equal(tools.status, 200);
    assert.ok((await tools.json()).some(tool => tool.name === 'list_files'));

    const call = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'list_files', args: { vault: 'TransportVault' } }),
    });
    assert.equal(call.status, 200);
    const entries = await call.json();
    assert.ok(Array.isArray(entries));
    assert.ok(entries.some(entry => entry.name === 'Existing.md'));

    const missingRead = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'read_file',
        args: { vault: 'TransportVault', path: 'Missing.md' },
      }),
    });
    assert.equal(missingRead.status, 500);
    const missingReadBody = await missingRead.json();
    assert.equal(missingReadBody.status, 'needs_action');
    assert.equal(missingReadBody.code, 'note_not_found');
    assert.deepEqual(missingReadBody.sideEffects, { state: 'none' });

    const unresolvedLink = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'resolve_wikilink',
        args: { vault: 'TransportVault', link: 'Missing' },
      }),
    });
    assert.equal(unresolvedLink.status, 200);
    const unresolvedLinkBody = await unresolvedLink.json();
    assert.equal(unresolvedLinkBody.status, 'needs_action');
    assert.equal(unresolvedLinkBody.code, 'note_not_found');
    assert.deepEqual(unresolvedLinkBody.sideEffects, { state: 'none' });

    const similarWithoutIndex = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'get_similar',
        args: { vault: 'TransportVault', path: 'Existing.md' },
      }),
    });
    assert.equal(similarWithoutIndex.status, 200);
    const similarWithoutIndexBody = await similarWithoutIndex.json();
    assert.equal(similarWithoutIndexBody.error, 'File not indexed. Run index_file first.');
    assert.equal(similarWithoutIndexBody.path, 'Existing.md');
    assert.equal(similarWithoutIndexBody.status, 'needs_action');
    assert.equal(similarWithoutIndexBody.code, 'file_index_required');
    assert.deepEqual(similarWithoutIndexBody.sideEffects, { state: 'none' });
    assert.deepEqual(similarWithoutIndexBody.actions, [{
      label: 'Index this file',
      tool: 'index_file',
      arguments: { path: 'Existing.md', vault: 'TransportVault' },
    }]);

    const unknown = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_note', args: {} }),
    });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.status, 'needs_action');
    assert.equal(unknownBody.code, 'unknown_tool');
    assert.deepEqual(unknownBody.closest_matches, [
      'read_file',
      'find_note_by_name',
      'follow_link',
    ]);

    const prototypeName = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'constructor', args: {} }),
    });
    assert.equal(prototypeName.status, 404);
    const prototypeBody = await prototypeName.json();
    assert.equal(prototypeBody.code, 'unknown_tool');
    assert.equal(prototypeBody.requested, 'constructor');

    for (const invalidTool of [['read_file'], { name: 'read_file' }]) {
      const invalid = await fetch(`${base}/call`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: invalidTool, args: {} }),
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: 'tool name is required' });
    }
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

test('legacy HTTP routes preserve their historical status matrix', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);
  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;
  let indexCall = 0;

  const recovery = {
    status: 'failed',
    code: 'fixture_failure',
    message: 'The fixture handler could not complete.',
    retryable: true,
    sideEffects: { state: 'none' },
  };
  const response = (payload, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
    ...(isError ? { structuredContent: payload } : {}),
  });

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-legacy-secret';
    const config = loadConfigFromVault(vaultDir);
    server = createHttpServer({
      port: 0,
      config,
      handlers: {
        semantic_search: async ({ query }) => {
          if (query === 'throw') throw new Error('private search diagnostic');
          if (query === 'handler-error') return response(recovery, true);
          return response({ route: 'search', query });
        },
        read_file: async ({ path: filePath }) => {
          if (filePath === 'throw') throw new Error('private read diagnostic');
          if (filePath === 'handler-error') return response(recovery, true);
          return response({ route: 'read', path: filePath });
        },
        index_status: async () => {
          indexCall += 1;
          if (indexCall === 1) return response({ route: 'index', indexed: 0 });
          if (indexCall === 2) return response(recovery, true);
          throw new Error('private index diagnostic');
        },
      },
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: 'Bearer transport-legacy-secret',
      'Content-Type': 'application/json',
    };

    const request = (route, body) => fetch(`${base}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    assert.equal((await request('/search', {})).status, 400);
    const searchSuccess = await request('/search', { query: 'ok' });
    assert.equal(searchSuccess.status, 200);
    assert.deepEqual(await searchSuccess.json(), { route: 'search', query: 'ok' });
    const searchError = await request('/search', { query: 'handler-error' });
    assert.equal(searchError.status, 500);
    assert.deepEqual(await searchError.json(), recovery);
    const searchThrown = await request('/search', { query: 'throw' });
    assert.equal(searchThrown.status, 500);
    assert.deepEqual(await searchThrown.json(), { error: 'The request could not be completed.' });

    assert.equal((await request('/read', {})).status, 400);
    const readSuccess = await request('/read', { path: 'Existing.md' });
    assert.equal(readSuccess.status, 200);
    assert.deepEqual(await readSuccess.json(), { route: 'read', path: 'Existing.md' });
    const readError = await request('/read', { path: 'handler-error' });
    assert.equal(readError.status, 500);
    assert.deepEqual(await readError.json(), recovery);
    const readThrown = await request('/read', { path: 'throw' });
    assert.equal(readThrown.status, 500);
    assert.deepEqual(await readThrown.json(), { error: 'The request could not be completed.' });

    const indexSuccess = await fetch(`${base}/index/status`, { headers });
    assert.equal(indexSuccess.status, 200);
    assert.deepEqual(await indexSuccess.json(), { route: 'index', indexed: 0 });
    const indexError = await fetch(`${base}/index/status`, { headers });
    assert.equal(indexError.status, 200);
    assert.deepEqual(await indexError.json(), recovery);
    const indexThrown = await fetch(`${base}/index/status`, { headers });
    assert.equal(indexThrown.status, 500);
    assert.deepEqual(await indexThrown.json(), { error: 'The request could not be completed.' });
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

test('HTTP transport distinguishes a disabled tool without suggesting it', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);
  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-disabled-secret';
    const config = loadConfigFromVault(vaultDir, { disabled: ['read_file'] });
    server = createHttpServer({ port: 0, config });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/call`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer transport-disabled-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: 'read_file', args: { path: 'Existing.md' } }),
    });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.status, 'unavailable');
    assert.equal(payload.code, 'tool_disabled');
    assert.equal(payload.requested, 'read_file');
    assert.ok(!payload.closest_matches?.includes('read_file'));

    const alias = await fetch(`http://127.0.0.1:${address.port}/call`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer transport-disabled-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: ['read_file'], args: { path: 'Existing.md' } }),
    });
    assert.equal(alias.status, 400);
    assert.deepEqual(await alias.json(), { error: 'tool name is required' });
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

test('HTTP preserves authoritative graph and open-vault error objects', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);
  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;

  const graphOutcome = {
    status: 'analysis_failed',
    message: 'Exact graph analysis failed.',
    decisionState: {
      requestedMode: 'exact',
      targetReadiness: 'open',
      probeInvoked: true,
      openInvoked: false,
      analysisInvoked: true,
    },
  };
  const openVaultOutcome = {
    status: 'exact_unavailable',
    message: 'Exact vault preparation is unavailable.',
    decisionState: {
      requestedMode: 'exact',
      targetReadiness: 'closed',
      probeInvoked: true,
      openInvoked: true,
      analysisInvoked: false,
    },
  };

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-domain-error-secret';
    const config = loadConfigFromVault(vaultDir);
    server = createHttpServer({
      port: 0,
      config,
      handlers: {
        analyze_link_hierarchy: async () => ({
          content: [{ type: 'text', text: JSON.stringify(graphOutcome) }],
          isError: true,
        }),
        open_vault: async () => ({
          content: [{ type: 'text', text: JSON.stringify(openVaultOutcome) }],
          isError: true,
        }),
      },
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: 'Bearer transport-domain-error-secret',
      'Content-Type': 'application/json',
    };

    for (const [tool, expected] of [
      ['analyze_link_hierarchy', graphOutcome],
      ['open_vault', openVaultOutcome],
    ]) {
      const response = await fetch(`${base}/call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool, args: { vault: 'TransportVault' } }),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), expected);
    }
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

test('HTTP client disconnect aborts the request-scoped handler signal', { timeout: 30_000 }, async () => {
  const vaultDir = createTempVault({ 'Existing.md': '# Existing\n' });
  vaultsToClean.push(vaultDir);
  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;
  let markStarted;
  let markAborted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const aborted = new Promise(resolve => { markAborted = resolve; });

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-abort-secret';
    const config = loadConfigFromVault(vaultDir);
    server = createHttpServer({
      port: 0,
      config,
      handlers: {
        slow_test: async (_args, context) => {
          assert.ok(context?.signal, 'HTTP handler receives a request signal');
          markStarted();
          await new Promise(resolve => {
            context.signal.addEventListener('abort', () => {
              markAborted();
              resolve();
            }, { once: true });
          });
          return {
            content: [{ type: 'text', text: '{}' }],
            isError: true,
          };
        },
      },
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/call`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer transport-abort-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: 'slow_test', args: {} }),
      signal: controller.signal,
    });
    await withTimeout(started, 2_000, 'HTTP handler start');
    controller.abort();
    await assert.rejects(request, error => error?.name === 'AbortError');
    await withTimeout(aborted, 2_000, 'HTTP handler abort');
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

test('stdio cancellation interrupts real filesystem graph work and keeps the server responsive', { timeout: 30_000 }, async () => {
  const files = {};
  for (let index = 0; index < 1_500; index++) {
    files[`notes/N${index}.md`] = `[[N${(index + 1) % 1_500}]] [[N${(index + 7) % 1_500}]]\n`;
  }
  files['notes/Large.md'] = `${'plain text '.repeat(800_000)}[[N0]]\n`;
  const vaultDir = createTempVault(files);
  vaultsToClean.push(vaultDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repoRoot,
    env: isolatedServerEnvironment({
      OBSIDIAN_VAULTS: JSON.stringify({ TransportVault: vaultDir }),
      OBSIDIAN_AUTO_INDEX: 'false',
      OBSIDIAN_DISABLED_TOOLS: '',
      OBSIDIAN_HTTP_SERVER: 'false',
      OBSIDIAN_READ_ONLY: 'false',
      OBSIDIAN_WRAP_UNTRUSTED: 'false',
      HTTP_MODE: 'false',
    }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'transport-graph-cancel', version: '1.0.0' });
  let markStarted;
  let markCompleted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const completed = new Promise(resolve => { markCompleted = resolve; });
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => {
    const text = String(chunk);
    if (text.includes('Tool call: analyze_link_hierarchy')) markStarted();
    if (text.includes('Tool complete: analyze_link_hierarchy')) markCompleted();
  });

  try {
    await client.connect(transport);
    const controller = new AbortController();
    const request = client.callTool({
      name: 'analyze_link_hierarchy',
      arguments: { vault: 'TransportVault', providerMode: 'filesystem' },
    }, undefined, { signal: controller.signal });
    await withTimeout(started, 2_000, 'stdio graph handler start');
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(
      request,
      error => error?.name === 'AbortError' || /abort|cancel/i.test(String(error)),
    );
    await withTimeout(completed, 2_000, 'stdio graph handler cancellation');

    const listed = await client.callTool({
      name: 'list_files',
      arguments: { vault: 'TransportVault', path: 'notes', limit: 1 },
    });
    assert.notEqual(listed.isError, true);
  } finally {
    await client.close();
  }
});

test('HTTP disconnect cancels the real graph handler rather than leaving graph work running', { timeout: 30_000 }, async () => {
  const files = {};
  const targets = [];
  for (let index = 0; index < 3_000; index++) {
    files[`notes/N${index}.md`] = '# Target\n';
    targets.push(`[[N${index}]]`);
  }
  files['notes/Hub.md'] = targets.join(' ');
  const vaultDir = createTempVault(files);
  vaultsToClean.push(vaultDir);
  const previousToken = process.env.OBSIDIAN_HTTP_TOKEN;
  let server;
  let markStarted;
  let markFinished;
  const started = new Promise(resolve => { markStarted = resolve; });
  const finished = new Promise(resolve => { markFinished = resolve; });

  try {
    process.env.OBSIDIAN_HTTP_TOKEN = 'transport-real-graph-abort';
    const config = loadConfigFromVault(vaultDir);
    const handlers = createAllHandlers(config);
    const analyze = handlers.analyze_link_hierarchy;
    handlers.analyze_link_hierarchy = async (args, context) => {
      markStarted();
      const result = await analyze(args, context);
      markFinished(result);
      return result;
    };
    server = createHttpServer({ port: 0, config, handlers });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/call`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer transport-real-graph-abort',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'analyze_link_hierarchy',
        args: { vault: 'TransportVault', providerMode: 'filesystem' },
      }),
      signal: controller.signal,
    });
    await withTimeout(started, 2_000, 'HTTP real graph handler start');
    controller.abort();
    await assert.rejects(request, error => error?.name === 'AbortError');
    const result = await withTimeout(finished, 2_000, 'HTTP real graph handler cancellation');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'cancelled');
    assert.equal(body.decisionState.requestedMode, 'filesystem');
    assert.equal(body.decisionState.analysisInvoked, true);
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      if (previousToken === undefined) delete process.env.OBSIDIAN_HTTP_TOKEN;
      else process.env.OBSIDIAN_HTTP_TOKEN = previousToken;
    }
  }
});

function loadConfigFromVault(vaultDir, { disabled = [] } = {}) {
  const previousVaults = process.env.OBSIDIAN_VAULTS;
  const previousDisabled = process.env.OBSIDIAN_DISABLED_TOOLS;
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TransportVault: vaultDir });
  process.env.OBSIDIAN_DISABLED_TOOLS = disabled.join(',');
  try {
    return loadConfig();
  } finally {
    if (previousVaults === undefined) delete process.env.OBSIDIAN_VAULTS;
    else process.env.OBSIDIAN_VAULTS = previousVaults;
    if (previousDisabled === undefined) delete process.env.OBSIDIAN_DISABLED_TOOLS;
    else process.env.OBSIDIAN_DISABLED_TOOLS = previousDisabled;
  }
}
