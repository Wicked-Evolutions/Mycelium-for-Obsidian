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
import { extractWikilinks, buildMultiFileIndex, resolveWikilink } from '../parsers/wikilink.js';
import { evalInObsidian, isCliAvailable } from '../cli/bridge.js';
import { GraphProvider, ProviderResult } from './types.js';

/**
 * Recursively collect all .md files (vault-relative paths, with .md).
 */
async function collectMarkdownPaths(vaultPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
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

  async build(vaultPath: string): Promise<ProviderResult> {
    const nodes = await collectMarkdownPaths(vaultPath);
    const multiIndex = await buildMultiFileIndex(vaultPath);
    const resolvedLinks = new Map<string, Map<string, number>>();

    for (const rel of nodes) {
      const sourceAbs = path.join(vaultPath, rel);
      let content: string;
      try {
        content = await fs.readFile(sourceAbs, 'utf-8');
      } catch {
        continue;
      }
      const links = extractWikilinks(content);
      const targets = new Map<string, number>();

      for (const link of links) {
        // Cross-vault links are EXTERNAL → out-only, never an internal edge.
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
        if (!resolvedAbs) continue; // unresolved → out-only, no edge

        const relTarget = path.relative(vaultPath, resolvedAbs);
        // Self-links don't create graph edges.
        if (relTarget === rel) continue;
        targets.set(relTarget, (targets.get(relTarget) || 0) + 1);
      }

      if (targets.size > 0) {
        resolvedLinks.set(rel, targets);
      }
    }

    return { nodes, resolvedLinks };
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
  constructor(private config: Config, private vaultName?: string) {}

  async build(vaultPath: string): Promise<ProviderResult> {
    // Build resolvedLinks + node set inside Obsidian in one eval round-trip.
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
      "  const nodes = app.vault.getMarkdownFiles().map(f => f.path);",
      '  return JSON.stringify({ nodes, links });',
      '})()'
    ].join('\n');

    const raw = await evalInObsidian(this.config, this.vaultName, code, 60000);
    const parsed = parseEvalJson(raw);

    const nodes: string[] = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const resolvedLinks = new Map<string, Map<string, number>>();
    const links = (parsed.links || {}) as Record<string, Record<string, number>>;
    for (const src of Object.keys(links)) {
      const inner = links[src];
      const m = new Map<string, number>();
      for (const t of Object.keys(inner)) {
        if (t === src) continue; // self-links excluded for parity with fs provider
        m.set(t, inner[t]);
      }
      if (m.size > 0) resolvedLinks.set(src, m);
    }

    return { nodes, resolvedLinks };
  }
}

/**
 * The eval bridge may wrap output in quotes or prefix it. Try to parse a JSON
 * object from the returned string robustly.
 */
function parseEvalJson(raw: string): { nodes?: string[]; links?: Record<string, Record<string, number>> } {
  let s = raw.trim();
  // The eval result is a JS string literal containing JSON; it may itself be
  // wrapped in quotes (e.g. '"{...}"'). Unwrap one layer of quoting if present.
  try {
    const first = JSON.parse(s);
    if (typeof first === 'string') {
      return JSON.parse(first);
    }
    if (first && typeof first === 'object') {
      return first;
    }
  } catch {
    // fall through to substring extraction
  }
  // Last resort: extract the first {...} block.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(s.slice(start, end + 1));
  }
  throw new Error(`Could not parse eval_obsidian graph result: ${raw.slice(0, 200)}`);
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
  const evalDisabled = config.disabledTools.has('eval_obsidian');
  if (!evalDisabled) {
    try {
      if (await isCliAvailable()) {
        return new ObsidianProvider(config, vaultName);
      }
    } catch {
      // isCliAvailable threw — fall through to filesystem.
    }
  }
  return new FilesystemProvider();
}
