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
    ChunkRow, KnowledgeStore, RagStore, WorkspaceIngestInputs, knowledge_db_path, rag_db_path,
};
use rag::{
    cloud_configured, default_entry, download_model, entry as catalog_entry, ingest_documents,
    ingest_workspace, local_model_exists, resolve_embedder_for_build, resolve_embedder_for_query,
    Embedder, EmbedUse, EmbeddingPlan, RagConfigInput,
};
use store::paths::{config_path, data_dir};
use tools::{MemoryHit, MemoryIndex, rrf_fuse, set_shared_memory_index};

/// Effective RAG settings at a config path (defaults when absent).
fn effective_settings_at(cfg_path: &std::path::Path) -> store::config::EffectiveRagSettings {
    store::config::load(cfg_path)
        .ok()
        .map(|c| c.rag_effective())
        .unwrap_or_default()
}

/// The hydrated rag-crate config at a path. Custom endpoint keys are
/// decrypted here, in-process — the rag crate never sees the secrets store.
fn rag_config_at(cfg_path: &std::path::Path) -> RagConfigInput {
    let eff = effective_settings_at(cfg_path);
    let custom_endpoints = eff
        .custom_endpoints
        .iter()
        .filter_map(|ep| {
            let api_key = ep
                .encrypted_key
                .as_deref()
                .and_then(|k| store::secrets::decrypt_stored(k).ok().flatten())?;
            Some(rag::CustomEndpointSpec {
                id: ep.id.clone(),
                base_url: ep.base_url.clone(),
                model_id: ep.model_id.clone(),
                api_key,
                dims: ep.dims,
                max_tokens: ep.max_tokens.unwrap_or(8191) as usize,
            })
        })
        .collect();
    RagConfigInput {
        embedder_id: eff.embedder_id.clone(),
        cloud_allowed: eff.cloud_allowed,
        cloud_model_id: eff.cloud_model_id.clone(),
        custom_endpoints,
    }
}

/// The hydrated global config (the daemon's own config path).
fn effective_rag_config() -> RagConfigInput {
    rag_config_at(&config_path())
}

/// The embedding plan an ingest run intends: the resolved embedder's id,
/// MEASURED dimensions (remote embedders probe once here), and the
/// configured chunking.
fn intended_plan(
    embedder: &dyn Embedder,
    eff: &store::config::EffectiveRagSettings,
) -> Result<EmbeddingPlan, String> {
    let dims = embedder.ensure_dims()?;
    Ok(EmbeddingPlan {
        embedder_id: embedder.id().to_owned(),
        dims,
        chunk_size: eff.chunk_size,
        chunk_overlap: eff.chunk_overlap,
        created_at: rag::unix_ms_now(),
    })
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

    /// The hydrated rag config at this index's config path.
    fn rag_config(&self) -> RagConfigInput {
        rag_config_at(&self.config_path)
    }

    /// The embedder id a project index is locked to — its embedding plan
    /// when the db exists, the configured default otherwise.
    fn project_index_id(&self, project_id: &str, cfg: &RagConfigInput) -> String {
        let path = rag_db_path(&self.data_dir, project_id);
        if path.is_file()
            && let Ok(store) = RagStore::open_at(&path)
        {
            return store.plan().embedder_id.clone();
        }
        cfg.embedder_id.clone()
    }

    /// The embedder id the knowledge index is locked to.
    fn knowledge_index_id(&self, cfg: &RagConfigInput) -> String {
        let path = knowledge_db_path(&self.data_dir);
        if path.is_file()
            && let Ok(ks) = KnowledgeStore::open_at(&path)
        {
            return ks.rag.plan().embedder_id.clone();
        }
        cfg.embedder_id.clone()
    }

    /// Embed the query with the embedder the given index recorded.
    /// `None` when resolution fails (the seam degrades to empty vector
    /// rankings; FTS needs no embedder).
    fn embed_query_with(
        &self,
        index_id: &str,
        query: &str,
        cfg: &RagConfigInput,
    ) -> Option<Vec<f32>> {
        let (_, embedder) = resolve_embedder_for_query(index_id, cfg, &self.data_dir).ok()?;
        embedder
            .embed_use(&[query.to_owned()], EmbedUse::Query)
            .ok()?
            .into_iter()
            .next()
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
            let cfg = self.rag_config();
            let index_id = self.project_index_id(project_id, &cfg);
            if let Some(vec) = self.embed_query_with(&index_id, query, &cfg) {
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
        // Resolution is keyed on the index's recorded plan id — a stale
        // index resolves ITS embedder (or fails, degrading this lane);
        // it never borrows the newly configured one.
        let cfg = self.rag_config();
        let over_fetch = k * 3;
        let hits: Vec<MemoryHit> = match mode {
            Mode::Vector => {
                let index_id = self.knowledge_index_id(&cfg);
                let Some(vec) = self.embed_query_with(&index_id, query, &cfg) else {
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

/// (chunk count, last ingested at, plan embedder id) for a project's
/// index; `None` count when no index exists yet.
fn read_ingest_state(
    data_dir: &std::path::Path,
    project_id: &str,
) -> (Option<u64>, Option<i64>, Option<String>) {
    let path = rag_db_path(data_dir, project_id);
    if !path.is_file() {
        return (None, None, None);
    }
    let Ok(store) = RagStore::open_at(&path) else {
        return (None, None, None);
    };
    let chunks = store.chunk_count().unwrap_or(0).max(0) as u64;
    let last = store
        .get_meta("lastIngestedAt")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    (Some(chunks), last, Some(store.plan().embedder_id.clone()))
}

/// Does the project's recorded plan differ from the configured
/// model/chunking? `false` with no index yet (nothing to be stale).
fn plan_stale_at(
    cfg_path: &std::path::Path,
    data_dir: &std::path::Path,
    project_id: &str,
) -> bool {
    let eff = effective_settings_at(cfg_path);
    let path = rag_db_path(data_dir, project_id);
    if !path.is_file() {
        return false;
    }
    let Ok(store) = RagStore::open_at(&path) else {
        return false;
    };
    let plan = store.plan();
    plan.embedder_id != eff.embedder_id
        || plan.chunk_size != eff.chunk_size
        || plan.chunk_overlap != eff.chunk_overlap
}

fn plan_stale(data_dir: &std::path::Path, project_id: &str) -> bool {
    plan_stale_at(&config_path(), data_dir, project_id)
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

/// The state of a local embedding-model download (upstream streamed
/// progress; the daemon records state the settings panel polls). Keyed
/// by catalog model id.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelDownloadState {
    NotStarted,
    Ready,
    Downloading,
    Failed(String),
}

fn model_download_states() -> &'static Mutex<HashMap<String, ModelDownloadState>> {
    static STATES: OnceLock<Mutex<HashMap<String, ModelDownloadState>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn model_downloads_running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// (state, error) for one model, in the wire shape; vendored models are
/// always "ready".
fn model_download_wire(model_id: &str) -> (String, Option<String>) {
    let Some(entry) = catalog_entry(model_id) else {
        return ("not-downloaded".to_owned(), None);
    };
    if entry.vendored {
        return ("ready".to_owned(), None);
    }
    let states = model_download_states().lock().unwrap();
    match states.get(model_id) {
        Some(ModelDownloadState::Ready) => ("ready".to_owned(), None),
        Some(ModelDownloadState::Downloading) => ("downloading".to_owned(), None),
        Some(ModelDownloadState::Failed(error)) => ("failed".to_owned(), Some(error.clone())),
        Some(ModelDownloadState::NotStarted) | None => {
            // Never-started reads as ready when the files are already on
            // disk (e.g. a restored data dir).
            if rag::local_model_exists_for(entry, &data_dir()) {
                ("ready".to_owned(), None)
            } else {
                ("not-downloaded".to_owned(), None)
            }
        }
    }
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
    let (chunks, last_ingested, plan_id) = read_ingest_state(&dir, project_id);
    let (download_state, download_error) = model_download_wire(default_entry().id);
    protocol::RagStatusWire {
        project_id: project_id.to_owned(),
        enabled,
        local_model_available: local_available,
        cloud_configured: cloud,
        model_download: download_state,
        model_download_error: download_error,
        chunk_count: chunks.unwrap_or(0),
        last_ingested_at: last_ingested,
        init_state: init_state_of(project_id, last_ingested),
        embedder_id: plan_id.unwrap_or_else(|| effective_rag_config().embedder_id),
        plan_stale: plan_stale(&dir, project_id),
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
pub fn ensure_model_downloaded(model_id: &str) {
    let Some(entry) = catalog_entry(model_id) else {
        return; // cloud/custom ids download nothing
    };
    if entry.vendored || rag::local_model_exists_for(entry, &data_dir()) {
        model_download_states()
            .lock()
            .unwrap()
            .insert(model_id.to_owned(), ModelDownloadState::Ready);
        return;
    }
    {
        let mut running = model_downloads_running().lock().unwrap();
        if running.contains(model_id) {
            return;
        }
        running.insert(model_id.to_owned());
    }
    model_download_states()
        .lock()
        .unwrap()
        .insert(model_id.to_owned(), ModelDownloadState::Downloading);
    let dir = data_dir();
    let id = model_id.to_owned();
    let spawned = std::thread::Builder::new()
        .name(format!("tide-rag-model-{id}"))
        .spawn(move || {
            let result = download_model(&dir, entry, |_progress| {});
            let mut states = model_download_states().lock().unwrap();
            match result {
                Ok(_) => {
                    states.insert(id.clone(), ModelDownloadState::Ready);
                }
                Err(error) => {
                    states.insert(id.clone(), ModelDownloadState::Failed(error));
                }
            }
            model_downloads_running().lock().unwrap().remove(&id);
        });
    if spawned.is_err() {
        model_downloads_running().lock().unwrap().remove(model_id);
        model_download_states().lock().unwrap().insert(
            model_id.to_owned(),
            ModelDownloadState::Failed("could not spawn the download thread".to_owned()),
        );
    }
}

/// Make sure the CONFIGURED embedder's model is on its way down (the
/// enable-path entry point; no-op for cloud/custom ids).
fn ensure_configured_model_downloaded() {
    ensure_model_downloaded(&effective_rag_config().embedder_id);
}

/// Delete a downloaded catalog model's files. Returns the affected
/// projects first (indexes whose plan names the model — plus the global
/// knowledge index) so callers can confirm; the delete itself refuses
/// while an ingest is running. Vendored models cannot be deleted.
pub fn delete_model(model_id: &str) -> Result<Vec<protocol::RagAffectedWorkspaceWire>, String> {
    let Some(entry) = catalog_entry(model_id) else {
        return Err(format!("unknown model id {model_id:?}"));
    };
    if entry.vendored {
        return Err(format!("{} ships with the app and cannot be deleted", entry.repo));
    }
    let affected = affected_workspaces_by_id(model_id);
    let dir = data_dir();
    let model_dir = rag::models_dir_for(&dir).join(entry.repo);
    if model_dir.is_dir() {
        let running = running_inits().lock().unwrap();
        if !running.is_empty() {
            return Err("an indexing run is in progress — try again after it finishes".into());
        }
        drop(running);
        std::fs::remove_dir_all(&model_dir).map_err(|e| e.to_string())?;
    }
    model_download_states().lock().unwrap().remove(model_id);
    Ok(affected)
}

/// Enabled project ids straight from config.
fn enabled_project_ids() -> Vec<String> {
    store::config::load(&config_path())
        .ok()
        .and_then(|cfg| cfg.rag_enabled_workspaces)
        .unwrap_or_default()
}

// ── global config / models / endpoints (the settings cards) ────────────

/// The effective settings + custom endpoints (no key material) + whether
/// the system cloud connection is available — one read for the page.
pub fn config_wire() -> (
    protocol::RagConfigWire,
    Vec<protocol::RagEndpointWire>,
    bool,
) {
    let cfg = store::config::load(&config_path()).ok();
    let eff = cfg
        .as_ref()
        .map(|c| c.rag_effective())
        .unwrap_or_default();
    let endpoints = eff
        .custom_endpoints
        .iter()
        .map(|ep| protocol::RagEndpointWire {
            id: ep.id.clone(),
            name: ep.name.clone(),
            base_url: ep.base_url.clone(),
            model_id: ep.model_id.clone(),
            dims: ep.dims,
            max_tokens: ep.max_tokens,
            has_key: ep.encrypted_key.is_some(),
        })
        .collect();
    let wire = protocol::RagConfigWire {
        embedder_id: eff.embedder_id.clone(),
        cloud_allowed: eff.cloud_allowed,
        cloud_model_id: eff.cloud_model_id.clone(),
        top_k: eff.top_k,
        min_similarity: eff.min_similarity,
        chunk_size: eff.chunk_size,
        chunk_overlap: eff.chunk_overlap,
    };
    (wire, endpoints, cloud_configured())
}

/// Indexes whose plan differs from (embedder id, chunking) — the rebuild
/// dialog's rows. `project_id == "*"` marks the global knowledge index.
fn affected_workspaces(
    embedder_id: &str,
    chunk_size: Option<u64>,
    chunk_overlap: Option<u64>,
) -> Vec<protocol::RagAffectedWorkspaceWire> {
    affected_workspaces_for(data_dir(), &enabled_project_ids(), embedder_id, chunk_size, chunk_overlap)
}

/// The affected computation over explicit inputs (testable): every listed
/// project index + the knowledge index whose plan differs.
fn affected_workspaces_for(
    dir: std::path::PathBuf,
    enabled: &[String],
    embedder_id: &str,
    chunk_size: Option<u64>,
    chunk_overlap: Option<u64>,
) -> Vec<protocol::RagAffectedWorkspaceWire> {
    let mut out = Vec::new();
    for project_id in enabled {
        let path = rag_db_path(&dir, &project_id);
        if !path.is_file() {
            continue;
        }
        if let Ok(store) = RagStore::open_at(&path) {
            let plan = store.plan();
            if plan.embedder_id != embedder_id
                || plan.chunk_size != chunk_size
                || plan.chunk_overlap != chunk_overlap
            {
                out.push(protocol::RagAffectedWorkspaceWire {
                    project_id: project_id.clone(),
                    built_with: plan.embedder_id.clone(),
                });
            }
        }
    }
    let knowledge = knowledge_db_path(&dir)
        .is_file()
        .then(|| KnowledgeStore::open_at(&knowledge_db_path(&dir)).ok())
        .flatten();
    let _ = &knowledge;
    if let Some(ks) = knowledge {
        let plan = ks.rag.plan();
        if plan.embedder_id != embedder_id
            || plan.chunk_size != chunk_size
            || plan.chunk_overlap != chunk_overlap
        {
            out.push(protocol::RagAffectedWorkspaceWire {
                project_id: "*".to_owned(),
                built_with: plan.embedder_id.clone(),
            });
        }
    }
    out
}

/// Merge a partial settings update under the config lock, validate the
/// embedder id resolves, kick the model download when it's a catalog id,
/// and return which indexes the change left behind.
pub fn update_config(
    patch: &protocol::RagConfigPatchWire,
) -> Result<Vec<protocol::RagAffectedWorkspaceWire>, String> {
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    let rag = cfg.rag.get_or_insert_with(store::config::RagSettings::default);
    merge_rag_patch(rag, patch)?;

    let eff = rag.effective();
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())?;
    drop(_guard);

    // A newly-selected catalog model starts downloading immediately.
    if rag::entry(&eff.embedder_id).is_some() {
        ensure_model_downloaded(&eff.embedder_id);
    }
    Ok(affected_workspaces(
        &eff.embedder_id,
        eff.chunk_size,
        eff.chunk_overlap,
    ))
}

/// Validation + field merge for a settings patch (pure — testable without
/// touching the daemon's config path).
fn merge_rag_patch(
    rag: &mut store::config::RagSettings,
    patch: &protocol::RagConfigPatchWire,
) -> Result<(), String> {
    if let Some(id) = &patch.embedder_id {
        let valid = rag::entry(id).is_some()
            || id == "cloud-base"
            || rag.custom_endpoints.iter().any(|e| &e.id == id);
        if !valid {
            return Err(format!(
                "unknown embedder {id:?} — pick a catalog model, cloud, or an existing endpoint"
            ));
        }
        rag.embedder_id = Some(id.clone());
    }
    if let Some(allowed) = patch.cloud_allowed {
        rag.cloud_allowed = Some(allowed);
    }
    if let Some(model) = &patch.cloud_model_id {
        rag.cloud_model_id = (!model.is_empty()).then(|| model.clone());
    }
    if let Some(top_k) = patch.top_k {
        if top_k == 0 || top_k > 50 {
            return Err("topK must be between 1 and 50".into());
        }
        rag.top_k = Some(top_k);
    }
    if let Some(min) = patch.min_similarity {
        if !(-1.0..=1.0).contains(&min) {
            return Err("minSimilarity must be within [-1, 1]".into());
        }
        rag.min_similarity = Some(min);
    }
    if let Some(size) = patch.chunk_size {
        if !(64..=8192).contains(&size) {
            return Err("chunkSize must be between 64 and 8192".into());
        }
        rag.chunk_size = Some(size);
    }
    if let Some(overlap) = patch.chunk_overlap {
        if overlap >= 8192 {
            return Err("chunkOverlap must be smaller than the chunk size range".into());
        }
        rag.chunk_overlap = Some(overlap);
    }
    Ok(())
}

/// The catalog joined with on-disk download state.
pub fn models_list() -> Vec<protocol::RagModelWire> {
    let dir = data_dir();
    rag::CATALOG
        .iter()
        .map(|entry| {
            let (state, error) = model_download_wire(entry.id);
            protocol::RagModelWire {
                id: entry.id.to_owned(),
                name: entry.repo.to_owned(),
                dims: entry.dims,
                max_tokens: entry.max_tokens as u64,
                languages: entry.languages.to_owned(),
                vendored: entry.vendored,
                downloaded: rag::local_model_exists_for(entry, &dir),
                download_size: entry.download_size,
                download_state: state,
                download_error: error,
            }
        })
        .collect()
}

fn endpoint_wire(ep: &store::config::RagCustomEndpoint) -> protocol::RagEndpointWire {
    protocol::RagEndpointWire {
        id: ep.id.clone(),
        name: ep.name.clone(),
        base_url: ep.base_url.clone(),
        model_id: ep.model_id.clone(),
        dims: ep.dims,
        max_tokens: ep.max_tokens,
        has_key: ep.encrypted_key.is_some(),
    }
}

fn endpoint_slug(name: &str, taken: &[String]) -> String {
    let base: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse separator runs before trimming.
    let base = base
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "endpoint".to_string() } else { base };
    let mut candidate = format!("custom-{base}");
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = format!("custom-{base}-{n}");
        n += 1;
    }
    candidate
}

/// Add a custom endpoint: probe FIRST (one test embedding measures dims
/// and validates the URL/key; upstream errors surface verbatim), persist
/// only on success. A key from an existing provider can ride `api_key`
/// the same way — the daemon never learns where it came from.
pub fn endpoint_add(
    name: &str,
    base_url: &str,
    model_id: &str,
    api_key: &str,
    max_tokens: Option<u64>,
) -> Result<protocol::RagEndpointWire, String> {
    if name.trim().is_empty() {
        return Err("name is required".into());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("base URL must start with http:// or https://".into());
    }
    if model_id.trim().is_empty() {
        return Err("model id is required".into());
    }
    if api_key.is_empty() {
        return Err("API key is required".into());
    }
    let probe = rag::RemoteEmbedder::custom(
        "probe",
        base_url,
        model_id,
        api_key,
        0, // unknown — force the probe
        max_tokens.unwrap_or(8191) as usize,
    );
    let dims = probe.ensure_dims()?;
    if dims == 0 {
        return Err("endpoint returned zero-dimensional vectors".into());
    }

    let encrypted = store::secrets::encrypt_stored(api_key).map_err(|e| e.to_string())?;
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    let rag = cfg.rag.get_or_insert_with(store::config::RagSettings::default);
    let id = endpoint_slug(
        name,
        &rag.custom_endpoints.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
    );
    let endpoint = store::config::RagCustomEndpoint {
        id: id.clone(),
        name: name.trim().to_owned(),
        base_url: base_url.trim_end_matches('/').to_owned(),
        model_id: model_id.trim().to_owned(),
        dims,
        max_tokens,
        encrypted_key: Some(encrypted),
        ..Default::default()
    };
    let wire = endpoint_wire(&endpoint);
    rag.custom_endpoints.push(endpoint);
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())?;
    Ok(wire)
}

/// Replace an endpoint's key, re-probing so a dead key can't silently
/// become the plan's embedder.
pub fn endpoint_set_key(endpoint_id: &str, api_key: &str) -> Result<(), String> {
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    let rag = cfg.rag.get_or_insert_with(store::config::RagSettings::default);
    let ep = rag
        .custom_endpoints
        .iter_mut()
        .find(|e| e.id == endpoint_id)
        .ok_or_else(|| format!("unknown endpoint {endpoint_id:?}"))?;
    let probe = rag::RemoteEmbedder::custom(
        "probe",
        &ep.base_url,
        &ep.model_id,
        api_key,
        0,
        ep.max_tokens.unwrap_or(8191) as usize,
    );
    probe.ensure_dims()?;
    ep.encrypted_key = Some(
        store::secrets::encrypt_stored(api_key)
            .map_err(|e| e.to_string())?,
    );
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove an endpoint. Returns the indexes still locked to it (they will
/// read as rebuild-required) before dropping the config entry.
pub fn endpoint_remove(
    endpoint_id: &str,
) -> Result<Vec<protocol::RagAffectedWorkspaceWire>, String> {
    let _guard = crate::TIDE_CONFIG_LOCK.lock().unwrap();
    let mut cfg = store::config::load(&config_path()).map_err(|e| e.to_string())?;
    let affected = affected_workspaces_by_id(endpoint_id);
    if let Some(rag) = cfg.rag.as_mut() {
        rag.custom_endpoints.retain(|e| e.id != endpoint_id);
        if rag.embedder_id.as_deref() == Some(endpoint_id) {
            rag.embedder_id = Some("local-code-512".to_owned());
        }
    }
    store::config::save(&config_path(), &cfg).map_err(|e| e.to_string())?;
    Ok(affected)
}

/// Affected computation for one embedder id (deletes/removals).
fn affected_workspaces_by_id(
    embedder_id: &str,
) -> Vec<protocol::RagAffectedWorkspaceWire> {
    let dir = data_dir();
    let mut out = Vec::new();
    for project_id in enabled_project_ids() {
        let path = rag_db_path(&dir, &project_id);
        if path.is_file()
            && let Ok(store) = RagStore::open_at(&path)
            && store.plan().embedder_id == embedder_id
        {
            out.push(protocol::RagAffectedWorkspaceWire {
                project_id,
                built_with: embedder_id.to_owned(),
            });
        }
    }
    if knowledge_db_path(&dir).is_file()
        && let Ok(ks) = KnowledgeStore::open_at(&knowledge_db_path(&dir))
        && ks.rag.plan().embedder_id == embedder_id
    {
        out.push(protocol::RagAffectedWorkspaceWire {
            project_id: "*".to_owned(),
            built_with: embedder_id.to_owned(),
        });
    }
    out
}

/// Warm the configured embedder at boot so the first memory query
/// doesn't pay cold-model load. Fire-and-forget; failures log only
/// (the first query retries naturally).
pub fn prewarm() {
    let dir = data_dir();
    let spawned = std::thread::Builder::new()
        .name("tide-rag-prewarm".to_owned())
        .spawn(move || {
            let cfg = store::config::load(&config_path()).ok();
            let any_enabled = cfg
                .as_ref()
                .and_then(|c| c.rag_enabled_workspaces.as_deref())
                .is_some_and(|ids| !ids.is_empty());
            if !any_enabled && !knowledge_db_path(&dir).is_file() {
                return;
            }
            let cfg_in = rag_config_at(&config_path());
            let Ok((_, embedder)) = resolve_embedder_for_build(&cfg_in, &dir) else {
                return;
            };
            if let Err(e) = embedder.embed_use(&["prewarm".to_owned()], EmbedUse::Query) {
                eprintln!("[tide-rag] prewarm skipped: {e}");
            }
        });
    if spawned.is_err() {
        eprintln!("[tide-rag] could not spawn the prewarm thread");
    }
}

/// Enable RAG for a project: persist into `rag_enabled_workspaces` (config
/// write under the crate's config lock) and make sure the model download
/// is on its way.
pub fn enable_project(project_id: &str) -> Result<(), String> {
    ensure_configured_model_downloaded();
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
                let cfg = effective_rag_config();
                let eff = effective_settings_at(&config_path());
                let (_, embedder) = resolve_embedder_for_build(&cfg, &dir)?;
                let plan = intended_plan(embedder.as_ref(), &eff)?;
                ingest_workspace(
                    WorkspaceIngestInputs {
                        workspace_id: &id,
                        path: &path,
                        worktree_location: None,
                        data_dir: &dir,
                    },
                    embedder.as_ref(),
                    &plan,
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
/// first index, and return the wire row. `project_id` scopes the source to
/// one project's memory; `None` keeps it global.
pub fn add_source(
    name: &str,
    kind: &str,
    location: &str,
    project_id: Option<&str>,
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
        .add_source(
            &name,
            kind,
            location.trim(),
            Some(&[project_id
                .map(str::to_owned)
                .unwrap_or_else(|| "*".to_owned())]),
        )
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
        let (_, embedder) = resolve_embedder_for_build(&effective_rag_config(), &dir)?;
        // Measure remote dims up front so the plan check in
        // ingest_documents compares reality, not the pre-probe default.
        embedder.ensure_dims()?;
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
    let (_, embedder) = resolve_embedder_for_build(&effective_rag_config(), &dir)?;
    embedder.ensure_dims()?;
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

    #[test]
    fn rag_config_at_hydrates_and_decrypts_custom_endpoints() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_path = tmp.path().join("config.json");
        let encrypted = store::secrets::encrypt_stored("sk-real-key").unwrap();
        let mut cfg = store::config::Config::default();
        cfg.rag = Some(store::config::RagSettings {
            embedder_id: Some("custom-x".into()),
            cloud_allowed: Some(true),
            cloud_model_id: Some("text-embedding-3-small".into()),
            custom_endpoints: vec![store::config::RagCustomEndpoint {
                id: "custom-x".into(),
                name: "OpenAI".into(),
                base_url: "https://api.openai.com/v1".into(),
                model_id: "text-embedding-3-small".into(),
                dims: 1536,
                max_tokens: Some(8191),
                encrypted_key: Some(encrypted),
                ..Default::default()
            }],
            ..Default::default()
        });
        store::config::save(&cfg_path, &cfg).unwrap();

        let input = super::rag_config_at(&cfg_path);
        assert_eq!(input.embedder_id, "custom-x");
        assert!(input.cloud_allowed);
        assert_eq!(input.cloud_model_id.as_deref(), Some("text-embedding-3-small"));
        assert_eq!(input.custom_endpoints.len(), 1);
        assert_eq!(input.custom_endpoints[0].api_key, "sk-real-key");
        assert_eq!(input.custom_endpoints[0].dims, 1536);
        assert_eq!(input.custom_endpoints[0].max_tokens, 8191);
    }

    #[test]
    fn rag_config_at_defaults_when_block_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_path = tmp.path().join("config.json");
        store::config::save(&cfg_path, &store::config::Config::default()).unwrap();
        let input = super::rag_config_at(&cfg_path);
        assert_eq!(input.embedder_id, "local-code-512");
        assert!(!input.cloud_allowed);
        assert!(input.custom_endpoints.is_empty());
    }

    #[test]
    fn plan_stale_tracks_the_configured_model_and_chunking() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_path = tmp.path().join("config.json");
        store::config::save(&cfg_path, &store::config::Config::default()).unwrap();
        let data = tmp.path().join("data");

        // No index yet → nothing to be stale.
        assert!(!super::plan_stale_at(&cfg_path, &data, "p1"));

        // Index under a different model (same dims — the id must catch it).
        let plan = rag::EmbeddingPlan {
            embedder_id: "local-mle5-small".into(),
            dims: 384,
            chunk_size: None,
            chunk_overlap: None,
            created_at: 0,
        };
        rag::RagStore::open_at_with_plan(&rag::rag_db_path(&data, "p1"), &plan).unwrap();
        assert!(super::plan_stale_at(&cfg_path, &data, "p1"));

        // Matching index → fresh.
        let plan = rag::EmbeddingPlan {
            embedder_id: "local-code-512".into(),
            dims: 384,
            chunk_size: None,
            chunk_overlap: None,
            created_at: 0,
        };
        rag::RagStore::open_at_with_plan(&rag::rag_db_path(&data, "p2"), &plan).unwrap();
        assert!(!super::plan_stale_at(&cfg_path, &data, "p2"));

        // A chunking change in config makes the matching index stale.
        let mut cfg = store::config::load(&cfg_path).unwrap();
        cfg.rag = Some(store::config::RagSettings {
            chunk_size: Some(800),
            ..Default::default()
        });
        store::config::save(&cfg_path, &cfg).unwrap();
        assert!(super::plan_stale_at(&cfg_path, &data, "p2"));
    }

    #[test]
    fn merge_rag_patch_validates_and_merges() {
        let mut rag = store::config::RagSettings::default();
        super::merge_rag_patch(
            &mut rag,
            &protocol::RagConfigPatchWire {
                embedder_id: Some("local-bge-m3".into()),
                cloud_allowed: Some(true),
                top_k: Some(8),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rag.embedder_id.as_deref(), Some("local-bge-m3"));
        assert!(rag.cloud_allowed.unwrap());
        assert_eq!(rag.top_k, Some(8));

        // Unknown embedder ids are refused outright.
        let err = super::merge_rag_patch(
            &mut store::config::RagSettings::default(),
            &protocol::RagConfigPatchWire {
                embedder_id: Some("custom-missing".into()),
                ..Default::default()
            },
        )
        .err()
        .unwrap();
        assert!(err.contains("unknown embedder"), "was {err}");

        // Out-of-range values are refused.
        for bad in [
            protocol::RagConfigPatchWire { top_k: Some(0), ..Default::default() },
            protocol::RagConfigPatchWire { min_similarity: Some(2.0), ..Default::default() },
            protocol::RagConfigPatchWire { chunk_size: Some(8), ..Default::default() },
            protocol::RagConfigPatchWire { chunk_overlap: Some(9000), ..Default::default() },
        ] {
            assert!(super::merge_rag_patch(&mut store::config::RagSettings::default(), &bad).is_err());
        }

        // Empty string clears cloud_model_id; absent keeps it.
        let mut rag = store::config::RagSettings {
            cloud_model_id: Some("text-embedding-3-small".into()),
            ..Default::default()
        };
        super::merge_rag_patch(
            &mut rag,
            &protocol::RagConfigPatchWire {
                cloud_model_id: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rag.cloud_model_id, None);
    }

    #[test]
    fn affected_workspaces_flags_mismatched_plans() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().to_path_buf();
        let mk_plan = |id: &str| rag::EmbeddingPlan {
            embedder_id: id.into(),
            dims: 384,
            chunk_size: None,
            chunk_overlap: None,
            created_at: 0,
        };
        // p1 matches the default; p2 was built with e5 (same dims); p3
        // matches but with chunking; knowledge pinned to e5.
        rag::RagStore::open_at_with_plan(&rag::rag_db_path(&data, "p1"), &mk_plan("local-code-512")).unwrap();
        rag::RagStore::open_at_with_plan(&rag::rag_db_path(&data, "p2"), &mk_plan("local-mle5-small")).unwrap();
        rag::RagStore::open_at_with_plan(
            &rag::rag_db_path(&data, "p3"),
            &rag::EmbeddingPlan { chunk_size: Some(800), ..mk_plan("local-code-512") },
        )
        .unwrap();
        // Pin the knowledge index to e5 by creating its db under that plan
        // (KnowledgeStore::open_at then adopts the recorded plan).
        rag::RagStore::open_at_with_plan(
            &rag::knowledge_db_path(&data),
            &mk_plan("local-mle5-small"),
        )
        .unwrap();

        let affected = super::affected_workspaces_for(
            data.clone(),
            &["p1".to_owned(), "p2".to_owned(), "p3".to_owned()],
            "local-code-512",
            None,
            None,
        );
        let ids: Vec<&str> = affected.iter().map(|a| a.project_id.as_str()).collect();
        assert!(ids.contains(&"p2"), "was {ids:?}");
        assert!(ids.contains(&"p3"), "was {ids:?}");
        assert!(ids.contains(&"*"), "knowledge should count, was {ids:?}");
        assert!(!ids.contains(&"p1"), "was {ids:?}");
        let p2 = affected.iter().find(|a| a.project_id == "p2").unwrap();
        assert_eq!(p2.built_with, "local-mle5-small");
    }

    #[test]
    fn endpoint_slugs_are_stable_and_unique() {
        let taken: Vec<String> = vec!["custom-openai".into()];
        assert_eq!(super::endpoint_slug("OpenAI", &taken), "custom-openai-2");
        assert_eq!(super::endpoint_slug("Ollama (local)", &[]), "custom-ollama-local");
        assert_eq!(super::endpoint_slug("---", &[]), "custom-endpoint");
    }
}
