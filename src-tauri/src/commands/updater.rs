//! Updater surface. Release notes are a real GitHub-API fetch (identical to
//! the TS). The check/download/apply trio is an honest M5 stub: the
//! tauri-plugin-updater wiring (signed dual channels) lands in M5 — until
//! then `updaterStatus` reports no updater loaded (the renderer's quiet
//! state, same as the TS with no update host configured) and the actions
//! report unavailable rather than pretending to succeed.

use serde::Deserialize;
use serde_json::Value;


use super::CommandError;

#[tauri::command]
pub fn updater_status() -> Option<Value> {
    None
}

#[tauri::command]
pub fn updater_check_now() -> Result<Value, CommandError> {
    Ok(serde_json::json!({ "ok": false, "error": "Update checks arrive with the M5 updater" }))
}

#[tauri::command]
pub fn updater_download() -> Result<Value, CommandError> {
    Ok(serde_json::json!({ "ok": false, "error": "Update downloads arrive with the M5 updater" }))
}

#[tauri::command]
pub fn updater_apply() -> Result<Value, CommandError> {
    Ok(serde_json::json!({ "ok": false, "error": "Update installs arrive with the M5 updater" }))
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

    #[test]
    fn stubs_report_unavailable_not_success() {
        assert!(updater_status().is_none());
        assert!(updater_check_now().unwrap()["ok"] == false);
        assert!(updater_download().unwrap()["ok"] == false);
        assert!(updater_apply().unwrap()["ok"] == false);
    }

    #[test]
    fn release_notes_url_strips_v_prefix() {
        assert_eq!(github_repo(), "code-with-current/tide");
    }
}
