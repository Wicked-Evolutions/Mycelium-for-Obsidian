# Sprint 06 - Reliable, Selective and Measurable Retrieval

## Outcome and Authority

Deliver the three-stage retrieval improvement authorized by J on 2026-09-05 as a
reviewed, merged and locally testable candidate. The intended next release is
1.6.0; version files and publication remain outside this development task.

[Issue #88](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/issues/88)
is the current execution dashboard. It records focused PRs, reviews, verification
and remaining work. J authorized team implementation and eligible merges under
the existing review and Node 20/22 checks. No tag, npm/GitHub publication,
deployment, MCPB work, or task archival is authorized.

Baseline: clean `main` at `499543f7b2d22396900a4563f0ead4536d7d2dee`.
Public npm/GitHub remain 1.5.0 at `a27b147674300b3836693bee471082fbb0d68a73`.

## Work and Ownership

| Stage | Work | Owner and Boundary |
| --- | --- | --- |
| 1 | #89 Unicode keywords, explicit zero thresholds, sorting and precision | Scoped Astra writer; existing behavior and schemas preserved beyond the defects |
| 1 | #90 cached-target truth and source-grounded orientation | Next focused writer; no automatic link repair or assumed vault taxonomy |
| 1 | #94 source availability and distinct similar files | Scoped writer; bounded candidate reads, no general freshness claim or reference-policy change |
| 1 | #86/#87 index recovery | Typed nonmutating inspection and explicit offline normalization; preserve normal checks and original artifacts; no automatic identity-drift acceptance |
| 2 | #91 scoped retrieval and compact source evidence | Concrete additive contract before implementation; no universal tool rewrite |
| 3 | #92 retrieval evaluation and integration | Existing metrics plus generic fixtures; retain defaults without demonstrated benefit |

The principal owns scope, documentation, integration and final accuracy. Each
consequential implementation receives independent correctness review. Material
contracts also receive pre-implementation proportionality review.

All sprint subagents use GPT-6 Astra with effort appropriate to the work. The
general delegation surface supplies explicit model settings because the named
repository roles lock other models. Role responsibilities remain those in
AGENTS.md; launch receipts describe observed host settings, not self-attestation.
Writers stay in their assigned Codex-managed checkout with disjoint ownership.

## Generic Boundary

A user's property standard, folder layout or note naming is not an MCP product
requirement. Fixtures demonstrate different conventions without prescribing one.
No local note migration, global exclusion policy, concept nodes, graph-based
retrieval ranking, automatic cross-vault mutation, composed vaults, ANN database,
or unrelated Atlas work is included. Prefer existing helpers and small changes.
New dependencies, persistent schemas or embedding recipes require a demonstrated
need and independent proportionality review; they are not presumed necessary.

## Verification and Stop Conditions

- Build and focused regressions during implementation.
- Headless suite and coverage on each integrated focused candidate.
- Independent Astra review and required GitHub Node 20/22 checks before merge.
- Applicable non-skipped Obsidian/Ollama checks and generic retrieval evidence.
- Current README, Unreleased changelog and focused development-memory receipt.
- Merged main built in the configured canonical checkout for J's local test.

Do not report a failure as an empty successful result, stale evidence as current,
or skipped work as passed. Status calls do not silently migrate indexes. A
ranking experiment may conclude that the existing algorithm should remain;
that is an evaluated result, not an implementation commitment. Required work
cannot be declared complete solely by moving it to a later issue.

The live-session observations of 3 searchable semantic vaults out of 22 describe
availability, not the cause of every failure or the quality of ecosystem-wide
retrieval. Diagnose distinct states and validate recovery using controlled
fixtures before touching live derived data.

## Implementation and Evidence

Focused, independently reviewed PRs #93, #95, #96, #97 and #98 delivered #89,
#90, #94, #86 and #91 with required Node 20/22 checks. The optional evaluation
and its limitations are recorded in [RETRIEVAL_EVALUATION_S06.md](RETRIEVAL_EVALUATION_S06.md).
The final local build and coverage runs each executed 1,303 tests: 1,300 passed,
0 failed, 3 skipped. The distinct NFC/NFD directory case cannot execute on the
local normalization-insensitive filesystem; it passed on both Linux CI jobs.
The other skips are the optional Obsidian headless lane and the unavailable-Ollama
case when Ollama is running.

An isolated real-Ollama recovery check passed four checks without configured-vault
changes. The final generic evaluation executed 120 observations with 168 valid
requested excerpts. Read-only validation against an already-open Obsidian vault
passed four checks, with app opening explicitly prohibited and no note/index writes.
This is not a pass of the separate strict closed-vault pre-release gate, which
remains unexecuted for this development sprint.

#87 remains open: typed diagnosis and an explicit operator procedure do not prove
automatic recovery across filesystem identity changes or prevent recurrence of an
unexplained publication interruption. The founder boundary decision remains
pending; do not close this gap by relabeling it complete. Existing legacy indexes
also require an explicit maintained offline upgrade window, not an automatic
migration during status or search. No release or publication is authorized.
