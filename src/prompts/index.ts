/**
 * MCP prompts (slash commands) for Obsidian MCP
 *
 * Side-effect-free module (mirrors the allTools / createAllHandlers split) so
 * tests can import it from dist/ without index.ts's dotenv / watcher /
 * server.connect side effects.
 *
 * A prompt RETURNS user-role messages that PRIME the AI to drive the existing
 * read-only tools. A prompt NEVER executes a tool itself — it just produces the
 * instruction text the model then acts on.
 *
 * #14: pure-additive `prompts` capability. Five read-only slash commands:
 *   orient, search, excluded, vault-health, get-started.
 */

import { Prompt, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Static prompt definitions (the ListPrompts surface)
// ---------------------------------------------------------------------------

export const allPrompts: Prompt[] = [
  {
    name: 'orient',
    description:
      'Orient in a vault: combine get_started + analyze_link_hierarchy into a plain-language map (shape, central hubs, what is excluded, where to begin).',
    arguments: [
      { name: 'vault', description: 'Vault name. Defaults to the configured default vault if omitted.', required: false },
    ],
  },
  {
    name: 'search',
    description:
      'Semantic-search a vault and explain each hit\'s structural role (HUB / MID / PERIPHERAL / EXCLUDED) using the additive graph signals, preserving the tool\'s relevance ordering.',
    arguments: [
      { name: 'query', description: 'What to search for.', required: true },
      { name: 'vault', description: 'Vault name. Defaults to the configured default vault if omitted.', required: false },
    ],
  },
  {
    name: 'excluded',
    description:
      'Show what is currently PRUNED from the orientation graph (mycelium_exclude or node_type in [generated, archive, index, log]), recovered via two query_notes calls and merged by reason.',
    arguments: [
      { name: 'vault', description: 'Vault name. Defaults to the configured default vault if omitted.', required: false },
    ],
  },
  {
    name: 'vault-health',
    description:
      'Run get_vault_health and summarize orphans, broken links, stale notes, and file stats in plain language with concrete cleanup actions.',
    arguments: [
      { name: 'vault', description: 'Vault name. Defaults to the configured default vault if omitted.', required: false },
    ],
  },
  {
    name: 'get-started',
    description:
      'Call get_started and return the orientation guide for this Obsidian MCP (vault names, tool count + categories, key workflow guidance).',
    arguments: [],
  },
];

// ---------------------------------------------------------------------------
// GetPrompt — pure message builder
// ---------------------------------------------------------------------------

/**
 * Build the primed user message(s) for a prompt.
 *
 * PURE: no I/O, no tool calls. Throws on an unknown name and on a missing
 * required argument (search.query). The return type is the SDK's
 * `GetPromptResult` so it drops straight into the GetPrompt handler.
 */
export function getPromptMessages(
  name: string,
  args: Record<string, unknown> = {}
): GetPromptResult {
  const def = allPrompts.find(p => p.name === name);
  if (!def) {
    throw new Error(`Unknown prompt: ${name}`);
  }

  // Required-argument enforcement (driven by the static definition).
  for (const arg of def.arguments ?? []) {
    if (arg.required) {
      const v = args[arg.name];
      if (v === undefined || v === null || v === '') {
        throw new Error(`Missing required argument "${arg.name}" for prompt "${name}"`);
      }
    }
  }

  // Interpolation helpers — computed once per call.
  const vault = typeof args.vault === 'string' && args.vault ? args.vault : undefined;
  const VAULT_CLAUSE = vault ? `the "${vault}" vault` : 'this vault (the default configured vault)';
  const VAULT_ARG = vault ? ` with vault "${vault}"` : '';

  let text: string;

  switch (name) {
    case 'orient':
      text =
        `Orient me in ${VAULT_CLAUSE}. First call the \`get_started\` tool, then call \`analyze_link_hierarchy\`${VAULT_ARG}. ` +
        `Using both results, give me a plain-language orientation: (1) the SHAPE of the vault (total notes, the level histogram L0→L5, ` +
        `which provider built the graph — obsidian or filesystem); (2) the CENTRAL notes — list the top hubs (L0–L1 nodes, highest PageRank) by name; ` +
        `(3) what was EXCLUDED from ranking and why (the excludedNodes count and the active exclusion rule); ` +
        `(4) WHERE TO BEGIN — 2–4 concrete starting notes or entry points based on the hubs. ` +
        `Keep it opinionated and oriented toward action, not a raw data dump. Remember: levels are structural orientation, not importance.`;
      break;

    case 'search': {
      const query = String(args.query);
      text =
        `Search ${VAULT_CLAUSE} for: "${query}". Call the \`semantic_search\` tool with query "${query}"${VAULT_ARG}. ` +
        `Present the results in the order the tool returns them — that IS the relevance/fusion ranking (reranked only when reranking is explicitly enabled). ` +
        `Do NOT silently reorder hits by centrality. Each hit carries an additive \`graph\` block with raw structural signals ` +
        `{ level (L0–L5, or null if pruned), pagerank, inDegree, outDegree, inOutRatio, archived, excluded }. ` +
        `Use that block to EXPLAIN each hit's structural ROLE next to it, using ONLY these honest labels: HUB = level L0–L1; MID = L2–L3; ` +
        `PERIPHERAL = level L4–L5; EXCLUDED = the \`graph\` block is PRESENT and its \`excluded\` is true (its level and pagerank will be null). ` +
        `A null \`graph\` block is NOT the same as excluded — it means this hit did not join to graph signals, so its structural role is UNAVAILABLE; say so for that hit and do NOT label it excluded. ` +
        `Do NOT invent any additional role beyond these four — there is no centrality/intermediary metric computed in v1, ` +
        `so never infer one from inOutRatio or degree. ` +
        `After the ranked list you MAY add a short 'central hits to notice' line pointing at which results are hubs worth opening first. ` +
        `If \`graphAvailable\` is false, say search ran without graph orientation and just give the plain ranked hits.`;
      break;
    }

    case 'excluded':
      text =
        `Show me what is currently PRUNED from the graph in ${VAULT_CLAUSE} — the notes the orientation map ignores. ` +
        `The exclusion model is: a note is excluded when \`mycelium_exclude: true\` OR its \`node_type\` is one of [generated, archive, index, log]. ` +
        `Because \`query_notes\` filters are AND-only, recover this OR with TWO calls and merge: ` +
        `call \`query_notes\`${VAULT_ARG} filtering mycelium_exclude == true with a high limit (1000), ` +
        `then call \`query_notes\`${VAULT_ARG} filtering node_type in [generated, archive, index, log] with a high limit (1000). ` +
        `(query_notes returns only 20 by default — the high limit prevents silently under-reporting larger vaults.) ` +
        `Present the merged, de-duplicated list grouped by reason (which rule pruned each), so I can SEE the pruning model and decide whether each ` +
        `exclusion is correct — this is the human side of the rank → tag → re-rank loop. ` +
        `(Note: analyze_link_hierarchy reports only an excluded COUNT, not the paths, which is why we use query_notes here.)`;
      break;

    case 'vault-health':
      text =
        `Run a health check on ${VAULT_CLAUSE}. Call the \`get_vault_health\` tool${VAULT_ARG}. ` +
        `Summarize the report in plain language: orphan notes (zero inbound links), broken links (wikilinks to non-existent notes), ` +
        `stale notes (default threshold 90 days), and overall file stats. ` +
        `Lead with anything that needs attention and suggest concrete cleanup actions where useful.`;
      break;

    case 'get-started':
      text =
        `Call the \`get_started\` tool and give me the orientation guide for this Obsidian MCP: the configured vault name(s), ` +
        `the total tool count and tool categories, and the key workflow guidance (resolver-first, wikilink syntax, CLI vs filesystem tiers). ` +
        `This is the 'remind me what this MCP can do' command.`;
      break;

    default:
      // Unreachable — the name was validated against allPrompts above.
      throw new Error(`Unknown prompt: ${name}`);
  }

  return {
    description: def.description ?? '',
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
