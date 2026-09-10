//! The built-in tool set, ported from `app/core/agent/tools/*.ts` ().
//! Each module exposes a unit struct implementing [`crate::Tool`];
//! [`core_tools`] returns the full set for the orchestrator's toolset.

pub mod agent_message;
pub mod ask_followup;
pub mod background_shell;
pub mod bash;
pub mod browser;
pub mod browser_tools;
pub mod compact;
pub mod computer;
pub mod computer_tools;
pub mod directory_tree;
pub mod dispatch_agent;
pub mod edit_file;
pub mod exit_plan_mode;
pub mod git;
pub mod git_repo;
pub mod glob;
pub mod grep;
pub mod init;
pub mod job_tools;
pub mod list_dir;
pub mod load_skill;
pub mod memory;
pub mod multi_edit;
pub mod notebook_edit;
pub mod proc;
pub mod read_file;
pub mod read_media_file;
pub mod remember;
pub mod session_history;
pub mod slash_command;
pub mod todo_write;
pub mod web_fetch;
pub mod web_search;
pub mod write_file;

use crate::Tool;

pub use agent_message::{ListAgentsTool, SendMessageTool};
pub use ask_followup::{
    AskFollowupTool, FollowupAsk, FollowupOption, followup_pick_outcome, normalize_followup_args,
    render_followup_text,
};
pub use background_shell::{BashOutputTool, KillShellTool};
pub use bash::BashTool;
pub use browser::BrowserBackend;
pub use browser_tools::{
    BROWSER_TOOLS, BrowserClickTool, BrowserGetStateTool, BrowserNavigateTool, BrowserPressKeyTool,
    BrowserScreenshotTool, BrowserScrollTool, BrowserSetViewportTool, BrowserTypeTool,
    is_browser_tool,
};
pub use compact::{CompactTool, DEFAULT_KEEP_LAST};
pub use computer::ComputerBackend;
pub use computer_tools::{
    COMPUTER_TOOLS, ClickTool, DragTool, GetAppStateTool, ListAppsTool, PerformSecondaryActionTool,
    PressKeyTool, ScrollTool, SetValueTool, TypeTextTool, is_computer_tool,
};
pub use directory_tree::DirectoryTreeTool;
pub use dispatch_agent::DispatchAgentTool;
pub use edit_file::EditFileTool;
pub use exit_plan_mode::ExitPlanModeTool;
pub use git::GitTool;
pub use git_repo::GitRepoTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use init::InitTool;
pub use job_tools::{JobKillTool, JobListTool, JobOutputTool};
pub use list_dir::ListDirTool;
pub use load_skill::LoadSkillTool;
pub use memory::{MemoryIndex, MemoryTool};
pub use multi_edit::MultiEditTool;
pub use notebook_edit::NotebookEditTool;
pub use read_file::ReadFileTool;
pub use read_media_file::ReadMediaFileTool;
pub use remember::RememberTool;
pub use session_history::{
    ListSessionsTool, ReadSessionTool, SessionMessage, SessionPage, SessionReader, SessionSummary,
    set_shared_session_reader, shared_session_reader,
};
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
        Box::new(JobOutputTool),
        Box::new(JobListTool),
        Box::new(JobKillTool),
        Box::new(BashOutputTool),
        Box::new(KillShellTool),
        Box::new(GitTool),
        Box::new(GitRepoTool),
        Box::new(WebFetchTool),
        Box::new(WebSearchTool),
        Box::new(DispatchAgentTool),
        Box::new(SendMessageTool),
        Box::new(ListAgentsTool),
        Box::new(TodoWriteTool),
        Box::new(AskFollowupTool),
        Box::new(ExitPlanModeTool),
        Box::new(CompactTool),
        Box::new(SlashCommandTool),
        Box::new(MemoryTool::new(None)),
        Box::new(InitTool),
        Box::new(LoadSkillTool),
        Box::new(RememberTool),
        Box::new(ListAppsTool),
        Box::new(GetAppStateTool),
        Box::new(ClickTool),
        Box::new(DragTool),
        Box::new(PressKeyTool),
        Box::new(TypeTextTool),
        Box::new(PerformSecondaryActionTool),
        Box::new(SetValueTool),
        Box::new(ScrollTool),
        Box::new(BrowserNavigateTool),
        Box::new(BrowserGetStateTool),
        Box::new(BrowserScreenshotTool),
        Box::new(BrowserClickTool),
        Box::new(BrowserTypeTool),
        Box::new(BrowserPressKeyTool),
        Box::new(BrowserScrollTool),
        Box::new(BrowserSetViewportTool),
        Box::new(ListSessionsTool),
        Box::new(ReadSessionTool),
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
