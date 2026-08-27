//! Knowledge-sources commands (M4 T7) — port of `app/rpc/sources.ts` @
//! 91ec558: registry CRUD, per-workspace enablement, and reindex
//! enqueueing through a serial ingestion manager. The `sourcesProgress`
//! push carries the SourceProgressEvent payload verbatim; crash leftovers
//! stuck in queued/indexing resolve to idle before the UI reads them.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tide_rag::{
    fetch_crawl, fetch_docs, fetch_repo, fetch_url, ingest_documents, RagConfigInput,
    SourceProgressEvent,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::agent::events::ChatPush;
use crate::agent::hub::ChatHubCell;
use crate::state::AppState;

use super::CommandError;

/// `SourcesListResult`.
#[derive(Debug, Serialize)]
pub struct SourcesListResultWire {
    pub sources: Vec<tide_rag::KnowledgeSource>,
    pub enabled_source_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `{ok, id?}` — the add result (TS SourcesAddResult).
#[derive(Debug, Serialize)]
pub struct SourcesAddResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `{ok, error?}` — update/remove/setEnabled/reindex.
#[derive(Debug, Serialize)]
pub struct SourcesOpResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Job {
    source_id: String,
    done: oneshot::Sender<Result<(), String>>,
}

/// Serial ingestion manager: one job at a time on a dedicated thread
/// (fetchers are blocking HTTP/fs), statuses queued → indexing → idle /
/// error, progress broadcast to the push bus. Duplicate enqueues of the
/// same pending source share one job.
struct KnowledgeManager {
    tx: mpsc::UnboundedSender<Job>,
    pending: Arc<StdMutex<HashSet<String>>>,
}

impl KnowledgeManager {
    fn start(data_dir: PathBuf, bus: broadcast::Sender<ChatPush>) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        let pending = Arc::new(StdMutex::new(HashSet::new()));
        let pending_clone = Arc::clone(&pending);
        std::thread::Builder::new()
            .name("tide-knowledge".into())
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    let source_id = job.source_id.clone();
                    run_job(&data_dir, &bus, job);
                    pending_clone
                        .lock()
                        .expect("knowledge pending poisoned")
                        .remove(&source_id);
                }
            })
            .expect("knowledge worker thread spawned");
        Self { tx, pending }
    }

    /// Mark queued and hand the job to the worker; resolves when THIS
    /// source's job finishes. Unknown source → Err (enqueue-time check).
    fn enqueue(
        &self,
        ks: &tide_rag::KnowledgeStore,
        source_id: &str,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        {
            let mut pending = self.pending.lock().expect("knowledge pending poisoned");
            if pending.contains(source_id) {
                // Duplicate enqueue of a pending source: report a completed
                // no-op job (the in-flight one carries the real result).
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(Ok(()));
                return Ok(rx);
            }
            pending.insert(source_id.to_string());
        }
        if ks.get_source(source_id).is_none() {
            self.pending
                .lock()
                .expect("knowledge pending poisoned")
                .remove(source_id);
            return Err(format!("enqueue: unknown knowledge source {source_id}"));
        }
        ks.mark_status(source_id, "queued", None);
        let (done_tx, done_rx) = oneshot::channel();
        if self
            .tx
            .send(Job {
                source_id: source_id.to_string(),
                done: done_tx,
            })
            .is_err()
        {
            self.pending
                .lock()
                .expect("knowledge pending poisoned")
                .remove(source_id);
            return Err("knowledge worker unavailable".to_string());
        }
        Ok(done_rx)
    }
}

fn broadcast_source(bus: &broadcast::Sender<ChatPush>, event: SourceProgressEvent) {
    let _ = bus.send(ChatPush::SourcesProgress { event });
}

fn fetch_documents(
    kind: &str,
    location: &str,
    data_dir: &std::path::Path,
    bus: &broadcast::Sender<ChatPush>,
    source_id: &str,
) -> Result<Vec<tide_rag::SourceDocument>, String> {
    match kind {
        "url" => fetch_url(location),
        "docs" => fetch_docs(location, &[data_dir.to_path_buf()]),
        "crawl" => fetch_crawl(location, None, None, |pages_seen, current| {
            broadcast_source(
                bus,
                SourceProgressEvent {
                    source_id: source_id.to_string(),
                    phase: "fetching".into(),
                    pages_seen: Some(pages_seen),
                    chunks_total: None,
                    chunks_embedded: None,
                    current: Some(current.to_string()),
                    error: None,
                },
            );
        }),
        "repo" => fetch_repo(location),
        other => Err(format!("no fetcher registered for kind '{other}'")),
    }
}

fn run_job(data_dir: &std::path::Path, bus: &broadcast::Sender<ChatPush>, job: Job) {
    let result = (|| -> Result<(), String> {
        let ks = tide_rag::KnowledgeStore::open(data_dir).map_err(|e| e.to_string())?;
        let Some(src) = ks.get_source(&job.source_id) else {
            return Ok(());
        };
        ks.mark_status(&job.source_id, "indexing", None);
        broadcast_source(
            bus,
            SourceProgressEvent {
                source_id: job.source_id.clone(),
                phase: "fetching".into(),
                pages_seen: None,
                chunks_total: None,
                chunks_embedded: None,
                current: Some(src.location.clone()),
                error: None,
            },
        );
        let docs = fetch_documents(&src.kind, &src.location, data_dir, bus, &job.source_id)?;

        if ks.get_source(&job.source_id).is_none() {
            ks.purge_orphans(&job.source_id);
            return Ok(());
        }
        // Lazy embedder at job time — hydrateRagConfig(undefined) defaults,
        // same as workspace ingest with no global rag config.
        let (_, embedder) =
            tide_rag::resolve_embedder_for_build(&RagConfigInput::default(), data_dir)?;
        let chunks = ingest_documents(&ks, embedder.as_ref(), &job.source_id, &docs, |event| {
            broadcast_source(bus, event);
        })?;
        if ks.get_source(&job.source_id).is_none() {
            ks.purge_orphans(&job.source_id);
            return Ok(());
        }
        ks.set_chunk_count(&job.source_id, chunks as i64);
        ks.mark_status(&job.source_id, "idle", None);
        Ok(())
    })();
    if let Err(message) = &result {
        // A removed source has no row left to carry the error.
        if let Ok(ks) = tide_rag::KnowledgeStore::open(data_dir) {
            if ks.get_source(&job.source_id).is_some() {
                ks.mark_status(&job.source_id, "error", Some(message));
                broadcast_source(
                    bus,
                    SourceProgressEvent {
                        source_id: job.source_id.clone(),
                        phase: "failed".into(),
                        pages_seen: None,
                        chunks_total: None,
                        chunks_embedded: None,
                        current: None,
                        error: Some(message.clone()),
                    },
                );
            }
        }
    }
    let _ = job.done.send(result);
}

struct SourcesCell {
    manager: OnceLock<Arc<KnowledgeManager>>,
}

impl SourcesCell {
    pub fn new() -> Self {
        Self {
            manager: OnceLock::new(),
        }
    }

    /// The manager + the knowledge store for this data dir; boot-time
    /// stale-status recovery runs once per process.
    async fn get(
        &self,
        state: &AppState,
        hub_cell: &ChatHubCell,
    ) -> Result<(Arc<KnowledgeManager>, tide_rag::KnowledgeStore), CommandError> {
        let hub = hub_cell
            .get(state.data_dir())
            .await
            .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
        let manager = self.manager.get_or_init(|| {
            Arc::new(KnowledgeManager::start(
                state.data_dir().to_path_buf(),
                hub.push_bus().clone(),
            ))
        });
        let ks = tide_rag::KnowledgeStore::open(state.data_dir()).map_err(|e| {
            CommandError::with_code(format!("knowledge store open failed: {e}"), "DB_OPEN")
        })?;
        // Crash leftovers stuck in queued/indexing resolve to idle before
        // any UI reads them (TS recoverStale in registerSourcesRpc).
        ks.resolve_stale_statuses(&[]);
        Ok((Arc::clone(manager), ks))
    }
}

/// `sourcesList`.
#[tauri::command]
pub async fn sources_list(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    sources: tauri::State<'_, SourcesState>,
    workspace_id: Option<String>,
) -> Result<SourcesListResultWire, CommandError> {
    let (_, ks) = sources.0.get(&state, &hub_cell).await?;
    match ks.list_sources() {
        Ok(sources) => Ok(SourcesListResultWire {
            enabled_source_ids: workspace_id
                .as_deref()
                .map(|id| ks.enabled_source_ids_for(id))
                .unwrap_or_default(),
            sources,
            error: None,
        }),
        Err(err) => Ok(SourcesListResultWire {
            sources: vec![],
            enabled_source_ids: vec![],
            error: Some(err.to_string()),
        }),
    }
}

/// Managed state: the process-wide knowledge manager cell.
pub struct SourcesState(SourcesCell);

impl SourcesState {
    pub fn new() -> Self {
        Self(SourcesCell::new())
    }
}

impl Default for SourcesState {
    fn default() -> Self {
        Self::new()
    }
}

fn err_wire(e: String) -> SourcesOpResultWire {
    SourcesOpResultWire {
        ok: false,
        error: Some(e),
    }
}

/// `sourcesAdd` — validate + duplicate-check, persist, then enqueue the
/// first index pass detached (failures surface as status=error on the row).
#[tauri::command]
pub async fn sources_add(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    sources: tauri::State<'_, SourcesState>,
    name: String,
    kind: String,
    location: String,
    enabled_workspace_ids: Option<Vec<String>>,
) -> Result<SourcesAddResultWire, CommandError> {
    if name.trim().is_empty() {
        return Ok(SourcesAddResultWire {
            ok: false,
            id: None,
            error: Some("name is required".into()),
        });
    }
    if !tide_rag::SOURCE_KINDS.contains(&kind.as_str()) {
        return Ok(SourcesAddResultWire {
            ok: false,
            id: None,
            error: Some(format!("unsupported source kind '{kind}'")),
        });
    }
    if location.trim().is_empty() {
        return Ok(SourcesAddResultWire {
            ok: false,
            id: None,
            error: Some("location is required".into()),
        });
    }
    if let Some(ids) = enabled_workspace_ids.as_deref() {
        if ids.iter().any(|w| w.trim().is_empty()) {
            return Ok(SourcesAddResultWire {
                ok: false,
                id: None,
                error: Some("enabledWorkspaceIds must be an array of workspace ids".into()),
            });
        }
    }
    let location_trimmed = location.trim().to_string();
    let (manager, ks) = sources.0.get(&state, &hub_cell).await?;
    let duplicate = ks
        .list_sources()
        .unwrap_or_default()
        .into_iter()
        .find(|s| s.kind == kind && s.location == location_trimmed);
    if let Some(dup) = duplicate {
        return Ok(SourcesAddResultWire {
            ok: false,
            id: Some(dup.id),
            error: Some("a source with this location already exists".into()),
        });
    }
    let added = ks
        .add_source(
            name.trim(),
            &kind,
            &location_trimmed,
            enabled_workspace_ids.as_deref(),
        )
        .map_err(|e| CommandError::with_code(e.to_string(), "DB"))?;
    let id = added.id.clone();
    // Row is persisted — resolve immediately; ingestion failures surface
    // on the row, not as an add failure.
    if let Ok(rx) = manager.enqueue(&ks, &id) {
        tokio::spawn(async move {
            let _ = rx.await;
        });
    }
    Ok(SourcesAddResultWire {
        ok: true,
        id: Some(id),
        error: None,
    })
}

/// `sourcesUpdate` — field edits + enablement; a location edit re-indexes.
#[tauri::command]
pub async fn sources_update(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    sources: tauri::State<'_, SourcesState>,
    id: String,
    patch: Value,
) -> Result<SourcesOpResultWire, CommandError> {
    let (manager, ks) = sources.0.get(&state, &hub_cell).await?;
    let name = patch.get("name").and_then(Value::as_str);
    let location = patch.get("location").and_then(Value::as_str);
    let enabled = patch.get("enabledWorkspaceIds").and_then(Value::as_array);
    if let Some(ids) = enabled {
        if ids
            .iter()
            .any(|w| w.as_str().map(|w| w.trim().is_empty()).unwrap_or(true))
        {
            return Ok(err_wire(
                "enabledWorkspaceIds must be an array of workspace ids".into(),
            ));
        }
    }
    if ks.update_source(&id, name, location).is_none() {
        return Ok(err_wire(format!("unknown knowledge source {id}")));
    }
    if let Some(ids) = enabled {
        let parsed: Vec<String> = ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        ks.set_enabled(&id, &parsed);
    }
    // A location edit invalidates the stored chunks — reindex automatically.
    if location.map(str::trim).is_some_and(|l| !l.is_empty()) {
        ks.mark_status(&id, "queued", None);
        if let Ok(rx) = manager.enqueue(&ks, &id) {
            // Row edits persisted; the failed reindex shows as status=error.
            std::mem::drop(rx.await);
        }
    }
    Ok(SourcesOpResultWire {
        ok: true,
        error: None,
    })
}

/// `sourcesRemove`.
#[tauri::command]
pub async fn sources_remove(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    sources: tauri::State<'_, SourcesState>,
    id: String,
) -> Result<SourcesOpResultWire, CommandError> {
    let (manager, ks) = sources.0.get(&state, &hub_cell).await?;
    if ks.get_source(&id).is_none() {
        return Ok(SourcesOpResultWire {
            ok: true,
            error: None,
        });
    }
    let inflight = manager.enqueue(&ks, &id).ok();
    ks.delete_source(&id);
    if let Some(rx) = inflight {
        let _ = rx.await;
    }
    ks.purge_orphans(&id);
    Ok(SourcesOpResultWire {
        ok: true,
        error: None,
    })
}

/// `sourcesSetEnabled` — the '*' expansion semantics: disabling under '*'
/// expands to the concrete workspace list minus it (refusing when nothing
/// would remain).
#[tauri::command]
pub fn sources_set_enabled(
    state: tauri::State<'_, AppState>,
    source_id: String,
    workspace_id: String,
    enabled: bool,
) -> Result<SourcesOpResultWire, CommandError> {
    let id = source_id;
    if id.trim().is_empty() {
        return Ok(err_wire("invalid source id".into()));
    }
    if workspace_id.trim().is_empty() {
        return Ok(err_wire("invalid workspace id".into()));
    }
    let ks = tide_rag::KnowledgeStore::open(state.data_dir())
        .map_err(|e| CommandError::with_code(e.to_string(), "DB_OPEN"))?;
    let Some(src) = ks.get_source(&id) else {
        return Ok(err_wire(format!("unknown knowledge source {id}")));
    };
    let cur = src.enabled_workspace_ids;
    let next: Vec<String> = if enabled {
        if cur.iter().any(|w| w == "*" || w == &workspace_id) {
            cur
        } else {
            let mut next = cur.clone();
            next.push(workspace_id.clone());
            next
        }
    } else if cur.iter().any(|w| w == "*") {
        let all: Vec<String> =
            state.read_config(|cfg| cfg.workspaces.iter().map(|w| w.id.clone()).collect())?;
        let next: Vec<String> = all.into_iter().filter(|wid| wid != &workspace_id).collect();
        if next.is_empty() {
            return Ok(err_wire("no workspaces registered".into()));
        }
        next
    } else {
        cur.into_iter().filter(|wid| wid != &workspace_id).collect()
    };
    ks.set_enabled(&id, &next);
    Ok(SourcesOpResultWire {
        ok: true,
        error: None,
    })
}

/// `sourcesReindex`.
#[tauri::command]
pub async fn sources_reindex(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    sources: tauri::State<'_, SourcesState>,
    source_id: String,
) -> Result<SourcesOpResultWire, CommandError> {
    let (manager, ks) = sources.0.get(&state, &hub_cell).await?;
    match manager.enqueue(&ks, &source_id) {
        Ok(rx) => {
            let _ = rx.await;
            Ok(SourcesOpResultWire {
                ok: true,
                error: None,
            })
        }
        Err(e) => Ok(err_wire(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_wire_shapes_match_the_rpc() {
        let ok = SourcesOpResultWire {
            ok: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "ok": true })
        );
        let err = err_wire("boom".into());
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({ "ok": false, "error": "boom" })
        );
    }

    #[test]
    fn add_result_carries_duplicate_id() {
        let wire = SourcesAddResultWire {
            ok: false,
            id: Some("src_1".into()),
            error: Some("a source with this location already exists".into()),
        };
        let json = serde_json::to_value(&wire).unwrap();
        assert_eq!(json["id"], serde_json::json!("src_1"));
        assert_eq!(json["ok"], serde_json::json!(false));
    }

    /// Serial-queue semantics with real fetchers (docs kind, temp dirs)
    /// and the real vendored embedder — slow, so ignored in the normal
    /// gate. Verifies: add persists + enqueues, job runs to idle with
    /// chunkCount, update-with-location re-indexes, remove purges.
    #[test]
    #[ignore]
    fn manager_round_trip_with_docs_source() {
        std::env::set_var(
            "TIDE_MODELS_DIR",
            concat!(env!("CARGO_MANIFEST_DIR"), "/crates/tide-rag/models"),
        );
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (bus, _rx) = broadcast::channel(64);
        let manager = KnowledgeManager::start(data_dir.clone(), bus);
        let ks = tide_rag::KnowledgeStore::open(&data_dir).unwrap();

        let docs = dir.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(
            docs.join("guide.md"),
            "# Guide\n\nThe authentication flow uses tokens.\n",
        )
        .unwrap();

        let src = ks
            .add_source("Guide", "docs", &docs.to_string_lossy(), None)
            .unwrap();
        let rx = manager.enqueue(&ks, &src.id).unwrap();
        rx.blocking_recv().unwrap().unwrap();

        let after = ks.get_source(&src.id).unwrap();
        assert_eq!(after.status, "idle");
        assert!(
            after.chunk_count > 0,
            "chunkCount was {}",
            after.chunk_count
        );
        assert!(after.last_indexed_at.is_some());

        // Location edit re-indexes.
        std::fs::write(
            docs.join("guide.md"),
            "# Guide v2\n\nMore prose here for a fresh chunk.\n",
        )
        .unwrap();
        ks.update_source(&src.id, None, Some(&docs.to_string_lossy()));
        let rx = manager.enqueue(&ks, &src.id).unwrap();
        rx.blocking_recv().unwrap().unwrap();
        assert_eq!(ks.get_source(&src.id).unwrap().status, "idle");

        // Unknown source enqueue refuses.
        assert!(manager.enqueue(&ks, "missing").is_err());

        // Remove purges rows + chunks.
        ks.delete_source(&src.id);
        assert!(ks.get_source(&src.id).is_none());
    }
}
