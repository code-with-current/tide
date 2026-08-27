//! OS/window glue — the M4 T1 port of `app/rpc/misc.ts` (91ec558): native
//! dialogs (tauri-plugin-dialog), shell opener ops (tauri-plugin-opener),
//! clipboard-blob persistence, renderer log forwarding, env/diagnostics,
//! macOS permission consent, pid liveness, mermaid repair, and the
//! workspace-external file/image readers. Return shapes are the
//! `shared/rpc.ts` wires byte-for-byte; every TS catch-to-null /
//! catch-to-empty degradation is kept.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

use super::CommandError;

const IMG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const EXTERNAL_MAX_BYTES: u64 = 256 * 1024;

// ── Window ops ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|e| CommandError::with_code(e.to_string(), "WINDOW"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .minimize()
            .map_err(|e| CommandError::with_code(e.to_string(), "WINDOW"))?;
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaximizedWire {
    pub maximized: bool,
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> Result<MaximizedWire, CommandError> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(MaximizedWire { maximized: false });
    };
    let maximized = window
        .is_maximized()
        .map_err(|e| CommandError::with_code(e.to_string(), "WINDOW"))?;
    let op = if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
    op.map_err(|e| CommandError::with_code(e.to_string(), "WINDOW"))?;
    Ok(MaximizedWire {
        maximized: !maximized,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FullscreenWire {
    pub fullscreen: bool,
}

#[tauri::command]
pub fn window_is_full_screen(app: AppHandle) -> FullscreenWire {
    FullscreenWire {
        fullscreen: app
            .get_webview_window("main")
            .and_then(|w| w.is_fullscreen().ok())
            .unwrap_or(false),
    }
}

// ── Native dialogs ──────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct PickFilesWire {
    pub paths: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct PickDirectoryWire {
    pub path: Option<String>,
}

fn join_err(e: tauri::Error) -> CommandError {
    CommandError::with_code(e.to_string(), "DIALOG_JOIN")
}

/// The blocking dialog APIs must not run on the macOS main thread, and a
/// modal open shouldn't stall async-runtime workers — hence spawn_blocking.
/// Tauri commands run sync fns on the main thread, so these two are async.
#[tauri::command]
pub async fn dialog_pick_files(app: AppHandle) -> Result<PickFilesWire, CommandError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_files()
    })
    .await
    .map_err(join_err)?
    .unwrap_or_default();
    let paths = picked
        .into_iter()
        .filter_map(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Ok(PickFilesWire { paths })
}

#[tauri::command]
pub async fn dialog_pick_directory(app: AppHandle) -> Result<PickDirectoryWire, CommandError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(join_err)?;
    Ok(PickDirectoryWire {
        path: picked
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

// ── Shell opener ops ────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct OkWire {
    pub ok: bool,
}

#[derive(Serialize, Debug)]
pub struct ShellOpWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn url_scheme(url: &str) -> Option<&str> {
    let (scheme, _) = url.split_once(':')?;
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    Some(scheme)
}

fn is_allowed_external_url(url: &str) -> bool {
    url_scheme(url).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "tel"
        )
    })
}

#[tauri::command]
pub fn shell_open_external(app: AppHandle, url: String) -> OkWire {
    if !is_allowed_external_url(&url) {
        return OkWire { ok: false };
    }
    OkWire {
        ok: app.opener().open_url(url, None::<&str>).is_ok(),
    }
}

#[tauri::command]
pub fn shell_open_path(app: AppHandle, path: String) -> ShellOpWire {
    match app.opener().open_path(path, None::<&str>) {
        Ok(()) => ShellOpWire {
            ok: true,
            error: None,
        },
        Err(_) => ShellOpWire {
            ok: false,
            error: Some("Failed to open path".into()),
        },
    }
}

#[tauri::command]
pub fn shell_show_item_in_folder(app: AppHandle, full_path: String) -> Result<(), CommandError> {
    app.opener()
        .reveal_item_in_dir(full_path)
        .map_err(|e| CommandError::with_code(e.to_string(), "SHELL"))
}

// ── Clipboard-blob persistence ──────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct SavedPathWire {
    pub path: String,
}

fn sanitize_attachment_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("pasted-file");
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "pasted-file".into()
    } else {
        safe
    }
}

fn unix_millis() -> Option<u128> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis())
}

fn save_attachment(data_dir: &Path, name: &str, data_base64: &str) -> String {
    let run = || -> std::io::Result<PathBuf> {
        let dir = data_dir.join("attachments");
        std::fs::create_dir_all(&dir)?;
        let safe = sanitize_attachment_name(name);
        let millis = unix_millis().ok_or_else(|| {
            std::io::Error::other("clock before UNIX_EPOCH")
        })?;
        let target = dir.join(format!("{millis}-{safe}"));
        std::fs::write(&target, BASE64.decode(data_base64).map_err(std::io::Error::other)?)?;
        Ok(target)
    };
    match run() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => String::new(),
    }
}

/// The renderer already holds the pasted bytes — it base64s them onto the
/// wire, so this is pure persistence (no clipboard read; no plugin needed).
#[tauri::command]
pub fn clipboard_file_save(
    state: tauri::State<AppState>,
    name: String,
    data_base64: String,
) -> SavedPathWire {
    SavedPathWire {
        path: save_attachment(state.data_dir(), &name, &data_base64),
    }
}

// ── Renderer log forwarding ─────────────────────────────────────────────

fn is_known_level(level: &str) -> bool {
    matches!(level, "error" | "warn" | "info" | "debug")
}

fn hhmmss_millis_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        (secs / 3600) % 24,
        (secs / 60) % 60,
        secs % 60,
        d.subsec_millis()
    )
}

fn forward_log(level: &str, tag: &str, msg: &str, args: &[Value]) {
    if !is_known_level(level) {
        return;
    }
    let mut line = format!(
        "{} {:5} {} {}",
        hhmmss_millis_now(),
        level.to_uppercase(),
        tag,
        msg
    );
    if !args.is_empty() {
        let serialized = args
            .iter()
            .filter_map(|a| serde_json::to_string(a).ok())
            .collect::<Vec<_>>()
            .join(" ");
        line.push(' ');
        line.push_str(&serialized);
    }
    eprintln!("{line}");
}

#[tauri::command]
pub fn log_send(level: String, tag: String, msg: String, args: Option<Vec<Value>>) {
    forward_log(&level, &tag, &msg, &args.unwrap_or_default());
}

// ── Env + diagnostics ───────────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfoWire {
    pub platform: String,
    pub arch: String,
    pub release: String,
    pub shell: String,
    pub keys_need_migration: bool,
}

/// `process.platform` spellings — the string is baked into the system
/// prompt ("darwin arm64 …") so the model recognizes its host.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn os_release() -> String {
    #[cfg(unix)]
    {
        // Mirrors Node's os.release(): the kernel version out of uname(2).
        let mut uts: libc::utsname = unsafe { std::mem::zeroed() };
        if unsafe { libc::uname(&mut uts) } == 0 {
            let bytes = uts
                .release
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8)
                .collect::<Vec<u8>>();
            if let Ok(release) = String::from_utf8(bytes) {
                if !release.is_empty() {
                    return release;
                }
            }
        }
        "unknown".into()
    }
    #[cfg(not(unix))]
    {
        "unknown".into()
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn env_info() -> EnvInfoWire {
    EnvInfoWire {
        platform: node_platform().into(),
        arch: node_arch().into(),
        release: os_release(),
        shell: default_shell(),
        // Electron-v10 blob migration was an Electrobun-shell-only concern;
        // under Tauri there is nothing to migrate.
        keys_need_migration: false,
    }
}

#[tauri::command]
pub fn env_info_get() -> EnvInfoWire {
    env_info()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsWire {
    pub app_version: String,
    pub runtime: String,
    pub runtime_version: String,
    pub chrome: String,
    pub platform: String,
    pub user_data_path: String,
}

#[tauri::command]
pub fn diagnostics_get(state: tauri::State<AppState>) -> DiagnosticsWire {
    let env = env_info();
    DiagnosticsWire {
        app_version: env!("CARGO_PKG_VERSION").into(),
        runtime: "tauri".into(),
        runtime_version: tauri::VERSION.into(),
        // WKWebView/Chromium engine version isn't reachable from the Rust
        // side — the TS Bun shell reported 'unknown' here too.
        chrome: "unknown".into(),
        platform: format!("{} {} {}", env.platform, env.release, env.arch),
        user_data_path: state.data_dir().to_string_lossy().into_owned(),
    }
}

// ── macOS permission consent ────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatusWire {
    pub platform: String,
    pub accessibility: Option<String>,
    pub full_disk_access: Option<String>,
    pub folders: Option<String>,
}

/// node-mac-permissions queried the TCC database natively; Tauri ships no
/// equivalent, so this returns the TS "bindings missing" shape (platform
/// 'other', all nulls — the consent screen's "no check possible, don't
/// block" path, consistent with the always-clear `consent_should_show`).
/// TODO(M4-note): real status needs a native TCC binding or a later-milestone
/// plugin; never fake 'authorized'.
#[tauri::command]
pub fn permission_status_get() -> PermissionStatusWire {
    PermissionStatusWire {
        platform: "other".into(),
        accessibility: None,
        full_disk_access: None,
        folders: None,
    }
}

#[derive(Serialize, Debug)]
pub struct PermissionResultWire {
    pub result: &'static str,
}

/// The OS never grants on call — node-mac-permissions only opened System
/// Settings to the right pane, and that part IS portable: the opener can
/// launch the pane URL directly. 'folders' opens the Files-and-Folders pane
/// once (TS fired one prompt per protected folder; the pane lists all three).
#[tauri::command]
pub fn permission_request(
    app: AppHandle,
    permission_type: String,
) -> Result<PermissionResultWire, CommandError> {
    let unavailable = || PermissionResultWire {
        result: "unavailable",
    };
    if !cfg!(target_os = "macos") {
        return Ok(unavailable());
    }
    let anchor = match permission_type.as_str() {
        "accessibility" => "Privacy_Accessibility",
        "fullDiskAccess" => "Privacy_AllFiles",
        "folders" => "Privacy_Lists",
        _ => return Ok(unavailable()),
    };
    let pane = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    match app.opener().open_url(pane, None::<&str>) {
        Ok(()) => Ok(PermissionResultWire {
            result: "opened",
        }),
        Err(_) => Ok(unavailable()),
    }
}

// ── Pid liveness ────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct AliveWire {
    pub alive: bool,
}

fn is_process_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(pid, 0): probe only. TS treated ANY error (EPERM included) as
    // dead — keep that, don't "improve" it.
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    // Windows TS fired an async tasklist and returned true unconditionally.
    #[cfg(windows)]
    {
        true
    }
}

#[tauri::command]
pub fn process_is_alive(pid: i64) -> AliveWire {
    AliveWire {
        alive: is_process_alive(pid),
    }
}

// ── Mermaid repair ──────────────────────────────────────────────────────

const REPAIR_SYSTEM: &str = "You fix broken Mermaid diagram sources. You will get the diagram source and the parser error. \
Return ONLY the corrected diagram inside a single ```mermaid fenced code block — no prose, no explanation. \
Keep the same diagram type, nodes, and meaning; only fix the syntax.\n\
Rules: quote labels containing spaces or special characters; never use `end` as a node id; \
quote subgraph titles containing spaces; no inline %% comments; no HTML entities; \
no style/classDef/class/linkStyle/click lines; every subgraph/alt/opt/loop block needs its `end`; \
no braces {} in sequenceDiagram message text; balanced brackets on every line.";

const SYSTEM_DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
const SYSTEM_DEFAULT_MODEL: &str = "google/gemma-4-26b-a4b-it:free";

fn system_model_configured() -> bool {
    std::env::var("TIDE_SYSTEM_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
}

fn system_base_url() -> String {
    let raw = std::env::var("TIDE_SYSTEM_BASE_URL")
        .unwrap_or_else(|_| SYSTEM_DEFAULT_BASE_URL.into());
    raw.strip_suffix("/chat/completions")
        .unwrap_or_else(|| raw.strip_suffix("/chat/completions/").unwrap_or(&raw))
        .to_string()
}

/// One-shot OpenAI-compatible completion on the system model — the port of
/// runSystemTask (same env vars, same defaults, 45s abort in the caller).
async fn run_system_task(system: &str, prompt: &str, max_output_tokens: u64) -> Result<String, String> {
    let api_key = std::env::var("TIDE_SYSTEM_API_KEY")
        .map_err(|_| "System model not configured: set TIDE_SYSTEM_API_KEY in .env.".to_string())?;
    let model = std::env::var("TIDE_SYSTEM_MODEL")
        .unwrap_or_else(|_| SYSTEM_DEFAULT_MODEL.into());
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": max_output_tokens,
    });
    let request = async {
        let response = reqwest::Client::new()
            .post(format!("{}/chat/completions", system_base_url()))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("system model HTTP {}", response.status()));
        }
        let payload: Value = response.json().await.map_err(|e| e.to_string())?;
        payload
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "system model reply had no content".to_string())
    };
    tokio::time::timeout(Duration::from_secs(45), request)
        .await
        .map_err(|_| "system model request timed out after 45s".to_string())?
}

/// Port of extractMermaidFromReply: fenced block (with or without the
/// mermaid tag), else the whole reply when it opens with a diagram
/// directive (multiline) — prose preambles reject.
fn extract_mermaid_from_reply(reply: &str) -> Option<String> {
    let text = reply.trim();
    if let Some(open) = text.find("```") {
        let after_fence = &text[open + 3..];
        let after_tag = if let Some(rest) = after_fence.strip_prefix("mermaid") {
            rest
        } else if let Some(rest) = after_fence.strip_prefix("mmd") {
            rest
        } else {
            after_fence
        };
        // `\s*\n` from the TS regex: all leading whitespace up to and
        // including its last newline, and at least one newline must exist.
        let first_non_ws = after_tag.find(|c: char| !c.is_whitespace());
        let content_start = match first_non_ws {
            Some(idx) if after_tag[..idx].contains('\n') => idx,
            _ => return unfenced_diagram(text),
        };
        let content = &after_tag[content_start..];
        if let Some(close) = content.find("```") {
            return Some(content[..close].trim().to_string());
        }
    }
    unfenced_diagram(text)
}

const DIAGRAM_DIRECTIVES: [&str; 10] = [
    "flowchart",
    "graph",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "erDiagram",
    "gantt",
    "pie",
    "mindmap",
    "journey",
];

fn line_starts_with_directive(line: &str) -> bool {
    for directive in DIAGRAM_DIRECTIVES {
        // `stateDiagram(-v2)?\b` backtracks: -v2 followed by a word char
        // still matches via plain stateDiagram + boundary at '-'.
        for candidate in [format!("{directive}-v2"), directive.to_string()] {
            if let Some(rest) = line.strip_prefix(&candidate) {
                let boundary = rest
                    .chars()
                    .next()
                    .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
                if boundary {
                    return true;
                }
            }
        }
    }
    false
}

fn unfenced_diagram(text: &str) -> Option<String> {
    // `^…\b` with the m flag: any line STARTING with a directive (no indent).
    if text.lines().any(line_starts_with_directive) {
        Some(text.to_string())
    } else {
        None
    }
}

async fn repair_mermaid_diagram(source: &str, parse_error: &str) -> Value {
    if !system_model_configured() {
        return json!({ "ok": false, "error": "System model not configured" });
    }
    let prompt = format!("Parser error:\n{parse_error}\n\nBroken diagram source:\n{source}");
    match run_system_task(REPAIR_SYSTEM, &prompt, 2048).await {
        Ok(reply) => match extract_mermaid_from_reply(&reply) {
            Some(code) => json!({ "ok": true, "code": code }),
            None => json!({ "ok": false, "error": "Repair reply contained no diagram" }),
        },
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub async fn mermaid_repair(source: String, error: String) -> Result<Value, CommandError> {
    Ok(repair_mermaid_diagram(&source, &error).await)
}

// ── External / image file reads ─────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct ExternalFileWire {
    pub content: String,
    pub bytes: u64,
    pub truncated: bool,
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

fn read_external_file(file_path: &str) -> Option<ExternalFileWire> {
    let meta = std::fs::metadata(file_path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = meta.len();
    let raw = std::fs::read(file_path).ok()?;
    let text = String::from_utf8_lossy(&raw);
    Some(ExternalFileWire {
        content: truncate_chars(&text, EXTERNAL_MAX_BYTES as usize),
        truncated: bytes > EXTERNAL_MAX_BYTES,
        bytes,
    })
}

#[tauri::command]
pub fn external_file_read(file_path: String) -> Option<ExternalFileWire> {
    read_external_file(&file_path)
}

fn mime_from_path(p: &str) -> Option<&'static str> {
    let ext = p.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn expand_path(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return Path::new(&home).join(rest);
        }
        return Path::new("~").join(rest);
    }
    PathBuf::from(p)
}

/// path.resolve, lexically: collapse CurDir, pop on ParentDir. None when a
/// `..` escapes the path's own root — the sandbox check below then rejects.
fn normalize_absolute(p: &Path) -> Option<PathBuf> {
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.clear(),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop()?;
            }
            Component::Normal(c) => out.push(c.to_os_string()),
        }
    }
    let mut normalized = PathBuf::from(if p.has_root() { "/" } else { "" });
    for part in out {
        normalized.push(part);
    }
    Some(normalized)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ImageFileWire {
    pub data_url: String,
    pub bytes: u64,
}

fn read_image_target(target: &Path) -> Option<ImageFileWire> {
    let meta = std::fs::metadata(target).ok()?;
    if !meta.is_file() || meta.len() > IMG_MAX_BYTES {
        return None;
    }
    let mime = mime_from_path(&target.to_string_lossy())?;
    let buf = std::fs::read(target).ok()?;
    Some(ImageFileWire {
        data_url: format!("data:{mime};base64,{}", BASE64.encode(buf)),
        bytes: meta.len(),
    })
}

fn read_image_file(
    data_dir_workspaces: Vec<(String, String)>,
    abs_path: Option<String>,
    workspace_id: Option<String>,
    rel_path: Option<String>,
) -> Option<ImageFileWire> {
    let target: PathBuf = if let Some(abs) = abs_path.filter(|s| !s.is_empty()) {
        PathBuf::from(abs)
    } else {
        let workspace_id = workspace_id?;
        let rel = rel_path?;
        let ws_path = data_dir_workspaces
            .into_iter()
            .find(|(id, _)| id.as_str() == workspace_id)
            .map(|(_, p)| p)?;
        let root = expand_path(&ws_path);
        let full = normalize_absolute(&root.join(&rel))?;
        let under_root = full.strip_prefix(normalize_absolute(&root)?).ok()?;
        // TS rejected rel === '' (the workspace root itself) and any escape
        // beyond it ('..' prefix / absolute) — strip_prefix + non-empty
        // covers all three.
        if under_root.as_os_str().is_empty() {
            return None;
        }
        full
    };
    read_image_target(&target)
}

#[tauri::command]
pub fn image_file_read(
    state: tauri::State<AppState>,
    abs_path: Option<String>,
    workspace_id: Option<String>,
    rel_path: Option<String>,
) -> Option<ImageFileWire> {
    // TS wrapped the whole body in one catch → null (even config errors).
    let workspaces = state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .map(|w| (w.id.clone(), w.path.clone()))
                .collect()
        })
        .ok()?;
    read_image_file(workspaces, abs_path, workspace_id, rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-misc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── extract_mermaid_from_reply (ported 1:1 from test/core/mermaid-repair.test.ts) ──

    #[test]
    fn extracts_a_fenced_mermaid_block() {
        let reply = "Here is the fixed diagram:\n\n```mermaid\nflowchart TD\nA --> B\n```\nDone.";
        assert_eq!(
            extract_mermaid_from_reply(reply).as_deref(),
            Some("flowchart TD\nA --> B")
        );
    }

    #[test]
    fn accepts_a_bare_fence_without_the_mermaid_tag() {
        let reply = "```\nflowchart TD\nA --> B\n```";
        assert_eq!(
            extract_mermaid_from_reply(reply).as_deref(),
            Some("flowchart TD\nA --> B")
        );
    }

    #[test]
    fn accepts_the_mmd_tag() {
        let reply = "```mmd\npie\n\"a\": 1\n```";
        assert_eq!(extract_mermaid_from_reply(reply).as_deref(), Some("pie\n\"a\": 1"));
    }

    #[test]
    fn accepts_a_raw_unfenced_diagram_source() {
        let reply = "sequenceDiagram\nA->>B: hello";
        assert_eq!(
            extract_mermaid_from_reply(reply).as_deref(),
            Some("sequenceDiagram\nA->>B: hello")
        );
    }

    #[test]
    fn rejects_prose_with_no_diagram() {
        assert_eq!(extract_mermaid_from_reply("Sorry, I could not fix that diagram."), None);
    }

    #[test]
    fn rejects_prose_that_only_mentions_mermaid_in_passing() {
        assert_eq!(
            extract_mermaid_from_reply("The flowchart directive goes at the top."),
            None
        );
    }

    #[test]
    fn takes_the_first_fence_when_several_are_present() {
        let reply = "```mermaid\nflowchart TD\nA --> B\n```\ntext\n```mermaid\nflowchart TD\nC --> D\n```";
        assert_eq!(
            extract_mermaid_from_reply(reply).as_deref(),
            Some("flowchart TD\nA --> B")
        );
    }

    #[test]
    fn unfenced_directives_match_at_line_start_only_and_state_diagram_v2_counts() {
        assert!(line_starts_with_directive("stateDiagram-v2"));
        assert!(line_starts_with_directive("stateDiagram"));
        assert!(line_starts_with_directive("journey"));
        assert!(!line_starts_with_directive("  flowchart TD"));
        assert!(!line_starts_with_directive("graphviz is not a directive"));
        assert!(line_starts_with_directive("graph TD"));
        assert_eq!(
            extract_mermaid_from_reply("intro\nstateDiagram-v2\n[*] --> s1").as_deref(),
            Some("intro\nstateDiagram-v2\n[*] --> s1")
        );
    }

    #[test]
    fn fence_without_a_newline_before_content_rejects() {
        // ```flowchart TD has no \n after the tag — the TS regex fails the
        // match, and the unfenced branch sees no directive-led line either.
        assert_eq!(extract_mermaid_from_reply("```flowchart TD\nA --> B\n```"), None);
    }

    #[test]
    fn repair_reports_unconfigured_system_model() {
        if system_model_configured() {
            // A developer shell with TIDE_SYSTEM_API_KEY exported can't
            // exercise the unconfigured branch without mutating env state.
            return;
        }
        let wire = futures::executor::block_on(repair_mermaid_diagram("flowchart TD", "boom"));
        assert_eq!(wire, json!({ "ok": false, "error": "System model not configured" }));
    }

    // ── URL scheme validation ──

    #[test]
    fn allowed_url_schemes() {
        for url in [
            "https://tide.codes",
            "http://localhost:5173",
            "mailto:a@b.c",
            "TEL:+1234",
        ] {
            assert!(is_allowed_external_url(url), "{url} should be allowed");
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "x-apple.systempreferences:com.apple.preference.security",
            "not a url",
            "",
            "1https://x",
        ] {
            assert!(!is_allowed_external_url(url), "{url} should be rejected");
        }
    }

    // ── mime + attachment names ──

    #[test]
    fn mime_lookup_by_extension() {
        assert_eq!(mime_from_path("/a/b.PNG"), Some("image/png"));
        assert_eq!(mime_from_path("x.jpeg"), Some("image/jpeg"));
        assert_eq!(mime_from_path("x.svg"), Some("image/svg+xml"));
        assert_eq!(mime_from_path("x.txt"), None);
        assert_eq!(mime_from_path("noext"), None);
    }

    #[test]
    fn sanitizes_attachment_names() {
        assert_eq!(sanitize_attachment_name("../evil name.png"), "evil_name.png");
        assert_eq!(sanitize_attachment_name("screen shot 2026"), "screen_shot_2026");
        assert_eq!(sanitize_attachment_name(""), "pasted-file");
        assert_eq!(sanitize_attachment_name("/abs/path/b.bin"), "b.bin");
        assert_eq!(sanitize_attachment_name("屏幕快照.png"), "____.png");
    }

    #[test]
    fn save_attachment_persists_timestamped_file() {
        let dir = temp_dir("attach");
        let path = save_attachment(&dir, "pic name.png", &BASE64.encode(b"by\ttes"));
        assert!(!path.is_empty(), "save must succeed");
        let saved = Path::new(&path);
        assert!(saved.starts_with(dir.join("attachments")));
        let name = saved.file_name().unwrap().to_str().unwrap();
        assert!(name.ends_with("-pic_name.png"), "timestamped + sanitized: {name}");
        assert_eq!(fs::read(saved).unwrap(), b"by\ttes".to_vec());
        assert_eq!(save_attachment(&dir, "x", "!!not base64!!"), "");
        fs::remove_dir_all(&dir).unwrap();
    }

    // ── external file reads ──

    #[test]
    fn external_file_read_reports_bytes_and_truncation() {
        let dir = temp_dir("external");
        let small = dir.join("small.txt");
        fs::write(&small, "hello").unwrap();
        let wire = read_external_file(small.to_str().unwrap()).unwrap();
        assert_eq!(wire.content, "hello");
        assert_eq!(wire.bytes, 5);
        assert!(!wire.truncated);

        let big = dir.join("big.txt");
        fs::write(&big, vec![b'a'; (EXTERNAL_MAX_BYTES + 10) as usize]).unwrap();
        let wire = read_external_file(big.to_str().unwrap()).unwrap();
        assert!(wire.truncated);
        assert_eq!(wire.bytes, EXTERNAL_MAX_BYTES + 10);
        assert_eq!(wire.content.chars().count(), EXTERNAL_MAX_BYTES as usize);

        assert_eq!(read_external_file(dir.to_str().unwrap()), None, "directory");
        assert_eq!(read_external_file("/nonexistent/tide-misc"), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn external_file_read_is_lossy_utf8() {
        let dir = temp_dir("external-bin");
        let bin = dir.join("blob.bin");
        fs::write(&bin, [0xff, 0xfe, b'x']).unwrap();
        let wire = read_external_file(bin.to_str().unwrap()).unwrap();
        assert!(wire.content.contains('\u{fffd}'));
        fs::remove_dir_all(&dir).unwrap();
    }

    // ── image reads + sandbox ──

    fn image_workspaces(dir: &Path) -> Vec<(String, String)> {
        vec![("ws_1".into(), dir.join("ws").to_string_lossy().into_owned())]
    }

    #[test]
    fn image_read_abs_path_builds_data_url() {
        let dir = temp_dir("image");
        let png = dir.join("pic.png");
        fs::write(&png, [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
        let wire =
            read_image_file(vec![], Some(png.to_string_lossy().into_owned()), None, None).unwrap();
        assert_eq!(
            wire.data_url,
            format!("data:image/png;base64,{}", BASE64.encode([0x89, b'P', b'N', b'G', 1, 2, 3]))
        );
        assert_eq!(wire.bytes, 7);

        let txt = dir.join("pic.txt");
        fs::write(&txt, b"nope").unwrap();
        assert_eq!(
            read_image_file(vec![], Some(txt.to_string_lossy().into_owned()), None, None),
            None,
            "non-image extension"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_read_workspace_rel_path_is_sandboxed() {
        let dir = temp_dir("image-ws");
        let ws = dir.join("ws");
        let img = ws.join("sub");
        fs::create_dir_all(&img).unwrap();
        fs::write(img.join("i.jpg"), b"jpegbytes").unwrap();
        fs::write(dir.join("outside.png"), b"out").unwrap();

        let workspaces = image_workspaces(&dir);
        let wire = read_image_file(
            workspaces.clone(),
            None,
            Some("ws_1".into()),
            Some("sub/i.jpg".into()),
        )
        .unwrap();
        assert!(wire.data_url.starts_with("data:image/jpeg;base64,"));

        for escape in ["../../outside.png", "sub/../../outside.png", "/etc/hosts"] {
            assert_eq!(
                read_image_file(workspaces.clone(), None, Some("ws_1".into()), Some(escape.into())),
                None,
                "escape {escape} must be rejected"
            );
        }
        assert_eq!(
            read_image_file(workspaces.clone(), None, Some("ws_1".into()), Some("".into())),
            None,
            "empty rel = workspace root"
        );
        assert_eq!(
            read_image_file(workspaces, None, Some("ws_missing".into()), Some("i.jpg".into())),
            None,
            "unknown workspace"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_read_rejects_oversized() {
        let dir = temp_dir("image-big");
        let big = dir.join("big.png");
        fs::write(&big, vec![0u8; (IMG_MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            read_image_file(vec![], Some(big.to_string_lossy().into_owned()), None, None),
            None
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expand_path_resolves_tilde_prefix() {
        let expanded = expand_path("~/x").to_string_lossy().into_owned();
        match std::env::var("HOME") {
            Ok(home) if !home.is_empty() => assert!(expanded.starts_with(&home)),
            _ => assert!(expanded.starts_with('~')),
        }
        assert_eq!(expand_path("/abs"), PathBuf::from("/abs"));
        assert_eq!(expand_path("rel"), PathBuf::from("rel"));
    }

    // ── pid liveness ──

    #[test]
    fn process_liveness() {
        assert!(is_process_alive(std::process::id() as i64));
        assert!(!is_process_alive(0));
        assert!(!is_process_alive(-1));
        let mut child = Command::new("sleep")
            .arg("5")
            .spawn()
            .expect("sleep spawns on CI/dev hosts");
        let pid = child.id() as i64;
        assert!(is_process_alive(pid));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!is_process_alive(pid));
    }

    // ── env + log helpers ──

    #[test]
    fn env_info_uses_node_spellings() {
        let env = env_info();
        assert!(matches!(env.platform.as_str(), "darwin" | "linux" | "win32" | "macos" | "freebsd"));
        assert!(matches!(env.arch.as_str(), "arm64" | "x64" | "aarch64" | "x86_64" | "riscv64" | "loongarch64"));
        assert!(!env.release.is_empty());
        assert!(!env.shell.is_empty());
        assert!(!env.keys_need_migration);
    }

    #[test]
    fn log_level_filter_matches_the_ts_order() {
        for level in ["error", "warn", "info", "debug"] {
            assert!(is_known_level(level));
        }
        for level in ["ERROR", "trace", "fatal", ""] {
            assert!(!is_known_level(level));
        }
    }

    #[test]
    fn timestamp_shape_is_hh_mm_ss_mmm() {
        let ts = hhmmss_millis_now();
        let parts: Vec<&str> = ts.split([':', '.']).collect();
        assert_eq!(parts.len(), 4, "{ts}");
        assert_eq!(parts[0].len(), 2);
        assert_eq!(parts[3].len(), 3);
    }

    #[test]
    fn os_release_is_populated_on_unix() {
        #[cfg(unix)]
        assert!(os_release() != "unknown", "uname(2) should resolve on unix");
    }
}
