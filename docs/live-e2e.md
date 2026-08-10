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
| **Live e2e** | `npm run test:live` | **AI operator, in-session only** | real Obsidian provider + real Ollama embeddings |
| Live diagnostic | `npm run test:live:optional` | local troubleshooting | the same suites, but missing prerequisites may skip |

`test:live` globs **only** `test/live/*.live.mjs`, so live tests never run in the
headless suite or CI. Its preflight requires a selected mapped vault and an
explicitly enabled Ollama lane. Missing prerequisites exit nonzero with a
sanitized `NOT RUN` receipt. The optional command remains useful for diagnostics,
but a skipped diagnostic run is never release evidence.

Preflight validates configuration shape only. It intentionally does not inspect
paths, start services, open vaults, or substitute probes for the product paths.
The graph and semantic suites are the authoritative runtime checks; an unavailable
Obsidian CLI, closed target vault, missing Ollama service, or handler failure makes
the strict command fail.

### CI Node-version asymmetry (know this)

CI runs the headless suite on **Node 20 and Node 22**:

- **Node 22 = the full gate.** It has a complete `mock.module` API, so every
  module-mock suite runs.
- **Node 20 = a compatibility / native-build floor.** `--experimental-test-module-mocks`
  is accepted (it was backported to 20 LTS), but `mock.module` is only partial
  before Node 22.3, so the mock-gated suites **skip** on 20 (via their `canMock`
  guard). That is why Node 20 reports more skips than Node 22.

Both legs are **0 failures**. Node 20 proves `better-sqlite3` compiles and the
non-mock paths pass; Node 22 is the authoritative full-suite run.

## Prerequisites for the live lane

1. **Obsidian 1.12+ with installer 1.12.7+ running** and the CLI **enabled and registered**
   (Settings → General → *Command line interface* → follow the register prompt).
2. The **target vault(s) OPEN** in Obsidian — the CLI `eval` command only reaches
   vaults that have an open window.
3. **Reconnect the MCP server after any Obsidian restart** — a restart can drop
   the CLI bridge; if the provider silently degrades you will see
   `provider: "filesystem"` + a `providerFallbackReason`. The `eval` bridge can
   also be intermittent; re-run if a run degrades unexpectedly.
4. For the semantic test: **Ollama running** with the embedding model available.
   Indexing embeds every note — point `LIVE_TEST_VAULT` at a **small/medium**
   vault for this lane.

## Running it

Export the real vault map plus the live selectors, then run:

```bash
# The real multi-vault map the server would use (name -> absolute path):
export OBSIDIAN_VAULTS='{"ExampleVault":"/absolute/path/to/example-vault", "ConceptVault":"/absolute/path/to/concept-vault"}'

# A well-LINKED vault (open in Obsidian) — asserts provider:"obsidian" + resolvedEdgeCount>0:
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
- **`provider` was `"filesystem"`** → the Obsidian exact-graph provider did not engage.
  Check the prereqs (CLI registered, vault open, MCP reconnected). The assertion
  message echoes `providerFallbackReason`. Inspect `providerState` to distinguish
  disabled eval, missing CLI registration, an unavailable app, and an attempted
  eval failure. Its invocation fields describe the graph build, including cached
  builds; they do not claim eval ran again for every response.
- **Skipped diagnostic** → the corresponding env var is unset. A fully-skipped
  `test:live:optional` run is not a pass for release purposes.

## What the lane asserts today

- `test/live/graph.live.mjs` — `analyze_link_hierarchy` returns `provider: "obsidian"`
  with exact, invoked `providerState` and `resolvedEdgeCount > 0` on a linked
  vault, and (optionally) surfaces unresolved concept-links on a concept-first vault.
- `test/live/semantic.live.mjs` — `index_vault` then `semantic_search` returns
  a non-empty, exactly reconciled index summary with zero per-file errors, then
  ranked hits carrying a `path`, a numeric `similarity` + `fusionScore`,
  `fusionMethod: "rrf"`, and the additive `graph` block. `LIVE_TEST_DIRECTORY`
  may bound the indexing pass without changing the exact whole-vault graph lane.

Extend this lane whenever a behavior can only be proven against real Obsidian/Ollama.
