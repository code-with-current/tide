//! settings.json shortcut overrides — the port of `app/rpc/settings.ts` +
//! `app/core/settingsStore.ts` (): `settingsGet` returns
//! `{overrides, platform-aware defaults}`, `settingsSetShortcut` sets/clears
//! one binding (null/[] deletes), `settingsResetShortcuts` clears all
//! overrides. Kept in settings.json — separate from config.json so a
//! settings reset never touches credentials. Writes are best-effort (a
//! read-only home logs and keeps serving the in-request value), exactly
//! like the TS store's swallow-and-log.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::state::AppState;

use super::CommandError;

pub type ShortcutMap = BTreeMap<String, Vec<String>>;

#[derive(Serialize, Debug)]
pub struct ShortcutsGetWire {
    pub overrides: ShortcutMap,
    pub defaults: ShortcutMap,
}

#[derive(Serialize, Debug)]
pub struct OverridesWire {
    pub overrides: ShortcutMap,
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn read_overrides(path: &Path) -> ShortcutMap {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("shortcuts").cloned())
        .and_then(|s| serde_json::from_value(s).ok())
        .unwrap_or_default()
}

fn write_overrides(data_dir: &Path, overrides: &ShortcutMap) -> Result<(), CommandError> {
    let body = serde_json::json!({ "shortcuts": overrides });
    let pretty = serde_json::to_string_pretty(&body)
        .map_err(|e| CommandError::with_code(e.to_string(), "SETTINGS_IO"))?;
    std::fs::create_dir_all(data_dir)
        .and_then(|_| std::fs::write(settings_path(data_dir), pretty))
        .map_err(|e| CommandError::with_code(e.to_string(), "SETTINGS_IO"))
}

/// macOS ⌘ / Win+Linux Ctrl — the canonical bindings from
/// src/lib/shortcuts.ts with the platform token substituted (keep the list
/// in sync with SHORTCUTS, per the TS comment).
fn default_shortcuts() -> ShortcutMap {
    let mod_token = if cfg!(target_os = "macos") {
        "⌘"
    } else {
        "Ctrl"
    };
    let entries: [(&str, Vec<&str>); 22] = [
        ("commandPalette", vec![mod_token, "K"]),
        ("newSession", vec![mod_token, "N"]),
        ("openSettings", vec![mod_token, ","]),
        ("closeWindow", vec![mod_token, "W"]),
        ("toggleWorkspaces", vec![mod_token, "1"]),
        ("toggleSessions", vec![mod_token, "2"]),
        ("toggleRightPanel", vec![mod_token, "3"]),
        ("toggleTerminal", vec!["T"]),
        ("toggleRightPanelBare", vec!["R"]),
        ("sendMessage", vec!["↵"]),
        ("newLine", vec!["⇧", "↵"]),
        ("abortTurn", vec![mod_token, "."]),
        ("dismissPrompt", vec!["Esc"]),
        ("editLastMessage", vec![mod_token, "↑"]),
        ("nextSession", vec!["J"]),
        ("prevSession", vec!["K"]),
        ("renameSession", vec![mod_token, "E"]),
        ("deleteSession", vec![mod_token, "⌫"]),
        ("approvePermission", vec!["Y"]),
        ("rejectPermission", vec!["N"]),
        ("copyDiff", vec![mod_token, "⇧", "C"]),
        ("branchFromWorktree", vec![mod_token, "B"]),
    ];
    entries
        .into_iter()
        .map(|(id, keys)| {
            (
                id.to_string(),
                keys.into_iter().map(str::to_owned).collect(),
            )
        })
        .collect()
}

#[tauri::command]
pub fn settings_get(state: tauri::State<AppState>) -> ShortcutsGetWire {
    get(&state)
}

fn get(state: &AppState) -> ShortcutsGetWire {
    ShortcutsGetWire {
        overrides: read_overrides(&settings_path(state.data_dir())),
        defaults: default_shortcuts(),
    }
}

#[tauri::command]
pub fn settings_set_shortcut(
    state: tauri::State<AppState>,
    id: String,
    keys: Option<Vec<String>>,
) -> OverridesWire {
    set_shortcut(&state, &id, keys)
}

fn set_shortcut(state: &AppState, id: &str, keys: Option<Vec<String>>) -> OverridesWire {
    let mut next = read_overrides(&settings_path(state.data_dir()));
    match keys {
        Some(keys) if !keys.is_empty() => {
            next.insert(id.to_string(), keys);
        }
        _ => {
            next.remove(id);
        }
    }
    if let Err(e) = write_overrides(state.data_dir(), &next) {
        eprintln!("[tide] failed to write settings.json: {}", e.message);
    }
    OverridesWire { overrides: next }
}

#[tauri::command]
pub fn settings_reset_shortcuts(state: tauri::State<AppState>) -> OverridesWire {
    reset_shortcuts(&state)
}

fn reset_shortcuts(state: &AppState) -> OverridesWire {
    if let Err(e) = write_overrides(state.data_dir(), &ShortcutMap::new()) {
        eprintln!("[tide] failed to write settings.json: {}", e.message);
    }
    OverridesWire {
        overrides: ShortcutMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-shortcuts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn keys(parts: &[&str]) -> Option<Vec<String>> {
        Some(parts.iter().map(|s| (*s).to_string()).collect())
    }

    #[test]
    fn defaults_cover_all_twenty_two_actions_with_platform_mod() {
        let defaults = default_shortcuts();
        assert_eq!(defaults.len(), 22);
        let expected_mod = if cfg!(target_os = "macos") { "⌘" } else { "Ctrl" };
        assert_eq!(defaults["commandPalette"], vec![expected_mod, "K"]);
        assert_eq!(defaults["sendMessage"], vec!["↵"]);
        assert_eq!(defaults["newLine"], vec!["⇧", "↵"]);
        assert_eq!(defaults["copyDiff"], vec![expected_mod, "⇧", "C"]);
    }

    #[test]
    fn reads_overrides_and_tolerates_missing_or_broken_files() {
        let dir = temp_dir("read");
        assert!(read_overrides(&settings_path(&dir)).is_empty());

        fs::write(
            settings_path(&dir),
            r#"{"shortcuts": {"sendMessage": ["Ctrl", "Enter"]}, "futureField": 1}"#,
        )
        .unwrap();
        let overrides = read_overrides(&settings_path(&dir));
        assert_eq!(overrides["sendMessage"], vec!["Ctrl", "Enter"]);
        assert_eq!(overrides.len(), 1);

        fs::write(settings_path(&dir), "{ nope").unwrap();
        assert!(read_overrides(&settings_path(&dir)).is_empty());

        fs::write(settings_path(&dir), r#"{"shortcuts": "bogus"}"#).unwrap();
        assert!(read_overrides(&settings_path(&dir)).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_shortcut_round_trips_and_clear_deletes() {
        let dir = temp_dir("set");
        let state = AppState::load(dir.clone());

        let wire = set_shortcut(&state, "commandPalette", keys(&["⌥", "P"]));
        assert_eq!(wire.overrides["commandPalette"], vec!["⌥", "P"]);
        assert_eq!(
            read_overrides(&settings_path(&dir))["commandPalette"],
            vec!["⌥", "P"]
        );

        let wire = set_shortcut(&state, "commandPalette", None);
        assert!(!wire.overrides.contains_key("commandPalette"));
        let wire = set_shortcut(&state, "commandPalette", Some(vec![]));
        assert!(!wire.overrides.contains_key("commandPalette"), "empty list clears");
        assert!(read_overrides(&settings_path(&dir)).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_layers_overrides_over_defaults_without_merging() {
        let dir = temp_dir("get");
        let state = AppState::load(dir.clone());
        set_shortcut(&state, "newSession", keys(&["F2"]));

        let wire = get(&state);
        assert_eq!(wire.overrides.len(), 1);
        assert_eq!(wire.defaults.len(), 22, "defaults stay complete");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reset_writes_an_empty_overrides_map() {
        let dir = temp_dir("reset");
        let state = AppState::load(dir.clone());
        set_shortcut(&state, "newSession", keys(&["F2"]));

        let wire = reset_shortcuts(&state);
        assert!(wire.overrides.is_empty());
        let disk = fs::read_to_string(settings_path(&dir)).unwrap();
        assert_eq!(disk, "{\n  \"shortcuts\": {}\n}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
