import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SERVER_VERSION } from '../dist/version.js';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function readJson(file) {
  return JSON.parse(await readFile(path.join(repoRoot, file), 'utf8'));
}

test('npm and MCP server candidate versions are coherent', async () => {
  const packageJson = await readJson('package.json');
  const packageLock = await readJson('package-lock.json');

  assert.equal(packageJson.name, '@wickedevolutions/mcp-obsidian');
  assert.deepEqual(packageJson.bin, { 'mcp-obsidian': 'dist/index.js' });
  assert.equal(packageJson.version, '1.5.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(packageJson.engines.node, '>=20.0.0');
  assert.equal(packageJson.publishConfig?.access, 'public');
});

test('MCPB metadata remains on v1.4.0 by founder-directed exception', async () => {
  const manifest = await readJson('manifest.json');
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');

  assert.equal(manifest.version, '1.4.0');
  assert.match(readme, /MCPB channel remains on v1\.4\.0/);
  assert.match(readme, /releases\/download\/v1\.4\.0\/mcp-obsidian\.mcpb/);
  assert.doesNotMatch(readme, /releases\/latest\/download\/mcp-obsidian\.mcpb/);
});

test('release-facing installation, HTTP, and security documentation is publishable', async () => {
  const [readme, envExample, security, changelog] = await Promise.all([
    readFile(path.join(repoRoot, 'README.md'), 'utf8'),
    readFile(path.join(repoRoot, '.env.example'), 'utf8'),
    readFile(path.join(repoRoot, 'SECURITY.md'), 'utf8'),
    readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'),
  ]);

  assert.match(readme, /"command": "mcp-obsidian",\s+"args": \[\]/);
  assert.doesNotMatch(readme, /"command": "npx",\s+"args": \["mcp-obsidian"\]/);
  assert.doesNotMatch(readme, /\bnpx[^\n`]*(?<![@/])\bmcp-obsidian(?:@[^\s`]+)?(?=\s|$|`)/m);
  assert.match(readme, /npx @wickedevolutions\/mcp-obsidian/);
  assert.match(readme, /OBSIDIAN_HTTP_TOKEN='replace-with-a-strong-secret'/);
  assert.match(readme, /Authorization: Bearer \$OBSIDIAN_HTTP_TOKEN/);
  assert.match(readme, /Data-bearing HTTP API endpoints require/);
  assert.match(readme, /`\/health` and CORS preflight `OPTIONS` responses are unauthenticated/);
  assert.match(readme, /derived semantic-index writes remain allowed/);
  assert.match(readme, /`OBSIDIAN_AUTO_INDEX=false` to prevent background indexing/);
  assert.match(
    readme,
    /^\| `OBSIDIAN_READ_ONLY` \| Refuse note\/content and Obsidian app-state mutations; derived semantic-index writes remain allowed \| `false` \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_WRAP_UNTRUSTED` \| Wrap file content in untrusted-content markers when set to `true` \| `false` \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_AUTO_INDEX` \| Watch vault changes and write derived semantic-index updates; set to `false` to disable background indexing \| `true` \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_HTTP_SERVER` \/ `HTTP_MODE` \| Run as HTTP server instead of STDIO \| `false` \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_HTTP_PORT` \/ `HTTP_PORT` \| HTTP server port \| `3456` \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_HTTP_TOKEN` \| Bearer token for data-bearing HTTP API endpoints; `\/health` and CORS preflight are unauthenticated \| random per process \|$/m,
  );
  assert.match(
    readme,
    /^\| `OBSIDIAN_HTTP_CORS_ORIGIN` \| Allowed browser origin for HTTP mode \| `app:\/\/obsidian\.md` \|$/m,
  );
  assert.match(readme, /server generates a random token and prints\s+it to stderr for that process only/);

  assert.match(envExample, /^# OBSIDIAN_READ_ONLY=true$/m);
  assert.match(envExample, /^# OBSIDIAN_WRAP_UNTRUSTED=true$/m);
  assert.match(envExample, /^# OBSIDIAN_AUTO_INDEX=false$/m);
  assert.match(envExample, /^# OBSIDIAN_HTTP_SERVER=true$/m);
  assert.match(envExample, /^# OBSIDIAN_HTTP_PORT=3456$/m);
  assert.match(envExample, /^# OBSIDIAN_HTTP_TOKEN=replace-with-a-strong-secret$/m);
  assert.match(envExample, /^# OBSIDIAN_HTTP_CORS_ORIGIN=app:\/\/obsidian\.md$/m);

  assert.match(
    security,
    /github\.com\/Wicked-Evolutions\/Mycelium-for-Obsidian\/security\/advisories\/new/,
  );
  assert.doesNotMatch(security, /github\.com\/Wicked-Evolutions\/mcp-obsidian\//);
  assert.match(changelog, /^## \[1\.5\.0\] - 2026-08-10$/m);
  assert.doesNotMatch(changelog, /^## \[1\.5\.0\] - Unreleased$/m);
});
