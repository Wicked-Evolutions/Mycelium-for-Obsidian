# mcp-obsidian

Multi-vault Obsidian MCP server — full AI operations toolset for file management, wikilinks, semantic search, frontmatter queries, daily notes, tasks, properties, templates, and more.

Capability surface: 75 filesystem-tier tools require only Node.js, 1 explicit app-contact tool (`open_vault`) may open/contact local Obsidian, and 28 CLI-only tools access Obsidian's runtime API when the app is running with [CLI enabled](https://obsidian.md/help/cli) (Obsidian 1.12+ with installer 1.12.7+).

In 1.5.0: **validated cross-vault declarations** from native Obsidian links; **truthful index coverage and broken-link occurrence metrics**; **exact-versus-approximate graph provider provenance and recovery**; refreshed production dependencies and transport validation; and a strict real Obsidian/Ollama release-evidence lane. See [CHANGELOG](CHANGELOG.md).

On current `main` (unreleased): exact vault orientation uses an explicit consent flow. `analyze_link_hierarchy` never opens Obsidian or silently approximates; `open_vault` is the separate, explicit app-contact step that opens one configured vault if needed and prepares a session-only exact graph snapshot.

**Runtime:** npm and source installs require Node.js 20 or newer.

## Install

### Claude Desktop — one click

Download the [v1.4.0 mcp-obsidian.mcpb](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/releases/download/v1.4.0/mcp-obsidian.mcpb), double-click, enter your vault paths. Done.

> The MCPB channel remains on v1.4.0 and does not include the 1.5.0 npm/server changes. MCPB work is deferred to a separate release track.
>
> The one-click bundle is built and tested on **macOS (Apple Silicon)** only — it ships a prebuilt native module for that platform. On Intel Mac, Windows, or Linux, install via **npm** below instead. The npm server and semantic-index-independent tools remain cross-platform; the hardened derived semantic index described below currently requires macOS or Linux. (A cross-platform bundle is tracked for a later release.)

### npm

```bash
npm install -g @wickedevolutions/mcp-obsidian
```

Or run directly without installing:

```bash
npx @wickedevolutions/mcp-obsidian
```

### From source

```bash
git clone https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian.git
cd Mycelium-for-Obsidian
npm install
npm run build
```

## Setup

Works with Claude Code, Claude Desktop, Gemini CLI, Cursor, Windsurf, VS Code, and any MCP-compatible client.

All clients use the same server config — the only difference is where the config file lives.

### Claude Code — quick add

```bash
claude mcp add -e OBSIDIAN_VAULTS='{"My Vault":"/path/to/vault"}' obsidian -- npx @wickedevolutions/mcp-obsidian
```

### Server Config Block

**If you installed via npm** (`npm install -g @wickedevolutions/mcp-obsidian`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "mcp-obsidian",
      "args": [],
      "env": {
        "OBSIDIAN_VAULTS": "{\"My Vault\":\"/path/to/your/vault\"}"
      }
    }
  }
}
```

**If you cloned and built from source:**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/mcp-obsidian/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULTS": "{\"My Vault\":\"/path/to/your/vault\"}"
      }
    }
  }
}
```

### Where to Put the Config

| Client | Config file |
|--------|-------------|
| **Claude Code** | `.mcp.json` in your project root, or `~/.mcp.json` for global access |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **Gemini CLI** | `~/.gemini/settings.json` (add the server block inside the existing `mcpServers` object) |
| **Cursor** | `.cursor/mcp.json` in project root |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **VS Code (Copilot)** | `.vscode/mcp.json` in project root |

Any AI client or IDE that supports the Model Context Protocol can use mcp-obsidian — add the server config block to your client's MCP configuration.

### Multiple Vaults — One Server, All Vaults

A single mcp-obsidian server handles all your vaults. Pass them as a JSON object in `OBSIDIAN_VAULTS` — most tools accept an optional `vault` parameter to target a specific vault (authoritative graph orientation via `analyze_link_hierarchy` requires an explicit one):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["@wickedevolutions/mcp-obsidian"],
      "env": {
        "OBSIDIAN_VAULTS": "{\"Work\":\"/Users/me/Vaults/Work\",\"Personal\":\"/Users/me/Vaults/Personal\",\"Research\":\"/Users/me/Vaults/Research\",\"Client Projects\":\"/Users/me/Vaults/Client Projects\"}"
      }
    }
  }
}
```

Then use the `vault` parameter on any tool call to target a specific vault:

```json
{ "tool": "read_file", "args": { "vault": "Work", "path": "my-note.md" } }
```

```json
{ "tool": "search_all_vaults", "args": { "query": "project deadline" } }
```

Omitting `vault` defaults to the first vault in the list. Cross-vault tools like `search_all_vaults`, `find_note_by_name`, and `get_cross_vault_links` operate across all configured vaults in a single call.

### Single Vault

For a single vault, you can use the simpler environment variables instead of `OBSIDIAN_VAULTS`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["@wickedevolutions/mcp-obsidian"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/me/Vaults/My Vault",
        "OBSIDIAN_VAULT_NAME": "My Vault"
      }
    }
  }
}
```

### Disabling Tools

To prevent specific tools from being exposed to MCP clients, set `OBSIDIAN_DISABLED_TOOLS` in the env block:

```json
{
  "env": {
    "OBSIDIAN_DISABLED_TOOLS": "search_replace_in_file,eval_obsidian"
  }
}
```

Comma-separated list. Disabled tools are removed from both the tool list and handler registry at startup.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OBSIDIAN_VAULTS` | JSON object: `{"name":"path",...}` for multi-vault | - |
| `OBSIDIAN_VAULT_PATH` | Path to single vault (alternative to `OBSIDIAN_VAULTS`) | - |
| `OBSIDIAN_VAULT_NAME` | Display name for single vault | - |
| `OBSIDIAN_DISABLED_TOOLS` | Comma-separated list of tools to disable | - |
| `OBSIDIAN_READ_ONLY` | Refuse note/content and Obsidian app-state mutations; derived semantic-index writes remain allowed | `false` |
| `OBSIDIAN_WRAP_UNTRUSTED` | Wrap file content in untrusted-content markers when set to `true` | `false` |
| `OBSIDIAN_AUTO_INDEX` | Watch vault changes and write derived semantic-index updates; set to `false` to disable background indexing | `true` |
| `OLLAMA_HOST` | Ollama API endpoint | `http://localhost:11434` |
| `OLLAMA_EMBEDDING_MODEL` | Model for embeddings | `nomic-embed-text` |
| `OBSIDIAN_HTTP_SERVER` / `HTTP_MODE` | Run as HTTP server instead of STDIO | `false` |
| `OBSIDIAN_HTTP_PORT` / `HTTP_PORT` | HTTP server port | `3456` |
| `OBSIDIAN_HTTP_TOKEN` | Bearer token for data-bearing HTTP API endpoints; `/health` and CORS preflight are unauthenticated | random per process |
| `OBSIDIAN_HTTP_CORS_ORIGIN` | Allowed browser origin for HTTP mode | `app://obsidian.md` |

`OBSIDIAN_READ_ONLY=true` blocks note/content and Obsidian app-state mutators,
but it does not block derived semantic-index writes. Set
`OBSIDIAN_AUTO_INDEX=false` to prevent background indexing, and do not invoke
the index tools when an operation must perform no derived-index writes.

## Features

- **Unified Multi-Vault**: Single server process handles all vaults. Most tools accept an optional `vault` parameter; authoritative graph orientation (`analyze_link_hierarchy`) requires an explicit one.
- **Explicit Capability Tiers**: 75 filesystem tools + 1 explicit app-contact tool + 28 CLI-only tools
- **Orientation & Self-Correction**: `get_started` and `discover_tools` map the server's surface; configured vault names surface as an `enum` in each tool's input schema; bounded structured recovery outcomes distinguish unknown tools, unavailable providers, conflicts, refusals, and safe no-change results
- **File Operations**: List, read, create, update, delete, move files with frontmatter support
- **Wikilink Resolution**: Resolve `[[wikilinks]]`, get outlinks/backlinks, follow link chains
- **Semantic Search**: Vector-based similarity search using Ollama embeddings
- **Frontmatter Queries**: Dataview-like query engine with 10 filter operators
- **Vault Analytics**: Health reports, orphan detection, broken links, stale notes
- **Section Editing**: Append, prepend, or replace content within specific markdown sections
- **Cross-Vault Search**: Search across all vaults simultaneously
- **Daily Notes**: Read, append, prepend to daily notes (CLI)
- **Tasks**: List and update tasks across the vault (CLI)
- **Properties**: List all frontmatter properties with types, get all unique values for any property (CLI)
- **Templates & Bases**: Access templates and Obsidian database views (CLI)
- **Commands & History**: Execute Obsidian commands, access file version history (CLI)
- **Tool Filtering**: Disable specific tools via `OBSIDIAN_DISABLED_TOOLS` env var

`analyze_link_hierarchy` requires an explicit vault and has two explicit modes:

- `providerMode: "exact"` (default) consumes a prepared, session-only Obsidian base-graph snapshot. It never calls the CLI, opens or focuses a window, or falls back to filesystem analysis. If preparation is needed, it returns `decision_required` before graph construction or ranking.
- `providerMode: "filesystem"` is an explicit approximation. It does not inspect the Obsidian registry, call the CLI, or open the app.

To choose exact analysis, call `open_vault` with one configured vault. The tool resolves that configured canonical path to exactly one registered 16-character Obsidian vault ID, opens it only when needed, and prepares the exact base graph without ranking. Re-run `analyze_link_hierarchy` in exact mode to rank that snapshot. Snapshots remain in server-session memory only and are invalidated by vault changes, identity changes, in-process mutation attempts other than a canonical proven no-change outcome, or a fresh preparation attempt.

Graph results include top-level `provider`, graph-build `providerState`, and request-level `decisionState`. Control outcomes such as `decision_required` and `exact_unavailable` include `decisionState` but no `providerState`, because no graph was returned. Other graph consumers, including additive search enrichment, retain their existing automatic provider recovery and bounded `providerFallbackReason` behavior.

## Structured Recovery Outcomes

Routine successful tool responses keep their established contracts. When a tool cannot complete safely or usefully, the server returns a bounded recovery object as both the first JSON text block and MCP `structuredContent`:

```json
{
  "status": "needs_action",
  "code": "unknown_tool",
  "message": "The requested tool is not registered in this server instance.",
  "requested": "read_note",
  "closest_matches": [
    "read_file",
    "find_note_by_name",
    "follow_link"
  ],
  "hint": "Use discover_tools to inspect the enabled tool inventory before retrying.",
  "actions": [
    {
      "label": "List available tools",
      "tool": "discover_tools"
    }
  ],
  "retryable": false,
  "sideEffects": {
    "state": "none"
  }
}
```

Recovery statuses cover `needs_action`, `no_change`, `unavailable`, `conflict`, `refused`, `cancelled`, and `failed`. Specific codes distinguish conditions such as an unknown or disabled tool, an unavailable Obsidian CLI, app, Ollama service, or model, an index that must be built, a failed precondition, and a request that safely made no change.

Closest matches and next actions are suggestions only: the server never executes a guessed replacement. Suggestions are capped, sanitized, deterministic, and limited to tools enabled for the current server and applicable to the request; read-like requests do not suggest mutators. Suggestions derived from vault content are marked as untrusted identifiers and are never copied into prose or executable actions.

`sideEffects.state` reports whether state was changed: `none`, `performed`, `possible`, or `unknown`. Unexpected reader failures report `none`; unexpected writer failures report `unknown` rather than claiming a write did or did not occur. Existing graph and vault decision/provider states remain their own authoritative domain contracts.

Over stdio, clients receive the full MCP tool result including `structuredContent`. HTTP successes keep their existing response bodies; known handler errors return the structured body with status 500, while unknown and disabled tools return distinct structured bodies with status 404. Legacy shorthand routes keep their existing HTTP status behavior.

## Result Completeness and Limits

High-volume JSON readers report what they actually evaluated instead of treating a returned-array length as a full total:

- `total`, `returned`, `truncated`, and `has_more` appear together only when the full matching total is known. A limited but fully scanned result is not `partial`.
- `limit_reached: true` means a configured result or provider bound is proven to have withheld at least one eligible candidate while the exact total remains unknown. The field is omitted when that fact is not proven; it is never emitted as `false`.
- `completeness: { state: "partial", scanned, skipped, reasons }` appears only when required files, descendant subtrees, or vaults could not be evaluated. `scanned` and `skipped` are operational units, not a mathematical coverage denominator: one inaccessible descendant directory is one skipped unknown-subtree unit. Caller-limit-unvisited work, hidden/non-Markdown exclusions, and successful fallback representations are not skipped.

Reasons are stable, bounded codes such as `file_unreadable`, `file_unparseable`, `directory_unavailable`, `vault_unindexed`, `embedding_index_incompatible`, and `vault_search_failed`. They never contain exception text, file paths, or vault-derived prose.

Composite reports place independently bounded arrays under `resultMetadata`. `get_broken_links` describes `brokenLinks` and `uniqueUnresolvedTargetStrings`; `get_vault_health` describes all four `top*` arrays; and `index_status` describes `staleIndexedFileSamples`. The stale-sample `total` counts all stale index records, while unsafe absolute or platform-specific path samples remain suppressed from the returned array.

`semantic_search`, `semantic_search_all`, and `get_similar` cannot claim an exact note total from capped embedding and FTS providers. For these tools, `limit_reached` means at least one eligible provider candidate row was withheld; that candidate can be another indexed block from a note already represented in the results. For `get_similar`, self-note chunks are excluded from the returned list, and extra self chunks inspected only to establish the bound do not change its historical result pool. Evidence-only sentinel rows never enter ranking, RRF scores, graph annotation, reranker input, or returned ordering.

Semantic results include `indexCompatibility`, which identifies the exact model generation and vector dimension searched and counts compatible versus excluded rows. Rows from another model digest, malformed legacy metadata, another vector dimension, or an empty/nonfinite vector cannot enter semantic or keyword ranking. Invalid provider vectors fail before retrieval begins. `state: "partial"` and `reindexRequired: true` say that a full re-index is needed. Cross-vault semantic search returns the same receipt globally and per vault. Its configured-order `resultMetadataByVault` entries use `searched`, `unindexed`, `incompatible`, or `failed` so one vault's stale or failed index does not erase successful results from another.

Legacy newline/tab readers such as `search_with_context` keep their established text responses. They do not yet receive machine-readable completeness metadata because adding metadata-only `structuredContent` would hide their text body on the HTTP surface, while converting them to a success envelope would be a broader compatibility migration. Their absence of completeness fields is not a claim that a swallowed read failure could not occur.

## Capability Tiers

| Tier | Tools | Requires | Always Available |
|------|-------|----------|-----------------|
| **Filesystem** | 75 tools | Node.js only | Yes — no Obsidian contact |
| **Explicit app contact** | 1 tool (`open_vault`) | Local Obsidian installation and registered CLI for exact preparation | Listed always; contacts/opens Obsidian only when explicitly invoked |
| **CLI-only** | 28 tools | Obsidian 1.12+ with installer 1.12.7+ running | No — graceful error if app not running |

**Filesystem tools** read and write vault files directly. They work whether Obsidian is open or not.

**The app-contact tool** is separate from the filesystem and CLI-only tiers because it is always exposed but intentionally contacts or opens local Obsidian only after explicit consent.

**CLI tools** access Obsidian's runtime API (`app.vault`, `app.metadataCache`, `app.fileManager`, etc.) via the Obsidian CLI. They provide access to features that only exist in the running app — metadata cache, daily notes configuration, task parsing, property types, backlink index, version history, and more.

If Obsidian is not running, CLI tools return a structured unavailable outcome with a corrective hint. All filesystem tools continue to work normally.
CLI subprocesses are time-bounded; a process that ignores the normal timeout signal is force-stopped after a short grace period so it cannot strand the MCP request or server shutdown.

### Enabling the Obsidian CLI

To use the 28 CLI-only tools, you need Obsidian 1.12+ installed with installer 1.12.7+ and CLI enabled. In Obsidian: **Settings → General → Enable "Command line interface"**, then follow the prompt to register. See the [Obsidian CLI documentation](https://obsidian.md/help/cli) for install and troubleshooting details.

## Available Tools (104)

### Filesystem Tier (75 tools)

#### Orientation (2)

| Tool | Description |
|------|-------------|
| `get_started` | Orientation guide — configured vaults, tool categories with counts, and tier/resolver guidance. Call first in a new session |
| `discover_tools` | Compact paginated inventory of all tools with category and tier (filesystem/app-contact/cli) |

#### Graph Orientation (1)

| Tool | Description |
|------|-------------|
| `analyze_link_hierarchy` | Rank a prepared exact Obsidian graph (default) or an explicitly selected filesystem approximation; never opens Obsidian or silently falls back |

### Explicit App Contact (1 tool)

| Tool | Description |
|------|-------------|
| `open_vault` | Explicitly open one configured vault if needed and prepare a session-only exact base-graph snapshot; refused by `OBSIDIAN_READ_ONLY` |

#### File Operations (9)

| Tool | Description |
|------|-------------|
| `list_files` | List all markdown files in a vault |
| `read_file` | Read file contents with frontmatter |
| `create_file` | Create a new file with optional frontmatter |
| `update_file` | Overwrite file contents (use section editing for partial changes) |
| `delete_file` | Delete a file |
| `get_frontmatter` | Read only frontmatter metadata |
| `update_frontmatter` | Merge updates into frontmatter |
| `search_content` | Full-text regex search across files |
| `move_note` | Relocate a file and update all wikilinks pointing to it |

#### Wikilink Operations (5)

| Tool | Description |
|------|-------------|
| `resolve_wikilink` | Resolve a `[[wikilink]]` to its file path |
| `get_outlinks` | Get all wikilinks from a note |
| `get_backlinks` | Get all notes that link to a given note |
| `follow_link` | Resolve a wikilink and read the target file |
| `rebuild_link_index` | Rebuild the wikilink resolution index |

#### Semantic Search (5)

| Tool | Description |
|------|-------------|
| `semantic_search` | Find similar content using embeddings (requires Ollama) |
| `index_vault` | Index all files in a vault for search |
| `index_file` | Index a single file |
| `get_similar` | Find notes similar to a given note |
| `index_status` | Check indexing status and stats |

`index_status` separates file coverage from embedding chunk density. `currentMarkdownFiles`
counts current non-hidden Markdown files; `currentIndexedFiles` counts current files
with at least one stored embedding row; `staleIndexedFiles` counts deleted, unsafe,
or redundant legacy index keys not counted as current coverage. `fileCoveragePercent`
is based on current indexed files divided by current Markdown files. `embeddingChunks`,
`currentEmbeddingChunks`, and `staleEmbeddingChunks` are chunk counts, not file
coverage. `uniqueFiles` and `totalEmbeddings` remain as legacy aliases for indexed
DB path count and all stored embedding chunks.

#### Frontmatter Queries (1)

| Tool | Description |
|------|-------------|
| `query_notes` | Dataview-like query engine for frontmatter fields |

Filter operators: `equals`, `not_equals`, `contains`, `not_contains`, `in`, `not_in`, `exists`, `not_exists`, `greater_than`, `less_than`

Example:
```json
{
  "tool": "query_notes",
  "args": {
    "vault": "Main",
    "from": "Projects",
    "where": [
      { "field": "type", "op": "equals", "value": "PROJECT" },
      { "field": "status", "op": "not_equals", "value": "archived" }
    ],
    "fields": ["type", "status", "updated"],
    "sort_by": "-updated",
    "limit": 10
  }
}
```

#### Vault Analytics (4)

| Tool | Description |
|------|-------------|
| `get_vault_health` | Composite health report (orphans + broken links + stale notes) |
| `get_orphan_notes` | Find notes with zero inbound wikilinks |
| `get_broken_links` | Find wikilinks pointing to non-existent notes |
| `get_stale_notes` | Find notes not modified within N days |

Broken-link reports distinguish physical occurrences from unique legacy target
strings. `brokenLinkCount` remains a physical-occurrence count and is also exposed
as `brokenLinkOccurrenceCount`; `uniqueUnresolvedTargetStringCount` groups by the
same target string emitted in each occurrence, not by canonical destination identity.
Occurrence entries include `sourceText`, `lineNumber`, `columnStart`, and
`occurrenceIndexOnLine` so repeated identical links on one line remain distinct.

#### Section Editing (3)

| Tool | Description |
|------|-------------|
| `append_to_section` | Add content to the end of a section |
| `prepend_to_section` | Add content to the beginning of a section |
| `update_section` | Replace all content within a section (heading preserved) |

#### Cross-Vault (5)

| Tool | Description |
|------|-------------|
| `search_all_vaults` | Search across all configured vaults |
| `semantic_search_all` | Semantic search across all configured vaults |
| `find_note_by_name` | Find a note by name across vaults |
| `get_cross_vault_links` | Find legacy candidates, validate native URI declarations, and compose eligible declarations into a typed read-only cross-vault graph overlay |
| `get_ecosystem_stats` | Statistics across the entire knowledge ecosystem (all vaults) |

`get_ecosystem_stats` uses the same truthful index accounting as `index_status`
but reports aggregate counts only. The legacy `indexedPercent` and
`overallIndexedPercent` fields now alias file coverage rather than embedding
chunks divided by files. Stale path samples are available only from targeted
`index_status` calls, not from ecosystem-wide stats.

`get_cross_vault_links` preserves its original unresolved-wikilink candidate fields and adds a separate `nativeUriInventory`. This first slice recognizes the documented `[Label](obsidian://open?vault=...&file=...)` inline-link form; bare URI text and angle-bracket autolinks are not relationship declarations in this contract. The inventory scans Markdown notes only, ignores code and image embeds, retains each source occurrence, validates configured destination vaults and exact vault-relative note paths, and returns canonical URIs plus actionable diagnostics. Results distinguish valid, noncanonical, malformed, unsupported, unknown/ambiguous vault, invalid path, missing destination, and same-vault URI cases. It never rewrites a note.

The additive `declaredCrossVaultGraph` projects only validated cross-vault declarations into structured `{ vault, path }` endpoints. It aggregates duplicate note-to-note relationships, reports canonical/noncanonical declaration counts and bounded subpaths, excludes invalid/missing/same-physical-vault declarations, and states its filesystem observation authority. This overlay is uncached and never enters per-vault `BaseGraph`, PageRank, structural levels, graph annotations, or retrieval ordering.

#### Daily Notes (4)

| Tool | Description |
|------|-------------|
| `daily_read` | Read today's daily note |
| `daily_append` | Append content to daily note |
| `daily_prepend` | Prepend content to daily note |
| `daily_path` | Get the configured daily note path |

#### Tasks (2)

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks with status, file, line number. Filter by done/todo |
| `update_task` | Toggle, complete, or uncomplete a task by file and line |

#### Tags (2)

| Tool | Description |
|------|-------------|
| `list_tags` | All tags with occurrence counts |
| `get_tag_info` | Tag details including file list |

#### Properties (5)

| Tool | Description |
|------|-------------|
| `list_properties` | All frontmatter properties with counts |
| `get_property_values` | All unique values for a property across the vault |
| `property_read` | Read a single property value from a file |
| `property_set` | Set a single frontmatter property |
| `property_remove` | Remove a single frontmatter property |

#### Targeted Editing (3)

| Tool | Description |
|------|-------------|
| `file_append` | Append content to end of any file |
| `file_prepend` | Prepend content to start of any file (after frontmatter) |
| `search_replace_in_file` | Find-and-replace — only changes matched text |

#### Metadata & Navigation (5)

| Tool | Description |
|------|-------------|
| `list_aliases` | List aliases in the vault or for a specific file |
| `get_file_info` | File metadata — name, path, size, created/modified dates |
| `get_folder_info` | Folder metadata — file count, folder count, size |
| `list_folders` | List folders in the vault, optionally filtered by parent |
| `read_random` | Read a random note |

#### Structure (2)

| Tool | Description |
|------|-------------|
| `get_outline` | Heading tree for a file |
| `word_count` | Word and character count |

#### Vault Structure (3)

| Tool | Description |
|------|-------------|
| `list_orphans` | Files with no incoming links |
| `list_deadends` | Files with no outgoing links |
| `unresolved_links` | Broken/unresolved wikilinks across the vault |

#### File Management (2)

| Tool | Description |
|------|-------------|
| `rename_file` | Rename a file and update all wikilinks |
| `move_file` | Move a file and update all wikilinks |

#### Bookmarks (2)

| Tool | Description |
|------|-------------|
| `add_bookmark` | Bookmark a file, folder, search query, or URL |
| `list_bookmarks` | List all bookmarks |

#### Search (1)

| Tool | Description |
|------|-------------|
| `search_with_context` | Search vault with matching line context |

#### Plugins (read-only) (3)

| Tool | Description |
|------|-------------|
| `list_plugins` | List installed plugins |
| `get_plugin_info` | Get detailed info about a specific plugin |
| `list_enabled_plugins` | List only enabled plugins |

#### Snippets & Themes (read-only) (3)

| Tool | Description |
|------|-------------|
| `list_snippets` | List installed CSS snippets |
| `list_themes` | List installed themes |
| `get_active_theme` | Get the active theme |

#### Vault & Workspace (3)

| Tool | Description |
|------|-------------|
| `get_vault_info` | Vault metadata — name, path, file/folder count, size |
| `get_workspace` | Workspace tree showing open panes and layout |
| `list_bases` | List all .base files in the vault |

---

### CLI-Only (28 tools — require Obsidian 1.12+ with installer 1.12.7+)

These tools access Obsidian's runtime state, plugin systems, or internal databases. They require the Obsidian app to be running with [CLI enabled](https://obsidian.md/help/cli). If Obsidian is not running, they return a structured unavailable outcome with a corrective hint.

#### Commands (2)

| Tool | Description |
|------|-------------|
| `list_commands` | Available Obsidian commands with optional filter |
| `execute_command` | Run any Obsidian command by ID |

#### Obsidian Search (1)

| Tool | Description |
|------|-------------|
| `vault_search` | Full-text search using Obsidian's search engine (supports `file:`, `tag:`, `path:` operators) |

#### Templates (3)

| Tool | Description |
|------|-------------|
| `list_templates` | List available templates |
| `read_template` | Read template content, optionally with variables resolved |
| `create_from_template` | Create a new file using an Obsidian template |

#### Version History (5)

| Tool | Description |
|------|-------------|
| `list_versions` | File version history (local and sync) |
| `read_version` | Read a historical version of a file |
| `diff_versions` | Diff between file versions |
| `restore_version` | Restore a file to a previous version |
| `list_files_with_history` | List files that have version history |

#### Plugin State Changes (2)

| Tool | Description |
|------|-------------|
| `enable_plugin` | Enable an installed plugin |
| `disable_plugin` | Disable a plugin |

#### Sync (3)

| Tool | Description |
|------|-------------|
| `sync_status` | Sync status (paused/active/connected) |
| `sync_history` | Sync version history for a file |
| `sync_read_version` | Read a specific sync version |

#### Snippet & Theme State Changes (3)

| Tool | Description |
|------|-------------|
| `list_enabled_snippets` | List enabled CSS snippets |
| `enable_snippet` | Enable a CSS snippet |
| `disable_snippet` | Disable a CSS snippet |

| Tool | Description |
|------|-------------|
| `set_theme` | Set the active theme |

#### Bases (3)

| Tool | Description |
|------|-------------|
| `query_base` | Query a base view (JSON, CSV, TSV, markdown, or paths) |
| `create_base_item` | Create a new item in a base/database |
| `list_base_views` | List views in a base file |

#### Other (6)

| Tool | Description |
|------|-------------|
| `eval_obsidian` | Execute JavaScript inside Obsidian's process |
| `list_recents` | Recently opened files |
| `list_known_vaults` | List all vaults known to Obsidian with paths |
| `get_hotkey` | Get the hotkey for a specific command |
| `list_hotkeys` | List all hotkey bindings |

## Semantic Search (Optional)

Semantic search requires [Ollama](https://ollama.ai/) running locally and the
hardened semantic-storage backend currently available on macOS and Linux. On an
unsupported platform, the server still starts, auto-indexing stays off, and tools
that require the derived semantic index return the structured
`semantic_storage_unavailable` outcome. Filesystem and Obsidian tools remain
available without the semantic index or Ollama.

Indexing reads the installed embedding model's architecture-specific context
window from Ollama, splits long Markdown deterministically without dropping source
content, and replaces each file's embeddings and keyword-search rows only after
the complete new index is ready. A provider failure leaves the previous file
index intact. If a note changes once during indexing, the first attempt is
discarded and retried; cache hits receive the same post-read verification. A
second change aborts without replacing the prior rows. Watcher events that arrive
during an active batch are drained after that batch completes, and single-file
indexing waits behind the same per-vault mutation boundary. Deleted notes are
removed from both semantic and keyword indexes even while Ollama is unavailable;
live notes receive bounded, exponentially delayed provider retries. A fresh
filesystem event resets that file's retry budget, and one delayed retry cannot
strand a newer event for another note.

Exact model cohorts are guarded against mutable Ollama tags. After each embedding,
Mycelium verifies the digest of the model Ollama actually loaded and confirms that
the requested tag still resolves to that digest. It repeats the tag check before
an index commit or exact query. A retag during any of those boundaries aborts the
operation; unverified vectors are not stored or searched as an exact cohort.

The derived SQLite index is bound to the physical vault root, storage directory,
and database identity. Existing symlinked or hard-linked storage files and SQLite
sidecars are rejected before SQLite runs. The canonical database is read through
a verified file handle into a private in-memory SQLite working copy. When an older
WAL-format main file needs normalization, its verified bytes are opened only in a
private temporary directory outside the vault, serialized into memory, and the
temporary directory is removed in a `finally` cleanup. SQLite never opens the
vault's database or sidecar paths. Successful mutations replace the canonical
database with a securely created atomic snapshot. Publication is
serialized across processes. Temporary and rollback files are created privately;
the rollback snapshot is copied from a retained verified database handle.
Creation, copying, replacement, and removal are relative to one pinned storage-
directory descriptor, so swapping the parent
pathname cannot redirect publication or recovery into another directory. The
implementation verifies the temporary file through the rename, records a durable
commit marker only after the renamed database is synced, and refuses a stale
database generation instead of silently overwriting a newer one. On startup, a
dead publisher's transaction is recovered only when its lock, canonical
generation, temporary snapshot, and rollback inode relationships all match the
recorded transaction. A crash before the commit marker restores the prior
generation, including a crash after rename; a crash after the marker preserves the
new generation. Missing or unverified recovery state fails closed. Authority
verification and SQLite snapshot acquisition are inside the same rejection
boundary as journal publication. A publication that reports failure restores both
the prior on-disk generation and the last successfully published in-memory state,
so later work or `close()` cannot commit a rejected mutation. If authority was
lost, the stale connection is closed and removed from the shared cache instead.
Once the marker is durable, a cleanup failure keeps the commit, invalidates that
connection, and requires a clean reopen. Full-vault indexing
publishes one snapshot at its
operation-owned batch boundary. Replacing a vault at the same path invalidates
the old connection instead of reusing its index. The native adapter exposes only
the fixed filesystem operations required by this protocol; arbitrary libraries,
symbols, and vault-supplied paths are not accepted.

When upgrading from an earlier WAL-mode build, stop the older Mycelium server
process before starting the new build. Live or stale WAL/SHM/journal sidecars fail
closed rather than being recovered through user-controlled paths; a normal Codex
restart removes live sidecars and supplies this process boundary. If sidecars
remain after every older process has stopped, remove only the derived
`.mcp-obsidian/embeddings.db*`, `.mcp-obsidian/embeddings.publish.lock`,
`.mcp-obsidian/.embeddings.db.*.tmp`, and
`.mcp-obsidian/.embeddings.db.*.rollback` files and run `index_vault` again;
notes are not part of that derived cache.

```bash
# Install (macOS)
brew install ollama

# Pull embedding model (~274MB)
ollama pull nomic-embed-text

# Verify
curl http://localhost:11434/api/tags
```

### First-Time Indexing

```bash
export OBSIDIAN_HTTP_TOKEN='replace-with-a-strong-secret'
OBSIDIAN_HTTP_SERVER=true npx @wickedevolutions/mcp-obsidian &
curl http://localhost:3456/call \
  -H "Authorization: Bearer $OBSIDIAN_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "index_vault", "args": {"vault": "MyVault"}}'
```

## HTTP Server Mode

```bash
OBSIDIAN_HTTP_SERVER=true \
OBSIDIAN_HTTP_PORT=3456 \
OBSIDIAN_HTTP_TOKEN='replace-with-a-strong-secret' \
npx @wickedevolutions/mcp-obsidian
```

Data-bearing HTTP API endpoints require `Authorization: Bearer <token>`.
`/health` and CORS preflight `OPTIONS` responses are unauthenticated. If
`OBSIDIAN_HTTP_TOKEN` is omitted, the server generates a random token and prints
it to stderr for that process only.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/tools` | GET | List available tools |
| `/call` | POST | Call any tool |
| `/search` | POST | Semantic search shorthand |

## Architecture

```
src/
├── index.ts              # Entry point, MCP server setup
├── http-server.ts        # HTTP server mode
├── config.ts             # Config loading + resolveVault() helper
├── tool-outcomes.ts      # Bounded structured recovery contract
├── types/index.ts        # TypeScript type definitions
├── cli/
│   ├── bridge.ts         # Obsidian CLI bridge (1.12+, installer 1.12.7+)
│   └── vault-target.ts   # Canonical registry identity + allowlisted exact-ID opening
├── graph/
│   └── prepared.ts       # Session-only exact base-graph snapshots + per-vault lock
├── parsers/
│   ├── markdown.ts       # Markdown/frontmatter parsing, section extraction
│   ├── wikilink.ts       # Wikilink parsing + resolution
│   └── obsidian-uri.ts   # Native obsidian://open URI parsing + extraction
├── embeddings/
│   ├── ollama.ts         # Ollama API client
│   ├── storage.ts        # SQLite vector storage
│   └── watcher.ts        # File watcher for auto-indexing
└── tools/
    ├── index.ts          # Tool registration hub
    ├── files.ts          # File ops (9 tools)
    ├── wikilinks.ts      # Wikilink ops (5 tools)
    ├── semantic.ts       # Semantic search (5 tools)
    ├── crossvault.ts     # Cross-vault ops (5 tools)
    ├── sections.ts       # Section editing (3 tools)
    ├── query.ts          # Frontmatter queries (1 tool)
    ├── analytics.ts      # Vault health (4 tools)
    ├── graph.ts          # Exact/filesystem orientation contract (1 tool)
    ├── vault.ts          # Explicit exact snapshot preparation (1 tool)
    ├── fs-promoted.ts    # Filesystem-promoted tools (40 tools)
    ├── cli-tools.ts      # CLI-only tools (28 tools)
    ├── get-started.ts    # Onboarding tool (1 tool)
    └── discover-tools.ts # Tool discovery (1 tool)
```

## Safety Notes

The following tools have application-state or broad-write consequences. Understand their behavior before use.

### `open_vault` — explicit application contact

`open_vault` may launch or open one explicitly named configured Obsidian vault and leaves any opened window open. It never closes or batch-opens vaults, accepts no path or arbitrary URI input, and issues no separate focus action; the operating system may bring a newly opened window forward. `OBSIDIAN_READ_ONLY=true` refuses it. Cancellation can stop waiting or child work but cannot undo a URI that was already dispatched.

### `search_replace_in_file` — fixed in v1.0.1 ([#4](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/issues/4))

**Fixed.** Previously, when the search text was not found, the tool wrote the literal string `"NO_CHANGE"` as file content, destroying the original. Now it returns a structured `no_change` outcome and does not modify the file.

### `update_section` on H1 headings — by design ([#5](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/issues/5))

**Caution:** When targeting an H1 heading (`# Title`), the section scope extends to the end of the file — because no heading of equal or higher level exists to close the section. This replaces everything below the title. Use `update_section` only on H2 and lower headings. For H1-level content, use `update_file` with full content instead.

### `update_file` — by design ([#6](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/issues/6))

**Caution:** This tool replaces the entire file body (frontmatter is preserved if the `frontmatter` parameter is omitted). For partial updates, use `append_to_section`, `prepend_to_section`, `update_section`, or the CLI tools `file_append` and `file_prepend`.

## Known Limitations

- **CLI-only tools require Obsidian running** — a subset of tools need Obsidian 1.12+ with installer 1.12.7+ and [CLI enabled](https://obsidian.md/help/cli). If Obsidian is not running, these tools return a structured unavailable outcome while all other tools continue working.
- **Unicode filenames** — Files with curly apostrophes (U+2019) and some Unicode characters may fail to resolve.
- **Vault path changes** — If a vault folder is renamed on disk, the `OBSIDIAN_VAULTS` environment variable must be updated manually.
- **Exact graph snapshots are session-only** — Restarting the MCP server clears prepared snapshots. Run `open_vault` again before exact orientation; choose `providerMode: "filesystem"` when an explicit approximation is sufficient.

## License

MIT — see [LICENSE](LICENSE) for details.
