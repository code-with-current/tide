//! tide-rag — local-first RAG engine, port of `app/core/rag/` @ 91ec558.
//!
//! Same vendored ONNX model (`models/` in this crate, embedded into the
//! binary as the packaged-app fallback), same per-workspace SQLite index
//! layout (`<data>/rag/<workspaceId>/index.db`, schema v2 with FTS5 +
//! sqlite-vec `vec0` shadow tables), same tokenizer (the HF
//! `tokenizer.json` that ships beside the model) — so indexes written by
//! the Electron/Electrobun builds stay readable and query-compatible.
//!
//! Everything here is synchronous (ort inference, sqlite, tree-sitter, and
//! `reqwest::blocking` for the fetchers/downloader); the Tauri command
//! layer wraps calls in `spawn_blocking`.

pub mod chunker;
pub mod embedder;
pub mod ingest;
pub mod knowledge;
pub mod resolve;
pub mod store;

pub use chunker::{Chunk, chunk_file};
pub use embedder::{
    LOCAL_EMBEDDER_DIM, LOCAL_EMBEDDER_ID, LOCAL_EMBEDDER_MAX_TOKENS, MODEL_FILES,
    MODEL_ID,
};
pub use embedder::{cloud_configured, download_model, local_model_exists, models_dir_for};
pub use ingest::{
    CHUNKABLE_EXTS, IngestProgressEvent, IngestResult, SKIP_DIRS, WorkspaceIngestInputs,
    embed_and_store, ingest_workspace,
};
pub use knowledge::{
    KnowledgeSource, KnowledgeStore, SOURCE_KINDS, SourceDocument, SourceKind,
    SourceProgressEvent,
};
pub use knowledge::{
    fetch_crawl, fetch_docs, fetch_repo, fetch_url, ingest_documents, knowledge_db_path,
    split_prose,
};
pub use resolve::{
    EmbedderKind, RagConfigInput, embedder_of, resolve_embedder_for_build,
    resolve_embedder_for_query, resolve_for_build, resolve_for_query,
};
pub use store::{ChunkRow, FtsHit, RagStore, VectorHit, rag_db_path};

/// `sha256(hex)` of a string — the id/contentHash hasher the TS module used.
pub(crate) fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let out = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// Milliseconds since the unix epoch (`Date.now()`).
pub fn unix_ms_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
