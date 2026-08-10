import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { computeGraphDigest } from '../dist/graph/digest.js';

test('graph digest detects same-size content edits with restored mtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mycelium-digest-'));
  try {
    const file = join(root, 'Link.md');
    writeFileSync(file, 'See [[A]].\n', 'utf8');
    const original = statSync(file);
    const before = await computeGraphDigest(root);

    writeFileSync(file, 'See [[B]].\n', 'utf8');
    utimesSync(file, original.atime, original.mtime);
    const after = await computeGraphDigest(root);

    assert.equal(statSync(file).size, original.size);
    assert.notEqual(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph digest length-frames paths and content without NUL collisions', async () => {
  const combined = mkdtempSync(join(tmpdir(), 'mycelium-digest-combined-'));
  const split = mkdtempSync(join(tmpdir(), 'mycelium-digest-split-'));
  try {
    writeFileSync(join(combined, 'a.md'), Buffer.from('X\0b.md\0Y'));
    writeFileSync(join(split, 'a.md'), 'X', 'utf8');
    writeFileSync(join(split, 'b.md'), 'Y', 'utf8');

    assert.notEqual(
      await computeGraphDigest(combined),
      await computeGraphDigest(split),
    );
  } finally {
    rmSync(combined, { recursive: true, force: true });
    rmSync(split, { recursive: true, force: true });
  }
});

test('graph digest fails closed when a markdown file is unreadable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mycelium-digest-unreadable-file-'));
  const file = join(root, 'Locked.md');
  try {
    writeFileSync(file, '# Locked', 'utf8');
    chmodSync(file, 0o000);
    await assert.rejects(
      computeGraphDigest(root),
      /could not be read completely/,
    );
  } finally {
    chmodSync(file, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph digest fails closed when a vault subtree is unreadable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mycelium-digest-unreadable-dir-'));
  const locked = join(root, 'Locked');
  try {
    mkdirSync(locked);
    writeFileSync(join(locked, 'Hidden.md'), '# Hidden', 'utf8');
    chmodSync(locked, 0o000);
    await assert.rejects(computeGraphDigest(root));
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
