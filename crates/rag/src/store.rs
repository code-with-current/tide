//! Per-workspace RAG storage — port of `app/core/rag/store.ts`.
//! SQLite + FTS5 + sqlite-vec at `<data>/rag/<workspaceId>/index.db`
//! (schema v3). Table/DDL shapes are byte-compatible with the TS store so
//! existing indexes stay valid: `chunks` (+ `sourceId`), `chunks_fts`
//! (porter unicode61), `chunks_vec` (`vec0`, rowid = chunks.rowid,
//! `+chunkId` aux), `meta`. Since v3 every index carries an
//! `embeddingPlan` meta record — {embedderId, dims, chunking} — written
//! BEFORE the vec0 DDL (vec0 dimensions are fixed at CREATE), asserted on
//! every vector write and query so a model switch can never mix vector
//! spaces or silently return empty results.
//!
//! sqlite-vec registers through `sqlite3_auto_extension` (the crate's
//! documented static hookup) so every connection — including the sessions
//! db — transparently carries `vec0`; the C library links once per process.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i64 = 3;
const PLAN_META_KEY: &str = "embeddingPlan";

/// The embedding plan an index is locked to. Written at creation (before
/// the vec0 DDL — dimensions are fixed at CREATE time) and backfilled for
/// pre-v3 indexes. Every embed path asserts against it; a mismatch is an
/// explicit "rebuild required", never a silent empty or mixed-space query.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingPlan {
    /// Catalog/cloud/custom id that built (or will build) this index.
    pub embedder_id: String,
    /// Vector dimensionality of the vec0 table.
    pub dims: usize,
    /// Chunking the index was built with; `None` = chunker defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_overlap: Option<u64>,
    pub created_at: i64,
}

impl EmbeddingPlan {
    /// The plan every pre-v3 index effectively lived under: both embedders
    /// that exist today (`local-code-512`, `cloud-base`) are 384-dim and
    /// chunking was not configurable.
    pub fn legacy(now_ms: i64) -> Self {
        Self {
            embedder_id: "local-code-512".into(),
            dims: 384,
            chunk_size: None,
            chunk_overlap: None,
            created_at: now_ms,
        }
    }
}

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
        // `c_char` rather than `i8`: on aarch64 Linux (and anywhere C's char
        // is unsigned) the signed alias fails the fn-pointer match.
        type Sqlite3Init = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::os::raw::c_char,
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
    plan: EmbeddingPlan,
}

impl RagStore {
    /// Open (or create) the per-workspace index at
    /// `<data>/rag/<workspace_id>/index.db` under the legacy plan.
    pub fn open(data_dir: &Path, workspace_id: &str) -> rusqlite::Result<Self> {
        Self::open_at(&rag_db_path(data_dir, workspace_id))
    }

    /// Open (or create) the per-workspace index under an explicit plan —
    /// the ingest entry point once embedders are configurable.
    pub fn open_with_plan(
        data_dir: &Path,
        workspace_id: &str,
        plan: &EmbeddingPlan,
    ) -> rusqlite::Result<Self> {
        Self::open_at_with_plan(&rag_db_path(data_dir, workspace_id), plan)
    }

    /// Open (or create) a RAG index at an explicit path (e.g. the global
    /// knowledge-sources index at `<data>/knowledge/index.db`) under the
    /// legacy plan. An existing index keeps its recorded plan — the
    /// intended plan only shapes FRESH databases.
    pub fn open_at(db_path: &Path) -> rusqlite::Result<Self> {
        Self::open_at_with_plan(db_path, &EmbeddingPlan::legacy(crate::unix_ms_now()))
    }

    /// Open (or create) a RAG index at an explicit path under an explicit
    /// plan. The plan is written before the vec0 DDL on fresh databases
    /// (dimensions are fixed at CREATE); an existing database keeps its
    /// recorded plan untouched.
    pub fn open_at_with_plan(db_path: &Path, intended: &EmbeddingPlan) -> rusqlite::Result<Self> {
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
        let mut store = Self {
            conn,
            plan: intended.clone(),
        };
        store.migrate(intended)?;
        store.plan = store.read_plan()?;
        Ok(store)
    }

    /// The plan this index is locked to.
    pub fn plan(&self) -> &EmbeddingPlan {
        &self.plan
    }

    fn read_plan(&self) -> rusqlite::Result<EmbeddingPlan> {
        let raw = self
            .get_meta(PLAN_META_KEY)?
            .ok_or_else(|| rusqlite::Error::InvalidParameterName("embeddingPlan meta missing".into()))?;
        serde_json::from_str(&raw)
            .map_err(|e| rusqlite::Error::InvalidParameterName(format!("corrupt embeddingPlan meta: {e}")))
    }

    /// Idempotent schema migration — same steps/versions as the TS
    /// `migrate()` through v2, each target version in one transaction. v3
    /// adds the embeddingPlan lock: fresh databases write the intended
    /// plan BEFORE the vec0 DDL (dimensions are fixed at CREATE); existing
    /// databases get a backfill derived from their recorded embedderId.
    fn migrate(&self, intended: &EmbeddingPlan) -> rusqlite::Result<()> {
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
            // Plan before DDL: the vec0 dimension below comes from it.
            let plan_json = serde_json::to_string(intended)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            tx.prepare(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?
            .execute([PLAN_META_KEY, plan_json.as_str()])?;
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
                  embedding float[{}],
                  +chunkId  TEXT
                );",
                intended.dims
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
        if current < 3 {
            // Guarded backfill — a db left half-migrated by a crash reopens.
            let has_plan = tx
                .prepare("SELECT 1 FROM meta WHERE key = ?1")?
                .exists([PLAN_META_KEY])?;
            if !has_plan {
                // Every embedder that could have built a pre-v3 index is
                // 384-dim; the id comes from what init recorded, if
                // anything (workspace/knowledge init both write it).
                let embedder_id = tx
                    .prepare("SELECT value FROM meta WHERE key = 'embedderId'")?
                    .query_row([], |r| r.get::<_, String>(0))
                    .unwrap_or_else(|_| "local-code-512".to_owned());
                let mut plan = intended.clone();
                plan.embedder_id = embedder_id;
                plan.dims = 384;
                let plan_json = serde_json::to_string(&plan)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                tx.prepare(
                    "INSERT INTO meta(key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )?
                .execute([PLAN_META_KEY, plan_json.as_str()])?;
            }
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
        // Structural dimension lock — a wrong-space vector can never be
        // written, whatever the caller believes.
        for (_, _, embedding) in items {
            if embedding.len() != self.plan.dims {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "embedding dimension {} does not match the index plan {}",
                    embedding.len(),
                    self.plan.dims
                )));
            }
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
        if vec.len() != self.plan.dims {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "query dimension {} does not match the index plan {}",
                vec.len(),
                self.plan.dims
            )));
        }
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
    fn opens_with_schema_version_three_and_vec0() {
        let (_dir, s) = store();
        assert_eq!(s.get_meta("schemaVersion").unwrap().as_deref(), Some("3"));
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
        let embedder = FakeEmbedder { dim: 384 };
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
        let embedder = FakeEmbedder { dim: 384 };
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
        let embedder = FakeEmbedder { dim: 384 };
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

    fn plan(id: &str, dims: usize) -> EmbeddingPlan {
        EmbeddingPlan {
            embedder_id: id.into(),
            dims,
            chunk_size: None,
            chunk_overlap: None,
            created_at: unix_ms_now(),
        }
    }

    #[test]
    fn fresh_db_with_plan_creates_matching_vec0_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        let s = RagStore::open_at_with_plan(&path, &plan("local-bge-m3", 768)).unwrap();
        assert_eq!(s.plan().dims, 768);
        assert_eq!(s.plan().embedder_id, "local-bge-m3");

        let embedder = FakeEmbedder { dim: 768 };
        let r = row("b1", "wide vector chunk");
        let vectors = embedder.embed(&[r.content.clone()]).unwrap();
        let rowids = s.upsert_chunks(&[r]).unwrap();
        s.upsert_vectors(
            &rowids
                .into_iter()
                .zip(vectors)
                .map(|((id, rowid), embedding)| (rowid, id, embedding))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let q = embedder.embed(&["wide vector chunk".to_owned()]).unwrap();
        let hits = s.query_by_vector(&q[0], 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.id, "b1");

        // Reopen keeps the recorded plan even under a different intended
        // one — plans only shape fresh databases.
        let reopened = RagStore::open_at_with_plan(&path, &plan("local-code-512", 384)).unwrap();
        assert_eq!(reopened.plan().dims, 768);
        assert_eq!(reopened.plan().embedder_id, "local-bge-m3");
    }

    #[test]
    fn legacy_v2_db_backfills_plan_from_embedder_id_meta() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        // Build a current db, then rewind it to v2 shape (no plan meta).
        {
            let s = RagStore::open_at(&path).unwrap();
            s.conn
                .execute_batch(
                    "DELETE FROM meta WHERE key = 'embeddingPlan';
                     INSERT INTO meta(key, value) VALUES ('embedderId', 'cloud-base');
                     UPDATE meta SET value = '2' WHERE key = 'schemaVersion';",
                )
                .unwrap();
        }
        let reopened = RagStore::open_at(&path).unwrap();
        assert_eq!(reopened.get_meta("schemaVersion").unwrap().as_deref(), Some("3"));
        assert_eq!(reopened.plan().embedder_id, "cloud-base");
        assert_eq!(reopened.plan().dims, 384);
        // Its 384-dim vectors stay queryable through the migration.
        let embedder = FakeEmbedder { dim: 384 };
        let q = embedder.embed(&["anything".to_owned()]).unwrap();
        assert!(reopened.query_by_vector(&q[0], 1).is_ok());
    }

    #[test]
    fn dimension_lock_rejects_wrong_space_writes_and_queries() {
        let (_dir, s) = store(); // legacy plan: local-code-512, 384
        let embedder = FakeEmbedder { dim: 768 };
        let r = row("w1", "wrong space chunk");
        let vectors = embedder.embed(&[r.content.clone()]).unwrap();
        let rowids = s.upsert_chunks(&[r]).unwrap();
        let err = s
            .upsert_vectors(
                &rowids
                    .into_iter()
                    .zip(vectors)
                    .map(|((id, rowid), embedding)| (rowid, id, embedding))
                    .collect::<Vec<_>>(),
            )
            .unwrap_err();
        assert!(err.to_string().contains("768"), "was {err}");
        assert!(err.to_string().contains("384"), "was {err}");

        let q = embedder.embed(&["query".to_owned()]).unwrap();
        let err = s.query_by_vector(&q[0], 1).unwrap_err();
        assert!(err.to_string().contains("does not match the index plan"), "was {err}");
    }
}
