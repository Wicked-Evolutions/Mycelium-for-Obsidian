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

function loadConfigFromVault(vaultDir) {
  const previousVaults = process.env.OBSIDIAN_VAULTS;
  const previousDisabled = process.env.OBSIDIAN_DISABLED_TOOLS;
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TransportVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  try {
    return loadConfig();
  } finally {
    if (previousVaults === undefined) delete process.env.OBSIDIAN_VAULTS;
    else process.env.OBSIDIAN_VAULTS = previousVaults;
    if (previousDisabled === undefined) delete process.env.OBSIDIAN_DISABLED_TOOLS;
    else process.env.OBSIDIAN_DISABLED_TOOLS = previousDisabled;
  }
}
