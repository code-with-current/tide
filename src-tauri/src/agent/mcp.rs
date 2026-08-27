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

use std::path::PathBuf;
use std::sync::Arc;

use tide_mcp::McpPool;
use tide_store::config::Config;
use tide_tools::Tool;
use tokio::sync::RwLock;

/// Identifies the pool instance: project servers come from the active
/// workspace's `.mcp.json`, so a workspace change must rebuild it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct PoolKey {
    workspace_root: String,
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

#[derive(Default, Clone)]
pub struct McpPoolCell {
    inner: Arc<RwLock<Option<PoolSlot>>>,
}

impl McpPoolCell {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(None)),
        }
    }

    /// The live pool, if one has finished initializing.
    pub async fn pool(&self) -> Option<Arc<McpPool>> {
        let guard = self.inner.read().await;
        match guard.as_ref() {
            Some(PoolSlot::Ready(_, pool)) => Some(Arc::clone(pool)),
            _ => None,
        }
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
        tokio::spawn(async move {
            let workspace_id = workspace_root
                .as_deref()
                .and_then(|root| resolve_workspace_id(&config, root));
            let root_path = workspace_root.as_deref().map(PathBuf::from);
            let workspace_pair = workspace_id.as_deref().zip(root_path.as_deref());
            let pool = McpPool::from_config(data_dir, &config, workspace_pair).await;
            let mut guard = inner.write().await;
            *guard = Some(PoolSlot::Ready(key, pool));
        });
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
}
