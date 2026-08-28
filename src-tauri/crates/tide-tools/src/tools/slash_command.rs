//! slash_command — port of `app/core/agent/tools/slash-command.ts`
//! (). User-defined slash commands are prompt-prefix macros in
//! `<userData>/commands/*.md` (first non-empty line = description); the
//! tool returns the body as instructions to apply to the task at hand.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const DESCRIPTION: &str = "Invoke a user-defined slash command. Commands live in <userData>/commands/*.md and bundle a prompt prefix + instructions. Use when the user explicitly references one (e.g. \"run /refactor on src/\") or when a known command matches the task. Returns the command body so you can apply its instructions.";

/// `<userData>/commands` — same resolution as `tide-store::paths::data_dir`
/// (`~/.tide`, `TIDE_DATA_DIR` override) without taking a crate dependency
/// on tide-store (which would drag rusqlite in). The TS original called
/// `appDataDir()` fresh on every invocation; do the same.
pub fn commands_dir() -> PathBuf {
    let data_dir = match std::env::var_os("TIDE_DATA_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir().unwrap_or_default().join(".tide"),
    };
    data_dir.join("commands")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
}

/// List available slash commands (name + description), sorted by name.
pub fn list_slash_commands() -> Vec<SlashCommand> {
    list_slash_commands_in(&commands_dir())
}

fn list_slash_commands_in(dir: &std::path::Path) -> Vec<SlashCommand> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<SlashCommand> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".md") && e.path().is_file())
        .map(|e| {
            let name = e
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".md")
                .to_string();
            let description = std::fs::read_to_string(e.path())
                .map(|raw| {
                    let trimmed = raw.trim();
                    let first_line = trimmed.split('\n').next().unwrap_or("");
                    clamp_chars(first_line, 120)
                })
                .unwrap_or_default();
            SlashCommand { name, description }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Char-boundary-safe clamp (the TS `slice(0, n)` on a UTF-16 string).
pub(crate) fn clamp_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Shared body — reads `<userData>/commands/<name>.md`; no ctx dependency.
pub(crate) fn run_slash_command(
    command: &str,
    args: &str,
    commands_dir: &std::path::Path,
) -> ToolOutcome {
    let name = command.trim_start_matches('/');
    if name.is_empty() {
        return ToolOutcome::failed("Missing required arg: command");
    }
    // The TS joined the name naively; reject path separators so a hostile
    // `command` can't traverse out of the commands dir.
    if name.contains(['/', '\\']) || name.contains("..") || name.contains('\0') {
        return ToolOutcome::failed(format!(
            "Invalid command name: /{name}. Command names are plain file names."
        ));
    }

    let file = commands_dir.join(format!("{name}.md"));
    if !file.is_file() {
        let available = list_slash_commands_in(commands_dir);
        let list = if !available.is_empty() {
            format!(
                "Available: {}.",
                available
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            "No commands are installed. Drop .md files in <userData>/commands/.".to_string()
        };
        return ToolOutcome::failed(format!("Unknown command: /{name}. {list}"));
    }

    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(e) => return ToolOutcome::failed(format!("Cannot read command file: {e}")),
    };
    let bytes = raw.len();
    let body = raw.trim().to_string();

    let lines = body.split('\n').count();
    // First non-empty line is the human description (commands/*.md convention).
    let description = body
        .split('\n')
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| clamp_chars(l, 120))
        .unwrap_or_default();
    let arg_suffix = if args.is_empty() {
        String::new()
    } else {
        format!("\n\nArguments: {args}")
    };

    ToolOutcome::executed(format!(
        "/{name} loaded. Apply its instructions to the task at hand.{arg_suffix}\n\n---\n{body}"
    ))
    .with_meta(format!("/{name} · {lines}L"))
    // file_loaded display → renders a compact "loaded <path> · N lines ·
    // N bytes" card with the body collapsible.
    .with_display(ToolDisplay::FileLoaded {
        path: format!("commands/{name}.md"),
        lines: lines as u64,
        bytes: bytes as u64,
        description: Some(description),
        body,
    })
}

pub struct SlashCommandTool;

impl Tool for SlashCommandTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "slash_command".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command name without the leading slash (e.g. \"refactor\")." },
                    "args": { "type": "string", "description": "Optional arguments to pass to the command." }
                },
                "required": ["command"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        let command = arg_str(&args, "command");
        let extra = arg_str(&args, "args");
        Ok(run_slash_command(&command, &extra, &commands_dir_for(ctx)))
    }
}

/// Resolve the commands dir against the context so tests can point it at a
/// tempdir; production contexts use the real `<userData>/commands`.
fn commands_dir_for(_ctx: &ToolContext) -> PathBuf {
    commands_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use serde_json::json;

    #[test]
    fn loads_command_body_with_display_card() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("refactor.md"),
            "Refactor the selected code safely.\n\nDo X then Y.",
        )
        .unwrap();

        let out = run_slash_command("refactor", "src/lib", &dir);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "/refactor loaded. Apply its instructions to the task at hand.\n\nArguments: src/lib\n\n---\nRefactor the selected code safely.\n\nDo X then Y."
        );
        assert_eq!(out.meta.as_deref(), Some("/refactor · 3L"));
        let ToolDisplay::FileLoaded {
            path,
            lines,
            bytes,
            description,
            body,
        } = out.display.unwrap()
        else {
            panic!("file_loaded display");
        };
        assert_eq!(path, "commands/refactor.md");
        assert_eq!(lines, 3);
        assert_eq!(bytes, 48);
        assert_eq!(
            description.as_deref(),
            Some("Refactor the selected code safely.")
        );
        assert!(body.contains("Do X then Y."));
    }

    #[test]
    fn no_args_means_no_arguments_suffix() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.md"), "Body").unwrap();
        let out = run_slash_command("/x", "", &dir);
        assert!(out
            .output
            .starts_with("/x loaded. Apply its instructions to the task at hand.\n\n---\nBody"));
        assert!(!out.output.contains("Arguments:"));
    }

    #[test]
    fn missing_command_lists_available() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.md"), "A").unwrap();
        std::fs::write(dir.join("beta.md"), "B").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a command").unwrap();

        let out = run_slash_command("nope", "", &dir);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Unknown command: /nope. Available: alpha, beta."
        );
    }

    #[test]
    fn missing_command_with_no_commands_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_slash_command("nope", "", &tmp.path().join("commands"));
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Unknown command: /nope. No commands are installed. Drop .md files in <userData>/commands/."
        );
    }

    #[test]
    fn missing_command_arg_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_slash_command("", "", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: command");
    }

    #[test]
    fn list_sorts_and_describes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("zeta.md"), "Zeta command\nbody").unwrap();
        std::fs::write(dir.join("alpha.md"), "Alpha command\nbody").unwrap();
        let list = list_slash_commands_in(&dir);
        assert_eq!(
            list,
            vec![
                SlashCommand {
                    name: "alpha".into(),
                    description: "Alpha command".into()
                },
                SlashCommand {
                    name: "zeta".into(),
                    description: "Zeta command".into()
                },
            ]
        );
    }

    #[test]
    fn description_clamped_to_120_chars() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        let long = "x".repeat(200);
        std::fs::write(dir.join("long.md"), format!("{long}\nbody")).unwrap();
        let out = run_slash_command("long", "", &dir);
        let ToolDisplay::FileLoaded { description, .. } = out.display.unwrap() else {
            panic!("file_loaded display");
        };
        assert_eq!(description.as_deref().map(str::len), Some(120));
    }

    #[test]
    fn traversal_names_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret.md"), "s").unwrap();
        for bad in ["../secret", "a/b", "..\\secret"] {
            let out = run_slash_command(bad, "", &tmp.path().join("commands"));
            assert_eq!(out.status, OutcomeStatus::Failed, "{bad}");
            assert!(out.output.contains("Invalid command name"), "{bad}");
        }
    }

    #[test]
    fn execute_routes_through_trait() {
        // TIDE_DATA_DIR points the tool's commands dir at a tempdir.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hello.md"), "Say hello politely.").unwrap();

        let guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TIDE_DATA_DIR", tmp.path());
        let tool = SlashCommandTool;
        assert_eq!(tool.spec().name, "slash_command");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let ctx = ToolContext::new(tmp.path());
        let out = tool.execute(&ctx, json!({ "command": "hello" })).unwrap();
        std::env::remove_var("TIDE_DATA_DIR");
        drop(guard);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Say hello politely."));
    }

    // set_var/remove_var are process-global; serialize the env-touching test.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
