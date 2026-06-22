/**
 * SQLite vector storage for embeddings
 * Stores embeddings as binary blobs for efficient retrieval
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { cosineSimilarity } from './ollama.js';

export interface StoredEmbedding {
  id: number;
  filePath: string;
  blockId: string | null;
  contentHash: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface SearchResult {
  filePath: string;
  blockId: string | null;
  similarity: number;
  metadata: Record<string, unknown>;
}

// Shared storage instances across the process — prevents duplicate DB connections
// between semantic.ts, watcher.ts, and crossvault.ts
const sharedInstances = new Map<string, EmbeddingStorage>();

/**
 * Get or create a shared EmbeddingStorage instance for a vault.
 * Ensures only one DB connection per vault path across the entire process.
 */
export function getSharedStorage(vaultPath: string): EmbeddingStorage {
  const dbPath = path.join(vaultPath, '.mcp-obsidian', 'embeddings.db');
  if (!sharedInstances.has(dbPath)) {
    sharedInstances.set(dbPath, new EmbeddingStorage(dbPath));
  }
  return sharedInstances.get(dbPath)!;
}

export class EmbeddingStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    // Enable WAL mode for better concurrent access and busy timeout
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    // Check if we need to migrate from old schema
    const tableExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
    ).get();

    if (tableExists) {
      // Migration: clean up duplicates from old schema bug
      // The old UNIQUE(file_path, block_id) didn't work with NULLs
      this.db.exec(`
        DELETE FROM embeddings WHERE id NOT IN (
          SELECT MIN(id) FROM embeddings
          GROUP BY file_path, COALESCE(block_id, '')
        );
      `);

      // Check if we need to add the new unique index
      const hasNewIndex = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_unique_file_block'"
      ).get();

      if (!hasNewIndex) {
        // Drop old constraint by recreating table (SQLite limitation)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS embeddings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            block_id TEXT DEFAULT '',
            content_hash TEXT NOT NULL,
            embedding BLOB NOT NULL,
            metadata TEXT,
            updated_at INTEGER NOT NULL
          );

          INSERT INTO embeddings_new (id, file_path, block_id, content_hash, embedding, metadata, updated_at)
          SELECT id, file_path, COALESCE(block_id, ''), content_hash, embedding, metadata, updated_at
          FROM embeddings;

          DROP TABLE embeddings;
          ALTER TABLE embeddings_new RENAME TO embeddings;

          CREATE UNIQUE INDEX idx_unique_file_block ON embeddings(file_path, block_id);
          CREATE INDEX IF NOT EXISTS idx_file_path ON embeddings(file_path);
          CREATE INDEX IF NOT EXISTS idx_content_hash ON embeddings(content_hash);
          CREATE INDEX IF NOT EXISTS idx_updated_at ON embeddings(updated_at);
        `);
        console.error('[mcp-obsidian] Migrated embeddings table to fix duplicate bug');
      }
    } else {
      // Fresh install - create with correct schema
      this.db.exec(`
        CREATE TABLE embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          block_id TEXT DEFAULT '',
          content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          metadata TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX idx_unique_file_block ON embeddings(file_path, block_id);
        CREATE INDEX idx_file_path ON embeddings(file_path);
        CREATE INDEX idx_content_hash ON embeddings(content_hash);
        CREATE INDEX idx_updated_at ON embeddings(updated_at);
      `);
    }

    // Create FTS5 table for keyword search (hybrid search)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
        file_path,
        block_id,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Store an embedding (and optionally content for FTS)
   */
  store(
    filePath: string,
    embedding: number[],
    contentHash: string,
    metadata: Record<string, unknown> = {},
    blockId: string | null = null,
    content?: string  // Optional content for FTS indexing
  ): void {
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
    // Use empty string instead of NULL to make UNIQUE constraint work
    const normalizedBlockId = blockId || '';

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (file_path, block_id, content_hash, embedding, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      filePath,
      normalizedBlockId,
      contentHash,
      embeddingBlob,
      JSON.stringify(metadata),
      Date.now()
    );

    // Also store in FTS if content provided
    if (content) {
      // Delete existing FTS entry first
      this.db.prepare(`
        DELETE FROM content_fts WHERE file_path = ? AND block_id = ?
      `).run(filePath, normalizedBlockId);

      this.db.prepare(`
        INSERT INTO content_fts (file_path, block_id, content)
        VALUES (?, ?, ?)
      `).run(filePath, normalizedBlockId, content);
    }
  }

  /**
   * Get embedding for a file (or any section of it)
   * When blockId is null, tries '' first (whole file), then returns the first section found.
   */
  get(filePath: string, blockId: string | null = null): StoredEmbedding | null {
    const normalizedBlockId = blockId || '';
    const stmt = this.db.prepare(`
      SELECT * FROM embeddings WHERE file_path = ? AND block_id = ?
    `);

    let row = stmt.get(filePath, normalizedBlockId) as {
      id: number;
      file_path: string;
      block_id: string;
      content_hash: string;
      embedding: Buffer;
      metadata: string;
      updated_at: number;
    } | undefined;

    // Fix for get_similar: if looking for whole-file embedding but file is chunked,
    // fall back to the first section's embedding
    if (!row && normalizedBlockId === '') {
      row = this.db.prepare(`
        SELECT * FROM embeddings WHERE file_path = ? ORDER BY id ASC LIMIT 1
      `).get(filePath) as typeof row;
    }

    if (!row) return null;

    return {
      id: row.id,
      filePath: row.file_path,
      blockId: row.block_id || null,  // Return null for empty string for API consistency
      contentHash: row.content_hash,
      embedding: Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)),
      metadata: JSON.parse(row.metadata || '{}'),
      updatedAt: row.updated_at
    };
  }

  /**
   * Check if embedding exists and is up to date
   */
  isUpToDate(filePath: string, contentHash: string, blockId: string | null = null): boolean {
    const normalizedBlockId = blockId || '';
    const stmt = this.db.prepare(`
      SELECT content_hash FROM embeddings
      WHERE file_path = ? AND block_id = ?
    `);

    const row = stmt.get(filePath, normalizedBlockId) as { content_hash: string } | undefined;
    return row?.content_hash === contentHash;
  }

  /**
   * Delete embeddings for a file
   */
  delete(filePath: string): void {
    this.db.prepare('DELETE FROM embeddings WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM content_fts WHERE file_path = ?').run(filePath);
  }

  /**
   * Delete stale embeddings — removes rows for files that no longer exist on disk.
   * Call after indexing to clean up renamed/deleted files.
   */
  deleteStale(vaultPath: string): number {
    const rows = this.db.prepare(
      'SELECT DISTINCT file_path FROM embeddings'
    ).all() as Array<{ file_path: string }>;

    let removed = 0;
    for (const row of rows) {
      const fullPath = path.join(vaultPath, row.file_path);
      if (!fs.existsSync(fullPath)) {
        this.delete(row.file_path);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Delete all embeddings
   */
  clear(): void {
    this.db.exec('DELETE FROM embeddings');
    this.db.exec('DELETE FROM content_fts');
  }

  /**
   * Get all embeddings (for similarity search)
   * Filters out empty embeddings that would cause dimension mismatch
   */
  getAll(): StoredEmbedding[] {
    // Only get embeddings with actual content (non-empty blobs)
    const stmt = this.db.prepare('SELECT * FROM embeddings WHERE LENGTH(embedding) > 0');
    const rows = stmt.all() as Array<{
      id: number;
      file_path: string;
      block_id: string;
      content_hash: string;
      embedding: Buffer;
      metadata: string;
      updated_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      filePath: row.file_path,
      blockId: row.block_id || null,  // Return null for empty string for API consistency
      contentHash: row.content_hash,
      embedding: Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)),
      metadata: JSON.parse(row.metadata || '{}'),
      updatedAt: row.updated_at
    }));
  }

  /**
   * Search for similar embeddings (semantic search)
   */
  search(queryEmbedding: number[], limit: number = 10, minSimilarity: number = 0): SearchResult[] {
    const allEmbeddings = this.getAll();

    const results: SearchResult[] = allEmbeddings
      .map(stored => ({
        filePath: stored.filePath,
        blockId: stored.blockId,
        similarity: cosineSimilarity(queryEmbedding, stored.embedding),
        metadata: stored.metadata
      }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return results;
  }

  /**
   * Fetch the full passage TEXT for a candidate by (file_path, block_id).
   *
   * Used by the reranker SEAM (issue #27): the fused top-K candidates are keyed
   * by `${filePath}:${blockId}`, and the reranker must score the REAL passage
   * text (the full chunk stored in content_fts), not the 200-char preview.
   * `blockId` is normalized to '' (whole-file) the same way `store` writes it.
   * Returns null when no FTS row exists (e.g. content was never passed to store).
   */
  getContent(filePath: string, blockId: string | null = null): string | null {
    const normalizedBlockId = blockId || '';
    const row = this.db.prepare(`
      SELECT content FROM content_fts WHERE file_path = ? AND block_id = ?
    `).get(filePath, normalizedBlockId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /**
   * Keyword search result
   */
  keywordSearch(query: string, limit: number = 10): Array<{
    filePath: string;
    blockId: string | null;
    score: number;
  }> {
    try {
      // FTS5 MATCH query - sanitize to prevent operator injection.
      // Strip quotes, then wrap each word in double quotes to treat as literals,
      // neutralizing FTS5 operators (AND, OR, NOT, NEAR) and column filters.
      const words = query
        .replace(/['"]/g, '')
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_\-]/g, ''))  // strip special chars
        .filter(w => w.length > 0 && w.length < 100);  // drop empty/absurd tokens
      if (words.length === 0) return [];
      // Each word quoted as literal — FTS5 operators like NEAR/AND/OR are neutralized
      const sanitizedQuery = words.map(w => `"${w}"`).join(' ');

      const rows = this.db.prepare(`
        SELECT file_path, block_id, bm25(content_fts) as score
        FROM content_fts
        WHERE content_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(sanitizedQuery, limit) as Array<{
        file_path: string;
        block_id: string;
        score: number;
      }>;

      return rows.map(row => ({
        filePath: row.file_path,
        blockId: row.block_id || null,
        score: Math.abs(row.score)  // BM25 returns negative scores, lower is better
      }));
    } catch {
      // FTS query syntax error - return empty
      return [];
    }
  }

  /**
   * Get statistics
   */
  getStats(): { totalEmbeddings: number; uniqueFiles: number; lastUpdated: number | null } {
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM embeddings');
    const filesStmt = this.db.prepare('SELECT COUNT(DISTINCT file_path) as count FROM embeddings');
    const lastUpdatedStmt = this.db.prepare('SELECT MAX(updated_at) as last FROM embeddings');

    const count = (countStmt.get() as { count: number }).count;
    const files = (filesStmt.get() as { count: number }).count;
    const lastUpdated = (lastUpdatedStmt.get() as { last: number | null }).last;

    return {
      totalEmbeddings: count,
      uniqueFiles: files,
      lastUpdated
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
