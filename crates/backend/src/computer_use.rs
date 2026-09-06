//! Headless Computer Use state and helper lifecycle.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;

use anyhow::{Context as _, anyhow, bail};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_HELPER_OUTPUT_BYTES: usize = 24 * 1024 * 1024;

pub use protocol::computer_use::{
    ComputerAppGrant, ComputerPermissions, ComputerTarget, ComputerUsePhase, ComputerUseState,
};

#[derive(Clone, Debug)]
pub struct ComputerToolRequest {
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
}

impl ComputerToolRequest {
    pub fn summary(&self) -> String {
        match self.tool.as_str() {
            "status" => "Check computer-use access".into(),
            "list_apps" => "List apps".into(),
            "get_app_state" => "Inspect the app window".into(),
            "click" => "Click".into(),
            "drag" => "Drag".into(),
            "press_key" => "Press keys".into(),
            "type_text" => "Type text".into(),
            "perform_secondary_action" => "Run a secondary action".into(),
            "set_value" => "Set a control value".into(),
            "scroll" => "Scroll".into(),
            other => other.to_owned(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputerUsePreviewUpdate {
    target: ComputerTarget,
    image_url: String,
}

pub fn decode_preview_update(data: &[u8]) -> anyhow::Result<ComputerUseState> {
    let update: ComputerUsePreviewUpdate =
        serde_json::from_slice(data).context("Computer Use preview is invalid JSON")?;
    validate_preview_image_url(&update.image_url)?;
    Ok(ComputerUseState {
        target: Some(update.target),
        phase: ComputerUsePhase::Running,
        visible: true,
        image_url: Some(update.image_url),
    })
}

fn validate_preview_image_url(image_url: &str) -> anyhow::Result<()> {
    const PNG_PREFIX: &str = "data:image/png;base64,";
    let encoded = image_url
        .strip_prefix(PNG_PREFIX)
        .ok_or_else(|| anyhow!("Computer Use preview is not a PNG data URL"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("Computer Use preview contains invalid base64")?;
    if bytes.is_empty() {
        bail!("Computer Use preview is empty");
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct PendingComputerApproval {
    pub request: ComputerToolRequest,
    pub target: ComputerTarget,
    pub sensitive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    permissions: Option<ComputerPermissions>,
}

pub fn probe_permissions(prompt: bool) -> anyhow::Result<ComputerPermissions> {
    let operation = if prompt {
        json!({"operation": "requestPermissions"})
    } else {
        json!({"operation": "status"})
    };
    let helper = mcp_server_command()?;
    let active_helper_pid = AtomicU32::new(0);
    let response = invoke_helper_direct(&helper, &operation, &active_helper_pid)?;
    if !response.success {
        bail!(
            "{}",
            response
                .error
                .unwrap_or_else(|| tr!("computer_use.permission_check_failed"))
        );
    }
    Ok(response.permissions.unwrap_or_default())
}

/// The app-level Computer Use toggle (Settings → Computer Use), mirrored
/// from the persisted task state so the `computer` tool's backend can gate
/// without reaching into the backend's state mutex. Boot seeds it from the
/// loaded state; every state save refreshes it.
static COMPUTER_USE_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_computer_use_enabled(enabled: bool) {
    COMPUTER_USE_ENABLED.store(enabled, std::sync::atomic::Ordering::Release);
}

fn computer_use_enabled() -> bool {
    COMPUTER_USE_ENABLED.load(std::sync::atomic::Ordering::Acquire)
}

/// The `computer` tool's execution backend: bridges one helper request per
/// call through [`invoke_helper_direct`]. The macOS TCC grants stay the
/// hard gate (the helper preflights every operation); this seam only adds
/// the app-level toggle and the "helper exists in this build" check.
#[derive(Debug)]
pub struct HelperComputerBackend {
    helper: PathBuf,
}

impl tools::ComputerBackend for HelperComputerBackend {
    fn enabled(&self) -> bool {
        computer_use_enabled()
    }

    fn invoke(&self, operation: &Value) -> Result<Value, String> {
        let active_helper_pid = AtomicU32::new(0);
        let output = invoke_helper_raw(&self.helper, operation, &active_helper_pid)
            .map_err(|error| format!("{error:#}"))?;
        let response: Value = serde_json::from_slice(&output).map_err(|error| error.to_string())?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the Computer Use helper failed");
            return Err(remediate_helper_error(error));
        }
        Ok(response)
    }
}

/// Wrap capture-level failures with the remediation the model (and the
/// user) needs. ScreenCaptureKit denies the actual capture with the
/// generic Cocoa "data couldn't be read" error even when the TCC preflight
/// reports granted — the classic cause is a stale Screen Recording grant
/// (an ad-hoc-signed dev helper changes identity on rebuild), not a
/// targeting or permission-prompt problem.
fn remediate_helper_error(error: &str) -> String {
    if error.contains("couldn't be read because it is missing") {
        return format!(
            "{error} — macOS denied the screen capture itself even though the permission preflight \
             passes, which usually means the Screen Recording grant is stale for the Computer Use \
             helper. Fix: System Settings → Privacy & Security → Screen Recording → toggle \
             `{}` off and back on, then retry.",
            helper_display_name()
        );
    }
    error.to_owned()
}

/// Install the process-wide `computer` tool backend. A no-op off macOS —
/// the tool then reports "not available in this build" instead of failing
/// at call time.
pub fn install_computer_backend(enabled: bool) {
    set_computer_use_enabled(enabled);
    #[cfg(target_os = "macos")]
    match mcp_server_command() {
        Ok(helper) => {
            // Installing the helper at boot also primes the Application
            // Support copy: the first tool call pays no install latency.
            tools::set_shared_computer_backend(Some(std::sync::Arc::new(HelperComputerBackend {
                helper,
            })));
        }
        Err(error) => {
            eprintln!("Computer Use helper unavailable: {error:#}");
        }
    }
}

fn invoke_helper_direct(
    helper: &Path,
    operation: &Value,
    active_helper_pid: &AtomicU32,
) -> anyhow::Result<HelperResponse> {
    let output = invoke_helper_raw(helper, operation, active_helper_pid)?;
    serde_json::from_slice(&output).context("computer-use helper returned invalid JSON")
}

/// Spawn the helper for one request, feed it `operation` on stdin, and
/// return the bounded raw stdout response.
fn invoke_helper_raw(
    helper: &Path,
    operation: &Value,
    active_helper_pid: &AtomicU32,
) -> anyhow::Result<Vec<u8>> {
    // Every operation rides the Launch Services bridge, not the in-process
    // one-shot path: Screen Recording follows the responsible application,
    // and a capture or Accessibility call executed as a direct child of the
    // daemon would be attributed to Tide itself instead of the standalone
    // helper that actually holds the grants (see `install_helper_app`).
    // `request-permissions` additionally raises the child's activation
    // policy so the macOS prompts can appear.
    let mode = match operation.get("operation").and_then(Value::as_str) {
        Some("requestPermissions") => Some("request-permissions"),
        _ => Some("status"),
    };
    let mut command = Command::new(helper);
    if let Some(mode) = mode {
        command.arg(mode);
    }
    let command = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::command_env::spawn(command)
        .with_context(|| format!("failed to start {}", helper.display()))?;
    let pid = child.id();
    active_helper_pid.store(pid, Ordering::SeqCst);
    let payload = serde_json::to_vec(operation)?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("computer-use helper stdin unavailable"))?
        .write_all(&payload)?;
    // The bridge relays through `/usr/bin/open -W`, so a stalled Launch
    // Services launch (loginwindow mid-transition, sandbox denial, heavy
    // load) blocks forever — bound it with a watchdog that kills the child
    // and lets `wait_with_output` return.
    #[cfg(unix)]
    let watchdog = spawn_helper_watchdog(pid);
    let output = child.wait_with_output()?;
    let _ = active_helper_pid.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    #[cfg(unix)]
    watchdog.store(true, Ordering::Release);
    if output.stdout.len() > MAX_HELPER_OUTPUT_BYTES {
        bail!("computer-use helper returned too much data");
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("computer-use helper failed: {}", stderr.trim());
    }
    Ok(output.stdout)
}

/// How long one helper request may take. A `use` call is bounded by the
/// helper itself (≤ 16 actions, `wait` capped at 2 s each, one capture);
/// the Launch Services launch adds a few seconds of slack.
#[cfg(unix)]
const HELPER_TIMEOUT_SECS: u64 = 120;

/// Kill the helper after [`HELPER_TIMEOUT_SECS`] unless disarmed. The flag
/// is checked once a second so a finished request never pays the full
/// timer thread lifetime.
#[cfg(unix)]
fn spawn_helper_watchdog(pid: u32) -> std::sync::Arc<AtomicBool> {
    let disarmed = std::sync::Arc::new(AtomicBool::new(false));
    let flag = std::sync::Arc::clone(&disarmed);
    thread::Builder::new()
        .name("tide-computer-use-watchdog".into())
        .spawn(move || {
            for _ in 0..HELPER_TIMEOUT_SECS {
                if flag.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(std::time::Duration::from_secs(1));
            }
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        })
        .ok();
    disarmed
}

fn helper_app_path() -> anyhow::Result<PathBuf> {
    let executable = host_executable_path()?;
    let macos = executable
        .parent()
        .ok_or_else(|| anyhow!("Tide executable has no parent directory"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| anyhow!("Tide app bundle is malformed"))?;
    let app_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Tide executable name is invalid"))?;
    let helper_name = format!("{app_name} Computer Use");
    let path = contents.join("Helpers").join(format!("{helper_name}.app"));
    if !path.is_dir() {
        bail!("Computer Use helper is missing from this Tide build")
    }
    Ok(path)
}

pub fn helper_display_name() -> String {
    host_executable_path()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .map(|app_name| format!("{app_name} Computer Use"))
        .unwrap_or_else(|| "Tide Computer Use".into())
}

pub fn mcp_server_command() -> anyhow::Result<PathBuf> {
    let bundled_helper = helper_app_path()?;
    let helper = install_helper_app(&bundled_helper)?;
    let executable = helper
        .file_stem()
        .ok_or_else(|| anyhow!("Computer Use helper name is invalid"))?;
    Ok(helper.join("Contents").join("MacOS").join(executable))
}

pub fn js_repl_server_path() -> anyhow::Result<PathBuf> {
    let executable = host_executable_path()?;
    let macos = executable
        .parent()
        .ok_or_else(|| anyhow!("Tide executable has no parent directory"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| anyhow!("Tide app bundle is malformed"))?;
    let path = contents.join("Resources").join("tide_js_repl");
    if !path.is_file() {
        bail!("Tide JavaScript REPL is missing from this Tide build")
    }
    Ok(path)
}

pub fn pi_extension_path() -> anyhow::Result<PathBuf> {
    let executable = host_executable_path()?;
    let macos = executable
        .parent()
        .ok_or_else(|| anyhow!("Tide executable has no parent directory"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| anyhow!("Tide app bundle is malformed"))?;
    let path = contents
        .join("Resources")
        .join("computer-use")
        .join("pi-extension.ts");
    if !path.is_file() {
        bail!("Tide Pi Computer Use extension is missing from this Tide build")
    }
    Ok(path)
}

/// Install the bundled helper as an independent, stable runtime service.
///
/// Screen Recording differs from Accessibility on macOS: it follows the
/// responsible application. A helper launched from inside Tide's bundle is
/// therefore attributed to Tide even though the capture API runs in the
/// helper. Launching this standalone copy through Launch Services gives the
/// helper its own TCC identity while the signed app bundle remains the source
/// shipped with Tide.
fn install_helper_app(source: &Path) -> anyhow::Result<PathBuf> {
    let application_support =
        dirs::data_dir().ok_or_else(|| anyhow!("Application Support directory is unavailable"))?;
    let install_root = application_support.join("Tide").join("Computer Use");
    crate::fs_ext::create_private_dir_all(&install_root)
        .with_context(|| format!("could not create {}", install_root.display()))?;
    let bundle_name = source
        .file_name()
        .ok_or_else(|| anyhow!("Computer Use helper bundle name is invalid"))?;
    let destination = install_root.join(bundle_name);
    if helper_install_matches(source, &destination)? {
        return Ok(destination);
    }

    let staging = install_root.join(format!(".install-{}.app", Uuid::new_v4().simple()));
    copy_directory(source, &staging)?;
    let previous = install_root.join(format!(".previous-{}.app", Uuid::new_v4().simple()));
    let had_previous = destination.exists();
    if had_previous {
        fs::rename(&destination, &previous)
            .with_context(|| format!("could not replace {}", destination.display()))?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if had_previous {
            let _ = fs::rename(&previous, &destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(error).context("could not install Computer Use helper");
    }
    if had_previous {
        let _ = fs::remove_dir_all(previous);
    }
    Ok(destination)
}

fn helper_install_matches(source: &Path, destination: &Path) -> anyhow::Result<bool> {
    if !destination.is_dir() {
        return Ok(false);
    }
    let fingerprint = Path::new("Contents/Resources/.tide-helper-fingerprint");
    let source_fingerprint = fs::read(source.join(fingerprint))?;
    let Ok(installed_fingerprint) = fs::read(destination.join(fingerprint)) else {
        return Ok(false);
    };
    Ok(source_fingerprint == installed_fingerprint)
}

fn copy_directory(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    fs::create_dir(destination)?;
    fs::set_permissions(destination, metadata.permissions())?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_symlink() {
            crate::fs_ext::symlink(&fs::read_link(&source_path)?, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)?;
            fs::set_permissions(
                &destination_path,
                fs::symlink_metadata(&source_path)?.permissions(),
            )?;
        }
    }
    Ok(())
}

pub fn skill_root_path() -> anyhow::Result<PathBuf> {
    let executable = host_executable_path()?;
    let macos = executable
        .parent()
        .ok_or_else(|| anyhow!("Tide executable has no parent directory"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| anyhow!("Tide app bundle is malformed"))?;
    let path = contents.join("Resources").join("skills");
    if !path.join("tide-computer-use").join("SKILL.md").is_file() {
        bail!("Tide Computer Use skill is missing from this Tide build")
    }
    Ok(path)
}

fn host_executable_path() -> anyhow::Result<PathBuf> {
    protocol::env_var_os_or_legacy(crate::APP_EXECUTABLE_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| std::env::current_exe().context("Tide executable path is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_grants_preserve_bundle_identity() {
        let target = ComputerTarget {
            window_id: 42,
            bundle_id: "net.imput.helium".into(),
            team_id: Some("S4Q33XPHB4".into()),
            app_name: "Helium".into(),
            window_title: "Window".into(),
            width: 1440,
            height: 823,
        };
        let grant = ComputerAppGrant {
            bundle_id: "net.imput.helium".into(),
            app_name: "Helium".into(),
        };
        assert_eq!(target.grant_key(), grant.key());
        assert!(target.persistable());
    }

    #[test]
    fn preview_updates_restore_the_pip_state() {
        let state = decode_preview_update(
            br#"{
                "target": {
                    "windowId": 42,
                    "bundleId": "net.imput.helium",
                    "teamId": "S4Q33XPHB4",
                    "appName": "Helium",
                    "windowTitle": "Window",
                    "width": 1440,
                    "height": 823
                },
                "imageUrl": "data:image/png;base64,aGVsbG8="
            }"#,
        )
        .unwrap();

        assert_eq!(state.target.unwrap().window_id, 42);
        assert_eq!(state.phase, ComputerUsePhase::Running);
        assert!(state.visible);
        assert!(state.image_url.is_some());
    }
}
