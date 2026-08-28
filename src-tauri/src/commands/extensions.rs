//! Extensions + project entries — port of `app/rpc/extensions.ts`
//! and the `projectEntriesList` half of `app/rpc/misc.ts`. The
//! disabled-set lives in config.json (`extensions.disabled`); list
//! handlers merge it with the built-in agent registry and the
//! `.claude`/`.agent`/`.zcode` workspace scan (project entries shadow user
//! entries on name collisions).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tide_store::config::ExtensionsDisabled;

use crate::state::AppState;

use super::CommandError;

/// `ExtensionsDisabledSet` — `{agents, skills}` (the mcp domain stays
/// internal to the config).
#[derive(Debug, Serialize, PartialEq)]
pub struct ExtensionsDisabledSetWire {
    pub agents: Vec<String>,
    pub skills: Vec<String>,
}

/// The disabled set with the TS defaults (mcp defaults to
/// ['tide-filesystem'] when absent — persisted on the next toggle).
fn disabled_set(cfg: &tide_store::config::Config) -> ExtensionsDisabled {
    cfg.extensions
        .as_ref()
        .map(|e| {
            let mut disabled = e.disabled.clone();
            if disabled.mcp.is_empty() {
                disabled.mcp = vec!["tide-filesystem".to_string()];
            }
            disabled
        })
        .unwrap_or(ExtensionsDisabled {
            agents: vec![],
            skills: vec![],
            mcp: vec!["tide-filesystem".to_string()],
        })
}

/// `extensionsList`.
#[tauri::command]
pub fn extensions_list(
    state: tauri::State<'_, AppState>,
) -> Result<ExtensionsDisabledSetWire, CommandError> {
    let set = state.read_config(disabled_set)?;
    Ok(ExtensionsDisabledSetWire {
        agents: set.agents,
        skills: set.skills,
    })
}

/// `extensionsSetEnabled` — toggle one name in the disabled list.
#[tauri::command]
pub fn extensions_set_enabled(
    state: tauri::State<'_, AppState>,
    domain: String,
    name: String,
    enabled: bool,
) -> Result<(), CommandError> {
    extensions_set_enabled_inner(&state, &domain, &name, enabled)
}

pub(crate) fn extensions_set_enabled_inner(
    state: &AppState,
    domain: &str,
    name: &str,
    enabled: bool,
) -> Result<(), CommandError> {
    if !matches!(domain, "agents" | "skills" | "mcp") {
        return Err(CommandError::with_code(
            format!("unknown extension domain '{domain}'"),
            "INVALID_ARG",
        ));
    }
    state.update_config(|cfg| {
        let ext = cfg.extensions.get_or_insert_with(Default::default);
        let list = match domain {
            "agents" => &mut ext.disabled.agents,
            "skills" => &mut ext.disabled.skills,
            _ => &mut ext.disabled.mcp,
        };
        if enabled {
            list.retain(|n| n != name);
        } else if !list.contains(&name.to_string()) {
            list.push(name.to_string());
        }
        Ok(())
    })
}

// ── project entries scan (port of app/core/agent/project-context.ts) ───────

const MAX_FILE_BYTES: u64 = 16 * 1024;
const CONTEXT_FILE_NAMES: &[&str] = &["CLAUDE.md", "AGENT.md", "AGENTS.md"];
const PROJECT_DIRS: &[&str] = &[".claude", ".agent", ".zcode"];
const SUBDIRS: &[&str] = &["skills", "agents"];

/// `ProjectEntryWire` — one scanned file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectEntryWire {
    pub name: String,
    pub path: String,
    #[serde(rename = "absPath")]
    pub abs_path: String,
    pub description: String,
    pub content: String,
    pub bytes: u64,
    pub truncated: bool,
    pub source: Option<&'static str>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntriesResultWire {
    pub context_files: Vec<ProjectEntryWire>,
    pub skills: Vec<ProjectEntryWire>,
    pub agents: Vec<ProjectEntryWire>,
}

/// Scan project-level and user-level agent context. Safe on any directory
/// — empty lists when nothing relevant exists.
pub fn scan_project_entries(workspace_root: &Path) -> ProjectEntriesResultWire {
    let mut result = ProjectEntriesResultWire::default();
    let Ok(root) = workspace_root.canonicalize() else {
        return result;
    };

    // 1. Root-level CLAUDE.md / AGENT.md / AGENTS.md — project only, first wins.
    for name in CONTEXT_FILE_NAMES {
        if let Some(file) = read_file_capped(&root.join(name), name, "project") {
            result.context_files.push(file);
            break;
        }
    }

    // 2. Project-level skills/agents across the three config dirs (order
    //    = precedence).
    for project_dir in PROJECT_DIRS {
        let project_dir_abs = root.join(project_dir);
        if !is_directory(&project_dir_abs) {
            continue;
        }
        for sub in SUBDIRS {
            let found = scan_skill_or_agent_dir(&project_dir_abs.join(sub), "project");
            merge_dedup(&mut result[sub], found);
        }
    }

    // 3. User-level (~) entries — skipped when the user dir IS the project
    //    dir so nothing double-counts.
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    for user_dir in PROJECT_DIRS {
        let user_dir_abs = home.join(user_dir);
        if !is_directory(&user_dir_abs) {
            continue;
        }
        if same_path(&user_dir_abs, &root.join(user_dir)) {
            continue;
        }
        for sub in SUBDIRS {
            let found = scan_skill_or_agent_dir(&user_dir_abs.join(sub), "user");
            merge_dedup(&mut result[sub], found);
        }
    }

    result
}

impl std::ops::Index<&'static str> for ProjectEntriesResultWire {
    type Output = Vec<ProjectEntryWire>;
    fn index(&self, sub: &'static str) -> &Self::Output {
        match sub {
            "skills" => &self.skills,
            _ => &self.agents,
        }
    }
}

impl std::ops::IndexMut<&'static str> for ProjectEntriesResultWire {
    fn index_mut(&mut self, sub: &'static str) -> &mut Self::Output {
        match sub {
            "skills" => &mut self.skills,
            _ => &mut self.agents,
        }
    }
}

fn scan_skill_or_agent_dir(sub_abs: &Path, source: &'static str) -> Vec<ProjectEntryWire> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(sub_abs) else {
        return out;
    };
    let mut names: Vec<_> = entries.flatten().collect();
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip dotfiles (.DS_Store, .gitkeep) outright.
        if name.starts_with('.') {
            continue;
        }
        let entry_abs = sub_abs.join(&name);
        // Follow symlinks: user-level skills are frequently linked in.
        let Ok(meta) = std::fs::metadata(&entry_abs) else {
            continue;
        };
        if meta.is_file() {
            let Some(stem) = name.strip_suffix(".md") else {
                continue;
            };
            if !seen.insert(stem.to_string()) {
                continue;
            }
            if let Some(mut file) = read_file_capped(&entry_abs, &name, source) {
                file.name = stem.to_string();
                out.push(file);
            }
        } else if meta.is_dir() {
            if !seen.insert(name.clone()) {
                continue;
            }
            if let Some(mut file) = read_file_capped(
                &entry_abs.join("SKILL.md"),
                &format!("{name}/SKILL.md"),
                source,
            ) {
                file.name = name.clone();
                out.push(file);
            }
        }
    }
    out
}

/// Push entries from `src` into `dst`, skipping name collisions — project
/// entries merged first take precedence over user entries.
fn merge_dedup(dst: &mut Vec<ProjectEntryWire>, src: Vec<ProjectEntryWire>) {
    for entry in src {
        if dst.iter().any(|existing| existing.name == entry.name) {
            continue;
        }
        dst.push(entry);
    }
}

fn read_file_capped(path: &Path, display: &str, source: &'static str) -> Option<ProjectEntryWire> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes_len = meta.len();
    let take = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    use std::io::Read as _;
    take.take(MAX_FILE_BYTES).read_to_end(&mut bytes).ok()?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    // First non-empty line is the description.
    let description = content
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string();
    Some(ProjectEntryWire {
        name: display.to_string(),
        path: display.to_string(),
        abs_path: path.to_string_lossy().into_owned(),
        description,
        truncated: bytes_len > MAX_FILE_BYTES,
        bytes: bytes_len,
        content,
        source: Some(source),
    })
}

fn is_directory(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.canonicalize().ok() == b.canonicalize().ok() && a.canonicalize().is_ok()
}

/// `projectEntriesList` — the workspace-scoped scan (empty for unknown
/// workspaces).
#[tauri::command]
pub fn project_entries_list(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<ProjectEntriesResultWire, CommandError> {
    Ok(project_entries_list_inner(&state, &workspace_id))
}

pub(crate) fn project_entries_list_inner(
    state: &AppState,
    workspace_id: &str,
) -> ProjectEntriesResultWire {
    let path = state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.id == workspace_id)
                .map(|ws| ws.path.clone())
                .filter(|p| !p.is_empty())
        })
        .unwrap_or(None);
    match path {
        Some(path) => scan_project_entries(Path::new(&path)),
        None => ProjectEntriesResultWire::default(),
    }
}

// ── extension listings ─────────────────────────────────────────────────────

/// `AgentExtensionEntry`.
#[derive(Debug, Serialize, PartialEq)]
pub struct AgentExtensionEntryWire {
    pub name: String,
    pub description: String,
    #[serde(rename = "whenToUse")]
    pub when_to_use: String,
    /// builtin | project | user
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub enabled: bool,
}

/// `SkillExtensionEntry`.
#[derive(Debug, Serialize, PartialEq)]
pub struct SkillExtensionEntryWire {
    pub name: String,
    pub description: String,
    /// project | user
    pub source: String,
    pub path: String,
    #[serde(rename = "absPath")]
    pub abs_path: String,
    pub enabled: bool,
}

/// `extensionsListAgents` — builtins + the workspace scan (scan failures
/// fall back to builtins only).
#[tauri::command]
pub fn extensions_list_agents(
    state: tauri::State<'_, AppState>,
    workspace_root: String,
) -> Result<Vec<AgentExtensionEntryWire>, CommandError> {
    Ok(extensions_list_agents_inner(&state, &workspace_root))
}

pub(crate) fn extensions_list_agents_inner(
    state: &AppState,
    workspace_root: &str,
) -> Vec<AgentExtensionEntryWire> {
    let disabled = state.read_config(disabled_set).expect("config readable");
    let mut entries: Vec<AgentExtensionEntryWire> = tide_tools::builtin_agents()
        .iter()
        .map(|a| AgentExtensionEntryWire {
            name: a.name.clone(),
            description: a.description.clone(),
            when_to_use: a.when_to_use.clone(),
            source: "builtin".into(),
            path: None,
            enabled: !disabled.agents.contains(&a.name),
        })
        .collect();
    for a in scan_project_entries(Path::new(workspace_root)).agents {
        let enabled = !disabled.agents.contains(&a.name);
        entries.push(AgentExtensionEntryWire {
            name: a.name,
            description: a.description,
            when_to_use: String::new(),
            source: a.source.unwrap_or("project").to_string(),
            path: Some(a.abs_path),
            enabled,
        });
    }
    entries
}

/// `extensionsListSkills` — the workspace scan only (empty on failure).
#[tauri::command]
pub fn extensions_list_skills(
    state: tauri::State<'_, AppState>,
    workspace_root: String,
) -> Result<Vec<SkillExtensionEntryWire>, CommandError> {
    Ok(extensions_list_skills_inner(&state, &workspace_root))
}

pub(crate) fn extensions_list_skills_inner(
    state: &AppState,
    workspace_root: &str,
) -> Vec<SkillExtensionEntryWire> {
    let disabled = state.read_config(disabled_set).expect("config readable");
    let scanned = scan_project_entries(Path::new(workspace_root));
    scanned
        .skills
        .into_iter()
        .map(|s| {
            let enabled = !disabled.skills.contains(&s.name);
            SkillExtensionEntryWire {
                enabled,
                name: s.name,
                description: s.description,
                source: s.source.unwrap_or("project").to_string(),
                path: s.path,
                abs_path: s.abs_path,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-ext-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_at(dir: &Path) -> AppState {
        AppState::load(dir.to_path_buf())
    }

    #[test]
    fn disabled_set_defaults() {
        let dir = temp_dir("defaults");
        let state = state_at(&dir);
        let set = state.read_config(disabled_set).unwrap();
        assert!(set.agents.is_empty());
        assert!(set.skills.is_empty());
        assert_eq!(set.mcp, vec!["tide-filesystem".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_enabled_toggles_persistently() {
        let dir = temp_dir("toggle");
        fs::write(dir.join("config.json"), "{}").unwrap();
        let state = state_at(&dir);

        extensions_set_enabled_inner(&state, "agents", "code-reviewer", false).unwrap();
        extensions_set_enabled_inner(&state, "skills", "pdf", false).unwrap();
        let set = state.read_config(disabled_set).unwrap();
        assert_eq!(set.agents, vec!["code-reviewer".to_string()]);
        assert_eq!(set.skills, vec!["pdf".to_string()]);

        // Re-enabling removes from the list; persists through the file.
        extensions_set_enabled_inner(&state, "agents", "code-reviewer", true).unwrap();
        let reloaded = state_at(&dir);
        let set = reloaded.read_config(disabled_set).unwrap();
        assert!(set.agents.is_empty());
        assert_eq!(set.skills, vec!["pdf".to_string()]);

        assert!(extensions_set_enabled_inner(&state, "bogus", "x", true).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_finds_context_skills_and_agents_with_precedence() {
        let dir = temp_dir("scan");
        fs::write(dir.join("AGENTS.md"), "# House rules\nBe terse.").unwrap();
        fs::write(dir.join("CLAUDE.md"), "# Shadowed\n").unwrap();
        fs::create_dir_all(dir.join(".claude/skills/pdf")).unwrap();
        fs::write(
            dir.join(".claude/skills/pdf/SKILL.md"),
            "# PDF skill\nDoes pdf things.",
        )
        .unwrap();
        fs::write(dir.join(".claude/skills/flat.md"), "# Flat skill\n").unwrap();
        fs::create_dir_all(dir.join(".agent/agents")).unwrap();
        fs::write(dir.join(".agent/agents/reviewer.md"), "# Reviewer agent\n").unwrap();

        let result = scan_project_entries(&dir);
        // One context file — CLAUDE.md checked first but AGENTS.md also
        // present: the TS loop breaks on the FIRST found (CLAUDE.md wins).
        assert_eq!(result.context_files.len(), 1);
        assert_eq!(result.context_files[0].name, "CLAUDE.md");
        assert_eq!(result.context_files[0].source, Some("project"));
        assert!(result.context_files[0].content.contains("Shadowed"));

        // The user-level dirs (~/.claude etc.) legitimately join skills /
        // agents — assert on the project-sourced subset.
        let project_skills: Vec<&ProjectEntryWire> = result
            .skills
            .iter()
            .filter(|s| s.source == Some("project"))
            .collect();
        let names: Vec<&str> = project_skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"pdf"));
        assert!(names.contains(&"flat"));
        let pdf = project_skills.iter().find(|s| s.name == "pdf").unwrap();
        assert!(pdf.abs_path.contains("SKILL.md"));
        assert_eq!(pdf.description, "# PDF skill");

        let project_agents: Vec<&ProjectEntryWire> = result
            .agents
            .iter()
            .filter(|a| a.source == Some("project"))
            .collect();
        assert_eq!(project_agents.len(), 1);
        assert_eq!(project_agents[0].name, "reviewer");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_truncates_large_files() {
        let dir = temp_dir("truncate");
        fs::create_dir_all(dir.join(".claude/skills")).unwrap();
        fs::write(dir.join(".claude/skills/big.md"), "x".repeat(20 * 1024)).unwrap();
        let result = scan_project_entries(&dir);
        let big = result
            .skills
            .iter()
            .find(|s| s.source == Some("project") && s.name == "big")
            .expect("project skill scanned");
        assert!(big.truncated);
        assert_eq!(big.content.len(), 16 * 1024);
        assert_eq!(big.bytes, 20 * 1024);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_agents_merges_builtins_with_disabled_flags() {
        let dir = temp_dir("agents");
        fs::write(
            dir.join("config.json"),
            r#"{"extensions":{"disabled":{"agents":["explore"],"skills":[],"mcp":[]}}}"#,
        )
        .unwrap();
        let state = state_at(&dir);
        fs::create_dir_all(dir.join("proj/.claude/agents")).unwrap();
        fs::write(
            dir.join("proj/.claude/agents/custom.md"),
            "# Custom agent\n",
        )
        .unwrap();

        let entries = extensions_list_agents_inner(&state, &dir.join("proj").to_string_lossy());
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"custom"), "names: {names:?}");
        let explore = entries.iter().find(|e| e.name == "explore").unwrap();
        assert!(!explore.enabled);
        assert_eq!(explore.source, "builtin");
        let custom = entries.iter().find(|e| e.name == "custom").unwrap();
        assert!(custom.enabled);
        assert_eq!(custom.source, "project");
        assert!(custom
            .path
            .as_deref()
            .is_some_and(|p| p.ends_with("custom.md")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_workspace_returns_empty_entries() {
        let dir = temp_dir("empty");
        let state = state_at(&dir);
        let result = project_entries_list_inner(&state, "ws_missing");
        assert_eq!(result.context_files.len(), 0);
        assert_eq!(result.skills.len(), 0);
        assert_eq!(result.agents.len(), 0);
        fs::remove_dir_all(&dir).unwrap();
    }
}
