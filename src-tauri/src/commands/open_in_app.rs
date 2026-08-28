//! Open-in-app commands — port of `app/rpc/open-in-app.ts`: detects
//! external apps (Finder/Files, Terminal, VSCode, Zed) and opens a
//! session's resolved folder in one. Icons are not extractable here —
//! always null (the renderer falls back to its lucide icons).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::state::AppState;

use super::CommandError;

/// `ExternalApp` (shared/rpc.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExternalAppWire {
    pub id: &'static str,
    pub label: String,
    pub available: bool,
    #[serde(rename = "iconDataUrl")]
    pub icon_data_url: Option<String>,
}

/// `ShellOpResult`.
#[derive(Debug, Serialize, PartialEq)]
pub struct ShellOpResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Detection cached for the process lifetime — installing an editor
/// mid-session requires a restart to surface.
fn detected_cache() -> &'static std::sync::Mutex<Option<Vec<ExternalAppWire>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<Vec<ExternalAppWire>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// True if a CLI binary is on PATH (which/where) OR — macOS only — the
/// .app bundle exists.
fn is_editor_available(cli: &str, mac_bundle: Option<&str>) -> bool {
    if cli_available(cli) {
        return true;
    }
    if cfg!(target_os = "macos") {
        if let Some(bundle) = mac_bundle {
            return Path::new("/Applications").join(bundle).exists();
        }
    }
    false
}

/// The OS-appropriate display name for the built-in file manager.
fn file_manager_label() -> &'static str {
    if cfg!(windows) {
        "File Explorer"
    } else if cfg!(target_os = "macos") {
        "Finder"
    } else {
        "Files"
    }
}

fn detect_apps() -> Vec<ExternalAppWire> {
    let mut cache = detected_cache().lock().expect("open-in-app cache poisoned");
    if let Some(cached) = cache.as_ref() {
        return cached.clone();
    }
    let apps = vec![
        ExternalAppWire {
            id: "finder",
            label: file_manager_label().to_string(),
            available: true,
            icon_data_url: None,
        },
        ExternalAppWire {
            id: "terminal",
            label: "Terminal".into(),
            available: true,
            icon_data_url: None,
        },
        ExternalAppWire {
            id: "vscode",
            label: "VSCode".into(),
            available: is_editor_available("code", Some("Visual Studio Code.app")),
            icon_data_url: None,
        },
        ExternalAppWire {
            id: "zed",
            label: "Zed".into(),
            available: is_editor_available("zed", Some("Zed.app")),
            icon_data_url: None,
        },
    ];
    *cache = Some(apps.clone());
    apps
}

/// Is a CLI binary on PATH? (Unix `which` / Windows `where`.)
fn cli_available(cli: &str) -> bool {
    let probe = if cfg!(windows) {
        Command::new("where")
            .args([cli])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        Command::new("which")
            .args([cli])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    probe.is_ok_and(|s| s.success())
}

/// Spawn a detached process so the launched app outlives Tide.
fn detach(cmd: &str, args: &[&str], cwd: Option<&Path>) -> bool {
    let mut command = Command::new(cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    command
        .args(args)
        .current_dir(cwd.unwrap_or_else(|| Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Launch an editor for `dir`: prefer the CLI on PATH; fall back to
/// `open -a <App>` on macOS for installed .apps missing the CLI.
fn launch_editor(cli: &str, mac_app: &str, dir: &Path) -> bool {
    if cli_available(cli) {
        let dir = dir.to_string_lossy().into_owned();
        return detach(cli, &[&dir], None);
    }
    if cfg!(target_os = "macos") {
        let dir = dir.to_string_lossy().into_owned();
        return detach("open", &["-a", mac_app, &dir], None);
    }
    false
}

fn open_in_target(target: &str, dir: &Path) -> ShellOpResultWire {
    if !dir.exists() {
        return ShellOpResultWire {
            ok: false,
            error: Some(format!("Path does not exist: {}", dir.display())),
        };
    }
    let dir_str = dir.to_string_lossy().into_owned();
    match target {
        "finder" => {
            // `open` (macOS) / `xdg-open` open the directory in the OS
            // file manager.
            let opened = if cfg!(target_os = "macos") {
                detach("open", &[&dir_str], None)
            } else if cfg!(windows) {
                Command::new("explorer").arg(&dir_str).spawn().is_ok()
            } else {
                detach("xdg-open", &[&dir_str], None)
            };
            if opened {
                ShellOpResultWire {
                    ok: true,
                    error: None,
                }
            } else {
                ShellOpResultWire {
                    ok: false,
                    error: Some("Failed to open file manager".into()),
                }
            }
        }
        "terminal" => {
            if cfg!(target_os = "macos") {
                let ok = detach("open", &["-a", "Terminal", &dir_str], None);
                return result_or(ok, "Failed to launch Terminal");
            }
            if cfg!(windows) {
                let ok = detach("cmd", &["/c", "start", "", "cmd"], Some(dir));
                return result_or(ok, "Failed to launch cmd");
            }
            let working_dir = format!("--working-directory={dir_str}");
            let ok = detach("x-terminal-emulator", &[&working_dir], None)
                || detach("xdg-open", &[&dir_str], None);
            result_or(ok, "No terminal handler found")
        }
        "vscode" => result_or(
            launch_editor("code", "Visual Studio Code", dir),
            "Failed to launch VSCode",
        ),
        "zed" => result_or(launch_editor("zed", "Zed", dir), "Failed to launch Zed"),
        other => ShellOpResultWire {
            ok: false,
            error: Some(format!("Unknown target: {other}")),
        },
    }
}

fn result_or(ok: bool, error: &'static str) -> ShellOpResultWire {
    if ok {
        ShellOpResultWire {
            ok: true,
            error: None,
        }
    } else {
        ShellOpResultWire {
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// `openInAppDetect`.
#[tauri::command]
pub fn open_in_app_detect() -> Vec<ExternalAppWire> {
    detect_apps()
}

/// Resolve a session's folder: worktree.path → session workspace path →
/// workspace-by-id → $HOME (the TS main.ts resolveSessionPath chain).
fn resolve_session_path(state: &AppState, session_id: Option<&str>) -> PathBuf {
    if let Some(session_id) = session_id.filter(|s| !s.is_empty()) {
        let db_path = state.sessions_db_path();
        if db_path.is_file() {
            if let Ok(store) = tide_store::sessions_v2::SessionsV2::open(&db_path) {
                if let Ok(Some(worktree)) = store.session_worktree_of(session_id) {
                    if let Some(path) = worktree.get("path").and_then(|v| v.as_str()) {
                        if Path::new(path).exists() {
                            return PathBuf::from(path);
                        }
                    }
                }
                if let Ok(Some(meta)) = store.session_meta_by_id(session_id) {
                    if Path::new(&meta.workspace_path).exists() {
                        return PathBuf::from(meta.workspace_path);
                    }
                }
            }
        }
        let by_id = state
            .read_config(|cfg| {
                cfg.workspaces
                    .iter()
                    .find(|ws| ws.id == session_id)
                    .map(|ws| ws.path.clone())
            })
            .ok()
            .flatten();
        if let Some(path) = by_id.filter(|p| Path::new(p).exists()) {
            return PathBuf::from(path);
        }
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

/// `openInAppOpen`.
#[tauri::command]
pub fn open_in_app_open(
    state: tauri::State<'_, AppState>,
    target: String,
    session_id: Option<String>,
) -> Result<ShellOpResultWire, CommandError> {
    let dir = resolve_session_path(&state, session_id.as_deref());
    Ok(open_in_target(&target, &dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_lists_the_four_apps_with_icons_null() {
        let apps = open_in_app_detect();
        assert_eq!(apps.len(), 4);
        assert_eq!(apps[0].id, "finder");
        assert!(apps[0].available);
        assert!(apps[1].available, "terminal is always available");
        for app in &apps {
            assert!(app.icon_data_url.is_none());
        }
    }

    #[test]
    fn unknown_target_refuses() {
        let result = open_in_target("nope", Path::new("/tmp"));
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("Unknown target"));
    }

    #[test]
    fn missing_path_refuses() {
        let result = open_in_target("finder", Path::new("/definitely/not/here/xyz"));
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("Path does not exist"));
    }

    #[test]
    fn shell_op_wire_shape() {
        let ok = ShellOpResultWire {
            ok: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "ok": true })
        );
        let err = ShellOpResultWire {
            ok: false,
            error: Some("nope".into()),
        };
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({ "ok": false, "error": "nope" })
        );
    }
}
