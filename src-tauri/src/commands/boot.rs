//! Boot-path commands: last-session restore (config-backed) and the consent
//! gate. The consent screen covered the Electrobun shell's Accessibility /
//! Full-Disk-Access prerequisites; the Tauri shell has none yet, so it
//! reports clear until the M4 permission work revisits it. The splash's
//! routing effect calls `consentShouldShow` without a `.catch`, so an
//! un-ported rejection there froze the app at the splash screen.

use serde::Serialize;

use crate::state::AppState;

use super::CommandError;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastSessionWire {
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
}

#[tauri::command]
pub fn last_session_get(state: tauri::State<AppState>) -> Result<LastSessionWire, CommandError> {
    #[cfg(debug_assertions)]
    eprintln!("[tide] last_session_get");
    state.read_config(|cfg| LastSessionWire {
        session_id: cfg.last_session_id.clone(),
        workspace_id: cfg.last_workspace_id.clone(),
    })
}

#[tauri::command]
pub fn last_session_set(
    state: tauri::State<AppState>,
    session_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<(), CommandError> {
    #[cfg(debug_assertions)]
    eprintln!("[tide] last_session_set session={session_id:?} workspace={workspace_id:?}");
    state.update_config(|cfg| {
        cfg.last_session_id = session_id;
        cfg.last_workspace_id = workspace_id;
        Ok(())
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConsentWire {
    pub should_show: bool,
}

#[tauri::command]
pub fn consent_should_show() -> ConsentWire {
    #[cfg(debug_assertions)]
    eprintln!("[tide] consent_should_show -> false");
    ConsentWire { should_show: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::fs;

    fn temp_state(name: &str, config: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tide-cmd-boot-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), config).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    #[test]
    fn last_session_round_trips_and_clears() {
        let (state, dir) = temp_state(
            "roundtrip",
            r#"{"workspaces":[{"id":"ws_1","name":"a","path":"/a"}],"lastSessionId":"s_abc","lastWorkspaceId":"ws_1"}"#,
        );
        let wire = last_session_get_value(&state);
        assert_eq!(wire.session_id.as_deref(), Some("s_abc"));
        assert_eq!(wire.workspace_id.as_deref(), Some("ws_1"));

        set(&state, None, None);
        let cleared = last_session_get_value(&state);
        assert_eq!(cleared.session_id, None);
        assert_eq!(cleared.workspace_id, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn consent_reports_clear() {
        assert!(!consent_should_show().should_show);
    }

    fn last_session_get_value(state: &AppState) -> LastSessionWire {
        state
            .read_config(|cfg| LastSessionWire {
                session_id: cfg.last_session_id.clone(),
                workspace_id: cfg.last_workspace_id.clone(),
            })
            .unwrap()
    }

    fn set(state: &AppState, session_id: Option<&str>, workspace_id: Option<&str>) {
        state
            .update_config(|cfg| {
                cfg.last_session_id = session_id.map(str::to_owned);
                cfg.last_workspace_id = workspace_id.map(str::to_owned);
                Ok(())
            })
            .unwrap();
    }
}
