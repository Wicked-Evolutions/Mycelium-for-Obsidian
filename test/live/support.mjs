const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function envFlag(value) {
  return typeof value === 'string' && TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

function notRun(reason) {
  return new Error(`Live release gate NOT RUN: ${reason}`);
}

export function validateSelectedVaultEnvironment(env = process.env) {
  const rawVaultName = typeof env.LIVE_TEST_VAULT === 'string'
    ? env.LIVE_TEST_VAULT
    : '';
  const vaultName = rawVaultName.trim();
  if (!vaultName) {
    throw notRun('LIVE_TEST_VAULT must name the operator-selected vault.');
  }
  if (rawVaultName !== vaultName) {
    throw notRun('LIVE_TEST_VAULT must not contain surrounding whitespace.');
  }

  let vaults;
  try {
    vaults = JSON.parse(env.OBSIDIAN_VAULTS ?? '');
  } catch {
    throw notRun('OBSIDIAN_VAULTS must be valid JSON.');
  }

  if (vaults === null || Array.isArray(vaults) || typeof vaults !== 'object') {
    throw notRun('OBSIDIAN_VAULTS must be an object that maps vault names to paths.');
  }
  if (!Object.prototype.hasOwnProperty.call(vaults, vaultName)) {
    throw notRun('OBSIDIAN_VAULTS must contain the selected LIVE_TEST_VAULT as its own entry.');
  }
  if (typeof vaults[vaultName] !== 'string' || vaults[vaultName].trim().length === 0) {
    throw notRun('the selected vault entry must contain a non-empty path.');
  }

  return { vaultName };
}

export function validateRequiredLiveEnvironment(env = process.env) {
  const { vaultName } = validateSelectedVaultEnvironment(env);
  if (!envFlag(env.LIVE_OLLAMA)) {
    throw notRun('LIVE_OLLAMA must be explicitly enabled with 1, true, yes, or on.');
  }

  return {
    vaultName,
    ollamaEnabled: true,
  };
}

export function optionalVaultSkipReason(env = process.env) {
  try {
    validateSelectedVaultEnvironment(env);
    return false;
  } catch {
    return 'set a valid LIVE_TEST_VAULT and OBSIDIAN_VAULTS map to run this diagnostic suite';
  }
}

/**
 * Temporarily changes process.env and restores exact prior presence and values.
 * Process environment is global, so callers must use this sequentially.
 */
export async function withTemporaryEnv(changes, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(changes)) {
    previous.set(name, {
      present: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    return await operation();
  } finally {
    for (const [name, state] of previous) {
      if (state.present) process.env[name] = state.value;
      else delete process.env[name];
    }
  }
}
