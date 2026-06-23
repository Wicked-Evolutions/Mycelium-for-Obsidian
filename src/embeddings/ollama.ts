/**
 * Ollama embedding client
 * Generates embeddings using local Ollama instance
 */

export interface OllamaConfig {
  host: string;
  model: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
  config: OllamaConfig
): Promise<EmbeddingResult> {
  const response = await fetch(`${config.host}/api/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      prompt: text
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
  }

  const data = await response.json() as { embedding: number[] };

  return {
    embedding: data.embedding,
    model: config.model
  };
}

/**
 * Generate a text completion via Ollama's `/api/generate` (non-streaming).
 *
 * This is the SAME endpoint the query-expansion path uses. Factored here so the
 * LLM-as-reranker backend (PR-C, #27) can call it AND tests can inject a fake
 * `generate` instead of mocking the network. Returns the raw `response` string;
 * the caller is responsible for parsing/validating it.
 *
 * `model` defaults to a GENERATION model (never the embedding model, which
 * cannot emit text), overridable via OLLAMA_GENERATE_MODEL.
 */
export type GenerateFn = (prompt: string) => Promise<string>;

export async function generateCompletion(
  prompt: string,
  config: { host: string; model?: string }
): Promise<string> {
  const model =
    config.model || process.env.OLLAMA_GENERATE_MODEL || 'qwen2.5:7b';
  const response = await fetch(`${config.host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama generate failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? '';
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function generateEmbeddings(
  texts: string[],
  config: OllamaConfig,
  onProgress?: (completed: number, total: number) => void
): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i++) {
    const result = await generateEmbedding(texts[i], config);
    results.push(result);

    if (onProgress) {
      onProgress(i + 1, texts.length);
    }
  }

  return results;
}

/**
 * Check if Ollama is available and has the required model
 */
export async function checkOllamaAvailability(config: OllamaConfig): Promise<{
  available: boolean;
  hasModel: boolean;
  error?: string;
}> {
  try {
    // Check if Ollama is running
    const response = await fetch(`${config.host}/api/tags`);
    if (!response.ok) {
      return { available: false, hasModel: false, error: 'Ollama not responding' };
    }

    const data = await response.json() as { models: Array<{ name: string }> };
    const hasModel = data.models?.some(m =>
      m.name === config.model || m.name.startsWith(`${config.model}:`)
    ) ?? false;

    return {
      available: true,
      hasModel,
      error: hasModel ? undefined : `Model ${config.model} not found. Run: ollama pull ${config.model}`
    };
  } catch (error) {
    return {
      available: false,
      hasModel: false,
      error: `Cannot connect to Ollama at ${config.host}`
    };
  }
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}
