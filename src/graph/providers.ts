/**
 * Graph-source providers for L4.
 *
 * Primary: Obsidian-runtime provider — reads app.metadataCache.resolvedLinks
 * via the eval_obsidian bridge (exact graph-view parity, Flag 1 solved exactly).
 *
 * Fallback: filesystem provider — a buildBacklinkIndex-style pass for
 * headless/CI/Obsidian-closed. Heuristic resolution (same-folder → shortest-path
 * → first-occurrence) reusing resolveWikilink with a multi-candidate index.
 *
 * Provider selection respects OBSIDIAN_DISABLED_TOOLS=eval_obsidian and
 * isCliAvailable(): when eval is disabled OR the CLI is unavailable, the
 * Obsidian provider is skipped and the filesystem fallback is used. We never
 * call evalInObsidian behind a disabled tool.
 *
 * Both providers normalize to the SAME edge shape: resolvedLinks keyed by
 * vault-relative source path (with .md) → { target (with .md) → count }.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import {
  extractWikilinksCooperative,
  buildMultiFileIndex,
  resolveWikilink,
  normalizeUnresolvedKey
} from '../parsers/wikilink.js';
import { parseJsonCancellable } from './json-parse.js';
import {
  evalInObsidian,
  evalInRegisteredVault,
  probeObsidianCli
} from '../cli/bridge.js';
import {
  abortableYield,
  canonicalPathsEqual,
  isAbortError,
  throwIfAborted
} from '../cli/vault-target.js';
import {
  GraphBuildContext,
  GraphProvider,
  GraphProviderState,
  ProviderResult
} from './types.js';

/**
 * Recursively collect all .md files (vault-relative paths, with .md).
 */
async function collectMarkdownPaths(
  vaultPath: string,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = [];
  let visitedEntries = 0;
  async function walk(dir: string): Promise<void> {
    throwIfAborted(signal);
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      visitedEntries += 1;
      if (signal && visitedEntries % 256 === 0) await abortableYield(signal);
      else throwIfAborted(signal);
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile() && d.name.endsWith('.md')) {
        out.push(path.relative(vaultPath, full));
      }
    }
  }
  await walk(vaultPath);
  return out;
}

// ─── Filesystem provider ─────────────────────────────────────────────────────

export class FilesystemProvider implements GraphProvider {
  readonly name = 'filesystem' as const;

  async build(vaultPath: string, context?: GraphBuildContext): Promise<ProviderResult> {
    const signal = context?.signal;
    const nodes = await collectMarkdownPaths(vaultPath, signal);
    throwIfAborted(signal);
    const multiIndex = await buildMultiFileIndex(vaultPath, signal);
    const resolvedLinks = new Map<string, Map<string, number>>();

    // Vault-level link-resolution aggregates (issue #37). SAME-VAULT only.
    let resolvedEdgeCount = 0;
    let unresolvedLinkCount = 0;
    const unresolvedTargets = new Set<string>();

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      if (signal && nodeIndex % 64 === 0) await abortableYield(signal);
      else throwIfAborted(signal);
      const rel = nodes[nodeIndex];
      const sourceAbs = path.join(vaultPath, rel);
      let content: string;
      try {
        content = await fs.readFile(sourceAbs, { encoding: 'utf8', signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        continue;
      }
      throwIfAborted(signal);
      const links = await extractWikilinksCooperative(content, signal);
      const targets = new Map<string, number>();

      for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
        if (signal && linkIndex % 256 === 0) await abortableYield(signal);
        else throwIfAborted(signal);
        const link = links[linkIndex];
        // Cross-vault links are EXTERNAL → out-only, never an internal edge
        // and never counted in the same-vault aggregates.
        if (link.vault) continue;

        // Resolve on the SUBPATH-STRIPPED path (graph-layer field), so
        // [[Note#Heading]] credits Note (Bug-3 / DR-6 heading stripping).
        const linkPath = link.path ?? link.target;
        if (!linkPath) continue;

        const resolvedAbs = await resolveWikilink(
          linkPath,
          vaultPath,
          undefined,
          sourceAbs,
          multiIndex
        );
        if (!resolvedAbs) {
          // Unresolved → out-only, no edge. Derive the distinct key + skip
          // decision via the SHARED helper on the verbatim rawTarget, so the
          // filesystem and Obsidian providers agree BY CONSTRUCTION. (Cross-vault
          // is already skipped above via link.vault; the helper's null case is
          // the same contract, and for same-vault targets the key equals the
          // resolver's stripped linkPath — behavior unchanged.)
          const key = normalizeUnresolvedKey(link.rawTarget ?? linkPath);
          if (key === null) continue; // cross-vault → not a same-vault unresolved link
          unresolvedLinkCount += 1;
          unresolvedTargets.add(key);
          continue;
        }

        const relTarget = path.relative(vaultPath, resolvedAbs);
        // Self-links that RESOLVE don't create graph edges and are NOT counted
        // as unresolved (excluded from both aggregates).
        if (relTarget === rel) continue;
        targets.set(relTarget, (targets.get(relTarget) || 0) + 1);
        resolvedEdgeCount += 1;
      }

      if (targets.size > 0) {
        resolvedLinks.set(rel, targets);
      }
    }

    return {
      nodes,
      resolvedLinks,
      resolvedEdgeCount,
      unresolvedLinkCount,
      distinctUnresolvedTargets: unresolvedTargets.size
    };
  }
}

// ─── Obsidian-runtime provider ───────────────────────────────────────────────

/**
 * Reads app.metadataCache.resolvedLinks via eval_obsidian. resolvedLinks is
 * already keyed source(.md) → { target(.md) → count } — exactly our shape.
 * Nodes are the markdown files known to the vault.
 */
export class ObsidianProvider implements GraphProvider {
  readonly name = 'obsidian' as const;
  constructor(
    private config: Config,
    private vaultName?: string,
    private exactTarget?: {
      registeredVaultId: string;
      expectedCanonicalPath: string;
    }
  ) {}

  async build(vaultPath: string, context?: GraphBuildContext): Promise<ProviderResult> {
    const signal = context?.signal;
    throwIfAborted(signal);
    // Build resolvedLinks + node set + RAW unresolved aggregation inside Obsidian
    // in one eval round-trip. app.metadataCache.unresolvedLinks is same-vault by
    // nature and keyed source(.md) → { targetText → count } (issue #37). The eval
    // returns the unresolved keys aggregated by RAW key (verbatim, summed across
    // .md sources) — it does NOT normalize. Normalization (cross-vault skip +
    // subpath/alias strip) happens below in TS via the SHARED
    // normalizeUnresolvedKey helper, so it is testable and agrees with the
    // filesystem provider BY CONSTRUCTION. Aggregating by key in eval keeps the
    // payload bounded by the distinct-concept count (the #32 maxBuffer discipline).
    const code = [
      '(() => {',
      '  const rl = app.metadataCache.resolvedLinks || {};',
      '  const links = {};',
      '  for (const src of Object.keys(rl)) {',
      "    if (!src.endsWith('.md')) continue;",
      '    const inner = rl[src];',
      '    const tgts = {};',
      '    for (const t of Object.keys(inner)) {',
      "      if (!t.endsWith('.md')) continue;",
      '      tgts[t] = inner[t];',
      '    }',
      '    links[src] = tgts;',
      '  }',
      '  const ul = app.metadataCache.unresolvedLinks || {};',
      '  const unresolvedRaw = {};',
      '  for (const src of Object.keys(ul)) {',
      "    if (!src.endsWith('.md')) continue;",
      '    const inner = ul[src];',
      '    for (const t of Object.keys(inner)) {',
      '      unresolvedRaw[t] = (unresolvedRaw[t] || 0) + inner[t];',
      '    }',
      '  }',
      "  const nodes = app.vault.getMarkdownFiles().map(f => f.path);",
      '  const adapter = app.vault.adapter;',
      "  const basePath = typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : adapter?.basePath;",
      '  return JSON.stringify({ nodes, links, unresolvedRaw, basePath });',
      '})()'
    ].join('\n');

    const raw = this.exactTarget
      ? await evalInRegisteredVault(
          this.exactTarget.registeredVaultId,
          code,
          60_000,
          signal
        )
      : await evalInObsidian(this.config, this.vaultName, code, 60_000, signal);
    await abortableYield(signal);
    const parsed = await parseEvalJson(raw, signal);
    await abortableYield(signal);

    if (this.exactTarget) {
      if (typeof parsed.basePath !== 'string') {
        throw new Error('Exact Obsidian target did not report its vault identity.');
      }
      const observedCanonical = await fs.realpath(parsed.basePath);
      if (!canonicalPathsEqual(observedCanonical, this.exactTarget.expectedCanonicalPath)) {
        throw new Error('Exact Obsidian target identity did not match the configured vault.');
      }
    }
    throwIfAborted(signal);

    const nodes: string[] = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const resolvedLinks = new Map<string, Map<string, number>>();
    const links = (parsed.links || {}) as Record<string, Record<string, number>>;
    // resolvedEdgeCount = sum of counts in the FILTERED resolvedLinks (after the
    // .md filter above + the self-link exclusion below), so it matches the edges.
    let resolvedEdgeCount = 0;
    const sources = Object.keys(links);
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      if (signal && sourceIndex % 256 === 0) await abortableYield(signal);
      const src = sources[sourceIndex];
      const inner = links[src];
      const m = new Map<string, number>();
      const targets = Object.keys(inner);
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        if (signal && targetIndex % 512 === 0) await abortableYield(signal);
        const t = targets[targetIndex];
        if (t === src) continue; // self-links excluded for parity with fs provider
        m.set(t, inner[t]);
        resolvedEdgeCount += inner[t];
      }
      if (m.size > 0) resolvedLinks.set(src, m);
    }

    // Normalize the RAW unresolved keys in TS via the SHARED helper: cross-vault
    // keys are skipped (null), heading/alias variants collapse to one distinct
    // key, and their occurrence counts are summed. This honors the same
    // "same-vault, resolver-consistent key" contract the filesystem provider uses.
    const unresolvedRaw = (parsed.unresolvedRaw || {}) as Record<string, number>;
    let unresolvedLinkCount = 0;
    const distinctUnresolved = new Set<string>();
    const unresolvedKeys = Object.keys(unresolvedRaw);
    for (let keyIndex = 0; keyIndex < unresolvedKeys.length; keyIndex += 1) {
      if (signal && keyIndex % 256 === 0) await abortableYield(signal);
      const rawKey = unresolvedKeys[keyIndex];
      const key = normalizeUnresolvedKey(rawKey);
      if (key === null) continue; // cross-vault → not a same-vault unresolved link
      unresolvedLinkCount += unresolvedRaw[rawKey];
      distinctUnresolved.add(key);
    }

    return {
      nodes,
      resolvedLinks,
      resolvedEdgeCount,
      unresolvedLinkCount,
      distinctUnresolvedTargets: distinctUnresolved.size
    };
  }
}

/**
 * The eval bridge may wrap output in quotes or prefix it. Try to parse a JSON
 * object from the returned string robustly.
 */
export async function parseEvalJson(raw: string, signal?: AbortSignal): Promise<{
  nodes?: string[];
  links?: Record<string, Record<string, number>>;
  unresolvedRaw?: Record<string, number>;
  basePath?: string;
}> {
  const s = raw;
  // The eval result is a JS string literal containing JSON; it may itself be
  // wrapped in quotes (e.g. '"{...}"'). Unwrap one layer of quoting if present.
  try {
    const first = await parseJsonCancellable<unknown>(s, signal);
    if (typeof first === 'string') {
      return await parseJsonCancellable(first, signal);
    }
    if (first && typeof first === 'object') {
      return first;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // fall through to substring extraction
  }
  // Last resort: extract the first {...} block.
  const { start, end } = await findObjectBounds(s, signal);
  if (start >= 0 && end > start) {
    return await parseJsonCancellable(s.slice(start, end + 1), signal);
  }
  throw new Error('Could not parse the exact Obsidian graph response.');
}

async function findObjectBounds(
  value: string,
  signal?: AbortSignal
): Promise<{ start: number; end: number }> {
  let start = -1;
  let end = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (signal && index % (64 * 1024) === 0) await abortableYield(signal);
    if (start < 0 && value[index] === '{') start = index;
    if (value[index] === '}') end = index;
  }
  return { start, end };
}

// ─── Provider selection ──────────────────────────────────────────────────────

/**
 * Decide which provider to use. The Obsidian provider is used ONLY when
 * eval_obsidian is not disabled AND the CLI is available. Otherwise the
 * filesystem fallback is used. This never calls evalInObsidian behind a
 * disabled tool.
 */
export async function selectProvider(
  config: Config,
  vaultName?: string
): Promise<GraphProvider> {
  return (await selectProviderWithState(config, vaultName)).provider;
}

export interface GraphProviderSelection {
  provider: GraphProvider;
  state: GraphProviderState;
  decisionKey: string;
}

function selection(
  provider: GraphProvider,
  state: GraphProviderState
): GraphProviderSelection {
  const decisionKey = [
    state.selectedProvider,
    state.exactProviderAvailability,
    state.degradationReason ?? 'none'
  ].join(':');
  return { provider, state, decisionKey };
}

/** Select a provider and retain a safe, explicit eligibility receipt. */
export async function selectProviderWithState(
  config: Config,
  vaultName?: string
): Promise<GraphProviderSelection> {
  const evalDisabled = config.disabledTools.has('eval_obsidian');
  if (evalDisabled) {
    return selection(new FilesystemProvider(), {
      selectedProvider: 'filesystem',
      approximate: true,
      exactProviderAvailability: 'disabled',
      exactProviderInvoked: false,
      degradationReason: 'eval_disabled'
    });
  }

  const probe = await probeObsidianCli();
  if (probe.status === 'available') {
    return selection(new ObsidianProvider(config, vaultName), {
      selectedProvider: 'obsidian',
      approximate: false,
      exactProviderAvailability: 'available',
      exactProviderInvoked: false
    });
  }

  const degradationReason =
    probe.status === 'cli_unavailable'
      ? 'cli_unavailable'
      : probe.status === 'obsidian_unavailable'
        ? 'obsidian_unavailable'
        : 'cli_probe_failed';
  return selection(new FilesystemProvider(), {
    selectedProvider: 'filesystem',
    approximate: true,
    exactProviderAvailability: probe.status,
    exactProviderInvoked: false,
    degradationReason
  });
}
