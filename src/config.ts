/**
 * Configuration handler for Obsidian MCP
 * Supports single vault and multi-vault modes
 */

import * as path from 'path';
import * as fs from 'fs';
import { VaultConfig } from './types/index.js';
import { closestMatches, VAULT_NOT_FOUND_HINT } from './resolver-hints.js';

export interface Config {
  mode: 'single' | 'multi';
  vaults: VaultConfig[];
  ollama: {
    host: string;
    model: string;
  };
  disabledTools: Set<string>;
  /** Global read-only mode: refuse vault-content mutators (OBSIDIAN_READ_ONLY). */
  readOnly: boolean;
  /** Wrap reader output in untrusted-content markers (OBSIDIAN_WRAP_UNTRUSTED). Default OFF. */
  wrapUntrusted: boolean;
}

/**
 * Parse a boolean-ish env var. Truthy when set to 1/true/yes/on (case-insensitive).
 * Unset or any other value is false.
 */
function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(): Config {
  // Parse disabled tools from env (comma-separated list)
  const disabledTools = new Set(
    (process.env.OBSIDIAN_DISABLED_TOOLS || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  );

  // Track C safety flags (read at config load; default OFF).
  const readOnly = envFlag(process.env.OBSIDIAN_READ_ONLY);
  const wrapUntrusted = envFlag(process.env.OBSIDIAN_WRAP_UNTRUSTED);

  // Check for multi-vault mode first
  const vaultsJson = process.env.OBSIDIAN_VAULTS;

  if (vaultsJson) {
    try {
      const vaultsObj = JSON.parse(vaultsJson) as Record<string, string>;
      const vaults: VaultConfig[] = Object.entries(vaultsObj).map(([name, path]) => ({
        name,
        path
      }));

      if (vaults.length === 0) {
        throw new Error('OBSIDIAN_VAULTS is empty');
      }

      return {
        mode: 'multi',
        vaults,
        ollama: {
          host: process.env.OLLAMA_HOST || 'http://localhost:11434',
          model: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text'
        },
        disabledTools,
        readOnly,
        wrapUntrusted
      };
    } catch (e) {
      console.error('Failed to parse OBSIDIAN_VAULTS:', e);
      throw new Error('Invalid OBSIDIAN_VAULTS JSON');
    }
  }

  // Single vault mode
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const vaultName = process.env.OBSIDIAN_VAULT_NAME || 'Vault';

  if (!vaultPath) {
    throw new Error('OBSIDIAN_VAULT_PATH environment variable is required');
  }

  return {
    mode: 'single',
    vaults: [{ name: vaultName, path: vaultPath }],
    ollama: {
      host: process.env.OLLAMA_HOST || 'http://localhost:11434',
      model: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text'
    },
    disabledTools,
    readOnly,
    wrapUntrusted
  };
}

// Get the primary vault (first one in multi-vault, only one in single)
export function getPrimaryVault(config: Config): VaultConfig {
  return config.vaults[0];
}

// Find vault by name
export function getVaultByName(config: Config, name: string): VaultConfig | undefined {
  return config.vaults.find(v => v.name.toLowerCase() === name.toLowerCase());
}

// Resolve vault by name, with fallback to primary vault
export function resolveVault(config: Config, vaultName?: string): VaultConfig {
  if (!vaultName) return getPrimaryVault(config);
  const found = getVaultByName(config, vaultName);
  if (!found) {
    const availableNames = config.vaults.map(v => v.name);
    const suggestions = closestMatches(vaultName, availableNames);
    const suggestionNote = suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(', ')}?`
      : '';
    const err = new Error(
      `Unknown vault: "${vaultName}". Available: ${availableNames.join(', ')}.${suggestionNote}`
    ) as Error & { closest_matches: string[]; hint: string };
    err.closest_matches = suggestions;
    err.hint = VAULT_NOT_FOUND_HINT;
    throw err;
  }
  return found;
}

/**
 * Safely resolve a user-supplied relative path to an absolute path within a vault.
 * Prevents path traversal (../), absolute paths, and symlink escapes.
 *
 * @param vaultPath - The absolute path to the vault root
 * @param userPath - The user-supplied relative path
 * @returns The absolute path guaranteed to be within the vault
 * @throws Error if the path escapes the vault boundary
 */
export function resolvePathInVault(vaultPath: string, userPath: string): string {
  // Reject absolute paths
  if (path.isAbsolute(userPath)) {
    throw new Error(`Absolute paths are not allowed: "${userPath}". Use a relative path from the vault root.`);
  }

  // Unicode normalization: macOS APFS preserves the normalization form used at
  // creation time, but iCloud Drive and different MCP clients may send paths in
  // NFC or NFD form. Try the path as-is first, then try the alternate
  // normalization form if the file doesn't exist.
  let normalizedPath = userPath;
  const resolved1 = path.resolve(vaultPath, userPath);
  if (!fs.existsSync(resolved1)) {
    // Try NFC if we got NFD, or NFD if we got NFC
    const nfc = userPath.normalize('NFC');
    const nfd = userPath.normalize('NFD');
    const altPath = userPath === nfc ? nfd : nfc;
    const resolved2 = path.resolve(vaultPath, altPath);
    if (fs.existsSync(resolved2)) {
      normalizedPath = altPath;
    }
  }

  // Resolve to absolute, normalize away any ../
  const resolved = path.resolve(vaultPath, normalizedPath);

  // Ensure the resolved path is within the vault
  // Add trailing separator to prevent prefix attacks (e.g., /vault-secret matching /vault)
  const vaultPrefix = vaultPath.endsWith(path.sep) ? vaultPath : vaultPath + path.sep;
  if (resolved !== vaultPath && !resolved.startsWith(vaultPrefix)) {
    throw new Error(`Path traversal detected: "${userPath}" resolves outside vault boundary.`);
  }

  // Check for symlink escape: resolve the real path and verify it's still in the vault
  try {
    // Only check if the path (or a parent) actually exists
    let checkPath = resolved;
    while (!fs.existsSync(checkPath) && checkPath !== vaultPath) {
      checkPath = path.dirname(checkPath);
    }
    if (fs.existsSync(checkPath)) {
      const realPath = fs.realpathSync(checkPath);
      const realVault = fs.realpathSync(vaultPath);
      const realVaultPrefix = realVault.endsWith(path.sep) ? realVault : realVault + path.sep;
      if (realPath !== realVault && !realPath.startsWith(realVaultPrefix)) {
        throw new Error(`Symlink escape detected: "${userPath}" resolves outside vault via symlink.`);
      }
    }
  } catch (e) {
    // Re-throw our own errors, ignore fs errors (file doesn't exist yet for create)
    if (e instanceof Error && (e.message.includes('Symlink escape') || e.message.includes('Path traversal'))) {
      throw e;
    }
  }

  return resolved;
}

/**
 * Verify that an open file descriptor's real path is still within the vault.
 * Call this AFTER opening a file to close the TOCTOU window between
 * resolvePathInVault() (which checks the symlink target) and the actual open().
 *
 * @param fd - The open file descriptor (from fs.open)
 * @param vaultPath - The absolute path to the vault root
 * @throws Error if the fd resolves outside the vault (symlink swapped between check and open)
 */
export async function verifyPathAfterOpen(fdPath: string, vaultPath: string): Promise<void> {
  const { realpath } = await import('fs/promises');
  try {
    const realFilePath = await realpath(fdPath);
    const realVault = await realpath(vaultPath);
    const realVaultPrefix = realVault.endsWith(path.sep) ? realVault : realVault + path.sep;
    if (realFilePath !== realVault && !realFilePath.startsWith(realVaultPrefix)) {
      throw new Error(`TOCTOU: file resolved outside vault after open. Real path: "${realFilePath}"`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('TOCTOU')) throw e;
    // File may have been deleted between open and check — that's fine
  }
}
