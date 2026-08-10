import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { Config, resolveVault } from '../config.js';
import {
  evalInRegisteredVault
} from './bridge.js';

const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
const VAULT_ID_PATTERN = /^[a-f0-9]{16}$/i;

export const OPEN_VAULT_TIMEOUT_MS = 30_000;
export const OPEN_VAULT_POLL_MS = 250;

export type RegisteredVaultStatus =
  | 'open'
  | 'closed'
  | 'unregistered'
  | 'ambiguous'
  | 'unsupported_platform'
  | 'probe_failed';

export interface RegisteredVaultTarget {
  status: RegisteredVaultStatus;
  probeInvoked: boolean;
  canonicalPath?: string;
  vaultId?: string;
  reason?:
    | 'registry_unavailable'
    | 'registry_invalid'
    | 'invalid_registration'
    | 'configured_path_unavailable';
}

export interface RegistryLocationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  registryPath?: string;
}

interface RegistryVaultEntry {
  path?: unknown;
  open?: unknown;
}

interface ObsidianRegistry {
  vaults?: Record<string, RegistryVaultEntry>;
}

export interface OpenVaultCommand {
  executable: string;
  args: string[];
  uri: string;
}

export type OpenCommandRunner = (
  executable: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; onSpawn?: () => void }
) => Promise<void>;

export type ExactTargetProbeStatus =
  | 'ready'
  | 'loading'
  | 'cli_unavailable'
  | 'identity_mismatch'
  | 'probe_failed';

export interface ExactTargetProbe {
  status: ExactTargetProbeStatus;
}

function comparablePath(value: string, platform = process.platform): string {
  const normalized = path.resolve(value).normalize('NFC');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function canonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

export function isValidObsidianVaultId(value: string): boolean {
  return VAULT_ID_PATTERN.test(value);
}

export function obsidianRegistryPath(
  options: RegistryLocationOptions = {}
): string | undefined {
  if (options.registryPath) return options.registryPath;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(configHome, 'obsidian', 'obsidian.json');
  }
  return undefined;
}

export async function canonicalizeVaultPath(vaultPath: string): Promise<string> {
  return fs.realpath(vaultPath);
}

/** Resolve one configured vault path to exactly one registered Obsidian ID. */
export async function inspectRegisteredVault(
  config: Config,
  vaultName: string,
  options: RegistryLocationOptions = {}
): Promise<RegisteredVaultTarget> {
  const platform = options.platform ?? process.platform;
  const registryPath = obsidianRegistryPath(options);
  if (!registryPath) {
    return { status: 'unsupported_platform', probeInvoked: false };
  }

  const vault = resolveVault(config, vaultName);
  let canonicalConfigured: string;
  try {
    canonicalConfigured = await canonicalizeVaultPath(vault.path);
  } catch {
    return {
      status: 'probe_failed',
      probeInvoked: true,
      reason: 'configured_path_unavailable'
    };
  }

  let rawRegistry: string;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(registryPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > REGISTRY_MAX_BYTES) {
      return {
        status: 'probe_failed',
        probeInvoked: true,
        reason: 'registry_invalid'
      };
    }
    const buffer = Buffer.alloc(REGISTRY_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > REGISTRY_MAX_BYTES) {
      return {
        status: 'probe_failed',
        probeInvoked: true,
        reason: 'registry_invalid'
      };
    }
    rawRegistry = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return {
      status: 'probe_failed',
      probeInvoked: true,
      reason: 'registry_unavailable'
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let registry: ObsidianRegistry;
  try {
    const parsed = JSON.parse(rawRegistry) as ObsidianRegistry;
    if (!parsed || typeof parsed !== 'object' || !parsed.vaults || typeof parsed.vaults !== 'object') {
      return {
        status: 'probe_failed',
        probeInvoked: true,
        reason: 'registry_invalid'
      };
    }
    registry = parsed;
  } catch {
    return {
      status: 'probe_failed',
      probeInvoked: true,
      reason: 'registry_invalid'
    };
  }

  const configuredComparable = comparablePath(canonicalConfigured, platform);
  const matches: Array<{ id: string; open: boolean }> = [];
  let invalidMatchingRegistration = false;

  for (const [id, entry] of Object.entries(registry.vaults ?? {})) {
    if (!entry || typeof entry.path !== 'string') continue;
    let canonicalRegistered: string;
    try {
      canonicalRegistered = await canonicalizeVaultPath(entry.path);
    } catch {
      continue;
    }
    if (comparablePath(canonicalRegistered, platform) !== configuredComparable) continue;
    if (!isValidObsidianVaultId(id)) {
      invalidMatchingRegistration = true;
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, 'open') &&
      typeof entry.open !== 'boolean'
    ) {
      invalidMatchingRegistration = true;
      continue;
    }
    matches.push({ id, open: entry.open === true });
  }

  if (invalidMatchingRegistration) {
    return {
      status: 'probe_failed',
      probeInvoked: true,
      canonicalPath: canonicalConfigured,
      reason: 'invalid_registration'
    };
  }
  if (matches.length === 0) {
    return {
      status: 'unregistered',
      probeInvoked: true,
      canonicalPath: canonicalConfigured
    };
  }
  if (matches.length !== 1) {
    return {
      status: 'ambiguous',
      probeInvoked: true,
      canonicalPath: canonicalConfigured
    };
  }

  return {
    status: matches[0].open ? 'open' : 'closed',
    probeInvoked: true,
    canonicalPath: canonicalConfigured,
    vaultId: matches[0].id
  };
}

export function buildOpenVaultCommand(
  vaultId: string,
  platform: NodeJS.Platform = process.platform
): OpenVaultCommand {
  if (!isValidObsidianVaultId(vaultId)) {
    throw new Error('Invalid registered Obsidian vault ID.');
  }

  const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
  if (platform === 'darwin') {
    return { executable: 'open', args: [uri], uri };
  }
  if (platform === 'linux') {
    return { executable: 'xdg-open', args: [uri], uri };
  }
  if (platform === 'win32') {
    return {
      executable: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', uri],
      uri
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

const defaultOpenCommandRunner: OpenCommandRunner = (
  executable,
  args,
  options
) => new Promise((resolve, reject) => {
  const child = execFile(
    executable,
    args,
    {
      timeout: options.timeoutMs,
      windowsHide: true,
      signal: options.signal
    },
    (error) => error ? reject(error) : resolve()
  );
  child.once('spawn', () => options.onSpawn?.());
});

/** Dispatch one allowlisted Obsidian URI without a shell. */
export async function dispatchOpenVault(
  vaultId: string,
  options: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    timeoutMs?: number;
    runner?: OpenCommandRunner;
    onDispatch?: () => void;
  } = {}
): Promise<void> {
  throwIfAborted(options.signal);
  const command = buildOpenVaultCommand(vaultId, options.platform);
  await (options.runner ?? defaultOpenCommandRunner)(
    command.executable,
    command.args,
    {
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
      onSpawn: options.onDispatch
    }
  );
}

/** Constant-size exact-ID readiness check used only inside explicit open_vault. */
export async function probeExactRegisteredVault(
  vaultId: string,
  expectedCanonicalPath: string,
  signal?: AbortSignal
): Promise<ExactTargetProbe> {
  throwIfAborted(signal);
  const code = [
    '(() => {',
    '  const adapter = app?.vault?.adapter;',
    "  const basePath = typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : adapter?.basePath;",
    '  const metadataReady = typeof app?.metadataCache?.initialized === \'boolean\'',
    '    ? app.metadataCache.initialized',
    '    : app?.workspace?.layoutReady === true;',
    '  return JSON.stringify({ basePath, ready: !!app?.vault && !!app?.metadataCache && metadataReady });',
    '})()'
  ].join('\n');

  try {
    const raw = await evalInRegisteredVault(vaultId, code, 5_000, signal);
    const parsed = parseEvalObject(raw);
    if (typeof parsed.basePath !== 'string') return { status: 'loading' };
    const observedCanonical = await canonicalizeVaultPath(parsed.basePath);
    if (comparablePath(observedCanonical) !== comparablePath(expectedCanonicalPath)) {
      return { status: 'identity_mismatch' };
    }
    return { status: parsed.ready === true ? 'ready' : 'loading' };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isCliErrorKind(error, 'cli_unavailable')) {
      return { status: 'cli_unavailable' };
    }
    if (isCliErrorKind(error, 'obsidian_unavailable')) {
      return { status: 'loading' };
    }
    return { status: 'probe_failed' };
  }
}

function isCliErrorKind(error: unknown, kind: string): boolean {
  return error instanceof Error &&
    'kind' in error &&
    (error as Error & { kind?: unknown }).kind === kind;
}

function parseEvalObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const first = JSON.parse(trimmed) as unknown;
  if (typeof first === 'string') {
    const nested = JSON.parse(first) as unknown;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }
  if (first && typeof first === 'object') return first as Record<string, unknown>;
  throw new Error('Unexpected Obsidian eval response.');
}

export function createAbortError(): Error {
  const error = new Error('The operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

/** Yield to the event loop so a transport abort can be delivered, then check it. */
export async function abortableYield(signal?: AbortSignal): Promise<void> {
  if (!signal) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
