/**
 * Track C — global read-only mode (OBSIDIAN_READ_ONLY).
 *
 * Verifies the refuse-and-stay-listed wrapper:
 *  - vault-content mutators are REFUSED with a structured, self-correcting payload
 *    (no underlying handler invoked, no file written)
 *  - refused tools STAY in allTools (not deleted like disabledTools)
 *  - readers pass through and run normally
 *  - derived-index tools (index_vault, index_file, rebuild_link_index) are EXEMPT and run
 *  - with read-only OFF, mutators run normally
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';

const { loadConfig } = await import('../dist/config.js');
const toolsMod = await import('../dist/tools/index.js');
const { createAllHandlers } = toolsMod;

const VAULT_NAME = 'TestVault';

function buildHandlers(vaultDir, { readOnly }) {
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ [VAULT_NAME]: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  if (readOnly) process.env.OBSIDIAN_READ_ONLY = '1';
  else delete process.env.OBSIDIAN_READ_ONLY;
  delete process.env.OBSIDIAN_WRAP_UNTRUSTED;
  const config = loadConfig();
  const handlers = createAllHandlers(config);
  return { handlers, tools: toolsMod.allTools };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test('read-only mode refuses a vault-content mutator (create_file) without writing', async () => {
  const dir = createTempVault({ 'Existing.md': '# E' });
  try {
    const { handlers } = buildHandlers(dir, { readOnly: true });
    const res = await handlers.create_file({ vault: VAULT_NAME, path: 'New.md', content: 'hi' });
    assert.equal(res.isError, true, 'refusal must be an error response');
    const body = parse(res);
    assert.equal(body.error, 'read_only_mode');
    assert.equal(body.tool, 'create_file');
    assert.equal(body.readOnly, true);
    assert.match(body.hint, /OBSIDIAN_READ_ONLY/, 'hint must explain how to lift the restriction');
    assert.ok(!fs.existsSync(path.join(dir, 'New.md')), 'no file may be created');
  } finally {
    cleanup(dir);
  }
});

test('read-only mode refuses delete_file (destructive mutator) without deleting', async () => {
  const dir = createTempVault({ 'Keep.md': '# keep' });
  try {
    const { handlers } = buildHandlers(dir, { readOnly: true });
    const res = await handlers.delete_file({ vault: VAULT_NAME, path: 'Keep.md' });
    assert.equal(res.isError, true);
    assert.equal(parse(res).error, 'read_only_mode');
    assert.ok(fs.existsSync(path.join(dir, 'Keep.md')), 'file must survive');
  } finally {
    cleanup(dir);
  }
});

test('read-only mode lets readers run normally', async () => {
  const dir = createTempVault({ 'Note.md': '# Title\n\nbody' });
  try {
    const { handlers } = buildHandlers(dir, { readOnly: true });
    const res = await handlers.read_file({ vault: VAULT_NAME, path: 'Note.md' });
    assert.equal(res.isError, false, 'read_file must succeed in read-only mode');
    assert.ok(parse(res).content !== undefined);
  } finally {
    cleanup(dir);
  }
});

test('refused mutators STAY listed in allTools (not removed)', async () => {
  const dir = createTempVault({});
  try {
    const { tools } = buildHandlers(dir, { readOnly: true });
    const names = new Set(tools.map(t => t.name));
    for (const n of ['create_file', 'update_file', 'delete_file', 'append_to_section']) {
      assert.ok(names.has(n), `${n} must remain in allTools (refuse-and-stay-listed)`);
    }
  } finally {
    cleanup(dir);
  }
});

test('derived-index tools are EXEMPT — handler runs in read-only mode', async () => {
  const dir = createTempVault({ 'A.md': '[[B]]', 'B.md': '# B' });
  try {
    const { handlers } = buildHandlers(dir, { readOnly: true });
    const res = await handlers.rebuild_link_index({ vault: VAULT_NAME });
    // The real handler ran (not the refusal payload).
    const body = parse(res);
    assert.notEqual(body.error, 'read_only_mode', 'rebuild_link_index must be exempt from the guard');
  } finally {
    cleanup(dir);
  }
});

test('with read-only OFF, mutators run normally', async () => {
  const dir = createTempVault({});
  try {
    const { handlers } = buildHandlers(dir, { readOnly: false });
    const res = await handlers.create_file({ vault: VAULT_NAME, path: 'Made.md', content: 'x' });
    assert.equal(res.isError, false, 'create_file must succeed when read-only is off');
    assert.ok(fs.existsSync(path.join(dir, 'Made.md')));
  } finally {
    cleanup(dir);
  }
});
