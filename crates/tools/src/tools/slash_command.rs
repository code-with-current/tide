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

const DESCRIPTION: &str = "Invoke a user-defined slash command or skill by its /name. Commands live in <userData>/commands/*.md; built-in /kb-* commands (knowledge library) resolve with no file installed — a file with the same name overrides the built-in; skills resolve from the workspace's enabled catalog (multi-word names allowed, e.g. \"/AgentDB Advanced Features\"). Use when the user explicitly references one (e.g. \"run /refactor on src/\") or when a known command matches the task. Returns the command or skill body so you can apply its instructions — one call resolves all three, no fallback needed.";

/// `<userData>/commands` — same resolution as `store::paths::data_dir`
/// (`~/.tide`, `TIDE_DATA_DIR` override) without taking a crate dependency
/// on store (which would drag rusqlite in). The TS original called
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
/// Built-in `/kb-*` command bodies, compiled in from the repo's
/// `resources/commands/` — the memory feature's command pack resolves
/// with no install step. A user file with the same name wins, so
/// `<userData>/commands/` stays the customization surface; the Settings
/// card's copy button materializes exactly these bodies for editing.
/// Single source of truth: backend's installer reads this table too.
pub const BUILTIN_COMMANDS: &[(&str, &str)] = &[
    (
        "kb-context",
        include_str!("../../../../resources/commands/kb-context.md"),
    ),
    (
        "kb-search",
        include_str!("../../../../resources/commands/kb-search.md"),
    ),
    (
        "kb-capture",
        include_str!("../../../../resources/commands/kb-capture.md"),
    ),
    (
        "kb-iterate",
        include_str!("../../../../resources/commands/kb-iterate.md"),
    ),
];

/// When no commands file matches, the invocation falls through to the
/// built-in `/kb-*` table and then the workspace skill catalog (see
/// [`resolve_skill_fallback`]) so `/name` resolves to a command, a
/// built-in, or a skill in one call.
pub(crate) fn run_slash_command(
    command: &str,
    args: &str,
    commands_dir: &std::path::Path,
    workspace_root: &std::path::Path,
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
        if let Some((_, raw)) = BUILTIN_COMMANDS.iter().find(|(n, _)| *n == name) {
            return command_loaded(name, args, raw, true);
        }
        if let Some(outcome) = resolve_skill_fallback(name, args, workspace_root) {
            return outcome;
        }
        let mut available: Vec<String> = list_slash_commands_in(commands_dir)
            .into_iter()
            .map(|c| c.name)
            .collect();
        for (n, _) in BUILTIN_COMMANDS {
            if !commands_dir.join(format!("{n}.md")).is_file() {
                available.push(format!("{n} (built-in)"));
            }
        }
        let list = format!("Available: {}.", available.join(", "));
        return ToolOutcome::failed(format!(
            "Unknown command: /{name}. {list} If /{name} is a skill, it is not enabled in this workspace's catalog; no fallback applies."
        ));
    }

    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(e) => return ToolOutcome::failed(format!("Cannot read command file: {e}")),
    };
    command_loaded(name, args, &raw, false)
}

/// Shared load outcome for file and built-in commands: first non-empty
/// line is the description, args ride as a suffix, and the display card
/// keeps the same shape so the timeline renders both identically.
fn command_loaded(name: &str, args: &str, raw: &str, builtin: bool) -> ToolOutcome {
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

    let origin = if builtin { " (built-in)" } else { "" };
    ToolOutcome::executed(format!(
        "/{name} loaded{origin}. Apply its instructions to the task at hand.{arg_suffix}\n\n---\n{body}"
    ))
    .with_meta(format!("/{name} · {lines}L"))
    // file_loaded display → renders a compact "loaded <path> · N lines ·
    // N bytes" card with the body collapsible. Built-ins display their
    // provenance instead of a filesystem path.
    .with_display(ToolDisplay::FileLoaded {
        path: if builtin {
            format!("built-in:/{name}")
        } else {
            format!("commands/{name}.md")
        },
        lines: lines as u64,
        bytes: bytes as u64,
        description: Some(description),
        body,
    })
}

/// An invocation that matched no commands file, tried against the
/// workspace's enabled skills: longest word-prefix match, case-insensitive,
/// so `/AgentDB Advanced Features deploy` resolves the three-word skill and
/// keeps `deploy` as leftover arguments. `None` when no provider is
/// installed or nothing matches — the plain unknown-command failure then
/// stands. One call resolves the skill (body in output, load_skill's
/// shape); the model never needs a follow-up load_skill.
fn resolve_skill_fallback(
    command: &str,
    args: &str,
    workspace_root: &std::path::Path,
) -> Option<ToolOutcome> {
    let provider = super::load_skill::shared_skill_catalog_provider()?;
    let skills = provider.skills(workspace_root);
    if skills.is_empty() {
        return None;
    }
    let words: Vec<&str> = command
        .split_whitespace()
        .chain(args.split_whitespace())
        .collect();
    let mut best: Option<(usize, &super::load_skill::SkillSummary)> = None;
    for skill in &skills {
        let name_len = skill.name.split_whitespace().count();
        if name_len == 0 || name_len > words.len() {
            continue;
        }
        let matches = skill
            .name
            .split_whitespace()
            .zip(&words)
            .all(|(name_word, word)| name_word.eq_ignore_ascii_case(word));
        if matches && best.is_none_or(|(len, _)| name_len > len) {
            best = Some((name_len, skill));
        }
    }
    let (name_len, skill) = best?;
    let mut outcome = super::load_skill::run_load_skill(&skill.abs_path, workspace_root);
    if outcome.status == crate::OutcomeStatus::Executed {
        if let Some(leftover) = words.get(name_len..) {
            let leftover = leftover.join(" ");
            if !leftover.is_empty() {
                outcome
                    .output
                    .push_str(&format!("\n\nArguments: {leftover}"));
            }
        }
    }
    Some(outcome)
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
        Ok(run_slash_command(
            &command,
            &extra,
            &commands_dir_for(ctx),
            &ctx.workspace_root,
        ))
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

        let out = run_slash_command("refactor", "src/lib", &dir, tmp.path());
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
        let out = run_slash_command("/x", "", &dir, tmp.path());
        assert!(
            out.output
                .starts_with("/x loaded. Apply its instructions to the task at hand.\n\n---\nBody")
        );
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

        let out = run_slash_command("nope", "", &dir, tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(
            out.output
                .starts_with("Unknown command: /nope. Available: alpha, beta,")
        );
        assert!(out.output.contains("kb-iterate (built-in)"));
        assert!(
            out.output
                .contains("not enabled in this workspace's catalog")
        );
    }

    #[test]
    fn missing_command_lists_builtins_when_no_files_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_slash_command("nope", "", &tmp.path().join("commands"), tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("kb-context (built-in)"));
        assert!(out.output.contains("kb-iterate (built-in)"));
    }

    #[test]
    fn builtin_kb_commands_resolve_without_files() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_slash_command(
            "kb-context",
            "shipping the library",
            &tmp.path().join("commands"),
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("(built-in). Apply its instructions"));
        assert!(out.output.contains("Load project background"));
        assert!(out.output.contains("Arguments: shipping the library"));
        let ToolDisplay::FileLoaded { path, .. } = out.display.unwrap() else {
            panic!("file_loaded display");
        };
        assert_eq!(path, "built-in:/kb-context");
    }

    #[test]
    fn file_overrides_builtin() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kb-search.md"), "Custom body").unwrap();
        let out = run_slash_command("kb-search", "", &dir, tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Custom body"));
        assert!(!out.output.contains("(built-in)"));
    }

    #[test]
    fn missing_command_arg_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_slash_command("", "", tmp.path(), tmp.path());
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
        let out = run_slash_command("long", "", &dir, tmp.path());
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
            let out = run_slash_command(bad, "", &tmp.path().join("commands"), tmp.path());
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

    struct FixedCatalog(Vec<crate::tools::load_skill::SkillSummary>);
    impl crate::tools::load_skill::SkillCatalogProvider for FixedCatalog {
        fn skills(
            &self,
            _workspace_root: &std::path::Path,
        ) -> Vec<crate::tools::load_skill::SkillSummary> {
            self.0.clone()
        }
    }

    /// Serializes the fallback tests: they share the process-global
    /// provider slot, so parallel installs/drops would stomp each other.
    static CATALOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Clears the shared provider on scope exit, even on assertion failure —
    /// the slot is process-global and tests run in parallel.
    struct CatalogGuard;
    impl Drop for CatalogGuard {
        fn drop(&mut self) {
            crate::tools::load_skill::set_shared_skill_catalog_provider(None);
        }
    }

    fn install_catalog(skills: Vec<crate::tools::load_skill::SkillSummary>) -> CatalogGuard {
        crate::tools::load_skill::set_shared_skill_catalog_provider(Some(std::sync::Arc::new(
            FixedCatalog(skills),
        )));
        CatalogGuard
    }

    #[test]
    fn skill_fallback_resolves_multi_word_names_with_leftover_args() {
        let _lock = CATALOG_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join("agentdb");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: AgentDB Advanced Features\n---\n# AgentDB\nBody",
        )
        .unwrap();
        let _guard = install_catalog(vec![crate::tools::load_skill::SkillSummary {
            name: "AgentDB Advanced Features".into(),
            description: String::new(),
            abs_path: skill_dir.join("SKILL.md").to_string_lossy().into_owned(),
        }]);

        // The model passes only the first word as `command`; the skill
        // name continues into `args` — longest match still resolves, in
        // ONE call, and the non-name tail rides along as Arguments.
        let out = run_slash_command(
            "AgentDB",
            "Advanced Features deploy the db",
            &tmp.path().join("commands"),
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed, "{}", out.output);
        assert!(
            out.output
                .starts_with("Skill \"AgentDB Advanced Features\" loaded.")
        );
        assert!(out.output.contains("# AgentDB"));
        assert!(out.output.ends_with("Arguments: deploy the db"));
    }

    #[test]
    fn skill_fallback_matches_single_word_and_prefers_longest() {
        let _lock = CATALOG_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mk = |dir: &str, name: &str| {
            let p = tmp.path().join(dir);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(
                p.join("SKILL.md"),
                format!("---\nname: {name}\n---\nBody {dir}"),
            )
            .unwrap();
            crate::tools::load_skill::SkillSummary {
                name: name.to_string(),
                description: String::new(),
                abs_path: p.join("SKILL.md").to_string_lossy().into_owned(),
            }
        };
        let _guard = install_catalog(vec![mk("short", "deploy"), mk("long", "deploy database")]);

        // Bare name resolves; a name that is a prefix of a longer skill
        // name picks the longer skill when the words are present.
        let out = run_slash_command("deploy", "", &tmp.path().join("commands"), tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Body short"));

        let out = run_slash_command(
            "deploy",
            "database now",
            &tmp.path().join("commands"),
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Body long"));
        assert!(out.output.ends_with("Arguments: now"));
    }

    #[test]
    fn skill_fallback_no_match_still_fails_with_unknown_command() {
        let _lock = CATALOG_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = install_catalog(vec![crate::tools::load_skill::SkillSummary {
            name: "unrelated".into(),
            description: String::new(),
            abs_path: "/nowhere/SKILL.md".into(),
        }]);
        let out = run_slash_command("nope", "", &tmp.path().join("commands"), tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unknown command: /nope."));
    }
}
