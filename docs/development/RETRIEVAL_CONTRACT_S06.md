# Sprint 06 Retrieval Contract

Implementation proposal for #91 and #92, revised after independent Astra review.
This is an additive extension of existing tools, not a general response framework.
No persistent schema, dependency, embedding recipe, or user property convention is
introduced. Omitted options and explicit false preserve the integrated Stage 1
success payloads. Correctness fixes are separately identified from new options.

## Selection

- `search_all_vaults` and `semantic_search_all`: optional `vaults: string[]`.
  Omission means all configured vaults. An empty array, non-string member, unknown
  name or ambiguous case-insensitive configured name is an invalid request.
  Validate the complete selection before scanning or opening any vault storage.
  Deduplicate valid names and retain configured order, not caller order.
- A small shared selection helper does not change scalar vault resolution.
  Extend dynamic enum injection only for `vaults.items.enum` where present.
- `semantic_search`: optional `directory: string`. Omission, empty string and `.`
  mean root. Other values resolve through existing vault path safeguards and must
  name a current directory. Missing, non-directory and escaping paths fail without
  broadening. Descendants qualify; prefix siblings do not.
- Directory is candidate scope, not an I/O isolation promise: compatibility counts,
  BM25 corpus statistics and graph annotation remain vault-wide. Filter vector and
  keyword rows before eligible provider limits and fusion; keyword scanning must
  continue past excluded batches. Out-of-scope rows are not failed/incompatible.
- Selected-vault counts retain existing meanings: attempted vaults include failures;
  indexed vaults are not a successful-search count. Unselected vaults contribute
  neither results nor failures. Cross-vault text reads use the existing verified
  in-vault reader. No unrelated scanner rewrite is included.

## Indexed Evidence

`semantic_search` and `semantic_search_all` accept optional `includeEvidence`,
default false. Existing previews remain unchanged when compact is false.

- Evidence comes from the exact winning `(filePath, blockId)` and the indexed
  generation observed when that candidate entered retrieval. Capture the relevant
  row/FTS content synchronously with retrieval, not after awaited enrichment.
- Available evidence carries `state: available`, `source: indexed_embedding_text`,
  the stored block identifier, content hash, model identity, update timestamp,
  optional stored heading (160 code points with `headingTruncated`), excerpt, and truncation flags. It explicitly reports
  `currentSourceVerified: false`; readable source is not proof of content freshness.
- Generated block IDs are index identifiers, not promised native Obsidian anchors.
  Do not emit current line numbers or imply that repeated embedding headings are
  exact note passages. Do not substitute a whole-file or different-block passage.
- Use a deterministic Unicode-code-point window of at most 600 characters, centered
  around the first literal query-token match where present; otherwise use the
  prefix. Report whether text was omitted before and/or after. Keep source identity
  complete; only display text is shortened.
- If exact FTS content is missing, the generation changes before response assembly,
  or identity cannot be verified, return `state: unavailable` with a fixed reason
  code. Never silently substitute another generation. Capture evidence only when
  requested, without changing ranking or using excerpts as a reranker replacement.
- Current readable-source validation applies independently of this option. Missing
  or unreadable candidates are excluded with truthful partial accounting; this
  still makes no general freshness claim about readable edited notes.

## Compact Projection

Optional `compact`, default false, applies to `semantic_search`,
`semantic_search_all`, and `get_cross_vault_links`. This bounds display collections,
not total execution cost or arbitrary-length identities. No global byte-bound claim.

- Semantic hits retain path, vault when present, title (at most 160 code points),
  `similarity` with its existing meaning, and optional requested evidence. For hybrid
  search also retain `fusionScore`, `fusionMethod` and `reranker_score`; similarity
  is not relabeled as a ranking score. Returned array order remains authoritative.
  Omit preview, detailed per-signal breakdown and per-hit graph decomposition. Keep all request-level
  compatibility, completeness, limits, per-vault state and graph-provider receipts.
- Cross-vault potential links retain source vault/path, unresolved target identity,
  and at most five candidate `(vault,path)` targets with total/returned/truncated
  metadata. These remain possibilities, not validated declarations.
- Native URI records retain source identity and coordinates, status, resolved target
  identity when available, and diagnostic codes. Omit raw/repeated URI text, display
  labels and diagnostic prose. Preserve inventory counts and validation caveats.
- Declared graph edges retain type, complete source/target identity and declaration
  counts; omit repeated canonical URIs and subpath samples, retaining the total
  unique subpath count. Keep graph authority, exclusions and edge-count metadata.
- Projection never deduplicates or reorders hits. Inventory scan errors retain the
  existing failure behavior. Explicit false and omission preserve full responses.
  Keep the existing untrusted-content wrapping on both projections.

## Similar Files and Measurement

Separate correctness from reference-policy experiments. Exclude the reference and
aggregate distinct readable target files before the file limit, with deterministic
ties; replace the old underfilled-pool regression intentionally. Do not assume a
fixed oversampling multiplier guarantees a file limit. Compare alternative reference
policies against the current whole-file/first-section policy before changing it.
There is no new public aggregation-mode parameter.

Use generic fixtures with frozen relevance labels, more candidates than K, and
distinct structured `(vault,path)` evaluation identities. Report duplicate hits
separately; repeated relevant IDs cannot increase NDCG. Include exact, multilingual,
natural-language, paraphrase, ambiguous, boilerplate, later-section, missing-source,
scope, cross-vault and no-answer cases. Record per-query ranks, response bytes,
evidence validity, and repeated cold/warm timing with model/digest/recipe receipts.
Change one ranking policy at a time and retain the baseline without demonstrated
benefit. A generic benchmark is evidence, not a universal retrieval-quality claim.

## Required Checks

Cover invalid selection before any scan; unknown/ambiguous/case-variant/duplicate
names; scoped candidate saturation across keyword batches; normalized directories,
prefix siblings and invalid targets; keyword-only evidence; missing or changed
indexed generations; readable-but-edited sources; matches after character 600;
Unicode truncation; every compact/evidence combination; saturated nested link
collections; preserved identities/counts/errors; and many self/duplicate target
chunks. Pin compatibility tests to Stage 1, not an earlier defective baseline.

Keep composite pagination, universal response conversion, model-prefix migration,
graph ranking and new indexing infrastructure out. A larger contract requires new
evidence and alignment review, not automatic expansion of these acceptance checks.
