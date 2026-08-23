/** Per-workspace RAG storage (SQLite + FTS5 + sqlite-vec) at `<userData>/rag/<workspaceId>/index.db`. Sync better-sqlite3 writes wrapped in transactions; bump SCHEMA_VERSION and append a step in `migrate()` to evolve the schema. */
import Database from 'better-sqlite3';
import { getLoadablePath as getSqliteVecPath } from 'sqlite-vec';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type { Database as DB } from 'better-sqlite3';
import { appDataDir } from '../appPaths.js';

/** A single AST-symbol chunk waiting to be embedded + stored. */
export interface ChunkRow {
  /** Stable id: content-addressable per location (hash of path|symbol|startLine). */
  id: string;
  /** Absolute path to the source file. */
  path: string;
  /** Symbol name (function/class/method) — empty for whole-file chunks. */
  symbol: string;
  /** Raw source text of the chunk. */
  content: string;
  /** sha256(content) — used by ingestion to skip unchanged chunks on re-ingest. */
  contentHash: string;
  startLine: number;
  endLine: number;
  /** Embedder that produced the stored vector (or will, once embedded). */
  embedderId: string;
  /** ms since epoch when the row was inserted. */
  createdAt: number;
  /** Knowledge source this chunk belongs to; null/undefined for workspace code chunks. */
  sourceId?: string | null;
}

/** What a vector search hit looks like — chunk row + cosine similarity. */
export interface VectorHit extends ChunkRow {
  /** Cosine similarity in [-1, 1]. Higher is better. Derived from
   *  sqlite-vec's L2 distance: for normalized vectors, similarity =
   *  1 − dist² / 2. */
  similarity: number;
}

/** What an FTS hit looks like — chunk row + bm25 rank (lower is better). */
export interface FtsHit extends ChunkRow {
  rank: number;
}

const SCHEMA_VERSION = 2;
const EMBED_DIM = 384;

/** Open (or create) the per-workspace RAG index. Loads sqlite-vec,
 *  runs migrations idempotently, prepares statements on the instance
 *  for fast repeated calls. */
export function openRagStore(workspaceId: string): RagStore {
  return openRagStoreAt(path.join(appDataDir(), 'rag', workspaceId, 'index.db'));
}

/** Open (or create) a RAG index at an explicit path (e.g. the global
 *  knowledge-sources index). Same setup as openRagStore. */
export function openRagStoreAt(dbPath: string): RagStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // sqlite-vec loads as a SQLite extension; the native binary must be unpacked from app.asar (asarUnpack), so rewrite the path to app.asar.unpacked before dlopen.
  try {
    const vecPath = getSqliteVecPath();
    const realPath = vecPath.replace('app.asar', 'app.asar.unpacked');
    db.loadExtension(realPath);
  } catch (e) {
    db.close();
    throw new Error(
      `Failed to load sqlite-vec extension for ${dbPath}: ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }

  migrate(db);
  return new RagStore(db);
}

/** Internal: idempotent schema migration. Reads `meta.schemaVersion`;
 *  runs each step whose version > stored, then writes the new version.
 *  All steps for a given target version (including the version write)
 *  run in one transaction, so a crash mid-migration rolls back cleanly
 *  instead of leaving a half-applied schema that can't be retried. */
function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as
    | { value?: string }
    | undefined;
  const parsed = row?.value ? Number(row.value) : 0;
  // Corrupt/non-numeric meta values must not silently skip every migration.
  const current = Number.isFinite(parsed) ? parsed : 0;

  // Only bump up — an older binary must not downgrade a newer db
  // (re-running future migrations against newer schemas would corrupt it).
  if (current >= SCHEMA_VERSION) return;

  db.transaction(() => {
    if (current < 1) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        content      TEXT NOT NULL,
        contentHash  TEXT NOT NULL,
        startLine    INTEGER NOT NULL,
        endLine      INTEGER NOT NULL,
        embedderId   TEXT NOT NULL,
        createdAt    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS chunks_by_hash ON chunks(contentHash);

      -- FTS5 index over the chunk's text fields. chunkId is UNINDEXED
      -- (stored, not searchable) and links FTS rows back to chunks.id.
      -- FTS manages its own integer rowid separately; we don't rely on
      -- it matching anything. bm25() ranking by default.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunkId UNINDEXED,
        content,
        symbol,
        path,
        tokenize = 'porter unicode61'
      );

      -- sqlite-vec virtual table. 384-dim matches the all-MiniLM-L6-v2
      -- family (both local-code-512 and cloud-base). The rowid IS the
      -- vector id — we use chunks.rowid for it so joins are trivial.
      -- +chunkId is an aux column for filter-by-id operations.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${EMBED_DIM}],
        +chunkId  TEXT
      );
      `);
    }

    if (current < 2) {
      // Guard the ALTER so a db left half-migrated by a pre-transactional
      // crash (column present, version stale) reopens instead of throwing.
      const hasSourceId = db
        .prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'sourceId'")
        .get();
      if (!hasSourceId) {
        db.exec('ALTER TABLE chunks ADD COLUMN sourceId TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS chunks_by_source ON chunks(sourceId)');
    }

    // Future migrations: append `if (current < 3) { ... }` blocks here.
    // Never EDIT a past migration — only add new ones.

    db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schemaVersion', String(SCHEMA_VERSION));
  })();
}

/** Handle to an open RAG index. Methods are sync; close() releases the
 *  underlying better-sqlite3 connection. */
export class RagStore {
  constructor(private readonly db: DB) {}

  /** Number of chunks in the index. */
  chunkCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return r.n;
  }

  /** Read a meta key. Returns undefined for missing keys. */
  getMeta(key: string): string | undefined {
    const r = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return r?.value;
  }

  /** Write a meta key/value. Upsert. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** Return chunks for a given path. Used by ingestion to compute the
   *  diff (what's still there, what's stale) before re-embedding. */
  byPath(absPath: string): ChunkRow[] {
    return this.db
      .prepare('SELECT * FROM chunks WHERE path = ?')
      .all(absPath) as ChunkRow[];
  }

  /** Look up a single chunk by content hash — used by ingestion's
   *  skip-unchanged fast path. */
  byContentHash(hash: string): ChunkRow | undefined {
    return this.db
      .prepare('SELECT * FROM chunks WHERE contentHash = ? LIMIT 1')
      .get(hash) as ChunkRow | undefined;
  }

  /** Upsert chunk + FTS rows in one transaction; returns rowids so the caller can pair them with async vector writes. */
  upsertChunks(rows: ChunkRow[]): { id: string; rowid: number }[] {
    if (rows.length === 0) return [];
    const out: { id: string; rowid: number }[] = [];
    const tx = this.db.transaction((rs: ChunkRow[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO chunks(id, path, symbol, content, contentHash, startLine, endLine, embedderId, createdAt, sourceId)
        VALUES (@id, @path, @symbol, @content, @contentHash, @startLine, @endLine, @embedderId, @createdAt, @sourceId)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          symbol = excluded.symbol,
          content = excluded.content,
          contentHash = excluded.contentHash,
          startLine = excluded.startLine,
          endLine = excluded.endLine,
          embedderId = excluded.embedderId,
          sourceId = excluded.sourceId
        RETURNING rowid
      `);
      // FTS5 doesn't support UPSERT — delete + insert within the same
      // transaction. The chunkId UNINDEXED column is the join key.
      const ftsDelete = this.db.prepare('DELETE FROM chunks_fts WHERE chunkId = ?');
      const ftsInsert = this.db.prepare(`
        INSERT INTO chunks_fts(chunkId, content, symbol, path)
        VALUES (?, ?, ?, ?)
      `);
      for (const r of rs) {
        // RETURNING inside ON CONFLICT upsert works in sqlite ≥ 3.35;
        // better-sqlite3 ships a recent sqlite.
        const rowidRow = stmt.get({ ...r, sourceId: r.sourceId ?? null }) as {
          rowid: number;
        };
        ftsDelete.run(r.id);
        ftsInsert.run(r.id, r.content, r.symbol, r.path);
        out.push({ id: r.id, rowid: rowidRow.rowid });
      }
    });
    tx(rows);
    return out;
  }

  /** Upsert (chunkId, rowid, embedding) triples into the vector table in one transaction; rowid must match chunks.rowid. vec0 has no UPSERT (DELETE+INSERT) and requires BigInt rowids. */
  upsertVectors(items: { rowid: number; chunkId: string; embedding: number[] }[]): void {
    if (items.length === 0) return;
    const tx = this.db.transaction((xs: typeof items) => {
      const del = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
      const ins = this.db.prepare(`
        INSERT INTO chunks_vec(rowid, embedding, chunkId)
        VALUES (?, ?, ?)
      `);
      for (const x of xs) {
        del.run(BigInt(x.rowid));
        // sqlite-vec accepts Float32Array (compact) or JSON. Use Float32.
        ins.run(BigInt(x.rowid), Float32Array.from(x.embedding), x.chunkId);
      }
    });
    tx(items);
  }

  /** Delete chunk + FTS + vector rows by chunk id; vec0 has no FK cascade, so all three deletes are explicit and vec0 deletes by the +chunkId aux column. */
  deleteChunks(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const tx = this.db.transaction((ids: string[]) => {
      const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE chunkId = ?');
      const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE chunkId = ?');
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
      for (const id of ids) {
        delVec.run(id);
        delFts.run(id);
        delChunk.run(id);
      }
    });
    tx(chunkIds);
  }

  /** Top-k vector search. Returns chunks sorted by similarity (desc).
   *  Conversion: sqlite-vec returns L2 distance; for L2-normalized
   *  vectors, similarity = 1 − dist² / 2. */
  queryByVector(vec: number[], k: number): VectorHit[] {
    const distRows = this.db
      .prepare(`
        SELECT v.chunkId AS id, v.distance AS distance
        FROM chunks_vec v
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `)
      .all(Float32Array.from(vec), k) as { id: string; distance: number }[];
    if (distRows.length === 0) return [];
    const ids = distRows.map((r) => r.id);
    const chunks = this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as ChunkRow[];
    const byId = new Map(chunks.map((c) => [c.id, c]));
    return distRows
      .map((r) => {
        const c = byId.get(r.id);
        if (!c) return null;
        const similarity = 1 - (r.distance * r.distance) / 2;
        return { ...c, similarity };
      })
      .filter((x): x is VectorHit => x !== null);
  }

  /** Top-k FTS5 search by bm25 rank (lower = better). Input is sanitized: each token is double-quoted so FTS5 treats special chars (?, *, OR, AND, parentheses) as literal text. */
  queryByFts(text: string, k: number): FtsHit[] {
    const safe = sanitizeFtsQuery(text);
    return this.db
      .prepare(`
        SELECT c.*, rank
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.chunkId
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(safe, k) as FtsHit[];
  }

  /** Drop every chunk + FTS + vec row. Used by the (still-disabled)
   *  "Clear" button on the panel. Fast — three DELETE FROM statements
   *  in a transaction. */
  dropAll(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM chunks_vec');
      this.db.exec('DELETE FROM chunks_fts');
      this.db.exec('DELETE FROM chunks');
    })();
  }

  close(): void {
    this.db.close();
  }
}

/** Sanitize a natural-language query for FTS5 MATCH: split into tokens, wrap each in double quotes so reserved chars/words are treated as literal phrase tokens. */
function sanitizeFtsQuery(text: string): string {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
