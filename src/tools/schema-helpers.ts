/**
 * Shared schema fragments for tool inputSchema definitions.
 *
 * Eliminates the per-file duplication of the vault param (identical across all
 * 8 tool files) and the limit param (same shape, different defaults).
 *
 * Usage:
 *   import { vaultParam, limitParam } from './schema-helpers.js';
 *
 *   properties: {
 *     vault: vaultParam,
 *     limit: limitParam(50),
 *   }
 */

/**
 * The vault param fragment — identical across all tool files.
 * Optional in every tool; resolves to the first configured vault when omitted.
 *
 * This is the static baseline. Use vaultParamWithEnum() after loadConfig() to
 * surface the operator's actual configured vault names to the AI.
 */
export const vaultParam = {
  type: 'string' as const,
  description: 'Vault name (e.g., "Platform", "Helena"). Defaults to first vault if omitted.'
};

/**
 * Factory that builds a vault param with a concrete enum of configured vault names.
 * Call this after loadConfig() and inject the result via injectVaultEnum().
 *
 * Returns a new object on every call (pure, no shared-singleton mutation).
 *
 * @param names - The vault names from config.vaults.map(v => v.name)
 */
export function vaultParamWithEnum(names: string[]): {
  type: 'string';
  description: string;
  enum: string[];
} {
  const list = names.join(', ');
  return {
    type: 'string',
    description: `Vault name. Configured vaults: ${list}. Defaults to first vault if omitted.`,
    enum: names
  };
}

/**
 * Walk a list of tools and inject a live vault enum into every vault param
 * that is present. Tools without a vault property are left unchanged.
 *
 * Mutates only the individual tool objects in the array (replaces
 * properties.vault), never the shared vaultParam singleton.
 *
 * @param tools  - The tool array to update in-place.
 * @param names  - The vault names from config.vaults.map(v => v.name).
 */
export function injectVaultEnum(
  tools: Array<{ inputSchema: { properties?: Record<string, unknown> } }>,
  names: string[]
): void {
  if (names.length === 0) return;
  const enriched = vaultParamWithEnum(names);
  for (const tool of tools) {
    const props = tool.inputSchema.properties;
    if (props && 'vault' in props) {
      props['vault'] = enriched;
    }
  }
}

/**
 * Factory for a limit param fragment.
 * Each call site can specify its own default and an optional description override.
 *
 * @param defaultVal  - The default maximum result count for this tool.
 * @param description - Optional description override; defaults to 'Maximum results'.
 */
export function limitParam(
  defaultVal: number,
  description = 'Maximum results'
): { type: 'number'; description: string; default: number } {
  return {
    type: 'number',
    description,
    default: defaultVal
  };
}
