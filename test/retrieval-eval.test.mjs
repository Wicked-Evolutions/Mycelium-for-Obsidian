// Offline harness contracts only. The optional CLI is the real-Ollama evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as metrics from '../dist/eval/metrics.js';
import { fixture } from './fixtures/retrieval-s06/fixture.mjs';
import {
  validateFixture, eligibleNotes, identityKey, distUrl, withSyntheticVaults,
  scoreRanking, inspectEvidence, utf8ResponseBytes, normalizedMean,
  meaningfulSection, rankReference,
} from '../scripts/evaluate-retrieval-s06.mjs';

const identity = (vault, notePath = 'Same.md') => ({ vault, path: notePath });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('frozen labels/corpus cover representative intents with more eligible files than K', () => {
  const receipt = validateFixture();
  assert.equal(receipt.fixtureSha256, '661a6ca522ea2f2e92cf98fc303ebb91f2c5ed38c9f0f2d605a1e4d5fa667568');
  assert.equal(receipt.labelsSha256, '3ead0e858efe95dae15d697a06f8b053555d4d8497ef3dbe6c45cd589250f8a6');
  assert.equal(receipt.notes, 18);
  assert.equal(receipt.queries, 18);
  const intents = new Set(fixture.queries.flatMap(query => query.intents));
  for (const intent of ['exact', 'multilingual', 'unicode', 'natural', 'paraphrase', 'ambiguous', 'boilerplate', 'late-section', 'noanswer', 'scoped', 'crossvault', 'missing-source']) assert.ok(intents.has(intent));
  for (const query of fixture.queries) assert.ok(eligibleNotes(query).length > fixture.k);
  const late = fixture.notes.find(note => note.path === 'Guides/Dispatch log.md').content;
  assert.ok(late.indexOf('ORCHID-73') - late.indexOf('## Observations') > 600);
});

test('structured identities avoid delimiter collisions and preserve vault distinctions', () => {
  assert.notEqual(identityKey(identity('A', 'B:C.md')), identityKey(identity('A:B', 'C.md')));
  assert.notEqual(identityKey(identity('Workshop')), identityKey(identity('Harbor')));
  assert.equal(identityKey(identity('A', 'Fjäder.md')), identityKey(identity('A', 'Fjäder.md'.normalize('NFD'))));
});

test('scope excludes prefix siblings, unselected vaults, removed sources and references', () => {
  const scoped = eligibleNotes(fixture.queries.find(query => query.id === 'directory-scope'));
  assert.ok(scoped.every(note => note.vault === 'Workshop' && note.path.startsWith('Guides/')));
  assert.ok(!scoped.some(note => note.path.startsWith('Guides-extra/')));
  assert.ok(eligibleNotes(fixture.queries.find(query => query.id === 'selected-vault')).every(note => note.vault === 'Harbor'));
  const similar = fixture.queries.find(query => query.id === 'similar-airlock');
  assert.ok(eligibleNotes(similar).every(note => !note.removeAfterIndex && identityKey(note) !== identityKey(similar.reference)));
});

test('harness metrics retain duplicate rank penalties even with legacy dist metrics', () => {
  const a = identity('Workshop');
  const b = identity('Harbor');
  const query = { id: 'q', relevant: [a, b] };
  const scored = scoreRanking(query, [a, a, b], metrics, 3);
  assert.equal(scored.duplicateHits, 1);
  assert.deepEqual(scored.ranks.map(row => row.duplicateOf), [null, 1, null]);
  assert.deepEqual(scored.relevantRanks.map(row => row.rank), [1, 3]);
  assert.equal(scored.metrics.recallAtK, 1);
  assert.equal(scored.metrics.mrr, 1);
  approx(scored.metrics.ndcgAtK, 1.5 / (1 + 1 / Math.log2(3)));
  assert.equal(scoreRanking({ id: 'q', relevant: [a] }, [a, a, a], metrics).metrics.ndcgAtK, 1);
  const missed = scoreRanking(query, [identity('Other'), identity('Other'), a], metrics);
  assert.equal(missed.metrics.recallAtK, 0.5);
  approx(missed.metrics.mrr, 1 / 3);
  assert.equal(missed.relevantRanks[1].rank, null);
});

test('no-answer false positives remain separate from answerable metrics', () => {
  const a = identity('Workshop');
  const scored = scoreRanking({ id: 'none', relevant: [] }, [a, a], metrics);
  assert.equal(scored.metrics, null);
  assert.equal(scored.noAnswerFalsePositives, 2);
  assert.equal(scored.duplicateHits, 1);
  assert.equal(scoreRanking({ id: 'none', relevant: [] }, [], metrics).noAnswerFalsePositives, 0);
});

test('UTF-8 response accounting measures the actual envelope, not string length', () => {
  const response = { content: [{ type: 'text', text: 'Ångström 日本語' }], isError: false };
  assert.equal(utf8ResponseBytes(response), Buffer.byteLength(JSON.stringify(response)));
  assert.ok(utf8ResponseBytes(response) > JSON.stringify(response).length);
});

test('evidence validation binds excerpt to exact identity and indexed generation', () => {
  const row = { vault: 'A', filePath: 'Same.md', blockId: 'late', contentHash: 'hash', updatedAt: 42,
    metadata: { modelIdentity: 'model@digest' }, content: 'First paragraph.\nA late éclair appears.' };
  const hit = { ...identity('A'), evidence: { state: 'available', source: 'indexed_embedding_text', blockId: 'late',
    contentHash: 'hash', modelIdentity: 'model@digest', updatedAt: 42, excerpt: 'éclair', currentSourceVerified: false } };
  assert.equal(inspectEvidence(hit, [row], true).state, 'valid');
  for (const changed of [{ blockId: 'other' }, { contentHash: 'old' }, { modelIdentity: 'other' }, { updatedAt: 41 },
    { excerpt: 'invented quote' }, { currentSourceVerified: true }]) {
    assert.equal(inspectEvidence({ ...hit, evidence: { ...hit.evidence, ...changed } }, [row], true).state, 'invalid');
  }
  assert.equal(inspectEvidence({ ...hit, vault: 'B' }, [row], true).state, 'invalid');
  assert.equal(inspectEvidence(identity('A'), [row], true).state, 'missing');
  assert.equal(inspectEvidence(identity('A'), [row], false).state, 'not_requested');
  assert.equal(inspectEvidence({ evidence: { state: 'unavailable', reason: 'missing_indexed_text' } }, [], true).state, 'unavailable');
});

test('independent reference policies normalize each chunk and ignore repeated introductions without labels', () => {
  const vector = normalizedMean([[10, 0], [0, 1]]);
  approx(vector[0], Math.SQRT1_2);
  approx(vector[1], Math.SQRT1_2);
  assert.throws(() => normalizedMean([[0, 0]]));
  assert.throws(() => normalizedMean([[1, 0], [1]]));
  const rows = [
    { vault: 'A', filePath: 'reference.md', content: '# Heading\n\nSign the very long shared administrative introduction.' },
    { vault: 'A', filePath: 'reference.md', content: 'Repair the valve.' },
    { vault: 'A', filePath: 'two.md', content: 'Sign the very long shared administrative introduction.' },
    { vault: 'B', filePath: 'three.md', content: 'Sign the very long shared administrative introduction.' },
  ];
  assert.equal(meaningfulSection(rows.slice(0, 2), rows), rows[1]);
});

test('reference comparisons fix target max-per-file aggregation, exclude self, and break ties deterministically', () => {
  const reference = identity('A', 'reference.md');
  const row = (filePath, similarity, extra = {}) => ({ vault: 'A', filePath, embedding: [similarity], blockId: 'b', ...extra });
  const hits = rankReference([1], reference, [row('reference.md', 1), row('b.md', 0.9), row('b.md', 0.8),
    row('a.md', 0.9), row('gone.md', 1, { removed: true }), row('cross.md', 1, { vault: 'B' }), row('negative.md', -1)],
  (_a, b) => b[0]);
  assert.deepEqual(hits.map(hit => hit.path), ['a.md', 'b.md']);
});

test('dist selection accepts an ordinary directory or file URL with spaces', () => {
  const directory = path.resolve('/tmp/s06 dist');
  assert.equal(distUrl(directory).href, pathToFileURL(directory + path.sep).href);
  assert.equal(distUrl(pathToFileURL(directory).href).href, distUrl(directory).href);
  assert.throws(() => distUrl('file:///tmp/dist/?wrong=yes'));
});

test('synthetic vaults never use configured paths and clean notes plus derived files on success and error', async () => {
  const previous = process.env.OBSIDIAN_VAULTS;
  process.env.OBSIDIAN_VAULTS = '{"Private":"/must/not/be/opened"}';
  try {
    let root;
    await withSyntheticVaults(fixture, async state => {
      root = state.root;
      assert.ok(state.vaults.every(vault => vault.path.startsWith(root + path.sep)));
      const note = fixture.notes[0];
      assert.equal(await readFile(path.join(root, note.vault, note.path), 'utf8'), note.content);
      await writeFile(path.join(root, 'derived.sqlite'), 'synthetic derived data');
    });
    await assert.rejects(access(root), { code: 'ENOENT' });
    await assert.rejects(withSyntheticVaults(fixture, async state => {
      root = state.root;
      await writeFile(path.join(root, 'derived.sqlite'), 'synthetic derived data');
      throw new Error('deliberate failure');
    }), /deliberate failure/);
    await assert.rejects(access(root), { code: 'ENOENT' });
    assert.equal(process.env.OBSIDIAN_VAULTS, '{"Private":"/must/not/be/opened"}');
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULTS;
    else process.env.OBSIDIAN_VAULTS = previous;
  }
});

test('invalid fixture paths and relevance labels fail before creating synthetic files', () => {
  assert.throws(() => validateFixture({ ...fixture, notes: [{ ...fixture.notes[0], path: '../escape.md' }] }));
  assert.throws(() => validateFixture({ ...fixture, queries: [{ ...fixture.queries[0], relevant: [identity('Private')] }] }));
});
