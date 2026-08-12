import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  fsyncDirectory,
  mkdirAt,
  openFileAt,
  openPinnedDirectory,
  renameAt,
  secureMutationSupported,
  unlinkAt,
} from '../dist/embeddings/secure-fs.js';
import { cleanup, createTempVault } from './helpers.mjs';

const pathsToClean = [];

afterEach(() => {
  for (const targetPath of pathsToClean.splice(0)) cleanup(targetPath);
});

function makeDirectory(files = {}) {
  const directory = createTempVault(files);
  pathsToClean.push(directory);
  return directory;
}

function identity(targetPath) {
  const stat = fs.lstatSync(targetPath, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

test('secure mutation support is explicit by operating-system family', async () => {
  assert.equal(secureMutationSupported('darwin'), true);
  assert.equal(secureMutationSupported('linux'), true);
  assert.equal(secureMutationSupported('win32'), false);
  assert.equal(secureMutationSupported('aix'), false);
});

test('descriptor-relative mutations remain inside the pinned directory after a parent swap', (t) => {
  if (!secureMutationSupported()) {
    t.skip('descriptor-relative mutation backend is unavailable on this platform');
    return;
  }

  const root = makeDirectory();
  const external = makeDirectory({
    'embeddings.db': 'external canonical',
    'embeddings.publish.lock': 'external lock',
    'temporary.tmp': 'external temporary',
    'rollback.rollback': 'external rollback',
  });
  const owned = path.join(root, 'owned');
  const moved = path.join(root, 'owned-moved');
  fs.mkdirSync(owned, { mode: 0o700 });
  fs.writeFileSync(path.join(owned, 'embeddings.db'), 'owned canonical', { mode: 0o600 });
  const externalBefore = new Map(
    fs.readdirSync(external).map(name => {
      const targetPath = path.join(external, name);
      const stat = fs.lstatSync(targetPath);
      return [name, { bytes: fs.readFileSync(targetPath), inode: stat.ino, links: stat.nlink }];
    })
  );

  const directoryDescriptor = openPinnedDirectory(owned, identity(owned));
  try {
    fs.renameSync(owned, moved);
    fs.symlinkSync(external, owned, 'dir');

    const temporaryDescriptor = openFileAt(
      directoryDescriptor,
      'temporary.tmp',
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    fs.writeFileSync(temporaryDescriptor, 'new generation');
    fs.fsyncSync(temporaryDescriptor);
    assert.equal(fs.fstatSync(temporaryDescriptor).mode & 0o777, 0o600);
    fs.closeSync(temporaryDescriptor);

    renameAt(directoryDescriptor, 'temporary.tmp', 'embeddings.db');
    const cleanupDescriptor = openFileAt(
      directoryDescriptor,
      'cleanup.tmp',
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    fs.closeSync(cleanupDescriptor);
    unlinkAt(directoryDescriptor, 'cleanup.tmp');
    mkdirAt(directoryDescriptor, 'child', 0o700);
    fsyncDirectory(directoryDescriptor);

    assert.equal(fs.readFileSync(path.join(moved, 'embeddings.db'), 'utf8'), 'new generation');
    assert.equal(fs.existsSync(path.join(moved, 'cleanup.tmp')), false);
    assert.equal(fs.statSync(path.join(moved, 'child')).mode & 0o777, 0o700);
    for (const [name, before] of externalBefore) {
      const targetPath = path.join(external, name);
      const after = fs.lstatSync(targetPath);
      assert.deepEqual(fs.readFileSync(targetPath), before.bytes, name);
      assert.equal(after.ino, before.inode, name);
      assert.equal(after.nlink, before.links, name);
    }
    assert.equal(fs.existsSync(path.join(external, 'child')), false);
  } finally {
    fs.closeSync(directoryDescriptor);
    if (fs.lstatSync(owned).isSymbolicLink()) fs.unlinkSync(owned);
    if (fs.existsSync(moved)) fs.renameSync(moved, owned);
  }
});

test('descriptor-relative names reject traversal and nested path components', (t) => {
  if (!secureMutationSupported()) {
    t.skip('descriptor-relative mutation backend is unavailable on this platform');
    return;
  }

  const directory = makeDirectory();
  const descriptor = openPinnedDirectory(directory, identity(directory));
  try {
    for (const name of ['', '.', '..', '../outside', 'nested/file', 'nested\\file', 'bad\0name']) {
      assert.throws(
        () => openFileAt(descriptor, name, fs.constants.O_RDONLY),
        /one safe path component/i,
        name
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
});
