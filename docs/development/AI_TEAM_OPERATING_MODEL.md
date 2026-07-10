# AI Team Operating Model

This repository uses a founder-directed, AI-executed development model. `AGENTS.md` is the authoritative repository instruction surface; this document explains the operational sequence for humans.

## Team shape

The lead model owns product synthesis, architecture, delegation, integration, and final review. Lower-cost specialists perform bounded research, repository exploration, implementation, testing, and independent review. Their project definitions live in `.codex/agents/` and return results directly to the lead session.

Native Codex subagents in a normal trusted-project session are the default. `scripts/codex-worker.sh` is the deterministic single-agent, non-interactive option for a separately selected model, especially in an isolated worktree. Hermes may later provide persistent Kanban or scheduled swarms, but it is not required for the core sprint workflow.

## Sprint sequence

1. **Orient:** verify branch, release, worktree, open PRs/issues, active Obsidian sprint note, and current runtime.
2. **Ratify scope:** define goal, non-goals, authority, acceptance criteria, evidence, and file ownership.
3. **Branch:** create one focused branch. Create additional Git worktrees only for genuinely independent writers.
4. **Implement:** use small commits and targeted tests. Keep product changes separate from unrelated cleanup.
5. **Verify:** build, targeted tests, `npm test`, `npm run test:coverage`, and applicable live tests.
6. **Review:** run an independent adversarial review and resolve findings with evidence.
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

## Model allocation

Use the project agent definitions as defaults, not permanent product constraints:

- SOL: lead, architecture, final synthesis.
- Luna: inexpensive research and repository discovery.
- Terra: everyday implementation.
- 5.4 Mini: bounded tests and mechanical verification.
- 5.5: adversarial review of high-risk changes.

Models may change as availability and measured performance change. Role instructions and quality gates are the stable part.

## Subscription-only operation

Codex is authenticated with ChatGPT. This Mac's user-level Codex configuration forces ChatGPT login; authentication is intentionally not committed to the repository. Before every worker run, the wrapper removes `OPENAI_API_KEY` and requires `codex login status` to report `Logged in using ChatGPT`. This verifies the authentication route used on this machine; it is not a general billing guarantee for modified Codex installations or other providers.

The wrapper accepts a model, sandbox, working directory, and prompt. By default it passes `--ignore-user-config` while retaining saved ChatGPT authentication. In the verified Codex 0.144.1 behavior, that isolated mode did not register project custom-agent profiles as callable agent types. Use a normal trusted-project Codex session, or pass `--with-user-config`, when those profiles are required:

```bash
scripts/codex-worker.sh \
  --model gpt-5.6-luna \
  --sandbox read-only \
  --workdir "$PWD" \
  --prompt "Map the graph-provider cache and report risks. Do not edit files."
```

Writing workers should run in a dedicated clean worktree with `--sandbox workspace-write`. The wrapper refuses a dirty writing worktree unless a human or lead agent deliberately passes the unsafe `--allow-dirty` override after reviewing ownership.

## Required evidence in every handoff

- Branch and commit or dirty-diff state.
- Files changed and why.
- Commands run with exact outcomes.
- Risks, assumptions, and checks not run.
- Independent-review verdict and unresolved findings.
- Obsidian note updated or created for the sprint.
- Authority still required for PR, merge, or release.
