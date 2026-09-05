import type { Config } from '../config.js';
import { recoveryResponse } from '../tool-outcomes.js';

export class VaultSelectionError extends Error {
  constructor() {
    super('Vault selection must contain unambiguous configured vault names.');
    this.name = 'VaultSelectionError';
  }
}

export function selectVaults(config: Config, names: unknown): Config['vaults'] {
  if (names === undefined) return config.vaults;
  if (!Array.isArray(names) || names.length === 0) throw new VaultSelectionError();
  const selected = new Set<Config['vaults'][number]>();
  for (const name of names) {
    if (typeof name !== 'string') throw new VaultSelectionError();
    const matches = config.vaults.filter(vault => vault.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new VaultSelectionError();
    selected.add(matches[0]);
  }
  return config.vaults.filter(vault => selected.has(vault));
}

export function vaultSelectionResponse(error: unknown) {
  if (!(error instanceof VaultSelectionError)) return undefined;
  return recoveryResponse({
    status: 'refused', code: 'invalid_vault_selection', message: error.message,
    hint: 'Omit vaults to search all configured vaults, or supply a nonempty list of configured names that resolve unambiguously.',
    retryable: false, sideEffects: { state: 'none' },
  });
}
