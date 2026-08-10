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

  assert.equal(packageJson.version, '1.5.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(packageJson.engines.node, '>=20.0.0');
});

test('MCPB metadata remains on v1.4.0 by founder-directed exception', async () => {
  const manifest = await readJson('manifest.json');
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');

  assert.equal(manifest.version, '1.4.0');
  assert.match(readme, /MCPB channel remains on v1\.4\.0/);
  assert.match(readme, /releases\/download\/v1\.4\.0\/mcp-obsidian\.mcpb/);
  assert.doesNotMatch(readme, /releases\/latest\/download\/mcp-obsidian\.mcpb/);
});
