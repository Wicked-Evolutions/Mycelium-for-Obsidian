# Changelog

All notable changes to mcp-obsidian are documented here.

## [1.3.0] - 2026-06-19

### Added

- **Orientation tools** — two new always-available tools help clients discover the server's surface without trial and error: `get_started` (returns an overview, configured vaults, and a tiered tool inventory) and `discover_tools` (lists/filters the available tools with their tiers and descriptions). (`src/tools/get-started.ts`, `src/tools/discover-tools.ts`)
- **Schema legibility** — shared schema helpers (`vaultParam`/`limitParam`) standardize common parameters, and the configured vault names are now injected as a dynamic `enum` into each tool's `inputSchema`, so clients see the actual vaults available rather than a free-form string. (`src/tools/schema-helpers.ts`)
- **Self-correcting resolution errors** — unknown-vault and unknown-note errors now return closest-match suggestions plus a corrective hint (Levenshtein `editDistance`/`closestMatches`, surfaced through handler responses via `formatVaultError`), so a typo'd vault or note name responds with "did you mean …?" instead of a bare failure. (`src/resolver-hints.ts`)
- **Comprehensive per-tool test coverage** — 8 new behavioral test files exercise every tool's real behavior (not just smoke checks), and `inputSchema` is now part of the tool contract snapshot to catch schema drift. (~542 tests)

### Bug Fixes

- **Bug-1 (analytics): duplicate-basename backlink collision** — `buildBacklinkIndex` used `buildFileIndex` (first-occurrence wins), so two notes with the same filename in different folders always credited the first-found copy. Fixed by introducing `buildMultiFileIndex` (basename → all paths) and passing `sourcePath` to `resolveWikilink` for same-folder tiebreak, matching Obsidian's resolution semantics. (`src/tools/analytics.ts`, `src/parsers/wikilink.ts`)

- **Bug-2 (semantic): `index_vault` skipped-counter invariant** — Section-chunked files whose sections were all up-to-date fell through without incrementing any counter, so `indexedFiles + skipped + errors < totalFiles`. Fixed by counting such files as `skipped` after the section loop, closing the accounting invariant for both whole-file and sectioned paths. (`src/tools/semantic.ts`)

- **Bug-3 (fs-promoted): `#`-anchor and `^`-block links falsely reported unresolved / target mislabelled orphan** — `list_orphans` and `unresolved_links` extracted link targets via `link.slice(2)` without stripping `#Section` or `^BlockRef` suffixes, so `[[Note#Heading]]` yielded target `Note#Heading`, which failed the filename membership check. Fixed by stripping anchors (`target.split('#')[0].split('^')[0].trim()`) and skipping empty self-anchors (`[[#Section]]`). (`src/tools/fs-promoted.ts`)

- **Bug-4 (fs-promoted): `resolveFile` bare-basename not found in subdirectory** — `resolveFile` appended `.md` and returned the path as-is, so a bare `{ file: 'Alpha' }` where the note lives at `Notes/Alpha.md` resolved to a non-existent root path. Fixed by performing a vault-wide `buildFileIndex` lookup for bare filenames not found at vault root, matching Obsidian's first-match semantics. (`src/tools/fs-promoted.ts`)

---

## [1.2.1] - 2026-05-31

### Bug Fixes

- **Stdio server process leak** — the stdio server now exits when the client disconnects, so orphaned server processes no longer accumulate after a client closes the connection.

### Documentation

- Corrected stale tool counts across the README (Features, Known Limitations).
- Updated the `search_replace_in_file` safety note to reflect that the no-match data-loss bug was fixed in v1.0.1.

---

## [1.2.0] - 2026-04-17

### Changed

- **Filesystem tier expansion** — promoted ~40 tools from the CLI tier to the filesystem tier, so the large majority of tools now work directly against the vault on disk without Obsidian running. Only tools that genuinely require Obsidian's runtime API remain CLI-only.

### Documentation

- Expanded the multi-vault setup section with a full configuration example.
- Replaced per-tool count language in descriptions with "full AI operations toolset" to avoid count drift.

---

## [1.1.0] - 2026-04-17

### Added

- **Full Obsidian 1.12+ CLI coverage** — added ~37 new CLI-tier tools, completing coverage of the Obsidian CLI surface (daily notes, tasks, tags, properties, templates, bases, commands, history, plugins, eval, and more).

---

## [1.0.1] - 2026-04-17

### Bug Fixes

- **`search_replace_in_file` no-match data loss** — fixed the tool so a search string that is not found no longer wipes the file; the operation is now a safe no-op.

### Documentation

- Added a Safety Notes section for destructive tools.

---

## [1.0.0] - 2026-04-17

First public release under the Wicked Evolutions org. Consolidates all prior development into a stable v1.0.0.

### Features

- **63 tools** across two tiers — 30 filesystem (always available) + 33 CLI (Obsidian 1.12+)
- **Unified multi-vault** — single server process handles all vaults via `vault` parameter
- **File operations** — list, read, create, update, delete, move files with frontmatter support
- **Wikilink resolution** — resolve `[[wikilinks]]`, backlinks, outlinks, follow link chains
- **Semantic search** — vector-based similarity search using Ollama embeddings
- **Frontmatter queries** — Dataview-like query engine with 10 filter operators
- **Vault analytics** — health reports, orphan detection, broken links, stale notes
- **Section editing** — append, prepend, or replace content within specific markdown sections
- **Cross-vault search** — search across all configured vaults simultaneously
- **CLI bridge** — daily notes, tasks, tags, properties, templates, bases, commands, history, plugins, eval
- **Tool filtering** — `OBSIDIAN_DISABLED_TOOLS` env var to disable specific tools at startup
- **HTTP server mode** — REST API for testing and integration
- **npm installable** — `npx mcp-obsidian` or global install

### Security

- Path traversal prevention — all file operations validate paths within vault boundaries
- TOCTOU race condition mitigations
- FTS injection prevention in semantic search
- Timing attack mitigations
- `OBSIDIAN_DISABLED_TOOLS` allows operators to disable dangerous tools (e.g. `search_replace_in_file`)

---

## Pre-1.0 Development History

Development history from the `Influencentricity/mcp-obsidian` era:

### v2.2.0 (2026-03-07)
- CLI bridge: 33 new tools via Obsidian 1.12+ CLI
- Two-tier architecture (filesystem + CLI)
- `OBSIDIAN_DISABLED_TOOLS` env var for tool filtering
- Total: 63 tools

### v2.1.1 (2026-03-05)
- Fix: `create_file` frontmatter serialization (JSON string no longer produces corrupt YAML)
- Fix: Unicode filename handling (NFC/NFD normalization fallback)

### v2.1.0 (2026-02-25)
- Security hardening: TOCTOU fixes, FTS injection prevention, timing attack mitigations

### v2.0.0 (2026-02-23)
- Unified multi-vault server (all tools accept optional `vault` parameter)
- New tools: `query_notes`, `get_vault_health`, `get_orphan_notes`, `get_broken_links`, `get_stale_notes`, `move_note`
- Total: 32 tools

### v1.0.0 (2026-01-16)
- Initial release: file ops, wikilinks, semantic search, cross-vault, section editing
- 27 tools across 5 modules

---

## License

MIT
