# Reranker eval procedure (LLM-as-reranker, #27)

This is a **documented PROCEDURE**, not a CI gate. The built-in fixture proves
**plumbing** (the toggle reorders, `reranker_score` populates, malformed output
degrades gracefully) — it does **not** prove *lift*. The fixture corpus scores
Recall@3 ≈ 1.0 with no headroom, so a reranker cannot measurably help it. **Real
lift can only be measured against your own gold queries on a real vault.** The
reranker ships **default-OFF regardless of eval.**

## What the reranker is (and isn't)

- Backend `llm` scores each `(query, passage)` pair by asking the existing Ollama
  `/api/generate` model for a 0.0–1.0 relevance score as strict JSON. It is **not**
  a true cross-encoder (Ollama has no `/api/rerank`; the `transformers.js`
  cross-encoder is deferred), so there is **no precision guarantee** — only an
  empirical, vault-specific judgement.
- It runs **only** when BOTH are set: the operator env `RERANKER_BACKEND=llm`
  **and** the per-call `rerank: true` arg. Either one missing → no rerank, no
  reorder, `reranker_score` stays `null`.
- Safety: the candidate set is capped to a top-K window
  (`RERANK_TOP_K`, `src/embeddings/reranker-llm.ts`), each passage is wrapped in
  the untrusted-content markers (`[BEGIN/END UNTRUSTED VAULT CONTENT]`), strict
  JSON is demanded, and any malformed / zero-join output degrades to
  `rerankerAvailable:false` (ordering unchanged) — never an error.

## Prerequisites

- A real Obsidian vault wired via `OBSIDIAN_VAULTS`.
- Ollama running with a **generation** model (default `qwen2.5:7b`; override with
  `OLLAMA_GENERATE_MODEL`) AND your embedding model (default `nomic-embed-text`).
  The embedding model alone cannot score passages.

```bash
ollama pull qwen2.5:7b        # or your chosen generation model
ollama pull nomic-embed-text  # embeddings (already required for search)
```

## Step 1 — build a gold set

A gold query is `{ query, relevant: [filePaths…] }` — the file paths you consider
correct answers. The metric helpers live in `src/eval/metrics.ts`
(`recallAtK`, `ndcgAtK`, `reciprocalRank`, `meanReciprocalRank`, `evaluate`).
Aim for queries with **headroom**: cases where the default fused order puts a
correct answer *below* rank 1, so a reranker has something to fix. Trivially-easy
queries (correct answer already at rank 1) cannot show lift.

## Step 2 — run BASELINE (reranker OFF)

Index once, then run `semantic_search` with `rerank` omitted and record the
ranked `path` list per query:

```jsonc
// semantic_search args
{ "vault": "<YourVault>", "query": "<gold query>", "limit": 10 }
```

Score each ranked list against its `relevant` set with `recallAtK` / `ndcgAtK` /
`reciprocalRank`, and aggregate MRR with `meanReciprocalRank`. This is your
**baseline**.

## Step 3 — run WITH the reranker ON

Start the server (or the harness process) with the backend enabled, then pass the
per-call toggle:

```bash
RERANKER_BACKEND=llm \
OLLAMA_GENERATE_MODEL=qwen2.5:7b \
  node <your eval harness>
```

```jsonc
// semantic_search args
{ "vault": "<YourVault>", "query": "<gold query>", "limit": 10, "rerank": true }
```

Confirm the response carries `rerankerBackend: "llm"` and
`rerankerAvailable: true` (if it is `false`, the model output was malformed or
Ollama was unreachable — fix that before trusting the numbers). Score the new
ranked lists exactly as in Step 2.

## Step 4 — compare

Lift = the rerank-ON metrics minus the baseline. Look at **NDCG@10 and MRR**
(reranking reorders within the candidate window, so Recall@K of the *window* is
unchanged — it is the *ordering* metrics that move). If the reranker does not
improve your gold set, leave it off: it adds an LLM call per search for no gain
on your corpus.

## Sketch harness

```js
import { createSemanticHandlers } from '../dist/tools/semantic.js';
import { loadConfig } from '../dist/config.js';
import { ndcgAtK, reciprocalRank, meanReciprocalRank } from '../dist/eval/metrics.js';

const handlers = createSemanticHandlers(loadConfig());
await handlers.index_vault({ vault: 'YourVault', force: true });

const GOLD = [
  { query: 'how do we measure latency', relevant: ['Engineering.md'] },
  // …your gold queries…
];

async function run(rerank) {
  const out = [];
  for (const g of GOLD) {
    const res = await handlers.semantic_search({
      vault: 'YourVault', query: g.query, limit: 10, rerank,
    });
    const data = JSON.parse(res.content[0].text);
    const ranked = data.results.map((r) => r.path);
    out.push({ query: g.query, relevant: new Set(g.relevant), ranked });
  }
  return out;
}

const fmt = (rows) => ({
  ndcg10: rows.reduce((s, r) => s + ndcgAtK(r.ranked, r.relevant, 10), 0) / rows.length,
  mrr: meanReciprocalRank(rows.map((r) => ({ ranked: r.ranked, relevant: r.relevant }))),
});

console.log('baseline', fmt(await run(false)));
console.log('rerank  ', fmt(await run(true)));   // run with RERANKER_BACKEND=llm
```

Treat the output as **informed judgement for J**, never a pass/fail CI gate.
