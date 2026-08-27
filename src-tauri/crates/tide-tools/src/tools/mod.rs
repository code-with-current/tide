//! The built-in tool set, ported from `app/core/agent/tools/*.ts` (91ec558).
//! Each module exposes a unit struct implementing [`crate::Tool`];
//! [`core_tools`] returns the full set for the orchestrator's toolset.

pub mod ask_followup;
pub mod background_shell;
pub mod bash;
pub mod compact;
pub mod directory_tree;
pub mod dispatch_agent;
pub mod edit_file;
pub mod exit_plan_mode;
pub mod git;
pub mod git_repo;
pub mod glob;
pub mod grep;
pub mod init;
pub mod list_dir;
pub mod load_skill;
pub mod memory;
pub mod multi_edit;
pub mod notebook_edit;
pub mod proc;
pub mod read_file;
pub mod read_media_file;
pub mod slash_command;
pub mod todo_write;
pub mod web_fetch;
pub mod web_search;
pub mod write_file;

use crate::Tool;

pub use ask_followup::{
    followup_pick_outcome, normalize_followup_args, render_followup_text, AskFollowupTool,
    FollowupAsk, FollowupOption,
};
pub use background_shell::{BashOutputTool, KillShellTool};
pub use bash::BashTool;
pub use compact::{CompactTool, DEFAULT_KEEP_LAST};
pub use directory_tree::DirectoryTreeTool;
pub use dispatch_agent::DispatchAgentTool;
pub use edit_file::EditFileTool;
pub use exit_plan_mode::ExitPlanModeTool;
pub use git::GitTool;
pub use git_repo::GitRepoTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use init::InitTool;
pub use list_dir::ListDirTool;
pub use load_skill::LoadSkillTool;
pub use memory::{MemoryIndex, MemoryTool};
pub use multi_edit::MultiEditTool;
pub use notebook_edit::NotebookEditTool;
pub use read_file::ReadFileTool;
pub use read_media_file::ReadMediaFileTool;
pub use slash_command::SlashCommandTool;
pub use todo_write::TodoWriteTool;
pub use web_fetch::WebFetchTool;
pub use web_search::WebSearchTool;
pub use write_file::WriteFileTool;

/// The tool instances the orchestrator registers, in the order the frozen
/// TS schema fixture lists them.
pub fn core_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ReadFileTool),
        Box::new(ListDirTool),
        Box::new(DirectoryTreeTool),
        Box::new(ReadMediaFileTool),
        Box::new(GlobTool),
        Box::new(GrepTool),
        Box::new(EditFileTool),
        Box::new(MultiEditTool),
        Box::new(WriteFileTool),
        Box::new(NotebookEditTool),
        Box::new(BashTool),
        Box::new(BashOutputTool),
        Box::new(KillShellTool),
        Box::new(GitTool),
        Box::new(GitRepoTool),
        Box::new(WebFetchTool),
        Box::new(WebSearchTool),
        Box::new(DispatchAgentTool),
        Box::new(TodoWriteTool),
        Box::new(AskFollowupTool),
        Box::new(ExitPlanModeTool),
        Box::new(CompactTool),
        Box::new(SlashCommandTool),
        Box::new(MemoryTool::new(None)),
        Box::new(InitTool),
        Box::new(LoadSkillTool),
    ]
}

/// String-coercing arg extraction mirroring the TS `String(args.x ?? "")`:
/// a missing or non-string arg becomes "" (tools report "Missing required
/// arg" as a failed outcome, like the TS versions did).
pub(crate) fn arg_str(args: &serde_json::Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

pub(crate) fn arg_bool(args: &serde_json::Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}
