#!/usr/bin/env node
/** Optional operator evaluation, not a CI gate or a production ranking mode.
 * node scripts/evaluate-retrieval-s06.mjs --dist /tmp/mycelium-s06-eval-baseline/dist --output /tmp/s06.json
 * node scripts/evaluate-retrieval-s06.mjs --dist file:///absolute/current/dist/ --repeats 1
 * node scripts/evaluate-retrieval-s06.mjs --freeze
 * --repeats counts warm repeats after one first-in-process observation (0..3).
 * Only --host (loopback Ollama) and --model choose runtime configuration. Never
 * loads .env, loadConfig(), configured vaults, or the server entry point.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fixture } from '../test/fixtures/retrieval-s06/fixture.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const identityKey = ({ vault, path: notePath }) => JSON.stringify([vault, notePath.normalize('NFC')]);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const utf8ResponseBytes = response => Buffer.byteLength(JSON.stringify(response), 'utf8');

export function eligibleNotes(query, corpus = fixture) {
  return corpus.notes.filter(note => !note.removeAfterIndex
    && (query.kind === 'cross' ? !query.vaults || query.vaults.includes(note.vault)
      : note.vault === (query.vault ?? query.reference.vault))
    && (!query.directory || note.path.startsWith(`${query.directory}/`))
    && (!query.reference || identityKey(note) !== identityKey(query.reference)));
}

export function validateFixture(corpus = fixture) {
  const safePart = value => typeof value === 'string' && value.length > 0
    && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value)
    && !value.split('/').some(part => ['', '.', '..'].includes(part));
  assert.ok(Number.isSafeInteger(corpus.k) && corpus.k > 0);
  assert.equal(new Set(corpus.vaults).size, corpus.vaults.length);
  for (const vault of corpus.vaults) assert.ok(safePart(vault) && !vault.includes('/'));
  const notes = new Map();
  for (const note of corpus.notes) {
    assert.ok(corpus.vaults.includes(note.vault) && safePart(note.path) && note.path.endsWith('.md'));
    assert.ok(typeof note.content === 'string' && note.content.trim());
    assert.ok(!notes.has(identityKey(note)), 'duplicate fixture identity');
    notes.set(identityKey(note), note);
  }
  const queryIds = new Set();
  for (const query of corpus.queries) {
    assert.ok(!queryIds.has(query.id));
    queryIds.add(query.id);
    assert.ok(['search', 'cross', 'similar'].includes(query.kind));
    assert.ok(query.rationale && query.intents.length);
    if (query.vault) assert.ok(corpus.vaults.includes(query.vault));
    if (query.vaults) assert.ok(query.vaults.length && query.vaults.every(v => corpus.vaults.includes(v)));
    if (query.directory) assert.ok(safePart(query.directory));
    if (query.reference) assert.ok(notes.has(identityKey(query.reference)));
    const eligible = new Set(eligibleNotes(query, corpus).map(identityKey));
    assert.ok(eligible.size > corpus.k, `${query.id}: candidates must exceed K`);
    assert.equal(new Set(query.relevant.map(identityKey)).size, query.relevant.length);
    for (const relevant of query.relevant) assert.ok(eligible.has(identityKey(relevant)), `${query.id}: invalid gold`);
    assert.equal(query.relevant.length === 0, query.intents.includes('noanswer'));
  }
  return {
    name: corpus.name, fixtureSha256: sha256(JSON.stringify(corpus)),
    labelsSha256: sha256(JSON.stringify(corpus.queries)), k: corpus.k,
    notes: corpus.notes.length, queries: corpus.queries.length, vaults: corpus.vaults,
    labels: corpus.queries,
  };
}

export function distUrl(value = fileURLToPath(new URL('../dist/', import.meta.url))) {
  const url = value.startsWith('file:') ? new URL(value) : pathToFileURL(path.resolve(value));
  assert.equal(url.protocol, 'file:', '--dist must be a filesystem path or file URL');
  assert.ok(!url.search && !url.hash, '--dist cannot contain a query or fragment');
  return pathToFileURL(path.resolve(fileURLToPath(url)) + path.sep);
}

export async function withSyntheticVaults(corpus, run, onCleanup = () => {}) {
  validateFixture(corpus);
  const root = await mkdtemp(path.join(tmpdir(), 'mycelium-s06-eval-'));
  try {
    const vaults = corpus.vaults.map(name => ({ name, path: path.join(root, name) }));
    for (const note of corpus.notes) {
      const filename = path.join(root, note.vault, note.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, note.content, { flag: 'wx' });
    }
    return await run({ root, vaults });
  } finally {
    await rm(root, { recursive: true, force: true });
    onCleanup();
  }
}

export function scoreRanking(query, hits, metrics, k = fixture.k) {
  const relevant = query.relevant.map(identityKey);
  const seen = new Map();
  const ranks = hits.map((hit, index) => {
    const identity = { vault: hit.vault, path: hit.path };
    const key = identityKey(identity);
    const duplicateOf = seen.get(key) ?? null;
    if (!duplicateOf) seen.set(key, index + 1);
    return { rank: index + 1, identity, relevant: relevant.includes(key), duplicateOf };
  });
  // Legacy dist metrics double-count duplicates. Neutral sentinels preserve the
  // original positions and make old/current scoring comparable without patching dist.
  const ranked = ranks.map(row => row.duplicateOf ? `duplicate-rank:${row.rank}` : identityKey(row.identity));
  const summary = metrics.evaluate([{ query: query.id, relevant, ranked }], k);
  return {
    ranks,
    relevantRanks: query.relevant.map(identity => ({ identity, rank: seen.get(identityKey(identity)) ?? null })),
    metrics: query.relevant.length ? { recallAtK: summary.recallAtK, mrr: summary.mrr, ndcgAtK: summary.ndcgAtK } : null,
    duplicateHits: ranks.filter(row => row.duplicateOf !== null).length,
    noAnswerFalsePositives: query.relevant.length ? null : hits.length,
  };
}

export function inspectEvidence(hit, rows, requested) {
  const evidence = hit.evidence;
  if (!evidence) return { state: requested ? 'missing' : 'not_requested' };
  if (evidence.state === 'unavailable') return { state: 'unavailable', reason: evidence.reason };
  const row = rows.find(item => item.vault === hit.vault && item.filePath.normalize('NFC') === hit.path.normalize('NFC')
    && item.blockId === evidence.blockId);
  const excerpt = evidence.excerpt;
  const checks = {
    available: evidence.state === 'available',
    source: evidence.source === 'indexed_embedding_text',
    exactBlock: Boolean(row),
    contentHash: Boolean(row) && evidence.contentHash === row.contentHash,
    modelIdentity: Boolean(row) && evidence.modelIdentity === row.metadata.modelIdentity,
    updatedAt: Boolean(row) && evidence.updatedAt === row.updatedAt,
    excerpt: Boolean(row) && typeof excerpt === 'string' && excerpt.length > 0 && row.content.includes(excerpt),
    codePointBound: typeof excerpt === 'string' && [...excerpt].length <= 600,
    noFreshnessClaim: evidence.currentSourceVerified === false,
  };
  return { state: Object.values(checks).every(Boolean) ? 'valid' : 'invalid', checks };
}

export function normalizedMean(vectors) {
  const unit = vector => {
    const norm = Math.hypot(...vector);
    assert.ok(norm > 0 && Number.isFinite(norm), 'invalid reference vector');
    return vector.map(value => value / norm);
  };
  assert.ok(vectors.length > 0);
  const mean = Array(vectors[0].length).fill(0);
  for (const vector of vectors) {
    assert.equal(vector.length, mean.length);
    unit(vector).forEach((value, i) => { mean[i] += value / vectors.length; });
  }
  return unit(mean);
}

export function meaningfulSection(referenceRows, allRows) {
  const paragraphs = text => text.replace(/^#{1,6}\s+.*$/gm, '').split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const documents = new Map();
  for (const row of allRows) {
    for (const paragraph of paragraphs(row.content)) {
      if (!documents.has(paragraph)) documents.set(paragraph, new Set());
      documents.get(paragraph).add(identityKey({ vault: row.vault, path: row.filePath }));
    }
  }
  const weight = row => paragraphs(row.content).filter(p => documents.get(p).size < 3)
    .reduce((n, p) => n + [...p].length, 0);
  // Label-blind heuristic: longest non-heading text after removing paragraphs
  // repeated in at least three documents; original storage order breaks ties.
  return referenceRows.reduce((best, row) => weight(row) > weight(best) ? row : best);
}

export function rankReference(vector, reference, rows, cosine, k = fixture.k) {
  const best = new Map();
  for (const row of rows) {
    if (row.vault !== reference.vault || row.filePath === reference.path || row.removed) continue;
    const identity = { vault: row.vault, path: row.filePath };
    const key = identityKey(identity);
    const similarity = cosine(vector, row.embedding);
    if (similarity < 0) continue;
    if (!best.has(key) || similarity > best.get(key).similarity) best.set(key, { ...identity, similarity, blockId: row.blockId });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity || compare(identityKey(a), identityKey(b))).slice(0, k);
}

async function artifactReceipt(url) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      assert.ok(!entry.isSymbolicLink(), 'dist must not contain symlinked modules');
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.name.endsWith('.js')) files.push([path.relative(fileURLToPath(url), filename), sha256(await readFile(filename))]);
    }
  }
  await visit(fileURLToPath(url));
  return { dist: url.href, javascriptSha256: sha256(JSON.stringify(files)), files: files.length };
}

function parseResponse(response) {
  if (response.isError) throw new Error(response.content?.map(item => item.text).join('\n') ?? 'Tool failed');
  const data = JSON.parse(response.content[0].text);
  if (data.status === 'needs_action' || data.status === 'unavailable') throw new Error(JSON.stringify(data));
  return data;
}

function aggregate(observations) {
  const groups = new Map();
  for (const item of observations.filter(item => item.status === 'RUN')) {
    const key = `${item.surface}/${item.variant}/${item.phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].map(([group, items]) => {
    const answerable = items.filter(item => item.metrics !== null);
    const average = field => answerable.length ? answerable.reduce((sum, item) => sum + item.metrics[field], 0) / answerable.length : null;
    const durations = items.map(item => item.durationMs).sort((a, b) => a - b);
    return {
      group, observations: items.length, answerableObservations: answerable.length,
      recallAtK: average('recallAtK'), mrr: average('mrr'), ndcgAtK: average('ndcgAtK'),
      duplicateHits: items.reduce((sum, item) => sum + item.duplicateHits, 0),
      noAnswerObservations: items.filter(item => item.noAnswerFalsePositives !== null).length,
      noAnswerWithHits: items.filter(item => item.noAnswerFalsePositives > 0).length,
      noAnswerFalsePositives: items.reduce((sum, item) => sum + (item.noAnswerFalsePositives ?? 0), 0),
      responseBytes: items.reduce((sum, item) => sum + item.responseBytes, 0),
      durationMs: { min: durations[0], median: durations[Math.floor(durations.length / 2)], max: durations.at(-1) },
    };
  });
}

export async function runEvaluation(options) {
  const frozen = validateFixture();
  const frozenAt = new Date().toISOString();
  // This is emitted before module imports, model calls, or the first comparison.
  console.error(JSON.stringify({ event: 'labels_frozen', frozenAt, ...frozen }));
  const url = distUrl(options.dist);
  const report = {
    status: 'NOT RUN', frozenAt, fixture: frozen, artifact: await artifactReceipt(url),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    timingContract: 'cold = first query/variant call in this process after indexing; warm = immediate repeats. OS caches and Ollama are not cleared or unloaded; variants run sequentially.',
    metricContract: 'Top-K file identities; duplicate hits retain positions but gain relevance once. MRR is RR of returned top-K only. No-answer cases are separate, never zero-valued answerable means.',
    limitation: 'Small fictional stress fixture, not representative evidence of general quality. Reference experiments hold target chunks/max-per-file aggregation fixed, unlike the separate production get_similar observations.',
    observations: [], referenceComparison: [], index: [], cleanup: 'not_created',
  };
  const host = new URL(options.host ?? 'http://127.0.0.1:11434');
  assert.ok(host.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
    && host.pathname === '/' && !host.username && !host.password && !host.search && !host.hash, '--host must be a loopback HTTP origin');
  const nativeFetch = globalThis.fetch;
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('Evaluation interrupted'));
  const deadline = setTimeout(() => abort.abort(new Error('Evaluation exceeded 15 minutes')), 15 * 60_000);
  const network = { embeddingCalls: 0, maximumEmbeddingCalls: 256, embeddingPromptBytes: 0, requests: {} };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  globalThis.fetch = async (input, init = {}) => {
    abort.signal.throwIfAborted();
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(requestUrl.origin, host.origin, 'evaluation network must stay on selected Ollama');
    assert.ok(['/api/tags', '/api/show', '/api/ps', '/api/embeddings'].includes(requestUrl.pathname), 'only embedding/profile endpoints allowed');
    network.requests[requestUrl.pathname] = (network.requests[requestUrl.pathname] ?? 0) + 1;
    if (requestUrl.pathname === '/api/embeddings') {
      assert.ok(network.embeddingCalls < network.maximumEmbeddingCalls, 'embedding call budget exhausted');
      network.embeddingCalls++;
      network.embeddingPromptBytes += Buffer.byteLength(JSON.parse(init.body).prompt, 'utf8');
    }
    return nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000), ...(init.signal ? [init.signal] : [])]) });
  };
  try {
    const semantic = await import(new URL('tools/semantic.js', url));
    const cross = await import(new URL('tools/crossvault.js', url));
    const storage = await import(new URL('embeddings/storage.js', url));
    const ollama = await import(new URL('embeddings/ollama.js', url));
    const metrics = await import(new URL('eval/metrics.js', url));
    const modelConfig = { host: host.origin, model: options.model ?? 'nomic-embed-text' };
    const availability = await ollama.checkOllamaAvailability(modelConfig);
    report.availability = availability;
    if (!availability.available || !availability.hasModel || !availability.model) {
      report.reason = 'Selected Ollama model unavailable; no download attempted.';
      return report;
    }
    const profile = await ollama.getEmbeddingModelProfile(modelConfig, availability.model);
    report.model = profile;
    report.recipe = {
      indexed: 'Selected dist index_vault: Markdown section chunking within model byte budget; original embedding text, no added task prefixes.',
      query: 'Original frozen query, no prefix, expansion, hypothetical answer, or reranker.',
      independentReference: {
        first: 'Actual store.get(path): whole-file row if present, otherwise earliest stored section.',
        whole: 'One embedding of complete frozen note text; abort if over model byte budget.',
        normalizedMean: 'L2-normalize each reference chunk, arithmetic mean, L2-normalize mean.',
        meaningfulSection: 'Longest non-heading paragraph mass after excluding exact normalized paragraphs repeated in >=3 documents; storage order breaks ties.',
        targetScoring: 'Same indexed target chunks for every policy, max cosine per distinct readable file, exclude reference, similarity >=0, deterministic identity ties.',
      },
      minSimilarity: fixture.minSimilarity, k: fixture.k, warmRepeats: options.repeats ?? 1,
    };
    const tools = [...semantic.semanticTools, ...cross.crossVaultTools];
    const has = (tool, option) => Boolean(tools.find(item => item.name === tool)?.inputSchema?.properties?.[option]);
    report.capabilities = Object.fromEntries(['semantic_search', 'semantic_search_all'].map(tool => [tool,
      Object.fromEntries(['directory', 'vaults', 'includeEvidence', 'compact'].map(option => [option, has(tool, option)]))]));
    await withSyntheticVaults(fixture, async ({ root, vaults }) => {
      report.cleanup = 'pending';
      const config = { mode: 'multi', vaults, ollama: modelConfig, disabledTools: new Set(['eval_obsidian']), readOnly: false, wrapUntrusted: false };
      const handlers = { ...semantic.createSemanticHandlers(config), ...cross.createCrossVaultHandlers(config) };
      const stores = new Map();
      try {
        for (const vault of vaults) {
          const started = performance.now();
          const response = await handlers.index_vault({ vault: vault.name, force: true });
          const data = parseResponse(response);
          assert.equal(data.errors, 0, 'all synthetic notes must index successfully');
          assert.equal(data.indexedFiles, fixture.notes.filter(note => note.vault === vault.name).length);
          report.index.push({ vault: vault.name, durationMs: performance.now() - started, response: data });
          stores.set(vault.name, storage.getSharedStorage(vault.path));
        }
        const rows = [...stores].flatMap(([vault, store]) => store.getAll().map(row => ({
          ...row, vault, content: store.getContent(row.filePath, row.blockId),
          removed: fixture.notes.find(note => identityKey(note) === identityKey({ vault, path: row.filePath }))?.removeAfterIndex === true,
        })));
        assert.ok(rows.every(row => typeof row.content === 'string' && row.metadata.modelIdentity === `${profile.name}@${profile.digest}`));
        for (const note of fixture.notes.filter(note => note.removeAfterIndex)) await rm(path.join(root, note.vault, note.path));
        for (const query of fixture.queries) {
          const tool = query.kind === 'similar' ? 'get_similar' : query.kind === 'cross' ? 'semantic_search_all' : 'semantic_search';
          const missing = ['directory', 'vaults'].filter(option => query[option] && !has(tool, option));
          if (missing.length) {
            report.observations.push({ query: query.id, surface: tool, status: 'NOT RUN', reason: `dist schema lacks ${missing.join(', ')}; no post-filter emulation` });
            continue;
          }
          const args = query.kind === 'similar'
            ? { ...query.reference, limit: fixture.k }
            : { query: query.query, limit: fixture.k, minSimilarity: fixture.minSimilarity,
              ...(query.vault ? { vault: query.vault, expand: false, rerank: false } : {}),
              ...(query.directory ? { directory: query.directory } : {}), ...(query.vaults ? { vaults: query.vaults } : {}) };
          const variants = [{ name: 'full', extra: {} }];
          if (has(tool, 'compact')) variants.push({ name: 'compact', extra: { compact: true } });
          if (has(tool, 'includeEvidence')) {
            variants.push({ name: 'evidence', extra: { includeEvidence: true } });
            if (has(tool, 'compact')) variants.push({ name: 'compact+evidence', extra: { compact: true, includeEvidence: true } });
          }
          let initialRanking;
          for (const variant of variants) {
            for (let iteration = 0; iteration <= (options.repeats ?? 1); iteration++) {
              abort.signal.throwIfAborted();
              const started = performance.now();
              const response = await handlers[tool]({ ...args, ...variant.extra });
              const durationMs = performance.now() - started;
              const data = parseResponse(response);
              const hits = (data.results ?? data.similarFiles).map(hit => ({ ...hit, vault: hit.vault ?? query.vault ?? query.reference?.vault }));
              const ranking = hits.map(identityKey);
              initialRanking ??= ranking;
              const eligible = new Set(eligibleNotes(query).map(identityKey));
              report.observations.push({
                query: query.id, surface: tool, variant: variant.name, iteration, phase: iteration === 0 ? 'cold' : 'warm', status: 'RUN',
                eligibleCandidates: eligible.size, durationMs, responseBytes: utf8ResponseBytes(response),
                textBytes: Buffer.byteLength(response.content[0].text, 'utf8'), responseSha256: sha256(JSON.stringify(response)),
                rankingMatchesFirst: JSON.stringify(ranking) === JSON.stringify(initialRanking),
                ...scoreRanking(query, hits, metrics),
                evidenceValidity: hits.map(hit => ({ identity: { vault: hit.vault, path: hit.path },
                  sourcePresent: fixture.notes.some(note => !note.removeAfterIndex && identityKey(note) === identityKey(hit)),
                  inScope: eligible.has(identityKey(hit)), ...inspectEvidence(hit, rows, variant.extra.includeEvidence === true) })),
                response: data,
              });
            }
          }
        }
        for (const query of fixture.queries.filter(query => query.kind === 'similar')) {
          const reference = fixture.notes.find(note => identityKey(note) === identityKey(query.reference));
          const referenceRows = rows.filter(row => row.vault === reference.vault && row.filePath.normalize('NFC') === reference.path);
          const started = performance.now();
          assert.ok(Buffer.byteLength(reference.content, 'utf8') <= profile.maxInputBytes, 'whole reference exceeds verified byte budget');
          const whole = await ollama.generateEmbedding(reference.content, ollama.resolveEmbeddingModelConfig(modelConfig, profile));
          const vectors = {
            first: stores.get(reference.vault).get(reference.path).embedding,
            whole: whole.embedding,
            normalizedMean: normalizedMean(referenceRows.map(row => row.embedding)),
            meaningfulSection: meaningfulSection(referenceRows, rows).embedding,
          };
          const preparationMs = performance.now() - started;
          for (const [policy, vector] of Object.entries(vectors)) {
            const scoredAt = performance.now();
            const hits = rankReference(vector, reference, rows, ollama.cosineSimilarity);
            report.referenceComparison.push({ query: query.id, policy, preparationMs,
              scoringMs: performance.now() - scoredAt, ...scoreRanking(query, hits, metrics), hits });
          }
        }
        await ollama.assertOllamaModelIdentity(modelConfig, profile);
        report.status = 'RUN';
      } finally {
        // Include stores opened by a partially failed index operation as well.
        for (const vault of vaults) {
          try { (stores.get(vault.name) ?? storage.getSharedStorage(vault.path)).close(); }
          catch (error) { (report.closeErrors ??= []).push(String(error)); }
        }
      }
    }, () => { report.cleanup = 'removed'; });
    report.summary = aggregate(report.observations);
    report.artifactUnchanged = (await artifactReceipt(url)).javascriptSha256 === report.artifact.javascriptSha256;
    assert.ok(report.artifactUnchanged, 'dist changed during evaluation; comparisons are invalid');
  } catch (error) {
    report.status = 'FAILED';
    report.error = String(error);
  } finally {
    report.network = network;
    report.finishedAt = new Date().toISOString();
    clearTimeout(deadline);
    globalThis.fetch = nativeFetch;
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    dist: { type: 'string' }, host: { type: 'string' }, model: { type: 'string' }, output: { type: 'string' },
    repeats: { type: 'string', default: '1' }, freeze: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Optional synthetic Ollama eval: --dist PATH|file:URL --host http://127.0.0.1:11434 --model nomic-embed-text --repeats 0..3 --output /tmp/report.json\n--freeze prints fixed labels/digests without model calls. No configured vaults or production ranking edits.');
    return;
  }
  const repeats = Number(values.repeats);
  assert.ok(Number.isInteger(repeats) && repeats >= 0 && repeats <= 3, '--repeats must be 0..3');
  const report = values.freeze ? validateFixture() : await runEvaluation({ ...values, repeats });
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(path.resolve(values.output), output, { flag: 'wx' });
  else process.stdout.write(output);
  if (!values.freeze && report.status !== 'RUN') process.exitCode = report.status === 'FAILED' ? 1 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
