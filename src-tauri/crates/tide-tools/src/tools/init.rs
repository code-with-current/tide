//! init — port of `app/core/agent/tools/init.ts` (91ec558). Scans the
//! workspace and generates a minimal AGENTS.md at the project root. The
//! tool itself only reports whether AGENTS.md exists and returns the
//! scaffolding instructions — the model writes the file with write_file.

use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

const DESCRIPTION: &str = "Initialize the project: scan the workspace and create a minimal AGENTS.md at the project root. The file captures non-obvious project rules, build commands, and gotchas. Call this when the user wants to set up project configuration for the agent.";

const INIT_INSTRUCTIONS: &str = r#"Set up a minimal AGENTS.md file for the current repository. Because this file is loaded into every session, the guiding principle is strict conciseness: only include what the agent would get wrong without it.

Follow these steps:

1. Explore the codebase: read manifest files (package.json, Cargo.toml, pyproject.toml, etc.), config files (tsconfig, eslint, prettier, .editorconfig), CI configs, and check for existing AI rules (.cursorrules, CLAUDE.md, CONTRIBUTING.md).

2. Identify non-obvious project rules, build commands, testing quirks, and gotchas that can't be inferred from reading the code.

3. Write an AGENTS.md to the project root with ONLY high-signal content. Every line must pass the test: "Would removing this cause the agent to make mistakes?" If not, cut it.

Include:
- Non-standard build/test/lint commands (things not obvious from manifest files)
- Differing style rules (only if they differ from the framework defaults)
- Testing quirks (e.g. "tests must run with X flag")
- Repo etiquette (branch conventions, commit message format, PR process)
- Gotchas (e.g. "don't edit files in X directory", "the DB must be running for tests")

Handling existing rule files:
- If .cursorrules, CLAUDE.md, .github/copilot-instructions.md, or similar AI rule files exist, fold their still-relevant rules INTO AGENTS.md instead of leaving parallel instruction sources — one canonical file the agent actually reads. Note what you consolidated.
- When creating AGENTS.md fresh, incorporate the content of those existing rule files rather than starting from zero.
- If AGENTS.md already exists, improve it in place: verify each existing rule against the codebase, add what's missing from your exploration, and flag stale entries to the user — don't rewrite from scratch.

Grounding:
- Never invent rules. Every rule must trace to something observed: a manifest script, a config value, a CI step, a README statement, or an existing rule file. If you can't cite the origin, don't write the rule.
- Omit license, security-policy, and governance boilerplate unless the user asks for it.

Exclude:
- Generic advice ("write clean code", "handle errors properly")
- File-by-file structure listings (the agent can read the code)
- Standard commands visible in package.json/Makefile
- Long tutorials (reference a doc path instead)
- Obvious things inferable from the codebase"#;

pub(crate) fn run_init(workspace_root: &std::path::Path) -> ToolOutcome {
    let agents_path = workspace_root.join("AGENTS.md");
    let exists = agents_path.is_file();

    let display_text = if exists {
        format!(
            "AGENTS.md already exists at {}. Review it and ask the user if they want to improve it or start fresh.",
            agents_path.display()
        )
    } else {
        "No AGENTS.md found. Explore the codebase and create one following the instructions below."
            .to_string()
    };

    let prefix = if exists {
        "AGENTS.md exists — review it.\n\n"
    } else {
        "No AGENTS.md found — create one.\n\n"
    };

    ToolOutcome::executed(format!("{prefix}{INIT_INSTRUCTIONS}"))
        .with_display(ToolDisplay::Text { text: display_text })
        .with_meta(if exists { "exists" } else { "new" })
}

pub struct InitTool;

impl Tool for InitTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "init".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_init(&ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn fresh_workspace_reports_new() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_init(tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("No AGENTS.md found — create one.\n\n"));
        assert!(out.output.contains("Set up a minimal AGENTS.md file"));
        assert!(out
            .output
            .contains("Would removing this cause the agent to make mistakes?"));
        assert_eq!(out.meta.as_deref(), Some("new"));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(
            text,
            "No AGENTS.md found. Explore the codebase and create one following the instructions below."
        );
    }

    #[test]
    fn existing_agents_md_reports_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("AGENTS.md"), "# Rules").unwrap();
        let out = run_init(tmp.path());
        assert!(out.output.starts_with("AGENTS.md exists — review it.\n\n"));
        assert_eq!(out.meta.as_deref(), Some("exists"));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert!(text.starts_with("AGENTS.md already exists at "));
        assert!(text.ends_with(
            "AGENTS.md. Review it and ask the user if they want to improve it or start fresh."
        ));
    }

    #[test]
    fn write_does_not_happen_automatically() {
        let tmp = tempfile::tempdir().unwrap();
        run_init(tmp.path());
        assert!(!tmp.path().join("AGENTS.md").exists());
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = InitTool;
        let spec = tool.spec();
        assert_eq!(spec.name, "init");
        assert_eq!(spec.parameters["properties"], json!({}));
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let ctx = ToolContext::new(tmp.path().to_path_buf());
        let out = tool.execute(&ctx, json!({})).unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
    }
}
