//! M4 T5 terminal commands — the 8-method domain over the portable-pty
//! registry (`crate::terminal`). Rust names stay the snake_case of the
//! TideRPC methods, same convention as the other domains. Output/exit/ports
//! pushes ride the ChatHub bus via the registry; see `crate::terminal`.

use std::path::PathBuf;

use serde::Serialize;
use tide_store::sessions_v2::SessionsV2;

use crate::agent::hub::ChatHubCell;
use crate::state::AppState;
use crate::terminal::{TerminalCell, TerminalRegistry};

use super::CommandError;

/// `TerminalScrollbackResult` — `{ alive: true, data, seq } | { alive: false }`
/// via optional fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackResultWire {
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PidWire {
    pub pid: Option<u32>,
}

/// Resolve cwd from the live session store. Preference: session worktree
/// path, then the session's workspace path, then the workspace when
/// sessionId IS a workspace id (Run button before any session exists), then
/// $HOME.
fn resolve_cwd(state: &AppState, session_id: &str) -> PathBuf {
    let db_path = state.sessions_db_path();
    if db_path.is_file() {
        if let Ok(store) = SessionsV2::open(&db_path) {
            if let Ok(Some(worktree)) = store.session_worktree_of(session_id) {
                if let Some(path) = worktree.get("path").and_then(|v| v.as_str()) {
                    if std::path::Path::new(path).exists() {
                        return PathBuf::from(path);
                    }
                }
            }
            if let Ok(Some(meta)) = store.session_meta_by_id(session_id) {
                if std::path::Path::new(&meta.workspace_path).exists() {
                    return PathBuf::from(meta.workspace_path);
                }
            }
        }
    }
    let workspace_by_id = state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.id == session_id)
                .map(|ws| ws.path.clone())
        })
        .unwrap_or(None);
    if let Some(path) = workspace_by_id {
        if std::path::Path::new(&path).exists() {
            return PathBuf::from(path);
        }
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

async fn registry(
    state: &AppState,
    hub_cell: &ChatHubCell,
    terminals: &TerminalCell,
) -> Result<std::sync::Arc<TerminalRegistry>, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    Ok(terminals.get(hub.push_bus().clone()).await)
}

#[tauri::command]
pub async fn terminal_create(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    let cwd = resolve_cwd(&state, &session_id);
    // A failed spawn is not an error on the wire (TS returned {}); the
    // renderer's snapshot probe re-spawns on re-attach.
    registry.spawn_shell(&terminal_id, &cwd, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
    data: String,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    registry.write(&terminal_id, &data);
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    registry.resize(&terminal_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn terminal_stop(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    registry.stop(&terminal_id);
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    registry.kill(&terminal_id);
    Ok(())
}

/// Quit-lifecycle entry (TS `disposeTerminals`): kills every PTY.
#[tauri::command]
pub async fn terminal_dispose(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
) -> Result<(), CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    registry.dispose();
    Ok(())
}

#[tauri::command]
pub async fn terminal_scrollback(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
) -> Result<ScrollbackResultWire, CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    Ok(match registry.scrollback(&terminal_id).await {
        Some(snap) => ScrollbackResultWire {
            alive: true,
            data: Some(snap.data),
            seq: Some(snap.seq),
        },
        None => ScrollbackResultWire {
            alive: false,
            data: None,
            seq: None,
        },
    })
}

#[tauri::command]
pub async fn terminal_get_pid(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    terminals: tauri::State<'_, TerminalCell>,
    terminal_id: String,
) -> Result<PidWire, CommandError> {
    let registry = registry(&state, &hub_cell, &terminals).await?;
    Ok(PidWire {
        pid: registry.pid_of(&terminal_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_wire_matches_the_rpc_discriminated_union() {
        let alive = ScrollbackResultWire {
            alive: true,
            data: Some("out".into()),
            seq: Some(4),
        };
        assert_eq!(
            serde_json::to_value(&alive).unwrap(),
            serde_json::json!({ "alive": true, "data": "out", "seq": 4 })
        );
        let dead = ScrollbackResultWire {
            alive: false,
            data: None,
            seq: None,
        };
        assert_eq!(
            serde_json::to_value(&dead).unwrap(),
            serde_json::json!({ "alive": false })
        );
    }

    #[test]
    fn pid_wire_serializes_null_pid() {
        let wire = PidWire { pid: None };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!({ "pid": null })
        );
    }

    #[test]
    fn resolve_cwd_prefers_worktree_then_workspace_then_home() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::load(dir.path().to_path_buf());
        // No sessions db, no workspaces: $HOME.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        assert_eq!(resolve_cwd(&state, "s_none"), PathBuf::from(home));

        // sessionId IS a workspace id (Run button before any session exists).
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"workspaces":[{"id":"ws_run","name":"w","path":"SITE","wsFuture":false}]}"#
                .replace("SITE", &dir.path().display().to_string()),
        )
        .unwrap();
        let state = AppState::load(dir.path().to_path_buf());
        assert_eq!(
            resolve_cwd(&state, "ws_run"),
            PathBuf::from(dir.path().display().to_string())
        );
    }
}
