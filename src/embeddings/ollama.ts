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
  digest: string;
}

export interface OllamaModelMatch {
  name: string;
  digest: string;
}

export interface EmbeddingModelProfile extends OllamaModelMatch {
  contextLength: number;
  maxInputBytes: number;
}

export interface OllamaAvailability {
  available: boolean;
  hasModel: boolean;
  model?: OllamaModelMatch;
  error?: string;
}

export interface ResolvedEmbeddingModelConfig extends OllamaConfig {
  modelDigest: string;
}

export function isValidEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === 'number' && Number.isFinite(item));
}

export function assertValidEmbeddingVector(
  value: unknown,
  source: string = 'Embedding provider'
): asserts value is number[] {
  if (!isValidEmbeddingVector(value)) {
    throw new Error(`${source} returned an invalid embedding vector.`);
  }
}

export function resolveEmbeddingModelConfig(
  config: OllamaConfig,
  model: OllamaModelMatch
): ResolvedEmbeddingModelConfig {
  if (!model.name || !model.digest) {
    throw new Error('Embedding model identity is unavailable from Ollama.');
  }
  return { ...config, model: model.name, modelDigest: model.digest };
}

function hasExplicitTag(model: string): boolean {
  return model.lastIndexOf(':') > model.lastIndexOf('/');
}

function selectConfiguredModel(
  configuredModel: string,
  candidates: Array<{ name: string; digest?: string }>
): { name: string; digest?: string } | undefined {
  if (hasExplicitTag(configuredModel)) {
    return candidates.find(model => model.name === configuredModel);
  }
  return candidates.find(model => model.name === `${configuredModel}:latest`) ??
    candidates.find(model => model.name === configuredModel);
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
  config: ResolvedEmbeddingModelConfig,
  fetchImpl: typeof fetch = fetch
): Promise<EmbeddingResult> {
  const response = await fetchImpl(`${config.host}/api/embeddings`, {
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

  const data = await response.json() as { embedding?: unknown };
  assertValidEmbeddingVector(data.embedding, 'Ollama');

  const expected = { name: config.model, digest: config.modelDigest };
  await assertRunningOllamaModelIdentity(config, expected, fetchImpl);
  await assertOllamaModelIdentity(config, expected, fetchImpl);

  return {
    embedding: data.embedding,
    model: config.model,
    digest: config.modelDigest,
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
  config: ResolvedEmbeddingModelConfig,
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

function modelIdentityChanged(): Error {
  return new Error(
    'Ollama embedding model identity changed during the operation; retry after the model tag is stable.'
  );
}

function parseModelMatches(data: unknown): Array<{ name: string; digest?: string }> {
  if (!data || typeof data !== 'object' || !('models' in data) || !Array.isArray(data.models)) {
    return [];
  }
  return data.models
    .filter((model): model is { name: string; digest?: string } => (
      Boolean(model) &&
      typeof model === 'object' &&
      'name' in model &&
      typeof model.name === 'string'
    ));
}

/** Verify that the exact model tag still resolves to the discovered digest. */
export async function assertOllamaModelIdentity(
  config: Pick<OllamaConfig, 'host'>,
  expected: OllamaModelMatch,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`${config.host}/api/tags`);
  if (!response.ok) throw modelIdentityChanged();

  const matches = parseModelMatches(await response.json())
    .filter(model => model.name === expected.name);
  if (
    matches.length !== 1 ||
    matches[0].digest !== expected.digest
  ) {
    throw modelIdentityChanged();
  }
}

/**
 * Verify the digest of the model Ollama actually loaded for an embedding call.
 * `/api/embeddings` does not return a digest, while `/api/ps` reports the loaded
 * model generation and therefore closes the mutable-tag attribution gap.
 */
export async function assertRunningOllamaModelIdentity(
  config: Pick<OllamaConfig, 'host'>,
  expected: OllamaModelMatch,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`${config.host}/api/ps`);
  if (!response.ok) throw modelIdentityChanged();

  const matches = parseModelMatches(await response.json())
    .filter(model => model.name === expected.name);
  if (
    matches.length !== 1 ||
    matches[0].digest !== expected.digest
  ) {
    throw modelIdentityChanged();
  }
}

export function assertEmbeddingResultIdentity(
  result: EmbeddingResult,
  expected: OllamaModelMatch
): void {
  if (result.model !== expected.name || result.digest !== expected.digest) {
    throw modelIdentityChanged();
  }
}

/**
 * Check if Ollama is available and has the required model
 */
export async function checkOllamaAvailability(
  config: OllamaConfig,
  fetchImpl: typeof fetch = fetch
): Promise<OllamaAvailability> {
  try {
    // Check if Ollama is running
    const response = await fetchImpl(`${config.host}/api/tags`);
    if (!response.ok) {
      return { available: false, hasModel: false, error: 'Ollama not responding' };
    }

    const candidates = parseModelMatches(await response.json());
    const matched = selectConfiguredModel(config.model, candidates);
    const model = matched && typeof matched.digest === 'string' && matched.digest.length > 0
      ? { name: matched.name, digest: matched.digest }
      : undefined;
    const hasModel = model !== undefined;

    return {
      available: true,
      hasModel,
      ...(model ? { model } : {}),
      error: hasModel
        ? undefined
        : matched
          ? `Model ${config.model} did not report a stable digest.`
          : `Model ${config.model} not found. Run: ollama pull ${config.model}`
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
 * Resolve the embedding model's architecture-specific context window.
 * The byte budget deliberately treats one input byte as one possible token,
 * which is conservative for byte-pair tokenizers and leaves provider overhead.
 */
export async function getEmbeddingModelProfile(
  config: OllamaConfig,
  model: OllamaModelMatch | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<EmbeddingModelProfile> {
  if (!model?.name || !model.digest) {
    throw new Error('Embedding model identity is unavailable from Ollama.');
  }

  const response = await fetchImpl(`${config.host}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.name })
  });
  if (!response.ok) {
    throw new Error(`Ollama model details failed: ${response.status}`);
  }

  const data = await response.json() as { model_info?: Record<string, unknown> };
  const modelInfo = data.model_info;
  const architecture = modelInfo?.['general.architecture'];
  const rawContextLength = typeof architecture === 'string'
    ? modelInfo?.[`${architecture}.context_length`]
    : undefined;
  if (
    typeof rawContextLength !== 'number' ||
    !Number.isSafeInteger(rawContextLength) ||
    rawContextLength < 256
  ) {
    throw new Error('Embedding model context length is absent or invalid.');
  }

  const contextLength = Math.min(rawContextLength, 1_000_000);
  const reserve = Math.max(128, Math.ceil(contextLength * 0.1));
  const maxInputBytes = contextLength - reserve;
  if (maxInputBytes < 16) {
    throw new Error('Embedding model context length leaves no safe input budget.');
  }

  await assertOllamaModelIdentity(config, model, fetchImpl);

  return {
    name: model.name,
    digest: model.digest,
    contextLength,
    maxInputBytes,
  };
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  assertValidEmbeddingVector(a, 'Query embedding');
  assertValidEmbeddingVector(b, 'Stored embedding');
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
