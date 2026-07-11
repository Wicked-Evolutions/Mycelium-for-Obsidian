# AI Team Operating Model — Codex Repository Distribution

This document explains the Codex/repository implementation of the Mycelium for Obsidian AI development team. It is a target runbook, not the provider-neutral semantic origin.

## Canonical origin and candidate state

Canonical operating-model ID:

```text
mycelium-obsidian.ai-team.operating-model
```

[Open the Obsidian origin](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FOPERATING%20MODEL%20%E2%80%94%20AI%20Development%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian)

The source is canonical role release `mycelium-obsidian-ai-team-0.1.0`, ratified by J at Gate A from origin revision `0.1-draft` and marker-scoped payload SHA-256 `f642db156d3ada17bd81013f566bcacc2c155f4f91a82c3cc30b8021964cfee5`. The repository changes that reference it remain a candidate distribution: they are not merged, runtime-verified, or eligible for Gate B until a fresh reconciliation proves alignment to those exact released semantic bytes and the remaining evidence contract passes. The two founder gates are:

1. **Gate A (passed):** J ratified the exact SHA-256 of the canonical semantic payload under `marker-delimited-utf8-bytes-v1`. The payload begins after the start marker line's actual terminator and ends immediately before the `<` of the end marker line. Both marker lines and their terminators are excluded; newline bytes after the final semantic line remain payload bytes; no line-ending normalization occurs.
2. **Gate B:** after a fresh reconciliation against that exact ratified payload, J separately authorizes the exact repository distribution revision and PR merge.

These gates are distinct from a Mycelium software/tag/npm/MCPB/GitHub release.

`AGENTS.md` is the binding composite instruction surface for work in this repository. Its principal/delegation semantics derive from the Obsidian origin. Its product invariants, implementation contracts, safety controls, tests, and Git rules remain repository-specific authority.

## Authority by question

| Question | Authority |
|---|---|
| Intended role meaning | current J statement → ratified canonical role release → this distribution |
| Active sprint authority | current J statement → active sprint contract → role defaults |
| Installed/effective agent behavior | runtime evidence → installed config → repository artifact at exact commit → documentation → canonical expectation |
| Product behavior | current code/runtime/tests → primary records → documentation |

A runtime discrepancy is drift evidence. It neither rewrites the canonical origin nor disappears because documentation expected something else.

## Lifecycle and evidence dimensions

The validation contract supports lifecycle progression rather than assuming one draft-only schema:

- Origin lifecycle: `origin-draft` → `canonical-release` after Gate A.
- Target lifecycle: `candidate-unverified` → `candidate-verified` when all evidence required by the current contract exists → `merged` only after Gate B and merge of the exact reviewed revision.
- Artifact integrity: deterministic `integrity-consistent`/`integrity-mismatch` checks over declared bytes and aggregate target revision.
- Semantic reconciliation: receipt-backed `candidate-reviewed` against a frozen draft or `aligned-to-release` against the exact Gate A payload.
- Runtime effect: separately observed `unverified`, `verified`, `failed`, or `blocked` state for configuration, availability, invocation, mapping, sandbox, and instructions.

Automation may report `consistent` or `integrity-consistent`; that result is not a semantic review and not runtime-effect evidence. Only a review receipt identifying the source digest, aggregate target revision, reviewer, date, and outcome may establish `candidate-reviewed` or `aligned-to-release`.

## Team and current Codex mapping

Mappings are dated implementation choices, not stable role identities.

| Canonical role | Canonical role ID | Current Codex mapping | Intended control |
|---|---|---|---|
| Principal Development Orchestrator | `mycelium-obsidian.ai-role.principal-development-orchestrator` | GPT-5.6 SOL selected for the main session | parent permissions plus `AGENTS.md` |
| Product and Knowledge Researcher | `mycelium-obsidian.ai-role.product-knowledge-researcher` | `gpt-5.6-luna`, medium | read-only |
| Repository and Runtime Explorer | `mycelium-obsidian.ai-role.repository-runtime-explorer` | `gpt-5.6-luna`, medium | read-only |
| Scoped Implementer | `mycelium-obsidian.ai-role.scoped-implementer` | `gpt-5.6-terra`, medium | workspace-write |
| Verification and Test Engineer | `mycelium-obsidian.ai-role.verification-test-engineer` | `gpt-5.4-mini`, medium | workspace-write |
| Independent Adversarial Reviewer | `mycelium-obsidian.ai-role.independent-adversarial-reviewer` | `gpt-5.5`, high | read-only |

The principal uses the highest-capability available model appropriate to the risk. Cost and latency inform routing but do not define the quality contract.

Do not silently substitute an unavailable mapping. Record the configured role/model, effective substitute, reason, preserved controls, and degraded state.

## Main role versus custom subagents

The principal is the active main-session role. A custom-agent TOML does not configure the main thread.

The five specialist transformations live in `.codex/agents/`. Current OpenAI documentation says project custom agents are standalone TOML files identified by their `name` field. Presence on disk proves configuration intent only. Each exact role must still be proven available, invoked, and effective on the installed Codex version.

As of 2026-07-11, Codex 0.144.1 parses the project settings and the intended model slugs exist, but exact custom-role registration/effectiveness has conflicting evidence. Sprint 00 reported success; a later audit could not prove the exact roles were applied. A post-repair retest was blocked by the ChatGPT subscription worker limit. Until a deterministic receipt exists, classify these roles as `unverified` rather than operational.

[Official Codex custom-agent documentation](https://developers.openai.com/codex/agent-configuration/subagents)

## Distribution artifacts

- `AGENTS.md` — composite binding repository instructions and principal-role distribution.
- `.codex/agents/*.toml` — five specialist role transformations.
- `.codex/config.toml` — Codex thread/depth/runtime installation policy.
- `scripts/codex-worker.sh` — generic model/sandbox execution adapter with authentication and dirty-worktree controls.
- `docs/development/SPRINT_TEMPLATE.md` — sprint workflow adaptation.
- `.github/PULL_REQUEST_TEMPLATE.md` — PR evidence and authority adaptation.
- `CONTRIBUTING.md` — public governance summary without duplicating private role doctrine.
- `scripts/validate-ai-team-distribution.mjs` — deterministic target-integrity, lifecycle, and optional local-origin validator.
- `.github/workflows/ci.yml` — CI invocation of the distribution check.
- `package.json` — local npm validation entrypoints.
- `docs/development/AI_TEAM_DISTRIBUTION.json` — machine-readable provenance, mappings, target digests, aggregate revision, source state, and receipts; deliberately excluded from its own hash set.
- `test/ai-team-distribution.test.mjs` — verification harness for the validator; inventoried but intentionally not part of the governed distribution hash set.

Subject to the validator implementation, the manifest declares 15 governed target artifact hashes plus itself as the self-excluded declaration. The verification test remains non-hashed. The JSON manifest is the machine-readable target declaration. The Obsidian distribution register holds the human-readable lifecycle, semantic-review, and effectiveness evidence.

## Sprint sequence

1. **Orient:** verify repository, branch, worktree, release, GitHub, active sprint, and minimum canonical sources.
2. **Ratify scope:** goal, non-goals, authority, acceptance criteria, evidence, ownership, and stop conditions.
3. **Isolate:** create one focused branch and separate worktrees for concurrent writers.
4. **Implement:** bounded changes with targeted checks.
5. **Verify:** build, targeted tests, full applicable gates, and honest skips.
6. **Review:** independent adversarial review proportionate to risk.
7. **Document:** update repository contracts and Obsidian sprint evidence.
8. **Draft PR:** wait for required CI and resolve findings.
9. **Founder merge gate:** merge only after explicit authority.
10. **Software release gate:** tag/package/publish/release only with separate authority.

When canonical role semantics change, Gate A precedes the target-distribution Gate B.

## Worktree isolation

Concurrent writers must not share uncommitted ownership:

```bash
git fetch origin
git worktree add ../mcp-obsidian-<task> -b <type>/<task> origin/main
```

Assign explicit paths. A worker changes only its scoped files. The principal integrates through Git and reviews the complete diff.

## Custom-role verification gate

A custom-role distribution is effective only after all applicable evidence exists:

1. strict config parsing on the supported Codex version;
2. exact role-name discovery and spawn without silent built-in substitution;
3. effective model and reasoning evidence;
4. effective sandbox/permission evidence;
5. an instruction sentinel sourced from the role transformation, not supplied in the task prompt;
6. bounded task output consistent with the role contract;
7. recorded pass/fail/skip receipt in the active sprint.

If the subscription or runtime prevents this gate, report `unverified` or `blocked`. Do not infer success from file presence.

## Generic worker adapter

`scripts/codex-worker.sh` starts one non-interactive Codex session for an explicitly selected model, sandbox, worktree, and prompt. It does **not** currently select a canonical role or automatically load the matching role instructions.

It:

- removes `OPENAI_API_KEY` from the child;
- requires `codex login status` to report ChatGPT login;
- refuses workspace-write in a dirty worktree unless `--allow-dirty` is deliberately supplied;
- defaults to isolated user configuration unless `--with-user-config` is requested.

Loading user configuration is broader than loading role definitions; it also loads MCPs and other personal defaults. Do not describe `--with-user-config` as a proven custom-role fix.

If the wrapper later gains a role selector, add shim-based tests for exact prompt/config/model/reasoning/sandbox arguments, auth behavior, API-key removal, and dirty-tree refusal.

## Subscription-only installation evidence

This Mac's user configuration forces ChatGPT login. Authentication is intentionally not committed to the repository. On 2026-07-11, the deprecated `features.codex_hooks` and removed `features.js_repl` entries were repaired to the supported `features.hooks` key. Strict configuration and ChatGPT-only doctor checks then loaded cleanly, apart from an unrelated rollout-database parity warning.

This is machine/version-specific installation evidence, not a portable guarantee for another user or provider.

## Required evidence in every handoff

- Stable canonical role ID and effective platform mapping.
- Branch, commit, worktree, or dirty-diff state.
- Files/sources inspected or changed.
- Exact commands and pass/fail/skip results.
- Assumptions, risks, substitutions, and checks not run.
- Independent-review verdict and unresolved findings.
- Obsidian note created or updated.
- Authority used and still required.
- Canonical-role-release, distribution, PR, merge, and software-release states without conflation.

## Reconciliation and drift

1. Update the marker-delimited semantic body of the Obsidian origin draft and increment its mutable revision metadata outside the payload.
2. Freeze and hash raw UTF-8 bytes strictly between the two unique marker lines, excluding the markers and performing no newline normalization.
3. Optionally transform the frozen draft into target candidates, run deterministic integrity checks, record a `candidate-reviewed` semantic receipt, and open a clearly marked draft PR. Do not claim released/current status.
4. Gate A: J ratifies the exact marker-scoped payload. Record release version/date/founder receipt in mutable origin history outside the payload.
5. Reconcile target artifacts again against the exact Gate A payload while preserving canonical and target-specific controls.
6. Update and validate `AI_TEAM_DISTRIBUTION.json`; compute the 15-artifact aggregate distribution revision without hashing the manifest into itself.
7. Record a post-Gate-A `aligned-to-release` semantic receipt tied to the exact source digest and aggregate target revision.
8. Run strict config, exact role/effect tests, script checks, and repository gates. Integrity, semantics, and runtime remain separate results.
9. Record the exact governed target Git commit, typed draft-PR receipt, aggregate revision, reviewer/date/outcome, effective receipts, reconciliation date, and drift state. Any governed target change invalidates the aggregate and semantic receipt. To avoid self-reference, a later manifest-only receipt commit may bind `candidateCommit` and the PR receipt to the earlier commit whose 15 governed artifact hashes equal the unchanged aggregate; that receipt-only commit must not alter a governed artifact. The mutable Obsidian register records current PR/head/merge state and the relationship between these commits.
10. Gate B: J separately authorizes merge of that exact target revision.

If the origin is unavailable, the last reconciled installation may continue to run, but reconciliation/publication stops and reports `source-unknown`.

Exact custom-role runtime effectiveness is currently `unverified`. This does not block Gate A or preparation of a clearly labeled draft PR. Under the current Sprint 03 contract it blocks `candidate-verified` and Gate B.

Validate target structure in any checkout:

```bash
npm run validate:ai-team
```

When the canonical origin file is locally available, compare its exact marker-scoped payload without storing its machine path:

```bash
npm run validate:ai-team -- --origin-file '<path-to-canonical-operating-model-note>'
```
