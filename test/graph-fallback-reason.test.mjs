/**
 * Obsidian→filesystem fallback observability (issue #32).
 *
 * When the Obsidian provider is SELECTED/ATTEMPTED and throws (e.g. ENOBUFS on a
 * >1 MB eval payload), buildVaultGraph degrades to the filesystem approximation.
 * Before #32 this was SILENT (provider:"filesystem", no reason). Now it attaches
 * a SANITIZED `providerFallbackReason`.
 *
 * Verifies:
 *   (1) A fake Obsidian provider throwing an ENOBUFS-style multiline error with
 *       absolute paths → provider === 'filesystem' AND providerFallbackReason is
 *       PRESENT, mentions the Obsidian failure, is bounded, and contains NO
 *       absolute path.
 *   (2) A filesystem provider selected NORMALLY (never attempts Obsidian) →
 *       providerFallbackReason is ABSENT.
 *   (3) sanitizeFallbackReason strips paths + truncates a deliberately nasty
 *       payload.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempVault, cleanup } from './helpers.mjs';

const { FilesystemProvider, buildVaultGraph } = await import('../dist/graph/index.js');
const { sanitizeFallbackReason } = await import('../dist/graph/build.js');

function buildVault() {
  return {
    'Hub.md': 'See [[A]] and [[B]].',
    'A.md': 'Back to [[Hub]].',
    'B.md': 'Back to [[Hub]].',
  };
}

// A fake provider that LOOKS like the Obsidian provider (name:'obsidian') and
// throws an ENOBUFS-style error — exactly what execCli surfaces when the eval
// payload overruns maxBuffer. Multiline, >200 chars, embeds absolute paths.
class ThrowingObsidianProvider {
  constructor() {
    this.name = 'obsidian';
  }
  async build() {
    const e = new Error(
      'CLI error: spawn maxBuffer length exceeded (ENOBUFS) at /Users/wicked/dev/repos/mcp-obsidian/dist/cli/bridge.js:48 ' +
        'while serializing app.metadataCache.resolvedLinks for vault /home/secret/00 Influencentricity OS — ' +
        'payload 1172413 bytes exceeded the configured ceiling and the process was killed before stdout drained completely\n' +
        'stderr line 1: /Users/wicked/private/path/leaked.md contents here\n' +
        'stderr line 2: more internal detail'
    );
    throw e;
  }
}

describe('buildVaultGraph fallback reason (#32)', () => {
  let dir;
  before(() => {
    dir = createTempVault(buildVault());
  });
  after(() => {
    if (dir) cleanup(dir);
  });

  test('attempted-Obsidian failure → filesystem + sanitized providerFallbackReason', async () => {
    const graph = await buildVaultGraph(dir, new ThrowingObsidianProvider());

    assert.equal(graph.provider, 'filesystem', 'degrades to filesystem');
    assert.ok(graph.nodes.includes('Hub.md'), 'still produced the vault graph');

    const reason = graph.providerFallbackReason;
    assert.ok(reason, 'providerFallbackReason must be PRESENT on the fallback path');
    assert.match(reason, /Obsidian/, 'must mention the Obsidian failure');
    assert.match(reason, /filesystem/, 'must mention the filesystem approximation');

    // No absolute path leaked.
    assert.ok(!reason.includes('/Users'), 'no /Users path');
    assert.ok(!reason.includes('/home'), 'no /home path');
    assert.ok(!/\/[A-Za-z0-9_]+\//.test(reason), 'no absolute path segments');

    // Bounded length (first-line + truncation). Wrapped form stays well-bounded.
    assert.ok(reason.length <= 280, `reason bounded, got ${reason.length}`);

    // First-line only: the stderr lines must NOT appear.
    assert.ok(!reason.includes('stderr line'), 'second/third lines stripped');
  });

  test('normally-selected filesystem provider → NO providerFallbackReason', async () => {
    const graph = await buildVaultGraph(dir, new FilesystemProvider());
    assert.equal(graph.provider, 'filesystem');
    assert.equal(
      graph.providerFallbackReason,
      undefined,
      'never set on the non-fallback path'
    );
  });
});

describe('sanitizeFallbackReason (#32) — nasty payload', () => {
  test('strips absolute paths, takes first line, truncates, mentions Obsidian', () => {
    const nasty = new Error(
      'Boom at /Users/wicked/dev/x/y/z.md and /home/u748067201/domains/site/public_html/wp.php ' +
        'plus a giant payload: ' +
        'A'.repeat(500) +
        '\nLINE TWO MUST BE DROPPED /Users/secret/leak.md'
    );
    const out = sanitizeFallbackReason(nasty);

    assert.match(out, /^Obsidian graph provider failed:/);
    assert.match(out, /used filesystem approximation$/);
    assert.ok(!out.includes('/Users'), 'no /Users');
    assert.ok(!out.includes('/home'), 'no /home');
    assert.ok(!out.includes('LINE TWO'), 'second line dropped');
    // Inner sanitized reason bounded ~200; total wrapped stays bounded.
    assert.ok(out.length <= 280, `bounded length, got ${out.length}`);
  });

  test('empty / non-Error input still yields a safe wrapped reason', () => {
    assert.match(sanitizeFallbackReason(''), /^Obsidian graph provider failed: .*filesystem approximation$/);
    assert.match(sanitizeFallbackReason(undefined), /Obsidian graph provider failed/);
  });
});
