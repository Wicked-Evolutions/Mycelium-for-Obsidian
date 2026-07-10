# Mycelium for Obsidian — AI Development Team

## Mission

Develop Mycelium for Obsidian as an external MCP server that helps humans and AI operate with Obsidian, turns vaults into high-quality knowledge bases, and advances measurable knowledge and memory retrieval. Obsidian remains the human interface and native vault engine; this repository extends it from outside the vault rather than assuming an in-vault plugin architecture.

The project is in an MVP/beta development phase but inherits months of research, releases, live use, corrections, and historical plans. Understand the present product before changing it. Historical notes are evidence and idea sources, not automatically current requirements.

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
2. Read the active sprint note and the minimum relevant sources from the GPT Dev Team Obsidian folder.
3. Verify historical claims against current code, runtime, tests, and GitHub before relying on them.
4. State the intended files, ownership, tests, and authority boundary before parallel writers start.
5. Use a focused branch from current `main`. Use separate Git worktrees for concurrent code-writing agents.

Current Obsidian orientation note:

[GPT Dev Team start](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FSTART%20%E2%80%94%20GPT%20Dev%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian)

## Delegation model

Use the highest-cost model for product synthesis, architecture, hard tradeoffs, escalation, and final integration review. Delegate bounded work to the repository agents in `.codex/agents/`:

- `mycelium_product_researcher`: read-only product and source synthesis.
- `mycelium_repository_explorer`: read-only code and dependency mapping.
- `mycelium_implementer`: scoped TypeScript implementation.
- `mycelium_test_engineer`: tests, regression analysis, and verification.
- `mycelium_adversarial_reviewer`: independent correctness, safety, and architecture review.

Delegate only concrete tasks with an explicit output. Parallelize read-only investigations freely. Parallel writers require disjoint file ownership or separate worktrees. The lead agent reviews every worker result against primary evidence and remains responsible for the integrated outcome.

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

Repository documentation records code-facing contracts. Obsidian records human-readable sprint plans, evidence, decisions, research, and handoffs. Create focused notes following `DRAFT STANDARD — MCP-Optimized Development Notes`; separate observation, inference, decision, and open question. Preserve historical notes and connect superseding state rather than rewriting history.

Use native same-vault links inside the GPT Dev Team folder. For another vault, use:

```markdown
[Label](obsidian://open?vault=<URL-encoded-vault>&file=<URL-encoded-path-without-.md>)
```

Do not add links merely to increase graph density.
