//! MCP server config resolution — port of `app/core/agent/mcp/config.ts` +
//! `types.ts` @ 91ec558 under the consolidated-config rules (memory:
//! mcp.json + extensions.json were merged into config.json):
//! - user-scope servers live in config.json's top-level `mcpServers`;
//! - project-scope server definitions live in `<workspace>/.mcp.json` on
//!   disk (flat map or `{ "mcpServers": {...} }` wrapper);
//! - project wins on name collision (TS `mergeConfigs`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tide_store::config::Config;

/// Where a server config lives — determines credential storage and
/// connection lifetime (user servers are app-lifetime, project servers
/// workspace-lifetime). `builtin` existed in the TS pool; the Tauri port
/// has no built-in MCP servers yet (none shipped in the fixture either).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    User,
    Project,
}

impl McpScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpScope::User => "user",
            McpScope::Project => "project",
        }
    }
}

/// Transport type. `sse` entries are served by the streamable-http client
/// (rmcp 3 dropped the standalone SSE transport; streamable HTTP speaks the
/// same SSE responses).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportType {
    Stdio,
    Sse,
    Http,
}

/// A single server's configuration — one entry in the server map. Unknown
/// fields survive in `extra` so hand-edited configs round-trip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<McpTransportType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    /// Set to `"oauth"` for OAuth-protected remote servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl McpServerConfig {
    /// Effective transport — inferred like the TS: `command` → stdio,
    /// `url` → http, stdio as the last-resort default.
    pub fn transport(&self) -> McpTransportType {
        self.r#type.unwrap_or(match (&self.command, &self.url) {
            (Some(_), _) => McpTransportType::Stdio,
            (None, Some(_)) => McpTransportType::Http,
            (None, None) => McpTransportType::Stdio,
        })
    }

    /// Validation errors (empty = valid) — port of `validateServerConfig`.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        match self.transport() {
            McpTransportType::Stdio => {
                if self.command.is_none() {
                    errors.push(r#"stdio servers require "command""#.to_owned());
                }
            }
            McpTransportType::Sse | McpTransportType::Http => {
                if self.url.is_none() {
                    errors.push(r#"remote servers require "url""#.to_owned());
                }
            }
        }
        errors
    }
}

/// The server map for one source (user config or one workspace).
pub type McpConfigFile = BTreeMap<String, McpServerConfig>;

/// Parse a raw server map value (config.json keeps untyped entries so the
/// lossless round-trip in tide-store isn't disturbed).
fn parse_map(value: &serde_json::Value) -> McpConfigFile {
    let Some(entries) = value.as_object() else {
        return McpConfigFile::new();
    };
    let mut out = McpConfigFile::new();
    for (name, raw) in entries {
        match serde_json::from_value::<McpServerConfig>(raw.clone()) {
            Ok(config) => {
                out.insert(name.clone(), config);
            }
            // Unparseable entries are skipped, not fatal — the TS JSON parse
            // path returned {} on any error.
            Err(_) => continue,
        }
    }
    out
}

/// User-scope servers from config.json's `mcpServers`.
pub fn user_servers(config: &Config) -> McpConfigFile {
    config
        .mcp_servers
        .as_ref()
        .map(|m| parse_map(&serde_json::Value::Object(m.clone())))
        .unwrap_or_default()
}

/// Project-scope servers from `<workspace_root>/.mcp.json` — flat map or a
/// `{ "mcpServers": ... }` wrapper; missing/unreadable file = empty.
pub fn project_servers(workspace_root: &Path) -> McpConfigFile {
    let path = project_config_path(workspace_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return McpConfigFile::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return McpConfigFile::new();
    };
    let Some(obj) = parsed.as_object() else {
        return McpConfigFile::new();
    };
    match obj.get("mcpServers") {
        Some(servers) if servers.is_object() => parse_map(servers),
        _ => parse_map(&parsed),
    }
}

/// `<workspace_root>/.mcp.json`.
pub fn project_config_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".mcp.json")
}

/// Merge user + project configs; project wins on name collision.
pub fn merge_configs(user: &McpConfigFile, project: &McpConfigFile) -> McpConfigFile {
    let mut merged = user.clone();
    for (name, config) in project {
        merged.insert(name.clone(), config.clone());
    }
    merged
}

/// One resolved pool entry: the server config plus where it came from.
#[derive(Debug, Clone)]
pub struct ResolvedServer {
    pub name: String,
    pub config: McpServerConfig,
    pub scope: McpScope,
    /// Workspace id for project-scope servers (credential storage key).
    pub workspace_id: Option<String>,
    /// Filesystem root for project-scope servers.
    pub workspace_root: Option<PathBuf>,
}

/// Resolve every server the pool should own for a given workspace: user
/// servers from `config` + project servers from `<workspace_root>/.mcp.json`.
/// Entries that fail validation are returned as `invalid` so the pool can
/// surface them as error rows instead of silently dropping them (the TS
/// surfaced validation only in the settings dialog; the pool connected and
/// failed — here the failure is explicit from the start).
pub fn resolve_servers(
    config: &Config,
    workspace: Option<(&str, &Path)>,
) -> (Vec<ResolvedServer>, Vec<(String, String)>) {
    let mut invalid = Vec::new();
    let mut by_name: std::collections::BTreeMap<String, ResolvedServer> =
        std::collections::BTreeMap::new();
    for (name, server_config) in user_servers(config) {
        let errors = server_config.validate();
        if errors.is_empty() {
            by_name.insert(
                name.clone(),
                ResolvedServer {
                    name,
                    config: server_config,
                    scope: McpScope::User,
                    workspace_id: None,
                    workspace_root: None,
                },
            );
        } else {
            invalid.push((name, errors.join("; ")));
        }
    }
    if let Some((workspace_id, workspace_root)) = workspace {
        for (name, server_config) in project_servers(workspace_root) {
            let errors = server_config.validate();
            if errors.is_empty() {
                // Project wins on collision (insert over the user entry).
                by_name.insert(
                    name.clone(),
                    ResolvedServer {
                        name,
                        config: server_config,
                        scope: McpScope::Project,
                        workspace_id: Some(workspace_id.to_owned()),
                        workspace_root: Some(workspace_root.to_path_buf()),
                    },
                );
            } else {
                invalid.push((name, errors.join("; ")));
            }
        }
    }
    (by_name.into_values().collect(), invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_inference_matches_ts() {
        let stdio: McpServerConfig =
            serde_json::from_str(r#"{"command":"npx","args":["-y","x"]}"#).unwrap();
        assert_eq!(stdio.transport(), McpTransportType::Stdio);
        let http: McpServerConfig = serde_json::from_str(r#"{"url":"https://mcp/x"}"#).unwrap();
        assert_eq!(http.transport(), McpTransportType::Http);
        let explicit: McpServerConfig =
            serde_json::from_str(r#"{"type":"http","url":"https://mcp/x"}"#).unwrap();
        assert_eq!(explicit.transport(), McpTransportType::Http);
        let sse: McpServerConfig =
            serde_json::from_str(r#"{"type":"sse","url":"https://mcp/sse"}"#).unwrap();
        assert_eq!(sse.transport(), McpTransportType::Sse);
        assert!(stdio.validate().is_empty());
        assert!(!sse.validate().is_empty() || sse.url.is_some());
        let broken = McpServerConfig::default();
        assert!(!broken.validate().is_empty());
    }

    #[test]
    fn project_config_reads_flat_and_wrapped_shapes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            project_config_path(dir.path()),
            r#"{"flat": {"command": "a"}, "mcpServers": {"wrapped": {"command": "b"}}}"#,
        )
        .unwrap();
        let servers = project_servers(dir.path());
        // A file carrying BOTH shapes: the wrapper wins per the TS read order.
        assert!(servers.contains_key("wrapped"));
        let dir2 = tempfile::tempdir().unwrap();
        std::fs::write(project_config_path(dir2.path()), r#"{"x": {"command": "a"}}"#).unwrap();
        assert!(project_servers(dir2.path()).contains_key("x"));
        assert!(project_servers(tempfile::tempdir().unwrap().path()).is_empty());
        std::fs::write(
            project_config_path(dir2.path()),
            "{ not json",
        )
        .unwrap();
        assert!(project_servers(dir2.path()).is_empty());
    }

    #[test]
    fn resolve_merges_user_and_project_with_project_priority() {
        let config = Config {
            mcp_servers: Some(serde_json::from_str(
                r#"{"shared": {"command": "user-cmd"}, "userOnly": {"type": "http", "url": "https://mcp"}}"#,
            )
            .unwrap()),
            ..Default::default()
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            project_config_path(dir.path()),
            r#"{"mcpServers": {"shared": {"command": "project-cmd"}, "proj": {"command": "p"}}}"#,
        )
        .unwrap();
        let (resolved, invalid) = resolve_servers(&config, Some(("ws_1", dir.path())));
        assert!(invalid.is_empty());
        assert_eq!(resolved.len(), 3);
        let shared = resolved.iter().find(|r| r.name == "shared").unwrap();
        assert_eq!(shared.config.command.as_deref(), Some("project-cmd"));
        assert_eq!(shared.scope, McpScope::Project);
        assert_eq!(shared.workspace_id.as_deref(), Some("ws_1"));
        let user_only = resolved.iter().find(|r| r.name == "userOnly").unwrap();
        assert_eq!(user_only.scope, McpScope::User);
        assert!(user_only.workspace_root.is_none());
    }

    #[test]
    fn invalid_entries_are_reported_not_dropped() {
        let config = Config {
            mcp_servers: Some(serde_json::from_str(r#"{"bad": {"type": "http"}}"#).unwrap()),
            ..Default::default()
        };
        let (resolved, invalid) = resolve_servers(&config, None);
        assert!(resolved.is_empty());
        assert_eq!(invalid.len(), 1);
        assert_eq!(invalid[0].0, "bad");
        assert!(invalid[0].1.contains("url"));
    }

    #[test]
    fn unknown_config_fields_round_trip() {
        let raw = r#"{"type":"http","url":"https://mcp","headers":{"Authorization":"Bearer x"},"futureField":7}"#;
        let parsed: McpServerConfig = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["futureField"], 7);
        assert_eq!(back["headers"]["Authorization"], "Bearer x");
    }
}
