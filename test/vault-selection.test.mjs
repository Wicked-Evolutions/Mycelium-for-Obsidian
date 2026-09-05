import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVaults, VaultSelectionError, vaultSelectionResponse } from '../dist/tools/vault-selection.js';

const config = { vaults: [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }] };
test('selection omission uses all vaults and explicit selection retains configured order', () => {
  assert.equal(selectVaults(config, undefined), config.vaults);
  assert.deepEqual(selectVaults(config, ['bETA', 'alpha', 'Beta']), config.vaults);
  assert.deepEqual(selectVaults(config, ['BETA']), [config.vaults[1]]);
});
test('invalid or partially valid selections are refused without changing configuration', () => {
  for (const names of [[], null, 'Alpha', [null], ['Alpha', 'missing'], [1], ['']]) {
    assert.throws(() => selectVaults(config, names), VaultSelectionError);
  }
  assert.equal(config.vaults.length, 2);
});
test('case-folded ambiguity is refused even for an exact spelling', () => {
  const ambiguous = { vaults: [...config.vaults, { name: 'ALPHA', path: '/other' }] };
  assert.throws(() => selectVaults(ambiguous, ['Alpha']), VaultSelectionError);
  assert.deepEqual(selectVaults(ambiguous, ['Beta']), [config.vaults[1]]);
});
test('selection errors have a bounded nonmutating outcome without reflecting input', () => {
  const response = vaultSelectionResponse(new VaultSelectionError());
  assert.equal(response.structuredContent.code, 'invalid_vault_selection');
  assert.equal(response.structuredContent.sideEffects.state, 'none');
  assert.equal(vaultSelectionResponse(new Error('other')), undefined);
});
