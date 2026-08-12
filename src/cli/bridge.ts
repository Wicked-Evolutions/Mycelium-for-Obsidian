/**
 * Obsidian CLI Bridge
 * Executes Obsidian CLI commands from the MCP server.
 * Requires Obsidian 1.12+ with installer 1.12.7+, CLI enabled, and the app running.
 */

import { execFile, type ChildProcess } from 'child_process';
import { accessSync, constants, realpathSync } from 'fs';
import * as path from 'path';
import { Config } from '../config.js';

/**
 * Maximum stdout buffer for an Obsidian CLI invocation.
 *
 * Node's `execFile` default `maxBuffer` is exactly 1 MB. The Obsidian graph
 * eval (`app.metadataCache.resolvedLinks` serialized to JSON) is ~1.17 MB for a
 * real ~1,700-note vault — which overruns the 1 MB ceiling, makes `execFile`
 * fail with ENOBUFS, and causes the graph layer to silently degrade from the
 * Obsidian provider to the filesystem approximation (issue #32). A generous
 * 256 MB ceiling keeps exact-graph parity on large vaults while still bounding
 * a runaway payload. Exported so tests can assert both the value and that
 * `execCli` actually passes it.
 */
export const OBSIDIAN_CLI_MAX_BUFFER = 256 * 1024 * 1024;
export const OBSIDIAN_CLI_KILL_GRACE_MS = 250;

export interface CliProcessOutcome {
  error: Error | null;
  stdout: string;
  stderr: string;
}

export type ObsidianCliProbeStatus =
  | 'available'
  | 'cli_unavailable'
  | 'obsidian_unavailable'
  | 'unknown';

export interface ObsidianCliProbe {
  status: ObsidianCliProbeStatus;
}

export class ObsidianCliError extends Error {
  constructor(
    public readonly kind: Exclude<ObsidianCliProbeStatus, 'available'>,
    message: string
  ) {
    super(message);
    this.name = 'ObsidianCliError';
  }
}

function isAppUnavailableText(value: string): boolean {
  return /ECONNREFUSED|not running|CLI is unable to find Obsidian|make sure Obsidian is running/i.test(value);
}

const MACOS_BUNDLED_CLI = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';

function findRegisteredMacCli(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, 'obsidian');
    try {
      accessSync(candidate, constants.X_OK);
      if (path.basename(realpathSync(candidate)).toLowerCase() === 'obsidian-cli') {
        return candidate;
      }
    } catch {
      // Continue through PATH. Missing entries and broken links are expected.
    }
  }
  return undefined;
}

/** Ordered executable candidates that never resolve the macOS GUI binary. */
export function obsidianCliCandidatesForPlatform(platform = process.platform): string[] {
  if (platform !== 'darwin') return ['obsidian'];
  const registered = findRegisteredMacCli();
  return [
    MACOS_BUNDLED_CLI,
    'obsidian-cli',
    ...(registered ? [registered] : [])
  ];
}

// Map our MCP vault paths to Obsidian CLI vault names
// CLI uses the folder name as vault name, we use short aliases
let cliVaultNameCache: Map<string, string> | null = null;

/**
 * Get the CLI vault name for a given vault path.
 * The CLI identifies vaults by their folder name (last path component).
 */
function getCliVaultName(vaultPath: string): string {
  // The CLI uses the vault's registered name, which we can discover
  // from `obsidian vaults verbose`. But since that requires a call,
  // we use a simpler approach: match by path via the vault name
  // registered in Obsidian (which is the folder name).
  const parts = vaultPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1];
}

/**
 * Build CLI vault name cache from config
 */
function buildVaultNameMap(config: Config): Map<string, string> {
  if (cliVaultNameCache) return cliVaultNameCache;
  cliVaultNameCache = new Map();
  for (const vault of config.vaults) {
    cliVaultNameCache.set(vault.name, getCliVaultName(vault.path));
  }
  return cliVaultNameCache;
}

/** Execute one CLI process while bounding children that ignore graceful termination. */
export function executeCliProcess(
  executable: string,
  args: string[],
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<CliProcessOutcome> {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: OBSIDIAN_CLI_MAX_BUFFER,
      env: process.env,
      signal
    } as const;
    let child: ChildProcess | undefined;
    let childExited = false;
    let timeoutEscalation: NodeJS.Timeout | undefined;
    let abortEscalation: NodeJS.Timeout | undefined;
    const forceKill = (): void => {
      if (
        child &&
        !childExited &&
        typeof child.kill === 'function'
      ) {
        child.kill('SIGKILL');
      }
    };
    const scheduleAbortEscalation = (): void => {
      if (!abortEscalation) {
        abortEscalation = setTimeout(forceKill, OBSIDIAN_CLI_KILL_GRACE_MS);
      }
    };
    const processExited = (): void => {
      childExited = true;
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      if (abortEscalation) clearTimeout(abortEscalation);
      signal?.removeEventListener('abort', scheduleAbortEscalation);
    };

    signal?.addEventListener('abort', scheduleAbortEscalation, { once: true });
    try {
      child = execFile(executable, args, options, (error, stdout, stderr) => {
        signal?.removeEventListener('abort', scheduleAbortEscalation);
        resolve({
          error,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
    } catch (error) {
      signal?.removeEventListener('abort', scheduleAbortEscalation);
      if (abortEscalation) clearTimeout(abortEscalation);
      reject(error);
      return;
    }

    child.once('exit', processExited);
    child.once('close', processExited);
    if (timeoutMs > 0) {
      timeoutEscalation = setTimeout(
        forceKill,
        timeoutMs + OBSIDIAN_CLI_KILL_GRACE_MS
      );
    }
    if (signal?.aborted) scheduleAbortEscalation();
  });
}

/**
 * Execute an Obsidian CLI command and return the output.
 */
export async function execCli(
  args: string[],
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<string> {
  const candidates = obsidianCliCandidatesForPlatform();
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const { error, stdout, stderr } = await executeCliProcess(
      candidates[candidateIndex],
      args,
      timeoutMs,
      signal
    );
    if (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (signal?.aborted || code === 'ABORT_ERR') throw error;
      if (code === 'ENOENT' && candidateIndex + 1 < candidates.length) continue;
      if (code === 'ENOENT') {
        throw new ObsidianCliError(
          'cli_unavailable',
          'Obsidian CLI is not installed or registered.'
        );
      }
      if (isAppUnavailableText(`${error.message}\n${stdout}\n${stderr}`)) {
        throw new ObsidianCliError(
          'obsidian_unavailable',
          'Obsidian app is not running. Start Obsidian to use CLI-based tools.'
        );
      }
      throw new ObsidianCliError('unknown', `CLI error: ${error.message}\n${stderr}`);
    }
    if (isAppUnavailableText(stderr)) {
      throw new ObsidianCliError(
        'obsidian_unavailable',
        'Obsidian app is not running. Start Obsidian to use CLI-based tools.'
      );
    }

    const lines = stdout.split('\n').filter(line =>
      !line.includes('installer is out of date') &&
      !line.includes('Loading updated app package') &&
      !line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Loading/)
    );
    const result = lines.join('\n').trim();
    if (result.startsWith('Error:')) {
      throw new ObsidianCliError(
        isAppUnavailableText(result) ? 'obsidian_unavailable' : 'unknown',
        result
      );
    }
    return result;
  }
  throw new ObsidianCliError('cli_unavailable', 'Obsidian CLI is not installed or registered.');
}

/**
 * Execute a CLI command targeting a specific vault.
 */
export function execCliForVault(
  config: Config,
  mcpVaultName: string | undefined,
  command: string,
  args: string[] = [],
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<string> {
  const nameMap = buildVaultNameMap(config);

  // Resolve MCP vault name to CLI vault name
  let cliVaultName: string;
  if (mcpVaultName) {
    const mapped = nameMap.get(mcpVaultName);
    if (!mapped) {
      // Try direct match (user might pass CLI name directly)
      cliVaultName = mcpVaultName;
    } else {
      cliVaultName = mapped;
    }
  } else {
    // Default to first vault
    cliVaultName = nameMap.values().next().value!;
  }

  const fullArgs = [`vault=${cliVaultName}`, command, ...args];
  return execCli(fullArgs, timeoutMs, signal);
}

/** Execute a command against one previously verified registered vault ID. */
export function execCliForRegisteredVault(
  vaultId: string,
  command: string,
  args: string[] = [],
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<string> {
  if (!/^[a-f0-9]{16}$/i.test(vaultId)) {
    return Promise.reject(new Error('Invalid registered Obsidian vault ID.'));
  }
  return execCli([`vault=${vaultId}`, command, ...args], timeoutMs, signal);
}

/**
 * Execute a JS expression via `obsidian eval` and return the result.
 */
export async function evalInObsidian(
  config: Config,
  mcpVaultName: string | undefined,
  code: string,
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<string> {
  const result = await execCliForVault(
    config,
    mcpVaultName,
    'eval',
    [`code=${code}`],
    timeoutMs,
    signal
  );
  // eval output starts with "=> " prefix
  if (result.startsWith('=> ')) {
    return result.slice(3);
  }
  return result;
}

/** Execute eval against one verified registered vault ID. */
export async function evalInRegisteredVault(
  vaultId: string,
  code: string,
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<string> {
  const result = await execCliForRegisteredVault(
    vaultId,
    'eval',
    [`code=${code}`],
    timeoutMs,
    signal
  );
  // eval output starts with "=> " prefix
  if (result.startsWith('=> ')) {
    return result.slice(3);
  }
  return result;
}

/**
 * Check if the Obsidian CLI is available and the app is running.
 */
export async function isCliAvailable(): Promise<boolean> {
  return (await probeObsidianCli()).status === 'available';
}

/** Probe CLI registration and app reachability without exposing raw errors. */
export async function probeObsidianCli(): Promise<ObsidianCliProbe> {
  try {
    await execCli(['version'], 5000);
    return { status: 'available' };
  } catch (err) {
    if (err instanceof ObsidianCliError) {
      return { status: err.kind };
    }
    return { status: 'unknown' };
  }
}
