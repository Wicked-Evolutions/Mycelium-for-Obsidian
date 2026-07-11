#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_PAYLOAD_START_MARKER = "<!-- canonical-payload:start -->";
export const CANONICAL_PAYLOAD_END_MARKER = "<!-- canonical-payload:end -->";

const MANIFEST_RELATIVE_PATH = "docs/development/AI_TEAM_DISTRIBUTION.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PAYLOAD_DIGEST_SCOPE = "marker-delimited-utf8-bytes-v1";
const ARTIFACT_TUPLE_ENCODING =
  "json-stringified-sorted-[path,classification,sha256]-tuples-utf8-v1";
const ADVERSARIAL_REVIEWER_ROLE_ID =
  "mycelium-obsidian.ai-role.independent-adversarial-reviewer";

const STABLE_ROLES = new Map([
  [
    "mycelium-obsidian.ai-role.principal-development-orchestrator",
    {
      roleName: "Principal Development Orchestrator",
      targetKind: "main-session",
      targetArtifact: "AGENTS.md",
      targetName: "main-session",
    },
  ],
  [
    "mycelium-obsidian.ai-role.product-knowledge-researcher",
    {
      roleName: "Product and Knowledge Researcher",
      targetKind: "custom-agent",
      targetArtifact: ".codex/agents/mycelium-product-researcher.toml",
      targetName: "mycelium_product_researcher",
    },
  ],
  [
    "mycelium-obsidian.ai-role.repository-runtime-explorer",
    {
      roleName: "Repository and Runtime Explorer",
      targetKind: "custom-agent",
      targetArtifact: ".codex/agents/mycelium-repository-explorer.toml",
      targetName: "mycelium_repository_explorer",
    },
  ],
  [
    "mycelium-obsidian.ai-role.scoped-implementer",
    {
      roleName: "Scoped Implementer",
      targetKind: "custom-agent",
      targetArtifact: ".codex/agents/mycelium-implementer.toml",
      targetName: "mycelium_implementer",
    },
  ],
  [
    "mycelium-obsidian.ai-role.verification-test-engineer",
    {
      roleName: "Verification and Test Engineer",
      targetKind: "custom-agent",
      targetArtifact: ".codex/agents/mycelium-test-engineer.toml",
      targetName: "mycelium_test_engineer",
    },
  ],
  [
    ADVERSARIAL_REVIEWER_ROLE_ID,
    {
      roleName: "Independent Adversarial Reviewer",
      targetKind: "custom-agent",
      targetArtifact: ".codex/agents/mycelium-adversarial-reviewer.toml",
      targetName: "mycelium_adversarial_reviewer",
    },
  ],
]);

const REQUIRED_ARTIFACTS = new Map([
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

const REQUIRED_AGENT_TOML_KEYS = [
  "name",
  "description",
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
  "developer_instructions",
];

const ALLOWED_KEYS = {
  top: new Set([
    "schemaVersion",
    "manifestId",
    "canonicalTeamId",
    "source",
    "target",
    "roles",
    "artifacts",
    "hashPolicy",
  ]),
  source: new Set([
    "canonicalId",
    "locator",
    "lifecycleState",
    "originRevision",
    "decisionOwner",
    "canonicalRoleRelease",
    "ratificationReceipt",
    "payloadDigestAlgorithm",
    "payloadDigestScope",
    "payloadDigestState",
    "payloadDigest",
  ]),
  ratificationReceipt: new Set([
    "authority",
    "decision",
    "canonicalRoleRelease",
    "originRevision",
    "payloadDigest",
    "recordedAt",
    "evidence",
  ]),
  target: new Set([
    "platform",
    "repository",
    "baselineCommit",
    "candidateBranch",
    "supportedCodexVersion",
    "reconciledAt",
    "lifecycleState",
    "integrityState",
    "distributionRevision",
    "candidateCommit",
    "draftPrReceipt",
    "semanticReconciliation",
    "runtimeEffectiveness",
    "mergeReceipt",
  ]),
  semanticReconciliation: new Set(["state", "receipt"]),
  draftPrReceipt: new Set([
    "authority",
    "decision",
    "distributionRevision",
    "candidateCommit",
    "prNumber",
    "url",
    "recordedAt",
  ]),
  semanticReceipt: new Set([
    "authority",
    "decision",
    "sprintId",
    "distributionRevision",
    "originRevision",
    "payloadDigest",
    "canonicalRoleRelease",
    "recordedAt",
    "evidence",
  ]),
  runtimeEffectiveness: new Set([
    "state",
    "configParsing",
    "exactRoleDiscovery",
    "exactRoleInvocation",
    "modelReasoningSandbox",
    "instructionSentinel",
    "receipt",
    "blocker",
  ]),
  runtimeReceipt: new Set([
    "authority",
    "decision",
    "distributionRevision",
    "supportedCodexVersion",
    "recordedAt",
    "evidence",
  ]),
  mergeReceipt: new Set([
    "authority",
    "decision",
    "distributionRevision",
    "canonicalRoleRelease",
    "candidateCommit",
    "mergedCommit",
    "recordedAt",
    "evidence",
  ]),
  role: new Set([
    "canonicalRoleId",
    "roleName",
    "targetKind",
    "targetArtifact",
    "targetName",
    "model",
    "reasoningEffort",
    "sandboxMode",
    "effectivenessState",
  ]),
  artifact: new Set(["path", "classification", "sha256"]),
  hashPolicy: new Set([
    "algorithm",
    "encoding",
    "artifactOrder",
    "artifactTupleEncoding",
    "distributionRevisionAlgorithm",
    "excludedPaths",
  ]),
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  return true;
}

function rejectUnknownKeys(value, allowed, label, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unsupported field ${JSON.stringify(key)}.`);
  }
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string.`);
    return false;
  }
  return true;
}

function requireNullableString(value, label, errors) {
  if (value !== null) requireString(value, label, errors);
}

function validateTimestamp(value, label, errors) {
  if (!requireString(value, label, errors)) return;
  const parsed = new Date(value);
  const expectedIso =
    typeof value === "string" && !value.includes(".") ? value.replace(/Z$/, ".000Z") : value;
  if (
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== expectedIso
  ) {
    errors.push(`${label} must be a valid UTC ISO-8601 timestamp.`);
  }
}

function validateDate(value, label, errors) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    errors.push(`${label} must use YYYY-MM-DD.`);
    return;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    errors.push(`${label} must be a valid calendar date.`);
  }
}

function compareLexicographically(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return !segments.includes("") && !segments.includes(".") && !segments.includes("..");
}

function decodePercentRepeatedly(value) {
  let decoded = value;
  const maximumIterations = value.length + 1;
  for (let attempt = 0; attempt < maximumIterations; attempt += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      next = decoded.replace(/%(25|2f|5c|3a|2e|7e)/gi, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
    if (next === decoded || next.length >= decoded.length) return decoded;
    decoded = next;
  }
  return decoded;
}

function containsMachineLocalAbsolutePath(value) {
  const decoded = decodePercentRepeatedly(value);
  return (
    path.posix.isAbsolute(decoded) ||
    path.win32.isAbsolute(decoded) ||
    /file:\/\//i.test(decoded) ||
    /(?:^|[\s="'([{,:])\/(?!\/)/.test(decoded) ||
    /(?:^|[\s="'([{,=])\/{2,}[^/]/.test(decoded) ||
    /(?:^|[\s="'([{,:])[A-Za-z]:[\\/]/.test(decoded) ||
    /(?:^|[\s="'([{,:])\\\\[^\\]/.test(decoded) ||
    /(?:^|[\s="'([{,:])~[\\/]/.test(decoded)
  );
}

function rejectMachineLocalPaths(value, label, errors) {
  if (typeof value === "string") {
    if (containsMachineLocalAbsolutePath(value)) {
      errors.push(`${label} must not contain a machine-local absolute path, including encoded forms.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectMachineLocalPaths(entry, `${label}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      rejectMachineLocalPaths(child, `${label}.${key}`, errors);
    }
  }
}

function validatePortableObsidianLocator(locator, errors) {
  if (!requireString(locator, "source.locator", errors)) return;
  if (!locator.startsWith("obsidian://open?")) {
    errors.push("source.locator must begin exactly with obsidian://open?.");
  }
  let uri;
  try {
    uri = new URL(locator);
  } catch {
    errors.push("source.locator must be a valid URI.");
    return;
  }

  if (
    uri.protocol !== "obsidian:" ||
    uri.hostname !== "open" ||
    uri.pathname !== "" ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== ""
  ) {
    errors.push("source.locator must be exactly an obsidian://open URI without a path or authority credentials.");
  }
  if (uri.hash !== "") errors.push("source.locator must not contain a fragment.");

  const rawQueryParts = uri.search.slice(1).split("&");
  if (rawQueryParts.length !== 2 || rawQueryParts.some((part) => part.length === 0)) {
    errors.push("source.locator query must contain exactly two non-empty parameters.");
  }
  if (rawQueryParts.some((part) => /%(?![a-f0-9]{2})/i.test(part))) {
    errors.push("source.locator query must not contain malformed percent encoding.");
  }

  const keys = [...uri.searchParams.keys()];
  const vaultValues = uri.searchParams.getAll("vault");
  const fileValues = uri.searchParams.getAll("file");
  if (
    keys.length !== 2 ||
    vaultValues.length !== 1 ||
    fileValues.length !== 1 ||
    keys.some((key) => key !== "vault" && key !== "file")
  ) {
    errors.push("source.locator must contain exactly one vault parameter and one file parameter, with no extras.");
    return;
  }

  const vault = decodePercentRepeatedly(vaultValues[0]);
  const file = decodePercentRepeatedly(fileValues[0]);
  if (/%(?:25|2f|5c|3a|2e|7e)/i.test(vault) || /%(?:25|2f|5c|3a|2e|7e)/i.test(file)) {
    errors.push("source.locator must not retain encoded path delimiters after decoding.");
  }
  if (
    vault.length === 0 ||
    vault.trim() !== vault ||
    vault === "." ||
    vault === ".." ||
    /[\\/\0\r\n]/.test(vault) ||
    path.posix.isAbsolute(vault) ||
    path.win32.isAbsolute(vault)
  ) {
    errors.push("source.locator vault must decode to a simple vault name, not a path.");
  }
  if (!isPortableRelativePath(file) || /^file:/i.test(file)) {
    errors.push("source.locator file must decode to a relative, traversal-free vault path.");
  }
}

function compareStableFields(actual, expected, label, errors) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      errors.push(
        `${label}.${key} must be ${JSON.stringify(expectedValue)}; received ${JSON.stringify(actual[key])}.`,
      );
    }
  }
}

function validateRatificationReceipt(receipt, source, errors) {
  if (!requireObject(receipt, "source.ratificationReceipt", errors)) return;
  rejectUnknownKeys(
    receipt,
    ALLOWED_KEYS.ratificationReceipt,
    "source.ratificationReceipt",
    errors,
  );
  if (receipt.authority !== "J") errors.push("source.ratificationReceipt.authority must be J.");
  if (receipt.decision !== "ratified") {
    errors.push("source.ratificationReceipt.decision must be ratified.");
  }
  if (receipt.canonicalRoleRelease !== source.canonicalRoleRelease) {
    errors.push("source.ratificationReceipt.canonicalRoleRelease must bind canonicalRoleRelease.");
  }
  if (receipt.originRevision !== source?.originRevision) {
    errors.push("source.ratificationReceipt.originRevision must bind originRevision.");
  }
  if (receipt.payloadDigest !== source?.payloadDigest) {
    errors.push("source.ratificationReceipt.payloadDigest must bind payloadDigest.");
  }
  validateTimestamp(receipt.recordedAt, "source.ratificationReceipt.recordedAt", errors);
  requireString(receipt.evidence, "source.ratificationReceipt.evidence", errors);
}

function validateDraftPrReceipt(receipt, target, errors) {
  if (!requireObject(receipt, "target.draftPrReceipt", errors)) return;
  rejectUnknownKeys(receipt, ALLOWED_KEYS.draftPrReceipt, "target.draftPrReceipt", errors);
  if (receipt.authority !== "GitHub") {
    errors.push("target.draftPrReceipt.authority must be GitHub.");
  }
  if (receipt.decision !== "draft-pr-opened") {
    errors.push("target.draftPrReceipt.decision must be draft-pr-opened.");
  }
  if (receipt.distributionRevision !== target.distributionRevision) {
    errors.push("target.draftPrReceipt.distributionRevision is stale.");
  }
  if (receipt.candidateCommit !== target.candidateCommit) {
    errors.push("target.draftPrReceipt.candidateCommit must bind target.candidateCommit.");
  }
  if (!Number.isSafeInteger(receipt.prNumber) || receipt.prNumber <= 0) {
    errors.push("target.draftPrReceipt.prNumber must be a positive safe integer.");
  }
  const expectedUrl = `https://github.com/${target.repository}/pull/${receipt.prNumber}`;
  if (receipt.url !== expectedUrl) {
    errors.push(`target.draftPrReceipt.url must be ${expectedUrl}.`);
  }
  validateTimestamp(receipt.recordedAt, "target.draftPrReceipt.recordedAt", errors);
}

function validateSemanticReceipt(receipt, state, source, target, errors) {
  if (!requireObject(receipt, "target.semanticReconciliation.receipt", errors)) return;
  rejectUnknownKeys(
    receipt,
    ALLOWED_KEYS.semanticReceipt,
    "target.semanticReconciliation.receipt",
    errors,
  );
  if (receipt.authority !== ADVERSARIAL_REVIEWER_ROLE_ID) {
    errors.push(
      `target.semanticReconciliation.receipt.authority must be ${ADVERSARIAL_REVIEWER_ROLE_ID}.`,
    );
  }
  if (receipt.decision !== state) {
    errors.push("target.semanticReconciliation.receipt.decision must equal its semantic state.");
  }
  requireString(receipt.sprintId, "target.semanticReconciliation.receipt.sprintId", errors);
  if (receipt.distributionRevision !== target.distributionRevision) {
    errors.push("target.semanticReconciliation.receipt.distributionRevision is stale.");
  }
  if (receipt.originRevision !== source?.originRevision) {
    errors.push("target.semanticReconciliation.receipt.originRevision must bind source.originRevision.");
  }
  if (receipt.payloadDigest !== source?.payloadDigest) {
    errors.push("target.semanticReconciliation.receipt.payloadDigest must bind source.payloadDigest.");
  }
  if (receipt.canonicalRoleRelease !== source?.canonicalRoleRelease) {
    errors.push(
      "target.semanticReconciliation.receipt.canonicalRoleRelease must bind source.canonicalRoleRelease.",
    );
  }
  validateTimestamp(receipt.recordedAt, "target.semanticReconciliation.receipt.recordedAt", errors);
  requireString(receipt.evidence, "target.semanticReconciliation.receipt.evidence", errors);
}

function validateRuntimeReceipt(receipt, target, errors) {
  if (!requireObject(receipt, "target.runtimeEffectiveness.receipt", errors)) return;
  rejectUnknownKeys(
    receipt,
    ALLOWED_KEYS.runtimeReceipt,
    "target.runtimeEffectiveness.receipt",
    errors,
  );
  requireString(receipt.authority, "target.runtimeEffectiveness.receipt.authority", errors);
  if (receipt.decision !== "runtime-verified") {
    errors.push("target.runtimeEffectiveness.receipt.decision must be runtime-verified.");
  }
  if (receipt.distributionRevision !== target.distributionRevision) {
    errors.push("target.runtimeEffectiveness.receipt.distributionRevision is stale.");
  }
  if (receipt.supportedCodexVersion !== target.supportedCodexVersion) {
    errors.push(
      "target.runtimeEffectiveness.receipt.supportedCodexVersion must bind target.supportedCodexVersion.",
    );
  }
  validateTimestamp(receipt.recordedAt, "target.runtimeEffectiveness.receipt.recordedAt", errors);
  requireString(receipt.evidence, "target.runtimeEffectiveness.receipt.evidence", errors);
}

function validateMergeReceipt(receipt, source, target, errors) {
  if (!requireObject(receipt, "target.mergeReceipt", errors)) return;
  rejectUnknownKeys(receipt, ALLOWED_KEYS.mergeReceipt, "target.mergeReceipt", errors);
  if (receipt.authority !== "J") errors.push("target.mergeReceipt.authority must be J.");
  if (receipt.decision !== "merged") errors.push("target.mergeReceipt.decision must be merged.");
  if (receipt.distributionRevision !== target.distributionRevision) {
    errors.push("target.mergeReceipt.distributionRevision is stale.");
  }
  if (receipt.canonicalRoleRelease !== source?.canonicalRoleRelease) {
    errors.push("target.mergeReceipt.canonicalRoleRelease must bind source.canonicalRoleRelease.");
  }
  if (receipt.candidateCommit !== target.candidateCommit) {
    errors.push("target.mergeReceipt.candidateCommit must bind target.candidateCommit.");
  }
  if (!FULL_GIT_SHA_PATTERN.test(receipt.mergedCommit ?? "")) {
    errors.push("target.mergeReceipt.mergedCommit must be a full lowercase Git commit SHA.");
  }
  validateTimestamp(receipt.recordedAt, "target.mergeReceipt.recordedAt", errors);
  requireString(receipt.evidence, "target.mergeReceipt.evidence", errors);
}

export function computeDistributionRevision(artifacts) {
  if (!Array.isArray(artifacts)) throw new TypeError("artifacts must be an array");
  const tuples = artifacts
    .map((artifact) => [artifact.path, artifact.classification, artifact.sha256])
    .sort(([left], [right]) => compareLexicographically(left, right));
  return createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");
}

function findExactMarkerLineIndices(bytes, needle) {
  const indices = [];
  let offset = 0;
  while (offset <= bytes.length - needle.length) {
    const index = bytes.indexOf(needle, offset);
    if (index === -1) break;
    const end = index + needle.length;
    const startsLine = index === 0 || bytes[index - 1] === 0x0a;
    const endsLine =
      end === bytes.length ||
      bytes[end] === 0x0a ||
      (bytes[end] === 0x0d && bytes[end + 1] === 0x0a);
    if (startsLine && endsLine) indices.push(index);
    offset = index + needle.length;
  }
  return indices;
}

function markerLinePayloadBoundary(bytes, marker, index, label) {
  const end = index + Buffer.byteLength(marker);
  if (index !== 0 && bytes[index - 1] !== 0x0a) {
    throw new Error(`${label} must be the only content on its line.`);
  }
  if (end === bytes.length) return end;
  if (bytes[end] === 0x0a) return end + 1;
  if (bytes[end] === 0x0d && bytes[end + 1] === 0x0a) return end + 2;
  throw new Error(`${label} must be the only content on its line.`);
}

export function extractCanonicalPayloadBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  const startBytes = Buffer.from(CANONICAL_PAYLOAD_START_MARKER, "utf8");
  const endBytes = Buffer.from(CANONICAL_PAYLOAD_END_MARKER, "utf8");
  const startIndices = findExactMarkerLineIndices(bytes, startBytes);
  const endIndices = findExactMarkerLineIndices(bytes, endBytes);
  if (startIndices.length !== 1 || endIndices.length !== 1) {
    throw new Error("Canonical origin must contain exactly one start marker and one end marker.");
  }

  const payloadStart = markerLinePayloadBoundary(
    bytes,
    CANONICAL_PAYLOAD_START_MARKER,
    startIndices[0],
    "Canonical payload start marker",
  );
  markerLinePayloadBoundary(
    bytes,
    CANONICAL_PAYLOAD_END_MARKER,
    endIndices[0],
    "Canonical payload end marker",
  );
  if (payloadStart > endIndices[0]) {
    throw new Error("Canonical payload end marker must follow the start marker.");
  }
  const payload = bytes.subarray(payloadStart, endIndices[0]);
  if (payload.length === 0) throw new Error("Canonical payload must not be empty.");
  return payload;
}

export function hashCanonicalPayload(input) {
  return createHash("sha256").update(extractCanonicalPayloadBytes(input)).digest("hex");
}

export async function hashCanonicalPayloadFile(filePath) {
  return hashCanonicalPayload(await readFile(filePath));
}

export async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveSafeRepositoryEntry(repoRoot, relativePath, expectedType) {
  if (!isPortableRelativePath(relativePath)) {
    throw new Error(`Repository path is not portable and relative: ${relativePath}`);
  }
  const lexicalRoot = path.resolve(repoRoot);
  const realRoot = await realpath(lexicalRoot);
  const lexicalEntry = path.resolve(lexicalRoot, relativePath);
  if (!isContainedPath(lexicalRoot, lexicalEntry)) {
    throw new Error(`Repository path escapes the repository root: ${relativePath}`);
  }

  const segments = relativePath.split("/");
  let current = lexicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const entryStat = await lstat(current);
    const isLeaf = index === segments.length - 1;
    if (isLeaf && entryStat.isSymbolicLink()) {
      throw new Error(`Repository entry must not be a symbolic link: ${relativePath}`);
    }
    if (!isLeaf && entryStat.isSymbolicLink()) {
      const resolvedParent = await realpath(current);
      if (!isContainedPath(realRoot, resolvedParent)) {
        throw new Error(`Parent directory symlink escapes repository root: ${relativePath}`);
      }
    }
    if (!isLeaf && !entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      throw new Error(`Repository path parent is not a directory: ${relativePath}`);
    }
  }

  const resolvedEntry = await realpath(lexicalEntry);
  if (!isContainedPath(realRoot, resolvedEntry)) {
    throw new Error(`Resolved repository path escapes repository root: ${relativePath}`);
  }
  const finalStat = await lstat(lexicalEntry);
  if (expectedType === "file" && !finalStat.isFile()) {
    throw new Error(`Repository entry is not a regular file: ${relativePath}`);
  }
  if (expectedType === "directory" && !finalStat.isDirectory()) {
    throw new Error(`Repository entry is not a directory: ${relativePath}`);
  }
  return resolvedEntry;
}

function parseSimpleTomlString(raw, key, errors) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    errors.push(`${key} must be one well-formed double-quoted TOML string.`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    errors.push(`${key} contains an unsupported or malformed string escape.`);
    return undefined;
  }
}

export function validateAgentTomlContent(content, role) {
  const errors = [];
  const assignments = new Map();
  const lines = content.split(/\r?\n/);
  let multilineKey;
  let multilineBody = [];

  for (const [index, line] of lines.entries()) {
    if (multilineKey) {
      if (/^\s*"""\s*$/.test(line)) {
        assignments.get(multilineKey).value = multilineBody.join("\n");
        assignments.get(multilineKey).bodyLineCount = multilineBody.length;
        multilineKey = undefined;
        multilineBody = [];
      } else {
        multilineBody.push(line);
      }
      continue;
    }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!assignment) {
      errors.push(`Malformed top-level TOML at line ${index + 1}.`);
      continue;
    }
    const [, key, rawValue] = assignment;
    if (!REQUIRED_AGENT_TOML_KEYS.includes(key)) {
      errors.push(`Unsupported top-level TOML key ${JSON.stringify(key)}.`);
      continue;
    }
    if (assignments.has(key)) {
      errors.push(`Required TOML key ${key} must appear exactly once.`);
      continue;
    }
    assignments.set(key, { value: undefined, bodyLineCount: 0 });
    if (key === "developer_instructions") {
      if (rawValue !== '"""') {
        errors.push("developer_instructions must use a multiline triple-double-quoted TOML string.");
      } else {
        multilineKey = key;
      }
    } else {
      assignments.get(key).value = parseSimpleTomlString(rawValue, key, errors);
    }
  }
  if (multilineKey) errors.push("developer_instructions multiline TOML string is unterminated.");

  for (const key of REQUIRED_AGENT_TOML_KEYS) {
    if (!assignments.has(key)) errors.push(`Required TOML key ${key} must appear exactly once.`);
  }
  const description = assignments.get("description")?.value;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("description must be non-empty.");
  }
  const developer = assignments.get("developer_instructions");
  if (
    typeof developer?.value !== "string" ||
    developer.value.trim().length === 0 ||
    developer.bodyLineCount < 2
  ) {
    errors.push("developer_instructions must contain non-empty multiline instructions.");
  }
  if (
    typeof developer?.value === "string" &&
    !developer.value.includes(role.canonicalRoleId)
  ) {
    errors.push(`developer_instructions must contain canonical role ID ${role.canonicalRoleId}.`);
  }

  const expected = {
    name: role.targetName,
    model: role.model,
    model_reasoning_effort: role.reasoningEffort,
    sandbox_mode: role.sandboxMode,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = assignments.get(key)?.value;
    if (actual !== expectedValue) {
      errors.push(
        `${key} must match role ${role.canonicalRoleId}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actual)}.`,
      );
    }
  }
  return { errors, values: Object.fromEntries([...assignments].map(([key, entry]) => [key, entry.value])) };
}

export function validateManifestSchema(manifest) {
  const errors = [];
  const warnings = [];
  const integrityErrors = [];
  const addIntegrityError = (message) => {
    errors.push(message);
    integrityErrors.push(message);
  };

  if (!requireObject(manifest, "manifest", errors)) return { errors, warnings, integrityErrors };
  rejectUnknownKeys(manifest, ALLOWED_KEYS.top, "manifest", errors);
  rejectMachineLocalPaths(manifest, "manifest", errors);

  if (manifest.schemaVersion !== 2) errors.push("schemaVersion must be 2.");
  if (manifest.manifestId !== "mycelium-obsidian.ai-team.codex-distribution") {
    errors.push("manifestId must be mycelium-obsidian.ai-team.codex-distribution.");
  }
  if (manifest.canonicalTeamId !== "mycelium-obsidian.ai-team.operating-model") {
    errors.push("canonicalTeamId must be mycelium-obsidian.ai-team.operating-model.");
  }

  const source = manifest.source;
  if (requireObject(source, "source", errors)) {
    rejectUnknownKeys(source, ALLOWED_KEYS.source, "source", errors);
    if (source.canonicalId !== manifest.canonicalTeamId) {
      errors.push("source.canonicalId must equal canonicalTeamId.");
    }
    validatePortableObsidianLocator(source.locator, errors);
    if (!requireString(source.originRevision, "source.originRevision", errors)) {
      // The non-empty requirement is the full revision policy for both lifecycle states.
    }
    if (source.decisionOwner !== "J") errors.push("source.decisionOwner must be J.");
    if (source.payloadDigestAlgorithm !== "sha256") {
      errors.push("source.payloadDigestAlgorithm must be sha256.");
    }
    if (source.payloadDigestScope !== PAYLOAD_DIGEST_SCOPE) {
      errors.push(`source.payloadDigestScope must be ${PAYLOAD_DIGEST_SCOPE}.`);
    }
    if (!SHA256_PATTERN.test(source.payloadDigest ?? "")) {
      errors.push("source.payloadDigest must be a lowercase 64-character SHA-256 value.");
    }

    if (source.lifecycleState === "origin-draft") {
      if (source.canonicalRoleRelease !== null) {
        errors.push("source.canonicalRoleRelease must be null while lifecycleState is origin-draft.");
      }
      if (source.ratificationReceipt !== null) {
        errors.push("source.ratificationReceipt must be null while lifecycleState is origin-draft.");
      }
      if (source.payloadDigestState !== "candidate-payload-recorded") {
        errors.push(
          "source.payloadDigestState must be candidate-payload-recorded while lifecycleState is origin-draft.",
        );
      }
    } else if (source.lifecycleState === "canonical-release") {
      requireString(source.canonicalRoleRelease, "source.canonicalRoleRelease", errors);
      if (source.payloadDigestState !== "ratified-payload") {
        errors.push(
          "source.payloadDigestState must be ratified-payload while lifecycleState is canonical-release.",
        );
      }
      validateRatificationReceipt(source.ratificationReceipt, source, errors);
    } else {
      errors.push("source.lifecycleState must be origin-draft or canonical-release.");
      requireNullableString(source.canonicalRoleRelease, "source.canonicalRoleRelease", errors);
    }
  }

  const target = manifest.target;
  if (requireObject(target, "target", errors)) {
    rejectUnknownKeys(target, ALLOWED_KEYS.target, "target", errors);
    if (target.platform !== "codex") errors.push("target.platform must be codex.");
    requireString(target.repository, "target.repository", errors);
    if (!FULL_GIT_SHA_PATTERN.test(target.baselineCommit ?? "")) {
      errors.push("target.baselineCommit must be a full lowercase Git commit SHA.");
    }
    requireString(target.candidateBranch, "target.candidateBranch", errors);
    requireString(target.supportedCodexVersion, "target.supportedCodexVersion", errors);
    validateDate(target.reconciledAt, "target.reconciledAt", errors);
    if (!["candidate-unverified", "candidate-verified", "merged"].includes(target.lifecycleState)) {
      errors.push("target.lifecycleState has an unsupported lifecycle state.");
    }
    if (target.integrityState !== "consistent") {
      addIntegrityError("target.integrityState must be consistent; validation reports actual inconsistency separately.");
    }
    if (!SHA256_PATTERN.test(target.distributionRevision ?? "")) {
      addIntegrityError("target.distributionRevision must be a lowercase 64-character SHA-256 value.");
    }
    if (target.candidateCommit !== null && !FULL_GIT_SHA_PATTERN.test(target.candidateCommit ?? "")) {
      errors.push("target.candidateCommit must be null or a full lowercase Git commit SHA.");
    }
    if (target.candidateCommit === null) {
      if (target.draftPrReceipt !== null) {
        errors.push("target.draftPrReceipt must be null while target.candidateCommit is null.");
      }
    } else {
      validateDraftPrReceipt(target.draftPrReceipt, target, errors);
    }

    if (requireObject(target.semanticReconciliation, "target.semanticReconciliation", errors)) {
      const semantic = target.semanticReconciliation;
      rejectUnknownKeys(
        semantic,
        ALLOWED_KEYS.semanticReconciliation,
        "target.semanticReconciliation",
        errors,
      );
      if (!["candidate-unreviewed", "candidate-reviewed", "aligned-to-release"].includes(semantic.state)) {
        errors.push("target.semanticReconciliation.state has an unsupported semantic state.");
      } else if (semantic.state === "candidate-unreviewed") {
        if (semantic.receipt !== null) {
          errors.push("candidate-unreviewed semantic state requires a null receipt.");
        }
      } else {
        validateSemanticReceipt(semantic.receipt, semantic.state, source, target, errors);
      }
      if (semantic.state === "aligned-to-release" && source?.lifecycleState !== "canonical-release") {
        errors.push("aligned-to-release semantic state requires a canonical-release source.");
      }
    }

    if (requireObject(target.runtimeEffectiveness, "target.runtimeEffectiveness", errors)) {
      const runtime = target.runtimeEffectiveness;
      rejectUnknownKeys(
        runtime,
        ALLOWED_KEYS.runtimeEffectiveness,
        "target.runtimeEffectiveness",
        errors,
      );
      if (!["unverified", "verified", "failed", "blocked"].includes(runtime.state)) {
        errors.push(
          "target.runtimeEffectiveness.state must be unverified, verified, failed, or blocked.",
        );
      }
      const evidenceKeys = [
        "configParsing",
        "exactRoleDiscovery",
        "exactRoleInvocation",
        "modelReasoningSandbox",
        "instructionSentinel",
      ];
      for (const key of evidenceKeys) {
        if (!["passed", "failed", "unverified", "blocked"].includes(runtime[key])) {
          errors.push(`target.runtimeEffectiveness.${key} has an unsupported evidence state.`);
        }
      }
      const evidenceStates = evidenceKeys.map((key) => runtime[key]);
      if (runtime.state === "verified") {
        for (const key of evidenceKeys) {
          if (runtime[key] !== "passed") {
            errors.push(`Verified runtime requires target.runtimeEffectiveness.${key} to be passed.`);
          }
        }
        if (runtime.blocker !== null) {
          errors.push("Verified runtime requires target.runtimeEffectiveness.blocker to be null.");
        }
        validateRuntimeReceipt(runtime.receipt, target, errors);
      } else if (["unverified", "failed", "blocked"].includes(runtime.state)) {
        if (runtime.receipt !== null) {
          errors.push(
            `${runtime.state} runtime requires target.runtimeEffectiveness.receipt to be null.`,
          );
        }
        requireString(runtime.blocker, "target.runtimeEffectiveness.blocker", errors);
        if (runtime.state === "unverified" && evidenceStates.includes("failed")) {
          errors.push("Unverified runtime must not contain failed evidence fields.");
        }
        if (runtime.state === "failed" && !evidenceStates.includes("failed")) {
          errors.push("Failed runtime requires at least one failed evidence field.");
        }
        if (runtime.state === "blocked") {
          if (!evidenceStates.includes("blocked")) {
            errors.push("Blocked runtime requires at least one blocked evidence field.");
          }
          if (evidenceStates.includes("failed")) {
            errors.push("Blocked runtime must not contain failed evidence fields.");
          }
        }
      }
    }

    if (target.lifecycleState === "candidate-unverified") {
      if (!["unverified", "failed", "blocked"].includes(target.runtimeEffectiveness?.state)) {
        errors.push("candidate-unverified target requires an unverified, failed, or blocked runtime.");
      }
      if (target.mergeReceipt !== null) errors.push("Candidate targets require target.mergeReceipt to be null.");
    } else if (target.lifecycleState === "candidate-verified") {
      if (target.runtimeEffectiveness?.state !== "verified") {
        errors.push("candidate-verified target requires a verified runtime.");
      }
      const expectedSemanticState =
        source?.lifecycleState === "canonical-release" ? "aligned-to-release" : "candidate-reviewed";
      if (target.semanticReconciliation?.state !== expectedSemanticState) {
        errors.push(
          `candidate-verified target requires semantic state ${expectedSemanticState} for the current source lifecycle.`,
        );
      }
      if (target.candidateCommit === null || target.draftPrReceipt === null) {
        errors.push("candidate-verified target requires candidateCommit and a bound draftPrReceipt.");
      }
      if (target.mergeReceipt !== null) errors.push("Candidate targets require target.mergeReceipt to be null.");
    } else if (target.lifecycleState === "merged") {
      if (source?.lifecycleState !== "canonical-release") {
        errors.push("A merged target requires a canonical-release source.");
      }
      if (target.semanticReconciliation?.state !== "aligned-to-release") {
        errors.push("A merged target requires semantic state aligned-to-release.");
      }
      if (target.runtimeEffectiveness?.state !== "verified") {
        errors.push("A merged target requires a verified runtime.");
      }
      if (target.candidateCommit === null || target.draftPrReceipt === null) {
        errors.push("A merged target requires candidateCommit and a bound draftPrReceipt.");
      }
      validateMergeReceipt(target.mergeReceipt, source, target, errors);
    }
  }

  if (!Array.isArray(manifest.roles)) {
    addIntegrityError("roles must be an array.");
  } else {
    const seenRoleIds = new Set();
    for (const [index, role] of manifest.roles.entries()) {
      const label = `roles[${index}]`;
      if (!requireObject(role, label, integrityErrors)) continue;
      rejectUnknownKeys(role, ALLOWED_KEYS.role, label, integrityErrors);
      const roleId = role.canonicalRoleId;
      if (!STABLE_ROLES.has(roleId)) {
        integrityErrors.push(`${label}.canonicalRoleId is not one of the six stable canonical role IDs.`);
        continue;
      }
      if (seenRoleIds.has(roleId)) integrityErrors.push(`Duplicate canonical role ID ${roleId}.`);
      seenRoleIds.add(roleId);
      compareStableFields(role, STABLE_ROLES.get(roleId), label, integrityErrors);
      requireString(role.model, `${label}.model`, integrityErrors);
      requireString(role.reasoningEffort, `${label}.reasoningEffort`, integrityErrors);
      requireString(role.sandboxMode, `${label}.sandboxMode`, integrityErrors);
      if (!["unverified", "verified", "failed", "blocked"].includes(role.effectivenessState)) {
        integrityErrors.push(
          `${label}.effectivenessState must be unverified, verified, failed, or blocked.`,
        );
      }
    }
    for (const roleId of STABLE_ROLES.keys()) {
      if (!seenRoleIds.has(roleId)) integrityErrors.push(`Missing canonical role ${roleId}.`);
    }
    if (manifest.roles.length !== STABLE_ROLES.size) {
      integrityErrors.push(`roles must contain exactly ${STABLE_ROLES.size} entries.`);
    }
    if (
      ["candidate-verified", "merged"].includes(target?.lifecycleState) &&
      manifest.roles.some((role) => !isObject(role) || role.effectivenessState !== "verified")
    ) {
      errors.push(`${target.lifecycleState} target requires every role effectivenessState to be verified.`);
    }
    if (
      manifest.roles.some((role) => isObject(role) && role.effectivenessState === "failed") &&
      target?.runtimeEffectiveness?.state !== "failed"
    ) {
      errors.push(
        "A failed role effectivenessState requires target.runtimeEffectiveness.state to be failed.",
      );
    }
    errors.push(...integrityErrors.filter((message) => !errors.includes(message)));
  }

  if (!Array.isArray(manifest.artifacts)) {
    addIntegrityError("artifacts must be an array.");
  } else {
    const artifactErrors = [];
    const seenPaths = new Set();
    const artifactPaths = [];
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const label = `artifacts[${index}]`;
      if (!requireObject(artifact, label, artifactErrors)) continue;
      rejectUnknownKeys(artifact, ALLOWED_KEYS.artifact, label, artifactErrors);
      if (!isPortableRelativePath(artifact.path)) {
        artifactErrors.push(`${label}.path must be a portable repository-relative path.`);
        continue;
      }
      artifactPaths.push(artifact.path);
      if (artifact.path === MANIFEST_RELATIVE_PATH) {
        artifactErrors.push(`${label}.path must not hash the manifest itself.`);
      }
      if (seenPaths.has(artifact.path)) artifactErrors.push(`Duplicate artifact path ${artifact.path}.`);
      seenPaths.add(artifact.path);
      const expectedClassification = REQUIRED_ARTIFACTS.get(artifact.path);
      if (!expectedClassification) {
        artifactErrors.push(`${label}.path is not part of the schema-2 distribution artifact set.`);
      } else if (artifact.classification !== expectedClassification) {
        artifactErrors.push(
          `${label}.classification must be ${expectedClassification}; received ${JSON.stringify(artifact.classification)}.`,
        );
      }
      if (!SHA256_PATTERN.test(artifact.sha256 ?? "")) {
        artifactErrors.push(`${label}.sha256 must be a lowercase SHA-256 value.`);
      }
    }
    for (const artifactPath of REQUIRED_ARTIFACTS.keys()) {
      if (!seenPaths.has(artifactPath)) {
        artifactErrors.push(`Missing required distribution artifact ${artifactPath}.`);
      }
    }
    if (manifest.artifacts.length !== REQUIRED_ARTIFACTS.size) {
      artifactErrors.push(`artifacts must contain exactly ${REQUIRED_ARTIFACTS.size} entries.`);
    }
    const sortedPaths = [...artifactPaths].sort(compareLexicographically);
    if (JSON.stringify(artifactPaths) !== JSON.stringify(sortedPaths)) {
      artifactErrors.push("artifacts must be sorted lexicographically by path.");
    }
    if (artifactErrors.length === 0) {
      const calculatedRevision = computeDistributionRevision(manifest.artifacts);
      if (target?.distributionRevision !== calculatedRevision) {
        artifactErrors.push(
          `target.distributionRevision mismatch: expected ${calculatedRevision}, received ${target?.distributionRevision}.`,
        );
      }
    }
    integrityErrors.push(...artifactErrors);
    errors.push(...artifactErrors);
  }

  if (requireObject(manifest.hashPolicy, "hashPolicy", integrityErrors)) {
    const hashPolicy = manifest.hashPolicy;
    const hashPolicyErrors = [];
    rejectUnknownKeys(hashPolicy, ALLOWED_KEYS.hashPolicy, "hashPolicy", hashPolicyErrors);
    if (hashPolicy.algorithm !== "sha256") hashPolicyErrors.push("hashPolicy.algorithm must be sha256.");
    if (hashPolicy.encoding !== "raw-file-bytes") {
      hashPolicyErrors.push("hashPolicy.encoding must be raw-file-bytes.");
    }
    if (hashPolicy.artifactOrder !== "lexicographic-path") {
      hashPolicyErrors.push("hashPolicy.artifactOrder must be lexicographic-path.");
    }
    if (hashPolicy.artifactTupleEncoding !== ARTIFACT_TUPLE_ENCODING) {
      hashPolicyErrors.push(`hashPolicy.artifactTupleEncoding must be ${ARTIFACT_TUPLE_ENCODING}.`);
    }
    if (hashPolicy.distributionRevisionAlgorithm !== "sha256") {
      hashPolicyErrors.push("hashPolicy.distributionRevisionAlgorithm must be sha256.");
    }
    if (
      !Array.isArray(hashPolicy.excludedPaths) ||
      hashPolicy.excludedPaths.length !== 1 ||
      hashPolicy.excludedPaths[0] !== MANIFEST_RELATIVE_PATH
    ) {
      hashPolicyErrors.push(`hashPolicy.excludedPaths must contain only ${MANIFEST_RELATIVE_PATH}.`);
    }
    integrityErrors.push(...hashPolicyErrors);
    errors.push(...hashPolicyErrors);
  } else {
    errors.push(...integrityErrors.filter((message) => !errors.includes(message)));
  }

  return { errors, warnings, integrityErrors: [...new Set(integrityErrors)] };
}

export async function collectArtifactDigests(manifest, repoRoot) {
  const digests = {};
  for (const artifact of manifest?.artifacts ?? []) {
    if (
      !isObject(artifact) ||
      !isPortableRelativePath(artifact.path) ||
      artifact.path === MANIFEST_RELATIVE_PATH
    ) {
      continue;
    }
    const filePath = await resolveSafeRepositoryEntry(repoRoot, artifact.path, "file");
    digests[artifact.path] = await hashFile(filePath);
  }
  return Object.fromEntries(
    Object.entries(digests).sort(([left], [right]) => compareLexicographically(left, right)),
  );
}

async function validateAgentInventory(manifest, repoRoot, errors) {
  let directory;
  try {
    directory = await resolveSafeRepositoryEntry(repoRoot, ".codex/agents", "directory");
  } catch (error) {
    errors.push(`Unable to inspect .codex/agents: ${error.message}`);
    return;
  }
  const expectedNames = new Set(
    manifest.roles
      .filter(
        (role) =>
          isObject(role) &&
          role.targetKind === "custom-agent" &&
          isPortableRelativePath(role.targetArtifact),
      )
      .map((role) => path.posix.basename(role.targetArtifact)),
  );
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.endsWith(".toml") && !expectedNames.has(entry.name)) {
        errors.push(`Unmanifested custom-agent TOML: .codex/agents/${entry.name}.`);
      }
    }
  } catch (error) {
    errors.push(`Unable to enumerate .codex/agents: ${error.message}`);
  }
}

export async function validateDistribution({ manifest, repoRoot, originFile }) {
  const schema = validateManifestSchema(manifest);
  const errors = [...schema.errors];
  const warnings = [...schema.warnings];
  const integrityErrors = [...schema.integrityErrors];
  const addIntegrityError = (message) => {
    errors.push(message);
    integrityErrors.push(message);
  };
  let originComparison = "not-requested";

  if (Array.isArray(manifest?.artifacts)) {
    for (const artifact of manifest.artifacts) {
      if (
        !isObject(artifact) ||
        !isPortableRelativePath(artifact.path) ||
        artifact.path === MANIFEST_RELATIVE_PATH
      ) {
        continue;
      }
      try {
        const filePath = await resolveSafeRepositoryEntry(repoRoot, artifact.path, "file");
        const actualDigest = await hashFile(filePath);
        if (actualDigest !== artifact.sha256) {
          addIntegrityError(
            `Artifact digest mismatch for ${artifact.path}: expected ${artifact.sha256}, received ${actualDigest}.`,
          );
        }
      } catch (error) {
        addIntegrityError(`Unable to hash artifact ${artifact.path}: ${error.message}`);
      }
    }
  }

  if (Array.isArray(manifest?.roles)) {
    await validateAgentInventory(manifest, repoRoot, integrityErrors);
    for (const message of integrityErrors) {
      if (!errors.includes(message)) errors.push(message);
    }
    for (const role of manifest.roles.filter(
      (entry) => isObject(entry) && entry.targetKind === "custom-agent",
    )) {
      if (!isPortableRelativePath(role.targetArtifact)) continue;
      try {
        const filePath = await resolveSafeRepositoryEntry(repoRoot, role.targetArtifact, "file");
        const toml = validateAgentTomlContent(await readFile(filePath, "utf8"), role);
        for (const message of toml.errors) {
          addIntegrityError(`${role.targetArtifact}: ${message}`);
        }
      } catch (error) {
        addIntegrityError(`Unable to inspect role transformation ${role.targetArtifact}: ${error.message}`);
      }
    }
  }

  if (originFile) {
    originComparison = "failed";
    try {
      const originStat = await lstat(originFile);
      if (!originStat.isFile() || originStat.isSymbolicLink()) {
        errors.push(`Canonical origin is not a regular non-symlink file: ${originFile}.`);
      } else {
        const actualOriginDigest = await hashCanonicalPayloadFile(originFile);
        if (actualOriginDigest !== manifest?.source?.payloadDigest) {
          errors.push(
            `Canonical origin digest mismatch: expected ${manifest?.source?.payloadDigest}, received ${actualOriginDigest}.`,
          );
        } else {
          originComparison = "verified";
        }
      }
    } catch (error) {
      errors.push(`Unable to hash canonical origin ${originFile}: ${error.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    artifactCount: manifest?.artifacts?.length ?? 0,
    originComparison,
    integrityState:
      integrityErrors.length === 0 && manifest?.target?.integrityState === "consistent"
        ? "consistent"
        : "inconsistent",
    semanticState: manifest?.target?.semanticReconciliation?.state ?? "unknown",
    runtimeEffectiveness: manifest?.target?.runtimeEffectiveness?.state ?? "unknown",
    distributionRevision: manifest?.target?.distributionRevision ?? "unknown",
  };
}

function parseArguments(argv) {
  const options = {
    repoRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    manifestPath: undefined,
    originFile: process.env.MYCELIUM_AI_TEAM_ORIGIN_FILE || undefined,
    printArtifactHashes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      options.repoRoot = path.resolve(argv[++index] ?? "");
    } else if (argument === "--manifest") {
      options.manifestPath = path.resolve(argv[++index] ?? "");
    } else if (argument === "--origin-file") {
      options.originFile = path.resolve(argv[++index] ?? "");
    } else if (argument === "--print-artifact-hashes") {
      options.printArtifactHashes = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  options.repoRoot = path.resolve(options.repoRoot);
  options.manifestPath ??= path.join(options.repoRoot, MANIFEST_RELATIVE_PATH);
  return options;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/validate-ai-team-distribution.mjs [options]",
      "",
      "Options:",
      "  --repo-root DIR              Repository root (defaults to this script's repository).",
      "  --manifest FILE              Manifest path (defaults inside --repo-root).",
      "  --origin-file FILE           Compare only the marker-delimited canonical payload.",
      "  --print-artifact-hashes      Print safe raw-file hashes and distribution revision.",
      "  -h, --help                   Show this help.",
      "",
      "MYCELIUM_AI_TEAM_ORIGIN_FILE may supply --origin-file without storing a local path.",
      "",
    ].join("\n"),
  );
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  } catch (error) {
    process.stderr.write(`Unable to read manifest ${options.manifestPath}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.printArtifactHashes) {
    try {
      const digests = await collectArtifactDigests(manifest, options.repoRoot);
      const artifacts = manifest.artifacts.map((artifact) => ({
        path: artifact.path,
        classification: artifact.classification,
        sha256: digests[artifact.path],
      }));
      process.stdout.write(
        `${JSON.stringify(
          { artifacts, distributionRevision: computeDistributionRevision(artifacts) },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      process.stderr.write(`Unable to calculate artifact hashes: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const result = await validateDistribution({
    manifest,
    repoRoot: options.repoRoot,
    originFile: options.originFile,
  });
  for (const warning of result.warnings) process.stderr.write(`WARNING: ${warning}\n`);
  const status =
    `integrity=${result.integrityState}; semantic=${result.semanticState}; ` +
    `runtime=${result.runtimeEffectiveness}; origin=${result.originComparison}`;
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`ERROR: ${error}\n`);
    process.stderr.write(`AI-team distribution invalid: ${status}.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `AI-team distribution valid: artifacts=${result.artifactCount}; ${status}; revision=${result.distributionRevision}.\n`,
  );
}

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) await main();
