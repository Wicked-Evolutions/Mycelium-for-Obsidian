import * as fs from 'fs/promises';
import { accessSync, constants, statSync } from 'fs';
import { resolvePathInVault } from '../config.js';
import { parseMarkdownFile } from '../parsers/markdown.js';
import { type ParsedFile } from '../types/index.js';
import { type CompletenessReason, partialCompletenessMetadata } from '../result-metadata.js';

interface SemanticSource {
  parsed: ParsedFile;
  identity: string;
}

/** Request-local availability evidence, not an embedding/content freshness check. */
export class SemanticSources {
  private readonly available = new Map<string, SemanticSource>();
  private readonly unavailable = new Map<string, CompletenessReason>();

  constructor(private readonly vaultPath: string) {}

  get(filePath: string): SemanticSource | undefined {
    return this.available.get(filePath);
  }

  /** Final availability sweep: no awaited work between validation and output. */
  getCurrent(filePath: string): SemanticSource | undefined {
    const source = this.available.get(filePath);
    if (!source) return undefined;
    try {
      const absolutePath = resolvePathInVault(this.vaultPath, filePath);
      const stat = statSync(absolutePath, { bigint: true });
      if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== source.identity) {
        throw new Error('Semantic source identity is no longer available.');
      }
      accessSync(absolutePath, constants.R_OK);
      return source;
    } catch {
      this.available.delete(filePath);
      this.unavailable.set(filePath, 'file_unreadable');
      return undefined;
    }
  }

  async read(filePath: string): Promise<SemanticSource | null> {
    if (this.unavailable.has(filePath)) return null;
    try {
      // Reject host paths even though the general Markdown parser accepts an
      // absolute in-vault path. Indexed keys are vault-relative identifiers.
      const absolutePath = resolvePathInVault(this.vaultPath, filePath);
      const before = await fs.stat(absolutePath, { bigint: true });
      if (!before.isFile()) throw new Error('Semantic source is not a regular file.');
      const parsed = await parseMarkdownFile(filePath, this.vaultPath);
      // The parser verifies the opened handle and containment. Also reject a
      // deletion or replacement observed across the awaited read/parse.
      const after = await fs.stat(resolvePathInVault(this.vaultPath, filePath), { bigint: true });
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error('Semantic source changed during validation.');
      }
      const source = { parsed, identity: `${after.dev}:${after.ino}` };
      this.available.set(filePath, source);
      return source;
    } catch (error) {
      const reason: CompletenessReason = error instanceof Error && error.name === 'YAMLException'
        ? 'file_unparseable'
        : error instanceof Error && error.message.startsWith('File too large (')
          ? 'file_too_large'
          : 'file_unreadable';
      this.available.delete(filePath);
      this.unavailable.set(filePath, reason);
      return null;
    }
  }

  async refresh(filePaths: Iterable<string> = this.available.keys()): Promise<void> {
    for (const filePath of filePaths) await this.read(filePath);
  }

  metadata() {
    return partialCompletenessMetadata(
      this.available.size,
      this.unavailable.size,
      [...this.unavailable.values()]
    );
  }
}
