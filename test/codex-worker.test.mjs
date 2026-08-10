import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const worker = path.join(repoRoot, "scripts", "codex-worker.sh");

async function fixture(agentToml) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-worker-"));
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  const capture = path.join(root, "capture.txt");
  await mkdir(bin);
  await mkdir(worktree);
  const gitInit = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  await mkdir(path.join(worktree, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(worktree, ".codex", "agents", "test.toml"), agentToml);
  await writeFile(
    path.join(bin, "codex"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  printf 'Logged in using ChatGPT\\n'
  exit 0
fi
{
  printf 'OPENAI_API_KEY=%s\\n' "\${OPENAI_API_KEY-unset}"
  printf 'ARG=%s\\n' "$@"
} > "$CAPTURE_FILE"
`,
  );
  await chmod(path.join(bin, "codex"), 0o755);
  return { root, worktree, capture, bin };
}

function run(args, context) {
  return spawnSync("bash", [worker, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "must-not-reach-child",
      CAPTURE_FILE: context.capture,
      PATH: `${context.bin}:${process.env.PATH}`,
    },
  });
}

const validAgent = `name = "test_researcher"
description = "Test researcher"
model = "gpt-test-model"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
Act as the test researcher.
Return evidence only.
"""
`;

test("--agent applies project target settings, prompt prefix, and subscription safeguards", async () => {
  const context = await fixture(validAgent);
  const result = run(
    ["--agent", "test_researcher", "--workdir", context.worktree, "--prompt", "Map the repository."],
    context,
  );

  assert.equal(result.status, 0, result.stderr);
  const capture = await readFile(context.capture, "utf8");
  assert.match(capture, /OPENAI_API_KEY=unset/);
  assert.match(capture, /ARG=--model\nARG=gpt-test-model/);
  assert.match(capture, /ARG=--sandbox\nARG=read-only/);
  assert.match(capture, /ARG=--config\nARG=model_reasoning_effort="medium"/);
  assert.match(capture, /ARG=--ignore-user-config/);
  assert.match(capture, /Act as the test researcher\./);
  assert.match(capture, /Parent assignment:\nMap the repository\./);
});

test("tracked adversarial reviewer adapter forwards the SOL xhigh target", async () => {
  const context = await fixture(validAgent);
  const result = run(
    [
      "--agent",
      "mycelium_adversarial_reviewer",
      "--workdir",
      repoRoot,
      "--prompt",
      "Review Gate 0.",
    ],
    context,
  );

  assert.equal(result.status, 0, result.stderr);
  const capture = await readFile(context.capture, "utf8");
  assert.match(capture, /ARG=--model\nARG=gpt-5\.6-sol/);
  assert.match(capture, /ARG=--sandbox\nARG=read-only/);
  assert.match(capture, /ARG=--config\nARG=model_reasoning_effort="xhigh"/);
  assert.match(capture, /canonical role mycelium-obsidian\.ai-role\.independent-adversarial-reviewer/);
  assert.match(capture, /Parent assignment:\nReview Gate 0\./);
});

test("--agent rejects unknown role names", async () => {
  const context = await fixture(validAgent);
  const result = run(
    ["--agent", "missing_agent", "--workdir", context.worktree, "--prompt", "Do work."],
    context,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown project agent: missing_agent/);
});

test("--agent rejects model and sandbox overrides", async () => {
  const context = await fixture(validAgent);
  const modelResult = run(
    [
      "--agent",
      "test_researcher",
      "--model",
      "gpt-other",
      "--workdir",
      context.worktree,
      "--prompt",
      "Do work.",
    ],
    context,
  );
  const sandboxResult = run(
    [
      "--agent",
      "test_researcher",
      "--sandbox",
      "workspace-write",
      "--workdir",
      context.worktree,
      "--prompt",
      "Do work.",
    ],
    context,
  );

  assert.equal(modelResult.status, 2);
  assert.match(modelResult.stderr, /Use either --agent or --model/);
  assert.equal(sandboxResult.status, 2);
  assert.match(sandboxResult.stderr, /agent supplies its own sandbox/);
});

test("--agent rejects incomplete role definitions", async () => {
  const context = await fixture(`name = "broken_agent"\nmodel = "gpt-test-model"\n`);
  const result = run(
    ["--agent", "broken_agent", "--workdir", context.worktree, "--prompt", "Do work."],
    context,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unable to read developer_instructions|missing a required worker field/);
});

test("--agent rejects duplicate role names", async () => {
  const context = await fixture(validAgent);
  await writeFile(
    path.join(context.worktree, ".codex", "agents", "duplicate.toml"),
    validAgent,
  );
  const result = run(
    ["--agent", "test_researcher", "--workdir", context.worktree, "--prompt", "Do work."],
    context,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Project agent name is not unique: test_researcher/);
});

test("agent-derived workspace-write refuses a dirty worktree", async () => {
  const context = await fixture(validAgent.replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'));
  const result = run(
    ["--agent", "test_researcher", "--workdir", context.worktree, "--prompt", "Do work."],
    context,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing workspace-write in a dirty worktree/);
});
