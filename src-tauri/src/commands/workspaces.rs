//! `workspaceList` — backs the TideRPC `workspaceList` method. Port of the
//! 91ec558 producer (`configStore.listWorkspaces`): stored entries pass
//! through verbatim (the config already persists the full wire shape —
//! branch/headCommit/fileCount/scripts ride tide-store's flatten-preserved
//! extras) with `ragConfig` hydrated at read time so workspaces persisted
//! before RAG config existed still get a fully-shaped block.

use serde_json::{Map, Value};
use tide_store::config::Workspace;

use crate::state::AppState;

use super::CommandError;

#[tauri::command]
pub fn workspace_list(state: tauri::State<AppState>) -> Result<Vec<Value>, CommandError> {
    list(&state)
}

fn list(state: &AppState) -> Result<Vec<Value>, CommandError> {
    state.read_config(|cfg| cfg.workspaces.iter().map(workspace_wire).collect())
}

fn workspace_wire(ws: &Workspace) -> Value {
    let mut wire = serde_json::to_value(ws).expect("stored workspace serializes");
    hydrate_rag_config(&mut wire);
    wire
}

/// Max input tokens per embedder variant (91ec558 kept the same table beside
/// hydrateRagConfig so hydration stays free of the embedder modules).
fn embedder_max_tokens(embedder_id: &str) -> Option<u64> {
    match embedder_id {
        "local-code-512" => Some(512),
        "cloud-base" => Some(256),
        _ => None,
    }
}

/// Port of `hydrateRagConfig` (91ec558 configStore): fill missing fields,
/// force `dim` to 384, and clamp `chunkTokens` to the recorded embedder's
/// max so a workspace flipped between embedders never keeps an
/// un-embeddable chunk size.
fn hydrate_rag_config(ws: &mut Value) {
    let Some(obj) = ws.as_object_mut() else {
        return;
    };
    let input: Map<String, Value> = obj
        .get("ragConfig")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let embedder_id = input
        .get("embedderId")
        .and_then(Value::as_str)
        .unwrap_or("local-code-512");
    let chunk_tokens = input
        .get("chunkTokens")
        .and_then(Value::as_u64)
        .unwrap_or(384);
    let chunk_tokens = embedder_max_tokens(embedder_id).map_or(chunk_tokens, |max| {
        chunk_tokens.min(max)
    });
    let cloud_allowed = input
        .get("cloudAllowed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    obj.insert(
        "ragConfig".to_string(),
        serde_json::json!({
            "embedderId": embedder_id,
            "dim": 384,
            "cloudAllowed": cloud_allowed,
            "chunkTokens": chunk_tokens,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_with_config(name: &str, config_json: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(dir.join("config.json"), config_json).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    #[test]
    fn passes_stored_fields_through_and_hydrates_missing_rag_config() {
        let (state, dir) = state_with_config(
            "hydrate",
            r#"{"workspaces":[{
                "id": "ws_1", "name": "tide", "path": "/repo/tide",
                "branch": "main", "headCommit": "1cd734e", "isDefault": false,
                "fileCount": 448, "worktreeLocation": ".agent/worktrees/",
                "scripts": [{ "kind": "run", "command": "pnpm dev" }]
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0],
            serde_json::json!({
                "id": "ws_1", "name": "tide", "path": "/repo/tide",
                "branch": "main", "headCommit": "1cd734e", "isDefault": false,
                "fileCount": 448, "worktreeLocation": ".agent/worktrees/",
                "scripts": [{ "kind": "run", "command": "pnpm dev" }],
                "ragConfig": {
                    "embedderId": "local-code-512", "dim": 384,
                    "cloudAllowed": false, "chunkTokens": 384
                }
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clamps_chunk_tokens_to_embedder_max_and_keeps_cloud_flag() {
        let (state, dir) = state_with_config(
            "clamp",
            r#"{"workspaces":[{
                "id": "ws_2", "name": "x", "path": "/x",
                "ragConfig": { "embedderId": "local-code-512", "chunkTokens": 999, "cloudAllowed": true }
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(
            workspaces[0]["ragConfig"],
            serde_json::json!({
                "embedderId": "local-code-512", "dim": 384,
                "cloudAllowed": true, "chunkTokens": 512
            })
        );

        let (state, dir2) = state_with_config(
            "clamp-cloud",
            r#"{"workspaces":[{
                "id": "ws_3", "name": "x", "path": "/x",
                "ragConfig": { "embedderId": "cloud-base", "chunkTokens": 384 }
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces[0]["ragConfig"]["chunkTokens"], serde_json::json!(256));
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&dir2).unwrap();
    }

    #[test]
    fn archived_workspace_keeps_archived_at_and_order_follows_config() {
        let (state, dir) = state_with_config(
            "archived",
            r#"{"workspaces":[
                { "id": "ws_a", "name": "a", "path": "/a", "archivedAt": "2026-01-01T00:00:00.000Z" },
                { "id": "ws_b", "name": "b", "path": "/b" }
            ]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0]["id"], "ws_a");
        assert_eq!(workspaces[0]["archivedAt"], "2026-01-01T00:00:00.000Z");
        assert!(workspaces[1].as_object().unwrap().get("archivedAt").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_and_unreadable_configs() {
        let (state, dir) = state_with_config("empty", "{}");
        assert!(list(&state).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();

        let (state, dir) = state_with_config("broken", "{ nope");
        let err = list(&state).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
