//! The RAG service — the daemon-side wiring over the vendored `rag` crate
//! (upstream tide's `src/commands/rag.rs` + `sources.rs`, adapted from
//! Tauri commands to plain functions the daemon's request handlers call).
//!
//! Layout mirrors upstream under `~/.tide` (or `TIDE_DATA_DIR`): the
//! per-project index at `<data>/rag/<projectId>/index.db`, the shared
//! knowledge index at `<data>/knowledge/index.db`, and the enabled list in
//! `config.rag_enabled_workspaces`. Projects (app.db) take the place of
//! upstream's config workspaces as the stable index key. Everything
//! blocking runs on the caller's request thread or a named background
//! thread — the UI polls status.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rag::{
    ChunkRow, KnowledgeStore, RagConfigInput, RagStore, WorkspaceIngestInputs, knowledge_db_path,
    rag_db_path,
};
use rag::{
    cloud_configured, download_model, ingest_documents, ingest_workspace, local_model_exists,
    resolve_embedder_for_build, resolve_embedder_for_query,
};
use store::paths::{config_path, data_dir};
use tools::{MemoryHit, MemoryIndex, rrf_fuse, set_shared_memory_index};

/// The default embedder config (upstream's hydrated defaults; the app has
/// no per-workspace ragConfig storage — cloud rides env vars only).
fn default_rag_config() -> RagConfigInput {
    RagConfigInput::default()
}

// ── memory tool index seam ─────────────────────────────────────────────────

/// The memory tool's backend — the upstream `runMemory` search semantics
/// over the per-project index plus the global knowledge-sources index
/// (filtered to sources enabled for the project, over-fetch ×3 then
/// post-filter, first-embedder-wins pinning honored). One process-wide
/// instance; each query resolves the embedder against the default config.
#[derive(Debug)]
pub struct RagMemoryIndex {
    data_dir: PathBuf,
    config_path: PathBuf,
}

impl RagMemoryIndex {
    pub fn new(data_dir: impl Into<PathBuf>, config_path: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            config_path: config_path.into(),
        }
    }

    /// Install the process-wide backend (idempotent).
    pub fn install_shared(self) {
        set_shared_memory_index(Some(Arc::new(self)));
    }

    /// (enabled) for a project id — a config re-read per query, exactly
    /// like upstream, so settings writes apply without restarts.
    fn enabled(&self, project_id: &str) -> bool {
        let Ok(cfg) = store::config::load(&self.config_path) else {
            return false;
        };
        cfg.rag_enabled_workspaces
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|id| id == project_id)
    }

    /// Embed the query with the query-time-resolved embedder. `None` when
    /// resolution fails (the seam degrades to empty vector rankings; FTS
    /// needs no embedder).
    fn embed_query(&self, query: &str) -> Option<Vec<f32>> {
        let (_, embedder) =
            resolve_embedder_for_query(&default_rag_config(), &self.data_dir).ok()?;
        embedder.embed(&[query.to_owned()]).ok()?.into_iter().next()
    }

    /// Open the knowledge store when its db exists — the existsSync guard
    /// keeps queries from creating an empty db as a side effect.
    fn knowledge(&self) -> Option<KnowledgeStore> {
        let path = knowledge_db_path(&self.data_dir);
        if !path.is_file() {
            return None;
        }
        KnowledgeStore::open_at(&path).ok()
    }
}

fn hit_from_row(row: &ChunkRow, similarity: Option<f64>, source_name: Option<String>) -> MemoryHit {
    MemoryHit {
        id: row.id.clone(),
        path: row.path.clone(),
        symbol: if row.symbol.is_empty() {
            None
        } else {
            Some(row.symbol.clone())
        },
        start_line: row.start_line.max(0) as u64,
        content: row.content.clone(),
        similarity,
        source_name,
    }
}

impl MemoryIndex for RagMemoryIndex {
    fn total_chunks(&self, project_id: &str) -> u64 {
        let mut total = 0u64;
        if self.enabled(project_id) {
            if let Some(count) = read_ingest_state(&self.data_dir, project_id).0 {
                total += count;
            }
        }
        if let Some(ks) = self.knowledge() {
            let enabled_ids: HashSet<String> =
                ks.enabled_source_ids_for(project_id).into_iter().collect();
            for source in ks.list_sources().unwrap_or_default() {
                if enabled_ids.contains(&source.id) {
                    total += source.chunk_count.max(0) as u64;
                }
            }
        }
        total
    }

    fn vector_hits(&self, project_id: &str, query: &str, k: usize) -> Vec<MemoryHit> {
        let enabled = self.enabled(project_id);
        let mut ws_hits = Vec::new();
        if enabled {
            if let Some(vec) = self.embed_query(query) {
                let path = rag_db_path(&self.data_dir, project_id);
                if path.is_file()
                    && let Ok(store) = RagStore::open_at(&path)
                {
                    ws_hits = store
                        .query_by_vector(&vec, k)
                        .unwrap_or_default()
                        .iter()
                        .map(|h| hit_from_row(&h.row, Some(h.similarity), None))
                        .collect();
                }
            }
        }
        let knowledge = self.knowledge_hits(project_id, query, k, Mode::Vector);
        rrf_fuse(ws_hits, knowledge, k)
    }

    fn fts_hits(&self, project_id: &str, query: &str, k: usize) -> Vec<MemoryHit> {
        let enabled = self.enabled(project_id);
        let mut ws_hits = Vec::new();
        if enabled {
            let path = rag_db_path(&self.data_dir, project_id);
            if path.is_file()
                && let Ok(store) = RagStore::open_at(&path)
            {
                ws_hits = store
                    .query_by_fts(query, k)
                    .unwrap_or_default()
                    .iter()
                    .map(|h| hit_from_row(&h.row, None, None))
                    .collect();
            }
        }
        let knowledge = self.knowledge_hits(project_id, query, k, Mode::Fts);
        rrf_fuse(ws_hits, knowledge, k)
    }
}

enum Mode {
    Vector,
    Fts,
}

impl RagMemoryIndex {
    /// The knowledge half: over-fetch ×3, filter to sources enabled for
    /// this project, decorate with the source's display name. Any failure
    /// degrades to "no knowledge results".
    fn knowledge_hits(
        &self,
        project_id: &str,
        query: &str,
        k: usize,
        mode: Mode,
    ) -> Vec<MemoryHit> {
        let Some(ks) = self.knowledge() else {
            return vec![];
        };
        let Ok(sources) = ks.list_sources() else {
            return vec![];
        };
        let enabled_ids: HashSet<String> =
            ks.enabled_source_ids_for(project_id).into_iter().collect();
        let names: HashMap<String, String> = sources
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect();
        let visible: u64 = sources
            .iter()
            .filter(|s| enabled_ids.contains(&s.id))
            .map(|s| s.chunk_count.max(0) as u64)
            .sum();
        if enabled_ids.is_empty() || visible == 0 {
            return vec![];
        }
        // First-embedder-wins pinning: silently skip on mismatch — never
        // cross vector spaces.
        if let Some(pinned) = ks.rag.get_meta("embedderId").ok().flatten() {
            let resolved = resolve_embedder_for_query(&default_rag_config(), &self.data_dir)
                .ok()
                .map(|(kind, _)| kind.id().to_string())
                .unwrap_or_default();
            if !resolved.is_empty() && pinned != resolved {
                return vec![];
            }
        }
        let over_fetch = k * 3;
        let hits: Vec<MemoryHit> = match mode {
            Mode::Vector => {
                let Some(vec) = self.embed_query(query) else {
                    return vec![];
                };
                ks.rag
                    .query_by_vector(&vec, over_fetch)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|h| {
                        let source_id = h.row.source_id.as_deref()?;
                        enabled_ids.contains(source_id).then(|| {
                            hit_from_row(&h.row, Some(h.similarity), names.get(source_id).cloned())
                        })
                    })
                    .collect()
            }
            Mode::Fts => ks
                .rag
                .query_by_fts(query, over_fetch)
                .unwrap_or_default()
                .iter()
                .filter_map(|h| {
                    let source_id = h.row.source_id.as_deref()?;
                    enabled_ids
                        .contains(source_id)
                        .then(|| hit_from_row(&h.row, None, names.get(source_id).cloned()))
                })
                .collect(),
        };
        rrf_fuse(hits, vec![], k)
    }
}

/// Install the process-wide memory index at boot.
pub fn install_memory_index() {
    RagMemoryIndex::new(data_dir(), config_path()).install_shared();
}

/// The `remember` tool's backend: routes facts into the project's durable
/// memory in the knowledge index.
#[derive(Debug)]
struct MemoryWriterBackend;

impl tools::MemoryWriter for MemoryWriterBackend {
    fn remember(&self, workspace_id: &str, fact: &str) -> Result<(), String> {
        remember_fact(workspace_id, fact)
    }
}

/// Install the process-wide memory writer at boot.
pub fn install_memory_writer() {
    tools::set_shared_memory_writer(Some(Arc::new(MemoryWriterBackend)));
}

// ── status / enable / init ─────────────────────────────────────────────────

/// (chunk count, last ingested at) for a project's index; `None` count
/// when no index exists yet.
fn read_ingest_state(data_dir: &std::path::Path, project_id: &str) -> (Option<u64>, Option<i64>) {
    let path = rag_db_path(data_dir, project_id);
    if !path.is_file() {
        return (None, None);
    }
    let Ok(store) = RagStore::open_at(&path) else {
        return (None, None);
    };
    let chunks = store.chunk_count().unwrap_or(0).max(0) as u64;
    let last = store
        .get_meta("lastIngestedAt")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    (Some(chunks), last)
}

/// Live ingestion progress per project — the last event each ingest thread
/// produced; the status read merges it (the poll's payload).
fn init_progress_map() -> &'static Mutex<HashMap<String, rag::IngestProgressEvent>> {
    static MAP: OnceLock<Mutex<HashMap<String, rag::IngestProgressEvent>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Live ingestion progress per knowledge source.
fn source_progress_map() -> &'static Mutex<HashMap<String, rag::SourceProgressEvent>> {
    static MAP: OnceLock<Mutex<HashMap<String, rag::SourceProgressEvent>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn running_inits() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The state of the local embedding-model download (upstream streamed
/// progress; the daemon records state the settings panel polls).
#[derive(Clone, Debug, PartialEq)]
pub enum ModelDownloadState {
    NotStarted,
    Ready,
    Downloading,
    Failed(String),
}

fn model_download_state() -> &'static Mutex<ModelDownloadState> {
    static STATE: OnceLock<Mutex<ModelDownloadState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(if local_model_exists(&data_dir()) {
            ModelDownloadState::Ready
        } else {
            ModelDownloadState::NotStarted
        })
    })
}

fn model_downloading() -> &'static Mutex<bool> {
    static FLAG: OnceLock<Mutex<bool>> = OnceLock::new();
    FLAG.get_or_init(|| Mutex::new(false))
}

/// Read one project's status (config + index + download state) straight
/// into the wire shape.
pub fn status(project_id: &str) -> protocol::RagStatusWire {
    let dir = data_dir();
    let cfg = store::config::load(&config_path()).ok();
    let enabled = cfg
        .as_ref()
        .and_then(|cfg| cfg.rag_enabled_workspaces.as_deref())
        .is_some_and(|ids| ids.iter().any(|id| id == project_id));
    let local_available = local_model_exists(&dir);
    let cloud = cloud_configured();
    let (chunks, last_ingested) = read_ingest_state(&dir, project_id);
    let downloading = *model_downloading().lock().unwrap();
    let download = match &*model_download_state().lock().unwrap() {
        ModelDownloadState::Ready => ("ready".to_owned(), None),
        ModelDownloadState::Downloading => ("downloading".to_owned(), None),
        ModelDownloadState::NotStarted => ("not-downloaded".to_owned(), None),
        ModelDownloadState::Failed(error) => ("failed".to_owned(), Some(error.clone())),
    };
    let _ = downloading;
    protocol::RagStatusWire {
        project_id: project_id.to_owned(),
        enabled,
        local_model_available: local_available,
        cloud_configured: cloud,
        model_download: download.0,
        model_download_error: download.1,
        chunk_count: chunks.unwrap_or(0),
        last_ingested_at: last_ingested,
        init_state: init_state_of(project_id, last_ingested),
        embedder_id: "local-code-512".to_owned(),
        init_progress: init_progress_map()
            .lock()
            .unwrap()
            .get(project_id)
            .map(|event| protocol::InitProgressWire {
                phase: event.phase.clone(),
                files_seen: event.files_seen,
                chunks_total: event.chunks_total,
                chunks_embedded: event.chunks_embedded,
                current_file: event.current_file.clone(),
                error: event.error.clone(),
            }),
    }
}

fn init_state_of(project_id: &str, last_ingested: Option<i64>) -> String {
    if running_inits().lock().unwrap().contains(project_id) {
        "running".to_owned()
    } else if last_ingested.is_some() {
        "done".to_owned()
    } else {
        "never".to_owned()
    }
}

/// Kick the embedding-model download on a background thread (idempotent;
/// a no-op when the model already exists). Progress is state, not events —
/// the panel polls.
pub fn ensure_model_downloaded() {
    if local_model_exists(&data_dir()) {
        *model_download_state().lock().unwrap() = ModelDownloadState::Ready;
        return;
    }
    let mut downloading = model_downloading().lock().unwrap();
    if *downloading {
        return;
    }
    *downloading = true;
    drop(downloading);
    *model_download_state().lock().unwrap() = ModelDownloadState::Downloading;
    let dir = data_dir();
    let spawned = std::thread::Builder::new()
        .name("tide-rag-model".to_owned())
        .spawn(move || {
            let result = download_model(&dir, |_progress| {});
            let mut state = model_download_state().lock().unwrap();
            match result {
                Ok(_) => *state = ModelDownloadState::Ready,
                Err(error) => *state = ModelDownloadState::Failed(error),
            }
            *model_downloading().lock().unwrap() = false;
        });
    if spawned.is_err() {
        *model_downloading().lock().unwrap() = false;
        *model_download_state().lock().unwrap() =
            ModelDownloadState::Failed("could not spawn the download thread".to_owned());
    }
}

/// Enable RAG for a project: persist into `rag_enabled_workspaces` (config
/// write under the crate's config lock) and make sure the model download
/// is on its way.
pub fn enable_project(project_id: &str) -> Result<(), String> {
    ensure_model_downloaded();
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    cfg.rag_enabled_workspaces
        .get_or_insert_with(Vec::new)
        .push(project_id.to_owned());
    cfg.rag_enabled_workspaces.as_mut().map(|ids| ids.dedup());
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())
}

/// Disable RAG for a project (config write only; the index stays).
pub fn disable_project(project_id: &str) -> Result<(), String> {
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    if let Some(ids) = cfg.rag_enabled_workspaces.as_mut() {
        ids.retain(|id| id != project_id);
    }
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())
}

/// Kick workspace ingestion on a background thread (re-entry guarded per
/// project). Returns the start time on success.
pub fn init_project(project_id: &str, project_path: &std::path::Path) -> Result<i64, String> {
    {
        let mut running = running_inits().lock().unwrap();
        if running.contains(project_id) {
            return Err("indexing already running for this project".into());
        }
        running.insert(project_id.to_owned());
    }
    let dir = data_dir();
    let id = project_id.to_owned();
    let path = project_path.to_path_buf();
    let started_at = rag::unix_ms_now();
    let spawned = std::thread::Builder::new()
        .name(format!("tide-rag-ingest-{id}"))
        .spawn(move || {
            let result = (|| {
                let (_, embedder) = resolve_embedder_for_build(&default_rag_config(), &dir)?;
                ingest_workspace(
                    WorkspaceIngestInputs {
                        workspace_id: &id,
                        path: &path,
                        worktree_location: None,
                        data_dir: &dir,
                    },
                    embedder.as_ref(),
                    |progress| {
                        init_progress_map()
                            .lock()
                            .unwrap()
                            .insert(id.clone(), progress);
                    },
                )
            })();
            running_inits().lock().unwrap().remove(&id);
            if let Err(error) = result {
                // The status read shows the failure via the missing/short
                // index; the error text rides the log only.
                eprintln!("[tide-rag] ingest {id} failed: {error}");
            }
        });
    if spawned.is_err() {
        running_inits().lock().unwrap().remove(project_id);
        return Err("could not spawn the ingest thread".into());
    }
    Ok(started_at)
}

// ── knowledge sources ──────────────────────────────────────────────────────

/// The serial knowledge-indexing manager — one thread, one job at a time,
/// duplicate jobs collapse (upstream's queue, minus Tauri).
struct KnowledgeManager {
    tx: std::sync::mpsc::Sender<String>,
    pending: Arc<Mutex<HashSet<String>>>,
}

fn knowledge_manager() -> &'static KnowledgeManager {
    static MANAGER: OnceLock<KnowledgeManager> = OnceLock::new();
    MANAGER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
        let pending_for_thread = Arc::clone(&pending);
        std::thread::Builder::new()
            .name("tide-knowledge".to_owned())
            .spawn(move || {
                // Crash recovery: an "indexing" row from a dead process is
                // stale the moment this thread starts.
                if let Ok(ks) = open_knowledge() {
                    let _ = ks.resolve_stale_statuses(&[]);
                }
                while let Ok(source_id) = rx.recv() {
                    reindex_source_sync(&source_id);
                    pending_for_thread.lock().unwrap().remove(&source_id);
                }
            })
            .expect("the knowledge manager thread spawns once");
        KnowledgeManager { tx, pending }
    })
}

/// Map a knowledge source row onto its wire shape.
pub fn source_wire(source: &rag::KnowledgeSource) -> protocol::KnowledgeSourceWire {
    protocol::KnowledgeSourceWire {
        id: source.id.clone(),
        name: source.name.clone(),
        kind: source.kind.clone(),
        location: source.location.clone(),
        created_at: source.created_at,
        last_indexed_at: source.last_indexed_at,
        status: source.status.clone(),
        error: source.error.clone(),
        chunk_count: source.chunk_count,
        embedder_id: source.embedder_id.clone(),
        enabled_workspace_ids: source.enabled_workspace_ids.clone(),
        progress: source_progress_map()
            .lock()
            .unwrap()
            .get(&source.id)
            .map(|event| protocol::SourceProgressWire {
                phase: event.phase.clone(),
                chunks_total: event.chunks_total,
                chunks_embedded: event.chunks_embedded,
                current: event.current.clone(),
                error: event.error.clone(),
            }),
    }
}

/// List sources in wire shape (an empty list when no index exists yet).
pub fn list_sources() -> Vec<protocol::KnowledgeSourceWire> {
    match open_knowledge() {
        Ok(ks) => ks
            .list_sources()
            .map(|sources| sources.iter().map(source_wire).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Add a source (validating kind + dedupe by kind+location), enqueue the
/// first index, and return the wire row.
pub fn add_source(
    name: &str,
    kind: &str,
    location: &str,
) -> Result<protocol::KnowledgeSourceWire, String> {
    if !matches!(kind, "url" | "docs" | "crawl" | "repo") {
        return Err(format!(
            "unknown source kind {kind:?} (url, docs, crawl, repo)"
        ));
    }
    if name.trim().is_empty() || location.trim().is_empty() {
        return Err("name and location are required".into());
    }
    let ks = open_knowledge()?;
    let existing = ks
        .list_sources()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.kind == kind && s.location == location);
    if existing.is_some() {
        return Err("a source with this kind and location already exists".into());
    }
    // No name given: derive one from the location (host, dir leaf, or repo
    // slug) so the settings list stays readable with the lean add row.
    let name = if name.trim().is_empty() {
        let trimmed: &str = location
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        let leaf = match kind {
            "repo" | "docs" => trimmed.rsplit('/').next().unwrap_or(trimmed),
            _ => trimmed.split('/').next().unwrap_or(trimmed),
        };
        let chosen = if leaf.is_empty() {
            location.trim()
        } else {
            leaf
        };
        chosen.to_owned()
    } else {
        name.trim().to_owned()
    };
    let source = ks
        .add_source(&name, kind, location.trim(), Some(&["*".to_owned()]))
        .map_err(|e| e.to_string())?;
    enqueue_reindex(&source.id);
    Ok(source_wire(&source))
}

/// Remove a source and its chunks.
pub fn remove_source(source_id: &str) -> Result<(), String> {
    let ks = open_knowledge()?;
    if ks.get_source(source_id).is_none() {
        return Err(format!("unknown source {source_id:?}"));
    }
    let _ = ks.delete_source(source_id);
    let _ = ks.purge_orphans(source_id);
    Ok(())
}

/// Queue a reindex; unknown ids fail loudly.
pub fn reindex_source(source_id: &str) -> Result<(), String> {
    let ks = open_knowledge()?;
    let Some(source) = ks.get_source(source_id) else {
        return Err(format!("unknown source {source_id:?}"));
    };
    let _ = source;
    ks.mark_status(source_id, "queued", None);
    enqueue_reindex(source_id);
    Ok(())
}

/// Set the workspaces a source is enabled for ("*" = all).
pub fn set_source_enabled(source_id: &str, enabled: &[String]) -> Result<(), String> {
    let ks = open_knowledge()?;
    if ks.get_source(source_id).is_none() {
        return Err(format!("unknown source {source_id:?}"));
    }
    ks.set_enabled(source_id, enabled);
    Ok(())
}

/// Open (creating) the shared knowledge store.
pub fn open_knowledge() -> Result<KnowledgeStore, String> {
    let dir = data_dir();
    KnowledgeStore::open(&dir).map_err(|e| e.to_string())
}

/// Queue one source for (re)indexing; duplicates collapse to a no-op.
pub fn enqueue_reindex(source_id: &str) {
    let manager = knowledge_manager();
    {
        let mut pending = manager.pending.lock().unwrap();
        if pending.contains(source_id) {
            return;
        }
        pending.insert(source_id.to_owned());
    }
    let _ = manager.tx.send(source_id.to_owned());
}

/// The synchronous job body: mark indexing → fetch by kind → embed+store
/// → settle status and chunk count.
fn reindex_source_sync(source_id: &str) {
    let Ok(ks) = open_knowledge() else {
        return;
    };
    let Some(source) = ks.get_source(source_id) else {
        return;
    };
    ks.mark_status(source_id, "indexing", None);
    let dir = data_dir();
    let result = (|| -> Result<usize, String> {
        let docs = fetch_documents(&source)?;
        let (_, embedder) = resolve_embedder_for_build(&default_rag_config(), &dir)?;
        let count = ingest_documents(&ks, embedder.as_ref(), source_id, &docs, |progress| {
            source_progress_map()
                .lock()
                .unwrap()
                .insert(source_id.to_owned(), progress);
        })?;
        Ok(count)
    })();
    source_progress_map().lock().unwrap().remove(source_id);
    match result {
        Ok(count) => {
            let _ = ks.purge_orphans(source_id);
            ks.set_chunk_count(source_id, count as i64);
            ks.mark_status(source_id, "idle", None);
        }
        Err(error) => {
            ks.mark_status(source_id, "error", Some(&error));
        }
    }
}

/// Kind dispatch for the fetchers.
fn fetch_documents(source: &rag::KnowledgeSource) -> Result<Vec<rag::SourceDocument>, String> {
    match source.kind.as_str() {
        "url" => rag::fetch_url(&source.location),
        "crawl" => rag::fetch_crawl(&source.location, None, None, |_n, _url| {}),
        "repo" => rag::fetch_repo(&source.location),
        "docs" => {
            let roots = project_roots();
            rag::fetch_docs(&source.location, &roots)
        }
        other => Err(format!("unknown source kind {other:?}")),
    }
}

/// Roots local docs sources may read: every known project path (the app's
/// projects stand in for upstream's workspaces). The daemon refreshes this
/// whenever its project list changes.
pub fn update_project_roots(roots: Vec<PathBuf>) {
    *project_roots_locked().lock().unwrap() = roots;
}

fn project_roots() -> Vec<PathBuf> {
    project_roots_locked().lock().unwrap().clone()
}

fn project_roots_locked() -> &'static Mutex<Vec<PathBuf>> {
    static ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

// ── agent memory (the remember seam's backend half) ────────────────────────

/// Append one durable fact for a project into the knowledge index under a
/// per-project "memory" source, embedded with the build embedder. Facts
/// ride the normal fused query with `source_name` = the source's name.
pub fn remember_fact(project_id: &str, fact: &str) -> Result<(), String> {
    let ks = open_knowledge()?;
    // The memory source is located by kind + location (add_source mints
    // uuid ids; the project id rides `location` so the row is findable
    // across restarts) and visible to every workspace.
    let existing = ks
        .list_sources()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.kind == "memory" && s.location == project_id);
    let source = match existing {
        Some(source) => source,
        None => ks
            .add_source(
                &format!("Memory · {project_id}"),
                "memory",
                project_id,
                Some(&["*".to_owned()]),
            )
            .map_err(|e| e.to_string())?,
    };
    let dir = data_dir();
    let (_, embedder) = resolve_embedder_for_build(&default_rag_config(), &dir)?;
    // Chunk ids derive from the origin — a unique origin per fact
    // accumulates; the same origin would overwrite.
    let fact_id = format!("{}{}", fact.len(), rag::unix_ms_now());
    let doc = rag::SourceDocument {
        title: "memory".to_owned(),
        content: fact.to_owned(),
        origin: format!("memory:{project_id}:{fact_id}"),
    };
    let count = ingest_documents(&ks, embedder.as_ref(), &source.id, &[doc], |_p| {})?;
    ks.set_chunk_count(&source.id, count as i64);
    Ok(())
}

#[cfg(test)]
mod tests {
    // The seam wiring is exercised through the vendored crate's own tests;
    // here we pin the config enable/disable cycle against a temp data dir.

    #[test]
    fn enable_disable_cycle_round_trips_the_config() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_path = tmp.path().join("config.json");
        store::config::save(&cfg_path, &store::config::Config::default()).unwrap();
        let mut cfg = store::config::load(&cfg_path).unwrap();
        cfg.rag_enabled_workspaces = Some(vec!["p1".to_owned()]);
        store::config::save(&cfg_path, &cfg).unwrap();

        let mut loaded = store::config::load(&cfg_path).unwrap();
        let ids = loaded.rag_enabled_workspaces.as_deref().unwrap_or_default();
        assert!(ids.iter().any(|id| id == "p1"));
        loaded
            .rag_enabled_workspaces
            .as_mut()
            .map(|ids| ids.retain(|id| id != "p1"));
        store::config::save(&cfg_path, &loaded).unwrap();
        let reloaded = store::config::load(&cfg_path).unwrap();
        assert!(
            reloaded
                .rag_enabled_workspaces
                .as_deref()
                .unwrap_or_default()
                .is_empty()
        );
    }
}
