//! M1 command domains. Each command's Rust name is the snake_case of the
//! exact TideRPC method it backs (`shared/rpc.ts`) so the renderer bridge
//! maps method → command 1:1: `sessionListV2` → `session_list_v2`,
//! `settingsGetAgent` → `settings_get_agent`, `workspaceList` →
//! `workspace_list`, `providerList` → `provider_list`, …

// Submodules are pub so `commands::<module>::<command>` paths resolve in
// generate_handler! — the macro it expands to looks up each command's hidden
// __cmd__*/__tauri_command_name_* items next to the fn. `mod commands` is
// crate-private, so nothing leaks outside the crate.
pub mod boot;
pub mod bridge;
pub mod chat;
pub mod mcp;
pub mod misc;
pub mod providers;
pub mod sessions;
pub mod settings;
pub mod shortcuts;
pub mod worktree;
pub mod workspaces;

use serde::Serialize;
use tide_store::config::ConfigError;
use tide_store::sessions_v2::SessionsV2Error;

/// The error contract for every command: serializes to `{ message, code? }`,
/// which is the value an `invoke` rejection delivers to the renderer bridge.
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl CommandError {
    pub fn with_code(message: impl Into<String>, code: &str) -> Self {
        Self {
            message: message.into(),
            code: Some(code.to_string()),
        }
    }
}

impl From<ConfigError> for CommandError {
    fn from(e: ConfigError) -> Self {
        let code = match e {
            ConfigError::Parse(_) => "CONFIG_PARSE",
            ConfigError::Io(_) => "CONFIG_IO",
        };
        CommandError::with_code(e.to_string(), code)
    }
}

impl From<SessionsV2Error> for CommandError {
    fn from(e: SessionsV2Error) -> Self {
        let code = match &e {
            SessionsV2Error::Open { .. } => "DB_OPEN",
            SessionsV2Error::UnsupportedSchema { .. } => "DB_SCHEMA",
            SessionsV2Error::Db(_) => "DB",
            SessionsV2Error::InvalidPartData { .. } => "DB_PART_DATA",
            SessionsV2Error::MalformedEvent { .. } => "DB_EVENT_SHAPE",
            SessionsV2Error::InvalidEventData { .. } => "DB_EVENT_DATA",
        };
        CommandError::with_code(e.to_string(), code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_message_only_when_no_code() {
        let err = CommandError {
            message: "boom".into(),
            code: None,
        };
        assert_eq!(serde_json::to_value(err).unwrap(), serde_json::json!({ "message": "boom" }));
    }

    #[test]
    fn serializes_message_and_code() {
        let wire = serde_json::to_value(CommandError::with_code("nope", "DB_SCHEMA")).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "message": "nope", "code": "DB_SCHEMA" })
        );
    }

    #[test]
    fn sessions_v2_errors_map_to_codes() {
        let open = SessionsV2Error::Open {
            path: "/x/sessions-v2.db".into(),
            cause: "file not found".into(),
        };
        assert_eq!(CommandError::from(open).code.as_deref(), Some("DB_OPEN"));

        let schema = SessionsV2Error::UnsupportedSchema { found: 3 };
        assert_eq!(CommandError::from(schema).code.as_deref(), Some("DB_SCHEMA"));
    }
}
