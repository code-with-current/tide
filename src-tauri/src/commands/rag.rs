//! RAG commands (M4 T7) — port of `app/rpc/rag.ts` @ 91ec558: status /
//! download / enable / disable / init for the Memory & RAG panel. The two
//! Electron progress channels ride one `ragProgress` message discriminated
//! by `kind`; `ragInitWorkspace` keeps the job pattern — `{ok, startedAt}`
//! returns immediately, ingest runs detached, `running_inits` guards
//! re-entry, and progress/failed events arrive via the push bus.
//!
//! The module also owns the memory tool's index seam
//! ([`RagMemoryIndex`]): the TS `runMemory` semantics over the workspace
//! index + global knowledge sources, exposed through
//! `tide_tools::set_shared_memory_index`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tide_rag::store::rag_db_path;
use tide_rag::{
    cloud_configured, knowledge_db_path, local_model_exists, resolve_embedder_for_build,
    resolve_embedder_for_query, ChunkRow, RagConfigInput,
};
use tide_tools::{rrf_fuse, MemoryHit, MemoryIndex};
use tokio::sync::broadcast;

use crate::agent::events::{
    ChatPush, RagDownloadProgressEvent, RagInitProgressEvent, RagProgressMessage,
};
use crate::agent::hub::ChatHubCell;
use crate::state::AppState;

use super::workspaces::hydrate_rag_config;
use super::CommandError;

/// `RagWorkspaceOpResult` — `{ok: true} | {ok: false, error}` via options.
#[derive(Debug, Serialize, PartialEq)]
pub struct RagOpResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `RagInitResult` — `{ok: true, startedAt} | {ok: false, error}`.
#[derive(Debug, Serialize, PartialEq)]
pub struct RagInitResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The per-workspace hydrated config slice the status reader needs.
#[derive(Debug, Clone)]
struct HydratedRagConfig {
    embedder_id: String,
    cloud_allowed: bool,
    chunk_tokens: u64,
}

impl HydratedRagConfig {
    fn from_workspace_extra(ws: &tide_store::config::Workspace) -> Self {
        let mut wire = serde_json::to_value(ws).unwrap_or_else(|_| json!({}));
        hydrate_rag_config(&mut wire);
        let rag = &wire["ragConfig"];
        Self {
            embedder_id: rag["embedderId"]
                .as_str()
                .unwrap_or("local-code-512")
                .to_string(),
            cloud_allowed: rag["cloudAllowed"].as_bool().unwrap_or(false),
            chunk_tokens: rag["chunkTokens"].as_u64().unwrap_or(384),
        }
    }

    fn defaults() -> Self {
        Self {
            embedder_id: "local-code-512".to_string(),
            cloud_allowed: false,
            chunk_tokens: 384,
        }
    }
}

/// In-flight init guard (TS `runningInits`).
fn running_inits() -> &'static StdMutex<HashSet<String>> {
    static RUNNING: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Read chunkCount + lastIngestedAt off a workspace index db (TS
/// readIngestState — readonly, missing dbs read as zeros).
fn read_ingest_state(data_dir: &std::path::Path, workspace_id: &str) -> (u64, Option<i64>) {
    let db_path = rag_db_path(data_dir, workspace_id);
    if !db_path.is_file() {
        return (0, None);
    }
    let Ok(store) = tide_rag::RagStore::open_at(&db_path) else {
        return (0, None);
    };
    let count = store.chunk_count().unwrap_or(0).max(0) as u64;
    let last = store
        .get_meta("lastIngestedAt")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    (count, last)
}

/// `ragStatus` — the read-only panel snapshot. Errors surface as the TS
/// `{error}` union member, never a rejection.
#[tauri::command]
pub fn rag_status(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Value, CommandError> {
    let data_dir = state.data_dir().to_path_buf();
    let result: Result<Result<Value, String>, CommandError> = state.read_config(|cfg| {
        let enabled: Vec<String> = cfg.rag_enabled_workspaces.clone().unwrap_or_default();
        let ws = cfg.workspaces.iter().find(|w| w.id == workspace_id);
        let Some(ws) = ws else {
            return Ok(json!({
                "embedderId": null,
                "dim": 384,
                "enabledWorkspaces": enabled,
                "cloudAllowed": false,
                "chunkTokens": 384,
                "localAvailable": local_model_exists(&data_dir),
                "cloudConfigured": cloud_configured(),
                "chunkCount": 0,
                "initState": "never",
                "lastIngestedAt": null,
                "state": "no-index",
            }));
        };
        let rag_config = HydratedRagConfig::from_workspace_extra(ws);
        let local_available = local_model_exists(&data_dir);
        let cloud_is_configured = cloud_configured();
        let state_str = if rag_config.embedder_id == "cloud-base" {
            "cloud-fallback"
        } else if local_available {
            "ok"
        } else if rag_config.cloud_allowed && cloud_is_configured {
            "cloud-fallback"
        } else {
            "unavailable"
        };
        let (chunk_count, last_ingested_at) = read_ingest_state(&data_dir, &workspace_id);
        let is_running = running_inits()
            .lock()
            .expect("running inits poisoned")
            .contains(&workspace_id);
        let init_state = if is_running {
            "running"
        } else if last_ingested_at.is_some() {
            "done"
        } else {
            "never"
        };
        Ok(json!({
            "embedderId": rag_config.embedder_id,
            "dim": 384,
            "enabledWorkspaces": enabled,
            "cloudAllowed": rag_config.cloud_allowed,
            "chunkTokens": rag_config.chunk_tokens,
            "localAvailable": local_available,
            "cloudConfigured": cloud_is_configured,
            "chunkCount": chunk_count,
            "initState": init_state,
            "lastIngestedAt": last_ingested_at,
            "state": state_str,
        }))
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Ok(json!({ "error": e })),
        Err(e) => Ok(json!({ "error": e.message })),
    }
}

/// `ragModelExists` — the download-gated availability probe.
#[tauri::command]
pub fn rag_model_exists(state: tauri::State<'_, AppState>) -> Result<bool, CommandError> {
    Ok(local_model_exists(state.data_dir()))
}

/// Push one ragProgress message down the bus.
fn emit_rag_progress(bus: &broadcast::Sender<ChatPush>, message: RagProgressMessage) {
    let _ = bus.send(ChatPush::RagProgress { message });
}

/// The detached model download (TS downloadRagModel): progress events per
/// chunk, a final `done`/`failed` event, `{ok}` (or `{ok, error}`) result.
async fn download_rag_model(
    data_dir: PathBuf,
    bus: broadcast::Sender<ChatPush>,
) -> RagOpResultWire {
    if local_model_exists(&data_dir) {
        return RagOpResultWire {
            ok: true,
            error: None,
        };
    }
    let task_bus = bus.clone();
    let download = tokio::task::spawn_blocking(move || {
        tide_rag::download_model(&data_dir, |p| {
            emit_rag_progress(
                &task_bus,
                RagProgressMessage::Download {
                    event: RagDownloadProgressEvent {
                        received: p.received,
                        total: p.total,
                        phase: "downloading".into(),
                        error: None,
                    },
                },
            );
        })
    })
    .await
    .unwrap_or_else(|e| Err(format!("download task panicked: {e}")));
    match download {
        Ok(_) => {
            emit_rag_progress(
                &bus,
                RagProgressMessage::Download {
                    event: RagDownloadProgressEvent {
                        received: 0,
                        total: 0,
                        phase: "done".into(),
                        error: None,
                    },
                },
            );
            RagOpResultWire {
                ok: true,
                error: None,
            }
        }
        Err(error) => {
            emit_rag_progress(
                &bus,
                RagProgressMessage::Download {
                    event: RagDownloadProgressEvent {
                        received: 0,
                        total: 0,
                        phase: "failed".into(),
                        error: Some(error.clone()),
                    },
                },
            );
            RagOpResultWire {
                ok: false,
                error: Some(error),
            }
        }
    }
}

/// `ragDownloadModel`.
#[tauri::command]
pub async fn rag_download_model(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
) -> Result<RagOpResultWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    Ok(download_rag_model(state.data_dir().to_path_buf(), hub.push_bus().clone()).await)
}

/// `ragEnableWorkspace` — download first (if missing), then flip the
/// config flag.
#[tauri::command]
pub async fn rag_enable_workspace(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
) -> Result<RagOpResultWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    let download = download_rag_model(state.data_dir().to_path_buf(), hub.push_bus().clone()).await;
    if !download.ok {
        return Ok(download);
    }
    state.update_config(|cfg| {
        let list = cfg.rag_enabled_workspaces.get_or_insert_with(Vec::new);
        if !list.contains(&workspace_id) {
            list.push(workspace_id.clone());
        }
        Ok(())
    })?;
    Ok(RagOpResultWire {
        ok: true,
        error: None,
    })
}

/// `ragDisableWorkspace`.
#[tauri::command]
pub fn rag_disable_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<RagOpResultWire, CommandError> {
    state.update_config(|cfg| {
        if let Some(list) = cfg.rag_enabled_workspaces.as_mut() {
            list.retain(|id| id != &workspace_id);
        }
        Ok(())
    })?;
    Ok(RagOpResultWire {
        ok: true,
        error: None,
    })
}

/// `ragInitWorkspace` — `{ok, startedAt}` now, ingest detached; progress
/// (and any failure) arrives as ragProgress init events.
#[tauri::command]
pub async fn rag_init_workspace(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
) -> Result<RagInitResultWire, CommandError> {
    {
        let mut running = running_inits().lock().expect("running inits poisoned");
        if running.contains(&workspace_id) {
            return Ok(RagInitResultWire {
                ok: false,
                started_at: None,
                error: Some("init already running for this workspace".into()),
            });
        }
        running.insert(workspace_id.clone());
    }

    let data_dir = state.data_dir().to_path_buf();
    let hub = hub_cell
        .get(&data_dir)
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    let bus = hub.push_bus().clone();
    let ws = state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .map(|w| {
                (
                    w.path.clone(),
                    w.extra
                        .get("worktreeLocation")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    HydratedRagConfig::from_workspace_extra(w),
                )
            })
    })?;
    let Some((ws_path, worktree_location, rag_config)) = ws else {
        running_inits()
            .lock()
            .expect("running inits poisoned")
            .remove(&workspace_id);
        return Ok(RagInitResultWire {
            ok: false,
            started_at: None,
            error: Some(format!("ingest: workspace {workspace_id} not found")),
        });
    };
    let started_at = tide_rag::unix_ms_now();

    let init_workspace_id = workspace_id.clone();
    tokio::task::spawn_blocking(move || {
        let progress = |event: tide_rag::IngestProgressEvent| {
            let _ = bus.send(ChatPush::RagProgress {
                message: RagProgressMessage::Init {
                    event: RagInitProgressEvent {
                        workspace_id: init_workspace_id.clone(),
                        phase: event.phase,
                        files_seen: event.files_seen,
                        chunks_total: event.chunks_total,
                        chunks_embedded: event.chunks_embedded,
                        current_file: event.current_file,
                        error: event.error,
                    },
                },
            });
        };
        let run = (|| {
            let (_, embedder) = resolve_embedder_for_build(
                &RagConfigInput {
                    embedder_id: rag_config.embedder_id.clone(),
                    cloud_allowed: rag_config.cloud_allowed,
                },
                &data_dir,
            )?;
            tide_rag::ingest_workspace(
                tide_rag::WorkspaceIngestInputs {
                    workspace_id: &init_workspace_id,
                    path: std::path::Path::new(&ws_path),
                    worktree_location: worktree_location.as_deref(),
                    data_dir: &data_dir,
                },
                embedder.as_ref(),
                progress,
            )
        })();
        if let Err(error) = run {
            let _ = bus.send(ChatPush::RagProgress {
                message: RagProgressMessage::Init {
                    event: RagInitProgressEvent {
                        workspace_id: init_workspace_id.clone(),
                        phase: "failed".into(),
                        files_seen: 0,
                        chunks_total: 0,
                        chunks_embedded: 0,
                        current_file: None,
                        error: Some(error),
                    },
                },
            });
        }
        running_inits()
            .lock()
            .expect("running inits poisoned")
            .remove(&init_workspace_id);
    });

    Ok(RagInitResultWire {
        ok: true,
        started_at: Some(started_at),
        error: None,
    })
}

// ── memory tool index seam ─────────────────────────────────────────────────

/// The memory tool's backend — the TS `runMemory` search semantics over
/// the per-workspace index plus the global knowledge-sources index
/// (filtered to sources enabled for the workspace, over-fetch ×3 then
/// post-filter, first-embedder-wins pinning honored). One process-wide
/// instance; each query resolves the embedder against the workspace's
/// hydrated ragConfig (defaults when the workspace has none).
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
        tide_tools::set_shared_memory_index(Some(Arc::new(self)));
    }

    /// (workspace found, enabled, hydrated config) for a workspace id.
    fn workspace_context(&self, workspace_id: &str) -> (bool, bool, HydratedRagConfig) {
        let Ok(cfg) = tide_store::config::load(&self.config_path) else {
            return (false, false, HydratedRagConfig::defaults());
        };
        let enabled = cfg
            .rag_enabled_workspaces
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|id| id == workspace_id);
        match cfg.workspaces.iter().find(|w| w.id == workspace_id) {
            Some(ws) => (true, enabled, HydratedRagConfig::from_workspace_extra(ws)),
            None => (false, enabled, HydratedRagConfig::defaults()),
        }
    }

    /// Embed the query with the query-time-resolved embedder. `None` when
    /// resolution fails (unusable index — the TS surfaced this fatally;
    /// the seam degrades to empty rankings).
    fn embed_query(&self, rag_config: &HydratedRagConfig, query: &str) -> Option<Vec<f32>> {
        let (_, embedder) = resolve_embedder_for_query(
            &RagConfigInput {
                embedder_id: rag_config.embedder_id.clone(),
                cloud_allowed: rag_config.cloud_allowed,
            },
            &self.data_dir,
        )
        .ok()?;
        embedder.embed(&[query.to_owned()]).ok()?.into_iter().next()
    }

    /// Open the knowledge store when its db exists (an existsSync guard in
    /// TS kept queries from creating an empty db as a side effect).
    fn knowledge(&self) -> Option<tide_rag::KnowledgeStore> {
        let path = knowledge_db_path(&self.data_dir);
        if !path.is_file() {
            return None;
        }
        tide_rag::KnowledgeStore::open_at(&path).ok()
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
    fn total_chunks(&self, workspace_id: &str) -> u64 {
        let (found, enabled, _) = self.workspace_context(workspace_id);
        let _ = found;
        let mut total = 0u64;
        if enabled {
            let path = rag_db_path(&self.data_dir, workspace_id);
            if path.is_file() {
                if let Ok(store) = tide_rag::RagStore::open_at(&path) {
                    total += store.chunk_count().unwrap_or(0).max(0) as u64;
                }
            }
        }
        if let Some(ks) = self.knowledge() {
            let enabled_ids: HashSet<String> = ks
                .enabled_source_ids_for(workspace_id)
                .into_iter()
                .collect();
            for source in ks.list_sources().unwrap_or_default() {
                if enabled_ids.contains(&source.id) {
                    total += source.chunk_count.max(0) as u64;
                }
            }
        }
        total
    }

    fn vector_hits(&self, workspace_id: &str, query: &str, k: usize) -> Vec<MemoryHit> {
        let (_, enabled, rag_config) = self.workspace_context(workspace_id);
        let mut ws_hits = Vec::new();
        if enabled {
            if let Some(vec) = self.embed_query(&rag_config, query) {
                let path = rag_db_path(&self.data_dir, workspace_id);
                if path.is_file() {
                    if let Ok(store) = tide_rag::RagStore::open_at(&path) {
                        ws_hits = store
                            .query_by_vector(&vec, k)
                            .unwrap_or_default()
                            .iter()
                            .map(|h| hit_from_row(&h.row, Some(h.similarity), None))
                            .collect();
                    }
                }
            }
        }
        let knowledge = self.knowledge_hits(workspace_id, query, k, &rag_config, Mode::Vector);
        rrf_fuse(ws_hits, knowledge, k)
    }

    fn fts_hits(&self, workspace_id: &str, query: &str, k: usize) -> Vec<MemoryHit> {
        let (_, enabled, rag_config) = self.workspace_context(workspace_id);
        let mut ws_hits = Vec::new();
        if enabled {
            let path = rag_db_path(&self.data_dir, workspace_id);
            if path.is_file() {
                if let Ok(store) = tide_rag::RagStore::open_at(&path) {
                    ws_hits = store
                        .query_by_fts(query, k)
                        .unwrap_or_default()
                        .iter()
                        .map(|h| hit_from_row(&h.row, None, None))
                        .collect();
                }
            }
        }
        let knowledge = self.knowledge_hits(workspace_id, query, k, &rag_config, Mode::Fts);
        rrf_fuse(ws_hits, knowledge, k)
    }
}

enum Mode {
    Vector,
    Fts,
}

impl RagMemoryIndex {
    /// The knowledge half: over-fetch ×3, filter to sources enabled for
    /// this workspace, decorate with the source's display name. Any
    /// failure degrades to "no knowledge results".
    fn knowledge_hits(
        &self,
        workspace_id: &str,
        query: &str,
        k: usize,
        rag_config: &HydratedRagConfig,
        mode: Mode,
    ) -> Vec<MemoryHit> {
        let Some(ks) = self.knowledge() else {
            return vec![];
        };
        let Ok(sources) = ks.list_sources() else {
            return vec![];
        };
        let enabled_ids: HashSet<String> = ks
            .enabled_source_ids_for(workspace_id)
            .into_iter()
            .collect();
        let names: std::collections::HashMap<String, String> = sources
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
        // First-embedder-wins pinning: silently skip on mismatch.
        if let Some(pinned) = ks.rag.get_meta("embedderId").ok().flatten() {
            let resolved = resolve_embedder_for_query(
                &RagConfigInput {
                    embedder_id: rag_config.embedder_id.clone(),
                    cloud_allowed: rag_config.cloud_allowed,
                },
                &self.data_dir,
            )
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
                let Some(vec) = self.embed_query(rag_config, query) else {
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

/// Install the process-wide memory index once the app state exists (boot).
pub fn install_memory_index(data_dir: &std::path::Path) {
    RagMemoryIndex::new(data_dir.to_path_buf(), data_dir.join("config.json")).install_shared();
}

/// Test helper — a real store backed by a temp dir with deterministic
/// embeddings from the vendored model (no network).
#[cfg(test)]
pub(crate) fn test_ingest_workspace(
    data_dir: &std::path::Path,
    workspace_id: &str,
    root: &std::path::Path,
) -> Result<tide_rag::IngestResult, String> {
    let (_, embedder) = resolve_embedder_for_build(
        &RagConfigInput {
            embedder_id: "local-code-512".into(),
            cloud_allowed: false,
        },
        data_dir,
    )?;
    tide_rag::ingest_workspace(
        tide_rag::WorkspaceIngestInputs {
            workspace_id,
            path: root,
            worktree_location: None,
            data_dir,
        },
        embedder.as_ref(),
        |_| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-rag-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_config(dir: &std::path::Path, body: &str) {
        fs::write(dir.join("config.json"), body).unwrap();
    }

    #[test]
    fn status_for_unknown_workspace_is_the_empty_shape() {
        let dir = temp_dir("unknown");
        write_config(&dir, "{}");
        let state = AppState::load(dir.clone());
        let raw = status_via_state(&state, "ws_missing");
        assert_eq!(raw["state"], json!("no-index"));
        assert_eq!(raw["embedderId"], json!(null));
        assert_eq!(raw["dim"], json!(384));
        assert_eq!(raw["initState"], json!("never"));
        fs::remove_dir_all(&dir).unwrap();
    }

    fn status_via_state(state: &AppState, workspace_id: &str) -> Value {
        let dir = state.data_dir().to_path_buf();
        let cfg = tide_store::config::load(&dir.join("config.json")).unwrap_or_default();
        let enabled = cfg.rag_enabled_workspaces.clone().unwrap_or_default();
        let ws = cfg.workspaces.iter().find(|w| w.id == workspace_id);
        // Mirror rag_status without the tauri::State wrapper.
        let Some(ws) = ws else {
            return json!({
                "embedderId": null, "dim": 384, "enabledWorkspaces": enabled,
                "cloudAllowed": false, "chunkTokens": 384,
                "localAvailable": local_model_exists(&dir), "cloudConfigured": cloud_configured(),
                "chunkCount": 0, "initState": "never", "lastIngestedAt": null, "state": "no-index",
            });
        };
        let rag_config = HydratedRagConfig::from_workspace_extra(ws);
        let local_available = local_model_exists(&dir);
        let state_str = if rag_config.embedder_id == "cloud-base" {
            "cloud-fallback"
        } else if local_available {
            "ok"
        } else if rag_config.cloud_allowed && cloud_configured() {
            "cloud-fallback"
        } else {
            "unavailable"
        };
        let (chunk_count, last) = read_ingest_state(&dir, workspace_id);
        json!({
            "embedderId": rag_config.embedder_id, "dim": 384, "enabledWorkspaces": enabled,
            "cloudAllowed": rag_config.cloud_allowed, "chunkTokens": rag_config.chunk_tokens,
            "localAvailable": local_available, "cloudConfigured": cloud_configured(),
            "chunkCount": chunk_count,
            "initState": if last.is_some() { "done" } else { "never" },
            "lastIngestedAt": last, "state": state_str,
        })
    }

    #[test]
    fn status_state_depends_on_model_and_cloud() {
        let dir = temp_dir("state");
        let ws_path = dir.join("repo");
        fs::create_dir_all(&ws_path).unwrap();
        write_config(
            &dir,
            &json!({
                "workspaces": [{ "id": "ws_1", "name": "r", "path": ws_path.to_string_lossy() }],
                "ragEnabledWorkspaces": ["ws_1"]
            })
            .to_string(),
        );
        let state = AppState::load(dir.clone());
        let raw = status_via_state(&state, "ws_1");
        // No downloaded model + cloud not allowed → unavailable (the
        // vendored in-binary model does NOT flip this — the download is
        // the gate, matching the TS shells).
        assert_eq!(raw["state"], json!("unavailable"));
        assert_eq!(raw["embedderId"], json!("local-code-512"));
        assert_eq!(raw["enabledWorkspaces"], json!(["ws_1"]));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn init_state_reads_the_index_meta() {
        let dir = temp_dir("meta");
        let store = tide_rag::RagStore::open_at(&rag_db_path(&dir, "ws_1")).unwrap();
        store.set_meta("lastIngestedAt", "1724000000000").unwrap();
        drop(store);
        let (count, last) = read_ingest_state(&dir, "ws_1");
        assert_eq!(count, 0);
        assert_eq!(last, Some(1724000000000));
        // Missing db → zeros.
        let (count, last) = read_ingest_state(&dir, "ws_2");
        assert_eq!((count, last), (0, None));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Full round-trip with the real vendored model: ingest a fixture
    /// workspace, then the memory seam finds it by meaning AND by keyword,
    /// fusing workspace + knowledge halves. `#[ignore]`ed (ONNX init is
    /// slow) but part of the committed verification suite.
    #[test]
    #[ignore]
    fn memory_index_round_trip_with_the_real_model() {
        // TIDE_MODELS_DIR is the TS availability knob: point it at the
        // crate-vendored model so the download gate reads "available" and
        // the embedder loads the same on-disk file.
        std::env::set_var(
            "TIDE_MODELS_DIR",
            concat!(env!("CARGO_MANIFEST_DIR"), "/crates/tide-rag/models"),
        );
        let dir = temp_dir("roundtrip");
        let repo = dir.join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(
            repo.join("src/auth.ts"),
            "export function authenticateUser(token: string): boolean {\n  return token.length > 0;\n}\n",
        )
        .unwrap();
        fs::write(
            repo.join("src/db.ts"),
            "export function connectPool(url: string) {\n  return url;\n}\n",
        )
        .unwrap();

        // Workspace config + enablement.
        write_config(
            &dir,
            &json!({
                "workspaces": [{ "id": "ws_1", "name": "r", "path": repo.to_string_lossy() }],
                "ragEnabledWorkspaces": ["ws_1"]
            })
            .to_string(),
        );

        let result = test_ingest_workspace(&dir, "ws_1", &repo).unwrap();
        assert!(result.files_seen >= 2, "files seen: {}", result.files_seen);
        assert!(result.chunks_total >= 2);
        assert_eq!(result.chunks_embedded, result.chunks_total);

        // Knowledge half: a docs source with one markdown page.
        let docs = dir.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(
            docs.join("auth-guide.md"),
            "# Authentication guide\n\nTokens are validated by the authenticateUser function.\n",
        )
        .unwrap();
        let ks = tide_rag::KnowledgeStore::open_at(&knowledge_db_path(&dir)).unwrap();
        let source = ks
            .add_source("Auth Guide", "docs", &docs.to_string_lossy(), None)
            .unwrap();
        let (_, embedder) = resolve_embedder_for_build(
            &RagConfigInput {
                embedder_id: "local-code-512".into(),
                cloud_allowed: false,
            },
            &dir,
        )
        .unwrap();
        let chunks = tide_rag::ingest_documents(
            &ks,
            embedder.as_ref(),
            &source.id,
            &tide_rag::fetch_docs(&docs.to_string_lossy(), std::slice::from_ref(&dir)).unwrap(),
            |_| {},
        )
        .unwrap();
        assert!(chunks > 0);
        // The manager stamps the row's chunk count — mirror it.
        ks.set_chunk_count(&source.id, chunks as i64);
        drop(ks);

        let index = RagMemoryIndex::new(&dir, dir.join("config.json"));
        assert!(
            index.total_chunks("ws_1") >= 3,
            "total was {}",
            index.total_chunks("ws_1")
        );

        let hits = index.vector_hits("ws_1", "how is authentication handled", 5);
        assert!(!hits.is_empty());
        assert!(
            hits.iter().any(|h| h.path.contains("auth")),
            "no auth hit in {:?}",
            hits.iter().map(|h| h.path.clone()).collect::<Vec<_>>()
        );

        let fts = index.fts_hits("ws_1", "authenticateUser", 5);
        assert!(!fts.is_empty());

        // A disabled workspace sees only the knowledge half.
        let (found, enabled, _) = index.workspace_context("ws_other");
        assert!(!found && !enabled);
        assert!(
            index.total_chunks("ws_other") >= 1,
            "knowledge sources stay reachable"
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}
