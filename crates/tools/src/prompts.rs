//! The full tide system prompt, assembled here the way tide's build-time
//! bundler (`build/promptMarkdownUtils.mjs`) and its app-side wrapper
//! (`src/lib/prompts/tide-system-prompt.ts`) assemble it:
//!
//! - `src/prompts/system/*.md` (vendored, sorted by numeric prefix) — the
//!   base fragments, HTML-comment frontmatter stripped, joined with `\n\n`;
//!   the TS `BASE_SYSTEM_PROMPT`.
//! - `src/prompts/tools/*.md` (vendored, sorted) — one usage line per tool,
//!   grouped under `**category:**` headers in first-appearance order; the
//!   TS `TOOL_LIST_MD`, wrapped in `# Available tools` by the app.
//! - [`crate::agents`]' catalog — the dispatch guidance + one
//!   "when to use" line per agent; the TS `AGENT_LIST_MD`.
//!
//! The `src/prompts/` tree is data (re-vendor from tide after editing the
//! upstream `.md` files); this module is the assembler. Adding a file means
//! adding one `include_str!` entry — the same "add a file + rebuild" flow
//! the TS bundler has, minus the codegen.

use std::sync::LazyLock;

/// The system fragments in the bundler's read order: alphabetical, which
/// the numeric prefixes (01-, 02-, …) encode.
const SYSTEM_SOURCES: &[&str] = &[
    include_str!("prompts/system/01-identity.md"),
    include_str!("prompts/system/02-tools.md"),
    include_str!("prompts/system/03-workspace-orientation.md"),
    include_str!("prompts/system/04-working-style.md"),
    include_str!("prompts/system/05-code-discipline.md"),
    include_str!("prompts/system/06-choices.md"),
    include_str!("prompts/system/07-tone.md"),
    include_str!("prompts/system/08-executing-actions-with-care.md"),
    include_str!("prompts/system/09-delivering-work.md"),
    include_str!("prompts/system/10-communication-style.md"),
    include_str!("prompts/system/11-subagent-discipline.md"),
    include_str!("prompts/system/12-git-safety.md"),
    include_str!("prompts/system/13-data-visualization.md"),
];

/// The tool usage fragments: (file stem, raw markdown), sorted the way the
/// bundler reads them. The stem is only a label — names and categories come
/// from each file's frontmatter.
const TOOL_SOURCES: &[(&str, &str)] = &[
    (
        "ask_followup_question",
        include_str!("prompts/tools/ask_followup_question.md"),
    ),
    ("bash", include_str!("prompts/tools/bash.md")),
    ("bash_output", include_str!("prompts/tools/bash_output.md")),
    ("compact", include_str!("prompts/tools/compact.md")),
    (
        "directory_tree",
        include_str!("prompts/tools/directory_tree.md"),
    ),
    (
        "dispatch_agent",
        include_str!("prompts/tools/dispatch_agent.md"),
    ),
    ("edit_file", include_str!("prompts/tools/edit_file.md")),
    (
        "exit_plan_mode",
        include_str!("prompts/tools/exit_plan_mode.md"),
    ),
    ("git", include_str!("prompts/tools/git.md")),
    ("glob", include_str!("prompts/tools/glob.md")),
    ("grep", include_str!("prompts/tools/grep.md")),
    ("init", include_str!("prompts/tools/init.md")),
    ("list_dir", include_str!("prompts/tools/list_dir.md")),
    ("memory", include_str!("prompts/tools/memory.md")),
    ("multi_edit", include_str!("prompts/tools/multi_edit.md")),
    (
        "notebook_edit",
        include_str!("prompts/tools/notebook_edit.md"),
    ),
    ("read_file", include_str!("prompts/tools/read_file.md")),
    (
        "read_media_file",
        include_str!("prompts/tools/read_media_file.md"),
    ),
    (
        "slash_command",
        include_str!("prompts/tools/slash_command.md"),
    ),
    ("todo_write", include_str!("prompts/tools/todo_write.md")),
    ("web_fetch", include_str!("prompts/tools/web_fetch.md")),
    ("web_search", include_str!("prompts/tools/web_search.md")),
    ("write_file", include_str!("prompts/tools/write_file.md")),
];

/// Strip the leading HTML-comment frontmatter (`<!-- ... -->`) and trim —
/// the bundler's `readPromptFiles` step (`/^<!--[\s\S]*?-->\s*/` + trim):
/// drop a leading `<!--`, then everything up to and including the FIRST
/// `-->`. Files without the block pass through trimmed.
fn strip_html_comment_frontmatter(raw: &str) -> &str {
    raw.strip_prefix("<!--")
        .and_then(|after_open| after_open.split_once("-->"))
        .map(|(_, body)| body)
        .unwrap_or(raw)
        .trim()
}

/// One tool's prompt line + its frontmatter category (the bundler's
/// `BundledTool` minus the fields only the TS registry used).
struct ToolPrompt {
    category: &'static str,
    text: &'static str,
}

/// Split a tool source into (category, usage text); `Other` when the
/// frontmatter names no category, matching the bundler's default.
fn parse_tool((_, raw): &(&'static str, &'static str)) -> ToolPrompt {
    let frontmatter = raw
        .strip_prefix("<!--")
        .and_then(|after_open| after_open.split_once("-->"))
        .map(|(head, _)| head)
        .unwrap_or("");
    let category = frontmatter
        .lines()
        .find_map(|line| line.strip_prefix("category:"))
        .map(|value| value.trim().trim_matches('"'))
        .filter(|value| !value.is_empty())
        .unwrap_or("Other");
    ToolPrompt {
        category,
        text: strip_html_comment_frontmatter(raw),
    }
}

static SYSTEM_FRAGMENTS: LazyLock<String> = LazyLock::new(|| {
    SYSTEM_SOURCES
        .iter()
        .map(|raw| strip_html_comment_frontmatter(raw))
        .collect::<Vec<_>>()
        .join("\n\n")
});

/// The base system prompt: every `system/*.md` fragment, frontmatter
/// stripped, joined with blank lines — the TS `BASE_SYSTEM_PROMPT`.
pub fn system_fragments() -> &'static str {
    SYSTEM_FRAGMENTS.as_str()
}

/// The background-jobs contract, appended after the per-tool usage groups.
/// DSH's notification guidance with tide's tool names. This text lands in
/// the SAME change as the settlement wake — the prompt must never promise
/// notification the loop does not deliver, and from here on it delivers.
const BACKGROUND_JOBS_GUIDANCE: &str = "\n\n**Background jobs:**\nTrack every background job id you start (`bash` with `background:true`, `dispatch_agent` with `background:true`). You are notified in-session when a job finishes — do not poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with `job_output` (set `wait: true` only when you are genuinely blocked on it), and `job_kill` jobs that stopped mattering.";

static TOOL_GUIDANCE: LazyLock<String> = LazyLock::new(|| {
    // Category groups in first-appearance order (an insertion-ordered map,
    // like the bundler's plain object), each "**Category:**" header over
    // its member lines — the TS TOOL_LIST_MD.
    let mut categories: Vec<(&str, Vec<&str>)> = Vec::new();
    for source in TOOL_SOURCES {
        let tool = parse_tool(source);
        match categories.iter_mut().find(|(cat, _)| *cat == tool.category) {
            Some((_, lines)) => lines.push(tool.text),
            None => categories.push((tool.category, vec![tool.text])),
        }
    }
    let mut guidance = categories
        .into_iter()
        .map(|(category, lines)| format!("**{category}:**\n{}", lines.join("\n")))
        .collect::<Vec<_>>()
        .join("\n\n");
    guidance.push_str(BACKGROUND_JOBS_GUIDANCE);
    guidance
});

/// The tool usage guidance, grouped by frontmatter category — the TS
/// `TOOL_LIST_MD` the app wraps in `# Available tools`.
pub fn tool_guidance() -> &'static str {
    TOOL_GUIDANCE.as_str()
}

/// The agent catalog for the system prompt — the TS `AGENT_LIST_MD`:
/// dispatch guidance plus one "when to use" line per built-in agent, in
/// catalog (file) order. (No built-in agent is hidden; the TS list never
/// filtered them either.)
pub fn agent_catalog_md() -> String {
    let lines = crate::agents::builtin_agents()
        .iter()
        .map(|agent| format!("- **{}** — {}", agent.name, agent.when_to_use))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"# Sub-agents — dispatch them
Sub-agents are multi-step specialists with their own tool loop — they investigate in their own context window and return a report, keeping yours small. Dispatch is cheap: issue it, keep working, read the report when it lands.

**Dispatch when:**
- The work is a multi-step investigation across many files (broad question, unknown locations)
- A specialty matches the job — `code-reviewer` for reviewing a diff, `simplifier` for a cleanup pass, `explore` for locating code, `general-purpose` when nothing narrower fits
- Several independent subtasks could run at once — dispatch them together in one response; they run in parallel
- The research would flood your context but only the conclusions matter

**Skip dispatch when:** you already know the answer, it is one targeted read/grep, or the user asked you to do it directly.

**Available agents:**
{lines}

**How to dispatch well:**
- Pass a self-contained `task` — the agent sees only that string, not prior conversation
- Prefer the specialist over general-purpose when one fits; dispatch several specialists in parallel rather than one generic agent sequentially
- Use the report as input to your next step; if incomplete, resume the same agent with `resumeFrom` and sharper instructions
- You make the edits yourself from the reports — except `simplifier`, which applies its own fixes"#
    )
}

/// The full tide system prompt — exactly what the tide app's
/// `buildSystemPrompt` sends before its dynamic context blocks:
/// `BASE_SYSTEM_PROMPT + "\n\n# Available tools\n" + TOOL_LIST_MD +
/// "\n\n" + AGENT_LIST_MD`.
pub fn system_prompt() -> String {
    format!(
        "{}\n\n# Available tools\n{}\n\n{}",
        system_fragments(),
        tool_guidance(),
        agent_catalog_md()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_strip_frontmatter_and_keep_prefix_order() {
        let fragments = system_fragments();
        // The bundler strips each file's <!-- ... --> block: none survive.
        assert!(!fragments.contains("<!--"));
        assert!(!fragments.contains("tideVersion"));
        assert!(!fragments.contains("name: \"Identity\""));
        // Sorted = numeric prefix order: identity first, data viz last.
        assert!(fragments.starts_with("You are Tide, an interactive coding agent"));
        assert!(fragments.find("You are Tide").unwrap() < fragments.find("# Tool usage").unwrap());
        assert!(fragments.find("# Tool usage").unwrap() < fragments.find("# Git safety").unwrap());
        assert!(
            fragments.find("# Git safety").unwrap()
                < fragments.find("# Data visualization").unwrap()
        );
        // The join: the first two stripped fragments, separated by exactly
        // one blank line, open the assembly.
        let head = format!(
            "{}\n\n{}",
            strip_html_comment_frontmatter(SYSTEM_SOURCES[0]),
            strip_html_comment_frontmatter(SYSTEM_SOURCES[1])
        );
        assert!(fragments.starts_with(&head));
    }

    #[test]
    fn strip_frontmatter_ports_the_bundler_regex() {
        // With the block: everything up to the first `-->` goes.
        assert_eq!(
            strip_html_comment_frontmatter("<!--\nname: \"x\"\n-->\nbody"),
            "body"
        );
        // No block: trimmed passthrough.
        assert_eq!(strip_html_comment_frontmatter("  body  "), "body");
        // Unterminated comment: nothing stripped (the regex would not match).
        assert_eq!(
            strip_html_comment_frontmatter("<!-- no close"),
            "<!-- no close"
        );
        // Comment NOT at the start: passthrough (the regex anchors at ^).
        assert_eq!(
            strip_html_comment_frontmatter("body <!-- trailing note --> tail"),
            "body <!-- trailing note --> tail"
        );
    }

    #[test]
    fn tool_guidance_groups_every_tool_by_category() {
        let guidance = tool_guidance();
        // All 23 tools' usage lines are present, frontmatter stripped.
        assert_eq!(TOOL_SOURCES.len(), 23);
        assert!(guidance
            .contains("- `bash` — Run a shell command in the workspace root. Full shell support."));
        assert!(guidance.contains("- `read_file` — Read a file from the workspace"));
        assert!(guidance.contains("- `web_fetch` — Fetch a URL and return its content as text."));
        assert!(!guidance.contains("<!--"));
        assert!(!guidance.contains("tideVersion"));
        // Sorted file order shows up as usage-line order: bash (Shell)
        // precedes edit_file and grep (both Files, directory_tree first).
        let order: Vec<usize> = [
            "- `bash` — Run a shell command",
            "- `edit_file` — Edit a file",
            "- `grep` — Search file contents",
        ]
        .iter()
        .map(|line| {
            guidance
                .find(line)
                .unwrap_or_else(|| panic!("missing {line}"))
        })
        .collect();
        assert!(
            order.windows(2).all(|pair| pair[0] < pair[1]),
            "tool lines out of order: {order:?}"
        );
        // Category headers, in the bundler's first-appearance order:
        // ask_followup_question (Agent) < bash (Shell) < directory_tree
        // (Files) < web_fetch (Web).
        let order: Vec<usize> = ["**Agent:**", "**Shell:**", "**Files:**", "**Web:**"]
            .iter()
            .map(|header| {
                guidance
                    .find(header)
                    .unwrap_or_else(|| panic!("missing {header}"))
            })
            .collect();
        assert!(
            order.windows(2).all(|pair| pair[0] < pair[1]),
            "categories out of order: {order:?}"
        );
        // The Shell group holds exactly its three members, in file order:
        // bash.md, bash_output.md, git.md.
        let shell = guidance.split("**Shell:**").nth(1).unwrap();
        let shell = shell.split("\n\n").next().unwrap();
        let lines: Vec<&str> = shell
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("- `bash` — Run a shell command"));
        assert!(lines[1]
            .starts_with("- `bash_output` — Read new output from a backgrounded bash shell."));
        assert!(lines[2].starts_with("- `git` — Run any git subcommand"));
    }

    #[test]
    fn tool_guidance_ends_with_the_background_jobs_contract() {
        // The wake's prompt change: the guidance closes with the
        // notify-and-collect contract, never a poll instruction.
        let guidance = tool_guidance();
        assert!(guidance.contains("**Background jobs:**"));
        assert!(guidance.contains(
            "You are notified in-session when a job finishes — do not poll or sleep on one"
        ));
        assert!(guidance.contains("collect every still-relevant job with `job_output`"));
        assert!(guidance.contains("`job_kill` jobs that stopped mattering"));
        // The fragment rides AFTER the per-tool category groups, so the
        // group parse above is untouched.
        let group_end = guidance.rfind("**Web:**").unwrap();
        assert!(guidance.find("**Background jobs:**").unwrap() > group_end);
        // The old poll contract must not resurface anywhere in the
        // guidance (the bash usage line stays; the contract sentence is
        // the flip).
        assert!(!guidance.contains("poll output via"));
    }

    #[test]
    fn agent_catalog_lists_every_builtin_agent() {
        let catalog = agent_catalog_md();
        for agent in crate::agents::builtin_agents() {
            let line = format!("- **{}** — {}", agent.name, agent.when_to_use);
            assert!(catalog.contains(&line), "missing line for {}", agent.name);
        }
        // All 9, in catalog order, under the Available agents header.
        let available = catalog.split("**Available agents:**").nth(1).unwrap();
        let available = available.split("\n\n").next().unwrap();
        assert_eq!(
            available
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .count(),
            crate::agents::builtin_agents().len()
        );
        assert!(available.trim_start().starts_with("- **code-reviewer** — "));
        // The dispatch guidance wraps the list on both sides.
        assert!(catalog.starts_with("# Sub-agents — dispatch them"));
        assert!(catalog.contains("**Dispatch when:**"));
        assert!(catalog.trim_end().ends_with("applies its own fixes"));
    }

    #[test]
    fn system_prompt_composes_the_three_parts_in_order() {
        let prompt = system_prompt();
        let expected = format!(
            "{}\n\n# Available tools\n{}\n\n{}",
            system_fragments(),
            tool_guidance(),
            agent_catalog_md()
        );
        assert_eq!(prompt, expected);
        // The order the app sends them: fragments, tools, agents.
        let fragments_at = prompt.find("You are Tide").unwrap();
        let tools_at = prompt.find("# Available tools").unwrap();
        let agents_at = prompt.find("# Sub-agents — dispatch them").unwrap();
        assert!(fragments_at < tools_at && tools_at < agents_at);
        // Content assertion for the jobs fragment: the assembled prompt
        // carries the background-jobs contract with tide's tool names.
        assert!(prompt.contains("**Background jobs:**"));
        assert!(prompt.contains(
            "You are notified in-session when a job finishes — do not poll or sleep on one"
        ));
        assert!(prompt.contains("`dispatch_agent` with `background:true`"));
        // And the fragment sits inside the tools section, before agents.
        let jobs_at = prompt.find("**Background jobs:**").unwrap();
        assert!(tools_at < jobs_at && jobs_at < agents_at);
    }
}
