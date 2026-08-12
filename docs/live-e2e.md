# Live E2E — the AI-run pre-release gate

The headless test suite (`npm test`) runs everywhere, including GitHub CI. But some
behavior can only be proven against a **real running environment** — the exact
Obsidian graph provider (CLI `eval` bridge) and semantic search (Ollama
embeddings). GitHub CI cannot host Obsidian or Ollama, so this lane fills that gap.

**This is a hard pre-release gate, and the AI team runs it — not the user.** Before
cutting any release, an AI operator runs `npm run test:live` against a real
environment and records the exact suite and test counts. It is not part of CI.

## Test tiers

| Tier | Command | Where it runs | Covers |
|---|---|---|---|
| Headless | `npm test` / `npm run test:coverage` | local + **CI (Node 20 & 22)** | everything with no external services (mocks, fixtures, contracts, provider parity) |
| npm package | `npm run test:package` | local + **CI (Node 20 & 22)** | tarball boundary, clean install, native binding, installed stdio handshake, version and tool surface |
| **Live e2e** | `npm run test:live` | **AI operator, in-session only** | real Obsidian provider + real Ollama embeddings |
| Live diagnostic | `npm run test:live:optional` | local troubleshooting | the same suites, but missing prerequisites may skip |

`test:live` names the graph and semantic live files explicitly, so live tests
never run in the headless suite or CI. The graph file is listed first and files
run sequentially, so the closed-vault consent case completes before semantic
work can contact the same target. Its preflight requires a selected mapped vault and an
explicitly enabled Ollama lane. Missing prerequisites exit nonzero with a
sanitized `NOT RUN` receipt. The optional command remains useful for diagnostics,
but a skipped diagnostic run is never release evidence.

Preflight validates configuration shape only. It intentionally does not inspect
paths, start services, open vaults, or substitute probes for the product paths.
The graph suite itself requires the selected target to begin closed, proves the
side-effect-free decision response, explicitly invokes `open_vault`, and then
consumes the prepared exact snapshot. An unavailable Obsidian CLI, a target that
was already open, missing Ollama service, or handler failure makes the strict
command fail.

### CI Node-version asymmetry (know this)

CI runs the headless suite on **Node 20 and Node 22**:

- **Node 22 = the full gate.** It has a complete `mock.module` API, so every
  module-mock suite runs.
- **Node 20 = a compatibility / native-build floor.** `--experimental-test-module-mocks`
  is accepted (it was backported to 20 LTS), but `mock.module` is only partial
  before Node 22.3, so the mock-gated suites **skip** on 20 (via their `canMock`
  guard). That is why Node 20 reports more skips than Node 22.

Both legs must report **0 failures**. A passing npm-package lane proves a clean
installation and compatible native-binding load on its `ubuntu-latest` Node 20 or
22 runner. Node 20 also exercises the non-mock paths; Node 22 is the authoritative
full headless-suite run.

### npm package verification

`npm run test:package` creates and removes one isolated temporary root. It stages
the package build inputs there, packs the current npm/server candidate, rejects
files outside the declared package boundary, installs the tarball with lifecycle
scripts enabled and npm's automatic audit disabled, loads both `better-sqlite3`
and Koffi from that installed tree, and runs the installed descriptor-relative
filesystem adapter against a parent-directory swap on supported platforms. It
also runs an MCP stdio smoke test against a synthetic read-only vault. The installed
server version and ordered tool names must match the staged build. Lifecycle scripts
execute normally and are not an operating-system sandbox;
the verifier supplies only the system/compiler/network settings needed by npm and
does not forward vault, live-test, or unrelated secret environment variables.

Record the command's sanitized receipt: Node/npm/platform/architecture, package
identity and integrity, package entry count, normalized native-binding paths,
secure-filesystem execution state, server identity, tool count, and marker-file
result. Production audit evidence is captured
separately because registry advisory data is time-varying and detailed triage is
private. This lane does not validate Obsidian, Ollama, MCPB, publication, or platforms
outside the CI runners on which it executes.

## Prerequisites for the live lane

1. **Obsidian 1.12+ with installer 1.12.7+ installed** and the CLI **enabled and registered**
   (Settings → General → *Command line interface* → follow the register prompt).
2. The configured `LIVE_TEST_VAULT` must be **CLOSED** in Obsidian when the command
   starts. Other vault windows may remain open. The graph suite fails rather than
   weakening this prerequisite.
3. The configured vault path must resolve to exactly one entry in Obsidian's local
   vault registry. Duplicate, malformed, missing, basename-only, or mismatched
   registrations fail closed.
4. For the semantic test: **Ollama running** with the embedding model available.
   Indexing embeds every note — point `LIVE_TEST_VAULT` at a **small/medium**
   vault for this lane.

## Running it

Export the real vault map plus the live selectors, then run:

```bash
# The real multi-vault map the server would use (name -> absolute path):
export OBSIDIAN_VAULTS='{"ExampleVault":"/absolute/path/to/example-vault", "ConceptVault":"/absolute/path/to/concept-vault"}'

# A well-LINKED vault that is currently CLOSED in Obsidian:
export LIVE_TEST_VAULT="ExampleVault"

# Optional: a CONCEPT-first vault — asserts unresolved concept-link counts > 0:
export LIVE_CONCEPT_VAULT="ConceptVault"

# Required: enable the semantic lane (requires Ollama up):
export LIVE_OLLAMA=1

# Optional: bound semantic indexing to a representative directory in that vault.
# The graph assertion still evaluates the whole vault; the handler validates this path.
export LIVE_TEST_DIRECTORY="Path/To/Representative Notes"

npm run test:live
```

## Interpreting results

- **Required graph and semantic suites executed with 0 failures** → record each
  suite name plus the total test/pass/fail/skip counts. Only then does the live
  gate pass. The optional concept-vault case may remain skipped.
- **`NOT RUN`** → strict preflight rejected missing or malformed prerequisites.
  The message intentionally omits vault names, paths, and the full vault map.
- **Initial result was not `decision_required` with `targetReadiness: "closed"`** →
  the target did not begin in the required closed state or a prior snapshot exists
  in that server session. Close the target and restart the test process.
- **`open_vault` returned `exact_unavailable`** → inspect its sanitized
  `decisionState` for `cli_unavailable`, `loading`, `unregistered`, `ambiguous`,
  `probe_failed`, or `stale`. It never stores a filesystem approximation.
- **Exact analysis returned `decision_required` or `exact_unavailable` after
  preparation** → the session snapshot is missing, changed, or no longer matches
  the canonical registration. Run a fresh explicit preparation; do not treat a
  filesystem result as equivalent evidence.
- **Skipped diagnostic** → the corresponding env var is unset. A fully-skipped
  `test:live:optional` run is not a pass for release purposes.

## What the lane asserts today

- `test/live/graph.live.mjs` — a closed target first returns the ratified consent
  choices without opening or graph provenance; explicit `open_vault` dispatches
  the open and prepares one exact snapshot; exact analysis returns
  `provider: "obsidian"` with resolved edges; and repeating `open_vault` while the
  target is already open reports `openInvoked: false`. The optional concept-first
  case prepares its target explicitly before asserting unresolved concept links.
- `test/live/semantic.live.mjs` — `index_vault` then `semantic_search` returns
  a non-empty, exactly reconciled index summary with zero per-file errors, then
  ranked hits carrying a `path`, a numeric `similarity` + `fusionScore`,
  `fusionMethod: "rrf"`, one complete exact model/dimension index cohort, and the
  additive `graph` block. `LIVE_TEST_DIRECTORY`
  may bound the selected-vault indexing pass without changing the exact whole-vault
  graph lane. A separate temporary long-note fixture verifies against real Ollama
  that model-context chunking completes without truncation or note mutation.

Extend this lane whenever a behavior can only be proven against real Obsidian/Ollama.
