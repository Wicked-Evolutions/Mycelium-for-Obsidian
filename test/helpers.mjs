import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a temporary vault directory populated with the given files.
 * @param {Record<string, string>} files - Map of relative path to file contents.
 * @returns {string} Absolute path to the vault root directory.
 */
export function createTempVault(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-obsidian-test-'));
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

/**
 * Recursively remove a directory created by createTempVault.
 * @param {string} dir - Absolute path to the directory to remove.
 */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
