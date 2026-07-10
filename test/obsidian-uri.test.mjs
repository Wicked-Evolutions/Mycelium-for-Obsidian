import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractObsidianUris,
  parseObsidianUri,
  serializeObsidianUri,
} from '../dist/parsers/obsidian-uri.js';

function codes(parsed) {
  return new Set(parsed.diagnostics.map(d => d.code));
}

test('official encoded URI parses, locates, and round-trips canonically', () => {
  const markdown = 'x\n[Read](obsidian://open?vault=My%20Vault&file=Folder%2FHej%20%E2%9C%93%23Heading)';
  const [link] = extractObsidianUris(markdown);

  assert.equal(link.vault, 'My Vault');
  assert.equal(link.file, 'Folder/Hej ✓');
  assert.equal(link.subpath, 'Heading');
  assert.equal(link.line, 2);
  assert.equal(link.column, 1);
  assert.equal(link.offset, 2);
  assert.equal(link.raw, 'obsidian://open?vault=My%20Vault&file=Folder%2FHej%20%E2%9C%93%23Heading');
  assert.equal(link.canonicalUri, link.raw);
  assert.equal(link.noncanonical, false);
  assert.deepEqual(link.diagnostics, []);
  assert.equal(
    serializeObsidianUri({ vault: link.vault, file: `${link.file}.md`, subpath: link.subpath }),
    link.raw,
  );
});

test('canonicalization explains query order, .md, casing, spaces, and literal plus', () => {
  const rawPlus = parseObsidianUri('obsidian://open?file=One+Two.md&vault=V');
  assert.equal(rawPlus.file, 'One Two.md');
  assert.equal(rawPlus.canonicalUri, 'obsidian://open?vault=V&file=One%20Two');
  assert.equal(rawPlus.noncanonical, true);
  assert.ok(codes(rawPlus).has('raw_plus_as_space'));
  assert.ok(codes(rawPlus).has('markdown_extension_present'));
  assert.ok(codes(rawPlus).has('noncanonical_uri'));

  const literalPlus = parseObsidianUri('obsidian://open?vault=V&file=One%2BTwo');
  assert.equal(literalPlus.file, 'One+Two');
  assert.equal(literalPlus.noncanonical, false);
  assert.equal(literalPlus.canonicalUri, literalPlus.raw);

  assert.equal(
    serializeObsidianUri({ vault: "J's Vault", file: 'Folder/Note (Draft)!' }),
    'obsidian://open?vault=J%27s%20Vault&file=Folder%2FNote%20%28Draft%29%21',
  );

  const mixedCase = parseObsidianUri('ObSiDiAn://OPEN?vault=V&file=N');
  assert.equal(mixedCase.file, 'N');
  assert.equal(mixedCase.canonicalUri, 'obsidian://open?vault=V&file=N');
  assert.ok(codes(mixedCase).has('noncanonical_uri'));
});

test('parser reports malformed, unsupported, and unsafe URI forms precisely', () => {
  const cases = [
    ['obsidian://open?vault=V&file=%ZZ', 'malformed_percent_encoding'],
    ['obsidian://open?vault=%ZZ&vault=V&file=N', 'duplicate_query_param'],
    ['obsidian://open?vault=V', 'missing_file'],
    ['obsidian://open?file=N', 'missing_vault'],
    ['obsidian://open?vault=V&file=%23Heading', 'missing_file'],
    ['obsidian://open?vault=V&file=N%23', 'invalid_subpath'],
    ['obsidian://open?vault=V&file=N&path=%2Ftmp%2FN', 'path_override'],
    ['obsidian://open?vault=V&file=N&extra=x', 'unknown_query_param'],
    ['obsidian://daily?vault=V&file=N', 'unsupported_action'],
    ['obsidian://open/x?vault=V&file=N', 'unsupported_shorthand'],
    ['obsidian://open?vault=V&file=N#H', 'fragment'],
    ['obsidian://open?vault=V&file=..%2FN', 'invalid_path'],
    ['obsidian://open?vault=V&file=%2Fetc%2FN', 'invalid_path'],
    ['obsidian://open?vault=V&file=C%3AN', 'invalid_path'],
    ['obsidian://open?vault=V&file=dir%5CN', 'invalid_path'],
    ['obsidian://open?vault=V&file=N%00x', 'invalid_path'],
    ['obsidian://open?vault=V&file=.%2FN', 'invalid_path'],
    ['obsidian://open?vault=V&file=dir%2F%2FN', 'invalid_path'],
    ['obsidian://open?vault=V&file=N.pdf', 'non_markdown_target'],
  ];

  for (const [uri, expected] of cases) {
    const parsed = parseObsidianUri(uri);
    assert.ok(codes(parsed).has(expected), `${uri} -> ${expected}: ${JSON.stringify(parsed.diagnostics)}`);
    assert.equal(parsed.canonicalUri, undefined, `${uri} must not advertise a canonical supported relationship`);
    assert.ok(
      parsed.diagnostics.every(d => d.severity === 'error' || d.severity === 'warning'),
      `${uri} diagnostic severity`,
    );
  }
});

test('serializer rejects unsafe, empty, and non-note inputs', () => {
  assert.throws(() => serializeObsidianUri({ vault: '', file: 'N' }), /vault/i);
  assert.throws(() => serializeObsidianUri({ vault: 'V', file: '' }), /file/i);
  assert.throws(() => serializeObsidianUri({ vault: 'V', file: '../N' }), /vault-relative/i);
  assert.throws(() => serializeObsidianUri({ vault: 'V', file: 'Asset.pdf' }), /Markdown/i);
  assert.throws(() => serializeObsidianUri({ vault: 'V', file: 'N', subpath: '' }), /subpath/i);
});

test('extractor supports canonical Markdown destinations and ignores non-relationships', () => {
  const source = [
    '![image](obsidian://open?vault=V&file=Image)',
    '`[code](obsidian://open?vault=V&file=Code)`',
    '``[two ticks](obsidian://open?vault=V&file=Two)``',
    '```md',
    '[fence](obsidian://open?vault=V&file=Fence)',
    '~~~',
    '```',
    '[real](<obsidian://open?vault=V&file=Real%23%5Eblock> "title")',
    'obsidian://open?vault=V&file=Bare',
    '<obsidian://open?vault=V&file=Autolink>',
  ].join('\n');

  const links = extractObsidianUris(source);
  assert.equal(links.length, 1);
  assert.equal(links[0].label, 'real');
  assert.equal(links[0].file, 'Real');
  assert.equal(links[0].subpath, '^block');
});

test('different fence markers do not accidentally close each other', () => {
  const source = [
    '~~~md',
    '[hidden](obsidian://open?vault=V&file=Hidden)',
    '```',
    '[still hidden](obsidian://open?vault=V&file=StillHidden)',
    '~~~',
    '[visible](obsidian://open?vault=V&file=Visible)',
  ].join('\n');
  const links = extractObsidianUris(source);
  assert.deepEqual(links.map(link => link.file), ['Visible']);
});
