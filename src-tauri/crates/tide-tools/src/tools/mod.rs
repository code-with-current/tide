//! The five core tools, ported from `app/core/agent/tools/*.ts` (91ec558).
//! Each module exposes a unit struct implementing [`crate::Tool`];
//! [`core_tools`] returns the full set for the orchestrator's toolset.

pub mod bash;
pub mod edit_file;
pub mod glob;
pub mod grep;
pub mod proc;
pub mod read_file;
pub mod write_file;

use crate::Tool;

pub use bash::BashTool;
pub use edit_file::EditFileTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use read_file::ReadFileTool;
pub use write_file::WriteFileTool;

/// The core five (+glob) tool instances the orchestrator registers.
pub fn core_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ReadFileTool),
        Box::new(WriteFileTool),
        Box::new(EditFileTool),
        Box::new(BashTool),
        Box::new(GrepTool),
        Box::new(GlobTool),
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
