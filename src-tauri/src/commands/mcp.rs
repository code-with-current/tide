//! MCP commands — the management-panel surface (M4 T6, the TS
//! `app/rpc/mcp.ts` port): status rows, config CRUD (user scope in
//! config.json's top-level `mcpServers`, project scope in the workspace's
//! `.mcp.json`), the import scanner, the `mcp-secrets.json` store, the
//! enabled/disabled toggle (config.json `extensions.disabled.mcp`), pool
//! rebuild/retry, and the OAuth browser flow (start returns the
//! authorization URL and opens the system browser via the opener plugin;
//! the loopback completion lives in tide-mcp).
//!
//! Approvals: the TS gate was removed upstream — `mcpApprove` stays as a
//! benign no-op so the UI channel keeps answering. Project-scoped handlers
//! resolve the active workspace via the tracker `mcpWorkspaceActivated`
//! sets, falling back to last-workspace/first-workspace in config so they
//! work before activation ever fires (TS `resolveWorkspace`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tide_mcp::config::{
    project_config_path, project_servers, user_servers, McpScope, McpServerConfig, ResolvedServer,
};
use tide_mcp::scanner::{self, ScanResult};
use tide_mcp::secrets;
use tide_mcp::{McpPool, ServerStatusRow};

use crate::agent::mcp::McpPoolCell;
use crate::state::AppState;

use super::CommandError;

// ── wire shapes (shared/rpc.ts) ─────────────────────────────────────────────

/// `McpOpResult` — the standard mutation reply.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpOpResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpOpResultWire {
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// `McpImportResult` — `imported` carries the server count written.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpImportResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `McpRawConfigResult` — the raw-config editor reply.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpRawConfigResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Map<String, Value>>,
}

/// `mcpAuthenticate` reply — the wire `{ ok: boolean }` plus the
/// authorization URL (additive field; the renderer uses it to surface the
/// sign-in link while the system browser opens).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpAuthenticateWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// `McpServerStatus` — the pool row plus the `enabled` flag the panel
/// toggles (kept in config.json's extensions.disabled.mcp, TS parity).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusRowWire {
    #[serde(flatten)]
    pub row: ServerStatusRow,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportServerParam {
    pub name: String,
    pub config: McpServerConfig,
}

// ── scope + workspace resolution ────────────────────────────────────────────

/// The panel's three scopes; the Tauri pool has no builtin servers, so
/// `builtin` answers with the TS no-op/error branches instead of failing
/// deserialization on a stale UI path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    User,
    Project,
    Builtin,
}

impl Scope {
    fn parse(scope: &str) -> Option<Self> {
        match scope {
            "user" => Some(Self::User),
            "project" => Some(Self::Project),
            "builtin" => Some(Self::Builtin),
            _ => None,
        }
    }
}

/// Resolve the active workspace: the `mcpWorkspaceActivated` tracker first,
/// then last-workspace/first-registered-workspace from config (TS
/// `resolveWorkspace` fallback).
pub(crate) fn resolve_active_workspace(
    state: &AppState,
    cell: &McpPoolCell,
) -> Option<(String, String)> {
    if let Some(workspace) = cell.active_workspace() {
        return Some(workspace);
    }
    state
        .read_config(|cfg| {
            let workspace = cfg
                .last_workspace_id
                .as_ref()
                .and_then(|id| cfg.workspaces.iter().find(|ws| &ws.id == id))
                .or_else(|| cfg.workspaces.iter().find(|ws| !ws.path.is_empty()))?;
            Some((workspace.id.clone(), workspace.path.clone()))
        })
        .ok()
        .flatten()
}

/// The workspace a scope mutates — None for user scope, the resolved
/// active workspace for project scope (the TS `configPathForScope` null
/// when project scope has no workspace).
fn workspace_for_scope(
    state: &AppState,
    cell: &McpPoolCell,
    scope: Scope,
) -> Option<(String, String)> {
    match scope {
        Scope::User | Scope::Builtin => None,
        Scope::Project => resolve_active_workspace(state, cell),
    }
}

// ── config CRUD ─────────────────────────────────────────────────────────────

/// Read the project `.mcp.json` as a raw map (flat or `mcpServers`-wrapped),
/// preserving unknown fields for the round-trip.
fn read_project_map(root: &Path) -> Map<String, Value> {
    for_servers_map(
        std::fs::read_to_string(project_config_path(root))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .as_ref(),
    )
}

/// Extract the server map from a parsed config file value — the wrapper
/// wins when both shapes are present (TS `readMcpConfig` order).
fn for_servers_map(parsed: Option<&Value>) -> Map<String, Value> {
    let Some(object) = parsed.and_then(Value::as_object) else {
        return Map::new();
    };
    match object.get("mcpServers") {
        Some(servers) if servers.is_object() => servers.as_object().cloned().unwrap_or_default(),
        _ => object.clone(),
    }
}

/// Write the project `.mcp.json` flat (server definitions only) — atomic
/// tmp+rename like the TS writer.
fn write_project_map(root: &Path, map: &Map<String, Value>) -> Result<(), String> {
    let path = project_config_path(root);
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn config_value(config: &McpServerConfig) -> Value {
    serde_json::to_value(config).unwrap_or(Value::Null)
}

fn upsert_server(
    state: &AppState,
    workspace: Option<&(String, String)>,
    name: &str,
    config: &McpServerConfig,
    scope: Scope,
) -> Result<(), McpOpResultWire> {
    match scope {
        Scope::User => state
            .update_config(|cfg| {
                let servers = cfg.mcp_servers.get_or_insert_with(Map::new);
                servers.insert(name.to_owned(), config_value(config));
                Ok(())
            })
            .map_err(|e| McpOpResultWire::error(e.message)),
        Scope::Project => {
            let Some((_, root)) = workspace else {
                return Err(McpOpResultWire::error(
                    "No active workspace for project-scoped server",
                ));
            };
            let mut map = read_project_map(Path::new(root));
            map.insert(name.to_owned(), config_value(config));
            write_project_map(Path::new(root), &map)
                .map_err(McpOpResultWire::error)
        }
        Scope::Builtin => Err(McpOpResultWire::error("Built-in servers cannot be edited.")),
    }
}

fn remove_server(
    state: &AppState,
    workspace: Option<&(String, String)>,
    name: &str,
    scope: Scope,
) -> Result<(), McpOpResultWire> {
    match scope {
        Scope::User => {
            state
                .update_config(|cfg| {
                    if let Some(servers) = cfg.mcp_servers.as_mut() {
                        servers.remove(name);
                    }
                    Ok(())
                })
                .map_err(|e| McpOpResultWire::error(e.message))?;
            Ok(())
        }
        Scope::Project => {
            let Some((_, root)) = workspace else {
                return Err(McpOpResultWire::error("No active workspace"));
            };
            let mut map = read_project_map(Path::new(root));
            map.remove(name);
            write_project_map(Path::new(root), &map)
                .map_err(McpOpResultWire::error)
        }
        Scope::Builtin => Err(McpOpResultWire::error("Built-in servers cannot be removed.")),
    }
}

/// The enabled/disabled allowlist lives in config.json's
/// `extensions.disabled.mcp` (the TS extensionsStore shape; items NOT
/// listed are enabled by default).
pub(crate) fn disabled_mcp_names(cfg: &tide_store::config::Config) -> Vec<String> {
    cfg.extra
        .get("extensions")
        .and_then(|v| v.get("disabled"))
        .and_then(|v| v.get("mcp"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn set_mcp_enabled_flag(
    state: &AppState,
    name: &str,
    enabled: bool,
) -> Result<(), CommandError> {
    state.update_config(|cfg| {
        let extensions = cfg
            .extra
            .entry("extensions".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !extensions.is_object() {
            *extensions = Value::Object(Map::new());
        }
        let disabled = extensions
            .as_object_mut()
            .expect("just ensured object")
            .entry("disabled".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !disabled.is_object() {
            *disabled = Value::Object(Map::new());
        }
        let mcp = disabled
            .as_object_mut()
            .expect("just ensured object")
            .entry("mcp".to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !mcp.is_array() {
            *mcp = Value::Array(Vec::new());
        }
        let list = mcp.as_array_mut().expect("just ensured array");
        if enabled {
            list.retain(|entry| entry.as_str() != Some(name));
        } else if !list.iter().any(|entry| entry.as_str() == Some(name)) {
            list.push(Value::String(name.to_owned()));
        }
        Ok(())
    })
}

// ── pool access + reload ────────────────────────────────────────────────────

/// Ensure a pool exists for the resolved workspace and wait (bounded) for
/// the background build so panel commands see the pool they asked for.
async fn ensure_pool(state: &AppState, cell: &McpPoolCell) -> Option<Arc<McpPool>> {
    let root = resolve_active_workspace(state, cell).map(|(_, root)| root);
    let config = state.read_config(|cfg| cfg.clone()).unwrap_or_default();
    cell.ensure_started(state.data_dir().to_path_buf(), config, root).await;
    for _ in 0..500 {
        if let Some(pool) = cell.pool().await {
            return Some(pool);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None
}

/// Fire-and-forget connect (TS `loadServer` behind `fireAndForget`) — the
/// request returns instantly; status transitions push via mcpEvents.
fn spawn_connect(pool: &Arc<McpPool>, server: ResolvedServer) {
    let pool = Arc::clone(pool);
    tokio::spawn(async move {
        pool.connect_entry(server).await;
    });
}

/// ResolveServer for a fresh connect (add/update/import/enable) — the
/// workspace id/root ride project-scope entries for credential storage.
fn resolved(name: &str, config: McpServerConfig, workspace: Option<&(String, String)>, scope: Scope) -> Option<ResolvedServer> {
    match scope {
        Scope::User => Some(ResolvedServer {
            name: name.to_owned(),
            config,
            scope: McpScope::User,
            workspace_id: None,
            workspace_root: None,
        }),
        Scope::Project => workspace.map(|(id, root)| ResolvedServer {
            name: name.to_owned(),
            config,
            scope: McpScope::Project,
            workspace_id: Some(id.clone()),
            workspace_root: Some(PathBuf::from(root)),
        }),
        Scope::Builtin => None,
    }
}

/// Fresh config from the scope's source (TS `retryServer` re-read disk so
/// external edits are picked up, not the stale cached config).
fn fresh_config(
    state: &AppState,
    workspace: Option<&(String, String)>,
    name: &str,
    scope: Scope,
) -> Option<McpServerConfig> {
    match scope {
        Scope::User => state
            .read_config(|cfg| user_servers(cfg).get(name).cloned())
            .ok()
            .flatten(),
        Scope::Project => {
            let (_, root) = workspace?;
            project_servers(Path::new(root)).get(name).cloned()
        }
        Scope::Builtin => None,
    }
}

// ── status rows ─────────────────────────────────────────────────────────────

async fn status_rows(state: &AppState, cell: &McpPoolCell) -> Vec<StatusRowWire> {
    let disabled = state
        .read_config(disabled_mcp_names)
        .unwrap_or_default();
    let Some(pool) = ensure_pool(state, cell).await else {
        return Vec::new();
    };
    pool.status_list()
        .await
        .into_iter()
        .map(|row| {
            let enabled = !disabled.contains(&row.name);
            StatusRowWire { row, enabled }
        })
        .collect()
}

// ── commands ────────────────────────────────────────────────────────────────

/// `mcpList` — status rows for the management panel. An absent pool (boot
/// init not finished / no servers configured) is an empty list, matching
/// the TS `getStatusList` on an empty pool.
#[tauri::command]
pub async fn mcp_list(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
) -> Result<Vec<StatusRowWire>, CommandError> {
    Ok(status_rows(&state, &mcp_cell).await)
}

/// `mcpAdd` / `mcpUpdate` share one path (addServer replaces by name);
/// update keeps the TS guard against editing built-ins.
async fn add_or_update_server(
    state: &AppState,
    cell: &McpPoolCell,
    name: &str,
    config: McpServerConfig,
    scope: &str,
    is_update: bool,
) -> McpOpResultWire {
    let Some(scope) = Scope::parse(scope) else {
        return McpOpResultWire::error(format!("Unknown scope: {scope}"));
    };
    if is_update && scope == Scope::Builtin {
        return McpOpResultWire::error("Built-in servers cannot be edited.");
    }
    let errors = config.validate();
    if !errors.is_empty() {
        return McpOpResultWire::error(errors.join("; "));
    }
    let workspace = resolve_active_workspace(state, cell);
    if let Err(result) = upsert_server(state, workspace.as_ref(), name, &config, scope) {
        return result;
    }
    if let Some(pool) = cell.pool().await {
        if let Some(server) = resolved(name, config, workspace.as_ref(), scope) {
            spawn_connect(&pool, server);
        }
    }
    McpOpResultWire::ok()
}

/// `mcpAdd` — validate, write the scope's config, connect in the
/// background so the request returns instantly (UI updates off mcpEvents).
#[tauri::command]
pub async fn mcp_add(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    config: McpServerConfig,
    scope: String,
) -> Result<McpOpResultWire, CommandError> {
    Ok(add_or_update_server(&state, &mcp_cell, &name, config, &scope, false).await)
}

/// `mcpUpdate` — identical to add (replace by name).
#[tauri::command]
pub async fn mcp_update(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    config: McpServerConfig,
    scope: String,
) -> Result<McpOpResultWire, CommandError> {
    Ok(add_or_update_server(&state, &mcp_cell, &name, config, &scope, true).await)
}

/// `mcpRemove` — delete from config, then unload from the pool so the row
/// disappears from the UI.
#[tauri::command]
pub async fn mcp_remove(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    scope: String,
) -> Result<McpOpResultWire, CommandError> {
    let Some(scope) = Scope::parse(&scope) else {
        return Ok(McpOpResultWire::error(format!("Unknown scope: {scope}")));
    };
    let workspace = workspace_for_scope(&state, &mcp_cell, scope);
    if let Err(result) = remove_server(&state, workspace.as_ref(), &name, scope) {
        return Ok(result);
    }
    if let Some(pool) = cell_pool(&mcp_cell).await {
        pool.unload(&name).await;
    }
    Ok(McpOpResultWire::ok())
}

/// `mcpApprove` — first-connect consent gate removed upstream; a benign
/// no-op so the UI channel keeps answering.
#[tauri::command]
pub async fn mcp_approve(name: String) -> Result<McpOpResultWire, CommandError> {
    let _ = name;
    Ok(McpOpResultWire::ok())
}

/// `mcpRetry` — reconnect with fresh config from the scope's source so
/// external edits are picked up; fire-and-forget.
#[tauri::command]
pub async fn mcp_retry(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    scope: String,
    workspace_id: Option<String>,
) -> Result<McpOpResultWire, CommandError> {
    let _ = workspace_id;
    let Some(scope) = Scope::parse(&scope) else {
        return Ok(McpOpResultWire::error(format!("Unknown scope: {scope}")));
    };
    let Some(pool) = ensure_pool(&state, &mcp_cell).await else {
        return Ok(McpOpResultWire::ok());
    };
    let workspace = resolve_active_workspace(&state, &mcp_cell);
    let fresh = fresh_config(&state, workspace.as_ref(), &name, scope);
    let pool = Arc::clone(&pool);
    let name_for_task = name.clone();
    tokio::spawn(async move {
        pool.reload_server(&name_for_task, fresh).await;
    });
    Ok(McpOpResultWire::ok())
}

/// `mcpAuthenticate` — user-initiated OAuth sign-in: start the flow (bind
/// the loopback listener, discover + register, build the authorize URL),
/// open the system browser at it via the opener plugin, and return the URL.
/// The completion (loopback redirect → code exchange → reconnect) runs in
/// the background inside tide-mcp.
#[tauri::command]
pub async fn mcp_authenticate(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    scope: String,
    workspace_id: Option<String>,
) -> Result<McpAuthenticateWire, CommandError> {
    let _ = (scope, workspace_id);
    let Some(pool) = ensure_pool(&state, &mcp_cell).await else {
        return Ok(McpAuthenticateWire { ok: false, url: None });
    };
    match pool.start_authorization(&name).await {
        Ok(url) => {
            let completion_pool = Arc::clone(&pool);
            let completion_name = name.clone();
            tokio::spawn(async move {
                if let Err(error) = completion_pool
                    .complete_authorization(&completion_name)
                    .await
                {
                    eprintln!("[tide] mcp authenticate failed for {completion_name}: {error}");
                }
            });
            Ok(McpAuthenticateWire {
                ok: true,
                url: Some(url),
            })
        }
        Err(error) => {
            eprintln!("[tide] mcp authenticate could not start for {name}: {error}");
            Ok(McpAuthenticateWire {
                ok: false,
                url: None,
            })
        }
    }
}

/// `mcpReinitialize` — disconnect + reconnect ALL servers from config (the
/// panel's reload): picks up added/removed/edited and previously-failing
/// servers. The rebuild runs in the background; UI updates off mcpEvents.
#[tauri::command]
pub async fn mcp_reinitialize(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
) -> Result<McpOpResultWire, CommandError> {
    let root = resolve_active_workspace(&state, &mcp_cell).map(|(_, root)| root);
    let config = state.read_config(|cfg| cfg.clone())?;
    mcp_cell
        .restart(state.data_dir().to_path_buf(), config, root)
        .await;
    Ok(McpOpResultWire::ok())
}

/// `mcpSetSecret` — store a `{{secret:name}}` value in
/// `<data_dir>/mcp-secrets.json`.
#[tauri::command]
pub async fn mcp_set_secret(
    state: tauri::State<'_, AppState>,
    name: String,
    value: String,
) -> Result<McpOpResultWire, CommandError> {
    secrets::set_secret(state.data_dir(), &name, &value);
    Ok(McpOpResultWire::ok())
}

/// `mcpHasSecret` — whether a secret is stored under this name.
#[tauri::command]
pub async fn mcp_has_secret(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<HasSecretWire, CommandError> {
    Ok(HasSecretWire {
        has: secrets::has_secret(state.data_dir(), &name),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HasSecretWire {
    pub has: bool,
}

/// `mcpClearSecret` — delete a stored secret.
#[tauri::command]
pub async fn mcp_clear_secret(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<McpOpResultWire, CommandError> {
    secrets::clear_secret(state.data_dir(), &name);
    Ok(McpOpResultWire::ok())
}

/// `mcpReauthorize` — force re-authentication: drop stored credentials and
/// run the browser flow end-to-end in the background (clear + start +
/// loopback completion + reconnect, all inside tide-mcp's
/// `reauthenticate`).
#[tauri::command]
pub async fn mcp_reauthorize(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    scope: String,
    workspace_id: Option<String>,
) -> Result<McpOpResultWire, CommandError> {
    let _ = (scope, workspace_id);
    let Some(pool) = ensure_pool(&state, &mcp_cell).await else {
        return Ok(McpOpResultWire::ok());
    };
    let pool = Arc::clone(&pool);
    tokio::spawn(async move {
        if let Err(error) = pool.reauthenticate(&name).await {
            eprintln!("[tide] mcp reauthorize failed for {name}: {error}");
        }
    });
    Ok(McpOpResultWire::ok())
}

/// `mcpScan` — detect MCP servers from other tools' config files under the
/// user's home directory.
#[tauri::command]
pub async fn mcp_scan(
    state: tauri::State<'_, AppState>,
) -> Result<ScanResult, CommandError> {
    let tide_servers = state.read_config(user_servers)?;
    Ok(scanner::scan_external_mcp_servers(&home_dir(), &tide_servers))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `mcpImport` — write the selected scan results to the scope's config
/// synchronously, then fire the connections in the background so the
/// dialog can close.
#[tauri::command]
pub async fn mcp_import(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    servers: Vec<ImportServerParam>,
    scope: String,
) -> Result<McpImportResultWire, CommandError> {
    Ok(import_servers_value(&state, &mcp_cell, servers, &scope).await)
}

async fn import_servers_value(
    state: &AppState,
    cell: &McpPoolCell,
    servers: Vec<ImportServerParam>,
    scope: &str,
) -> McpImportResultWire {
    let Some(scope) = Scope::parse(scope) else {
        return McpImportResultWire {
            ok: false,
            imported: None,
            error: Some(format!("Unknown scope: {scope}")),
        };
    };
    let workspace = workspace_for_scope(state, cell, scope);
    // TS mcpImport wrote without validation (scan results are pre-shaped);
    // one flat write per scope, then background connects.
    let write_result = match scope {
        Scope::User => state.update_config(|cfg| {
            let servers_map = cfg.mcp_servers.get_or_insert_with(Map::new);
            for server in &servers {
                servers_map.insert(server.name.clone(), config_value(&server.config));
            }
            Ok(())
        }),
        Scope::Project => {
            let Some((_, root)) = workspace.as_ref() else {
                return McpImportResultWire {
                    ok: false,
                    imported: None,
                    error: Some("No active workspace for project scope".to_owned()),
                };
            };
            let mut map = read_project_map(Path::new(root));
            for server in &servers {
                map.insert(server.name.clone(), config_value(&server.config));
            }
            write_project_map(Path::new(root), &map).map_err(|e| CommandError {
                message: e,
                code: None,
            })
        }
        Scope::Builtin => Err(CommandError {
            message: "Built-in servers cannot be edited.".to_owned(),
            code: None,
        }),
    };
    if let Err(error) = write_result {
        return McpImportResultWire {
            ok: false,
            imported: None,
            error: Some(error.message),
        };
    }
    let count = servers.len();
    if let Some(pool) = cell_pool(cell).await {
        for server in servers {
            if let Some(resolved) = resolved(&server.name, server.config, workspace.as_ref(), scope)
            {
                spawn_connect(&pool, resolved);
            }
        }
    }
    McpImportResultWire {
        ok: true,
        imported: Some(count),
        error: None,
    }
}

/// `mcpSetEnabled` — toggle without removing config. Disabling keeps a
/// `disconnected` row (greyed out); re-enabling reconnects from the
/// user/project config like the TS order (builtin → user → project; the
/// Tauri pool has no builtins).
#[tauri::command]
pub async fn mcp_set_enabled(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    name: String,
    enabled: bool,
    scope: String,
) -> Result<McpOpResultWire, CommandError> {
    let _ = scope;
    set_mcp_enabled_flag(&state, &name, enabled)?;
    let Some(pool) = ensure_pool(&state, &mcp_cell).await else {
        return Ok(McpOpResultWire::ok());
    };
    if !enabled {
        pool.disconnect(&name).await;
    } else {
        let workspace = resolve_active_workspace(&state, &mcp_cell);
        // User config first, then the active workspace's project file.
        let server = fresh_config(&state, workspace.as_ref(), &name, Scope::User)
            .map(|config| resolved(&name, config, None, Scope::User))
            .or_else(|| {
                workspace
                    .as_ref()
                    .and_then(|ws| {
                        fresh_config(&state, Some(ws), &name, Scope::Project)
                            .map(|config| resolved(&name, config, Some(ws), Scope::Project))
                    })
            })
            .flatten();
        if let Some(server) = server {
            spawn_connect(&pool, server);
        }
    }
    Ok(McpOpResultWire::ok())
}

/// `mcpReadRaw` — the scope's server map for the advanced editor.
#[tauri::command]
pub async fn mcp_read_raw(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    scope: String,
) -> Result<McpRawConfigResultWire, CommandError> {
    Ok(read_raw_value(&state, &mcp_cell, &scope).await)
}

async fn read_raw_value(
    state: &AppState,
    cell: &McpPoolCell,
    scope: &str,
) -> McpRawConfigResultWire {
    let Some(scope) = Scope::parse(scope) else {
        return McpRawConfigResultWire {
            ok: false,
            error: Some(format!("Unknown scope: {scope}")),
            config: None,
        };
    };
    match scope {
        Scope::User => {
            let config = state
                .read_config(|cfg| cfg.mcp_servers.clone().unwrap_or_default())
                .unwrap_or_default();
            McpRawConfigResultWire {
                ok: true,
                error: None,
                config: Some(config),
            }
        }
        Scope::Project => {
            let Some((_, root)) = resolve_active_workspace(state, cell) else {
                return McpRawConfigResultWire {
                    ok: false,
                    error: Some("No active workspace".to_owned()),
                    config: None,
                };
            };
            McpRawConfigResultWire {
                ok: true,
                error: None,
                config: Some(read_project_map(Path::new(&root))),
            }
        }
        Scope::Builtin => McpRawConfigResultWire {
            ok: false,
            error: Some("Built-in servers have no editable config.".to_owned()),
            config: None,
        },
    }
}

/// `mcpWriteRaw` — replace the scope's server map (the advanced editor's
/// save; no validation, matching the TS cast-through).
#[tauri::command]
pub async fn mcp_write_raw(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    config: Map<String, Value>,
    scope: String,
) -> Result<McpOpResultWire, CommandError> {
    Ok(write_raw_value(&state, &mcp_cell, config, &scope).await)
}

async fn write_raw_value(
    state: &AppState,
    cell: &McpPoolCell,
    config: Map<String, Value>,
    scope: &str,
) -> McpOpResultWire {
    let Some(scope) = Scope::parse(scope) else {
        return McpOpResultWire::error(format!("Unknown scope: {scope}"));
    };
    match scope {
        Scope::User => {
            match state.update_config(|cfg| {
                cfg.mcp_servers = Some(config.clone());
                Ok(())
            }) {
                Ok(()) => McpOpResultWire::ok(),
                Err(e) => McpOpResultWire::error(e.message),
            }
        }
        Scope::Project => {
            let Some((_, root)) = resolve_active_workspace(state, cell) else {
                return McpOpResultWire::error("No active workspace");
            };
            match write_project_map(Path::new(&root), &config) {
                Ok(()) => McpOpResultWire::ok(),
                Err(e) => McpOpResultWire::error(e),
            }
        }
        Scope::Builtin => McpOpResultWire::error("Built-in servers have no editable config."),
    }
}

/// `mcpWorkspaceActivated` — the workspace-switch hook: remember the
/// workspace and rebuild the pool so its project-scoped servers (the
/// root's `.mcp.json`) come up (TS `activateWorkspace`).
#[tauri::command]
pub async fn mcp_workspace_activated(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    workspace_id: String,
    workspace_root: String,
) -> Result<McpOpResultWire, CommandError> {
    mcp_cell.set_active_workspace(&workspace_id, &workspace_root);
    let config = state.read_config(|cfg| cfg.clone())?;
    mcp_cell
        .ensure_started(
            state.data_dir().to_path_buf(),
            config,
            Some(workspace_root),
        )
        .await;
    Ok(McpOpResultWire::ok())
}

/// The live pool without an ensure pass (post-mutation reloads where the
/// command already knows a pool exists).
async fn cell_pool(cell: &McpPoolCell) -> Option<Arc<McpPool>> {
    cell.pool().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tide_mcp::{ConnStatus, McpTransportType};

    fn temp_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::load(dir.path().to_path_buf());
        (state, dir)
    }

    fn stdio_config(command: &str) -> McpServerConfig {
        McpServerConfig {
            command: Some(command.to_owned()),
            ..Default::default()
        }
    }

    async fn wait_row(
        pool: &Arc<McpPool>,
        name: &str,
        want: Option<ConnStatus>,
    ) -> Option<ServerStatusRow> {
        for _ in 0..400 {
            if let Some(row) = pool.status_list().await.into_iter().find(|r| r.name == name) {
                if want.is_none() || Some(row.status) == want {
                    return Some(row);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }

    // ── config CRUD ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn user_scope_crud_round_trips_through_config_json() {
        let (state, dir) = temp_state();
        let cell = McpPoolCell::new();

        let added = add_or_update_server(&state, &cell, "srv", stdio_config("echo"), "user", false)
            .await;
        assert_eq!(added, McpOpResultWire::ok());
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk["mcpServers"]["srv"]["command"], "echo");

        // Update replaces by name.
        let mut updated_config = stdio_config("echo2");
        updated_config.args = Some(vec!["--flag".to_owned()]);
        let updated =
            add_or_update_server(&state, &cell, "srv", updated_config, "user", true).await;
        assert_eq!(updated, McpOpResultWire::ok());
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk["mcpServers"]["srv"]["command"], "echo2");
        assert_eq!(on_disk["mcpServers"]["srv"]["args"][0], "--flag");

        // Remove deletes the entry (and just that entry).
        assert!(remove_server(&state, None, "srv", Scope::User).is_ok());
        let reloaded = state.read_config(user_servers).unwrap();
        assert!(reloaded.is_empty());
    }

    #[tokio::test]
    async fn project_scope_crud_writes_workspace_mcp_json() {
        let (state, _dir) = temp_state();
        let workspace_dir = tempfile::tempdir().unwrap();
        // Wrapped input shape — the CRUD read unwraps, the write goes flat.
        std::fs::write(
            project_config_path(workspace_dir.path()),
            r#"{"mcpServers": {"existing": {"command": "keep"}}}"#,
        )
        .unwrap();
        let cell = McpPoolCell::new();
        cell.set_active_workspace("ws_1", &workspace_dir.path().display().to_string());

        let added = add_or_update_server(
            &state,
            &cell,
            "proj",
            stdio_config("run"),
            "project",
            false,
        )
        .await;
        assert_eq!(added, McpOpResultWire::ok());
        let raw = std::fs::read_to_string(project_config_path(workspace_dir.path())).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["proj"]["command"], "run");
        assert_eq!(parsed["existing"]["command"], "keep");

        assert!(remove_server(
            &state,
            Some(&("ws_1".to_owned(), workspace_dir.path().display().to_string())),
            "proj",
            Scope::Project,
        )
        .is_ok());
        let servers = project_servers(workspace_dir.path());
        assert!(!servers.contains_key("proj"));
        assert!(servers.contains_key("existing"));
    }

    #[tokio::test]
    async fn project_scope_without_workspace_errors_like_ts() {
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        let result =
            add_or_update_server(&state, &cell, "x", stdio_config("c"), "project", false).await;
        assert_eq!(
            result,
            McpOpResultWire::error("No active workspace for project-scoped server")
        );
    }

    #[tokio::test]
    async fn validation_errors_match_ts() {
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        let broken = McpServerConfig::default();
        let result = add_or_update_server(&state, &cell, "bad", broken, "user", false).await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("command"));

        let remote = McpServerConfig {
            r#type: Some(McpTransportType::Http),
            ..Default::default()
        };
        let result = add_or_update_server(&state, &cell, "bad-http", remote, "user", false).await;
        assert!(result.error.unwrap().contains("url"));

        // Unknown scope.
        let result =
            add_or_update_server(&state, &cell, "x", stdio_config("c"), "galactic", false).await;
        assert!(result.error.unwrap().contains("Unknown scope"));
    }

    // ── raw config editor ───────────────────────────────────────────────

    #[tokio::test]
    async fn raw_read_write_round_trips_both_scopes() {
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_str(r#"{"u": {"command": "uc"}}"#).unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let user = read_raw_value(&state, &cell, "user").await;
        assert!(user.ok);
        assert_eq!(user.config.unwrap()["u"]["command"], "uc");

        let mut replacement = Map::new();
        replacement.insert("v".to_owned(), serde_json::json!({"command": "vc"}));
        let written = write_raw_value(&state, &cell, replacement.clone(), "user").await;
        assert_eq!(written, McpOpResultWire::ok());
        assert_eq!(
            state.read_config(|cfg| cfg.mcp_servers.clone()).unwrap(),
            Some(replacement)
        );

        // Project scope: read unwraps the wrapper, write goes flat.
        let workspace_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            project_config_path(workspace_dir.path()),
            r#"{"mcpServers": {"p": {"command": "pc"}}}"#,
        )
        .unwrap();
        cell.set_active_workspace("ws_9", &workspace_dir.path().display().to_string());
        let project = read_raw_value(&state, &cell, "project").await;
        assert!(project.ok);
        assert_eq!(project.config.unwrap()["p"]["command"], "pc");

        let mut flat = Map::new();
        flat.insert("q".to_owned(), serde_json::json!({"url": "https://mcp"}));
        let written = write_raw_value(&state, &cell, flat, "project").await;
        assert_eq!(written, McpOpResultWire::ok());
        let raw = std::fs::read_to_string(project_config_path(workspace_dir.path())).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["q"]["url"], "https://mcp");
        assert!(parsed.get("mcpServers").is_none());
    }

    // ── scanner ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn scan_reads_external_sources_and_marks_imported() {
        let (state, _dir) = temp_state();
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_str(r#"{"mine": {"command": "own"}}"#).unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers": {"c7": {"type": "http", "url": "https://c7"}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex").join("config.toml"),
            "[mcp_servers.fx]\ncommand = \"uvx\"\nargs = [\"fx-mcp\"]\n",
        )
        .unwrap();
        let tide_servers = state.read_config(user_servers).unwrap();
        let result = scanner::scan_external_mcp_servers(home.path(), &tide_servers);
        assert_eq!(result.already_imported, vec!["mine".to_owned()]);
        let names: Vec<&str> = result.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["c7", "fx"]);
        assert_eq!(result.servers[1].source, "Codex");

        // Import into user scope and verify the write + count.
        let cell = McpPoolCell::new();
        let imported = import_servers_value(
            &state,
            &cell,
            result
                .servers
                .into_iter()
                .map(|s| ImportServerParam {
                    name: s.name,
                    config: s.config,
                })
                .collect(),
            "user",
        )
        .await;
        assert!(imported.ok);
        assert_eq!(imported.imported, Some(2));
        let servers = state.read_config(user_servers).unwrap();
        assert!(servers.contains_key("c7"));
        assert!(servers.contains_key("fx"));
        assert!(servers.contains_key("mine"));
    }

    // ── secrets ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn secrets_file_ops_round_trip() {
        let (state, dir) = temp_state();
        assert!(!secrets::has_secret(dir.path(), "API_KEY"));
        secrets::set_secret(dir.path(), "API_KEY", "sk-live");
        assert!(secrets::has_secret(dir.path(), "API_KEY"));
        assert_eq!(
            secrets::get_secret(dir.path(), "API_KEY").as_deref(),
            Some("sk-live")
        );
        // The file is the flat mcp-secrets.json map.
        let raw = std::fs::read_to_string(dir.path().join("mcp-secrets.json")).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["API_KEY"], "sk-live");
        secrets::clear_secret(dir.path(), "API_KEY");
        assert!(!secrets::has_secret(dir.path(), "API_KEY"));
        assert_eq!(state.data_dir(), dir.path());
    }

    // ── approve ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn approve_is_a_benign_noop() {
        let result = mcp_approve("anything".to_owned()).await.unwrap();
        assert_eq!(result, McpOpResultWire::ok());
    }

    // ── enabled flag store ──────────────────────────────────────────────

    #[tokio::test]
    async fn enabled_flag_lands_in_extensions_disabled_mcp() {
        let (state, _dir) = temp_state();
        set_mcp_enabled_flag(&state, "srv", false).unwrap();
        assert_eq!(
            state.read_config(disabled_mcp_names).unwrap(),
            vec!["srv".to_owned()]
        );
        // Idempotent disable.
        set_mcp_enabled_flag(&state, "srv", false).unwrap();
        assert_eq!(
            state.read_config(disabled_mcp_names).unwrap(),
            vec!["srv".to_owned()]
        );
        set_mcp_enabled_flag(&state, "srv", true).unwrap();
        assert!(state.read_config(disabled_mcp_names).unwrap().is_empty());
        // Preserves sibling domains it didn't create.
        state
            .update_config(|cfg| {
                cfg.extra.insert(
                    "extensions".to_owned(),
                    serde_json::json!({"disabled": {"agents": ["a1"], "mcp": ["keep-me"]}}),
                );
                Ok(())
            })
            .unwrap();
        set_mcp_enabled_flag(&state, "srv", false).unwrap();
        let cfg = state.read_config(|cfg| cfg.clone()).unwrap();
        assert_eq!(cfg.extra["extensions"]["disabled"]["agents"], serde_json::json!(["a1"]));
        assert_eq!(
            cfg.extra["extensions"]["disabled"]["mcp"],
            serde_json::json!(["keep-me", "srv"])
        );
    }

    // ── approve/reload semantics against the echo fixture ───────────────

    fn echo_fixture_path() -> Option<PathBuf> {
        if let Some(path) = option_env!("CARGO_BIN_EXE_mcp-echo-fixture") {
            return Some(PathBuf::from(path));
        }
        // Shared workspace target dir — present under `cargo test
        // --workspace` (the CI gate); absent on single-package runs, where
        // fixture-dependent tests skip.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join("mcp-echo-fixture");
        path.is_file().then_some(path)
    }

    fn fixture_config(fixture: &Path) -> McpServerConfig {
        McpServerConfig {
            r#type: Some(McpTransportType::Stdio),
            command: Some(fixture.display().to_string()),
            env: Some(BTreeMap::from([(
                "FIXTURE_MODE".to_owned(),
                "ok".to_owned(),
            )])),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn reinitialize_restarts_the_pool_on_config_change() {
        let Some(fixture) = echo_fixture_path() else {
            eprintln!("mcp-echo-fixture not built — skipping");
            return;
        };
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_value(serde_json::json!({
                        "first": config_value(&fixture_config(&fixture))
                    }))
                    .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let pool = ensure_pool(&state, &cell).await.unwrap();
        let row = wait_row(&pool, "first", Some(ConnStatus::Connected)).await;
        assert!(row.is_some(), "fixture server should connect");

        // Config change on disk: swap first → second, then reinitialize.
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_value(serde_json::json!({
                        "second": config_value(&fixture_config(&fixture))
                    }))
                    .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let root = resolve_active_workspace(&state, &cell).map(|(_, root)| root);
        cell.restart(
            state.data_dir().to_path_buf(),
            state.read_config(|cfg| cfg.clone()).unwrap(),
            root,
        )
        .await;
        // The rebuilt pool connects the new server; the old row is gone.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let Some(pool) = cell.pool().await else {
                assert!(std::time::Instant::now() < deadline, "rebuild never finished");
                tokio::time::sleep(Duration::from_millis(25)).await;
                continue;
            };
            let rows = pool.status_list().await;
            let second_connected = rows
                .iter()
                .any(|r| r.name == "second" && r.status == ConnStatus::Connected);
            if second_connected && rows.iter().all(|r| r.name != "first") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "restart never picked up the new config: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn set_enabled_disconnects_and_reconnects_the_row() {
        let Some(fixture) = echo_fixture_path() else {
            eprintln!("mcp-echo-fixture not built — skipping");
            return;
        };
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_value(serde_json::json!({
                        "tog": config_value(&fixture_config(&fixture))
                    }))
                    .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let pool = ensure_pool(&state, &cell).await.unwrap();
        wait_row(&pool, "tog", Some(ConnStatus::Connected)).await;

        // Disable: row stays, greyed out + enabled=false in mcp_list shape.
        set_mcp_enabled_flag(&state, "tog", false).unwrap();
        pool.disconnect("tog").await;
        let rows = status_rows(&state, &cell).await;
        let row = rows.iter().find(|r| r.row.name == "tog").unwrap();
        assert_eq!(row.row.status, ConnStatus::Disconnected);
        assert!(!row.enabled);

        // Enable: reconnects from the user config.
        set_mcp_enabled_flag(&state, "tog", true).unwrap();
        let config = fresh_config(&state, None, "tog", Scope::User).unwrap();
        pool.connect_entry(resolved("tog", config, None, Scope::User).unwrap())
            .await;
        let row = wait_row(&pool, "tog", Some(ConnStatus::Connected)).await;
        assert!(row.is_some());
        let rows = status_rows(&state, &cell).await;
        assert!(rows.iter().find(|r| r.row.name == "tog").unwrap().enabled);
    }

    #[tokio::test]
    async fn workspace_activation_connects_project_servers() {
        let Some(fixture) = echo_fixture_path() else {
            eprintln!("mcp-echo-fixture not built — skipping");
            return;
        };
        let (state, _dir) = temp_state();
        let cell = McpPoolCell::new();
        let workspace_dir = tempfile::tempdir().unwrap();
        state
            .update_config(|cfg| {
                cfg.workspaces = vec![tide_store::config::Workspace {
                    id: "ws_p".into(),
                    name: "proj".into(),
                    path: workspace_dir.path().display().to_string(),
                    branch: None,
                    archived_at: None,
                    extra: Default::default(),
                }];
                cfg.last_workspace_id = Some("ws_p".to_owned());
                Ok(())
            })
            .unwrap();
        std::fs::write(
            project_config_path(workspace_dir.path()),
            serde_json::to_string_pretty(&serde_json::json!({
                "proj-server": config_value(&fixture_config(&fixture))
            }))
            .unwrap(),
        )
        .unwrap();

        cell.set_active_workspace("ws_p", &workspace_dir.path().display().to_string());
        let config = state.read_config(|cfg| cfg.clone()).unwrap();
        cell.ensure_started(
            state.data_dir().to_path_buf(),
            config,
            Some(workspace_dir.path().display().to_string()),
        )
        .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let Some(pool) = cell.pool().await else {
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(25)).await;
                continue;
            };
            if let Some(row) = wait_row(&pool, "proj-server", None).await {
                if row.status == ConnStatus::Connected {
                    assert_eq!(row.scope, tide_mcp::McpScope::Project);
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "project server never connected: {:?}",
                pool.status_list().await
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    // ── OAuth start (mock IdP, tide-mcp test pattern) ───────────────────

    /// Minimal OAuth authorization server: RFC 8414 metadata + DCR. The
    /// MCP endpoint itself 404s — start_authorization only needs discovery
    /// and registration to build the authorize URL.
    fn spawn_mock_idp() -> String {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // Generous cap: discovery probes + register (+ the pool's failed
            // initial connect burning its own probes).
            for _ in 0..24 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    return;
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or_default().to_owned();
                // Headers first (through the blank line), THEN the body —
                // reading the body on the content-length header itself would
                // start at the terminator and deadlock the exchange.
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse().unwrap_or(0);
                        }
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let base = format!("http://127.0.0.1:{port}");
                let (status, json) = match path.as_str() {
                    "/.well-known/oauth-authorization-server" => (
                        200,
                        serde_json::json!({
                            "issuer": base,
                            "authorization_endpoint": format!("{base}/authorize"),
                            "token_endpoint": format!("{base}/token"),
                            "registration_endpoint": format!("{base}/register"),
                            "response_types_supported": ["code"],
                            "code_challenge_methods_supported": ["S256"],
                        }),
                    ),
                    "/register" => (
                        201,
                        serde_json::json!({
                            "client_id": "mock-client-id",
                            "client_id_issued_at": 1_700_000_000_u64,
                            "redirect_uris": []
                        }),
                    ),
                    _ => (404, serde_json::json!({"error": "not found"})),
                };
                let payload = serde_json::to_string(&json).unwrap();
                let reason = if status == 200 || status == 201 { "OK" } else { "Not Found" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn oauth_start_returns_the_authorization_url_and_opens_browser() {
        let (state, _dir) = temp_state();
        let idp_base = spawn_mock_idp();
        let remote = McpServerConfig {
            r#type: Some(McpTransportType::Http),
            url: Some(format!("{idp_base}/mcp")),
            auth: Some("oauth".to_owned()),
            ..Default::default()
        };
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_value(serde_json::json!({
                        "mock-remote": config_value(&remote)
                    }))
                    .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        let cell = McpPoolCell::new();
        let opened = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let capture = Arc::clone(&opened);
        cell.set_url_opener(Arc::new(move |url: &str| {
            capture.lock().unwrap().push(url.to_owned());
        }));
        let pool = ensure_pool(&state, &cell).await.unwrap();
        // The MCP endpoint 404s on the mock — wait for the row to settle so
        // start_authorization finds the stored config.
        wait_row(&pool, "mock-remote", None).await;

        let result = pool.start_authorization("mock-remote").await.unwrap();
        assert!(result.starts_with(&format!("{idp_base}/authorize")), "{result}");
        assert!(result.contains("127.0.0.1"), "loopback redirect: {result}");
        assert!(result.contains("code_challenge"), "PKCE: {result}");
        // The opener slot (the browser launch the app installs) fired.
        assert_eq!(opened.lock().unwrap().as_slice(), [result.as_str()]);

        // A non-remote server cannot start a flow.
        state
            .update_config(|cfg| {
                cfg.mcp_servers = Some(
                    serde_json::from_value(serde_json::json!({
                        "stdio-one": config_value(&stdio_config("nope"))
                    }))
                    .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        pool.connect_entry(
            resolved("stdio-one", stdio_config("nope"), None, Scope::User).unwrap(),
        )
        .await;
        assert!(pool.start_authorization("stdio-one").await.is_err());
    }
}
