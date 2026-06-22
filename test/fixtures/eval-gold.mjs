/**
 * Tiny gold-query fixture for the retrieval eval harness.
 *
 * Each entry is a hand-labelled query with:
 *   - `query`:    the natural-language search string,
 *   - `relevant`: the set of doc ids that are correct answers (ground truth),
 *   - `ranked`:   a sample system output (best-first) used by the offline metric
 *                 tests so they have deterministic, hand-verifiable inputs.
 *
 * The doc ids mirror the 2-note shape used elsewhere in the suite (Marketing /
 * Engineering), expanded with a couple of distractors so the metrics exercise
 * partial-hit and miss cases. This fixture is intentionally Ollama-free: it is
 * raw ranked lists, not a live index.
 */

export const GOLD_QUERIES = [
  {
    query: 'marketing strategy brand awareness',
    relevant: ['Marketing.md'],
    // Perfect ranking: relevant doc at rank 1.
    ranked: ['Marketing.md', 'Engineering.md', 'Misc.md'],
  },
  {
    query: 'system architecture REST API latency',
    relevant: ['Engineering.md'],
    // Relevant doc at rank 2 → RR = 1/2.
    ranked: ['Marketing.md', 'Engineering.md', 'Misc.md'],
  },
  {
    query: 'social media engagement and microservices throughput',
    relevant: ['Marketing.md', 'Engineering.md'],
    // Both relevant docs in top-2 → Recall@2 = 1.0.
    ranked: ['Engineering.md', 'Marketing.md', 'Misc.md'],
  },
  {
    query: 'unrelated topic with no answer in vault',
    relevant: ['DoesNotExist.md'],
    // Relevant doc never appears → MRR contribution 0, Recall 0.
    ranked: ['Marketing.md', 'Engineering.md', 'Misc.md'],
  },
];
