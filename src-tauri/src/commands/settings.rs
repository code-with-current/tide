//! `settingsGetAgent`/`settingsUpdateAgent`/`settingsGetGeneral`/
//! `settingsUpdateGeneral` — backs the four TideRPC settings methods. Get
//! returns the effective block (TS defaults layered over the stored partial,
//! exactly `{...DEFAULT_*_SETTINGS, ...cfg.*Settings}`); update merges the
//! patch over the current stored block, saves atomically, and returns the
//! new effective block. The merge is key-presence-based at the JSON level —
//! the faithful port of the TS object spread — so an explicit `null` patch
//! value overwrites (e.g. clearing `titleModel`) while an absent key keeps
//! the stored value, and unknown keys land in the flatten-preserved extras.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};
use tide_store::config::{
    AgentSettings, EffectiveAgentSettings, EffectiveGeneralSettings, GeneralSettings,
};

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
    state: tauri::State<AppState>,
) -> Result<EffectiveGeneralSettings, CommandError> {
    get_general(&state)
}

fn get_general(state: &AppState) -> Result<EffectiveGeneralSettings, CommandError> {
    state.read_config(|cfg| {
        cfg.general_settings
            .clone()
            .unwrap_or_default()
            .effective()
    })
}

#[tauri::command]
pub fn settings_update_general(
    state: tauri::State<AppState>,
    patch: Value,
) -> Result<EffectiveGeneralSettings, CommandError> {
    update_general(&state, patch)
}

fn update_general(
    state: &AppState,
    patch: Value,
) -> Result<EffectiveGeneralSettings, CommandError> {
    let patch = patch_map(patch)?;
    state.update_config(|cfg| {
        let merged: GeneralSettings = merge_patch(cfg.general_settings.clone(), &patch)?;
        cfg.general_settings = Some(merged.clone());
        Ok(merged.effective())
    })
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
        let wire = serde_json::to_value(get_general(&state).unwrap()).unwrap();
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
        let updated = update_general(
            &state,
            patch(r#"{ "notifications": false, "titleModel": null }"#),
        )
        .unwrap();
        assert!(!updated.notifications);
        assert_eq!(updated.title_model, None, "explicit null overwrites (TS spread)");

        let reloaded = AppState::load(dir.clone());
        let reloaded = get_general(&reloaded).unwrap();
        assert!(!reloaded.notifications);
        assert_eq!(reloaded.title_model, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_config_fails_get_and_update() {
        let (state, dir) = state_with_config("broken", "{ nope");
        assert_eq!(
            get_agent(&state).unwrap_err().code.as_deref(),
            Some("CONFIG_UNREADABLE")
        );
        assert_eq!(
            get_general(&state).unwrap_err().code.as_deref(),
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
}
