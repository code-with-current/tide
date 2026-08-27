//! MCP pool ownership for the app process — the bridge between the
//! tide-mcp crate and the turn loop. Port of the TS module-scoped pool
//! singleton (`app/core/agent/mcp/pool.ts`): user servers boot-connected
//! (app lifetime), project servers bound to the active workspace
//! (workspace lifetime — a workspace switch swaps the pool).
//!
//! The turn's tool list is extended dynamically: `chat_run_turn` appends
//! [`McpPool::mcp_tools`] to `core_tools()`, so MCP tools join each turn
//! with zero orchestrator special-casing (name-keyed dispatch + the
//! read-only `mcp__` permission tier do the rest).
//!
//! M4 T6 additions: a generation counter in the pool key so
//! `mcpReinitialize` can force a rebuild on an unchanged workspace; an
//! active-workspace tracker (the TS `mcpWorkspaceActivated` slot); a
//! status-change broadcast the chat push channel forwards to the renderer
//! as `mcpEvents`; and a pluggable OAuth URL opener (the opener plugin's
//! browser launch, installed at app setup).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tide_mcp::McpPool;
use tide_store::config::Config;
use tide_tools::Tool;
use tokio::sync::{broadcast, RwLock};

/// Identifies the pool instance: project servers come from the active
/// workspace's `.mcp.json`, so a workspace change must rebuild it. The
/// generation separates same-workspace rebuilds (mcpReinitialize) from
/// no-op re-ensures.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct PoolKey {
    workspace_root: String,
    generation: u64,
}

enum PoolSlot {
    Building(PoolKey),
    Ready(PoolKey, Arc<McpPool>),
}

impl PoolSlot {
    fn key(&self) -> &PoolKey {
        match self {
            PoolSlot::Building(key) | PoolSlot::Ready(key, _) => key,
        }
    }
}

/// The shared authorization-URL opener hook (the opener plugin's browser
/// launch), swappable after construction.
type SharedUrlOpener = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct McpPoolCell {
    inner: Arc<RwLock<Option<PoolSlot>>>,
    generation: Arc<AtomicU64>,
    active_workspace: Arc<StdMutex<Option<(String, String)>>>,
    status_tx: broadcast::Sender<()>,
    url_opener: Arc<StdMutex<SharedUrlOpener>>,
}

impl Default for McpPoolCell {
    fn default() -> Self {
        Self::new()
    }
}

impl McpPoolCell {
    pub fn new() -> Self {
        let (status_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            active_workspace: Arc::new(StdMutex::new(None)),
            status_tx,
            url_opener: Arc::new(StdMutex::new(Arc::new(|_url: &str| {}))),
        }
    }

    /// Install the OAuth authorization-URL opener (the opener plugin's
    /// system-browser launch). Applied to every pool built afterwards.
    pub fn set_url_opener(&self, opener: Arc<dyn Fn(&str) + Send + Sync>) {
        *self.url_opener.lock().expect("opener slot poisoned") = opener;
    }

    /// The live pool, if one has finished initializing.
    pub async fn pool(&self) -> Option<Arc<McpPool>> {
        let guard = self.inner.read().await;
        match guard.as_ref() {
            Some(PoolSlot::Ready(_, pool)) => Some(Arc::clone(pool)),
            _ => None,
        }
    }

    /// Subscribe to pool status-change pings (forwarded to the renderer as
    /// `mcpEvents` — the payload is a ping, the panel re-fetches via
    /// `mcpList`; a lagged receiver just skips pings).
    pub fn subscribe_status(&self) -> broadcast::Receiver<()> {
        self.status_tx.subscribe()
    }

    /// The workspace the panel activated (TS `activeWorkspace` tracker),
    /// set by `mcpWorkspaceActivated`.
    pub fn set_active_workspace(&self, workspace_id: &str, workspace_root: &str) {
        *self.active_workspace.lock().expect("workspace slot poisoned") = Some((
            workspace_id.to_owned(),
            workspace_root.to_owned(),
        ));
    }

    pub fn active_workspace(&self) -> Option<(String, String)> {
        self.active_workspace
            .lock()
            .expect("workspace slot poisoned")
            .clone()
    }

    /// Make sure a pool for this workspace exists — spawn-and-return (the
    /// TS booted connections at app start in the background; a slow stdio
    /// server must not block turn acceptance, so the first turn after boot
    /// may briefly run without MCP tools). Rebuilds when the workspace
    /// changes, shutting the old pool down first (TS `activateWorkspace`
    /// disconnected the previous workspace's project servers).
    pub async fn ensure_started(
        &self,
        data_dir: PathBuf,
        config: Config,
        workspace_root: Option<String>,
    ) {
        let key = PoolKey {
            workspace_root: workspace_root.clone().unwrap_or_default(),
            generation: self.generation.load(Ordering::SeqCst),
        };
        {
            let guard = self.inner.read().await;
            if let Some(slot) = guard.as_ref() {
                if *slot.key() == key {
                    return;
                }
            }
        }
        let existing = {
            let mut guard = self.inner.write().await;
            // Another task may have started the same build while we waited
            // for the write lock.
            if let Some(slot) = guard.as_ref() {
                if *slot.key() == key {
                    return;
                }
            }
            match guard.replace(PoolSlot::Building(key.clone())) {
                Some(PoolSlot::Ready(_, pool)) => Some(pool),
                _ => None,
            }
        };
        if let Some(pool) = existing {
            pool.shutdown().await;
        }
        let inner = Arc::clone(&self.inner);
        let status_tx = self.status_tx.clone();
        let url_opener = Arc::clone(&self.url_opener.lock().expect("opener slot poisoned"));
        tokio::spawn(async move {
            let workspace_id = workspace_root
                .as_deref()
                .and_then(|root| resolve_workspace_id(&config, root));
            let root_path = workspace_root.as_deref().map(PathBuf::from);
            let workspace_pair = workspace_id.as_deref().zip(root_path.as_deref());
            let pool = McpPool::from_config(data_dir, &config, workspace_pair).await;
            // Status transitions feed the renderer's mcpEvents push; boot
            // transitions before this point are dropped exactly like the
            // TS shell's zero-window broadcast was.
            let tx = status_tx.clone();
            pool.set_status_notifier(Box::new(move || {
                let _ = tx.send(());
            }));
            let opener = Arc::clone(&url_opener);
            pool.set_url_opener(Box::new(move |url| opener(url)));
            let mut guard = inner.write().await;
            // A newer key superseded this build while it ran — discard it
            // instead of clobbering the newer slot.
            let superseded = matches!(guard.as_ref(), Some(slot) if *slot.key() != key);
            if superseded {
                drop(guard);
                pool.shutdown().await;
                return;
            }
            *guard = Some(PoolSlot::Ready(key, pool));
        });
    }

    /// Force a full rebuild (TS `reinitializeAll`): disconnect everything,
    /// re-read config, reconnect — even when the workspace is unchanged.
    /// Bumping the generation makes the pool key differ, so
    /// [`McpPoolCell::ensure_started`] treats it as a workspace change.
    pub async fn restart(
        &self,
        data_dir: PathBuf,
        config: Config,
        workspace_root: Option<String>,
    ) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.ensure_started(data_dir, config, workspace_root).await;
    }

    /// Connected MCP tools for the turn's tool list.
    pub async fn turn_tools(&self) -> Vec<Arc<dyn Tool>> {
        match self.pool().await {
            Some(pool) => pool.mcp_tools().await,
            None => Vec::new(),
        }
    }
}

/// The workspace id for a filesystem root (project-scoped OAuth storage
/// key); None when the root isn't a registered workspace.
fn resolve_workspace_id(config: &Config, root: &str) -> Option<String> {
    config
        .workspaces
        .iter()
        .find(|ws| ws.path == root)
        .map(|ws| ws.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for_pool(cell: &McpPoolCell) -> Arc<McpPool> {
        for _ in 0..100 {
            if let Some(pool) = cell.pool().await {
                return pool;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("pool never became ready");
    }

    #[test]
    fn workspace_id_resolves_by_path() {
        let mut config = Config::default();
        config.workspaces = vec![tide_store::config::Workspace {
            id: "ws_1".into(),
            name: "w".into(),
            path: "/tmp/w".into(),
            branch: None,
            archived_at: None,
            extra: Default::default(),
        }];
        assert_eq!(
            resolve_workspace_id(&config, "/tmp/w").as_deref(),
            Some("ws_1")
        );
        assert_eq!(resolve_workspace_id(&config, "/elsewhere"), None);
    }

    #[tokio::test]
    async fn ensure_started_builds_a_pool_and_swaps_on_workspace_change() {
        let dir = tempfile::tempdir().unwrap();
        let cell = McpPoolCell::new();
        cell.ensure_started(dir.path().to_path_buf(), Config::default(), None)
            .await;
        let first = wait_for_pool(&cell).await;
        assert!(first.status_list().await.is_empty());

        // Same workspace → no rebuild (same Arc).
        cell.ensure_started(dir.path().to_path_buf(), Config::default(), None)
            .await;
        assert!(Arc::ptr_eq(&first, &wait_for_pool(&cell).await));

        // Workspace change → rebuild (different key, fresh pool).
        cell.ensure_started(
            dir.path().to_path_buf(),
            Config::default(),
            Some("/definitely/elsewhere".into()),
        )
        .await;
        let second = wait_for_pool(&cell).await;
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(second.status_list().await.is_empty());
    }

    #[tokio::test]
    async fn restart_rebuilds_even_for_the_same_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let cell = McpPoolCell::new();
        cell.ensure_started(dir.path().to_path_buf(), Config::default(), None)
            .await;
        let first = wait_for_pool(&cell).await;
        cell.restart(dir.path().to_path_buf(), Config::default(), None)
            .await;
        let second = wait_for_pool(&cell).await;
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn status_pings_flow_from_pool_transitions() {
        let dir = tempfile::tempdir().unwrap();
        let cell = McpPoolCell::new();
        cell.ensure_started(dir.path().to_path_buf(), Config::default(), None)
            .await;
        let pool = wait_for_pool(&cell).await;
        let mut rx = cell.subscribe_status();
        // reset_connection pings immediately on the connecting transition —
        // connect_entry drives one even for an invalid config (error row).
        pool.connect_entry(tide_mcp::ResolvedServer {
            name: "bad".to_owned(),
            config: tide_mcp::McpServerConfig {
                r#type: Some(tide_mcp::McpTransportType::Http),
                ..Default::default()
            },
            scope: tide_mcp::McpScope::User,
            workspace_id: None,
            workspace_root: None,
        })
        .await;
        match tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
            Ok(Ok(())) => {}
            other => panic!("expected a status ping, got {other:?}"),
        }
    }
}
