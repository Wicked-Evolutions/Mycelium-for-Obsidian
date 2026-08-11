# Changelog

All notable changes to mcp-obsidian are documented here.

## [Unreleased]

### Added

- Added `open_vault`, an explicit app-state tool that opens one configured vault only when needed and prepares a session-only exact Obsidian base-graph snapshot. Targeting is bound to one canonical configured path and one registered 16-character Obsidian vault ID; basename, active-window, default-vault, arbitrary-URI, and batch targeting are not used. (#45)
- Added bounded structured recovery outcomes across the 104-tool MCP boundary. Unknown or disabled tools, unavailable runtime/model prerequisites, resolver misses, conflicts, refusals, cancellations, and safe no-change results now expose stable status, code, retry, side-effect, hint, and optional corrective-action fields without executing guessed replacements. (#80)

### Changed

- `analyze_link_hierarchy` now defaults to side-effect-free `providerMode: "exact"`. Exact mode ranks only a valid prepared snapshot and returns `decision_required` or `exact_unavailable` without opening Obsidian or silently falling back. Explicit `providerMode: "filesystem"` performs approximate analysis without probing or invoking Obsidian. Graph results add a request-level `decisionState`; non-graph outcomes omit `providerState`. (#45)
- Exact snapshot preparation, consumption, and in-process mutations are serialized per canonical vault; cancellation is carried through stdio/HTTP and graph work; and snapshots are invalidated conservatively on identity/digest changes, fresh preparation, and in-process mutation attempts other than canonical proven no-change outcomes. (#45, #80)
- Obsidian CLI/app, Ollama/model, and semantic-index prerequisites now remain distinct recovery conditions. Resolver suggestions are bounded and identify vault-derived names as untrusted; mutator preconditions and `search_replace_in_file` no-match results report truthful side-effect state. Stdio now preserves MCP `structuredContent`, and HTTP returns structured error bodies while retaining existing success and legacy-route behavior. (#80)

### Tests

- Added canonical registry identity, exact-ID argv, cross-platform opener, digest collision/failure, snapshot race/invalidation, consent-response, read-only refusal, queue cancellation/concurrency, and real graph-work cancellation coverage over stdio and HTTP. On the independently approved final candidate, the strict macOS live gate executed both required lanes successfully (exact Obsidian graph and real Ollama semantic search): 3 tests, 2 passed, 0 failed, 1 optional concept-vault test skipped. (#45)
- Added hostile-input bounds, recovery compatibility, resolver trust, provider-prerequisite, no-change, side-effect, stdio, and HTTP coverage for structured recovery outcomes. (#80)

## [1.5.0] - 2026-08-10

An npm/server reliability and cross-vault integrity release. The MCPB channel remains on v1.4.0 and is not part of this release.

### Added

- `get_cross_vault_links` now inventories validated native `obsidian://open` note links and composes eligible declarations into a bounded, typed, read-only cross-vault graph overlay. Same-vault graph ranking and retrieval ordering remain unchanged.

### Changed

- Graph-bearing responses now expose explicit exact-versus-approximate `providerState` provenance. Graph caches recheck provider eligibility and recover from filesystem fallback to the exact Obsidian provider without requiring a vault edit or server restart. macOS CLI probing now targets the dedicated `obsidian-cli` binary safely; CLI-tier compatibility requires Obsidian 1.12+ with installer 1.12.7+. (#62, #35)
- `index_status` and `get_ecosystem_stats` now report file coverage, stale or redundant indexed paths, and embedding chunk density as separate values. Legacy `indexedPercent` and `overallIndexedPercent` now alias truthful file coverage instead of embedding chunks divided by files. (#61)
- `get_broken_links` and `get_vault_health` now distinguish physical broken-link occurrences from unique unresolved target strings and include occurrence coordinates so repeated identical links on one line remain distinguishable. (#61)
- npm and source installs now require Node.js `>=20.0.0`. The founder approved `1.5.0` as the minor-release compatibility policy for this runtime-floor change. (#64)
- The Model Context Protocol SDK baseline is updated to `^1.30.0`, with an explicit 128 MiB stdio request limit to preserve large-note workflows while keeping input bounded.

### Fixed

- The shared Markdown reader, the filesystem-promoted `readVaultFile` helper, and `get_cross_vault_links` source/destination reads now verify opened file handles against their intended in-vault paths, strengthening those paths against symlink-swap and TOCTOU races.

### Security

- Refreshed the supported production dependency closure. The final production audit for the candidate lockfile reports zero findings; detailed triage remains private.

### Infrastructure

- `npm run test:live` is now a strict release-evidence command: missing configuration reports `NOT RUN`, and the required exact Obsidian and real Ollama lanes must execute successfully. `npm run test:live:optional` remains diagnostic only. (#63)
- Added real MCP stdio and authenticated local REST API smoke tests, including large-request handling and clean disconnect behavior.

## [1.4.0] - 2026-07-06

A two-pillar release: **graph orientation** (the vault's link graph) alongside the existing **semantic retrieval** (embeddings). Everything below was developed since 1.3.0.

### Added

- **Graph orientation — `analyze_link_hierarchy`** — ranks the vault's wikilink graph by PageRank + degree and assigns structural levels L0 (top hubs) → L5 (leaves), pruning declared / generated / index / archive notes before ranking. Obsidian-authoritative when the app is running (exact `resolvedLinks`), filesystem approximation otherwise. Backed by a reusable `getGraphSignals`. (#19)
- **Graph-aware search** — every `semantic_search` hit now carries an additive `graph` block describing its structural role; extended to cross-vault `semantic_search_all`. Ordering is unchanged — the graph block is a compass, not a re-ranker. (#24, #26)
- **Hybrid retrieval** — Reciprocal Rank Fusion (RRF) over embeddings + BM25, an eval harness (Recall@K / NDCG@K / MRR), and per-signal observability. (#18)
- **Opt-in reranker + HyDE** — an LLM-as-reranker backend over Ollama (default **OFF**; ordering unchanged when off) and a `hypotheticalAnswer` (HyDE) argument for `semantic_search`. (#28, #29)
- **Slash commands (MCP prompts)** — five read-only, human-triggered commands that prime the assistant over the shipped tools: `/orient`, `/search`, `/excluded`, `/vault-health`, `/get-started`. (#14)
- **Safety / trust surface** — global read-only mode (`OBSIDIAN_READ_ONLY`), untrusted-content markers (`OBSIDIAN_WRAP_UNTRUSTED`), per-tool MCP annotations (readOnly / destructive / idempotent / openWorld hints), and byte-delta telemetry on writes. (#20)
- **Concept-link visibility** — `analyze_link_hierarchy` now reports `resolvedEdgeCount`, `unresolvedLinkCount`, and `distinctUnresolvedTargets`, and `/orient` distinguishes a genuinely unstructured vault from a **concept-first** one (many `[[concept]]` links to notes that don't exist yet) instead of claiming "no structure." (#37)

### Changed

- **`analyze_link_hierarchy` now requires an explicit `vault`.** The authoritative orientation map no longer silently defaults to the first configured vault — omitting `vault` returns a structured error listing the configured vaults. A valid but empty vault returns a clear `emptyVault` response instead of a hollow all-zero map. (#33)

### Fixed

- **Obsidian graph provider silently degraded to the filesystem approximation on larger vaults.** The CLI eval output exceeded Node's default 1 MB `execFile` buffer, so vaults with more than ~1 MB of resolved links quietly lost exact-graph parity and reported `provider: "filesystem"`. Raised the buffer and surfaced a `providerFallbackReason` so any degrade is now visible rather than silent. (#32)

### Infrastructure

- **Continuous integration** — the full test suite now runs on every pull request and push across Node 20 and 22; `main` is branch-protected on those checks; baseline coverage (c8) is reported. (#39)
- **Live end-to-end lane** — an operator-run `test:live` suite exercises the real Obsidian provider and real Ollama embeddings before each release (`docs/live-e2e.md`). (#40)
- Project-board automation CI hygiene. (#22, #31)

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
