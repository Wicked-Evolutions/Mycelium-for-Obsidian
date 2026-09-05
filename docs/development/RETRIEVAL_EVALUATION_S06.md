# Sprint 06 Retrieval Evaluation (#92)

The final evaluation completed with `status=RUN` and `artifactUnchanged=true`.
"Current" below means this measured artifact. #91 merged as PR #98 after independent review and passing Node 20/22 checks; its distinct NFC/NFD directory regression executed successfully on both Linux jobs.
Independent Astra reviews approved the harness/metrics and final report. The report reviewer verified all 152 baseline/final response envelope hashes and byte counts, paired metrics, timing medians and stated limitations against the raw receipts. This is development evidence, not release approval.
Local `npm test` and `npm run test:coverage`: 1303 tests, 1300 passed, 0 failed, 3 skipped (the local filesystem merges NFC/NFD directory names; the other two skips are documented in the sprint receipt).

## Sources and Identity

- Contract: [RETRIEVAL_CONTRACT_S06.md](RETRIEVAL_CONTRACT_S06.md); harness: `scripts/evaluate-retrieval-s06.mjs`; frozen corpus/labels: `test/fixtures/retrieval-s06/fixture.mjs`; metrics: `src/eval/metrics.ts`.
- Baseline receipt: `/tmp/mycelium-s06-eval-baseline-receipt.json`, frozen at `2026-09-05T15:42:43.068Z`; frozen built #90 commit `9bf633e8435c38cc7d98dba80d0b790b4286bb2d`, AFTER #89/#90, not the v1.5.0 release.
- Baseline artifact SHA-256: `ac936fb461c5325df6cec460c7783ecf9ab46b041cca8b83f52033da7fc69653` (57 JavaScript files).
- Final current receipt: `/tmp/mycelium-s06-eval-final-receipt.json`, frozen at `2026-09-05T17:23:44.389Z`, finished at `2026-09-05T17:23:55.723Z`; measured artifact SHA-256: `f2de5e0dbaa7ea7d96ad08810fdabcb3c9796f3844579be1dbec299cf991a73b` (63 JavaScript files).
- Both receipts: `status=RUN`, `artifactUnchanged=true`, synthetic storage `cleanup=removed`. Artifact hashes cover the sorted JavaScript path/hash manifest, not Git provenance or native dependencies.
- Fixture SHA-256: `661a6ca522ea2f2e92cf98fc303ebb91f2c5ed38c9f0f2d605a1e4d5fa667568`; labels SHA-256: `3ead0e858efe95dae15d697a06f8b053555d4d8497ef3dbe6c45cd589250f8a6` (same in both receipts).
- Both used Node `v22.22.3`, `darwin/arm64`, Ollama `nomic-embed-text:latest`, model digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, context length 2048, verified input budget 1843 bytes.
- Recipe: selected artifact's Markdown section indexing, original embedding text and frozen queries; no task prefixes, expansion, hypothetical answer, or reranker. Search `minSimilarity=0.3`, K=3, `--repeats 1` (one immediate warm repeat).

## Measurement Contract

Only fictional Workshop and Harbor are used: 18 notes, 18 queries, more eligible files than K for every query; 9 files per vault index successfully, producing 12/11 sections, with zero indexing errors. One source is deleted after indexing.
Labels cover exact, multilingual, natural, paraphrase, ambiguous, boilerplate, later-section, scope, cross-vault, missing-source and no-answer intents; they are frozen before comparisons.
Metrics use structured `(vault, NFC(path))` file identities and binary relevance. Duplicate hits occupy ranks but earn relevance once; harness sentinels also prevent legacy DCG inflation. MRR sees only returned top-K. No-answer cases are excluded from answerable means.
Baseline has 32 executed observations and 2 NOT RUN scope entries; current has 120 executed observations. Extra variants/scopes are not extra independent queries or a comparable sample-size gain.

## Paired Existing Measures

Use `full/cold` only, pairing common answerable IDs before unweighted means; warm rankings match. Do not compare unmatched receipt `summary` averages.
Search (7): `exact-title`, `unicode-swedish`, `natural-question`, `paraphrase-recovery`, `boilerplate-pump`, `late-section`, `french-question`.
Cross-vault (2): `ambiguous-spring`, `cross-vault-identity`. Similar (4): `similar-boilerplate`, `similar-airlock`, `similar-night-shift`, `similar-battery`.

| Surface | N | Recall@3 baseline -> current | MRR baseline -> current | NDCG@3 baseline -> current |
| --- | ---: | --- | --- | --- |
| semantic_search | 7 | 0.881 -> 0.952 | 1.000 -> 1.000 | 0.911 -> 0.955 |
| semantic_search_all | 2 | 0.583 -> 0.583 | 1.000 -> 1.000 | 0.689 -> 0.689 |
| get_similar | 4 | 0.500 -> 0.583 | 0.375 -> 0.458 | 0.408 -> 0.466 |

The search gain is `natural-question`: Workshop's `Guides/Dispatch log.md` enters rank 3 after the deleted source is excluded (recall 0.5 -> 1; NDCG 0.613 -> 0.920). Other paired search/cross metrics are unchanged, although five answerable rankings replace a deleted-source hit.
`similar-boilerplate` changes from two irrelevant files to three files with `Guides/Airlock reset.md` at rank 3 (recall 0 -> 0.333); other similar cases' ranks/metrics are unchanged. These observations match #94 source-availability/distinct-file fixes, not a new reference-vector policy or a benefit attributed to #91 projection options.

## Newly Executable Scopes and Evidence

`directory-scope` (Workshop `Guides`, 7 eligible files) and `selected-vault` (Harbor only, 9 eligible files) were baseline NOT RUN because schemas lacked the options; no post-filter emulation. Each current case has Recall@3/MRR/NDCG@3 = 1/1/1. These are two new scope measurements, not paired quality improvements; selected-vault still includes two irrelevant hits.
Across all 120 current observations: 168 valid requested excerpts; zero invalid, missing or unavailable requested excerpts, out-of-scope hits, deleted-source hits, duplicate hits, or within-query ranking changes across variants/repeats. These are repeated observations, not 168 unique passages.
Validation checks exact indexed block, content hash, model identity, timestamp, excerpt containment, <=600 Unicode code points and `currentSourceVerified=false`. `late-section` evidence contains ORCHID-73 beyond the original first 600 characters, with `truncatedBefore=true`; readable source is not proof of freshness.
The source contract caps stored headings at 160 Unicode code points with `headingTruncated`. All 168 measured headings have `headingTruncated=false` (maximum 18 code points); this benchmark does not exercise heading-cap truncation.
On the 16 shared executed queries, full/cold deleted-source hits fall from 7 to 0; baseline out-of-scope flags here refer to those same deleted sources, not failed directory/vault filtering. #91 full/compact/evidence variants preserve current ranking; this is not baseline-to-current ranking identity.
All three no-answer cases (`no-answer-single`, `missing-source`, `no-answer-cross`) return 3 false positives each in both receipts' full/cold observations: 9 hits per side. Removing a deleted answer source does not provide abstention or answerability detection.

## Response Bytes and Timing

Bytes sum the UTF-8 `JSON.stringify` tool-response envelope on the paired answerable IDs, one current cold call per variant; untrusted wrapping is disabled by the harness. They are not token counts, transport traffic, or a global payload bound.

| Current surface | Full, no evidence | Compact, no evidence | Full + evidence | Compact + evidence |
| --- | ---: | ---: | ---: | ---: |
| semantic_search (7) | 31794 | 15010 | 50222 | 33438 |
| semantic_search_all (2) | 9050 | 6572 | 14097 | 11619 |

Compact reduces bytes by 52.8%/27.4% without evidence and 33.4%/17.6% with evidence (search/cross). Evidence adds 18428/5047 bytes to either projection; compact+evidence is larger than full without evidence in both cohorts.
Relative to the superseded current receipt, `headingTruncated=false` adds 798/228 envelope bytes per evidence variant (search/cross); no-evidence bytes and all per-observation rankings/metrics are unchanged.
Baseline full bytes for these same cohorts are 29556/7995; similar full bytes are 3604 -> 3885. Changes between artifacts include correctness/diagnostic payloads, not just compact projection. Link inventory/text search are not measured by this harness.
`cold` means first query/variant call in-process after indexing, NOT machine-cold. Warm is its immediate repeat; variants execute sequentially, with OS caches and Ollama neither cleared nor unloaded.

| Paired full surface | Baseline cold / warm ms | Current cold / warm ms |
| --- | ---: | ---: |
| semantic_search (7) | 20.20 / 18.13 | 59.50 / 65.31 |
| semantic_search_all (2) | 22.85 / 20.84 | 74.04 / 108.39 |
| get_similar (4) | 1.89 / 1.57 | 5.34 / 5.17 |

Timing entries are query medians (upper middle for even N, matching the harness); they exclude indexing. One warm repeat on a tiny local fixture cannot establish latency distributions or general performance regressions/improvements.

## Measured Reference-Policy Experiments

Each policy was measured on the same four cases with fixed indexed target chunks, max cosine per distinct readable target file, self exclusion, similarity >=0 and deterministic identity ties. These independent experiments are separate from production `get_similar` observations; both receipts have the same policy metrics.
`first` uses the stored whole-file row if present, otherwise earliest section; `whole` embeds complete text within the byte budget; `normalizedMean` L2-normalizes chunks, averages, then normalizes again; `meaningfulSection` selects longest non-heading paragraph mass excluding exact normalized paragraphs repeated in >=3 documents, with storage-order ties.
Cells below are Recall@3 / reciprocal rank / NDCG@3, rounded to three decimals; `whole` and `normalizedMean` have equal metrics here, not necessarily equal result identities.

| Case | first | whole | normalizedMean | meaningfulSection |
| --- | --- | --- | --- | --- |
| similar-boilerplate | .333 / .333 / .235 | .667 / .500 / .531 | .667 / .500 / .531 | .667 / 1.000 / .704 |
| similar-airlock | 1.000 / .500 / .631 | 1.000 / .500 / .631 | 1.000 / .500 / .631 | 1.000 / .500 / .631 |
| similar-night-shift | .000 / .000 / .000 | 1.000 / .500 / .693 | 1.000 / .500 / .693 | 1.000 / 1.000 / 1.000 |
| similar-battery | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |

Alternatives improve the two boilerplate cases and leave two cases' metrics unchanged. Four deliberately small cases with frozen binary labels do not justify an automatic default change, a new public mode, or universal retrieval-quality claims; retain the existing production reference policy pending broader evidence.

## Reproduction

Use already-built baseline/current artifacts and the same locally available Ollama model/digest; unavailable models yield NOT RUN, not a download. Run from the repository root with portable artifact placeholders. The harness ignores real vault configuration and cleans its temporary synthetic vaults; output creation is exclusive.
```sh
out=$(mktemp -d /tmp/mycelium-s06-report.XXXXXX)
node scripts/evaluate-retrieval-s06.mjs --freeze --output "$out/labels.json"
node scripts/evaluate-retrieval-s06.mjs --dist path/to/baseline/dist \
  --host http://127.0.0.1:11434 --model nomic-embed-text:latest --repeats 1 \
  --output "$out/baseline.json"
node scripts/evaluate-retrieval-s06.mjs --dist path/to/current/dist \
  --host http://127.0.0.1:11434 --model nomic-embed-text:latest --repeats 1 \
  --output "$out/current.json"
```
Retain hashes, recipes and per-query observations; pair IDs before aggregation. Rerun after changes to the measured artifact. The separate strict closed-vault release gate and publication remain outside this report.
