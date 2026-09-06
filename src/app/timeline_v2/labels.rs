//! tide's tool-helpers vocabulary, ported as fresh data tables for the v2
//! tool cards: one row per builtin tool plus pure string helpers for the
//! description column. Pure data — no rendering, no argument parsing; the
//! cards fold these labels into their headers.

/// One builtin tool's presentation vocabulary — tide's tool-helpers port.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ToolLabel {
    /// "Edit File", not "edit_file".
    pub display_name: &'static str,
    /// Asset path under icons/.
    pub icon: &'static str,
    pub family: ToolFamily,
    /// Whether the card starts expanded. tide's conventions: shell cards
    /// open, edit/write cards collapse behind a diff stat, reads and
    /// searches stay collapsed behind their one-line description. Carried
    /// for table parity; the cards decide expansion from the block shape.
    #[allow(dead_code)]
    pub default_expanded: bool,
    /// Highlight hint for the card body ("diff", "bash", …), when the tool
    /// has one. Carried for table parity; nothing reads it yet.
    #[allow(dead_code)]
    pub language_hint: Option<&'static str>,
}

/// The bucket a tool belongs to — drives the card's grouping and accents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolFamily {
    Bash,
    Edit,
    Read,
    Search,
    Task,
    Web,
    Skill,
    Other,
}

/// The fallback vocabulary for tools outside the table: generic wrench,
/// collapsed — the caution default for anything the pane can't vouch for.
const UNKNOWN: ToolLabel = ToolLabel {
    display_name: "Tool",
    icon: "icons/wrench.svg",
    family: ToolFamily::Other,
    default_expanded: false,
    language_hint: None,
};

/// The builtin tools' vocabulary, answering for tools' core set. The
/// names here are the wire names (`edit_file`), not the display names.
pub(crate) fn label_for(tool: &str) -> ToolLabel {
    match tool.trim() {
        // Shell family: expanded by default (tide's bash convention).
        "bash" => ToolLabel {
            display_name: "Shell",
            icon: "icons/terminal.svg",
            family: ToolFamily::Bash,
            default_expanded: true,
            language_hint: Some("bash"),
        },
        "bash_output" => ToolLabel {
            display_name: "Shell Output",
            icon: "icons/terminal-square.svg",
            family: ToolFamily::Bash,
            default_expanded: true,
            language_hint: None,
        },
        "kill_shell" => ToolLabel {
            display_name: "Kill Shell",
            icon: "icons/stop.svg",
            family: ToolFamily::Bash,
            default_expanded: false,
            language_hint: None,
        },
        "git" => ToolLabel {
            display_name: "Git",
            icon: "icons/git-branch.svg",
            family: ToolFamily::Bash,
            default_expanded: false,
            language_hint: None,
        },
        "git_repo" => ToolLabel {
            display_name: "Git Repo",
            icon: "icons/git-commit-horizontal.svg",
            family: ToolFamily::Bash,
            default_expanded: false,
            language_hint: None,
        },

        // Edit family: collapsed by default, showing a diff stat.
        "edit_file" => ToolLabel {
            display_name: "Edit File",
            icon: "icons/pencil.svg",
            family: ToolFamily::Edit,
            default_expanded: false,
            language_hint: Some("diff"),
        },
        "multi_edit" => ToolLabel {
            display_name: "Multi-Edit",
            icon: "icons/replace-all.svg",
            family: ToolFamily::Edit,
            default_expanded: false,
            language_hint: Some("diff"),
        },
        "write_file" => ToolLabel {
            display_name: "Write File",
            icon: "icons/compose.svg",
            family: ToolFamily::Edit,
            default_expanded: false,
            language_hint: Some("auto"),
        },
        "notebook_edit" => ToolLabel {
            display_name: "Edit Notebook",
            icon: "icons/file-diff.svg",
            family: ToolFamily::Edit,
            default_expanded: false,
            language_hint: Some("json"),
        },

        // Read family: static, collapsed behind the path description.
        "read_file" => ToolLabel {
            display_name: "Read File",
            icon: "icons/file.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: Some("auto"),
        },
        "list_dir" => ToolLabel {
            display_name: "List Directory",
            icon: "icons/folder-open.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: None,
        },
        "directory_tree" => ToolLabel {
            display_name: "Directory Tree",
            icon: "icons/fork.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: None,
        },
        "read_media_file" => ToolLabel {
            display_name: "Read Media",
            icon: "icons/eye.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: None,
        },

        // Search family.
        "grep" => ToolLabel {
            display_name: "Search",
            icon: "icons/regex.svg",
            family: ToolFamily::Search,
            default_expanded: false,
            language_hint: None,
        },
        "glob" => ToolLabel {
            display_name: "Find Files",
            icon: "icons/list-filter.svg",
            family: ToolFamily::Search,
            default_expanded: false,
            language_hint: None,
        },

        // Web family.
        "web_fetch" => ToolLabel {
            display_name: "Fetch URL",
            icon: "icons/globe.svg",
            family: ToolFamily::Web,
            default_expanded: false,
            language_hint: Some("auto"),
        },
        "web_search" => ToolLabel {
            display_name: "Web Search",
            icon: "icons/search.svg",
            family: ToolFamily::Web,
            default_expanded: false,
            language_hint: Some("markdown"),
        },

        // Task family: the agent's own orchestration surface.
        "dispatch_agent" => ToolLabel {
            display_name: "Dispatch Agent",
            icon: "icons/bot.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: Some("markdown"),
        },
        "todo_write" => ToolLabel {
            display_name: "Update Todo List",
            icon: "icons/list.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: Some("json"),
        },
        "ask_followup_question" => ToolLabel {
            display_name: "Question",
            icon: "icons/info.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: None,
        },
        "exit_plan_mode" => ToolLabel {
            display_name: "Build Mode",
            icon: "icons/target.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: None,
        },

        // Skill family: loading or managing packaged agent capabilities.
        "load_skill" => ToolLabel {
            display_name: "Load Skill",
            icon: "icons/package.svg",
            family: ToolFamily::Skill,
            default_expanded: false,
            language_hint: Some("markdown"),
        },
        "slash_command" => ToolLabel {
            display_name: "Slash Command",
            icon: "icons/slash.svg",
            family: ToolFamily::Skill,
            default_expanded: false,
            language_hint: None,
        },
        "memory" => ToolLabel {
            display_name: "Memory",
            icon: "icons/brain.svg",
            family: ToolFamily::Skill,
            default_expanded: false,
            language_hint: None,
        },
        "init" => ToolLabel {
            display_name: "Init",
            icon: "icons/sparkle.svg",
            family: ToolFamily::Skill,
            default_expanded: false,
            language_hint: None,
        },

        // Context compaction is the agent managing its own turn budget.
        "compact" => ToolLabel {
            display_name: "Compact",
            icon: "icons/chevrons-up-down.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: None,
        },

        // `Other` stays the unknown-tool fallback alone: every builtin above
        // carries a real family.
        _ => UNKNOWN,
    }
}

/// The (dir, file) split of a path argument, for the description column.
/// Everything before the last separator is the dir; a bare filename has an
/// empty dir half.
pub(crate) fn split_path_display(path: &str) -> (String, String) {
    let path = path.trim();
    match path.rfind('/') {
        Some(0) => (String::new(), path[1..].to_owned()),
        Some(index) => (path[..index].to_owned(), path[index + 1..].to_owned()),
        None => (String::new(), path.to_owned()),
    }
}

/// Where a directory stops being worth reading whole: past this many
/// characters the dir truncates from the left.
const DIR_DISPLAY_BUDGET: usize = 24;

/// A dir longer than the budget keeps only its tail, behind a leading "…" —
/// tide renders this with an rtl-truncated span; the string form bakes the
/// same leading-ellipsis rule so any renderer gets it for free.
fn truncate_dir_from_the_left(dir: &str) -> String {
    let count = dir.chars().count();
    if count <= DIR_DISPLAY_BUDGET {
        return dir.to_owned();
    }
    // One character of the budget goes to the ellipsis.
    let keep = DIR_DISPLAY_BUDGET - 1;
    let tail: String = dir.chars().skip(count - keep).collect();
    format!("…{tail}")
}

/// Path relative to the workspace, with the dir rtl-truncated when long
/// (tide: leading "…" when the dir exceeds ~24 chars). Targets outside the
/// workspace stand on their own, still split into dir + file.
pub(crate) fn relative_display(workspace: &std::path::Path, target: &str) -> String {
    let target = target.trim();
    if target.is_empty() {
        return String::new();
    }
    let path = std::path::Path::new(target);
    let stripped = path.strip_prefix(workspace).unwrap_or(path);
    let (dir, file) = split_path_display(&stripped.to_string_lossy());
    if dir.is_empty() {
        return file;
    }
    format!("{}/{}", truncate_dir_from_the_left(&dir), file)
}

/// First line of a bash command (the description column's bash form).
pub(crate) fn bash_first_line(command: &str) -> String {
    command.lines().next().unwrap_or("").trim().to_owned()
}
