import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureIndexedEvidence,
  compactSemanticHit,
  finalizeIndexedEvidence,
} from '../dist/tools/retrieval-evidence.js';

const modelIdentity = 'fixture:latest@sha256:exact';
const candidate = { filePath: 'Notes/Exact.md', blockId: 'section-2' };

function fixture(content = 'Indexed passage') {
  const calls = [];
  const store = {
    generation: 'physical-generation-1',
    row: {
      ...candidate,
      contentHash: 'stored-content-hash',
      metadata: { modelIdentity, heading: '## Stored heading', startLine: 200 },
      updatedAt: 123456789,
      get embedding() { throw new Error('Evidence must not read vectors'); },
    },
    content,
    get(filePath, blockId) {
      calls.push(['get', filePath, blockId]);
      return this.row;
    },
    getContent(filePath, blockId) {
      calls.push(['getContent', filePath, blockId]);
      return this.content;
    },
    getEvidenceGeneration() {
      calls.push(['generation']);
      return this.generation;
    },
  };
  return { store, calls };
}

function capture(store, query = 'passage', hit = candidate) {
  return captureIndexedEvidence(store, hit, modelIdentity, query, true);
}

function evidenceFor(content, query = '') {
  return finalizeIndexedEvidence(capture(fixture(content).store, query));
}

test('available evidence uses exact indexed identity and only the contracted fields', () => {
  const { store, calls } = fixture();
  const snapshot = capture(store);
  assert.equal(typeof snapshot, 'function', 'capture is synchronous');
  assert.deepEqual(finalizeIndexedEvidence(snapshot), {
    state: 'available',
    source: 'indexed_embedding_text',
    blockId: candidate.blockId,
    contentHash: 'stored-content-hash',
    modelIdentity,
    updatedAt: 123456789,
    heading: '## Stored heading',
    headingTruncated: false,
    excerpt: 'Indexed passage',
    truncatedBefore: false,
    truncatedAfter: false,
    currentSourceVerified: false,
  });
  assert.deepEqual(calls, [
    ['generation'], ['get', candidate.filePath, candidate.blockId],
    ['getContent', candidate.filePath, candidate.blockId], ['generation'], ['generation'],
  ]);
});

test('omitted and false includeEvidence do no reads or excerpt work', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('Unexpected access'); } });
  for (const enabled of [undefined, false]) {
    const snapshot = captureIndexedEvidence(forbidden, forbidden, modelIdentity, forbidden, enabled);
    assert.equal(snapshot, undefined);
    assert.equal(finalizeIndexedEvidence(snapshot), undefined);
  }
});

test('snapshot copies primitive metadata before await and cannot be mutated through output', async () => {
  const { store, calls } = fixture();
  Object.defineProperty(store.row.metadata, 'unrelated', {
    get() { throw new Error('Do not clone unrelated metadata'); }, enumerable: true,
  });
  const mutableCandidate = { ...candidate };
  const snapshot = capture(store, 'passage', mutableCandidate);
  const original = finalizeIndexedEvidence(snapshot);
  await Promise.resolve();
  mutableCandidate.filePath = 'Other.md';
  mutableCandidate.blockId = 'other';
  store.row.contentHash = 'mutated';
  store.row.updatedAt = 999;
  store.row.metadata.heading = 'Changed heading';
  store.row.metadata.modelIdentity = 'different-model';
  store.content = 'Replacement text';
  assert.deepEqual(finalizeIndexedEvidence(snapshot), original);
  const emitted = finalizeIndexedEvidence(snapshot);
  emitted.excerpt = 'Caller mutation';
  emitted.heading = 'Caller heading';
  assert.deepEqual(finalizeIndexedEvidence(snapshot), original);
  assert.equal(calls.filter(([method]) => method === 'get').length, 1);
  assert.equal(calls.filter(([method]) => method === 'getContent').length, 1);
});

test('heading is optional and never inferred from embedding text or current source', () => {
  for (const heading of [undefined, null, { text: 'Not a stored string' }]) {
    const { store } = fixture('# Repeated embedding heading\nIndexed passage');
    store.row.metadata.heading = heading;
    const evidence = finalizeIndexedEvidence(capture(store));
    assert.equal(evidence.state, 'available');
    assert.equal('heading' in evidence, false);
    assert.equal('startLine' in evidence, false);
  }
});

test('heading display is bounded by Unicode code points without truncating identity', () => {
  const { store } = fixture();
  store.row.metadata.heading = '\u{1F9ED}'.repeat(161);
  const evidence = finalizeIndexedEvidence(capture(store));
  assert.equal(Array.from(evidence.heading).length, 160);
  assert.equal(evidence.headingTruncated, true);
  assert.equal(evidence.blockId, candidate.blockId);
  assert.equal(evidence.contentHash, store.row.contentHash);
});

test('exact whole-file and keyword-only candidates use the same evidence lookup', () => {
  const { store } = fixture('Keyword-only passage');
  store.row.blockId = null;
  const evidence = finalizeIndexedEvidence(capture(store, 'Keyword-only', {
    filePath: candidate.filePath, blockId: null, score: 8,
  }));
  assert.equal(evidence.state, 'available');
  assert.equal(evidence.blockId, null);
  assert.equal(evidence.excerpt, 'Keyword-only passage');
});

for (const [label, mutate, hit] of [
  ['missing row', store => { store.row = null; }],
  ['different path', store => { store.row.filePath = 'Different.md'; }],
  ['different block', store => { store.row.blockId = 'section-1'; }],
  ['whole-file fallback to section', () => {}, { ...candidate, blockId: null }],
  ['section fallback to whole file', store => { store.row.blockId = null; }],
  ['different model', store => { store.row.metadata.modelIdentity = `${modelIdentity}-other`; }],
  ['missing model', store => { delete store.row.metadata.modelIdentity; }],
  ['missing hash', store => { store.row.contentHash = ''; }],
  ['missing timestamp', store => { store.row.updatedAt = undefined; }],
  ['nonfinite timestamp', store => { store.row.updatedAt = NaN; }],
]) {
  test(`unverified identity rejects ${label} without content fallback`, () => {
    const { store, calls } = fixture();
    mutate(store);
    assert.deepEqual(finalizeIndexedEvidence(capture(store, '', hit)), {
      state: 'unavailable', reason: 'indexed_identity_unverified',
    });
    assert.equal(calls.some(([method]) => method === 'getContent'), false);
  });
}

test('missing exact FTS remains unavailable even if content appears after await', async () => {
  const { store, calls } = fixture(null);
  const snapshot = capture(store);
  await Promise.resolve();
  store.content = 'Newly available whole-file or other-block content';
  assert.deepEqual(finalizeIndexedEvidence(snapshot), {
    state: 'unavailable', reason: 'indexed_content_missing',
  });
  assert.equal(calls.filter(([method]) => method === 'getContent').length, 1);
});

test('empty exact FTS text is available, not missing', () => {
  const evidence = evidenceFor('');
  assert.equal(evidence.state, 'available');
  assert.equal(evidence.excerpt, '');
  assert.equal(evidence.truncatedBefore, false);
  assert.equal(evidence.truncatedAfter, false);
});

for (const initial of [null, '']) {
  test(`unpublished or unidentified generation (${JSON.stringify(initial)}) does not capture content`, () => {
    const { store, calls } = fixture();
    store.generation = initial;
    const snapshot = capture(store);
    store.generation = 'later-publication';
    assert.deepEqual(finalizeIndexedEvidence(snapshot), {
      state: 'unavailable', reason: 'indexed_generation_unavailable',
    });
    assert.deepEqual(calls, [['generation']]);
  });
}

for (const [generation, reason] of [
  ['physical-generation-2', 'indexed_generation_changed'],
  [null, 'indexed_generation_unavailable'],
]) {
  test(`generation ${JSON.stringify(generation)} after await prevents stale emission and fallback`, async () => {
    const { store, calls } = fixture();
    const snapshot = capture(store);
    await Promise.resolve();
    store.generation = generation;
    store.content = 'Do not substitute this generation';
    store.row.contentHash = 'new-hash';
    assert.deepEqual(finalizeIndexedEvidence(snapshot), { state: 'unavailable', reason });
    store.generation = 'physical-generation-1';
    assert.deepEqual(finalizeIndexedEvidence(snapshot), { state: 'unavailable', reason });
    assert.equal(calls.filter(([method]) => method === 'getContent').length, 1);
  });
}

test('each candidate captures its own admission generation', async () => {
  const { store } = fixture();
  const first = capture(store);
  await Promise.resolve();
  store.generation = 'physical-generation-2';
  store.row.blockId = 'later-section';
  store.content = 'Later indexed section';
  const second = capture(store, 'Later', { ...candidate, blockId: 'later-section' });
  assert.deepEqual(finalizeIndexedEvidence(first), {
    state: 'unavailable', reason: 'indexed_generation_changed',
  });
  const evidence = finalizeIndexedEvidence(second);
  assert.equal(evidence.state, 'available');
  assert.equal(evidence.blockId, 'later-section');
  assert.equal(evidence.excerpt, 'Later indexed section');
});

test('generation changes within synchronous capture cannot mix row and FTS identities', () => {
  const { store } = fixture();
  store.getContent = () => {
    store.generation = 'physical-generation-2';
    return 'Different generation text';
  };
  assert.deepEqual(finalizeIndexedEvidence(capture(store)), {
    state: 'unavailable', reason: 'indexed_generation_changed',
  });
});

for (const method of ['get', 'getContent', 'getEvidenceGeneration']) {
  test(`storage failure in ${method} returns only a fixed reason, without diagnostics`, () => {
    const { store } = fixture();
    store[method] = () => { throw new Error('/private/source secret diagnostics'); };
    assert.deepEqual(finalizeIndexedEvidence(capture(store)), {
      state: 'unavailable',
      reason: method === 'getEvidenceGeneration'
        ? 'indexed_generation_unavailable' : 'indexed_identity_unverified',
    });
  });
}

test('authority failure during finalization cannot emit captured text', () => {
  const { store } = fixture();
  const snapshot = capture(store);
  store.getEvidenceGeneration = () => { throw new Error('Authority revoked'); };
  assert.deepEqual(finalizeIndexedEvidence(snapshot), {
    state: 'unavailable', reason: 'indexed_generation_unavailable',
  });
});

test('readable edited source is independent of the unchanged indexed generation', async () => {
  const { store } = fixture('Previously indexed passage');
  let readableSource = 'Previously indexed passage';
  const snapshot = capture(store);
  await Promise.resolve();
  readableSource = '# Edited title\nCurrent readable text';
  const evidence = finalizeIndexedEvidence(snapshot);
  assert.equal(evidence.state, 'available');
  assert.equal(evidence.excerpt, 'Previously indexed passage');
  assert.notEqual(evidence.excerpt, readableSource);
  assert.equal(evidence.currentSourceVerified, false);
});

test('late match is centered in at most 600 Unicode code points', () => {
  const prefix = '\u{1f680}'.repeat(900);
  const content = `${prefix}needle${'\u{10400}'.repeat(900)}`;
  const evidence = evidenceFor(content, 'needle');
  assert.equal(Array.from(evidence.excerpt).length, 600);
  assert.equal(evidence.excerpt, Array.from(content).slice(603, 1203).join(''));
  assert.equal(evidence.excerpt.isWellFormed(), true);
  assert.equal(evidence.truncatedBefore, true);
  assert.equal(evidence.truncatedAfter, true);
});

test('the first literal token match in text wins, not query order or regex syntax', () => {
  const content = `${'x'.repeat(800)}a+b${'x'.repeat(800)}later${'x'.repeat(800)}`;
  const evidence = evidenceFor(content, 'later a+b');
  assert.equal(evidence.excerpt, content.slice(501, 1101));
  assert.equal(evidence.excerpt.includes('later'), false);
  assert.equal(evidenceFor(content, 'a.*b').truncatedBefore, false);
});

test('literal matching preserves case, Unicode normalization and combining marks', () => {
  const token = 'cafe\u0301';
  const content = `${'x'.repeat(800)}${token}${'x'.repeat(800)}`;
  assert.equal(evidenceFor(content, token).excerpt.includes(token), true);
  assert.equal(evidenceFor(content, 'caf\u00e9').truncatedBefore, false);
  assert.equal(evidenceFor(content, 'CAFE\u0301').truncatedBefore, false);
});

test('prefix and tail boundaries report exactly what was truncated', () => {
  for (const query of ['', '  \t\n', 'unmatched']) {
    const evidence = evidenceFor('\u{1f680}'.repeat(601), query);
    assert.equal(evidence.excerpt, '\u{1f680}'.repeat(600));
    assert.equal(evidence.truncatedBefore, false);
    assert.equal(evidence.truncatedAfter, true);
  }
  for (const size of [1, 599, 600]) {
    const evidence = evidenceFor('\u{1f680}'.repeat(size));
    assert.equal(Array.from(evidence.excerpt).length, size);
    assert.equal(evidence.truncatedBefore, false);
    assert.equal(evidence.truncatedAfter, false);
  }
  const content = `${'x'.repeat(1000)}needle`;
  const tail = evidenceFor(content, 'needle');
  assert.equal(tail.excerpt, content.slice(-600));
  assert.equal(tail.truncatedBefore, true);
  assert.equal(tail.truncatedAfter, false);
  const head = evidenceFor(`needle${'x'.repeat(1000)}`, 'needle');
  assert.equal(head.truncatedBefore, false);
  assert.equal(head.truncatedAfter, true);
});

test('compact semantic hits preserve identities and scores while projecting only contracted fields', () => {
  const evidence = evidenceFor('Indexed evidence');
  const hit = {
    path: `${'folder/'.repeat(150)}Cafe\u0301.md`, vault: 'Vault'.repeat(200),
    title: '\u{1f680}'.repeat(161), similarity: -0.25,
    fusionScore: 0.123456789, fusionMethod: 'rrf', reranker_score: null, evidence,
    preview: 'Verbose preview', semanticScore: 0.8, keywordScore: 1,
    per_signal: { bm25: { rank: 1 } }, rrf_term: { k: 60 }, graph: { degree: 42 },
  };
  const original = structuredClone(hit);
  assert.deepEqual(compactSemanticHit(hit), {
    path: hit.path, vault: hit.vault, title: '\u{1f680}'.repeat(160), similarity: -0.25,
    fusionScore: 0.123456789, fusionMethod: 'rrf', reranker_score: null, evidence,
  });
  assert.deepEqual(hit, original, 'projection never mutates the full hit');
});

test('compact projection preserves order, duplicates, optional fields and zero scores', () => {
  const evidence = { state: 'unavailable', reason: 'indexed_content_missing' };
  const hits = [
    { path: 'B.md', title: 'B', similarity: 0.4 },
    { path: 'A.md', title: 'A', similarity: 0, fusionScore: 0, reranker_score: 0, evidence },
    { path: 'B.md', title: 'Duplicate', similarity: 0.2 },
  ];
  assert.deepEqual(hits.map(compactSemanticHit), hits);
  assert.equal('evidence' in compactSemanticHit(hits[0]), false);
  assert.equal('vault' in compactSemanticHit(hits[0]), false);
});
