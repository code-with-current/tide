mod agent;
mod commands;
mod state;

use agent::hub::ChatHubCell;
use state::AppState;

pub fn run() {
    let app_state = AppState::from_env();
    let hub_cell = ChatHubCell::new();
    tauri::Builder::default()
        .manage(app_state)
        .manage(hub_cell)
        .invoke_handler(tauri::generate_handler![
            commands::boot::consent_should_show,
            commands::boot::last_session_get,
            commands::boot::last_session_set,
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
            commands::providers::provider_list,
            commands::chat::session_create,
            commands::chat::chat_run_turn,
            commands::chat::chat_abort,
            commands::chat::permission_respond,
            commands::chat::chat_attach_channel,
            commands::chat::events_subscribe,
            commands::chat::events_unsubscribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
