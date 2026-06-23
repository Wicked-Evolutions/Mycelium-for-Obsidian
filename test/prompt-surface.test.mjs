/**
 * #14: MCP prompts (slash commands) surface + builder contract tests.
 *
 * Verifies that:
 *  - allPrompts is exactly the 5 ratified prompts (regenerate-on-change snapshot)
 *  - getPromptMessages interpolates the vault clause/arg in BOTH branches
 *  - required-argument enforcement throws (search without query)
 *  - unknown prompt name throws
 *  - PURE-ADDITION: none of the prompt names collide with a tool name
 *  - honesty guards: /search has no 'bridge'/'betweenness'; /excluded has '1000'
 *
 * Imports from dist/ (side-effect-free modules — no dotenv/watcher/server).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { allPrompts, getPromptMessages } = await import('../dist/prompts/index.js');
const { allTools } = await import('../dist/tools/index.js');

// ---------------------------------------------------------------------------
// Surface snapshot — contract baseline for {name, description, arguments}.
// Regenerate by running:
//   node --input-type=module -e "import {allPrompts} from './dist/prompts/index.js';
//     console.log(JSON.stringify(allPrompts.map(p=>({name:p.name,description:p.description,arguments:p.arguments})),null,2));"
// DO NOT edit manually; bump when dist/ changes.
// ---------------------------------------------------------------------------
const VAULT_ARG = {
  name: 'vault',
  description: 'Vault name. Defaults to the configured default vault if omitted.',
  required: false,
};

const PROMPT_SNAPSHOT = [
  {
    name: 'orient',
    description:
      'Orient in a vault: combine get_started + analyze_link_hierarchy into a plain-language map (shape, central hubs, what is excluded, where to begin).',
    arguments: [VAULT_ARG],
  },
  {
    name: 'search',
    description:
      "Semantic-search a vault and explain each hit's structural role (HUB / MID / PERIPHERAL / EXCLUDED) using the additive graph signals, preserving the tool's relevance ordering.",
    arguments: [
      { name: 'query', description: 'What to search for.', required: true },
      VAULT_ARG,
    ],
  },
  {
    name: 'excluded',
    description:
      'Show what is currently PRUNED from the orientation graph (mycelium_exclude or node_type in [generated, archive, index, log]), recovered via two query_notes calls and merged by reason.',
    arguments: [VAULT_ARG],
  },
  {
    name: 'vault-health',
    description:
      'Run get_vault_health and summarize orphans, broken links, stale notes, and file stats in plain language with concrete cleanup actions.',
    arguments: [VAULT_ARG],
  },
  {
    name: 'get-started',
    description:
      'Call get_started and return the orientation guide for this Obsidian MCP (vault names, tool count + categories, key workflow guidance).',
    arguments: [],
  },
];

test('allPrompts surface snapshot matches the 5 ratified prompts', () => {
  const actual = allPrompts.map(p => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  }));

  assert.equal(
    actual.length,
    PROMPT_SNAPSHOT.length,
    `prompt snapshot length mismatch: expected ${PROMPT_SNAPSHOT.length}, got ${actual.length}`
  );

  for (let i = 0; i < PROMPT_SNAPSHOT.length; i++) {
    assert.deepEqual(
      actual[i],
      PROMPT_SNAPSHOT[i],
      `prompt snapshot mismatch at index ${i} (prompt "${PROMPT_SNAPSHOT[i].name}")`
    );
  }
});

test('every prompt entry has the required MCP Prompt shape', () => {
  for (const p of allPrompts) {
    assert.equal(typeof p.name, 'string', 'prompt name must be a string');
    assert.ok(p.name.length > 0, 'prompt name must be non-empty');
    assert.equal(typeof p.description, 'string', `${p.name}: description must be a string`);
    assert.ok(Array.isArray(p.arguments), `${p.name}: arguments must be an array`);
    for (const arg of p.arguments) {
      assert.equal(typeof arg.name, 'string', `${p.name}: argument name must be a string`);
      assert.equal(typeof arg.required, 'boolean', `${p.name}: argument.required must be boolean`);
    }
  }
});

// ---------------------------------------------------------------------------
// getPromptMessages — message builder behavior
// ---------------------------------------------------------------------------

function textOf(result) {
  assert.ok(Array.isArray(result.messages), 'messages must be an array');
  assert.equal(result.messages.length, 1, 'expect exactly one primed message');
  const msg = result.messages[0];
  assert.equal(msg.role, 'user', 'primed message role must be "user"');
  assert.equal(msg.content.type, 'text', 'message content type must be "text"');
  assert.equal(typeof msg.content.text, 'string', 'message content text must be a string');
  return msg.content.text;
}

test('orient interpolates the named-vault clause and arg (vault given)', () => {
  const result = getPromptMessages('orient', { vault: 'Foo' });
  assert.equal(
    result.description,
    allPrompts.find(p => p.name === 'orient').description,
    'GetPrompt description must match the ListPrompts description'
  );
  const text = textOf(result);
  assert.ok(text.includes('the "Foo" vault'), 'must name the vault in the clause');
  assert.ok(text.includes('`analyze_link_hierarchy` with vault "Foo"'), 'must inject the vault arg');
  // No default-vault wording when a vault is given.
  assert.ok(!text.includes('default configured vault'), 'no default-vault wording when vault given');
});

test('orient emits default-vault wording with NO dangling vault arg (vault omitted)', () => {
  const text = textOf(getPromptMessages('orient', {}));
  assert.ok(
    text.includes('this vault (the default configured vault)'),
    'must use the default-vault clause'
  );
  // No leftover placeholder token and no empty `with vault ""`.
  assert.ok(!text.includes('{VAULT_ARG}'), 'no unresolved {VAULT_ARG} placeholder');
  assert.ok(!text.includes('{VAULT_CLAUSE}'), 'no unresolved {VAULT_CLAUSE} placeholder');
  assert.ok(!text.includes('with vault ""'), 'no dangling empty vault arg');
  // The tool call should be flush against the period (no trailing vault arg).
  assert.ok(
    text.includes('then call `analyze_link_hierarchy`.'),
    'analyze_link_hierarchy call must end cleanly with no vault arg'
  );
});

test('search interpolates the query (query given)', () => {
  const text = textOf(getPromptMessages('search', { query: 'marketing strategy' }));
  assert.ok(text.includes('for: "marketing strategy"'), 'must echo the query in the prompt');
  assert.ok(
    text.includes('with query "marketing strategy"'),
    'must pass the query to semantic_search'
  );
});

test('search interpolates query AND vault together', () => {
  const text = textOf(getPromptMessages('search', { query: 'x', vault: 'Bar' }));
  assert.ok(text.includes('the "Bar" vault'), 'must name the vault');
  assert.ok(text.includes('with query "x" with vault "Bar"'), 'must inject query then vault arg');
});

test('search THROWS when required query is missing', () => {
  assert.throws(
    () => getPromptMessages('search', {}),
    /Missing required argument "query"/,
    'must throw on missing required query'
  );
  // Also throws for an empty-string query (treated as absent).
  assert.throws(() => getPromptMessages('search', { query: '' }), /Missing required argument "query"/);
});

test('get-started returns a message with no interpolation', () => {
  const text = textOf(getPromptMessages('get-started', {}));
  assert.ok(text.includes('get_started'), 'must reference the get_started tool');
  // No vault placeholders at all (get-started takes no args).
  assert.ok(!text.includes('{VAULT'), 'no unresolved placeholders');
  assert.ok(!text.includes('with vault'), 'get-started must not inject a vault arg');
});

test('unknown prompt name THROWS', () => {
  assert.throws(() => getPromptMessages('unknown'), /Unknown prompt/);
  assert.throws(() => getPromptMessages('hubs', { vault: 'X' }), /Unknown prompt/);
});

// ---------------------------------------------------------------------------
// PURE-ADDITION guards
// ---------------------------------------------------------------------------

test('PURE-ADDITION: no prompt name collides with a tool name', () => {
  const toolNames = new Set(allTools.map(t => t.name));
  for (const p of allPrompts) {
    assert.equal(
      toolNames.has(p.name),
      false,
      `prompt name "${p.name}" must NOT shadow a tool name (prompts are additive)`
    );
  }
  // Spot-check the hyphen-vs-underscore boundary: prompt 'get-started' must not
  // be confused with the tool 'get_started'.
  assert.ok(allPrompts.some(p => p.name === 'get-started'), "prompt 'get-started' must exist");
  assert.ok(toolNames.has('get_started'), "tool 'get_started' must still exist");
  assert.equal(toolNames.has('get-started'), false, "'get-started' must not be a tool name");
});

// ---------------------------------------------------------------------------
// Honesty guards — the primed wording must not over-claim graph semantics
// ---------------------------------------------------------------------------

test("honesty: /search has PERIPHERAL and no 'bridge'/'betweenness'", () => {
  const text = textOf(getPromptMessages('search', { query: 'x' }));
  assert.ok(text.includes('PERIPHERAL'), "search must use the PERIPHERAL label");
  assert.ok(text.includes('HUB'), "search must use the HUB label");
  assert.ok(text.includes('MID'), "search must use the MID label");
  assert.ok(text.includes('EXCLUDED'), "search must use the EXCLUDED label");
  assert.ok(!text.includes('bridge'), "search must NOT invent a 'bridge' role");
  assert.ok(!text.includes('betweenness'), "search must NOT reference 'betweenness' (not computed in v1)");
});

test("honesty: /excluded uses the high limit (1000)", () => {
  const text = textOf(getPromptMessages('excluded', {}));
  assert.ok(text.includes('1000'), "excluded must use the high limit (1000) to avoid under-reporting");
  // Grounding: the OR-recovery rationale must be present.
  assert.ok(text.includes('query_notes'), 'excluded must drive query_notes');
  assert.ok(text.includes('node_type'), 'excluded must mention the node_type rule');
});
