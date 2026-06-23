/**
 * Obsidian CLI Bridge
 * Executes Obsidian CLI commands from the MCP server.
 * Requires Obsidian 1.12+ with CLI enabled and the app running.
 */

import { execFile } from 'child_process';
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

/**
 * Execute an Obsidian CLI command and return the output.
 */
export function execCli(args: string[], timeoutMs: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('obsidian', args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: OBSIDIAN_CLI_MAX_BUFFER,
      env: { ...process.env, PATH: `${process.env.PATH}:/Applications/Obsidian.app/Contents/MacOS` }
    }, (error, stdout, stderr) => {
      if (error) {
        // Check if Obsidian is not running
        if (stderr?.includes('ECONNREFUSED') || stderr?.includes('not running')) {
          reject(new Error('Obsidian app is not running. Start Obsidian to use CLI-based tools.'));
          return;
        }
        reject(new Error(`CLI error: ${error.message}\n${stderr || ''}`));
        return;
      }
      // Filter out installer warning and loading messages
      const lines = stdout.split('\n').filter(line =>
        !line.includes('installer is out of date') &&
        !line.includes('Loading updated app package') &&
        !line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Loading/)
      );
      const result = lines.join('\n').trim();

      // Obsidian CLI exits 0 even on errors — check for Error: prefix in output
      if (result.startsWith('Error:')) {
        reject(new Error(result));
        return;
      }

      resolve(result);
    });
  });
}

/**
 * Execute a CLI command targeting a specific vault.
 */
export function execCliForVault(
  config: Config,
  mcpVaultName: string | undefined,
  command: string,
  args: string[] = [],
  timeoutMs: number = 10000
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
  return execCli(fullArgs, timeoutMs);
}

/**
 * Execute a JS expression via `obsidian eval` and return the result.
 */
export async function evalInObsidian(
  config: Config,
  mcpVaultName: string | undefined,
  code: string,
  timeoutMs: number = 10000
): Promise<string> {
  const result = await execCliForVault(config, mcpVaultName, 'eval', [`code=${code}`], timeoutMs);
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
  try {
    await execCli(['version'], 5000);
    return true;
  } catch {
    return false;
  }
}
