import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';

let beforeOpen;
let afterOpen;
await mock.module('fs/promises', {
  namedExports: {
    ...fs,
    open: async (...args) => {
      if (beforeOpen) await beforeOpen(...args);
      const handle = await fs.open(...args);
      if (afterOpen) await afterOpen(args[0], handle);
      return handle;
    },
  },
});
after(() => mock.restoreAll());

const { buildFileIndex, buildMultiFileIndex, resolveWikilink } = await import('../dist/parsers/wikilink.js');
const { createWikilinkHandlers } = await import('../dist/tools/wikilinks.js');

function fixture(t, files = { 'nested/Note.md': '# Original' }) {
  const vault = createTempVault(files);
  t.after(() => cleanup(vault));
  return vault;
}

async function cachedResolver(vault, kind) {
  const index = await (kind === 'single' ? buildFileIndex(vault) : buildMultiFileIndex(vault));
  return (target = 'Note', source) => resolveWikilink(
    target, vault, kind === 'single' ? index : undefined,
    source, kind === 'multi' ? index : undefined,
  );
}

for (const kind of ['single', 'multi']) {
  test(`${kind} index discards a deleted nested target`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    assert.equal(await resolve(), path.join(vault, 'nested/Note.md'));
    await fs.unlink(path.join(vault, 'nested/Note.md'));
    assert.equal(await resolve(), null);
  });

  test(`${kind} index falls back after a move and a rename without rebuilding`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    await fs.mkdir(path.join(vault, 'moved'));
    await fs.rename(path.join(vault, 'nested/Note.md'), path.join(vault, 'moved/Note.md'));
    assert.equal(await resolve(), path.join(vault, 'moved/Note.md'));
    await fs.rename(path.join(vault, 'moved/Note.md'), path.join(vault, 'moved/Renamed.md'));
    assert.equal(await resolve(), null);
    assert.equal(await resolve('Renamed'), path.join(vault, 'moved/Renamed.md'));
    await fs.writeFile(path.join(vault, 'nested/New.md'), '# New name');
    assert.equal(await resolve('New'), path.join(vault, 'nested/New.md'));
  });

  test(`${kind} index accepts a current regular-file replacement`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    await fs.writeFile(path.join(vault, 'Replacement.md'), '# Replacement');
    await fs.rename(path.join(vault, 'Replacement.md'), path.join(vault, 'nested/Note.md'));
    assert.equal(await resolve(), path.join(vault, 'nested/Note.md'));
    assert.equal(await fs.readFile(await resolve(), 'utf8'), '# Replacement');
  });

  test(`${kind} index rejects a cached target replaced by a directory`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    await fs.unlink(path.join(vault, 'nested/Note.md'));
    await fs.mkdir(path.join(vault, 'nested/Note.md'));
    assert.equal(await resolve(), null);
    assert.equal(await resolve('nested/Note'), null, 'exact paths also require regular files');
  });

  test(`${kind} index rejects a cached target replaced by an escaping symlink`, async (t) => {
    const vault = fixture(t);
    const outside = fixture(t, { 'Note.md': '# Outside' });
    const resolve = await cachedResolver(vault, kind);
    await fs.unlink(path.join(vault, 'nested/Note.md'));
    await fs.symlink(path.join(outside, 'Note.md'), path.join(vault, 'nested/Note.md'));
    assert.equal(await resolve(), null);
    assert.equal(await resolve('nested/Note'), null);
    assert.equal(await fs.readFile(path.join(outside, 'Note.md'), 'utf8'), '# Outside');
  });

  test(`${kind} index rejects a cached parent replaced by an escaping symlink`, async (t) => {
    const vault = fixture(t);
    const outside = fixture(t, { 'Note.md': '# Outside' });
    const resolve = await cachedResolver(vault, kind);
    await fs.rm(path.join(vault, 'nested'), { recursive: true });
    await fs.symlink(outside, path.join(vault, 'nested'), 'dir');
    assert.equal(await resolve(), null);
    assert.equal(await resolve('nested/Note'), null);
  });

  test(`${kind} index preserves contained symlinks for cached and exact paths`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    const candidate = path.join(vault, 'nested/Note.md');
    await fs.rename(candidate, path.join(vault, 'Current.md'));
    await fs.symlink(path.join(vault, 'Current.md'), candidate);
    assert.equal(await resolve(), candidate);
    assert.equal(await resolve('nested/Note'), candidate);
    await fs.rename(path.join(vault, 'nested'), path.join(vault, 'contained'));
    await fs.symlink(path.join(vault, 'contained'), path.join(vault, 'nested'), 'dir');
    assert.equal(await resolve(), candidate, 'an in-vault parent symlink stays valid');
    assert.equal(await resolve('nested/Note'), candidate);
    assert.equal(await fs.readFile(candidate, 'utf8'), '# Original');
    assert.equal((await buildFileIndex(vault)).has('note.md'), false, 'index discovery still skips symlinks');
  });

  test(`${kind} index rejects an outside-vault candidate and keeps in-vault fallback`, async (t) => {
    const vault = fixture(t, {});
    const outside = fixture(t, { 'Note.md': '# Outside' });
    const candidate = path.join(outside, 'Note.md');
    const index = new Map([['note.md', kind === 'single' ? candidate : [candidate]]]);
    const resolve = () => resolveWikilink('Note', vault,
      kind === 'single' ? index : undefined, undefined, kind === 'multi' ? index : undefined);
    assert.equal(await resolve(), null);
    await fs.mkdir(path.join(vault, 'safe'));
    await fs.writeFile(path.join(vault, 'safe/Note.md'), '# Inside');
    assert.equal(await resolve(), path.join(vault, 'safe/Note.md'));
  });

  test(`${kind} index rejects a pathname replaced after its handle opens`, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    const candidate = path.join(vault, 'nested/Note.md');
    let replaced = false;
    t.after(() => { afterOpen = undefined; });
    afterOpen = async openedPath => {
      if (openedPath !== candidate || replaced) return;
      replaced = true;
      await fs.rename(candidate, path.join(vault, 'Retired.md'));
      await fs.mkdir(candidate);
    };
    assert.equal(await resolve(), null);
    assert.equal(replaced, true, 'the race must execute after open, before handle verification');
  });

  test(`${kind} index rejects a FIFO swapped in between stat and open without blocking`, {
    skip: process.platform === 'win32' ? 'POSIX FIFO fixture requires mkfifo' : false,
  }, async (t) => {
    const vault = fixture(t);
    const resolve = await cachedResolver(vault, kind);
    const candidate = path.join(vault, 'nested/Note.md');
    const fifo = path.join(vault, '.replacement-fifo');
    execFileSync('mkfifo', [fifo], { timeout: 5000 });
    let flagsSeen;
    let fifoHandle;
    t.after(() => { beforeOpen = undefined; afterOpen = undefined; });
    beforeOpen = async (openedPath, flags) => {
      if (openedPath !== candidate) return;
      flagsSeen = flags;
      await fs.rename(fifo, candidate);
      // Fail without hanging the suite if a future edit restores blocking open.
      if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK)) {
        throw new Error('Refusing a blocking FIFO open in the regression fixture');
      }
    };
    afterOpen = async (openedPath, handle) => {
      if (openedPath === candidate) fifoHandle = handle;
    };
    assert.equal(await resolve(), null);
    assert.equal(flagsSeen, constants.O_RDONLY | constants.O_NONBLOCK);
    assert.ok(fifoHandle, 'the FIFO must actually open without a writer');
    assert.equal((await fs.stat(candidate)).isFIFO(), true);
    await assert.rejects(fifoHandle.stat(), { code: 'EBADF' }, 'the rejected handle must be closed');
  });
}

test('single index falls back to a surviving duplicate', async (t) => {
  const vault = fixture(t, { 'a/Note.md': '# A', 'b/Note.md': '# B' });
  const resolve = await cachedResolver(vault, 'single');
  const first = await resolve();
  const survivor = first === path.join(vault, 'a/Note.md') ? 'b/Note.md' : 'a/Note.md';
  await fs.unlink(first);
  assert.equal(await resolve(), path.join(vault, survivor));
});

test('multi index preserves same-folder, shortest-path, and alphabetical tiebreaks among survivors', async (t) => {
  const vault = fixture(t, {
    'a/Note.md': '# A', 'b/Note.md': '# B',
    'deep/source/Note.md': '# Same folder', 'deep/other/Note.md': '# Deep',
  });
  const resolve = await cachedResolver(vault, 'multi');
  const source = path.join(vault, 'deep/source/Source.md');
  assert.equal(await resolve(), path.join(vault, 'a/Note.md'));
  for (const expected of ['deep/source/Note.md', 'a/Note.md', 'b/Note.md', 'deep/other/Note.md']) {
    assert.equal(await resolve('Note', source), path.join(vault, expected));
    await fs.unlink(path.join(vault, expected));
  }
  assert.equal(await resolve('Note', source), null);
});

test('invalid multi candidates do not hide a valid single-index candidate', async (t) => {
  const vault = fixture(t, { 'live/Note.md': '# Live' });
  const live = path.join(vault, 'live/Note.md');
  const single = new Map([['note.md', live]]);
  const multi = new Map([['note.md', [path.join(vault, 'deleted/Note.md')]]]);
  assert.equal(await resolveWikilink('Note', vault, single, undefined, multi), live);
});

test('cached resolve and follow handlers track move, replacement, and deletion in the named vault', async (t) => {
  const vault = fixture(t);
  const handlers = createWikilinkHandlers({
    mode: 'single', vaults: [{ name: 'Test', path: vault }],
    disabledTools: new Set(), ollama: { host: '', model: '' }, readOnly: true,
  });
  const payload = response => {
    assert.equal(response.isError, false, response.content[0]?.text);
    return JSON.parse(response.content[0].text);
  };
  const args = { vault: 'Test', link: '[[Note#Heading|Alias]]' };
  assert.equal(payload(await handlers.resolve_wikilink(args)).resolved, 'nested/Note.md');
  await fs.mkdir(path.join(vault, 'moved'));
  await fs.rename(path.join(vault, 'nested/Note.md'), path.join(vault, 'moved/Note.md'));
  assert.equal(payload(await handlers.resolve_wikilink(args)).resolved, 'moved/Note.md');
  await fs.writeFile(path.join(vault, 'Replacement.md'), '# Current content');
  await fs.rename(path.join(vault, 'Replacement.md'), path.join(vault, 'moved/Note.md'));
  assert.equal(payload(await handlers.follow_link(args)).content, '# Current content');
  await fs.unlink(path.join(vault, 'moved/Note.md'));
  const missing = payload(await handlers.resolve_wikilink(args));
  assert.equal(missing.exists, false);
  assert.equal(missing.resolved, null);
  assert.equal(payload(await handlers.follow_link(args)).found, false);
});
