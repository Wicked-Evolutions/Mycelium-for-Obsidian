import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_PAYLOAD_END_MARKER,
  CANONICAL_PAYLOAD_START_MARKER,
  collectArtifactDigests,
  computeDistributionRevision,
  hashCanonicalPayload,
  hashFile,
  validateAgentTomlContent,
  validateDistribution,
  validateManifestSchema,
} from "../scripts/validate-ai-team-distribution.mjs";

const tempRoots = [];
const LOCATOR =
  "obsidian://open?vault=Example%20Vault&file=GPT%20Dev%20Team%2FOPERATING%20MODEL%20%E2%80%94%20AI%20Development%20Team";
const TIMESTAMP = "2026-07-11T10:15:30Z";
const REVIEWER_ROLE_ID = "mycelium-obsidian.ai-role.independent-adversarial-reviewer";
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const roleDefinitions = [
  {
    canonicalRoleId: "mycelium-obsidian.ai-role.principal-development-orchestrator",
    roleName: "Principal Development Orchestrator",
    targetKind: "main-session",
    targetArtifact: "AGENTS.md",
    targetName: "main-session",
    model: "gpt-5.6-sol",
    reasoningEffort: "session-selected",
    sandboxMode: "inherited-session-permissions",
  },
  {
    canonicalRoleId: "mycelium-obsidian.ai-role.product-knowledge-researcher",
    roleName: "Product and Knowledge Researcher",
    targetKind: "custom-agent",
    targetArtifact: ".codex/agents/mycelium-product-researcher.toml",
    targetName: "mycelium_product_researcher",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    sandboxMode: "read-only",
  },
  {
    canonicalRoleId: "mycelium-obsidian.ai-role.repository-runtime-explorer",
    roleName: "Repository and Runtime Explorer",
    targetKind: "custom-agent",
    targetArtifact: ".codex/agents/mycelium-repository-explorer.toml",
    targetName: "mycelium_repository_explorer",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    sandboxMode: "read-only",
  },
  {
    canonicalRoleId: "mycelium-obsidian.ai-role.scoped-implementer",
    roleName: "Scoped Implementer",
    targetKind: "custom-agent",
    targetArtifact: ".codex/agents/mycelium-implementer.toml",
    targetName: "mycelium_implementer",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
  },
  {
    canonicalRoleId: "mycelium-obsidian.ai-role.verification-test-engineer",
    roleName: "Verification and Test Engineer",
    targetKind: "custom-agent",
    targetArtifact: ".codex/agents/mycelium-test-engineer.toml",
    targetName: "mycelium_test_engineer",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
  },
  {
    canonicalRoleId: REVIEWER_ROLE_ID,
    roleName: "Independent Adversarial Reviewer",
    targetKind: "custom-agent",
    targetArtifact: ".codex/agents/mycelium-adversarial-reviewer.toml",
    targetName: "mycelium_adversarial_reviewer",
    model: "gpt-5.5",
    reasoningEffort: "high",
    sandboxMode: "read-only",
  },
];

const artifactClassifications = new Map([
  [".codex/agents/mycelium-adversarial-reviewer.toml", "role-transformation"],
  [".codex/agents/mycelium-implementer.toml", "role-transformation"],
  [".codex/agents/mycelium-product-researcher.toml", "role-transformation"],
  [".codex/agents/mycelium-repository-explorer.toml", "role-transformation"],
  [".codex/agents/mycelium-test-engineer.toml", "role-transformation"],
  [".codex/config.toml", "orchestration-policy"],
  [".github/PULL_REQUEST_TEMPLATE.md", "workflow-adaptation"],
  [".github/workflows/ci.yml", "ci-integration"],
  ["AGENTS.md", "composite-repository-instructions"],
  ["CONTRIBUTING.md", "public-summary"],
  ["docs/development/AI_TEAM_OPERATING_MODEL.md", "distribution-runbook"],
  ["docs/development/SPRINT_TEMPLATE.md", "workflow-adaptation"],
  ["package.json", "local-validation-entrypoint"],
  ["scripts/codex-worker.sh", "generic-execution-adapter"],
  ["scripts/validate-ai-team-distribution.mjs", "distribution-validator"],
]);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFixtureFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

function agentToml(role) {
  return [
    `name = "${role.targetName}"`,
    `description = "Fixture transformation for ${role.roleName}."`,
    `model = "${role.model}"`,
    `model_reasoning_effort = "${role.reasoningEffort}"`,
    `sandbox_mode = "${role.sandboxMode}"`,
    'developer_instructions = """',
    `You are canonical role ${role.canonicalRoleId}.`,
    "Preserve the bounded fixture contract.",
    '"""',
    "",
  ].join("\n");
}

function originDocument(payload = "canonical draft payload\n") {
  return [
    "---",
    "status: draft-for-j-review",
    "receipt: null",
    `canonical_payload_start_marker: '${CANONICAL_PAYLOAD_START_MARKER}'`,
    `canonical_payload_end_marker: '${CANONICAL_PAYLOAD_END_MARKER}'`,
    "---",
    "Metadata outside the payload.",
    CANONICAL_PAYLOAD_START_MARKER,
    payload,
    CANONICAL_PAYLOAD_END_MARKER,
    "Release history and receipts outside the payload.",
    "",
  ].join("\n");
}

function encodeRepeatedly(value, count) {
  let encoded = value;
  for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mycelium-ai-team-"));
  tempRoots.push(root);
  const originContent = originDocument();
  const originFile = await writeFixtureFile(root, "private-origin.md", originContent);

  for (const [artifactPath] of artifactClassifications) {
    const role = roleDefinitions.find((entry) => entry.targetArtifact === artifactPath);
    await writeFixtureFile(root, artifactPath, role?.targetKind === "custom-agent" ? agentToml(role) : `${artifactPath}\n`);
  }

  const artifacts = [];
  for (const [artifactPath, classification] of artifactClassifications) {
    artifacts.push({
      path: artifactPath,
      classification,
      sha256: await hashFile(path.join(root, artifactPath)),
    });
  }

  const distributionRevision = computeDistributionRevision(artifacts);
  const manifest = {
    schemaVersion: 2,
    manifestId: "mycelium-obsidian.ai-team.codex-distribution",
    canonicalTeamId: "mycelium-obsidian.ai-team.operating-model",
    source: {
      canonicalId: "mycelium-obsidian.ai-team.operating-model",
      locator: LOCATOR,
      lifecycleState: "origin-draft",
      originRevision: "0.1-draft+fixture",
      decisionOwner: "J",
      canonicalRoleRelease: null,
      ratificationReceipt: null,
      payloadDigestAlgorithm: "sha256",
      payloadDigestScope: "marker-delimited-utf8-bytes-v1",
      payloadDigestState: "candidate-payload-recorded",
      payloadDigest: hashCanonicalPayload(originContent),
    },
    target: {
      platform: "codex",
      repository: "Wicked-Evolutions/Mycelium-for-Obsidian",
      baselineCommit: "6a0915708bc54ec68681ecad7410af4c8ded7f8c",
      candidateBranch: "docs/canonical-ai-team-origin",
      supportedCodexVersion: "0.144.1",
      reconciledAt: "2026-07-11",
      lifecycleState: "candidate-unverified",
      integrityState: "consistent",
      distributionRevision,
      candidateCommit: null,
      draftPrReceipt: null,
      semanticReconciliation: {
        state: "candidate-unreviewed",
        receipt: null,
      },
      runtimeEffectiveness: {
        state: "unverified",
        configParsing: "passed",
        exactRoleDiscovery: "unverified",
        exactRoleInvocation: "unverified",
        modelReasoningSandbox: "unverified",
        instructionSentinel: "unverified",
        receipt: null,
        blocker: "Exact-role receipt is pending.",
      },
      mergeReceipt: null,
    },
    roles: roleDefinitions.map((role) => ({ ...role, effectivenessState: "unverified" })),
    artifacts,
    hashPolicy: {
      algorithm: "sha256",
      encoding: "raw-file-bytes",
      artifactOrder: "lexicographic-path",
      artifactTupleEncoding:
        "json-stringified-sorted-[path,classification,sha256]-tuples-utf8-v1",
      distributionRevisionAlgorithm: "sha256",
      excludedPaths: ["docs/development/AI_TEAM_DISTRIBUTION.json"],
    },
  };

  return { root, originFile, manifest };
}

async function refreshArtifact(fixture, artifactPath) {
  const artifact = fixture.manifest.artifacts.find((entry) => entry.path === artifactPath);
  artifact.sha256 = await hashFile(path.join(fixture.root, artifactPath));
  fixture.manifest.target.distributionRevision = computeDistributionRevision(fixture.manifest.artifacts);
}

function setSemanticState(manifest, state) {
  manifest.target.semanticReconciliation = {
    state,
    receipt:
      state === "candidate-unreviewed"
        ? null
        : {
            authority: REVIEWER_ROLE_ID,
            decision: state,
            sprintId: "SPRINT-03",
            distributionRevision: manifest.target.distributionRevision,
            originRevision: manifest.source.originRevision,
            payloadDigest: manifest.source.payloadDigest,
            canonicalRoleRelease: manifest.source.canonicalRoleRelease,
            recordedAt: TIMESTAMP,
            evidence: "Sprint 03 independent adversarial review record.",
          },
  };
}

function setRuntimeVerified(manifest) {
  manifest.target.candidateCommit = "d".repeat(40);
  manifest.target.draftPrReceipt = {
    authority: "GitHub",
    decision: "draft-pr-opened",
    distributionRevision: manifest.target.distributionRevision,
    candidateCommit: manifest.target.candidateCommit,
    prNumber: 51,
    url: "https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/pull/51",
    recordedAt: TIMESTAMP,
  };
  manifest.target.lifecycleState = "candidate-verified";
  manifest.target.runtimeEffectiveness = {
    state: "verified",
    configParsing: "passed",
    exactRoleDiscovery: "passed",
    exactRoleInvocation: "passed",
    modelReasoningSandbox: "passed",
    instructionSentinel: "passed",
    receipt: {
      authority: "Codex exact-role verification gate",
      decision: "runtime-verified",
      distributionRevision: manifest.target.distributionRevision,
      supportedCodexVersion: manifest.target.supportedCodexVersion,
      recordedAt: TIMESTAMP,
      evidence: "Exact-role invocation evidence bundle.",
    },
    blocker: null,
  };
  manifest.roles.forEach((role) => {
    role.effectivenessState = "verified";
  });
}

function releaseCanonicalSource(manifest) {
  manifest.source.lifecycleState = "canonical-release";
  manifest.source.canonicalRoleRelease = "ai-team-2026.07";
  manifest.source.payloadDigestState = "ratified-payload";
  manifest.source.ratificationReceipt = {
    authority: "J",
    decision: "ratified",
    canonicalRoleRelease: manifest.source.canonicalRoleRelease,
    originRevision: manifest.source.originRevision,
    payloadDigest: manifest.source.payloadDigest,
    recordedAt: TIMESTAMP,
    evidence: "Gate A founder ratification record.",
  };
}

function mergeDistribution(manifest) {
  manifest.target.lifecycleState = "merged";
  manifest.target.mergeReceipt = {
    authority: "J",
    decision: "merged",
    distributionRevision: manifest.target.distributionRevision,
    canonicalRoleRelease: manifest.source.canonicalRoleRelease,
    candidateCommit: manifest.target.candidateCommit,
    mergedCommit: "a".repeat(40),
    recordedAt: TIMESTAMP,
    evidence: "Gate B founder-authorized merge record.",
  };
}

test("validates a consistent draft candidate and the exact marker-delimited origin payload", async () => {
  const fixture = await makeFixture();
  const result = await validateDistribution({
    manifest: fixture.manifest,
    repoRoot: fixture.root,
    originFile: fixture.originFile,
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.integrityState, "consistent");
  assert.equal(result.semanticState, "candidate-unreviewed");
  assert.equal(result.runtimeEffectiveness, "unverified");
  assert.equal(result.originComparison, "verified");
  assert.equal(result.artifactCount, 15);
});

test("marker hashing ignores metadata outside the markers and preserves exact payload bytes", () => {
  const baseline = originDocument("semantic payload\n\n");
  const outsideEdit = baseline
    .replace("status: draft-for-j-review", "status: canonical-release")
    .replace("Release history", "Ratification receipt and release history");
  const insideEdit = baseline.replace("semantic payload", "changed semantic payload");

  assert.equal(hashCanonicalPayload(outsideEdit), hashCanonicalPayload(baseline));
  assert.notEqual(hashCanonicalPayload(insideEdit), hashCanonicalPayload(baseline));

  const lfPayload = `${CANONICAL_PAYLOAD_START_MARKER}\nvalue\n${CANONICAL_PAYLOAD_END_MARKER}`;
  const crlfPayload = `${CANONICAL_PAYLOAD_START_MARKER}\r\nvalue\r\n${CANONICAL_PAYLOAD_END_MARKER}`;
  assert.equal(hashCanonicalPayload(lfPayload), hashCanonicalPayload("x\n" + lfPayload + "\ny"));
  assert.notEqual(hashCanonicalPayload(lfPayload), hashCanonicalPayload(crlfPayload));
});

test("marker hashing rejects missing, duplicate, non-line, reversed, empty, and invalid UTF-8 payloads", () => {
  const duplicate = `${originDocument()}\n${CANONICAL_PAYLOAD_START_MARKER}\nextra\n`;
  const inline = `prefix ${CANONICAL_PAYLOAD_START_MARKER}\nvalue\n${CANONICAL_PAYLOAD_END_MARKER}`;
  const reversed = `${CANONICAL_PAYLOAD_END_MARKER}\nvalue\n${CANONICAL_PAYLOAD_START_MARKER}`;
  const empty = `${CANONICAL_PAYLOAD_START_MARKER}\n${CANONICAL_PAYLOAD_END_MARKER}`;
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`${CANONICAL_PAYLOAD_START_MARKER}\n`),
    Buffer.from([0xff]),
    Buffer.from(`\n${CANONICAL_PAYLOAD_END_MARKER}`),
  ]);

  assert.throws(() => hashCanonicalPayload("no markers"), /exactly one start marker/i);
  assert.throws(() => hashCanonicalPayload(duplicate), /exactly one start marker/i);
  assert.throws(() => hashCanonicalPayload(inline), /exactly one start marker/i);
  assert.throws(() => hashCanonicalPayload(reversed), /must follow/i);
  assert.throws(() => hashCanonicalPayload(empty), /must not be empty/i);
  assert.throws(() => hashCanonicalPayload(invalidUtf8), /encoded data was not valid/i);
});

test("CI validation does not require access to the private origin file", async () => {
  const fixture = await makeFixture();
  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.originComparison, "not-requested");
});

test("an explicit origin mismatch fails origin verification without reporting target drift", async () => {
  const fixture = await makeFixture();
  await writeFile(fixture.originFile, originDocument("changed canonical payload\n"));

  const result = await validateDistribution({
    manifest: fixture.manifest,
    repoRoot: fixture.root,
    originFile: fixture.originFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.originComparison, "failed");
  assert.equal(result.integrityState, "consistent");
  assert.equal(result.semanticState, "candidate-unreviewed");
  assert.match(result.errors.join("\n"), /canonical origin digest mismatch/i);
});

test("artifact drift is reported as inconsistent independently of semantic and runtime state", async () => {
  const fixture = await makeFixture();
  await writeFile(path.join(fixture.root, "AGENTS.md"), "downstream drift\n");

  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.integrityState, "inconsistent");
  assert.equal(result.semanticState, "candidate-unreviewed");
  assert.equal(result.runtimeEffectiveness, "unverified");
  assert.match(result.errors.join("\n"), /digest mismatch for AGENTS\.md/i);
});

test("distribution revision is a sorted artifact-tuple hash and a mismatch fails closed", async () => {
  const fixture = await makeFixture();
  const reversed = [...fixture.manifest.artifacts].reverse();
  assert.equal(
    computeDistributionRevision(reversed),
    fixture.manifest.target.distributionRevision,
    "tuple order must not change the revision",
  );

  fixture.manifest.target.distributionRevision = "b".repeat(64);
  const schema = validateManifestSchema(fixture.manifest);
  assert.match(schema.errors.join("\n"), /distributionRevision mismatch/i);
});

test("accepts each legal lifecycle transition with receipts bound to the exact revision", async () => {
  const fixture = await makeFixture();
  assert.deepEqual(validateManifestSchema(fixture.manifest).errors, []);

  setSemanticState(fixture.manifest, "candidate-reviewed");
  setRuntimeVerified(fixture.manifest);
  assert.deepEqual(validateManifestSchema(fixture.manifest).errors, []);

  releaseCanonicalSource(fixture.manifest);
  setSemanticState(fixture.manifest, "aligned-to-release");
  mergeDistribution(fixture.manifest);
  assert.deepEqual(validateManifestSchema(fixture.manifest).errors, []);
});

test("accepts four-state aggregate runtime and per-role effectiveness evidence", async () => {
  const unverified = await makeFixture();
  unverified.manifest.target.runtimeEffectiveness.exactRoleInvocation = "blocked";
  unverified.manifest.roles[1].effectivenessState = "unverified";
  assert.deepEqual(validateManifestSchema(unverified.manifest).errors, []);

  const failed = await makeFixture();
  failed.manifest.target.runtimeEffectiveness.state = "failed";
  failed.manifest.target.runtimeEffectiveness.exactRoleInvocation = "failed";
  failed.manifest.target.runtimeEffectiveness.blocker = "Exact role invocation failed.";
  failed.manifest.roles[1].effectivenessState = "failed";
  assert.deepEqual(validateManifestSchema(failed.manifest).errors, []);

  const blocked = await makeFixture();
  blocked.manifest.target.runtimeEffectiveness.state = "blocked";
  blocked.manifest.target.runtimeEffectiveness.exactRoleInvocation = "blocked";
  blocked.manifest.target.runtimeEffectiveness.blocker = "Subscription limit blocked invocation.";
  blocked.manifest.roles[1].effectivenessState = "blocked";
  assert.deepEqual(validateManifestSchema(blocked.manifest).errors, []);

  const verified = await makeFixture();
  setSemanticState(verified.manifest, "candidate-reviewed");
  setRuntimeVerified(verified.manifest);
  assert.deepEqual(validateManifestSchema(verified.manifest).errors, []);
});

test("rejects aggregate runtime states that contradict their evidence", async () => {
  const unverifiedFailure = await makeFixture();
  unverifiedFailure.manifest.target.runtimeEffectiveness.exactRoleInvocation = "failed";
  let errors = validateManifestSchema(unverifiedFailure.manifest).errors.join("\n");
  assert.match(errors, /Unverified runtime must not contain failed evidence fields/i);

  const failedWithoutFailure = await makeFixture();
  failedWithoutFailure.manifest.target.runtimeEffectiveness.state = "failed";
  errors = validateManifestSchema(failedWithoutFailure.manifest).errors.join("\n");
  assert.match(errors, /Failed runtime requires at least one failed evidence field/i);

  const blockedWithoutBlockerEvidence = await makeFixture();
  blockedWithoutBlockerEvidence.manifest.target.runtimeEffectiveness.state = "blocked";
  errors = validateManifestSchema(blockedWithoutBlockerEvidence.manifest).errors.join("\n");
  assert.match(errors, /Blocked runtime requires at least one blocked evidence field/i);

  const blockedWithFailure = await makeFixture();
  blockedWithFailure.manifest.target.runtimeEffectiveness.state = "blocked";
  blockedWithFailure.manifest.target.runtimeEffectiveness.exactRoleInvocation = "blocked";
  blockedWithFailure.manifest.target.runtimeEffectiveness.instructionSentinel = "failed";
  errors = validateManifestSchema(blockedWithFailure.manifest).errors.join("\n");
  assert.match(errors, /Blocked runtime must not contain failed evidence fields/i);

  const verifiedWithFailedRole = await makeFixture();
  setSemanticState(verifiedWithFailedRole.manifest, "candidate-reviewed");
  setRuntimeVerified(verifiedWithFailedRole.manifest);
  verifiedWithFailedRole.manifest.roles[1].effectivenessState = "failed";
  errors = validateManifestSchema(verifiedWithFailedRole.manifest).errors.join("\n");
  assert.match(errors, /requires every role effectivenessState to be verified/i);

  const invalidRoleState = await makeFixture();
  invalidRoleState.manifest.roles[1].effectivenessState = "maybe";
  errors = validateManifestSchema(invalidRoleState.manifest).errors.join("\n");
  assert.match(errors, /effectivenessState must be unverified, verified, failed, or blocked/i);
});

test("a failed role requires failed aggregate runtime state", async () => {
  const unverified = await makeFixture();
  unverified.manifest.roles[1].effectivenessState = "failed";
  let errors = validateManifestSchema(unverified.manifest).errors.join("\n");
  assert.match(errors, /failed role effectivenessState requires .*runtimeEffectiveness\.state to be failed/i);

  const blocked = await makeFixture();
  blocked.manifest.target.runtimeEffectiveness.state = "blocked";
  blocked.manifest.target.runtimeEffectiveness.exactRoleInvocation = "blocked";
  blocked.manifest.roles[1].effectivenessState = "failed";
  errors = validateManifestSchema(blocked.manifest).errors.join("\n");
  assert.match(errors, /failed role effectivenessState requires .*runtimeEffectiveness\.state to be failed/i);

  const verified = await makeFixture();
  setSemanticState(verified.manifest, "candidate-reviewed");
  setRuntimeVerified(verified.manifest);
  verified.manifest.roles[1].effectivenessState = "failed";
  errors = validateManifestSchema(verified.manifest).errors.join("\n");
  assert.match(errors, /failed role effectivenessState requires .*runtimeEffectiveness\.state to be failed/i);

  const failed = await makeFixture();
  failed.manifest.target.runtimeEffectiveness.state = "failed";
  failed.manifest.target.runtimeEffectiveness.exactRoleInvocation = "failed";
  failed.manifest.roles[1].effectivenessState = "failed";
  assert.deepEqual(validateManifestSchema(failed.manifest).errors, []);
});

test("rejects illegal draft, verified, and merged lifecycle combinations", async () => {
  const draftMerged = await makeFixture();
  draftMerged.manifest.target.lifecycleState = "merged";
  let errors = validateManifestSchema(draftMerged.manifest).errors.join("\n");
  assert.match(errors, /merged target requires a canonical-release source/i);
  assert.match(errors, /merged target requires semantic state aligned-to-release/i);
  assert.match(errors, /merged target requires a verified runtime/i);

  const unverifiedCandidate = await makeFixture();
  unverifiedCandidate.manifest.target.lifecycleState = "candidate-verified";
  errors = validateManifestSchema(unverifiedCandidate.manifest).errors.join("\n");
  assert.match(errors, /candidate-verified target requires a verified runtime/i);
  assert.match(errors, /candidate-verified target requires semantic state candidate-reviewed/i);
  assert.match(errors, /requires candidateCommit and a bound draftPrReceipt/i);
  assert.match(errors, /requires every role effectivenessState to be verified/i);

  const releaseWithoutReceipt = await makeFixture();
  releaseWithoutReceipt.manifest.source.lifecycleState = "canonical-release";
  releaseWithoutReceipt.manifest.source.canonicalRoleRelease = "ai-team-2026.07";
  releaseWithoutReceipt.manifest.source.payloadDigestState = "ratified-payload";
  errors = validateManifestSchema(releaseWithoutReceipt.manifest).errors.join("\n");
  assert.match(errors, /source\.ratificationReceipt must be an object/i);
});

test("semantic, runtime, and merge receipts cannot survive a distribution revision change", async () => {
  const fixture = await makeFixture();
  setSemanticState(fixture.manifest, "candidate-reviewed");
  setRuntimeVerified(fixture.manifest);
  releaseCanonicalSource(fixture.manifest);
  setSemanticState(fixture.manifest, "aligned-to-release");
  mergeDistribution(fixture.manifest);
  fixture.manifest.target.distributionRevision = "c".repeat(64);

  const errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /semanticReconciliation\.receipt\.distributionRevision is stale/i);
  assert.match(errors, /runtimeEffectiveness\.receipt\.distributionRevision is stale/i);
  assert.match(errors, /draftPrReceipt\.distributionRevision is stale/i);
  assert.match(errors, /mergeReceipt\.distributionRevision is stale/i);
  assert.match(errors, /distributionRevision mismatch/i);
});

test("unknown fields and plain or repeatedly encoded machine-local paths fail closed", async () => {
  const fixture = await makeFixture();
  fixture.manifest.target.semanticReconciliation.unknown = true;
  fixture.manifest.target.candidateBranch = "/Users/wicked/private";

  let errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /semanticReconciliation has unsupported field "unknown"/i);
  assert.match(errors, /machine-local absolute path, including encoded forms/i);

  fixture.manifest.target.candidateBranch = "%252FUsers%252Fwicked%252Fprivate";
  errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /machine-local absolute path, including encoded forms/i);

  fixture.manifest.target.candidateBranch = encodeRepeatedly("/Users/wicked/private", 8);
  errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /machine-local absolute path, including encoded forms/i);

  for (const multiSlashPath of ["//Users/wicked/private", "///Users/wicked/private"]) {
    fixture.manifest.target.candidateBranch = multiSlashPath;
    errors = validateManifestSchema(fixture.manifest).errors.join("\n");
    assert.match(errors, /machine-local absolute path, including encoded forms/i);
  }
});

test("locator validation rejects duplicate, extra, fragmented, path-like vault, and unsafe file forms", async () => {
  const fixture = await makeFixture();
  const invalidLocators = [
    "obsidian://open?vault=A&vault=B&file=Note",
    "obsidian://open?vault=A&file=Note&extra=value",
    "obsidian://open?vault=A&&file=Note",
    "obsidian://open?vault=A&file=Note&",
    "OBSIDIAN://OPEN?vault=A&file=Note",
    "obsidian://open?vault=A&file=Note#heading",
    "obsidian://open/path?vault=A&file=Note",
    "obsidian://open?vault=Parent%2FVault&file=Note",
    "obsidian://open?vault=Parent%252FVault&file=Note",
    "obsidian://open?vault=A&file=..%2FSecret",
    "obsidian://open?vault=A&file=..%252FSecret",
    "obsidian://open?vault=A&file=%2FUsers%2Fwicked%2FSecret",
    "obsidian://open?vault=A&file=%252FUsers%252Fwicked%252FSecret",
    "obsidian://open?vault=A&file=file%3A%2F%2Fsecret",
    "obsidian://open?vault=A&file=Bad%ZZEncoding",
  ];

  for (const locator of invalidLocators) {
    fixture.manifest.source.locator = locator;
    assert.notEqual(
      validateManifestSchema(fixture.manifest).errors.length,
      0,
      `expected invalid locator: ${locator}`,
    );
  }

  fixture.manifest.source.locator =
    `obsidian://open?vault=A&file=${encodeRepeatedly("/Users/wicked/Secret", 8)}`;
  assert.match(
    validateManifestSchema(fixture.manifest).errors.join("\n"),
    /machine-local absolute path|relative, traversal-free vault path/i,
  );
});

test("artifact hashing and hash collection reject artifact symlinks", async () => {
  const fixture = await makeFixture();
  await rm(path.join(fixture.root, "AGENTS.md"));
  await symlink(fixture.originFile, path.join(fixture.root, "AGENTS.md"));

  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });
  assert.equal(result.integrityState, "inconsistent");
  assert.match(result.errors.join("\n"), /must not be a symbolic link/i);
  await assert.rejects(
    () => collectArtifactDigests(fixture.manifest, fixture.root),
    /must not be a symbolic link/i,
  );
});

test("artifact hashing rejects a parent-directory symlink escape", async () => {
  const fixture = await makeFixture();
  const external = await mkdtemp(path.join(tmpdir(), "mycelium-ai-team-external-"));
  tempRoots.push(external);
  const ciPath = path.join(fixture.root, ".github/workflows/ci.yml");
  const ciContent = await readFile(ciPath);
  await rm(path.join(fixture.root, ".github/workflows"), { recursive: true });
  await writeFixtureFile(external, "ci.yml", ciContent);
  await symlink(external, path.join(fixture.root, ".github/workflows"));

  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });
  assert.equal(result.integrityState, "inconsistent");
  assert.match(result.errors.join("\n"), /parent directory symlink escapes repository root/i);
});

test("agent TOML validation requires exact keys, multiline instructions, and role ID in instructions", async () => {
  const fixture = await makeFixture();
  const role = fixture.manifest.roles[1];
  const valid = agentToml(role);
  assert.deepEqual(validateAgentTomlContent(valid, role).errors, []);

  const duplicate = valid.replace(
    `name = "${role.targetName}"`,
    `name = "${role.targetName}"\nname = "${role.targetName}"`,
  );
  assert.match(validateAgentTomlContent(duplicate, role).errors.join("\n"), /name must appear exactly once/i);

  const emptyDescription = valid.replace(/description = ".*"/, 'description = ""');
  assert.match(validateAgentTomlContent(emptyDescription, role).errors.join("\n"), /description must be non-empty/i);

  const singleLineInstructions = valid.replace(
    /developer_instructions = """[\s\S]*?"""/,
    'developer_instructions = "single line"',
  );
  assert.match(
    validateAgentTomlContent(singleLineInstructions, role).errors.join("\n"),
    /must use a multiline triple-double-quoted/i,
  );

  const idOnlyInComment = valid
    .replace(role.canonicalRoleId, "different-role")
    .replace(/^/, `# ${role.canonicalRoleId}\n`);
  assert.match(
    validateAgentTomlContent(idOnlyInComment, role).errors.join("\n"),
    /developer_instructions must contain canonical role ID/i,
  );

  const malformed = valid.replace(`model = "${role.model}"`, `model: "${role.model}"`);
  assert.match(validateAgentTomlContent(malformed, role).errors.join("\n"), /malformed top-level TOML/i);
});

test("models, reasoning, and sandbox values are mutable when manifest and TOML agree", async () => {
  const fixture = await makeFixture();
  const role = fixture.manifest.roles[1];
  role.model = "provider-current-research-model";
  role.reasoningEffort = "high";
  role.sandboxMode = "workspace-write";
  await writeFile(path.join(fixture.root, role.targetArtifact), agentToml(role));
  await refreshArtifact(fixture, role.targetArtifact);

  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("unmanifested extra custom-agent TOMLs fail the distribution", async () => {
  const fixture = await makeFixture();
  await writeFixtureFile(fixture.root, ".codex/agents/unmanifested.toml", "name = \"unexpected\"\n");

  const result = await validateDistribution({ manifest: fixture.manifest, repoRoot: fixture.root });
  assert.equal(result.integrityState, "inconsistent");
  assert.match(result.errors.join("\n"), /unmanifested custom-agent TOML/i);
});

test("candidate and merge receipts bind the revision, commit, PR URL, and founder merge authority", async () => {
  const fixture = await makeFixture();
  setSemanticState(fixture.manifest, "candidate-reviewed");
  setRuntimeVerified(fixture.manifest);
  fixture.manifest.target.draftPrReceipt.candidateCommit = "e".repeat(40);
  fixture.manifest.target.draftPrReceipt.prNumber = 0;
  fixture.manifest.target.draftPrReceipt.url = "https://example.com/pull/51";

  let errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /draftPrReceipt\.candidateCommit must bind/i);
  assert.match(errors, /draftPrReceipt\.prNumber must be a positive safe integer/i);
  assert.match(errors, /draftPrReceipt\.url must be https:\/\/github\.com/i);

  fixture.manifest.target.draftPrReceipt.candidateCommit = fixture.manifest.target.candidateCommit;
  fixture.manifest.target.draftPrReceipt.prNumber = 51;
  fixture.manifest.target.draftPrReceipt.url =
    "https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/pull/51";
  releaseCanonicalSource(fixture.manifest);
  setSemanticState(fixture.manifest, "aligned-to-release");
  mergeDistribution(fixture.manifest);
  fixture.manifest.target.mergeReceipt.authority = "not-J";
  fixture.manifest.target.mergeReceipt.candidateCommit = "f".repeat(40);
  errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /mergeReceipt\.authority must be J/i);
  assert.match(errors, /mergeReceipt\.candidateCommit must bind/i);
});

test("CI invokes the hashed validator directly before coverage and package exposes local entrypoints", async () => {
  const ci = await readFile(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const directValidator = "run: node scripts/validate-ai-team-distribution.mjs";
  const coverage = "run: npm run test:coverage";
  assert.ok(ci.includes(directValidator), "CI must invoke the validator script directly");
  assert.ok(ci.indexOf(directValidator) < ci.indexOf(coverage), "validator must run before coverage");

  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["validate:ai-team"],
    "node scripts/validate-ai-team-distribution.mjs",
  );
  assert.equal(
    packageJson.scripts["validate:ai-team:hashes"],
    "node scripts/validate-ai-team-distribution.mjs --print-artifact-hashes",
  );
});

test("repository guidance requires exact custom-role selection and bounded runtime probes", async () => {
  const agentsMd = await readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
  const runbook = await readFile(path.join(REPO_ROOT, "docs/development/AI_TEAM_OPERATING_MODEL.md"), "utf8");
  const testAgent = await readFile(
    path.join(REPO_ROOT, ".codex/agents/mycelium-test-engineer.toml"),
    "utf8",
  );

  for (const content of [agentsMd, runbook]) {
    assert.match(content, /`agent_type`/);
    assert.match(content, /`fork_turns: "none"`/);
    assert.match(content, /`task_name` labels the child task path/i);
    assert.match(content, /full-history fork inherits the parent agent type/i);
  }

  assert.match(testAgent, /Do not invent a verification assignment or full gate\./);
  assert.match(testAgent, /metadata\/runtime probe, no-tool check, or exact-output sentinel/);
  assert.match(testAgent, /without inspecting files, running commands, or broadening the task/);
});

test("manifest self-hashing, omitted CI/package entries, and wrong classifications fail closed", async () => {
  const fixture = await makeFixture();
  fixture.manifest.artifacts = fixture.manifest.artifacts.filter(
    (artifact) => artifact.path !== ".github/workflows/ci.yml" && artifact.path !== "package.json",
  );
  fixture.manifest.artifacts.push({
    path: "docs/development/AI_TEAM_DISTRIBUTION.json",
    classification: "distribution-manifest",
    sha256: "a".repeat(64),
  });
  fixture.manifest.artifacts[0].classification = "wrong";

  const errors = validateManifestSchema(fixture.manifest).errors.join("\n");
  assert.match(errors, /must not hash the manifest itself/i);
  assert.match(errors, /missing required distribution artifact \.github\/workflows\/ci\.yml/i);
  assert.match(errors, /missing required distribution artifact package\.json/i);
  assert.match(errors, /classification must be role-transformation/i);
  assert.match(errors, /artifacts must contain exactly 15 entries/i);
});
