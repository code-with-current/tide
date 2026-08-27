//! MCP secret resolution — port of `app/core/agent/mcp/secrets.ts` @
//! 91ec558: `{{secret:name}}` placeholders in a server's env values and
//! args are resolved from `<data_dir>/mcp-secrets.json` (a flat name →
//! value map). Missing names surface as `needs_credentials` pool state.
//!
//! Deviation from the TS: values are stored (and read) as plain JSON, not
//! safeStorage-encrypted base64 — the Tauri shell has no safeStorage
//! equivalent yet; the M4 keychain work can wrap this file the way
//! tide-store::secrets wraps provider keys.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SECRETS_FILE: &str = "mcp-secrets.json";

pub fn secrets_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SECRETS_FILE)
}

fn read_secrets(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(secrets_path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Resolve `{{secret:name}}` placeholders in an env map. Inline values pass
/// through; missing secrets are reported by name (the pool turns those into
/// a `needs_credentials` row).
pub fn resolve_secrets(
    data_dir: &Path,
    values: &BTreeMap<String, String>,
) -> (BTreeMap<String, String>, Vec<String>) {
    let secrets = read_secrets(data_dir);
    let mut resolved = BTreeMap::new();
    let mut missing = Vec::new();
    for (key, value) in values {
        match secret_name(value) {
            Some(name) => match secrets.get(name) {
                Some(secret) => {
                    resolved.insert(key.clone(), secret.clone());
                }
                None => missing.push(name.to_owned()),
            },
            None => {
                resolved.insert(key.clone(), value.clone());
            }
        }
    }
    (resolved, missing)
}

/// Resolve placeholders in an args array — placeholders are kept in place
/// when missing so the arg count is stable (TS behavior).
pub fn resolve_args_secrets(
    data_dir: &Path,
    args: &[String],
) -> (Vec<String>, Vec<String>) {
    let secrets = read_secrets(data_dir);
    let mut resolved = Vec::with_capacity(args.len());
    let mut missing = Vec::new();
    for arg in args {
        match secret_name(arg) {
            Some(name) => match secrets.get(name) {
                Some(secret) => resolved.push(secret.clone()),
                None => {
                    missing.push(name.to_owned());
                    resolved.push(arg.clone());
                }
            },
            None => resolved.push(arg.clone()),
        }
    }
    (resolved, missing)
}

/// `{{secret:name}}` → `name`.
fn secret_name(value: &str) -> Option<&str> {
    let inner = value
        .strip_prefix("{{secret:")
        .and_then(|rest| rest.strip_suffix("}}"))?;
    (!inner.is_empty() && !inner.contains('}')).then_some(inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with_secrets(content: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(secrets_path(dir.path()), content).unwrap();
        dir
    }

    #[test]
    fn placeholders_resolve_and_missing_names_reported() {
        let dir = dir_with_secrets(r#"{"API_KEY": "sk-live"}"#);
        let env: BTreeMap<String, String> = [
            ("TOKEN", "{{secret:API_KEY}}".to_owned()),
            ("PLAIN", "inline".to_owned()),
            ("GONE", "{{secret:NOPE}}".to_owned()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        let (resolved, missing) = resolve_secrets(dir.path(), &env);
        assert_eq!(resolved["TOKEN"], "sk-live");
        assert_eq!(resolved["PLAIN"], "inline");
        assert_eq!(missing, vec!["NOPE".to_owned()]);

        let args = vec!["-k".to_owned(), "{{secret:API_KEY}}".to_owned()];
        let (args, missing) = resolve_args_secrets(dir.path(), &args);
        assert_eq!(args, vec!["-k".to_owned(), "sk-live".to_owned()]);
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_file_means_every_placeholder_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = [("X", "{{secret:ANY}}".to_owned())]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect();
        let (resolved, missing) = resolve_secrets(dir.path(), &env);
        assert!(resolved.is_empty());
        assert_eq!(missing, vec!["ANY".to_owned()]);
    }

    #[test]
    fn non_placeholder_braces_are_inline_values() {
        let value = "{{not-a-secret}}";
        assert_eq!(secret_name(value), None);
        assert_eq!(secret_name("{{secret:}}"), None);
        assert_eq!(secret_name("{{secret:OK}}"), Some("OK"));
    }
}
