/**
 * Track C — byte-delta telemetry on JSON content mutators.
 *
 * create_file/update_file/update_frontmatter/delete_file (files.ts) and
 * append/prepend/update_section (sections.ts) must report
 * previousSizeInBytes + currentSizeInBytes reflecting the on-disk UTF-8 size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';

const { loadConfig } = await import('../dist/config.js');
const { createFileHandlers } = await import('../dist/tools/files.js');
const { createSectionHandlers } = await import('../dist/tools/sections.js');

const VAULT_NAME = 'TestVault';

function makeConfig(vaultDir) {
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ [VAULT_NAME]: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  delete process.env.OBSIDIAN_READ_ONLY;
  return loadConfig();
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

function diskSize(dir, rel) {
  return fs.statSync(path.join(dir, rel)).size;
}

test('create_file reports previous=0 and current=on-disk size', async () => {
  const dir = createTempVault({});
  try {
    const h = createFileHandlers(makeConfig(dir));
    const res = await h.create_file({ vault: VAULT_NAME, path: 'New.md', content: 'hello world' });
    const body = parse(res);
    assert.equal(body.previousSizeInBytes, 0, 'new file has no previous bytes');
    assert.equal(body.currentSizeInBytes, diskSize(dir, 'New.md'), 'current must match disk size');
    assert.ok(body.currentSizeInBytes > 0);
  } finally {
    cleanup(dir);
  }
});

test('update_file reports the real previous and current sizes', async () => {
  const dir = createTempVault({ 'Doc.md': 'tiny' });
  try {
    const prevDisk = diskSize(dir, 'Doc.md');
    const h = createFileHandlers(makeConfig(dir));
    const longContent = 'a much longer body than before '.repeat(5);
    const res = await h.update_file({ vault: VAULT_NAME, path: 'Doc.md', content: longContent });
    const body = parse(res);
    assert.equal(body.previousSizeInBytes, prevDisk, 'previous must match the pre-write disk size');
    assert.equal(body.currentSizeInBytes, diskSize(dir, 'Doc.md'), 'current must match post-write disk size');
    assert.ok(body.currentSizeInBytes > body.previousSizeInBytes, 'file grew');
  } finally {
    cleanup(dir);
  }
});

test('update_frontmatter reports both sizes', async () => {
  const dir = createTempVault({ 'F.md': '---\na: 1\n---\nbody' });
  try {
    const prevDisk = diskSize(dir, 'F.md');
    const h = createFileHandlers(makeConfig(dir));
    const res = await h.update_frontmatter({ vault: VAULT_NAME, path: 'F.md', updates: { b: 2, c: 'three' } });
    const body = parse(res);
    assert.equal(body.previousSizeInBytes, prevDisk);
    assert.equal(body.currentSizeInBytes, diskSize(dir, 'F.md'));
  } finally {
    cleanup(dir);
  }
});

test('delete_file reports previous>0 and current=0', async () => {
  const dir = createTempVault({ 'Gone.md': 'some content here' });
  try {
    const prevDisk = diskSize(dir, 'Gone.md');
    const h = createFileHandlers(makeConfig(dir));
    const res = await h.delete_file({ vault: VAULT_NAME, path: 'Gone.md' });
    const body = parse(res);
    assert.equal(body.previousSizeInBytes, prevDisk);
    assert.equal(body.currentSizeInBytes, 0, 'deleted file has zero current bytes');
  } finally {
    cleanup(dir);
  }
});

test('append_to_section reports growth in byte size', async () => {
  const dir = createTempVault({ 'S.md': '# H\n\noriginal\n' });
  try {
    const prevDisk = diskSize(dir, 'S.md');
    const h = createSectionHandlers(makeConfig(dir));
    const res = await h.append_to_section({ vault: VAULT_NAME, path: 'S.md', heading: 'H', content: 'appended line' });
    const body = parse(res);
    assert.equal(body.success, true);
    assert.equal(body.previousSizeInBytes, prevDisk);
    assert.equal(body.currentSizeInBytes, diskSize(dir, 'S.md'));
    assert.ok(body.currentSizeInBytes > body.previousSizeInBytes, 'section grew after append');
  } finally {
    cleanup(dir);
  }
});

test('update_section reports both sizes', async () => {
  const dir = createTempVault({ 'U.md': '# Sec\n\nold content here\n' });
  try {
    const prevDisk = diskSize(dir, 'U.md');
    const h = createSectionHandlers(makeConfig(dir));
    const res = await h.update_section({ vault: VAULT_NAME, path: 'U.md', heading: 'Sec', content: 'new' });
    const body = parse(res);
    assert.equal(body.success, true);
    assert.equal(body.previousSizeInBytes, prevDisk);
    assert.equal(body.currentSizeInBytes, diskSize(dir, 'U.md'));
  } finally {
    cleanup(dir);
  }
});
