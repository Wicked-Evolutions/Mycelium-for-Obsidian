import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const activeChildren = new Set();
const activeShutdowns = new Set();
const requiredPackagePaths = new Set([
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'dist/index.js',
  'dist/tools/index.js',
  'dist/version.js',
  'package.json',
]);
const allowedTopLevelFiles = new Set([
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
]);
const allowedDistDirectories = new Set([
  'cli',
  'embeddings',
  'eval',
  'graph',
  'parsers',
  'prompts',
  'tools',
  'types',
]);
const forbiddenRoots = new Set([
  '.codex',
  '.github',
  '.understand-anything',
  'coverage',
  'node_modules',
  'scripts',
  'src',
  'test',
]);
const stageEntries = [
  '.env.example',
  '.npmignore',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package-lock.json',
  'package.json',
  'src',
  'tsconfig.json',
];
const safeEnvironmentKeys = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'CI',
  'CC',
  'CXX',
  'MAKE',
  'PYTHON',
  'SDKROOT',
  'MACOSX_DEPLOYMENT_TARGET',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NPM_CONFIG_REGISTRY',
  'npm_config_registry',
  'npm_config_arch',
  'npm_config_target_arch',
];

function withTimeout(promise, milliseconds, label) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

function trackChild(child) {
  if (!child) return;
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
}

function runCommand(command, args, options, label) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      activeChildren.delete(child);
      if (error) {
        reject(new Error(`${label} failed with exit code ${error.code ?? 'unknown'}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    trackChild(child);
  });
}

async function waitForChildExit(child, milliseconds, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(once(child, 'exit'), milliseconds, label);
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, 2_000, 'child termination');
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildExit(child, 2_000, 'forced child termination');
  }
}

async function shutdownActiveWork() {
  await Promise.all([...activeShutdowns].map(shutdown => shutdown()));
  await Promise.all([...activeChildren].map(child => terminateChild(child)));
}

async function shutdownAndCleanup(cleanup) {
  const errors = [];
  try {
    await shutdownActiveWork();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'child shutdown and temporary cleanup both failed');
}

function parsePackResult(stdout) {
  const trimmed = stdout.trim();
  for (let index = trimmed.lastIndexOf('['); index >= 0; index = trimmed.lastIndexOf('[', index - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(index));
      if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
    } catch {
      // npm lifecycle output can precede the JSON payload.
    }
  }
  throw new Error('npm pack did not return one JSON package record');
}

function validatePackagePath(packagePath) {
  assert.equal(packagePath.includes('\\'), false, `package path uses a backslash: ${packagePath}`);
  assert.equal(path.posix.isAbsolute(packagePath), false, `package path is absolute: ${packagePath}`);
  assert.equal(path.posix.normalize(packagePath), packagePath, `package path is not normalized: ${packagePath}`);
  assert.equal(packagePath.startsWith('../'), false, `package path traverses upward: ${packagePath}`);

  const [root] = packagePath.split('/');
  assert.equal(forbiddenRoots.has(root), false, `forbidden package root: ${root}`);
  assert.notEqual(packagePath, 'manifest.json', 'manifest.json belongs to the deferred MCPB channel');
  assert.equal(packagePath.endsWith('.db'), false, `database file is not publishable: ${packagePath}`);
  assert.equal(packagePath.endsWith('.sqlite'), false, `database file is not publishable: ${packagePath}`);
  assert.equal(packagePath === '.env' || (packagePath.startsWith('.env.') && packagePath !== '.env.example'), false,
    `non-example environment file is not publishable: ${packagePath}`);
  assert.equal(packagePath === 'package-lock.json' || packagePath === 'npm-shrinkwrap.json', false,
    `lock file is not publishable: ${packagePath}`);

  if (allowedTopLevelFiles.has(packagePath)) return;
  assert.equal(packagePath.startsWith('dist/'), true, `unexpected package path: ${packagePath}`);
  const distSegments = packagePath.slice('dist/'.length).split('/');
  if (distSegments.length > 1) {
    assert.equal(allowedDistDirectories.has(distSegments[0]), true,
      `unexpected dist directory: ${distSegments[0]}`);
  }
  assert.equal(distSegments.some(segment => segment.startsWith('.')), false,
    `hidden dist path is not publishable: ${packagePath}`);
  assert.match(packagePath, /(?:\.js|\.js\.map|\.d\.ts)$/, `unexpected dist artifact type: ${packagePath}`);
}

async function assertInside(childPath, parentPath, label) {
  const [child, parent] = await Promise.all([realpath(childPath), realpath(parentPath)]);
  assert.equal(child === parent || child.startsWith(`${parent}${path.sep}`), true,
    `${label} resolved outside its allowed root`);
  return child;
}

function baseSubprocessEnvironment(tempRoot) {
  const environment = {};
  for (const key of safeEnvironmentKeys) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    TMPDIR: tempRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  };
}

function npmEnvironment(tempRoot, cachePath) {
  return {
    ...baseSubprocessEnvironment(tempRoot),
    npm_config_audit: 'false',
    npm_config_cache: cachePath,
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function isolatedServerEnvironment(installRoot, vaultPath) {
  return {
    ...baseSubprocessEnvironment(installRoot),
    OBSIDIAN_VAULTS: JSON.stringify({ PackageSmokeVault: vaultPath }),
    OBSIDIAN_AUTO_INDEX: 'false',
    OBSIDIAN_DISABLED_TOOLS: '',
    OBSIDIAN_HTTP_SERVER: 'false',
    HTTP_MODE: 'false',
    OBSIDIAN_READ_ONLY: 'true',
    OBSIDIAN_WRAP_UNTRUSTED: 'false',
  };
}

async function stagePackageSource(stageRoot) {
  await mkdir(stageRoot);
  for (const entry of stageEntries) {
    await cp(path.join(repoRoot, entry), path.join(stageRoot, entry), { recursive: true });
  }
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(stageRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

async function verifyNativeBindings(installRoot) {
  const nativeProbe = String.raw`
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const requireFromInstall = createRequire(path.join(process.cwd(), 'package.json'));
    const Database = requireFromInstall('better-sqlite3');
    requireFromInstall('koffi');
    const database = new Database(':memory:');
    const result = database.prepare('select 1 as ok').get();
    database.close();
    const betterSqlite3 = Object.keys(require.cache).find(
      file => file.endsWith('.node') && file.includes('better-sqlite3')
    );
    const koffi = Object.keys(require.cache).find(
      file => file.endsWith('.node') && file.toLowerCase().includes('koffi')
    );
    if (!betterSqlite3) throw new Error('loaded better-sqlite3 native binding was not found in require.cache');
    if (!koffi) throw new Error('loaded Koffi native binding was not found in require.cache');
    process.stdout.write(JSON.stringify({ ok: result.ok, betterSqlite3, koffi }));
  `;
  const { stdout } = await runCommand(process.execPath, ['-e', nativeProbe], {
    cwd: installRoot,
    env: baseSubprocessEnvironment(installRoot),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }, 'native binding probe');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, 1);
  const nodeModules = path.join(installRoot, 'node_modules');
  return {
    betterSqlite3: await assertInside(
      result.betterSqlite3,
      nodeModules,
      'better-sqlite3 native binding'
    ),
    koffi: await assertInside(result.koffi, nodeModules, 'Koffi native binding'),
  };
}

async function verifySecureFilesystemAdapter(packageRoot, tempRoot) {
  const moduleUrl = `${pathToFileURL(
    path.join(packageRoot, 'dist', 'embeddings', 'secure-fs.js')
  ).href}?package-check=${Date.now()}`;
  const secureFilesystem = await import(moduleUrl);
  const root = path.join(tempRoot, 'secure-fs-smoke');
  const owned = path.join(root, 'owned');
  const moved = path.join(root, 'owned-moved');
  const external = path.join(root, 'external');
  await mkdir(owned, { recursive: true, mode: 0o700 });
  await mkdir(external, { mode: 0o700 });
  await writeFile(path.join(owned, 'embeddings.db'), 'owned generation', { mode: 0o600 });
  await writeFile(path.join(external, 'embeddings.db'), 'external generation', { mode: 0o600 });
  const ownedStat = fs.lstatSync(owned, { bigint: true });

  if (!secureFilesystem.secureMutationSupported()) {
    assert.throws(
      () => secureFilesystem.openPinnedDirectory(owned, {
        device: String(ownedStat.dev),
        inode: String(ownedStat.ino),
      }),
      error => error?.name === 'SecureFilesystemUnavailableError'
    );
    return {
      state: 'unavailable',
      reason: 'descriptor_relative_backend_unavailable',
    };
  }

  const externalBefore = fs.readFileSync(path.join(external, 'embeddings.db'));
  const directoryDescriptor = secureFilesystem.openPinnedDirectory(owned, {
    device: String(ownedStat.dev),
    inode: String(ownedStat.ino),
  });
  try {
    fs.renameSync(owned, moved);
    fs.symlinkSync(external, owned, 'dir');
    const temporaryDescriptor = secureFilesystem.openFileAt(
      directoryDescriptor,
      'temporary.tmp',
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    try {
      fs.writeFileSync(temporaryDescriptor, 'installed adapter generation');
      fs.fsyncSync(temporaryDescriptor);
      assert.equal(fs.fstatSync(temporaryDescriptor).mode & 0o777, 0o600);
    } finally {
      fs.closeSync(temporaryDescriptor);
    }
    secureFilesystem.renameAt(directoryDescriptor, 'temporary.tmp', 'embeddings.db');
    const cleanupDescriptor = secureFilesystem.openFileAt(
      directoryDescriptor,
      'cleanup.tmp',
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    fs.closeSync(cleanupDescriptor);
    secureFilesystem.unlinkAt(directoryDescriptor, 'cleanup.tmp');
    secureFilesystem.fsyncDirectory(directoryDescriptor);
    assert.equal(
      fs.readFileSync(path.join(moved, 'embeddings.db'), 'utf8'),
      'installed adapter generation'
    );
    assert.deepEqual(fs.readFileSync(path.join(external, 'embeddings.db')), externalBefore);
  } finally {
    fs.closeSync(directoryDescriptor);
    if (fs.lstatSync(owned).isSymbolicLink()) fs.unlinkSync(owned);
    if (fs.existsSync(moved)) fs.renameSync(moved, owned);
  }

  return {
    state: 'executed',
    parentSwapContained: true,
    externalTargetPreserved: true,
  };
}

async function verifyInstalledServer({ installRoot, packageRoot, packageJson, vaultPath, expectedToolNames }) {
  const binPath = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.['mcp-obsidian'];
  assert.equal(typeof binPath, 'string', 'installed package does not expose the mcp-obsidian bin');
  const serverEntry = await assertInside(path.resolve(packageRoot, binPath), packageRoot, 'server entry');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: installRoot,
    env: isolatedServerEnvironment(installRoot, vaultPath),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'npm-package-verifier', version: '1.0.0' });
  let connected = false;
  let stderrBytes = 0;
  let stderrAttached = false;
  const attachStderrDrain = () => {
    if (stderrAttached || !transport.stderr) return;
    stderrAttached = true;
    transport.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); });
  };
  attachStderrDrain();
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      const child = transport._process;
      let closeError;
      if (connected) {
        try {
          await withTimeout(client.close(), 5_000, 'installed MCP disconnect');
        } catch (error) {
          closeError = error;
        }
      }
      await terminateChild(child);
      if (closeError) throw closeError;
    })();
    return shutdownPromise;
  };
  activeShutdowns.add(shutdown);

  try {
    const connection = client.connect(transport);
    trackChild(transport._process);
    await withTimeout(connection, 15_000, 'installed MCP connection');
    connected = true;
    attachStderrDrain();

    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, 'mcp-obsidian');
    assert.equal(serverVersion?.version, packageJson.version);

    const listedTools = await withTimeout(client.listTools(), 15_000, 'installed tool listing');
    const installedToolNames = listedTools.tools.map(tool => tool.name);
    assert.deepEqual(installedToolNames, expectedToolNames, 'installed tool surface differs from the staged build');

    const listedFiles = await withTimeout(client.callTool({
      name: 'list_files',
      arguments: { vault: 'PackageSmokeVault' },
    }), 15_000, 'installed list_files smoke');
    assert.notEqual(listedFiles.isError, true);
    const textBlocks = listedFiles.content.filter(item => item.type === 'text');
    assert.equal(textBlocks.length, 1, 'list_files did not return one JSON text block');
    const entries = JSON.parse(textBlocks[0].text);
    assert.equal(Array.isArray(entries), true, 'list_files response is not an array');
    assert.equal(entries.some(entry => (
      entry?.name === 'PackageSmoke.md'
      && entry?.path === 'PackageSmoke.md'
      && entry?.isDirectory === false
    )), true, 'installed server did not return the synthetic marker file');
    assert.equal(stderrBytes <= 1024 * 1024, true, 'installed server emitted more than 1 MiB on stderr');

    return {
      name: serverVersion.name,
      version: serverVersion.version,
      toolCount: installedToolNames.length,
      markerFileRead: true,
    };
  } finally {
    try {
      await shutdown();
    } finally {
      activeShutdowns.delete(shutdown);
    }
  }
}

async function verifyPackage(tempRoot) {
  const stageRoot = path.join(tempRoot, 'stage');
  const packRoot = path.join(tempRoot, 'pack');
  const installRoot = path.join(tempRoot, 'install');
  const vaultPath = path.join(tempRoot, 'vault');
  const cachePath = path.join(tempRoot, 'npm-cache');
  await Promise.all([
    stagePackageSource(stageRoot),
    mkdir(packRoot),
    mkdir(installRoot),
    mkdir(vaultPath),
    mkdir(cachePath),
  ]);
  await writeFile(path.join(vaultPath, 'PackageSmoke.md'), '# Package smoke\n', 'utf8');

  const environment = npmEnvironment(tempRoot, cachePath);
  const { stdout: npmVersion } = await runCommand(npmCommand, ['--version'], {
    cwd: stageRoot,
    env: environment,
    timeout: 15_000,
  }, 'npm version probe');
  const { stdout: packOutput } = await runCommand(
    npmCommand,
    ['pack', '--json', '--silent', '--pack-destination', packRoot],
    {
      cwd: stageRoot,
      env: environment,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
    'npm pack',
  );
  const packResult = parsePackResult(packOutput);
  const expectedPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packResult.name, expectedPackage.name);
  assert.equal(packResult.version, expectedPackage.version);
  assert.equal(typeof packResult.integrity, 'string');
  assert.equal(packResult.integrity.startsWith('sha512-'), true);
  assert.equal(Array.isArray(packResult.files), true);
  assert.equal(packResult.files.length > 0, true);

  const packagePaths = new Set(packResult.files.map(file => file.path));
  for (const packagePath of packagePaths) validatePackagePath(packagePath);
  for (const requiredPath of requiredPackagePaths) {
    assert.equal(packagePaths.has(requiredPath), true, `required package path is missing: ${requiredPath}`);
  }

  const tarballPath = await assertInside(path.join(packRoot, packResult.filename), packRoot, 'tarball');
  const actualIntegrity = `sha512-${createHash('sha512').update(await readFile(tarballPath)).digest('base64')}`;
  assert.equal(actualIntegrity, packResult.integrity, 'tarball integrity differs from the npm pack receipt');

  await writeFile(path.join(installRoot, 'package.json'), '{"private":true}', 'utf8');
  await runCommand(npmCommand, [
    'install',
    '--omit=dev',
    '--audit=false',
    '--fund=false',
    '--ignore-scripts=false',
    '--no-package-lock',
    tarballPath,
  ], {
    cwd: installRoot,
    env: environment,
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
  }, 'clean tarball install');

  const packageRoot = path.join(installRoot, 'node_modules', '@wickedevolutions', 'mcp-obsidian');
  const installedPackagePath = path.join(packageRoot, 'package.json');
  await assertInside(installedPackagePath, installRoot, 'installed package metadata');
  const installedPackage = JSON.parse(await readFile(installedPackagePath, 'utf8'));
  assert.equal(installedPackage.name, packResult.name);
  assert.equal(installedPackage.version, packResult.version);

  const nativeBindings = await verifyNativeBindings(installRoot);
  const secureFilesystem = await verifySecureFilesystemAdapter(packageRoot, tempRoot);
  const toolsModuleUrl = `${pathToFileURL(path.join(stageRoot, 'dist', 'tools', 'index.js')).href}?package-check=${Date.now()}`;
  const { allTools } = await import(toolsModuleUrl);
  const expectedToolNames = allTools.map(tool => tool.name);
  const server = await verifyInstalledServer({
    installRoot,
    packageRoot,
    packageJson: installedPackage,
    vaultPath,
    expectedToolNames,
  });

  return {
    node: process.version,
    npm: npmVersion.trim(),
    platform: process.platform,
    architecture: process.arch,
    package: {
      name: packResult.name,
      version: packResult.version,
      filename: packResult.filename,
      integrity: packResult.integrity,
      entryCount: packagePaths.size,
    },
    nativeBindings: Object.fromEntries(Object.entries(nativeBindings).map(([name, binding]) => [
      name,
      path.relative(installRoot, binding).split(path.sep).join('/'),
    ])),
    secureFilesystem,
    server,
  };
}

async function main() {
  const systemTempRoot = await realpath(os.tmpdir());
  const tempRoot = await mkdtemp(path.join(systemTempRoot, 'mycelium-npm-package-'));
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return cleanupPromise;
  };
  let signalTask;
  const handleSignal = signal => {
    signalTask ??= (async () => {
      await shutdownAndCleanup(cleanup);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })().catch(error => {
      console.error(`npm package verification cleanup failed after ${signal}: ${error.message}`);
      process.exit(1);
    });
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let receipt;
  let verificationError;
  let cleanupError;
  try {
    assert.equal(path.dirname(tempRoot), systemTempRoot, 'temporary root has an unexpected parent');
    assert.match(path.basename(tempRoot), /^mycelium-npm-package-/, 'temporary root has an unexpected name');
    await assertInside(tempRoot, systemTempRoot, 'temporary root');
    receipt = await verifyPackage(tempRoot);
  } catch (error) {
    verificationError = error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try {
      await shutdownAndCleanup(cleanup);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (verificationError && cleanupError) {
    throw new AggregateError([verificationError, cleanupError], 'verification and temporary cleanup both failed');
  }
  if (verificationError) throw verificationError;
  if (cleanupError) throw cleanupError;

  console.log(JSON.stringify({ status: 'pass', ...receipt }, null, 2));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`npm package verification failed: ${message.replaceAll(os.tmpdir(), '<temp>')}`);
  process.exitCode = 1;
});
