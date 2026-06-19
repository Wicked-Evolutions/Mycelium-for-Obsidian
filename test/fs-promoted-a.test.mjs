/**
 * fs-promoted-a.test.mjs
 *
 * Vault Utilities part A — behavioral tests for:
 *   daily_read, daily_append, daily_prepend, daily_path,
 *   list_tasks, update_task,
 *   list_tags, get_tag_info,
 *   list_properties, get_property_values,
 *   property_read, property_set, property_remove,
 *   get_outline, word_count, list_aliases
 *
 * All assertions are on real output content — no tautologies.
 *
 * Run: node --test test/fs-promoted-a.test.mjs
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanup } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { createAllHandlers } from '../dist/tools/index.js';

// ---------------------------------------------------------------------------
// Shared vault setup (read-only vault for most tests)
// ---------------------------------------------------------------------------

const VAULT_FILES = {
  // frontmatter + tasks + tags + headings
  'Notes/Alpha.md': [
    '---',
    'status: active',
    'type: note',
    'aliases: [Alpha Alias, First Note]',
    'tags: [project, research]',
    '---',
    '',
    '# Alpha Title',
    '',
    'Some body text here with a few words.',
    '',
    '## Section One',
    '',
    'More content under section one.',
    '',
    '### Subsection',
    '',
    'Deep content.',
    '',
    '- [ ] Alpha todo task',
    '- [x] Alpha done task',
    '',
    'Inline tag: #inline-tag',
  ].join('\n'),

  'Notes/Beta.md': [
    '---',
    'status: draft',
    'type: reference',
    'aliases: [Beta Alias]',
    'tags: [research]',
    '---',
    '',
    '# Beta Title',
    '',
    '## Beta Section',
    '',
    'Beta body text.',
    '',
    '- [ ] Beta todo one',
    '- [ ] Beta todo two',
    '',
    '#inline-tag and #other-tag',
  ].join('\n'),

  'Gamma.md': [
    '---',
    'status: active',
    'type: note',
    '---',
    '',
    '# Gamma Title',
    '',
    'Short note.',
  ].join('\n'),

  // No frontmatter — plain file
  'Plain.md': [
    '# Plain Title',
    '',
    'No frontmatter here.',
    '',
    '## Sub A',
    '',
    '- [ ] Plain todo',
  ].join('\n'),
};

let vaultDir;
let handlers;

before(() => {
  vaultDir = createTempVault(VAULT_FILES);
  process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
  delete process.env.OBSIDIAN_DISABLED_TOOLS;
  const config = loadConfig();
  handlers = createAllHandlers(config);
});

after(() => {
  delete process.env.OBSIDIAN_VAULTS;
  if (vaultDir) cleanup(vaultDir);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function text(res) {
  return res.content[0].text;
}

function assertOk(res, label) {
  assert.equal(typeof res, 'object', `${label}: is object`);
  assert.ok(Array.isArray(res.content), `${label}: has content array`);
  assert.equal(typeof res.content[0].text, 'string', `${label}: text is string`);
  assert.equal(res.isError, false, `${label}: isError=false — got: ${res.content[0].text}`);
}

function assertErr(res, label) {
  assert.equal(res.isError, true, `${label}: isError=true — got: ${res.content[0].text}`);
}

// ---------------------------------------------------------------------------
// daily_path
// ---------------------------------------------------------------------------

describe('daily_path', () => {
  test('returns a string ending in .md', async () => {
    const res = await handlers.daily_path({ vault: 'TestVault' });
    assertOk(res, 'daily_path');
    const p = text(res);
    assert.ok(p.endsWith('.md'), `daily_path: ends with .md, got "${p}"`);
  });

  test('default path contains today YYYY-MM-DD date', async () => {
    const res = await handlers.daily_path({ vault: 'TestVault' });
    assertOk(res, 'daily_path date');
    const p = text(res);
    const today = new Date();
    const yyyy = today.getFullYear().toString();
    const mm = (today.getMonth() + 1).toString().padStart(2, '0');
    const dd = today.getDate().toString().padStart(2, '0');
    assert.ok(
      p.includes(`${yyyy}-${mm}-${dd}`),
      `daily_path: expected "${yyyy}-${mm}-${dd}" in "${p}"`,
    );
  });

  test('respects custom folder from daily-notes.json config', async () => {
    // Write a .obsidian/daily-notes.json into the vault
    const obsidianDir = path.join(vaultDir, '.obsidian');
    fs.mkdirSync(obsidianDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsidianDir, 'daily-notes.json'),
      JSON.stringify({ folder: 'Journal', format: 'YYYY-MM-DD' }),
      'utf-8',
    );
    const res = await handlers.daily_path({ vault: 'TestVault' });
    assertOk(res, 'daily_path folder');
    assert.ok(text(res).startsWith('Journal/'), `daily_path: expected Journal/ prefix, got "${text(res)}"`);
    // Cleanup
    fs.unlinkSync(path.join(obsidianDir, 'daily-notes.json'));
  });
});

// ---------------------------------------------------------------------------
// daily_read
// ---------------------------------------------------------------------------

describe('daily_read', () => {
  test('returns not-exist message when no daily note file', async () => {
    // No daily note created — should return the "does not exist" sentinel
    const res = await handlers.daily_read({ vault: 'TestVault' });
    assertOk(res, 'daily_read missing');
    // The implementation returns ok() not err() for missing file
    assert.equal(res.isError, false, 'daily_read: missing note is not an error');
    assert.ok(
      text(res).includes('does not exist') || text(res).includes('empty'),
      `daily_read: expected "does not exist" or "empty", got "${text(res)}"`,
    );
  });

  test('returns content after daily_append creates the note', async () => {
    const appendRes = await handlers.daily_append({ vault: 'TestVault', content: 'Appended line' });
    assertOk(appendRes, 'daily_append for daily_read');

    const readRes = await handlers.daily_read({ vault: 'TestVault' });
    assertOk(readRes, 'daily_read after append');
    assert.ok(text(readRes).includes('Appended line'), `daily_read: expected "Appended line", got "${text(readRes)}"`);
  });
});

// ---------------------------------------------------------------------------
// daily_append
// ---------------------------------------------------------------------------

describe('daily_append', () => {
  test('creates daily note and appends content', async () => {
    const res = await handlers.daily_append({ vault: 'TestVault', content: 'Hello daily' });
    assertOk(res, 'daily_append creates');
    assert.ok(text(res).toLowerCase().includes('append'), `daily_append: success message mentions append, got "${text(res)}"`);

    // Verify the file was actually written
    const readRes = await handlers.daily_read({ vault: 'TestVault' });
    assertOk(readRes, 'daily_read after first append');
    assert.ok(text(readRes).includes('Hello daily'), `daily_append: content persisted`);
  });

  test('subsequent appends accumulate content', async () => {
    await handlers.daily_append({ vault: 'TestVault', content: 'First append' });
    await handlers.daily_append({ vault: 'TestVault', content: 'Second append' });

    const readRes = await handlers.daily_read({ vault: 'TestVault' });
    assertOk(readRes, 'daily_read after two appends');
    const body = text(readRes);
    assert.ok(body.includes('First append'), 'daily_append: first line present');
    assert.ok(body.includes('Second append'), 'daily_append: second line present');
    // Second should appear after first
    assert.ok(
      body.indexOf('First append') < body.indexOf('Second append'),
      'daily_append: first comes before second',
    );
  });
});

// ---------------------------------------------------------------------------
// daily_prepend
// ---------------------------------------------------------------------------

describe('daily_prepend', () => {
  test('prepends content so it appears before existing content', async () => {
    // Ensure something is in the note first
    await handlers.daily_append({ vault: 'TestVault', content: 'Existing content' });
    const prependRes = await handlers.daily_prepend({ vault: 'TestVault', content: 'Prepended line' });
    assertOk(prependRes, 'daily_prepend');
    assert.ok(text(prependRes).toLowerCase().includes('prepend'), `daily_prepend: success mentions prepend`);

    const readRes = await handlers.daily_read({ vault: 'TestVault' });
    assertOk(readRes, 'daily_read after prepend');
    const body = text(readRes);
    assert.ok(body.includes('Prepended line'), 'daily_prepend: prepended content present');
    assert.ok(body.includes('Existing content'), 'daily_prepend: existing content preserved');
    assert.ok(
      body.indexOf('Prepended line') < body.indexOf('Existing content'),
      'daily_prepend: prepended content comes first',
    );
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe('list_tasks', () => {
  test('returns all tasks by default (filter=all)', async () => {
    const res = await handlers.list_tasks({ vault: 'TestVault' });
    assertOk(res, 'list_tasks all');
    const body = text(res);
    // Alpha todo, Alpha done, Beta todo x2, Plain todo
    assert.ok(body.includes('Alpha todo task'), 'list_tasks: Alpha todo present');
    assert.ok(body.includes('Alpha done task'), 'list_tasks: Alpha done present');
    assert.ok(body.includes('Beta todo one'), 'list_tasks: Beta todo one present');
  });

  test('filter=todo returns only unchecked tasks', async () => {
    const res = await handlers.list_tasks({ vault: 'TestVault', filter: 'todo' });
    assertOk(res, 'list_tasks todo');
    const body = text(res);
    assert.ok(body.includes('[ ]'), 'list_tasks todo: has unchecked marker');
    assert.ok(!body.includes('[x]') && !body.includes('[X]'), 'list_tasks todo: no done markers');
    assert.ok(body.includes('Alpha todo task'), 'list_tasks todo: Alpha todo present');
    assert.ok(!body.includes('Alpha done task'), 'list_tasks todo: Alpha done excluded');
  });

  test('filter=done returns only checked tasks', async () => {
    const res = await handlers.list_tasks({ vault: 'TestVault', filter: 'done' });
    assertOk(res, 'list_tasks done');
    const body = text(res);
    assert.ok(body.includes('[x]') || body.includes('[X]'), 'list_tasks done: has done marker');
    assert.ok(body.includes('Alpha done task'), 'list_tasks done: Alpha done present');
    // No unchecked tasks should appear
    assert.ok(!body.includes('Alpha todo task'), 'list_tasks done: Alpha todo excluded');
  });

  test('file filter scopes to single file', async () => {
    const res = await handlers.list_tasks({
      vault: 'TestVault',
      path: 'Notes/Alpha.md',
      filter: 'all',
    });
    assertOk(res, 'list_tasks file filter');
    const body = text(res);
    assert.ok(body.includes('Alpha todo task'), 'list_tasks file: Alpha todo present');
    assert.ok(body.includes('Alpha done task'), 'list_tasks file: Alpha done present');
    assert.ok(!body.includes('Beta todo'), 'list_tasks file: Beta tasks excluded');
  });

  test('verbose mode includes file:line prefix', async () => {
    const res = await handlers.list_tasks({
      vault: 'TestVault',
      path: 'Notes/Alpha.md',
      verbose: true,
      filter: 'all',
    });
    assertOk(res, 'list_tasks verbose');
    const body = text(res);
    // Verbose format: file:lineNum\t[mark] text
    assert.ok(body.includes('Notes/Alpha.md:'), 'list_tasks verbose: file:line prefix present');
  });

  test('returns "No tasks found." when file has no tasks', async () => {
    const res = await handlers.list_tasks({ vault: 'TestVault', path: 'Gamma.md' });
    assertOk(res, 'list_tasks empty');
    assert.ok(text(res).includes('No tasks found'), `list_tasks: empty result, got "${text(res)}"`);
  });
});

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

describe('update_task', () => {
  // We need a mutable vault for update_task tests
  let mutVaultDir;
  let mutHandlers;

  before(() => {
    mutVaultDir = createTempVault({
      'tasks.md': [
        '- [ ] Task one',
        '- [x] Task two',
        '- [ ] Task three',
      ].join('\n'),
    });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ MutVault: mutVaultDir });
    delete process.env.OBSIDIAN_DISABLED_TOOLS;
    const config = loadConfig();
    mutHandlers = createAllHandlers(config);
  });

  after(() => {
    if (mutVaultDir) cleanup(mutVaultDir);
    // Restore main vault env
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
    const config = loadConfig();
    handlers = createAllHandlers(config);
  });

  test('action=done marks an unchecked task as done', async () => {
    const res = await mutHandlers.update_task({
      vault: 'MutVault',
      path: 'tasks.md',
      line: 1,
      action: 'done',
    });
    assertOk(res, 'update_task done');
    // Verify file was actually updated
    const content = fs.readFileSync(path.join(mutVaultDir, 'tasks.md'), 'utf-8');
    const lines = content.split('\n');
    assert.ok(lines[0].includes('[x]'), `update_task done: line 1 should be [x], got "${lines[0]}"`);
    assert.ok(lines[0].includes('Task one'), 'update_task done: text preserved');
  });

  test('action=todo unchecks a done task', async () => {
    const res = await mutHandlers.update_task({
      vault: 'MutVault',
      path: 'tasks.md',
      line: 2,
      action: 'todo',
    });
    assertOk(res, 'update_task todo');
    const content = fs.readFileSync(path.join(mutVaultDir, 'tasks.md'), 'utf-8');
    const lines = content.split('\n');
    assert.ok(lines[1].includes('[ ]'), `update_task todo: line 2 should be [ ], got "${lines[1]}"`);
    assert.ok(lines[1].includes('Task two'), 'update_task todo: text preserved');
  });

  test('action=toggle flips todo to done', async () => {
    // Line 3 is Task three, which is [ ]
    const res = await mutHandlers.update_task({
      vault: 'MutVault',
      path: 'tasks.md',
      line: 3,
      action: 'toggle',
    });
    assertOk(res, 'update_task toggle');
    const content = fs.readFileSync(path.join(mutVaultDir, 'tasks.md'), 'utf-8');
    const lines = content.split('\n');
    assert.ok(lines[2].includes('[x]'), `update_task toggle: line 3 should be [x], got "${lines[2]}"`);
  });

  test('action=toggle on done task flips to todo', async () => {
    // After the previous test, line 3 is now [x] — toggle again
    const res = await mutHandlers.update_task({
      vault: 'MutVault',
      path: 'tasks.md',
      line: 3,
      action: 'toggle',
    });
    assertOk(res, 'update_task toggle back');
    const content = fs.readFileSync(path.join(mutVaultDir, 'tasks.md'), 'utf-8');
    const lines = content.split('\n');
    assert.ok(lines[2].includes('[ ]'), `update_task toggle back: line 3 should be [ ], got "${lines[2]}"`);
  });

  test('returns error for out-of-range line number', async () => {
    const res = await mutHandlers.update_task({
      vault: 'MutVault',
      path: 'tasks.md',
      line: 999,
      action: 'done',
    });
    assertErr(res, 'update_task oob');
    assert.ok(text(res).includes('999'), `update_task oob: error mentions line, got "${text(res)}"`);
  });

  test('returns error when line is not a task', async () => {
    // Create a file where line 1 is not a task
    const notTaskVaultDir = createTempVault({ 'note.md': 'Just plain text\n- [ ] real task' });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ NTVault: notTaskVaultDir });
    const cfg = loadConfig();
    const h = createAllHandlers(cfg);
    const res = await h.update_task({ vault: 'NTVault', path: 'note.md', line: 1, action: 'done' });
    assertErr(res, 'update_task not-a-task');
    assert.ok(text(res).toLowerCase().includes('not a task'), `update_task not-a-task: "${text(res)}"`);
    cleanup(notTaskVaultDir);
    // Restore
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ MutVault: mutVaultDir });
  });
});

// ---------------------------------------------------------------------------
// list_tags
// ---------------------------------------------------------------------------

describe('list_tags', () => {
  test('returns tags with counts in tab-separated format', async () => {
    const res = await handlers.list_tags({ vault: 'TestVault' });
    assertOk(res, 'list_tags');
    const body = text(res);
    // research appears in both Alpha and Beta frontmatter
    const lines = body.split('\n');
    const researchLine = lines.find(l => l.startsWith('research'));
    assert.ok(researchLine, `list_tags: "research" tag present in:\n${body}`);
    const [, countStr] = researchLine.split('\t');
    assert.ok(Number(countStr) >= 2, `list_tags: research count >= 2, got "${countStr}"`);
  });

  test('sort=name returns tags in alphabetical order', async () => {
    const res = await handlers.list_tags({ vault: 'TestVault', sort: 'name' });
    assertOk(res, 'list_tags name sort');
    const lines = text(res).split('\n').map(l => l.split('\t')[0]);
    const sorted = [...lines].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(lines, sorted, 'list_tags name sort: tags are alphabetically ordered');
  });

  test('sort=count returns highest-count tags first', async () => {
    const res = await handlers.list_tags({ vault: 'TestVault', sort: 'count' });
    assertOk(res, 'list_tags count sort');
    const counts = text(res).split('\n').map(l => Number(l.split('\t')[1]));
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i - 1] >= counts[i], `list_tags count sort: ${counts[i-1]} >= ${counts[i]} at index ${i}`);
    }
  });

  test('inline tags are counted', async () => {
    const res = await handlers.list_tags({ vault: 'TestVault' });
    assertOk(res, 'list_tags inline');
    const body = text(res);
    // inline-tag appears in both Alpha and Beta
    assert.ok(body.includes('inline-tag'), `list_tags: inline-tag present, got:\n${body}`);
  });
});

// ---------------------------------------------------------------------------
// get_tag_info
// ---------------------------------------------------------------------------

describe('get_tag_info', () => {
  test('returns file list for a known tag', async () => {
    const res = await handlers.get_tag_info({ vault: 'TestVault', name: 'research' });
    assertOk(res, 'get_tag_info research');
    const body = text(res);
    assert.ok(body.includes('#research'), `get_tag_info: includes #research in output`);
    assert.ok(body.includes('Alpha.md'), `get_tag_info: Alpha.md in results`);
    assert.ok(body.includes('Beta.md'), `get_tag_info: Beta.md in results`);
  });

  test('accepts tag name with # prefix', async () => {
    const res = await handlers.get_tag_info({ vault: 'TestVault', name: '#project' });
    assertOk(res, 'get_tag_info #prefix');
    assert.ok(text(res).includes('Alpha.md'), `get_tag_info #prefix: Alpha.md in results`);
  });

  test('returns not-found message for unknown tag', async () => {
    const res = await handlers.get_tag_info({ vault: 'TestVault', name: 'nonexistent-xyz-tag' });
    assertOk(res, 'get_tag_info missing');
    assert.ok(
      text(res).includes('not found'),
      `get_tag_info: "not found" for missing tag, got "${text(res)}"`,
    );
  });

  test('count in output matches number of files listed', async () => {
    const res = await handlers.get_tag_info({ vault: 'TestVault', name: 'research' });
    assertOk(res, 'get_tag_info count');
    const body = text(res);
    // Format: "#research (N files):"
    const match = body.match(/\((\d+) files?\)/);
    assert.ok(match, `get_tag_info: count pattern present in "${body}"`);
    const count = Number(match[1]);
    const listedFiles = body.split('\n').slice(1).filter(l => l.trim().length > 0).length;
    assert.equal(count, listedFiles, `get_tag_info: reported count (${count}) matches listed files (${listedFiles})`);
  });
});

// ---------------------------------------------------------------------------
// list_properties
// ---------------------------------------------------------------------------

describe('list_properties', () => {
  test('returns property names with occurrence counts', async () => {
    const res = await handlers.list_properties({ vault: 'TestVault' });
    assertOk(res, 'list_properties');
    const body = text(res);
    assert.ok(body.includes('status'), `list_properties: "status" property present`);
    assert.ok(body.includes('type'), `list_properties: "type" property present`);
  });

  test('status count reflects files with that property', async () => {
    const res = await handlers.list_properties({ vault: 'TestVault' });
    assertOk(res, 'list_properties count');
    const lines = text(res).split('\n');
    const statusLine = lines.find(l => l.startsWith('status\t'));
    assert.ok(statusLine, `list_properties: status line found in:\n${text(res)}`);
    const count = Number(statusLine.split('\t')[1]);
    // Alpha, Beta, Gamma all have status — Plain does not
    assert.ok(count >= 3, `list_properties: status count >= 3, got ${count}`);
  });

  test('sort=count returns highest-count props first', async () => {
    const res = await handlers.list_properties({ vault: 'TestVault', sort: 'count' });
    assertOk(res, 'list_properties count sort');
    const counts = text(res).split('\n').map(l => Number(l.split('\t')[1]));
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i - 1] >= counts[i], `list_properties count sort: descending at index ${i}`);
    }
  });

  test('sort=name returns alphabetical order', async () => {
    const res = await handlers.list_properties({ vault: 'TestVault', sort: 'name' });
    assertOk(res, 'list_properties name sort');
    const names = text(res).split('\n').map(l => l.split('\t')[0]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted, 'list_properties name sort: alphabetical');
  });
});

// ---------------------------------------------------------------------------
// get_property_values
// ---------------------------------------------------------------------------

describe('get_property_values', () => {
  test('returns unique values for a property', async () => {
    const res = await handlers.get_property_values({ vault: 'TestVault', name: 'status' });
    assertOk(res, 'get_property_values status');
    const body = text(res);
    assert.ok(body.includes('active'), `get_property_values: "active" present`);
    assert.ok(body.includes('draft'), `get_property_values: "draft" present`);
  });

  test('count in header matches unique values listed', async () => {
    const res = await handlers.get_property_values({ vault: 'TestVault', name: 'type' });
    assertOk(res, 'get_property_values count');
    const body = text(res);
    const headerMatch = body.match(/\((\d+) unique\)/);
    assert.ok(headerMatch, `get_property_values: count in header found in "${body}"`);
    const reported = Number(headerMatch[1]);
    const listed = body.split('\n').slice(1).filter(l => l.trim().startsWith('-')).length;
    assert.equal(reported, listed, `get_property_values: reported (${reported}) matches listed (${listed})`);
  });

  test('returns no-values message for unknown property', async () => {
    const res = await handlers.get_property_values({ vault: 'TestVault', name: 'nonexistent_prop_xyz' });
    assertOk(res, 'get_property_values missing');
    assert.ok(
      text(res).includes('No values found'),
      `get_property_values missing: "${text(res)}"`,
    );
  });

  test('each value is listed on its own line with - prefix', async () => {
    const res = await handlers.get_property_values({ vault: 'TestVault', name: 'status' });
    assertOk(res, 'get_property_values format');
    const valueLines = text(res).split('\n').filter(l => l.trim().startsWith('-'));
    assert.ok(valueLines.length >= 2, `get_property_values: at least 2 value lines, got ${valueLines.length}`);
  });
});

// ---------------------------------------------------------------------------
// property_read
// ---------------------------------------------------------------------------

describe('property_read', () => {
  test('reads a known string property value', async () => {
    const res = await handlers.property_read({
      vault: 'TestVault',
      path: 'Notes/Alpha.md',
      name: 'status',
    });
    assertOk(res, 'property_read string');
    assert.equal(text(res), 'active', `property_read: expected "active", got "${text(res)}"`);
  });

  test('reads a known string property from another file', async () => {
    const res = await handlers.property_read({
      vault: 'TestVault',
      path: 'Notes/Beta.md',
      name: 'status',
    });
    assertOk(res, 'property_read beta');
    assert.equal(text(res), 'draft', `property_read: expected "draft", got "${text(res)}"`);
  });

  test('returns "(property not set)" for missing property', async () => {
    const res = await handlers.property_read({
      vault: 'TestVault',
      path: 'Notes/Alpha.md',
      name: 'nonexistent_prop',
    });
    assertOk(res, 'property_read missing');
    assert.equal(text(res), '(property not set)', `property_read missing: "${text(res)}"`);
  });

  test('resolves by file name (no .md extension)', async () => {
    const res = await handlers.property_read({
      vault: 'TestVault',
      file: 'Gamma',
      name: 'type',
    });
    assertOk(res, 'property_read by name');
    assert.equal(text(res), 'note', `property_read by name: expected "note", got "${text(res)}"`);
  });
});

// ---------------------------------------------------------------------------
// property_set
// ---------------------------------------------------------------------------

describe('property_set', () => {
  let propVaultDir;
  let propHandlers;

  before(() => {
    propVaultDir = createTempVault({
      'doc.md': [
        '---',
        'status: old',
        '---',
        '',
        'Body text.',
      ].join('\n'),
      'nofm.md': 'No frontmatter at all.',
    });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ PropVault: propVaultDir });
    const config = loadConfig();
    propHandlers = createAllHandlers(config);
  });

  after(() => {
    if (propVaultDir) cleanup(propVaultDir);
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
    const config = loadConfig();
    handlers = createAllHandlers(config);
  });

  test('sets an existing property to a new value', async () => {
    const res = await propHandlers.property_set({
      vault: 'PropVault',
      path: 'doc.md',
      name: 'status',
      value: 'updated',
    });
    assertOk(res, 'property_set update');
    assert.ok(text(res).includes('updated'), `property_set: success message has new value`);

    // Verify actual file content
    const readRes = await propHandlers.property_read({
      vault: 'PropVault',
      path: 'doc.md',
      name: 'status',
    });
    assert.equal(text(readRes), 'updated', `property_set: value persisted to disk`);
  });

  test('sets a new property without touching existing body text', async () => {
    await propHandlers.property_set({
      vault: 'PropVault',
      path: 'doc.md',
      name: 'priority',
      value: 'high',
    });

    const content = fs.readFileSync(path.join(propVaultDir, 'doc.md'), 'utf-8');
    assert.ok(content.includes('priority: high'), `property_set new: priority in frontmatter`);
    assert.ok(content.includes('Body text.'), `property_set new: body text preserved`);
  });

  test('does not duplicate existing frontmatter keys', async () => {
    await propHandlers.property_set({
      vault: 'PropVault',
      path: 'doc.md',
      name: 'status',
      value: 'final',
    });
    const content = fs.readFileSync(path.join(propVaultDir, 'doc.md'), 'utf-8');
    const statusMatches = (content.match(/^status:/gm) || []).length;
    assert.equal(statusMatches, 1, `property_set: "status" key appears exactly once, got ${statusMatches}`);
  });
});

// ---------------------------------------------------------------------------
// property_remove
// ---------------------------------------------------------------------------

describe('property_remove', () => {
  let rmVaultDir;
  let rmHandlers;

  before(() => {
    rmVaultDir = createTempVault({
      'doc.md': [
        '---',
        'status: active',
        'type: note',
        'keep: yes',
        '---',
        '',
        'Body here.',
      ].join('\n'),
    });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ RmVault: rmVaultDir });
    const config = loadConfig();
    rmHandlers = createAllHandlers(config);
  });

  after(() => {
    if (rmVaultDir) cleanup(rmVaultDir);
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
    const config = loadConfig();
    handlers = createAllHandlers(config);
  });

  test('removes a property from frontmatter', async () => {
    const res = await rmHandlers.property_remove({
      vault: 'RmVault',
      path: 'doc.md',
      name: 'status',
    });
    assertOk(res, 'property_remove');
    assert.ok(text(res).includes('removed'), `property_remove: success message says "removed"`);

    const content = fs.readFileSync(path.join(rmVaultDir, 'doc.md'), 'utf-8');
    assert.ok(!content.includes('status:'), `property_remove: "status" not in file anymore`);
  });

  test('leaves other properties intact after removal', async () => {
    const content = fs.readFileSync(path.join(rmVaultDir, 'doc.md'), 'utf-8');
    assert.ok(content.includes('type:'), `property_remove: "type" still present`);
    assert.ok(content.includes('keep:'), `property_remove: "keep" still present`);
    assert.ok(content.includes('Body here.'), `property_remove: body preserved`);
  });

  test('removing a non-existent property is idempotent (no error)', async () => {
    const res = await rmHandlers.property_remove({
      vault: 'RmVault',
      path: 'doc.md',
      name: 'no_such_prop_xyz',
    });
    assertOk(res, 'property_remove idempotent');
  });
});

// ---------------------------------------------------------------------------
// get_outline
// ---------------------------------------------------------------------------

describe('get_outline', () => {
  test('returns headings indented by level', async () => {
    const res = await handlers.get_outline({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'get_outline');
    const body = text(res);
    // H1 = no indent, H2 = 2 spaces, H3 = 4 spaces
    assert.ok(body.includes('Alpha Title'), `get_outline: H1 present`);
    assert.ok(body.includes('  Section One'), `get_outline: H2 has 2-space indent`);
    assert.ok(body.includes('    Subsection'), `get_outline: H3 has 4-space indent`);
  });

  test('headings appear in document order', async () => {
    const res = await handlers.get_outline({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'get_outline order');
    const body = text(res);
    const alphaTitleIdx = body.indexOf('Alpha Title');
    const sectionOneIdx = body.indexOf('Section One');
    const subsectionIdx = body.indexOf('Subsection');
    assert.ok(alphaTitleIdx < sectionOneIdx, 'get_outline: H1 before H2');
    assert.ok(sectionOneIdx < subsectionIdx, 'get_outline: H2 before H3');
  });

  test('returns "No headings found." for file without headings', async () => {
    // Create a temp vault with a headingless file
    const noHDir = createTempVault({ 'bare.md': 'Just some text.\n\nMore text.' });
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ NoHVault: noHDir });
    const cfg = loadConfig();
    const h = createAllHandlers(cfg);
    const res = await h.get_outline({ vault: 'NoHVault', path: 'bare.md' });
    assertOk(res, 'get_outline no headings');
    assert.ok(text(res).includes('No headings found'), `get_outline: no headings message, got "${text(res)}"`);
    cleanup(noHDir);
    // Restore
    process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
    handlers = createAllHandlers(loadConfig());
  });

  test('outline does not include task checkboxes or inline tags', async () => {
    const res = await handlers.get_outline({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'get_outline clean');
    const body = text(res);
    assert.ok(!body.includes('[ ]'), `get_outline: no task checkboxes in outline`);
    assert.ok(!body.includes('#inline-tag'), `get_outline: no inline tags in outline`);
  });
});

// ---------------------------------------------------------------------------
// word_count
// ---------------------------------------------------------------------------

describe('word_count', () => {
  test('returns words and characters on separate tab-separated lines', async () => {
    const res = await handlers.word_count({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'word_count format');
    const body = text(res);
    assert.ok(body.includes('words\t'), `word_count: "words\\t" label present`);
    assert.ok(body.includes('characters\t'), `word_count: "characters\\t" label present`);
  });

  test('word count is a positive integer', async () => {
    const res = await handlers.word_count({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'word_count positive');
    const lines = text(res).split('\n');
    const wordLine = lines.find(l => l.startsWith('words\t'));
    assert.ok(wordLine, 'word_count: words line found');
    const count = Number(wordLine.split('\t')[1]);
    assert.ok(Number.isInteger(count) && count > 0, `word_count: positive integer, got ${count}`);
  });

  test('character count >= word count', async () => {
    const res = await handlers.word_count({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'word_count chars >= words');
    const lines = text(res).split('\n');
    const words = Number(lines.find(l => l.startsWith('words\t')).split('\t')[1]);
    const chars = Number(lines.find(l => l.startsWith('characters\t')).split('\t')[1]);
    assert.ok(chars >= words, `word_count: chars (${chars}) >= words (${words})`);
  });

  test('frontmatter is excluded from count (count < raw file length)', async () => {
    const res = await handlers.word_count({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'word_count no fm');
    const body = text(res);
    const chars = Number(body.split('\n').find(l => l.startsWith('characters\t')).split('\t')[1]);
    const rawSize = fs.statSync(path.join(vaultDir, 'Notes/Alpha.md')).size;
    assert.ok(chars < rawSize, `word_count: chars (${chars}) < raw file size (${rawSize}) — frontmatter excluded`);
  });

  test('shorter note has fewer words than longer note', async () => {
    const longRes = await handlers.word_count({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    const shortRes = await handlers.word_count({ vault: 'TestVault', path: 'Gamma.md' });
    assertOk(longRes, 'word_count long');
    assertOk(shortRes, 'word_count short');
    const longWords = Number(text(longRes).split('\n').find(l => l.startsWith('words\t')).split('\t')[1]);
    const shortWords = Number(text(shortRes).split('\n').find(l => l.startsWith('words\t')).split('\t')[1]);
    assert.ok(longWords > shortWords, `word_count: Alpha (${longWords}) > Gamma (${shortWords})`);
  });
});

// ---------------------------------------------------------------------------
// list_aliases
// ---------------------------------------------------------------------------

describe('list_aliases', () => {
  test('returns aliases for a specific file by path', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', path: 'Notes/Alpha.md' });
    assertOk(res, 'list_aliases path');
    const body = text(res);
    assert.ok(body.includes('Alpha Alias'), `list_aliases path: "Alpha Alias" present`);
    assert.ok(body.includes('First Note'), `list_aliases path: "First Note" present`);
  });

  test('returns single alias for Beta', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', path: 'Notes/Beta.md' });
    assertOk(res, 'list_aliases beta');
    assert.ok(text(res).includes('Beta Alias'), `list_aliases beta: "Beta Alias" present`);
  });

  test('returns "No aliases found." for file without aliases', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', path: 'Gamma.md' });
    assertOk(res, 'list_aliases none');
    assert.ok(
      text(res).includes('No aliases found'),
      `list_aliases none: expected "No aliases found", got "${text(res)}"`,
    );
  });

  test('vault-wide list includes aliases from all files', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault' });
    assertOk(res, 'list_aliases vault-wide');
    const body = text(res);
    assert.ok(body.includes('Alpha Alias'), `list_aliases vault-wide: Alpha Alias present`);
    assert.ok(body.includes('Beta Alias'), `list_aliases vault-wide: Beta Alias present`);
    assert.ok(body.includes('First Note'), `list_aliases vault-wide: First Note present`);
  });

  test('verbose mode includes file paths in output', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', verbose: true });
    assertOk(res, 'list_aliases verbose');
    const body = text(res);
    // Each line should be "alias\tfile-path"
    const lines = body.split('\n').filter(l => l.includes('\t'));
    assert.ok(lines.length > 0, `list_aliases verbose: tab-separated lines present`);
    for (const line of lines) {
      const [alias, filePath] = line.split('\t');
      assert.ok(alias.length > 0, `list_aliases verbose: alias is non-empty`);
      assert.ok(filePath.endsWith('.md'), `list_aliases verbose: file path ends in .md — got "${filePath}"`);
    }
  });

  test('resolves by file name with path prefix (no .md extension)', async () => {
    // resolveFile appends .md — so "Notes/Alpha" → "Notes/Alpha.md"
    const res = await handlers.list_aliases({ vault: 'TestVault', file: 'Notes/Alpha' });
    assertOk(res, 'list_aliases by name');
    assert.ok(text(res).includes('Alpha Alias'), `list_aliases by name: "Alpha Alias" present`);
  });

  test('resolves bare basename to note in subfolder (Bug-4 fix: vault-wide lookup)', async () => {
    // Alpha.md lives at Notes/Alpha.md — bare "Alpha" should still resolve via vault-wide search
    // Previously resolveFile would look for root-level "Alpha.md" (ENOENT), never finding Notes/Alpha.md
    const res = await handlers.list_aliases({ vault: 'TestVault', file: 'Alpha' });
    assertOk(res, 'list_aliases bare basename');
    assert.ok(
      text(res).includes('Alpha Alias'),
      `list_aliases bare basename: "Alpha Alias" should be found — got "${text(res)}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Not-found hints for expected-existing notes (fs-promoted resolver parity)
//
// A file-param tool given a typo'd / missing note must surface a STRUCTURED
// not-found error (closest_matches + "did you mean" hint) — matching what
// read_file / follow_link / resolve_wikilink already return — and must NEVER
// leak an absolute filesystem path.
// ---------------------------------------------------------------------------

describe('not-found hints (file-param tools)', () => {
  // Helper: assert no absolute path leaked in the response text.
  function assertNoAbsPath(res, label) {
    const t = text(res);
    assert.ok(
      !t.includes('/Users/') && !t.includes(vaultDir),
      `${label}: response must not leak an absolute path — got "${t}"`,
    );
  }

  test('list_aliases with 1-char-typo file returns closest_matches + hint (no abs path)', async () => {
    // "Alpha" exists at Notes/Alpha.md; "Alpla" is a 1-char typo near-miss.
    const res = await handlers.list_aliases({ vault: 'TestVault', file: 'Alpla' });
    assertErr(res, 'list_aliases typo');
    const data = JSON.parse(text(res));
    assert.ok(typeof data.error === 'string', 'error field is a string');
    assert.ok(Array.isArray(data.closest_matches), 'closest_matches is an array');
    assert.ok(
      data.closest_matches.includes('Alpha'),
      `expected "Alpha" in closest_matches, got: ${JSON.stringify(data.closest_matches)}`,
    );
    assert.ok(typeof data.hint === 'string' && data.hint.length > 0, 'hint is non-empty');
    // The structured error must NOT carry an absolute filesystem path.
    assert.ok(!data.error.includes('/Users/'), `error must not contain "/Users/", got "${data.error}"`);
    assert.ok(!data.error.includes(vaultDir), `error must not contain vault root, got "${data.error}"`);
    assertNoAbsPath(res, 'list_aliases typo');
  });

  test('"did you mean" prose appears in the note hint when closest_matches is non-empty', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', file: 'Alpla' });
    assertErr(res, 'list_aliases did-you-mean');
    const data = JSON.parse(text(res));
    assert.ok(data.closest_matches.length > 0, 'precondition: closest_matches non-empty');
    assert.ok(
      data.hint.includes('Did you mean:'),
      `expected "Did you mean:" in hint, got "${data.hint}"`,
    );
    assert.ok(
      data.hint.includes('Alpha'),
      `expected nearest match "Alpha" named in hint, got "${data.hint}"`,
    );
  });

  test('explicit path that does not exist also returns structured hint (no abs path)', async () => {
    const res = await handlers.list_aliases({ vault: 'TestVault', path: 'Notes/Nope.md' });
    assertErr(res, 'list_aliases bad path');
    const data = JSON.parse(text(res));
    assert.ok(Array.isArray(data.closest_matches), 'closest_matches is an array');
    assertNoAbsPath(res, 'list_aliases bad path');
  });

  test('get_outline / word_count / get_file_info on missing note also hint (no abs path)', async () => {
    for (const tool of ['get_outline', 'word_count', 'get_file_info']) {
      const res = await handlers[tool]({ vault: 'TestVault', file: 'Alpla' });
      assertErr(res, `${tool} typo`);
      const data = JSON.parse(text(res));
      assert.ok(Array.isArray(data.closest_matches), `${tool}: closest_matches is an array`);
      assertNoAbsPath(res, `${tool} typo`);
    }
  });

  test('daily_read on a fresh vault returns graceful "does not exist", never a not-found hint', async () => {
    // Daily notes use their own ENOENT tolerance, not resolveFile — must stay graceful.
    // Use an isolated vault so prior daily_append/daily_prepend tests can't have
    // created the note in the shared vault.
    const freshDir = createTempVault({ 'Seed.md': '# Seed' });
    try {
      process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir, Fresh: freshDir });
      const freshHandlers = createAllHandlers(loadConfig());
      const res = await freshHandlers.daily_read({ vault: 'Fresh' });
      assert.equal(res.isError, false, 'daily_read missing must not be an error');
      assert.ok(
        text(res).includes('does not exist') || text(res).includes('empty'),
        `daily_read: expected graceful sentinel, got "${text(res)}"`,
      );
      // It must NOT be a structured not-found hint.
      assert.ok(!text(res).includes('closest_matches'), 'daily_read must not emit closest_matches');
      assert.ok(!text(res).includes('Did you mean'), 'daily_read must not emit a "did you mean" hint');
    } finally {
      process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
      cleanup(freshDir);
    }
  });

  test('file_append tolerates a not-yet-existing target (create-capable, no hint error)', async () => {
    // file_append uses fs.appendFile which creates the file — must not throw a not-found hint.
    const res = await handlers.file_append({
      vault: 'TestVault',
      file: 'BrandNewAppendTarget',
      content: 'hello from append',
    });
    assertOk(res, 'file_append create');
    assert.equal(res.isError, false, 'file_append to new file must succeed');
    // Verify the file was actually created with the content.
    const created = fs.readFileSync(path.join(vaultDir, 'BrandNewAppendTarget.md'), 'utf-8');
    assert.ok(created.includes('hello from append'), 'append created file with content');
  });

  test('file_append to a path with a missing parent folder errors WITHOUT leaking an abs path (P3a)', async () => {
    // A missing INTERMEDIATE parent folder makes fs.appendFile throw a Node
    // ENOENT whose raw message embeds the user's absolute filesystem path.
    // The handler must NOT auto-create the folder (no behavior change) and must
    // sanitize the error to the vault-relative path only — never "/Users/" or
    // the vault root dir.
    const res = await handlers.file_append({
      vault: 'TestVault',
      path: 'NoSuchFolder/DeepNote.md',
      content: 'this should not be written',
    });
    // Must be a real error (ENOENT actually triggered), not a vacuous pass.
    assertErr(res, 'file_append missing parent');
    // No absolute path may appear in the error text.
    assertNoAbsPath(res, 'file_append missing parent');
    // The vault-relative path should be named so the caller knows what failed.
    assert.ok(
      text(res).includes('NoSuchFolder/DeepNote.md'),
      `file_append missing parent: should name the vault-relative path, got "${text(res)}"`,
    );
    // No behavior change: the handler must NOT have auto-created the folder/file.
    assert.ok(
      !fs.existsSync(path.join(vaultDir, 'NoSuchFolder')),
      'file_append must not auto-create the missing parent folder',
    );
  });

  // ── update_task parity (was bypassing resolveFile: leaked abs path + no Bug-4 lookup) ──

  test('update_task with 1-char-typo file returns closest_matches + hint (no abs path)', async () => {
    // "Alpha" exists at Notes/Alpha.md; "Alpla" is a 1-char typo near-miss.
    // update_task previously did naive args.file+'.md' at the vault root and
    // leaked the raw ENOENT absolute path in its catch.
    const res = await handlers.update_task({
      vault: 'TestVault',
      file: 'Alpla',
      line: 1,
      action: 'done',
    });
    assertErr(res, 'update_task typo');
    const data = JSON.parse(text(res));
    assert.ok(typeof data.error === 'string', 'error field is a string');
    assert.ok(Array.isArray(data.closest_matches), 'closest_matches is an array');
    assert.ok(
      data.closest_matches.includes('Alpha'),
      `expected "Alpha" in closest_matches, got: ${JSON.stringify(data.closest_matches)}`,
    );
    assert.ok(data.hint.includes('Did you mean:'), `expected "Did you mean:" in hint, got "${data.hint}"`);
    // The structured error must NOT carry an absolute filesystem path.
    assert.ok(!data.error.includes('/Users/'), `error must not contain "/Users/", got "${data.error}"`);
    assert.ok(!data.error.includes(vaultDir), `error must not contain vault root, got "${data.error}"`);
    assertNoAbsPath(res, 'update_task typo');
  });

  test('update_task resolves a bare basename in a subfolder (Bug-4 parity) and updates it', async () => {
    // Isolated vault so we can write without disturbing the shared fixture.
    // The note lives in a subfolder; update_task must find it by bare basename.
    const subDir = createTempVault({
      'Folder/Sub/Alpha.md': ['# Alpha', '', '- [ ] sub task'].join('\n'),
    });
    try {
      process.env.OBSIDIAN_VAULTS = JSON.stringify({ Sub: subDir });
      const subHandlers = createAllHandlers(loadConfig());
      const res = await subHandlers.update_task({
        vault: 'Sub',
        file: 'Alpha', // bare basename; note is 2 folders deep
        line: 3,
        action: 'done',
      });
      assertOk(res, 'update_task bare basename');
      assert.equal(res.isError, false, 'update_task bare basename must resolve via vault-wide index');
      const updated = fs.readFileSync(path.join(subDir, 'Folder/Sub/Alpha.md'), 'utf-8');
      assert.ok(
        updated.split('\n')[2].includes('[x]'),
        `Bug-4 parity: subfolder note's task should be marked done, got "${updated.split('\n')[2]}"`,
      );
    } finally {
      process.env.OBSIDIAN_VAULTS = JSON.stringify({ TestVault: vaultDir });
      cleanup(subDir);
    }
  });
});
