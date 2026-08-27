//! MCP commands — M3 keeps the read-only management surface (the TS
//! `mcpList` RPC): the pool's status rows. Mutating handlers (add/update/
//! remove/reload) and the OAuth-start plumbing land with the renderer's
//! MCP panel (M4); the Rust entry points already exist on
//! [`crate::agent::mcp::McpPoolCell`] → [`tide_mcp::McpPool`].

use tide_mcp::ServerStatusRow;

use crate::agent::mcp::McpPoolCell;
use crate::state::AppState;

use super::CommandError;

/// `mcpList` — status rows for the management panel. An absent pool (boot
/// init not finished / no servers configured) is an empty list, matching
/// the TS `getStatusList` on an empty pool.
#[tauri::command]
pub async fn mcp_list(
    state: tauri::State<'_, AppState>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
) -> Result<Vec<ServerStatusRow>, CommandError> {
    // Make sure something exists even if no chat turn ran yet (boot calls
    // ensure_started too; this is the idempotent fallback).
    mcp_cell
        .ensure_started(
            state.data_dir().to_path_buf(),
            state.read_config(|cfg| cfg.clone())?,
            None,
        )
        .await;
    match mcp_cell.pool().await {
        Some(pool) => Ok(pool.status_list().await),
        None => Ok(Vec::new()),
    }
}
