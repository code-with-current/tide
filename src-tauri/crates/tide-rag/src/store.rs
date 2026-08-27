//! Per-workspace RAG storage — port of `app/core/rag/store.ts` @ 91ec558.
//! SQLite + FTS5 + sqlite-vec at `<data>/rag/<workspaceId>/index.db`
//! (schema v2). Table/DDL shapes are byte-compatible with the TS store so
//! existing indexes stay valid: `chunks` (+ `sourceId`), `chunks_fts`
//! (porter unicode61), `chunks_vec` (`vec0`, 384-dim, rowid = chunks.rowid,
//! `+chunkId` aux), `meta`.
//!
//! sqlite-vec registers through `sqlite3_auto_extension` (the crate's
//! documented static hookup) so every connection — including the sessions
//! db — transparently carries `vec0`; the C library links once per process.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i64 = 2;
const EMBED_DIM: usize = 384;

/// A single AST-symbol chunk as stored (TS ChunkRow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRow {
    /// Stable id: sha256(path|symbol|startLine).
    pub id: String,
    pub path: String,
    pub symbol: String,
    pub content: String,
    /// sha256(content).
    pub content_hash: String,
    pub start_line: i64,
    pub end_line: i64,
    pub embedder_id: String,
    pub created_at: i64,
    /// Knowledge source this chunk belongs to; null for workspace code.
    #[serde(default)]
    pub source_id: Option<String>,
}

/// Vector hit — chunk row + cosine similarity (sqlite-vec returns L2
/// distance; for normalized vectors, similarity = 1 − dist²/2).
#[derive(Debug, Clone)]
pub struct VectorHit {
    pub row: ChunkRow,
    pub similarity: f64,
}

/// FTS hit — chunk row + bm25 rank (lower is better).
#[derive(Debug, Clone)]
pub struct FtsHit {
    pub row: ChunkRow,
    pub rank: f64,
}

/// Register the sqlite-vec extension for every connection opened from now
/// on. Idempotent and process-wide (safe to call per open).
fn register_sqlite_vec() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        type Sqlite3Init = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut i8,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> i32;
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            unsafe extern "C" fn(),
            Sqlite3Init,
        >(
            sqlite_vec::sqlite3_vec_init as unsafe extern "C" fn(),
        )));
    });
}

fn row_from_db(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkRow> {
    Ok(ChunkRow {
        id: row.get("id")?,
        path: row.get("path")?,
        symbol: row.get("symbol")?,
        content: row.get("content")?,
        content_hash: row.get("contentHash")?,
        start_line: row.get("startLine")?,
        end_line: row.get("endLine")?,
        embedder_id: row.get("embedderId")?,
        created_at: row.get("createdAt")?,
        source_id: row.get("sourceId")?,
    })
}

const CHUNK_COLUMNS: &str =
    "id, path, symbol, content, contentHash, startLine, endLine, embedderId, createdAt, sourceId";

/// Handle to an open RAG index. Methods are sync; `drop` closes the
/// connection.
pub struct RagStore {
    conn: Connection,
}

impl RagStore {
    /// Open (or create) the per-workspace index at
    /// `<data>/rag/<workspace_id>/index.db`.
    pub fn open(data_dir: &Path, workspace_id: &str) -> rusqlite::Result<Self> {
        Self::open_at(&rag_db_path(data_dir, workspace_id))
    }

    /// Open (or create) a RAG index at an explicit path (e.g. the global
    /// knowledge-sources index at `<data>/knowledge/index.db`).
    pub fn open_at(db_path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_e| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }
        register_sqlite_vec();
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Fail fast when the vec0 module did not register — the TS store
        // threw from loadExtension the same way.
        conn.query_row("SELECT vec_version()", [], |_| Ok(()))?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Idempotent schema migration — same steps/versions as the TS
    /// `migrate()`, each target version in one transaction.
    fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS meta (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )",
            [],
        )?;
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schemaVersion'",
                [],
                |r| r.get(0),
            )
            .ok();
        let parsed = stored.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        // Corrupt/non-numeric values must not silently skip migrations.
        let current = parsed;
        if current >= SCHEMA_VERSION {
            return Ok(());
        }

        let tx = self.conn.unchecked_transaction()?;
        if current < 1 {
            let ddl = format!(
                "CREATE TABLE IF NOT EXISTS chunks (
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

                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                  chunkId UNINDEXED,
                  content,
                  symbol,
                  path,
                  tokenize = 'porter unicode61'
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                  embedding float[{EMBED_DIM}],
                  +chunkId  TEXT
                );",
            );
            tx.execute_batch(&ddl)?;
        }
        if current < 2 {
            // Guard the ALTER so a db left half-migrated by a crash reopens.
            let has_source_id: bool = tx
                .prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'sourceId'")?
                .exists([])?;
            if !has_source_id {
                tx.execute_batch("ALTER TABLE chunks ADD COLUMN sourceId TEXT;")?;
            }
            tx.execute_batch("CREATE INDEX IF NOT EXISTS chunks_by_source ON chunks(sourceId);")?;
        }
        tx.prepare(
            "INSERT INTO meta(key, value) VALUES ('schemaVersion', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )?
        .execute([SCHEMA_VERSION.to_string()])?;
        tx.commit()
    }

    /// Raw SQL escape hatch for sibling stores (knowledge sources registry)
    /// building their own tables on the same db file.
    pub fn run_raw(&self, sql: &str) -> rusqlite::Result<()> {
        self.conn.execute_batch(sql)
    }

    /// Friend-module seam: sibling stores (the knowledge sources registry)
    /// prepare their typed statements on the same connection.
    pub(crate) fn with_connection<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&self.conn)
    }

    pub fn chunk_count(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
    }

    pub fn get_meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .map(Some)
            .or_else(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(e)
                }
            })
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    pub fn by_path(&self, abs_path: &str) -> rusqlite::Result<Vec<ChunkRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHUNK_COLUMNS} FROM chunks WHERE path = ?1"
        ))?;
        let rows = stmt
            .query_map([abs_path], row_from_db)?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn by_content_hash(&self, hash: &str) -> rusqlite::Result<Option<ChunkRow>> {
        self.conn
            .query_row(
                &format!("SELECT {CHUNK_COLUMNS} FROM chunks WHERE contentHash = ?1 LIMIT 1"),
                [hash],
                row_from_db,
            )
            .map(Some)
            .or_else(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(e)
                }
            })
    }

    /// Upsert chunk + FTS rows in one transaction; returns rowids so the
    /// caller can pair them with the async vector writes.
    pub fn upsert_chunks(&self, rows: &[ChunkRow]) -> rusqlite::Result<Vec<(String, i64)>> {
        if rows.is_empty() {
            return Ok(vec![]);
        }
        let mut out = Vec::with_capacity(rows.len());
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chunks(id, path, symbol, content, contentHash, startLine, endLine, embedderId, createdAt, sourceId)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   path = excluded.path,
                   symbol = excluded.symbol,
                   content = excluded.content,
                   contentHash = excluded.contentHash,
                   startLine = excluded.startLine,
                   endLine = excluded.endLine,
                   embedderId = excluded.embedderId,
                   sourceId = excluded.sourceId
                 RETURNING rowid",
            )?;
            // FTS5 has no UPSERT — delete + insert in the same transaction.
            let mut fts_delete = tx.prepare("DELETE FROM chunks_fts WHERE chunkId = ?1")?;
            let mut fts_insert = tx.prepare(
                "INSERT INTO chunks_fts(chunkId, content, symbol, path) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for r in rows {
                let rowid: i64 = stmt.query_row(
                    params![
                        r.id,
                        r.path,
                        r.symbol,
                        r.content,
                        r.content_hash,
                        r.start_line,
                        r.end_line,
                        r.embedder_id,
                        r.created_at,
                        r.source_id,
                    ],
                    |row| row.get(0),
                )?;
                fts_delete.execute([&r.id])?;
                fts_insert.execute(params![r.id, r.content, r.symbol, r.path])?;
                out.push((r.id.clone(), rowid));
            }
        }
        tx.commit()?;
        Ok(out)
    }

    /// Upsert (rowid, chunkId, embedding) triples into the vector table in
    /// one transaction; rowid must match chunks.rowid. vec0 has no UPSERT
    /// (DELETE+INSERT) and takes the embedding as a raw little-endian f32
    /// blob (the Float32Array binding the TS driver used).
    pub fn upsert_vectors(&self, items: &[(i64, String, Vec<f32>)]) -> rusqlite::Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut del = tx.prepare("DELETE FROM chunks_vec WHERE rowid = ?1")?;
            let mut ins = tx.prepare(
                "INSERT INTO chunks_vec(rowid, embedding, chunkId) VALUES (?1, vec_f32(?2), ?3)",
            )?;
            for (rowid, chunk_id, embedding) in items {
                let bytes: &[u8] = bytemuck::cast_slice(embedding);
                del.execute([rowid])?;
                ins.execute(params![rowid, bytes, chunk_id])?;
            }
        }
        tx.commit()
    }

    /// Chunk ids belonging to a knowledge source (cascade-purge feed).
    pub fn chunks_by_source(&self, source_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM chunks WHERE sourceId = ?1")?;
        let rows = stmt
            .query_map([source_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Delete chunk + FTS + vector rows by chunk id (all three explicit —
    /// vec0 has no FK cascade and deletes by the +chunkId aux column).
    pub fn delete_chunks(&self, chunk_ids: &[String]) -> rusqlite::Result<()> {
        if chunk_ids.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        self.delete_chunk_rows_tx(&tx, chunk_ids)?;
        tx.commit()
    }

    /// The same deletes WITHOUT opening a transaction — for callers
    /// composing them into a larger transaction on this connection.
    pub fn delete_chunk_rows(&self, chunk_ids: &[String]) -> rusqlite::Result<()> {
        if chunk_ids.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        self.delete_chunk_rows_tx(&tx, chunk_ids)?;
        tx.commit()
    }

    fn delete_chunk_rows_tx(
        &self,
        tx: &rusqlite::Transaction<'_>,
        chunk_ids: &[String],
    ) -> rusqlite::Result<()> {
        let mut del_fts = tx.prepare("DELETE FROM chunks_fts WHERE chunkId = ?1")?;
        let mut del_vec = tx.prepare("DELETE FROM chunks_vec WHERE chunkId = ?1")?;
        let mut del_chunk = tx.prepare("DELETE FROM chunks WHERE id = ?1")?;
        for id in chunk_ids {
            del_vec.execute([id])?;
            del_fts.execute([id])?;
            del_chunk.execute([id])?;
        }
        Ok(())
    }

    /// Top-k vector search. sqlite-vec returns L2 distance; for
    /// L2-normalized vectors similarity = 1 − dist²/2.
    pub fn query_by_vector(&self, vec: &[f32], k: usize) -> rusqlite::Result<Vec<VectorHit>> {
        let bytes: &[u8] = bytemuck::cast_slice(vec);
        let mut stmt = self.conn.prepare(
            "SELECT v.chunkId AS id, v.distance AS distance
             FROM chunks_vec v
             WHERE v.embedding MATCH ?1
             ORDER BY v.distance
             LIMIT ?2",
        )?;
        let dist_rows: Vec<(String, f64)> = stmt
            .query_map(params![bytes, k as i64], |r| {
                Ok((r.get::<_, String>("id")?, r.get::<_, f64>("distance")?))
            })?
            .collect::<Result<_, _>>()?;
        if dist_rows.is_empty() {
            return Ok(vec![]);
        }
        let chunks =
            self.chunks_by_ids(&dist_rows.iter().map(|r| r.0.clone()).collect::<Vec<_>>())?;
        Ok(dist_rows
            .into_iter()
            .filter_map(|(id, distance)| {
                chunks.iter().find(|c| c.id == id).map(|row| VectorHit {
                    row: row.clone(),
                    similarity: 1.0 - (distance * distance) / 2.0,
                })
            })
            .collect())
    }

    fn chunks_by_ids(&self, ids: &[String]) -> rusqlite::Result<Vec<ChunkRow>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT {CHUNK_COLUMNS} FROM chunks WHERE id IN ({placeholders})");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids), row_from_db)?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Top-k FTS5 search by bm25 rank (lower = better). Input sanitized:
    /// each token double-quoted so special chars are literal text.
    pub fn query_by_fts(&self, text: &str, k: usize) -> rusqlite::Result<Vec<FtsHit>> {
        let safe = sanitize_fts_query(text);
        let mut stmt = self.conn.prepare("SELECT c.id, c.path, c.symbol, c.content, c.contentHash, c.startLine, c.endLine, c.embedderId, c.createdAt, c.sourceId, rank
             FROM chunks_fts f
             JOIN chunks c ON c.id = f.chunkId
             WHERE chunks_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2")?;
        let rows = stmt
            .query_map(params![safe, k as i64], |row| {
                Ok(FtsHit {
                    row: ChunkRow {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        symbol: row.get(2)?,
                        content: row.get(3)?,
                        content_hash: row.get(4)?,
                        start_line: row.get(5)?,
                        end_line: row.get(6)?,
                        embedder_id: row.get(7)?,
                        created_at: row.get(8)?,
                        source_id: row.get(9)?,
                    },
                    rank: row.get(10)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Drop every chunk + FTS + vec row (the panel's Clear button).
    pub fn drop_all(&self) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM chunks_vec; DELETE FROM chunks_fts; DELETE FROM chunks;")?;
        tx.commit()
    }
}

/// `<data>/rag/<workspaceId>/index.db`.
pub fn rag_db_path(data_dir: &Path, workspace_id: &str) -> PathBuf {
    data_dir.join("rag").join(workspace_id).join("index.db")
}

/// Sanitize a natural-language query for FTS5 MATCH: split into tokens,
/// wrap each in double quotes so reserved chars/words are literal phrase
/// tokens (TS sanitizeFtsQuery).
pub(crate) fn sanitize_fts_query(text: &str) -> String {
    let tokens: Vec<&str> = text.split_whitespace().filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return "\"\"".to_string();
    }
    tokens
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A deterministic embedder for tests — hash-seeded pseudo-vectors with a
/// stable cosine structure (same text → same vector).
#[cfg(test)]
pub(crate) struct FakeEmbedder {
    pub dim: usize,
}

#[cfg(test)]
impl crate::embedder::Embedder for FakeEmbedder {
    fn id(&self) -> &str {
        "local-code-512"
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn max_tokens(&self) -> usize {
        512
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|t| {
                // Seed from the text, derive a unit vector of `dim`.
                let seed = t.bytes().map(|b| b as u64).sum::<u64>().max(1);
                let mut v = Vec::with_capacity(self.dim);
                let mut state = seed;
                for _ in 0..self.dim {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    v.push(((state >> 33) % 1000) as f32 / 1000.0 - 0.5);
                }
                let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 0.0 {
                    v.iter().map(|x| x / norm).collect()
                } else {
                    v
                }
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedder::Embedder;
    use crate::unix_ms_now;

    fn store() -> (tempfile::TempDir, RagStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = RagStore::open_at(&dir.path().join("index.db")).unwrap();
        (dir, s)
    }

    fn row(id: &str, content: &str) -> ChunkRow {
        ChunkRow {
            id: id.into(),
            path: "/repo/src/a.ts".into(),
            symbol: "login".into(),
            content: content.into(),
            content_hash: crate::sha256_hex(content),
            start_line: 1,
            end_line: 4,
            embedder_id: "local-code-512".into(),
            created_at: unix_ms_now(),
            source_id: None,
        }
    }

    #[test]
    fn opens_with_schema_version_two_and_vec0() {
        let (_dir, s) = store();
        assert_eq!(s.get_meta("schemaVersion").unwrap().as_deref(), Some("2"));
        let version: String = s
            .conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .unwrap();
        assert!(version.starts_with('v'), "vec_version was {version}");
        // sourceId column exists (v2).
        let count: i64 = s
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name = 'sourceId'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn upsert_and_query_round_trip() {
        let (_dir, s) = store();
        let embedder = FakeEmbedder { dim: EMBED_DIM };
        let rows = vec![
            row("c1", "authenticate the user session"),
            row("c2", "database connection pool"),
        ];
        let vectors = embedder
            .embed(&rows.iter().map(|r| r.content.clone()).collect::<Vec<_>>())
            .unwrap();
        let rowids = s.upsert_chunks(&rows).unwrap();
        s.upsert_vectors(
            &rowids
                .into_iter()
                .zip(vectors)
                .map(|((id, rowid), embedding)| (rowid, id, embedding))
                .collect::<Vec<_>>(),
        )
        .unwrap();

        assert_eq!(s.chunk_count().unwrap(), 2);

        // Vector search returns the chunk with a similarity in [-1, 1].
        let q = embedder
            .embed(&["authenticate the user session".to_owned()])
            .unwrap();
        let hits = s.query_by_vector(&q[0], 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].row.id, "c1");
        assert!(
            hits[0].similarity > 0.99,
            "self-similarity was {}",
            hits[0].similarity
        );
        assert!(hits[0].similarity <= 1.0);

        // FTS search by keyword with bm25 rank.
        let fts = s.query_by_fts("authenticate session", 5).unwrap();
        assert_eq!(fts.len(), 1);
        assert_eq!(fts[0].row.id, "c1");

        // by_path / by_content_hash readers.
        assert_eq!(s.by_path("/repo/src/a.ts").unwrap().len(), 2);
        assert_eq!(
            s.by_content_hash(&crate::sha256_hex("database connection pool"))
                .unwrap()
                .map(|r| r.id),
            Some("c2".into())
        );
    }

    #[test]
    fn upsert_replaces_on_conflict() {
        let (_dir, s) = store();
        s.upsert_chunks(&[row("c1", "first body")]).unwrap();
        s.upsert_chunks(&[row("c1", "second body")]).unwrap();
        assert_eq!(s.chunk_count().unwrap(), 1);
        let fts = s.query_by_fts("second body", 5).unwrap();
        assert_eq!(fts.len(), 1);
        assert!(fts[0].row.content.contains("second"));
        // The stale FTS row is gone.
        assert!(s.query_by_fts("first", 5).unwrap().is_empty());
    }

    #[test]
    fn delete_chunks_purges_all_three_tables() {
        let (_dir, s) = store();
        let embedder = FakeEmbedder { dim: EMBED_DIM };
        let rows = vec![row("c1", "one"), row("c2", "two")];
        let vectors = embedder
            .embed(&["one".to_owned(), "two".to_owned()])
            .unwrap();
        let rowids = s.upsert_chunks(&rows).unwrap();
        s.upsert_vectors(
            &rowids
                .into_iter()
                .zip(vectors)
                .map(|((id, rowid), embedding)| (rowid, id, embedding))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        s.delete_chunks(&["c1".to_string()]).unwrap();
        assert_eq!(s.chunk_count().unwrap(), 1);
        assert!(s.query_by_fts("one", 5).unwrap().is_empty());
        let q = embedder.embed(&["one".to_owned()]).unwrap();
        // KNN returns nearest matches — with only c2's vector left, any
        // query can still return it; the deleted c1 must be gone.
        for hit in s.query_by_vector(&q[0], 5).unwrap() {
            assert_ne!(hit.row.id, "c1");
        }
    }

    #[test]
    fn fts_query_sanitizes_special_characters() {
        assert_eq!(
            sanitize_fts_query("what? OR (x)"),
            "\"what?\" \"OR\" \"(x)\""
        );
        assert_eq!(sanitize_fts_query("say \"hi\""), "\"say\" \"\"\"hi\"\"\"");
        assert_eq!(sanitize_fts_query("   "), "\"\"");
    }

    #[test]
    fn meta_round_trips_and_upserts() {
        let (_dir, s) = store();
        assert_eq!(s.get_meta("lastIngestedAt").unwrap(), None);
        s.set_meta("lastIngestedAt", "123").unwrap();
        s.set_meta("lastIngestedAt", "456").unwrap();
        assert_eq!(
            s.get_meta("lastIngestedAt").unwrap().as_deref(),
            Some("456")
        );
    }

    #[test]
    fn knowledge_source_chunks_filter_by_source() {
        let (_dir, s) = store();
        let mut r1 = row("k1", "react hooks docs");
        r1.source_id = Some("src-1".into());
        let mut r2 = row("k2", "react state docs");
        r2.source_id = Some("src-2".into());
        let embedder = FakeEmbedder { dim: EMBED_DIM };
        let vectors = embedder
            .embed(&["react hooks docs".to_owned(), "react state docs".to_owned()])
            .unwrap();
        let rowids = s.upsert_chunks(&[r1, r2]).unwrap();
        s.upsert_vectors(
            &rowids
                .into_iter()
                .zip(vectors)
                .map(|((id, rowid), embedding)| (rowid, id, embedding))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(s.chunks_by_source("src-1").unwrap(), vec!["k1".to_string()]);
        s.delete_chunks(&s.chunks_by_source("src-1").unwrap())
            .unwrap();
        assert_eq!(s.chunk_count().unwrap(), 1);
    }
}
