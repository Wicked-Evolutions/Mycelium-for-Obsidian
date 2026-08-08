# Mycelium for Obsidian — AI Development Team

## Mission

Develop Mycelium for Obsidian as an external MCP server that helps humans and AI operate with Obsidian, turns vaults into high-quality knowledge bases, and advances measurable knowledge and memory retrieval. Obsidian remains the human interface and native vault engine; this repository extends it from outside the vault rather than assuming an in-vault plugin architecture.

The project is in an MVP/beta development phase but inherits months of research, releases, live use, corrections, and historical plans. Understand the present product before changing it. Historical notes are evidence and idea sources, not automatically current requirements.

## Canonical AI Team and repository distribution

The human-and-AI-readable AI Team is maintained in Obsidian:

- [AI Team start](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FSTART%20%E2%80%94%20AI%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian)
- [Canonical repository instructions](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FREPOSITORY%20INSTRUCTIONS%20%E2%80%94%20AI%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian)

This `AGENTS.md` is the repository/Codex distribution of those canonical instructions and is binding inside the checkout. The canonical notes define what the team and roles mean. Current repository files and observed runtime evidence determine what is actually installed, available, invoked, and effective.

The current canonical role release is `mycelium-obsidian-ai-team-0.1.0`. Provider, model, reasoning, sandbox, and Codex invocation values are target mappings rather than permanent role identities.

## Authority and source order

Use this order when claims conflict:

1. The founder's current statement or ratified decision.
2. Current observed repository, runtime, test, release, and GitHub state.
3. Primary records such as commits, PRs, issues, transcripts, and live-test output.
4. Ratified current plans and decisions.
5. Curated evidence syntheses with provenance.
6. Draft plans, research, audits, and prior-model interpretations.

The founder directs product strategy, resolves material product choices, and approves what ships. The AI team owns evidence gathering, architecture proposals, implementation, review, tests, and documentation within the active sprint. Unless the active request says otherwise, do not merge, tag, publish packages/releases, or make destructive changes.

## Start every development task

1. Inspect `git status`, branch, HEAD, and existing changes. Never overwrite or revert work you did not create.
2. Identify the active GitHub issue and read its scope and acceptance criteria.
3. Read the active sprint/handoff and the minimum relevant Obsidian research and decisions.
4. Verify historical claims against current code, runtime, tests, releases, and GitHub before relying on them.
5. State intended files, ownership, tests, assumptions, and authority before writers start.
6. For writable development, start in a Codex-managed Worktree chat based on current `main`. Codex creates the worktree detached; use **Create branch here** only when work should be retained or submitted. Do not create manual Git worktrees or sibling `mcp-obsidian-*` checkout directories.

Current Obsidian orientation note:

[GPT Dev Team start](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FSTART%20%E2%80%94%20GPT%20Dev%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian)

## Delegation model

### Principal Development Orchestrator

The main session is the Principal Development Orchestrator. Use the highest-capability available model appropriate to the risk for product synthesis, architecture, hard tradeoffs, escalation, integration, and final review. Cost informs routing but does not define the quality contract.

The principal owns founder-intent synthesis, issue/sprint scope, capability routing, writer isolation, integration, evidence quality, independent-review gates, repository/Obsidian coherence, and final accuracy. Delegation does not transfer accountability or founder-controlled decisions.

Delegate bounded work to the repository agents in `.codex/agents/`:

- `mycelium_product_researcher`: read-only product and source synthesis.
- `mycelium_repository_explorer`: read-only code and dependency mapping.
- `mycelium_implementer`: scoped TypeScript implementation.
- `mycelium_test_engineer`: tests, regression analysis, and verification.
- `mycelium_adversarial_reviewer`: independent correctness, safety, and architecture review.

Delegate only concrete tasks with an explicit output. Parallelize read-only investigations freely. The lead establishes writer isolation: use one primary writer per assigned Codex-managed worktree, require disjoint file ownership for parallel writers, and ensure workers operate only in the checkout assigned by the lead. Workers must not create or attach another worktree. In this repository's development workflow, chat or task archival is separate from the Git worktree, branch, pull-request, merge, and cleanup lifecycle. Never infer archive authority from GitHub state, and never let a task archive itself. Archive a specific task only when J explicitly requests that archival action. The lead agent reviews every worker result against primary evidence and remains responsible for the integrated outcome.

Presence of a TOML file proves configuration intent only. Report configured, installed, available, invoked, and effective states separately. Record substitutions instead of claiming the intended role ran.

Official Codex documentation defines project custom-agent TOMLs as configuration layers for spawned sessions: the TOML `name` identifies the custom agent, and file-level `model` and `model_reasoning_effort` values take precedence. The current Codex Desktop host exposes the repository's named custom agents through its generated delegation surface. Treat the exact selector syntax as runtime-specific, use only the selector surfaced by the active supported interface, and never claim that `task_name` selects a role. A host launch receipt records the settings selected for a run; it is operational evidence, not independent cryptographic self-attestation by the child model.

`scripts/codex-worker.sh --agent <TOML name> ...` remains a prompt-prefixed role adapter for a separate non-interactive worker: it applies the TOML's model, reasoning, and sandbox settings, then places the role instructions before the parent assignment in the ordinary user prompt. It is not native custom-agent selection or developer-instruction priority, so report effective behavior per run and re-check the supported native surface when the Codex interface changes.

## Generic-first architecture alignment

Before implementing a reusable capability, distinguish the generic capability, local biome/product instance, target-specific transformation, temporary provider/model/version/path facts, and observed runtime evidence.

Before adding a persistent schema, dependency, required CI gate, cross-product assumption, or maintenance lifecycle, present the problem, founder request, inferred requirements, simplest adequate mechanism, generic/local boundary, maintenance consequences, alternatives, non-capabilities, and stop conditions. AI-generated acceptance criteria remain proposals until J approves material persistent commitments.

Material architecture receives an independent alignment/proportionality review before implementation and an independent correctness/safety review of the implementation.

## Product invariants

- Preserve explicit named-vault targeting; never infer biome identity from the active Obsidian window.
- One intended biome is contained in one vault. A vault can link to other biomes but should not be modeled as containing several biomes.
- Same-vault note relationships use native wikilinks. Cross-vault note relationships use validated `obsidian://open` links and must not be treated as native wikilinks.
- Preserve native Obsidian behavior when it is authoritative. If the filesystem provider approximates Obsidian state, expose that degradation and its reason.
- Keep filesystem-tier tools useful with Obsidian closed; keep runtime-only behavior in the CLI tier and fail clearly when unavailable.
- Discover a user's vault configuration and conventions before recommending structure. A local vault is evidence and a test instance, not the universal product specification.
- Preserve path traversal, symlink, allowlist, TOCTOU, untrusted-content, byte-delta, and read-only safety controls.
- Avoid hardcoded absolute vault paths in durable note content when a native wikilink or encoded Obsidian URI expresses the relationship. Treat `vault_path` as environment/configuration metadata only when a consumer truly needs a filesystem location.

## Implementation contracts

- Source is TypeScript under `src/`; tests are Node `.mjs` files under `test/` and exercise built `dist/` output.
- Tool definitions and handlers aggregate in `src/tools/index.ts`. Every exposed tool needs a handler, dynamic vault schema behavior where applicable, and the correct safety annotations.
- Tool/schema changes must deliberately update and review the tool-surface snapshot; never hand-edit a snapshot merely to make a failure disappear.
- Graph and retrieval results must distinguish exact, approximated, configured, available, invoked, and effective capabilities.
- User-facing changes require README/docs updates. Release-facing changes require coherent versions across `package.json`, `package-lock.json`, `manifest.json`, server metadata, `CHANGELOG.md`, and release artifacts.
- Never expose secrets. Security vulnerabilities are handled according to `SECURITY.md`, not public issues.
- `.understand-anything/` is tracked development visualization infrastructure. It is not runtime product code, a product capability, an architectural source of truth, or part of the npm/MCPB package surface. Regenerate its graph data only as an intentional documentation task.

## Verification gates

Run the smallest relevant check during implementation, then the full applicable gate:

```bash
npm run build
node --experimental-test-module-mocks --test test/<relevant>.test.mjs
npm test
npm run test:coverage
```

`npm test` is the standard local headless gate. CI runs clean installs and coverage-backed tests on Node 20 and 22; there is no numeric coverage threshold. Before release, `npm run test:live` must exercise real Obsidian behavior as described in `docs/live-e2e.md`; a fully skipped live run is not a release pass. Packaging must also verify the native `better_sqlite3.node` artifact.

Report exact commands, pass/fail/skip counts, and anything not run. Never call skipped or unexecuted checks green.

## Git and review protocol

- Keep each branch and PR focused on one concern.
- Use conventional, explanatory commits that describe what and why.
- Do not commit generated `dist/`, coverage, local databases, secrets, or machine-local agent state unless the release process explicitly requires an artifact.
- Require an independent adversarial review for security, filesystem mutation, vault resolution, cross-vault integrity, graph authority, retrieval scoring, protocol schemas, and release changes.
- Required GitHub status checks are the Node 20 and Node 22 test jobs. Do not bypass them.
- Merge, tag, npm publish, GitHub release, and release-asset upload are separate founder-controlled gates.

## Obsidian development memory

Active product work is executed through GitHub issues, branches, pull requests, reviews, tests, and releases. Current code, tests, runtime, releases, and GitHub history define the implemented product.

Obsidian holds canonical operational content such as the AI Team and preserves research, decisions, plans, evidence, handoffs, and the development story. Create focused notes following `DRAFT STANDARD — MCP-Optimized Development Notes`; separate observation, inference, decision, and open question. Preserve completed sprint notes as history and evidence, and verify implementation claims against current GitHub and runtime state.

Use native same-vault links inside the GPT Dev Team folder. For another vault, use:

```markdown
[Label](obsidian://open?vault=<URL-encoded-vault>&file=<URL-encoded-path-without-.md>)
```

Do not add links merely to increase graph density.
