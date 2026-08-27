mod agent;
mod commands;
mod state;

use tauri::Manager;

use agent::hub::ChatHubCell;
use agent::mcp::McpPoolCell;
use state::AppState;

pub fn run() {
    let app_state = AppState::from_env();
    let hub_cell = ChatHubCell::new();
    let mcp_cell = McpPoolCell::new();
    // Boot-connect the MCP pool (TS app.main initUserServers): user servers
    // come up in the background; turns pick up whatever is connected.
    {
        let boot_cell = mcp_cell.clone();
        let data_dir = tide_store::paths::data_dir();
        let config =
            tide_store::config::load(&data_dir.join("config.json")).unwrap_or_default();
        tauri::async_runtime::spawn(async move {
            boot_cell.ensure_started(data_dir, config, None).await;
        });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .manage(hub_cell)
        .manage(mcp_cell)
        .setup(|app| {
            // models.dev catalog boot init (TS initModelCatalog): load the
            // bundled/cache baseline, refresh in the background when stale.
            let handle = app.handle().clone();
            let data_dir = tide_store::paths::data_dir();
            tauri::async_runtime::spawn(async move {
                commands::model_catalog::init(&handle.state::<AppState>(), &data_dir).await;
            });
            Ok(())
        })
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
            commands::sessions::session_get,
            commands::sessions::session_rename,
            commands::sessions::session_archive,
            commands::sessions::session_unarchive,
            commands::sessions::session_delete,
            commands::sessions::session_update_settings,
            commands::sessions::session_fork,
            commands::sessions::session_list_dispatches,
            commands::sessions::session_add_message,
            commands::sessions::session_add_assistant_message,
            commands::sessions::session_finalize_assistant_message,
            commands::sessions::session_add_usage,
            commands::sessions::session_generate_title,
            commands::sessions::session_clear_all,
            commands::sessions::session_create_worktree,
            commands::sessions::session_remove_worktree,
            commands::workspaces::workspace_get,
            commands::workspaces::workspace_add,
            commands::workspaces::workspace_update,
            commands::workspaces::workspace_archive,
            commands::workspaces::workspace_unarchive,
            commands::workspaces::workspace_delete,
            commands::workspaces::workspace_context_get,
            commands::workspaces::workspace_file_read,
            commands::workspaces::workspace_list_branches,
            commands::workspaces::workspace_list_config_files,
            commands::workspaces::workspaces_exist,
            commands::settings::settings_get_agent,
            commands::settings::settings_update_agent,
            commands::settings::settings_get_general,
            commands::settings::settings_update_general,
            commands::misc::window_close,
            commands::misc::window_minimize,
            commands::misc::window_toggle_maximize,
            commands::misc::window_is_full_screen,
            commands::misc::dialog_pick_files,
            commands::misc::dialog_pick_directory,
            commands::misc::shell_open_external,
            commands::misc::shell_open_path,
            commands::misc::shell_show_item_in_folder,
            commands::misc::clipboard_file_save,
            commands::misc::log_send,
            commands::misc::env_info_get,
            commands::misc::diagnostics_get,
            commands::misc::permission_status_get,
            commands::misc::permission_request,
            commands::misc::process_is_alive,
            commands::misc::mermaid_repair,
            commands::misc::external_file_read,
            commands::misc::image_file_read,
            commands::shortcuts::settings_get,
            commands::shortcuts::settings_set_shortcut,
            commands::shortcuts::settings_reset_shortcuts,
            commands::providers::provider_list,
            commands::providers::provider_add,
            commands::providers::provider_update,
            commands::providers::provider_delete,
            commands::providers::provider_probe_models,
            commands::providers::provider_detect_protocol,
            commands::providers::provider_test_connection,
            commands::providers::provider_usage_windows,
            commands::providers::provider_usage_report,
            commands::providers::model_catalog_refresh,
            commands::providers::model_catalog_resolve,
            commands::misc::agent_list,
            commands::chat::session_create,
            commands::chat::chat_run_turn,
            commands::chat::chat_abort,
            commands::chat::permission_respond,
            commands::chat::chat_submit_followup,
            commands::chat::chat_attach_channel,
            commands::chat::events_subscribe,
            commands::chat::events_unsubscribe,
            commands::mcp::mcp_list,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_staged_diff,
            commands::git::git_log,
            commands::git::git_commit_files,
            commands::git::git_commit_file_diff,
            commands::git::git_commit_message,
            commands::git::git_bulk,
            commands::git::git_stash_list,
            commands::git::git_stage,
            commands::git::git_restore_file,
            commands::git::git_discard_file,
            commands::git::git_commit,
            commands::git::git_amend,
            commands::git::git_revert,
            commands::git::git_ahead_behind,
            commands::git::git_head_sha,
            commands::git::git_branch_info,
            commands::git::git_branches_detailed,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_checkout,
            commands::git::git_recent_branches,
            commands::git::git_merge_branch,
            commands::git::git_conflict_files,
            commands::git::git_resolve_file,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_repo_detect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
