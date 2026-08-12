/**
 * File watcher for automatic index updates
 * Uses native fs.watch for efficient file system monitoring
 *
 * Uses shared storage instances (same DB connection as semantic.ts)
 * and section-level chunking consistent with index_vault.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VaultConfig } from '../types/index.js';
import { getSharedStorage } from './storage.js';
import {
  checkOllamaAvailability,
  getEmbeddingModelProfile,
  OllamaConfig,
} from './ollama.js';
import { deleteIndexedFile, indexMarkdownFile } from './indexer.js';
import { PinnedVaultRoot, pinVaultRootSync } from './vault-root.js';

interface WatcherConfig {
  vaults: VaultConfig[];
  ollama: OllamaConfig;
  debounceMs?: number;
  retryBaseMs?: number;
  maxRetries?: number;
}

interface PendingFile {
  vaultRoot: PinnedVaultRoot;
  filePath: string;
  timestamp: number;
  sequence: number;
  retryCount: number;
  availableAt: number;
}

function retryableIndexFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Ollama|fetch failed|ECONN|network|timed?\s*out|HTTP\s+(?:408|429|5\d\d))/i.test(message);
}

export class VaultWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pendingFiles: Map<string, PendingFile> = new Map();
  private processTimer: NodeJS.Timeout | null = null;
  private processTimerDueAt: number | null = null;
  private isProcessing = false;
  private stopped = false;
  private config: WatcherConfig;
  private debounceMs: number;
  private retryBaseMs: number;
  private maxRetries: number;
  private sequence = 0;

  constructor(config: WatcherConfig) {
    this.config = config;
    this.debounceMs = Math.max(0, config.debounceMs ?? 2000);
    this.retryBaseMs = Math.max(
      1,
      config.retryBaseMs ?? Math.max(this.debounceMs, 1000)
    );
    this.maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 3));
  }

  /**
   * Start watching all configured vaults
   */
  start(): void {
    this.stopped = false;
    for (const vault of this.config.vaults) {
      try {
        this.watchDirectory(pinVaultRootSync(vault.path));
      } catch (error) {
        console.error(`[mcp-obsidian] Failed to pin watcher vault ${vault.name}:`, error);
      }
    }
    console.error(`[mcp-obsidian] File watcher started for ${this.config.vaults.length} vault(s)`);
  }

  /**
   * Stop all watchers
   */
  stop(): void {
    this.stopped = true;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
      this.processTimerDueAt = null;
    }
    console.error('[mcp-obsidian] File watcher stopped');
  }

  /**
   * Watch a directory recursively
   */
  private watchDirectory(vaultRoot: PinnedVaultRoot): void {
    const dirPath = vaultRoot.path;
    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Only watch markdown files
        if (!filename.endsWith('.md')) return;

        // Skip hidden files/directories
        if (filename.includes('/.') || filename.startsWith('.')) return;

        const fullPath = path.join(dirPath, filename);
        const relativePath = path.relative(vaultRoot.path, fullPath);

        // Queue the file for processing
        this.queueFile(vaultRoot, relativePath);
      });

      this.watchers.push(watcher);

      watcher.on('error', (error) => {
        console.error(`[mcp-obsidian] Watcher error for ${dirPath}:`, error);
      });
    } catch (error) {
      console.error(`[mcp-obsidian] Failed to watch ${dirPath}:`, error);
    }
  }

  /**
   * Queue a file for indexing (with debounce)
   */
  private queueFile(vaultRoot: PinnedVaultRoot, filePath: string): void {
    const key = this.pendingKey(vaultRoot, filePath);
    const now = Date.now();

    this.pendingFiles.set(key, {
      vaultRoot,
      filePath,
      timestamp: now,
      sequence: ++this.sequence,
      retryCount: 0,
      availableAt: now + this.debounceMs,
    });
    this.reschedulePending();
  }

  private pendingKey(vaultRoot: PinnedVaultRoot, filePath: string): string {
    return [
      vaultRoot.path,
      vaultRoot.device,
      vaultRoot.inode,
      filePath,
    ].join('\u0000');
  }

  private reschedulePending(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
      this.processTimerDueAt = null;
    }
    if (this.stopped || this.pendingFiles.size === 0) return;

    const dueAt = Math.min(
      ...Array.from(this.pendingFiles.values(), file => file.availableAt)
    );
    this.processTimerDueAt = dueAt;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processTimerDueAt = null;
      void this.processPendingFiles();
    }, Math.max(0, dueAt - Date.now()));
  }

  private requeueFile(file: PendingFile, reason: string): boolean {
    if (this.stopped) return false;
    const key = this.pendingKey(file.vaultRoot, file.filePath);
    const newerEvent = this.pendingFiles.get(key);
    if (newerEvent && newerEvent.sequence > file.sequence) {
      return true;
    }

    const retryCount = file.retryCount + 1;
    if (retryCount > this.maxRetries) {
      console.error(
        `[mcp-obsidian] Auto-index retry exhausted for ${file.filePath}: ${reason}`
      );
      return false;
    }
    const delay = Math.min(
      this.retryBaseMs * (2 ** (retryCount - 1)),
      30_000
    );
    const now = Date.now();
    this.pendingFiles.set(key, {
      ...file,
      timestamp: now,
      retryCount,
      availableAt: now + delay,
    });
    this.reschedulePending();
    return true;
  }

  /**
   * Process all pending files
   * Uses section-level chunking consistent with index_vault,
   * and stores content for FTS indexing.
   */
  private async processPendingFiles(): Promise<void> {
    if (this.isProcessing || this.pendingFiles.size === 0) return;

    const now = Date.now();
    const files: PendingFile[] = [];
    for (const [key, file] of this.pendingFiles) {
      if (file.availableAt <= now) {
        files.push(file);
        this.pendingFiles.delete(key);
      }
    }
    if (files.length === 0) {
      this.reschedulePending();
      return;
    }

    this.isProcessing = true;
    try {
      let indexed = 0;
      let deleted = 0;
      let skipped = 0;
      const filesToIndex: Array<PendingFile & { storage: ReturnType<typeof getSharedStorage> }> = [];

      // Deletions do not require an embedding provider. Process them first so
      // stale semantic and FTS rows cannot survive an Ollama outage.
      for (const file of files) {
        try {
          const storage = getSharedStorage(file.vaultRoot);
          const removed = await deleteIndexedFile({
            vaultRoot: file.vaultRoot,
            filePath: file.filePath,
            storage,
          });
          if (removed) {
            deleted++;
          } else {
            filesToIndex.push({ ...file, storage });
          }
        } catch (error) {
          console.error(`[mcp-obsidian] Auto-index error for ${file.filePath}:`, error);
        }
      }

      if (filesToIndex.length === 0) {
        if (deleted > 0) {
          console.error(`[mcp-obsidian] Auto-indexed: 0 new/updated, ${deleted} deleted, 0 unchanged`);
        }
        return;
      }

      // Check Ollama availability
      const ollama = await checkOllamaAvailability(this.config.ollama);
      if (!ollama.available || !ollama.hasModel) {
        console.error('[mcp-obsidian] Auto-index skipped: Ollama not available');
        for (const file of filesToIndex) {
          this.requeueFile(file, 'Ollama is unavailable');
        }
        return;
      }
      let profile;
      try {
        profile = await getEmbeddingModelProfile(this.config.ollama, ollama.model);
      } catch (error) {
        console.error('[mcp-obsidian] Auto-index skipped: embedding model context is unavailable', error);
        for (const file of filesToIndex) {
          this.requeueFile(file, 'embedding model context is unavailable');
        }
        return;
      }
      const resolvedOllama = { ...this.config.ollama, model: profile.name };

      for (const file of filesToIndex) {
        try {
          const result = await indexMarkdownFile({
            vaultRoot: file.vaultRoot,
            filePath: file.filePath,
            storage: file.storage,
            ollama: resolvedOllama,
            profile,
            force: false,
            metadata: { autoIndexed: true },
          });
          if (result.status === 'indexed') {
            indexed++;
          } else {
            skipped++;
          }
        } catch (error) {
          console.error(`[mcp-obsidian] Auto-index error for ${file.filePath}:`, error);
          if (retryableIndexFailure(error)) {
            this.requeueFile(
              file,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      if (indexed > 0 || deleted > 0) {
        console.error(`[mcp-obsidian] Auto-indexed: ${indexed} new/updated, ${deleted} deleted, ${skipped} unchanged`);
      }
    } catch (error) {
      console.error('[mcp-obsidian] Auto-index batch failed:', error);
    } finally {
      this.isProcessing = false;
      if (!this.stopped && this.pendingFiles.size > 0) {
        this.reschedulePending();
      }
    }
  }
}

/**
 * Create and start a vault watcher
 */
export function createVaultWatcher(config: WatcherConfig): VaultWatcher {
  const watcher = new VaultWatcher(config);
  watcher.start();
  return watcher;
}
