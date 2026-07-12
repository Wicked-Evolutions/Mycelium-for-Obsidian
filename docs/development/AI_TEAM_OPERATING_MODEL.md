# AI Team Operating Model — Repository/Codex Distribution

This repository uses a founder-directed, AI-executed development model. The [canonical AI Team](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FSTART%20%E2%80%94%20AI%20Team%20%E2%80%94%20Mycelium%20for%20Obsidian) is maintained in Obsidian. `AGENTS.md`, `.codex/agents/*.toml`, and this runbook are repository/Codex distributions.

Canonical role release: `mycelium-obsidian-ai-team-0.1.0`.

The canonical notes define what the team and roles mean. Current repository files and runtime evidence determine what is actually configured, available, invoked, and effective.

## Team shape

The Principal Development Orchestrator owns product synthesis, architecture, delegation, integration, evidence quality, and final accountability. Specialists perform bounded research, repository exploration, implementation, testing, and independent review. Their Codex target definitions live in `.codex/agents/` and return results to the principal session.

Use native Codex subagents for bounded delegation when the surfaced interface is sufficient. The current app and CLI delegation interfaces do not expose an exact project custom-agent selector. `scripts/codex-worker.sh --agent <name>` provides a prompt-prefixed role adapter when a separate worker should use a repository role's target mapping and instructions, especially in an isolated worktree. It is not equivalent to native custom-agent selection. Hermes integration is outside GitHub issue #51 and requires a separate named issue and decision before implementation.

## Canonical roles and current targets

| Canonical role | Codex target |
|---|---|
| [Principal Development Orchestrator](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Principal%20Development%20Orchestrator%20%E2%80%94%20Mycelium%20for%20Obsidian) | main session through `AGENTS.md` |
| [Product and Knowledge Researcher](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Product%20and%20Knowledge%20Researcher%20%E2%80%94%20Mycelium%20for%20Obsidian) | `mycelium_product_researcher` |
| [Repository and Runtime Explorer](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Repository%20and%20Runtime%20Explorer%20%E2%80%94%20Mycelium%20for%20Obsidian) | `mycelium_repository_explorer` |
| [Scoped Implementer](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Scoped%20Implementer%20%E2%80%94%20Mycelium%20for%20Obsidian) | `mycelium_implementer` |
| [Verification and Test Engineer](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Verification%20and%20Test%20Engineer%20%E2%80%94%20Mycelium%20for%20Obsidian) | `mycelium_test_engineer` |
| [Independent Adversarial Reviewer](obsidian://open?vault=06%202.0%20Influencentricity%20OS%20MVP&file=MCP%20Obsidian%20by%20Wicked%20Evolutions%2FGPT%20Dev%20Team%2FAI%20Team%2FAGENT%20%E2%80%94%20Independent%20Adversarial%20Reviewer%20%E2%80%94%20Mycelium%20for%20Obsidian) | `mycelium_adversarial_reviewer` |

Presence of a target file proves configuration intent only. Record substitutions and distinguish configured, installed, available, invoked, and effective states.

[Official Codex custom-agent documentation](https://developers.openai.com/codex/agent-configuration/subagents#custom-agents) confirms that project custom agents live under `.codex/agents/` and that the TOML `name` is the custom-agent identity. It does not document `agent_type` or `fork_turns` as user-facing selectors. A fresh Codex 0.144.1 probe found no exact custom-agent selector in the surfaced app or CLI delegation interface; `task_name` only labels a delegated task. Do not silently substitute a generic child while claiming a named role ran.

## Sprint sequence

1. **Orient:** verify active GitHub issue, branch, release, worktree, relevant Obsidian sources, and current runtime.
2. **Ratify scope:** define goal, non-goals, authority, acceptance criteria, evidence, and file ownership.
3. **Branch:** create one focused branch. Create additional Git worktrees only for genuinely independent writers.
4. **Implement:** use small commits and targeted tests. Keep product changes separate from unrelated cleanup.
5. **Verify:** build, targeted tests, `npm test`, `npm run test:coverage`, and applicable live tests.
6. **Review:** run the independent review required by the issue and resolve findings with evidence.
7. **Document:** update repository contracts and the Obsidian sprint evidence/handoff.
8. **PR:** open a focused draft PR, let Node 20/22 CI finish, and address review feedback.
9. **Founder gate:** merge only after product review and explicit approval.
10. **Release gate:** tag, package, publish, and release only under separately stated authority.

## Worktree isolation

Concurrent writers must not share an uncommitted working tree. From the repository root:

```bash
git fetch origin
git worktree add ../mcp-obsidian-<task> -b <type>/<task> origin/main
```

Assign explicit paths to each worker. A worker commits only its scoped changes. The lead reviews the diff and integrates it through Git rather than copying code between chats.

## Target model allocation

Use the project agent definitions as current target mappings, not permanent role identities:

- SOL: lead, architecture, final synthesis.
- Luna: inexpensive research and repository discovery.
- Terra: everyday implementation.
- 5.4 Mini: bounded tests and mechanical verification.
- 5.5: adversarial review of high-risk changes.

Models may change as availability and measured performance change. Canonical role meaning, authority, and evidence contracts remain separate from those mappings.

## Architecture alignment

Material reusable architecture must receive an alignment/proportionality review before implementation. The review compares the founder's original request with the proposed problem, abstraction, generic/local boundary, maintenance consequences, alternatives, and non-capabilities.

Implementation receives a separate correctness/safety review. Passing implementation tests does not establish that the selected architecture solves the intended problem.

## Subscription-only operation

Codex is authenticated with ChatGPT. This Mac's user-level Codex configuration forces ChatGPT login; authentication is intentionally not committed to the repository. Before every worker run, the wrapper removes `OPENAI_API_KEY` and requires `codex login status` to report `Logged in using ChatGPT`. This verifies the authentication route used on this machine; it is not a general billing guarantee for modified Codex installations or other providers.

The wrapper accepts either a project agent name or an explicit model, plus a working directory and prompt. With `--agent`, it reads the matching `.codex/agents/*.toml`, applies its model, reasoning effort, and sandbox, and places its role instructions before the parent assignment in the ordinary user prompt. It rejects model or sandbox overrides so those target settings cannot silently diverge. The role text does not receive native developer-instruction priority; a conflicting parent assignment can therefore weaken its effect and must not be reported as exact native role invocation. By default the wrapper passes `--ignore-user-config` while retaining saved ChatGPT authentication:

```bash
scripts/codex-worker.sh \
  --agent mycelium_product_researcher \
  --workdir "$PWD" \
  --prompt "Map the graph-provider cache and report risks. Do not edit files."
```

Use `--model` and `--sandbox` only for an explicitly non-role worker. The worker command is a separate non-interactive Codex execution that returns its final message; it is not evidence that the native parent-session subagent interface selected the custom role.

Writing workers should run in a dedicated clean worktree with `--sandbox workspace-write`. The wrapper refuses a dirty writing worktree unless a human or lead agent deliberately passes the unsafe `--allow-dirty` override after reviewing ownership.

## Required evidence in every handoff

- Active GitHub issue and acceptance criteria.
- Stable role ID and effective target mapping.
- Branch and commit or dirty-diff state.
- Files changed and why.
- Commands run with exact outcomes.
- Risks, assumptions, and checks not run.
- Independent-review verdict and unresolved findings.
- Obsidian note updated or created for the sprint.
- Authority still required for PR, merge, or release.

## GitHub and Obsidian responsibilities

Product implementation is executed and evidenced through GitHub issues, branches, pull requests, tests, reviews, releases, and current code/runtime state.

Obsidian contains the canonical AI Team content and preserves research, decisions, plans, evidence, and the development story. A completed sprint note is historical context; it is not proof of current product behavior.
