# mcp-obsidian

Multi-vault Obsidian MCP server — full AI operations toolset for file management, wikilinks, semantic search, frontmatter queries, daily notes, tasks, properties, templates, and more.

Two-tier architecture: 74 tools work without Obsidian running + 28 CLI tools access Obsidian's runtime API when the app is running with [CLI enabled](https://obsidian.md/help/cli) (1.12+).

New in 1.3.0: orientation tools (`get_started`, `discover_tools`) so a client can map the server's surface up front; schema legibility (your configured vault names appear as an `enum` in every tool's input schema); and self-correcting resolution — an unknown vault or note name returns closest-match suggestions and a corrective hint instead of a bare error.

## Install

### Claude Desktop — one click

Download [mcp-obsidian.mcpb](https://github.com/Wicked-Evolutions/mcp-obsidian/releases/latest/download/mcp-obsidian-1.0.0.mcpb), double-click, enter your vault paths. Done.

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
git clone https://github.com/Wicked-Evolutions/mcp-obsidian.git
cd mcp-obsidian
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
      "command": "npx",
      "args": ["mcp-obsidian"],
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

A single mcp-obsidian server handles all your vaults. Pass them as a JSON object in `OBSIDIAN_VAULTS` — every tool accepts an optional `vault` parameter to target a specific vault:

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
| `OLLAMA_HOST` | Ollama API endpoint | `http://localhost:11434` |
| `OLLAMA_EMBEDDING_MODEL` | Model for embeddings | `nomic-embed-text` |
| `HTTP_MODE` | Run as HTTP server instead of STDIO | `false` |
| `HTTP_PORT` | Port for HTTP server | `3456` |

## Features

- **Unified Multi-Vault**: Single server process handles all vaults. Every tool accepts an optional `vault` parameter.
- **Two-Tier Architecture**: 74 tools always available + 28 CLI tools when Obsidian 1.12+ is running
- **Orientation & Self-Correction**: `get_started` and `discover_tools` map the server's surface; configured vault names surface as an `enum` in each tool's input schema; unknown vault/note names return closest-match suggestions instead of bare errors
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

## Two-Tier Architecture

| Tier | Tools | Requires | Always Available |
|------|-------|----------|-----------------|
| **Filesystem** | 74 tools | Node.js only | Yes — works without Obsidian running |
| **CLI-only** | 28 tools | Obsidian 1.12+ running | No — graceful error if app not running |

**Filesystem tools** read and write vault files directly. They work whether Obsidian is open or not.

**CLI tools** access Obsidian's runtime API (`app.vault`, `app.metadataCache`, `app.fileManager`, etc.) via the Obsidian CLI. They provide access to features that only exist in the running app — metadata cache, daily notes configuration, task parsing, property types, backlink index, version history, and more.

If Obsidian is not running, CLI tools return a clear error message. All filesystem tools continue to work normally.

### Enabling the Obsidian CLI

To use the 28 CLI-only tools, you need Obsidian 1.12+ with CLI enabled. In Obsidian: **Settings → General → Enable "Command line interface"**, then follow the prompt to register. See the [Obsidian CLI documentation](https://obsidian.md/help/cli) for install and troubleshooting details.

## Available Tools (102)

### Always Available (74 tools — no Obsidian required)

#### Orientation (2)

| Tool | Description |
|------|-------------|
| `get_started` | Orientation guide — configured vaults, tool categories with counts, and tier/resolver guidance. Call first in a new session |
| `discover_tools` | Compact paginated inventory of all tools with category and tier (filesystem/cli) |

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
| `get_cross_vault_links` | Find wikilinks between vaults |
| `get_ecosystem_stats` | Statistics across the entire knowledge ecosystem (all vaults) |

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

### CLI-Only (28 tools — require Obsidian 1.12+)

These tools access Obsidian's runtime state, plugin systems, or internal databases. They require the Obsidian app to be running with [CLI enabled](https://obsidian.md/help/cli). If Obsidian is not running, they return a clear error message.

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

Semantic search requires [Ollama](https://ollama.ai/) running locally. All other tools work without Ollama.

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
HTTP_MODE=true npx @wickedevolutions/mcp-obsidian &
curl http://localhost:3456/call \
  -H "Content-Type: application/json" \
  -d '{"tool": "index_vault", "args": {"vault": "MyVault"}}'
```

## HTTP Server Mode

```bash
HTTP_MODE=true HTTP_PORT=3456 npx @wickedevolutions/mcp-obsidian
```

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
├── types/index.ts        # TypeScript type definitions
├── cli/
│   └── bridge.ts         # Obsidian CLI bridge (1.12+)
├── parsers/
│   ├── markdown.ts       # Markdown/frontmatter parsing, section extraction
│   └── wikilink.ts       # Wikilink parsing + resolution
├── embeddings/
│   ├── ollama.ts         # Ollama API client
│   ├── storage.ts        # SQLite vector storage
│   └── watcher.ts        # File watcher for auto-indexing
└── tools/
    ├── index.ts          # Tool registration hub (11 modules)
    ├── files.ts          # File ops (9 tools)
    ├── wikilinks.ts      # Wikilink ops (5 tools)
    ├── semantic.ts       # Semantic search (5 tools)
    ├── crossvault.ts     # Cross-vault ops (5 tools)
    ├── sections.ts       # Section editing (3 tools)
    ├── query.ts          # Frontmatter queries (1 tool)
    ├── analytics.ts      # Vault health (4 tools)
    ├── fs-promoted.ts    # Filesystem-promoted tools (40 tools)
    ├── cli-tools.ts      # CLI-only tools (28 tools)
    ├── get-started.ts    # Onboarding tool (1 tool)
    └── discover-tools.ts # Tool discovery (1 tool)
```

## Safety Notes

Three tools can cause data loss if used incorrectly. Understand their behavior before use.

### `search_replace_in_file` — fixed in v1.0.1 ([#4](https://github.com/Wicked-Evolutions/mcp-obsidian/issues/4))

**Fixed.** Previously, when the search text was not found, the tool wrote the literal string `"NO_CHANGE"` as file content, destroying the original. Now it safely returns an error without modifying the file.

### `update_section` on H1 headings — by design ([#5](https://github.com/Wicked-Evolutions/mcp-obsidian/issues/5))

**Caution:** When targeting an H1 heading (`# Title`), the section scope extends to the end of the file — because no heading of equal or higher level exists to close the section. This replaces everything below the title. Use `update_section` only on H2 and lower headings. For H1-level content, use `update_file` with full content instead.

### `update_file` — by design ([#6](https://github.com/Wicked-Evolutions/mcp-obsidian/issues/6))

**Caution:** This tool replaces the entire file body (frontmatter is preserved if the `frontmatter` parameter is omitted). For partial updates, use `append_to_section`, `prepend_to_section`, `update_section`, or the CLI tools `file_append` and `file_prepend`.

## Known Limitations

- **CLI-only tools require Obsidian running** — a subset of tools need Obsidian 1.12+ with [CLI enabled](https://obsidian.md/help/cli). If Obsidian is not running, these tools return a clear error while all other tools continue working.
- **Unicode filenames** — Files with curly apostrophes (U+2019) and some Unicode characters may fail to resolve.
- **Vault path changes** — If a vault folder is renamed on disk, the `OBSIDIAN_VAULTS` environment variable must be updated manually.

## License

MIT — see [LICENSE](LICENSE) for details.
