//! `settingsGetAgent`/`settingsUpdateAgent`/`settingsGetGeneral`/
//! `settingsUpdateGeneral` — backs the four TideRPC settings methods. Get
//! returns the effective block (TS defaults layered over the stored partial,
//! exactly `{...DEFAULT_*_SETTINGS, ...cfg.*Settings}`); update merges the
//! patch over the current stored block, saves atomically, and returns the
//! new effective block. The merge is key-presence-based at the JSON level —
//! the faithful port of the TS object spread — so an explicit `null` patch
//! value overwrites (e.g. clearing `titleModel`) while an absent key keeps
//! the stored value, and unknown keys land in the flatten-preserved extras.
//!
//! `startAtLogin` additionally drives the OS login item (the old Electron
//! `setLoginItemSettings` side effect): a patch carrying the key applies it
//! immediately (best-effort — a failed login-item write warns and keeps the
//! saved flag; the boot reconcile retries it), and every general reply
//! reports the login item's ACTUAL state so external changes (System
//! Settings, reinstall) show truth instead of the stored flag.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};
use tide_store::config::{
    AgentSettings, EffectiveAgentSettings, EffectiveGeneralSettings, GeneralSettings,
};

use crate::autostart::{reconcile, AutoStartBackend, PluginAutostart};
use crate::state::AppState;

use super::CommandError;

#[tauri::command]
pub fn settings_get_agent(
    state: tauri::State<AppState>,
) -> Result<EffectiveAgentSettings, CommandError> {
    get_agent(&state)
}

fn get_agent(state: &AppState) -> Result<EffectiveAgentSettings, CommandError> {
    state.read_config(|cfg| {
        cfg.agent_settings
            .clone()
            .unwrap_or_default()
            .effective()
    })
}

#[tauri::command]
pub fn settings_update_agent(
    state: tauri::State<AppState>,
    patch: Value,
) -> Result<EffectiveAgentSettings, CommandError> {
    update_agent(&state, patch)
}

fn update_agent(
    state: &AppState,
    patch: Value,
) -> Result<EffectiveAgentSettings, CommandError> {
    let patch = patch_map(patch)?;
    state.update_config(|cfg| {
        let merged: AgentSettings = merge_patch(cfg.agent_settings.clone(), &patch)?;
        validate_autonomy(merged.default_autonomy.as_deref())?;
        cfg.agent_settings = Some(merged.clone());
        Ok(merged.effective())
    })
}

#[tauri::command]
pub fn settings_get_general(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<EffectiveGeneralSettings, CommandError> {
    let autostart = PluginAutostart::new(&app);
    get_general(&state, &autostart)
}

fn get_general(
    state: &AppState,
    autostart: &dyn AutoStartBackend,
) -> Result<EffectiveGeneralSettings, CommandError> {
    let effective = state
        .read_config(|cfg| cfg.general_settings.clone().unwrap_or_default().effective())?;
    Ok(with_actual_autostart(effective, autostart))
}

#[tauri::command]
pub fn settings_update_general(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    patch: Value,
) -> Result<EffectiveGeneralSettings, CommandError> {
    let autostart = PluginAutostart::new(&app);
    update_general(&state, &autostart, patch)
}

fn update_general(
    state: &AppState,
    autostart: &dyn AutoStartBackend,
    patch: Value,
) -> Result<EffectiveGeneralSettings, CommandError> {
    let patch = patch_map(patch)?;
    // Key presence (not value truthiness): `startAtLogin: null` clears to
    // the default and still applies — the TS `'startAtLogin' in patch` guard.
    let touches_autostart = patch.contains_key("startAtLogin");
    let effective = state.update_config(|cfg| {
        let merged: GeneralSettings = merge_patch(cfg.general_settings.clone(), &patch)?;
        cfg.general_settings = Some(merged.clone());
        Ok(merged.effective())
    })?;
    if touches_autostart {
        if let Err(e) = reconcile(autostart, effective.start_at_login) {
            eprintln!("[tide] failed to apply startAtLogin: {e}");
        }
    }
    Ok(with_actual_autostart(effective, autostart))
}

/// Overlay the login item's actual state onto the effective block. Best
/// effort: a failing query keeps the stored flag rather than failing the
/// whole settings read.
fn with_actual_autostart(
    mut effective: EffectiveGeneralSettings,
    autostart: &dyn AutoStartBackend,
) -> EffectiveGeneralSettings {
    match autostart.is_enabled() {
        Ok(actual) => effective.start_at_login = actual,
        Err(e) => eprintln!("[tide] autostart state unavailable, serving stored flag: {e}"),
    }
    effective
}

fn patch_map(patch: Value) -> Result<Map<String, Value>, CommandError> {
    match patch {
        Value::Object(map) => Ok(map),
        other => Err(CommandError::with_code(
            format!("patch must be an object, got {}", type_name(&other)),
            "VALIDATION",
        )),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// `{...current, ...patch}`: serialize the stored block, overlay the patch
/// keys, parse the result back. Parse failures are validation failures (a
/// patch key with the wrong shape) and abort the write.
fn merge_patch<T>(stored: Option<T>, patch: &Map<String, Value>) -> Result<T, CommandError>
where
    T: Serialize + DeserializeOwned,
{
    let mut merged = match stored {
        Some(stored) => serde_json::to_value(stored).expect("settings block serializes"),
        None => Value::Object(Map::new()),
    };
    let obj = merged
        .as_object_mut()
        .expect("settings block serializes to an object");
    for (key, value) in patch {
        obj.insert(key.clone(), value.clone());
    }
    serde_json::from_value(merged)
        .map_err(|e| CommandError::with_code(format!("invalid settings patch: {e}"), "VALIDATION"))
}

/// `Partial<AgentSettingsWire>` narrows `defaultAutonomy` to the four modes;
/// the wire types can't enforce that at runtime, so the command does.
fn validate_autonomy(value: Option<&str>) -> Result<(), CommandError> {
    if let Some(value) = value {
        if !matches!(value, "plan" | "ask" | "edit" | "full") {
            return Err(CommandError::with_code(
                format!("invalid defaultAutonomy: {value}"),
                "VALIDATION",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autostart::MockAutoStart;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_with_config(name: &str, config_json: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(dir.join("config.json"), config_json).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    fn patch(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn get_agent_layers_defaults_over_empty_config() {
        let (state, dir) = state_with_config("agent-defaults", "{}");
        let wire = serde_json::to_value(get_agent(&state).unwrap()).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "defaultAutonomy": "ask",
                "maxSteps": 100,
                "permissionTimeoutMin": 10,
                "planModeDryRun": true,
                "auditShellCommands": true,
                "compactionEnabled": true,
                "compactionThreshold": 0.75,
                "compactionKeepTurns": 3,
                "experimentalBackgroundDispatch": false,
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_general_layers_defaults_and_keeps_model_refs() {
        let (state, dir) = state_with_config(
            "general-defaults",
            r#"{"generalSettings":{
                "notifications": false,
                "titleModel": { "providerId": "p_1", "modelId": "glm-4.5-air" }
            }}"#,
        );
        let autostart = MockAutoStart::default();
        let wire = serde_json::to_value(get_general(&state, &autostart).unwrap()).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "startAtLogin": false,
                "notifications": false,
                "notificationSound": true,
                "gitCoAuthored": true,
                "gitCoAuthorName": "Tide",
                "gitCoAuthorEmail": "314188112+tide-codes@users.noreply.github.com",
                "titleModel": { "providerId": "p_1", "modelId": "glm-4.5-air" },
                "commitMessageModel": null,
                "autoUpdateCheck": true,
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_agent_round_trips_through_disk() {
        let (state, dir) = state_with_config("agent-update", "{}");
        let updated = update_agent(
            &state,
            patch(r#"{ "maxSteps": 5, "defaultAutonomy": "plan" }"#),
        )
        .unwrap();
        assert_eq!(updated.max_steps, 5);
        assert_eq!(updated.default_autonomy, "plan");
        assert_eq!(updated.compaction_threshold, 0.75, "untouched keys keep defaults");

        let reloaded = AppState::load(dir.clone());
        let reloaded = get_agent(&reloaded).unwrap();
        assert_eq!(reloaded.max_steps, 5);
        assert_eq!(reloaded.default_autonomy, "plan");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_agent_merges_over_stored_and_preserves_unknown_fields() {
        let (state, dir) = state_with_config(
            "agent-merge",
            r#"{"agentSettings": { "maxSteps": 5, "agentFuture": "keep" }}"#,
        );
        update_agent(&state, patch(r#"{ "compactionEnabled": false }"#)).unwrap();
        let disk: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk["agentSettings"]["maxSteps"], serde_json::json!(5));
        assert_eq!(disk["agentSettings"]["compactionEnabled"], serde_json::json!(false));
        assert_eq!(disk["agentSettings"]["agentFuture"], serde_json::json!("keep"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_agent_rejects_invalid_values_without_writing() {
        let (state, dir) = state_with_config("agent-invalid", r#"{"agentSettings": { "maxSteps": 5 } }"#);
        let before = fs::read_to_string(dir.join("config.json")).unwrap();

        let err = update_agent(&state, patch(r#"{ "defaultAutonomy": "yolo" }"#)).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("VALIDATION"));

        let err = update_agent(&state, patch(r#"{ "maxSteps": "lots" }"#)).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("VALIDATION"));

        let err = update_agent(&state, patch("5")).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("VALIDATION"));

        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), before);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_general_round_trips_and_clears_model_ref() {
        let (state, dir) = state_with_config(
            "general-update",
            r#"{"generalSettings":{
                "titleModel": { "providerId": "p_1", "modelId": "glm-4.5-air" }
            }}"#,
        );
        let autostart = MockAutoStart::default();
        let updated = update_general(
            &state,
            &autostart,
            patch(r#"{ "notifications": false, "titleModel": null }"#),
        )
        .unwrap();
        assert!(!updated.notifications);
        assert_eq!(updated.title_model, None, "explicit null overwrites (TS spread)");

        let reloaded = AppState::load(dir.clone());
        let reloaded = get_general(&reloaded, &autostart).unwrap();
        assert!(!reloaded.notifications);
        assert_eq!(reloaded.title_model, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_config_fails_get_and_update() {
        let (state, dir) = state_with_config("broken", "{ nope");
        let autostart = MockAutoStart::default();
        assert_eq!(
            get_agent(&state).unwrap_err().code.as_deref(),
            Some("CONFIG_UNREADABLE")
        );
        assert_eq!(
            get_general(&state, &autostart).unwrap_err().code.as_deref(),
            Some("CONFIG_UNREADABLE")
        );
        assert_eq!(
            update_agent(&state, patch(r#"{"maxSteps": 5}"#))
                .unwrap_err()
                .code
                .as_deref(),
            Some("CONFIG_UNREADABLE")
        );
        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), "{ nope");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_general_applies_start_at_login_immediately() {
        let (state, dir) = state_with_config("general-autostart", "{}");
        let autostart = MockAutoStart::with_enabled(false);

        let updated =
            update_general(&state, &autostart, patch(r#"{ "startAtLogin": true }"#)).unwrap();
        assert!(updated.start_at_login);
        assert_eq!(
            autostart.calls(),
            [
                "is_enabled".to_owned(),
                "set_enabled(true)".to_owned(),
                "is_enabled".to_owned(),
            ]
        );

        let disk: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk["generalSettings"]["startAtLogin"], serde_json::json!(true));

        let updated =
            update_general(&state, &autostart, patch(r#"{ "startAtLogin": false }"#)).unwrap();
        assert!(!updated.start_at_login);
        assert_eq!(
            autostart.calls().last().map(String::as_str),
            Some("is_enabled"),
            "disables after enabling"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_general_clearing_start_at_login_applies_the_default() {
        let (state, dir) = state_with_config(
            "general-autostart-clear",
            r#"{"generalSettings": { "startAtLogin": true }}"#,
        );
        let autostart = MockAutoStart::with_enabled(true);
        let updated =
            update_general(&state, &autostart, patch(r#"{ "startAtLogin": null }"#)).unwrap();
        assert!(!updated.start_at_login, "null clears to the default");
        assert!(autostart.calls().contains(&"set_enabled(false)".to_owned()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_general_without_the_key_leaves_the_login_item_alone() {
        let (state, dir) = state_with_config(
            "general-autostart-untouched",
            r#"{"generalSettings": { "startAtLogin": true }}"#,
        );
        let autostart = MockAutoStart::with_enabled(false);
        let updated =
            update_general(&state, &autostart, patch(r#"{ "notifications": false }"#)).unwrap();
        assert!(
            !autostart.calls().iter().any(|c| c.starts_with("set_enabled")),
            "no implicit reconcile on unrelated patches"
        );
        assert!(!updated.start_at_login, "reply still reports actual state");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_general_survives_login_item_failure() {
        let (state, dir) = state_with_config("general-autostart-fail", "{}");
        let autostart = MockAutoStart::with_enabled(false);
        autostart.fail_set();
        let updated =
            update_general(&state, &autostart, patch(r#"{ "startAtLogin": true }"#)).unwrap();
        assert!(!updated.start_at_login, "reply reports the login item that exists");
        let reloaded = AppState::load(dir.clone());
        let stored = reloaded
            .read_config(|cfg| cfg.general_settings.clone().unwrap_or_default().start_at_login)
            .unwrap();
        assert_eq!(stored, Some(true), "failed apply still saves the flag (boot retries)");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_general_reports_actual_login_item_over_stored_flag() {
        let (state, dir) = state_with_config(
            "general-external-drift",
            r#"{"generalSettings": { "startAtLogin": true }}"#,
        );
        let autostart = MockAutoStart::with_enabled(false);
        assert!(!get_general(&state, &autostart).unwrap().start_at_login);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_general_falls_back_to_stored_flag_when_state_unreadable() {
        let (state, dir) = state_with_config(
            "general-state-error",
            r#"{"generalSettings": { "startAtLogin": true }}"#,
        );
        let autostart = MockAutoStart::default();
        autostart.fail_is_enabled();
        assert!(get_general(&state, &autostart).unwrap().start_at_login);
        fs::remove_dir_all(&dir).unwrap();
    }
}
