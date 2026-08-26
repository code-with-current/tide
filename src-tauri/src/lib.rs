mod commands;
mod state;

use state::AppState;

pub fn run() {
    let app_state = AppState::from_env();
    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::bridge::tide_ping,
            commands::bridge::bridge_version,
            commands::workspaces::workspace_list,
            commands::sessions::session_list,
            commands::sessions::session_list_archived,
            commands::sessions::session_list_v2,
            commands::sessions::session_messages_v2,
            commands::settings::settings_get_agent,
            commands::settings::settings_update_agent,
            commands::settings::settings_get_general,
            commands::settings::settings_update_general,
            commands::providers::provider_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
