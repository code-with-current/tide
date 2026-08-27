//! MCP import scanner — port of `app/core/agent/mcp/scanner.ts` @ 91ec558.
//! Detects servers from other tools' config files (Claude Code, Codex,
//! OpenCode, generic) and normalizes them to Tide's [`McpServerConfig`].
//!
//! Deviation from the TS: the already-imported list comes from the resolved
//! user server map (config.json's `mcpServers`) instead of a raw read of the
//! legacy `mcp.json` — post-migration that file is not where Tide's servers
//! live, and the intent is "names already present in Tide's config".

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::{McpConfigFile, McpServerConfig, McpTransportType};

/// A server detected in another tool's config file — the TS `DetectedServer`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedServer {
    pub name: String,
    pub config: McpServerConfig,
    /// Display label: "Claude Code", "Codex", etc.
    pub source: String,
    /// The file path it came from.
    pub source_file: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub servers: Vec<DetectedServer>,
    /// Names already present in Tide's config (so the UI can pre-uncheck).
    pub already_imported: Vec<String>,
}

/// Scan all known sources under `home` for MCP server configs.
pub fn scan_external_mcp_servers(home: &Path, tide_servers: &McpConfigFile) -> ScanResult {
    let mut detected: Vec<DetectedServer> = Vec::new();

    // 1. Claude Code — ~/.claude.json (root-level mcpServers).
    scan_json_file(
        &home.join(".claude.json"),
        "Claude Code",
        &mut detected,
        extract_mcp_servers,
    );
    // 1b. Claude Code — ~/.claude/settings.json (mcpServers key).
    scan_json_file(
        &home.join(".claude").join("settings.json"),
        "Claude Code",
        &mut detected,
        extract_mcp_servers,
    );
    // 2. Codex CLI — ~/.codex/config.toml ([mcp_servers.*] sections).
    scan_codex_toml(&home.join(".codex").join("config.toml"), &mut detected);
    // 3. OpenCode — ~/.config/opencode/opencode.json (mcp key).
    scan_json_file(
        &home.join(".config").join("opencode").join("opencode.json"),
        "OpenCode",
        &mut detected,
        |d| d.get("mcp").and_then(Value::as_object),
    );
    // 4. Generic — ~/.agents/mcp.json (mcpServers wrapper OR flat map).
    scan_json_file(
        &home.join(".agents").join("mcp.json"),
        "Generic",
        &mut detected,
        extract_generic_servers,
    );

    // Deduplicate by name (first source wins per name).
    let mut seen = std::collections::BTreeSet::new();
    detected.retain(|server| seen.insert(server.name.clone()));

    ScanResult {
        servers: detected,
        already_imported: tide_servers.keys().cloned().collect(),
    }
}

// ─── JSON source scanner ──────────────────────────────────────────────

type Extractor = fn(&Map<String, Value>) -> Option<&Map<String, Value>>;

fn extract_mcp_servers(data: &Map<String, Value>) -> Option<&Map<String, Value>> {
    data.get("mcpServers").and_then(Value::as_object)
}

fn extract_generic_servers(data: &Map<String, Value>) -> Option<&Map<String, Value>> {
    if let Some(servers) = data.get("mcpServers") {
        return servers.as_object();
    }
    // If all values look like server configs (objects), treat as flat.
    if !data.is_empty() && data.values().all(|v| v.is_object()) {
        return Some(data);
    }
    None
}

fn scan_json_file(
    file_path: &Path,
    source_label: &str,
    out: &mut Vec<DetectedServer>,
    extract: Extractor,
) {
    // Missing/unparseable file — skip silently like the TS.
    let Ok(raw) = std::fs::read_to_string(file_path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(root) = parsed.as_object() else {
        return;
    };
    let Some(servers) = extract(root) else {
        return;
    };
    for (name, raw_config) in servers {
        let Some(raw_map) = raw_config.as_object() else {
            continue;
        };
        if let Some(config) = normalize_external_config(raw_map) {
            out.push(DetectedServer {
                name: name.clone(),
                config,
                source: source_label.to_owned(),
                source_file: file_path.display().to_string(),
            });
        }
    }
}

// ─── Codex TOML scanner ───────────────────────────────────────────────

/// Minimal TOML reader for `[mcp_servers.NAME]` sections (plus env /
/// http_headers sub-tables) — the TS parser's exact subset, not full TOML.
fn scan_codex_toml(file_path: &Path, out: &mut Vec<DetectedServer>) {
    let Ok(raw) = std::fs::read_to_string(file_path) else {
        return;
    };
    for (name, config) in parse_toml_mcp_servers(&raw) {
        if let Some(normalized) = normalize_external_config(&config) {
            out.push(DetectedServer {
                name,
                config: normalized,
                source: "Codex".to_owned(),
                source_file: file_path.display().to_string(),
            });
        }
    }
}

fn parse_toml_mcp_servers(toml: &str) -> BTreeMap<String, Map<String, Value>> {
    let mut result: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut current_server: Option<String> = None;
    let mut current_sub_table: Option<String> = None;

    for line in toml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // [mcp_servers.NAME.env] / [mcp_servers.NAME.http_headers], or the
        // bare [mcp_servers.NAME] — the TS regexes' exact subset.
        if let Some(rest) = trimmed.strip_prefix("[mcp_servers.") {
            if let Some(section) = rest.strip_suffix(']') {
                if let Some((name, sub)) = section.split_once('.') {
                    if sub == "env" || sub == "http_headers" {
                        current_server = Some(name.to_owned());
                        current_sub_table = Some(sub.to_owned());
                        let server = result.entry(name.to_owned()).or_default();
                        server
                            .entry(sub.to_owned())
                            .or_insert_with(|| Value::Object(Map::new()));
                        continue;
                    }
                } else {
                    current_server = Some(section.to_owned());
                    current_sub_table = None;
                    result.entry(section.to_owned()).or_default();
                    continue;
                }
            }
        }

        // Any other [section] — reset context.
        if trimmed.starts_with('[') {
            current_server = None;
            current_sub_table = None;
            continue;
        }

        let Some(server_name) = current_server.clone() else {
            continue;
        };
        let Some((key, value_raw)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value_raw = value_raw.trim();
        let server = result.entry(server_name).or_default();

        // Inline table: { K = "V", ... }
        if value_raw.starts_with('{') {
            server.insert(key.to_owned(), Value::Object(parse_inline_toml_table(value_raw)));
            continue;
        }
        // Array: ["a", "b"]
        if value_raw.starts_with('[') {
            let items = parse_toml_array(value_raw);
            server.insert(
                key.to_owned(),
                Value::Array(items.into_iter().map(Value::String).collect()),
            );
            continue;
        }
        // String: "value" — sub-table keys nest under env/http_headers.
        if let Some(value) = value_raw
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
        {
            match &current_sub_table {
                Some(sub) if sub == "env" || sub == "http_headers" => {
                    if let Some(sub_map) = server
                        .get(sub)
                        .and_then(Value::as_object)
                        .cloned()
                    {
                        let mut merged = sub_map;
                        merged.insert(key.to_owned(), Value::String(value.to_owned()));
                        server.insert(sub.clone(), Value::Object(merged));
                    }
                }
                _ => {
                    server.insert(key.to_owned(), Value::String(value.to_owned()));
                }
            }
            continue;
        }
        // Bare value (number, bool) — kept as the raw string, TS parity.
        server.insert(key.to_owned(), Value::String(value_raw.to_owned()));
    }

    result
}

fn parse_inline_toml_table(raw: &str) -> Map<String, Value> {
    let mut result = Map::new();
    let inner = raw
        .strip_prefix('{')
        .and_then(|r| r.strip_suffix('}'))
        .unwrap_or(raw)
        .trim();
    // Naive comma split — doesn't handle commas inside values (TS parity).
    for part in inner.split(',') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let value = v
            .trim()
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(v.trim());
        result.insert(k.trim().to_owned(), Value::String(value.to_owned()));
    }
    result
}

fn parse_toml_array(raw: &str) -> Vec<String> {
    let inner = raw
        .strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .unwrap_or(raw)
        .trim();
    if inner.is_empty() {
        return Vec::new();
    }
    inner
        .split(',')
        .map(|s| {
            s.trim()
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(s.trim())
                .to_owned()
        })
        .collect()
}

// ─── Normalizer ───────────────────────────────────────────────────────

/// Normalize an external server config to Tide's format, inferring type
/// from `command` (stdio) or `url` (http); None when no transport can be
/// determined (the entry is skipped).
fn normalize_external_config(raw: &Map<String, Value>) -> Option<McpServerConfig> {
    let mut config = McpServerConfig::default();

    if let Some(kind) = raw.get("type").and_then(Value::as_str) {
        config.r#type = match kind {
            "stdio" => Some(McpTransportType::Stdio),
            "sse" => Some(McpTransportType::Sse),
            "http" => Some(McpTransportType::Http),
            _ => None,
        };
    }
    if config.r#type.is_none() {
        if raw.get("command").and_then(Value::as_str).is_some() {
            config.r#type = Some(McpTransportType::Stdio);
        } else if raw.get("url").and_then(Value::as_str).is_some() {
            config.r#type = Some(McpTransportType::Http);
        } else {
            return None;
        }
    }

    if let Some(command) = raw.get("command").and_then(Value::as_str) {
        config.command = Some(command.to_owned());
    }
    if let Some(args) = raw.get("args").and_then(Value::as_array) {
        let filtered: Vec<String> = args
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if !filtered.is_empty() {
            config.args = Some(filtered);
        }
    }
    if let Some(env) = raw.get("env").and_then(Value::as_object) {
        let mut resolved = BTreeMap::new();
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                resolved.insert(key.clone(), value.to_owned());
            }
        }
        if !resolved.is_empty() {
            config.env = Some(resolved);
        }
    }
    if let Some(url) = raw.get("url").and_then(Value::as_str) {
        config.url = Some(url.to_owned());
    }
    // Codex `http_headers` has no Tide mapping (TS parity — skipped; the
    // user can re-add headers manually).

    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn json_sources_are_normalized_and_labeled() {
        let home = scan_home();
        std::fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers": {"context7": {"type": "http", "url": "https://c7.mcp/dev"}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join(".config").join("opencode")).unwrap();
        std::fs::write(
            home.path().join(".config").join("opencode").join("opencode.json"),
            r#"{"mcp": {"gh": {"command": "npx", "args": ["-y", "gh-mcp"], "env": {"T": "1"}}}}"#,
        )
        .unwrap();
        let result = scan_external_mcp_servers(home.path(), &McpConfigFile::new());
        assert_eq!(result.servers.len(), 2);
        let c7 = result.servers.iter().find(|s| s.name == "context7").unwrap();
        assert_eq!(c7.source, "Claude Code");
        assert_eq!(c7.config.r#type, Some(McpTransportType::Http));
        assert_eq!(c7.config.url.as_deref(), Some("https://c7.mcp/dev"));
        assert!(c7.source_file.ends_with(".claude.json"));
        let gh = result.servers.iter().find(|s| s.name == "gh").unwrap();
        assert_eq!(gh.source, "OpenCode");
        assert_eq!(gh.config.r#type, Some(McpTransportType::Stdio));
        assert_eq!(gh.config.command.as_deref(), Some("npx"));
        assert_eq!(
            gh.config.args.as_deref(),
            Some(&["-y".to_owned(), "gh-mcp".to_owned()][..])
        );
        assert_eq!(gh.config.env.as_ref().unwrap()["T"], "1");
    }

    #[test]
    fn codex_toml_sections_parse_with_env_subtables() {
        let home = scan_home();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex").join("config.toml"),
            r#"
# comment
[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]

[mcp_servers.fetch.env]
FETCH_TIMEOUT = "30"

[other_section]
key = "ignored"
"#,
        )
        .unwrap();
        let result = scan_external_mcp_servers(home.path(), &McpConfigFile::new());
        assert_eq!(result.servers.len(), 1);
        let fetch = &result.servers[0];
        assert_eq!(fetch.name, "fetch");
        assert_eq!(fetch.source, "Codex");
        assert_eq!(fetch.config.command.as_deref(), Some("uvx"));
        assert_eq!(
            fetch.config.args.as_deref(),
            Some(&["mcp-server-fetch".to_owned()][..])
        );
        assert_eq!(fetch.config.env.as_ref().unwrap()["FETCH_TIMEOUT"], "30");
    }

    #[test]
    fn generic_source_accepts_wrapper_and_flat_maps() {
        let home = scan_home();
        std::fs::create_dir_all(home.path().join(".agents")).unwrap();
        std::fs::write(
            home.path().join(".agents").join("mcp.json"),
            r#"{"a": {"command": "run-a"}, "mcpServers": {"b": {"command": "run-b"}}}"#,
        )
        .unwrap();
        let result = scan_external_mcp_servers(home.path(), &McpConfigFile::new());
        // The wrapper wins per the TS extract order.
        assert_eq!(result.servers.len(), 1);
        assert_eq!(result.servers[0].name, "b");
        assert_eq!(result.servers[0].source, "Generic");
    }

    #[test]
    fn dedup_keeps_first_source_and_marks_already_imported() {
        let home = scan_home();
        std::fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers": {"shared": {"command": "from-claude"}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(
            home.path().join(".claude").join("settings.json"),
            r#"{"mcpServers": {"shared": {"command": "from-settings"}, "only-settings": {"url": "https://x"}}}"#,
        )
        .unwrap();
        let mut tide = McpConfigFile::new();
        tide.insert(
            "shared".to_owned(),
            serde_json::from_str(r#"{"command": "mine"}"#).unwrap(),
        );
        let result = scan_external_mcp_servers(home.path(), &tide);
        assert_eq!(result.servers.len(), 2);
        let shared = result.servers.iter().find(|s| s.name == "shared").unwrap();
        assert_eq!(shared.config.command.as_deref(), Some("from-claude"));
        assert_eq!(result.already_imported, vec!["shared".to_owned()]);
    }

    #[test]
    fn entries_without_a_transport_are_skipped() {
        let home = scan_home();
        std::fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers": {"mystery": {"note": "no command or url"}, "fine": {"command": "ok"}}}"#,
        )
        .unwrap();
        let result = scan_external_mcp_servers(home.path(), &McpConfigFile::new());
        assert_eq!(result.servers.len(), 1);
        assert_eq!(result.servers[0].name, "fine");
    }

    #[test]
    fn missing_sources_scan_clean() {
        let home = scan_home();
        let result = scan_external_mcp_servers(home.path(), &McpConfigFile::new());
        assert!(result.servers.is_empty());
        assert!(result.already_imported.is_empty());
    }
}
