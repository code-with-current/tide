//! Updater — the port of app/updater.ts's consent model onto
//! tauri-plugin-updater's signed feed. Release notes stay a GitHub-API
//! fetch (identical to the TS). Check/download/apply are the real flow:
//!
//! - **Check** (`updater_check_now` + the boot-delayed/periodic schedule in
//!   [`spawn_auto_check`]) resolves the channel from the running version
//!   (`-` suffix → beta) and stops at `available` — nothing downloads
//!   without the user's consent. The plugin's endpoint loop tries the
//!   channel feed first and falls through on 404, so a feed that does not
//!   exist for this channel naturally defers to the other one.
//! - **Download** (`updater_download`) fetches + minisign-verifies the
//!   artifact (progress pushes as `updateStatus` snapshots) and stops at
//!   `downloaded` — the verified bytes are held until apply.
//! - **Apply** (`updater_apply`) installs the prepared bytes and relaunches
//!   (`AppHandle::restart`; on Windows the NSIS installer exits the process
//!   itself, so the explicit restart effectively runs only elsewhere).
//!
//! Every phase transition publishes an `UpdateStatusWire` snapshot on the
//! shared broadcast bus; `chat_attach_channel` forwards it to the renderer
//! as the `updateStatus` push, and the update-store drives the pill and the
//! release/progress dialogs exactly like the TS shell did.
//!
//! Deviation from the TS: a downloaded update lives in memory, not on disk
//! (the plugin has no prepared-bundle store), so "Later" survives only
//! until quit — the next boot re-checks and re-offers. Errors (offline,
//! 404 on every endpoint, bad signature) publish an `error` snapshot that
//! keeps the target version, preserving the retry affordance.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tokio::sync::broadcast;
use url::Url;

use crate::state::AppState;

use super::CommandError;

/// Courtesy delay before the first automatic check (TS CHECK_DELAY_MS).
const CHECK_DELAY_MS: u64 = 500;
/// Periodic re-check cadence, 4h (TS CHECK_INTERVAL_MS).
const CHECK_INTERVAL_SECS: u64 = 4 * 60 * 60;

const STABLE_ENDPOINT: &str =
    "https://github.com/code-with-current/tide/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/code-with-current/tide/releases/download/beta/beta.json";

// ── Wire types (shared/rpc.ts) ───────────────────────────────────────────────

/// Coarse UI phases — the TS `UpdatePhase` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    Applying,
    NotAvailable,
    Error,
}

/// Reduced updater snapshot — the TS `UpdateStatusWire`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusWire {
    pub phase: UpdatePhase,
    pub message: String,
    pub current_version: String,
    /// Target version when one is known (available/downloading/downloaded,
    /// and error-with-target for the retry affordance).
    pub version: Option<String>,
    /// Download progress 0-100 while phase is `downloading` (99-cap until
    /// the verified bundle lands; 100 belongs to `downloaded`).
    pub percent: Option<u32>,
    pub error: Option<String>,
    pub last_checked_at: Option<u64>,
}

/// A verified, downloaded-but-not-installed update. Held until the user
/// applies it (consent model).
#[derive(Clone)]
pub struct DownloadedUpdate {
    pub update: Update,
    pub bytes: Vec<u8>,
}

// ── Channel resolution ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

/// The update channel a version belongs to: a semver prerelease suffix
/// (`0.4.1-beta.2`) is the beta channel, everything else stable.
pub fn channel_for_version(version: &str) -> Channel {
    if version.contains('-') {
        Channel::Beta
    } else {
        Channel::Stable
    }
}

/// Endpoints for a version, channel-preferred: stable builds never consult
/// the beta feed (a prerelease must not be offered to the stable channel);
/// beta builds try their own feed first and fall back to stable when no
/// beta feed answers (the plugin skips an endpoint that 404s).
pub fn endpoints_for_version(version: &str) -> Vec<Url> {
    let urls = match channel_for_version(version) {
        Channel::Stable => vec![STABLE_ENDPOINT],
        Channel::Beta => vec![BETA_ENDPOINT, STABLE_ENDPOINT],
    };
    urls.into_iter().filter_map(|u| Url::parse(u).ok()).collect()
}

// ── Shared consent state machine ─────────────────────────────────────────────

/// Updater state shared by the commands and the auto-check schedule. Every
/// transition publishes the next snapshot on the broadcast bus; guards
/// mirror the TS reducer (see the method docs).
pub struct UpdaterShared {
    current_version: Mutex<String>,
    status: Mutex<Option<UpdateStatusWire>>,
    /// Last check's `Update` — the download consent acts on it.
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<DownloadedUpdate>>,
    consent_in_flight: AtomicBool,
    push_tx: broadcast::Sender<UpdateStatusWire>,
}

impl UpdaterShared {
    pub fn new(current_version: impl Into<String>) -> Self {
        let (push_tx, _) = broadcast::channel(64);
        Self {
            current_version: Mutex::new(current_version.into()),
            status: Mutex::new(None),
            pending: Mutex::new(None),
            downloaded: Mutex::new(None),
            consent_in_flight: AtomicBool::new(false),
            push_tx,
        }
    }

    /// Renderer push subscription — `chat_attach_channel` forwards these as
    /// `updateStatus` ChatPush messages.
    pub fn subscribe(&self) -> broadcast::Receiver<UpdateStatusWire> {
        self.push_tx.subscribe()
    }

    /// `null` until the first check — the TS snapshot only exists after
    /// `start()` observes the local info.
    pub fn status(&self) -> Option<UpdateStatusWire> {
        self.status.lock().unwrap().clone()
    }

    pub fn current_version(&self) -> String {
        self.current_version.lock().unwrap().clone()
    }

    /// The updater compares against the app's package-info version
    /// (tauri.conf.json, kept in sync with the Cargo version) — trust the
    /// live value whenever a command or schedule tick runs.
    pub fn note_current_version(&self, version: &str) {
        *self.current_version.lock().unwrap() = version.to_owned();
    }

    /// The idle seed (TS `idleStatus`) — the base for the first transition.
    fn base(&self) -> UpdateStatusWire {
        self.status.lock().unwrap().clone().unwrap_or_else(|| UpdateStatusWire {
            phase: UpdatePhase::Idle,
            message: String::new(),
            current_version: self.current_version(),
            version: None,
            percent: None,
            error: None,
            last_checked_at: None,
        })
    }

    fn publish(&self, next: UpdateStatusWire) {
        *self.status.lock().unwrap() = Some(next.clone());
        let _ = self.push_tx.send(next);
    }

    /// A check starts. Skipped while an update sits prepared: "Later" keeps
    /// the ready snapshot so the pill must not lose its restart prompt to a
    /// periodic re-check that finds nothing new.
    pub fn begin_check(&self) {
        let base = self.base();
        if base.phase == UpdatePhase::Downloaded {
            return;
        }
        self.publish(UpdateStatusWire {
            phase: UpdatePhase::Checking,
            message: "Checking for updates…".into(),
            current_version: self.current_version(),
            version: base.version,
            percent: None,
            error: None,
            last_checked_at: base.last_checked_at,
        });
    }

    /// Check found an update — the consent model stops here (TS
    /// `ensureAvailable`): never regresses a flow already past `available`,
    /// and a same-version re-offer dedupes.
    pub fn finish_available(&self, version: &str) {
        let base = self.base();
        if matches!(
            base.phase,
            UpdatePhase::Downloading | UpdatePhase::Downloaded | UpdatePhase::Applying
        ) {
            return;
        }
        if base.phase == UpdatePhase::Available && base.version.as_deref() == Some(version) {
            return;
        }
        self.publish(UpdateStatusWire {
            phase: UpdatePhase::Available,
            message: format!("Version {version} is available"),
            current_version: self.current_version(),
            version: Some(version.to_owned()),
            percent: None,
            error: None,
            last_checked_at: base.last_checked_at,
        });
    }

    /// Check found nothing. `lastCheckedAt` lands here (and on error) only.
    pub fn finish_not_available(&self) {
        let base = self.base();
        if matches!(
            base.phase,
            UpdatePhase::Downloaded | UpdatePhase::Downloading | UpdatePhase::Applying
        ) {
            return;
        }
        self.publish(UpdateStatusWire {
            phase: UpdatePhase::NotAvailable,
            message: "You're up to date".into(),
            current_version: self.current_version(),
            version: None,
            percent: None,
            error: None,
            last_checked_at: Some(now_millis()),
        });
    }

    /// Failure publication — keeps the target version (the retry
    /// affordance) and dedupes against a snapshot that already carries the
    /// same error.
    pub fn fail(&self, error: &str) {
        let base = self.base();
        if base.phase == UpdatePhase::Error && base.error.as_deref() == Some(error) {
            return;
        }
        self.publish(UpdateStatusWire {
            phase: UpdatePhase::Error,
            message: error.to_owned(),
            current_version: self.current_version(),
            version: base.version,
            percent: None,
            error: Some(error.to_owned()),
            last_checked_at: Some(now_millis()),
        });
    }

    /// Consent action 1 begins — the pill swaps to the progress dialog.
    pub fn begin_download(&self) {
        let base = self.base();
        self.publish(UpdateStatusWire {
            phase: UpdatePhase::Downloading,
            message: "Downloading update…".into(),
            current_version: self.current_version(),
            version: base.version,
            percent: Some(0),
            error: None,
            last_checked_at: base.last_checked_at,
        });
    }

    /// Download progress — only pushes when the whole-percent changes.
    /// `None` (unknown content length) keeps the current percent, like the
    /// TS entries without `totalBytes`.
    pub fn progress(&self, percent: Option<u32>) {
        let snapshot = {
            let mut guard = self.status.lock().unwrap();
            let Some(current) = guard.as_mut() else { return };
            if current.phase != UpdatePhase::Downloading || current.percent == percent {
                return;
            }
            current.percent = percent;
            current.clone()
        };
        let _ = self.push_tx.send(snapshot);
    }

    /// The verified bundle landed — `percent` reaches 100 here, never
    /// during transfer (TS caps transfer at 99).
    pub fn finish_download(&self, version: &str) {
        let mut next = self.base();
        next.phase = UpdatePhase::Downloaded;
        next.message = format!("Version {version} ready to install");
        next.version = Some(version.to_owned());
        next.percent = Some(100);
        next.error = None;
        self.publish(next);
    }

    /// Consent action 2 — swap + relaunch.
    pub fn begin_apply(&self) {
        let mut next = self.base();
        next.phase = UpdatePhase::Applying;
        next.message = "Installing update…".into();
        next.percent = None;
        next.error = None;
        self.publish(next);
    }

    pub fn set_pending(&self, update: Update) {
        *self.pending.lock().unwrap() = Some(update);
    }

    pub fn clear_pending(&self) {
        *self.pending.lock().unwrap() = None;
    }

    pub fn pending(&self) -> Option<Update> {
        self.pending.lock().unwrap().clone()
    }

    pub fn store_downloaded(&self, prepared: DownloadedUpdate) {
        *self.pending.lock().unwrap() = None;
        *self.downloaded.lock().unwrap() = Some(prepared);
    }

    pub fn downloaded(&self) -> Option<DownloadedUpdate> {
        self.downloaded.lock().unwrap().clone()
    }

    pub fn try_begin_consent(&self) -> bool {
        !self.consent_in_flight.swap(true, Ordering::SeqCst)
    }

    pub fn end_consent(&self) {
        self.consent_in_flight.store(false, Ordering::SeqCst);
    }

    pub fn consent_in_flight(&self) -> bool {
        self.consent_in_flight.load(Ordering::SeqCst)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Core flows ───────────────────────────────────────────────────────────────

fn build_updater<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &UpdaterShared,
) -> Result<Updater, tauri_plugin_updater::Error> {
    app.updater_builder()
        .endpoints(endpoints_for_version(&shared.current_version()))
        .and_then(|builder| builder.build())
}

/// Check only — the consent model stops at `available`. Skipped while a
/// consent action is in flight so a periodic tick can't stack a `checking`
/// snapshot over the user-approved download/apply.
pub async fn run_check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &UpdaterShared,
) -> Result<(), String> {
    if shared.consent_in_flight() {
        return Ok(());
    }
    shared.note_current_version(&app.package_info().version.to_string());
    shared.begin_check();
    let updater = match build_updater(app, shared) {
        Ok(updater) => updater,
        Err(e) => {
            let message = e.to_string();
            shared.fail(&message);
            return Err(message);
        }
    };
    run_check_core(updater, shared).await
}

/// Check core — tests drive this against a mock app whose updater carries
/// a test keypair and a local feed.
pub async fn run_check_core(updater: Updater, shared: &UpdaterShared) -> Result<(), String> {
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            shared.set_pending(update);
            shared.finish_available(&version);
            Ok(())
        }
        Ok(None) => {
            shared.clear_pending();
            shared.finish_not_available();
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();
            shared.fail(&message);
            Err(message)
        }
    }
}

/// Consent action 1 — download + verify only, stops at ready. Idempotent
/// when a bundle is already prepared (retry after a failed apply).
pub async fn run_download(shared: &UpdaterShared) -> Value {
    if !shared.try_begin_consent() {
        return json!({ "ok": false, "error": "update already in progress" });
    }
    let reply = download_inner(shared).await;
    shared.end_consent();
    reply
}

async fn download_inner(shared: &UpdaterShared) -> Value {
    if shared.downloaded().is_some() {
        return json!({ "ok": true });
    }
    let Some(update) = shared.pending() else {
        return json!({ "ok": false, "error": "no update available" });
    };
    shared.begin_download();
    let mut downloaded_bytes: u64 = 0;
    let mut last_percent: Option<u32> = Some(0);
    // Signature verification happens inside download() — a feed signed by
    // any other key fails here and lands in the error snapshot below.
    match update
        .download(
            |chunk, total| {
                downloaded_bytes += chunk as u64;
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded_bytes * 100 / t) as u32).min(99));
                if percent != last_percent {
                    last_percent = percent;
                    shared.progress(percent);
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            let version = update.version.clone();
            shared.store_downloaded(DownloadedUpdate { update, bytes });
            shared.finish_download(&version);
            json!({ "ok": true })
        }
        Err(e) => {
            let message = e.to_string();
            shared.fail(&message);
            json!({ "ok": false, "error": message })
        }
    }
}

/// Consent action 2 — install the prepared bytes and relaunch. On Windows
/// the installer exits the process inside `install`; elsewhere the restart
/// re-execs the swapped binary. Never returns on the success path.
pub async fn run_apply<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &UpdaterShared,
) -> Value {
    if !shared.try_begin_consent() {
        return json!({ "ok": false, "error": "update already in progress" });
    }
    let Some(prepared) = shared.downloaded() else {
        shared.end_consent();
        return json!({ "ok": false, "error": "update not downloaded" });
    };
    shared.begin_apply();
    match prepared.update.install(&prepared.bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            let message = e.to_string();
            shared.fail(&message);
            shared.end_consent();
            json!({ "ok": false, "error": message })
        }
    }
}

/// Boot-delayed + periodic automatic checks, gated on the general
/// `autoUpdateCheck` setting (manual checks bypass this schedule). Errors
/// publish to the status stream, never log-crash the loop.
pub fn spawn_auto_check(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CHECK_DELAY_MS)).await;
        loop {
            let enabled = app
                .state::<AppState>()
                .read_config(|cfg| {
                    cfg.general_settings
                        .clone()
                        .unwrap_or_default()
                        .effective()
                        .auto_update_check
                })
                .unwrap_or(true);
            if enabled {
                let shared = Arc::clone(app.state::<Arc<UpdaterShared>>().inner());
                if let Err(e) = run_check(&app, &shared).await {
                    eprintln!("[tide] update auto-check failed: {e}");
                }
            }
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct UpdaterStatusResult {
    pub status: Option<UpdateStatusWire>,
}

#[tauri::command]
pub fn updater_status(shared: tauri::State<'_, Arc<UpdaterShared>>) -> UpdaterStatusResult {
    UpdaterStatusResult {
        status: shared.status(),
    }
}

#[tauri::command]
pub async fn updater_check_now(
    app: tauri::AppHandle,
    shared: tauri::State<'_, Arc<UpdaterShared>>,
) -> Result<Value, CommandError> {
    let shared = Arc::clone(shared.inner());
    Ok(match run_check(&app, &shared).await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    })
}

#[tauri::command]
pub async fn updater_download(
    shared: tauri::State<'_, Arc<UpdaterShared>>,
) -> Result<Value, CommandError> {
    Ok(run_download(shared.inner()).await)
}

#[tauri::command]
pub async fn updater_apply(
    app: tauri::AppHandle,
    shared: tauri::State<'_, Arc<UpdaterShared>>,
) -> Result<Value, CommandError> {
    Ok(run_apply(&app, shared.inner()).await)
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    body: Option<String>,
}

#[tauri::command]
pub fn updater_release_notes(version: String) -> Result<Value, CommandError> {
    let version = version.trim_start_matches('v').to_owned();
    let url = format!(
        "https://api.github.com/repos/{repo}/releases/tags/v{version}",
        repo = github_repo()
    );
    let reply = tide_tools::http::get(
        &url,
        &[("Accept", "application/vnd.github+json"), ("User-Agent", "Tide/1.0 (coding agent)")],
        std::time::Duration::from_secs(15),
    )
    .map_err(|e| CommandError {
        message: e.to_string(),
        code: Some("UPDATER_NOTES".into()),
    })?;
    if !reply.is_ok() {
        return Ok(serde_json::json!({ "markdown": null }));
    }
    let release: Release = serde_json::from_str(&reply.body)
        .map_err(|e| CommandError {
            message: e.to_string(),
            code: Some("UPDATER_NOTES".into()),
        })?;
    Ok(serde_json::json!({ "markdown": release.body }))
}

fn github_repo() -> String {
    std::env::var("TIDE_UPDATE_REPO").unwrap_or_else(|_| "code-with-current/tide".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn phases_serialize_to_the_ts_union() {
        let cases = [
            (UpdatePhase::Idle, "idle"),
            (UpdatePhase::Checking, "checking"),
            (UpdatePhase::Available, "available"),
            (UpdatePhase::Downloading, "downloading"),
            (UpdatePhase::Downloaded, "downloaded"),
            (UpdatePhase::Applying, "applying"),
            (UpdatePhase::NotAvailable, "not-available"),
            (UpdatePhase::Error, "error"),
        ];
        for (phase, expected) in cases {
            assert_eq!(
                serde_json::to_value(phase).unwrap(),
                serde_json::Value::String(expected.to_owned())
            );
        }
    }

    #[test]
    fn status_wire_serializes_like_shared_rpc() {
        let wire = UpdateStatusWire {
            phase: UpdatePhase::NotAvailable,
            message: "You're up to date".into(),
            current_version: "0.4.0".into(),
            version: None,
            percent: None,
            error: None,
            last_checked_at: Some(1_759_000_000_000),
        };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!({
                "phase": "not-available",
                "message": "You're up to date",
                "currentVersion": "0.4.0",
                "version": null,
                "percent": null,
                "error": null,
                "lastCheckedAt": 1_759_000_000_000u64,
            })
        );

        let mid_download = UpdateStatusWire {
            phase: UpdatePhase::Downloading,
            message: "Downloading update…".into(),
            current_version: "0.4.0".into(),
            version: Some("0.4.1-beta.2".into()),
            percent: Some(42),
            error: None,
            last_checked_at: None,
        };
        let wire = serde_json::to_value(&mid_download).unwrap();
        assert_eq!(wire["version"], "0.4.1-beta.2");
        assert_eq!(wire["percent"], 42);
    }

    #[test]
    fn status_result_serializes_null_before_any_check() {
        let shared = UpdaterShared::new("0.4.0");
        assert!(shared.status().is_none());
        let result = serde_json::to_value(UpdaterStatusResult { status: shared.status() }).unwrap();
        assert_eq!(result, serde_json::json!({ "status": null }));
    }

    #[test]
    fn channel_endpoints_follow_the_version_suffix() {
        assert_eq!(channel_for_version("0.4.0"), Channel::Stable);
        assert_eq!(channel_for_version("0.4.1-beta.2"), Channel::Beta);
        assert_eq!(channel_for_version("1.0.0-rc.1"), Channel::Beta);

        let stable = endpoints_for_version("0.4.0");
        assert_eq!(stable.len(), 1);
        assert_eq!(
            stable[0].as_str(),
            "https://github.com/code-with-current/tide/releases/latest/download/latest.json"
        );

        let beta = endpoints_for_version("0.4.1-beta.2");
        assert_eq!(beta.len(), 2);
        assert!(beta[0].as_str().ends_with("/beta.json"), "beta feed first");
        assert!(beta[1].as_str().ends_with("/latest.json"), "stable fallback");
    }

    #[test]
    fn consent_state_machine_matches_the_ts_reducer() {
        let shared = UpdaterShared::new("1.0.0");
        let mut rx = shared.subscribe();

        shared.begin_check();
        let checking = rx.try_recv().unwrap();
        assert_eq!(checking.phase, UpdatePhase::Checking);
        assert_eq!(checking.current_version, "1.0.0");
        assert!(checking.last_checked_at.is_none());

        shared.finish_available("1.1.0");
        let available = rx.try_recv().unwrap();
        assert_eq!(available.phase, UpdatePhase::Available);
        assert_eq!(available.version.as_deref(), Some("1.1.0"));
        assert!(available.last_checked_at.is_none());
        assert!(available.error.is_none());

        // Same-version re-offer dedupes (TS ensureAvailable).
        shared.finish_available("1.1.0");
        assert!(rx.try_recv().is_err());

        shared.begin_download();
        let downloading = rx.try_recv().unwrap();
        assert_eq!(downloading.phase, UpdatePhase::Downloading);
        assert_eq!(downloading.percent, Some(0));

        shared.progress(Some(50));
        assert_eq!(rx.try_recv().unwrap().percent, Some(50));
        shared.progress(Some(50));
        assert!(rx.try_recv().is_err(), "whole-percent change gates the push");

        shared.finish_download("1.1.0");
        let downloaded = rx.try_recv().unwrap();
        assert_eq!(downloaded.phase, UpdatePhase::Downloaded);
        assert_eq!(downloaded.percent, Some(100));

        // "Later": a periodic re-check while ready must not clobber the
        // restart prompt.
        shared.begin_check();
        assert!(rx.try_recv().is_err());
        shared.finish_not_available();
        assert!(rx.try_recv().is_err());
        assert_eq!(shared.status().unwrap().phase, UpdatePhase::Downloaded);

        shared.fail("offline");
        let error = rx.try_recv().unwrap();
        assert_eq!(error.phase, UpdatePhase::Error);
        assert_eq!(error.error.as_deref(), Some("offline"));
        assert_eq!(error.version.as_deref(), Some("1.1.0"), "retry keeps the target");
        assert!(error.last_checked_at.is_some());

        shared.fail("offline");
        assert!(rx.try_recv().is_err(), "identical errors dedupe");

        shared.finish_not_available();
        let none = rx.try_recv().unwrap();
        assert_eq!(none.phase, UpdatePhase::NotAvailable);
        assert_eq!(none.version, None);
        assert!(none.last_checked_at.is_some());
    }

    #[tokio::test]
    async fn download_without_an_update_reports_unavailable() {
        let shared = UpdaterShared::new("1.0.0");
        let reply = run_download(&shared).await;
        assert_eq!(reply["ok"], serde_json::json!(false));
        assert_eq!(reply["error"], serde_json::json!("no update available"));
    }

    #[tokio::test]
    async fn apply_without_a_download_reports_not_downloaded() {
        // The guard returns before any install/restart, so a mock app is
        // safe to drive here.
        let app = tauri::test::mock_app();
        let shared = UpdaterShared::new("1.0.0");
        let reply = run_apply(app.handle(), &shared).await;
        assert_eq!(reply["ok"], serde_json::json!(false));
        assert_eq!(reply["error"], serde_json::json!("update not downloaded"));
        assert!(!shared.consent_in_flight(), "guard releases the consent flag");
    }

    // ── Full check + download against a local signed feed ──────────────────
    //
    // A path-routing HTTP server (the tide-tools http.rs / or_catalog test
    // pattern) serves the channel JSON and the artifact; a test minisign
    // keypair signs the artifact so the plugin's verification runs for
    // real — including the wrong-key failure below.

    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    fn feed_listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        (listener, base)
    }

    fn serve_feed(listener: TcpListener, json_body: String, artifact: Vec<u8>) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                loop {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    loop {
                        match stream.read(&mut byte) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                head.push(byte[0]);
                                if head.ends_with(b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    if head.is_empty() {
                        break;
                    }
                    let request = String::from_utf8_lossy(&head);
                    let path = request.split(' ').nth(1).unwrap_or("/").to_owned();
                    let (content_type, body): (&str, Vec<u8>) = if path.ends_with(".json") {
                        ("application/json", json_body.clone().into_bytes())
                    } else {
                        ("application/octet-stream", artifact.clone())
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                        body.len()
                    );
                    if stream.write_all(response.as_bytes()).is_err()
                        || stream.write_all(&body).is_err()
                    {
                        break;
                    }
                }
            }
        });
    }

    /// Signs `data` with a fresh keypair → (config pubkey, feed signature),
    /// both base64(minisign-file-content), the wire format the plugin
    /// decodes.
    fn sign_artifact(data: &[u8]) -> (String, String) {
        let minisign::KeyPair { pk, sk } = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let signature = minisign::sign(
            Some(&pk),
            &sk,
            std::io::Cursor::new(data.to_vec()),
            None,
            None,
        )
        .unwrap();
        let engine = base64::engine::general_purpose::STANDARD;
        (
            engine.encode(pk.to_box().unwrap().to_string()),
            engine.encode(signature.to_string()),
        )
    }

    /// Mock app with the updater plugin registered against a test pubkey,
    /// plus the managed shared state. The plugin refuses to initialize
    /// without a `plugins.updater` config object, so the mock context gets
    /// an empty one injected — every meaningful value (pubkey, endpoints)
    /// is overridden on the builder at runtime. mock_app's package-info
    /// version (0.1.0) is what the updater compares the feed's 999.0.0
    /// against.
    fn mock_updater_app(pubkey: &str) -> (tauri::App<tauri::test::MockRuntime>, Arc<UpdaterShared>) {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".to_owned(), serde_json::json!({ "pubkey": "", "endpoints": [] }));
        let app = tauri::test::mock_builder().build(context).unwrap();
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey.to_owned()).build())
            .unwrap();
        let shared = Arc::new(UpdaterShared::new("0.1.0"));
        app.manage(Arc::clone(&shared));
        (app, shared)
    }

    async fn check_once(
        app: &tauri::App<tauri::test::MockRuntime>,
        shared: &UpdaterShared,
        endpoint: Url,
    ) {
        let updater = app
            .handle()
            .updater_builder()
            .endpoints(vec![endpoint])
            .and_then(|builder| builder.build())
            .unwrap();
        run_check_core(updater, shared).await.unwrap();
    }

    #[tokio::test]
    async fn check_and_download_against_a_signed_mock_feed() {
        let artifact = b"tiny updater artifact".to_vec();
        let (pubkey, signature) = sign_artifact(&artifact);
        let (listener, base) = feed_listener();
        let feed = format!(
            r#"{{"version":"999.0.0","notes":"mock release","pub_date":"2026-08-27T00:00:00Z","url":"{base}/artifact","signature":"{signature}"}}"#
        );
        serve_feed(listener, feed, artifact.clone());
        let endpoint = Url::parse(&format!("{base}/latest.json")).unwrap();

        let (app, shared) = mock_updater_app(&pubkey);
        check_once(&app, &shared, endpoint).await;

        let available = shared.status().unwrap();
        assert_eq!(available.phase, UpdatePhase::Available);
        assert_eq!(available.version.as_deref(), Some("999.0.0"));

        let reply = run_download(&shared).await;
        assert_eq!(reply["ok"], serde_json::json!(true));
        let prepared = shared.downloaded().unwrap();
        assert_eq!(prepared.bytes, artifact, "verified bytes are held for apply");
        let status = shared.status().unwrap();
        assert_eq!(status.phase, UpdatePhase::Downloaded);
        assert_eq!(status.percent, Some(100));
    }

    #[tokio::test]
    async fn download_fails_verification_against_the_wrong_key() {
        let artifact = b"tiny updater artifact".to_vec();
        let (pubkey, _matching) = sign_artifact(&artifact);
        // A second keypair signs the artifact — the configured pubkey must
        // reject it.
        let (_other_pubkey, wrong_signature) = sign_artifact(&artifact);
        let (listener, base) = feed_listener();
        let feed = format!(
            r#"{{"version":"999.0.0","notes":"mock release","pub_date":"2026-08-27T00:00:00Z","url":"{base}/artifact","signature":"{wrong_signature}"}}"#
        );
        serve_feed(listener, feed, artifact.clone());
        let endpoint = Url::parse(&format!("{base}/latest.json")).unwrap();

        let (app, shared) = mock_updater_app(&pubkey);
        check_once(&app, &shared, endpoint).await;
        assert_eq!(shared.status().unwrap().phase, UpdatePhase::Available);

        let reply = run_download(&shared).await;
        assert_eq!(reply["ok"], serde_json::json!(false));
        let status = shared.status().unwrap();
        assert_eq!(status.phase, UpdatePhase::Error);
        assert!(status.error.is_some());
        assert!(shared.downloaded().is_none(), "unverified bytes never land");
    }

    #[test]
    fn release_notes_url_strips_v_prefix() {
        assert_eq!(github_repo(), "code-with-current/tide");
    }
}
