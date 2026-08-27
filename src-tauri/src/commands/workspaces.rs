//! `workspaceList` — backs the TideRPC `workspaceList` method. Port of the
//! 91ec558 producer (`configStore.listWorkspaces`): stored entries pass
//! through verbatim (the config already persists the full wire shape —
//! branch/headCommit/fileCount/scripts ride tide-store's flatten-preserved
//! extras) with `ragConfig` hydrated at read time so workspaces persisted
//! before RAG config existed still get a fully-shaped block.

use serde_json::{Map, Value};
use tide_store::config::Workspace;

use crate::state::AppState;

use super::CommandError;

#[tauri::command]
pub fn workspace_list(state: tauri::State<AppState>) -> Result<Vec<Value>, CommandError> {
    list(&state)
}

fn list(state: &AppState) -> Result<Vec<Value>, CommandError> {
    state.read_config(|cfg| cfg.workspaces.iter().map(workspace_wire).collect())
}

fn workspace_wire(ws: &Workspace) -> Value {
    let mut wire = serde_json::to_value(ws).expect("stored workspace serializes");
    hydrate_rag_config(&mut wire);
    wire
}

/// Max input tokens per embedder variant (91ec558 kept the same table beside
/// hydrateRagConfig so hydration stays free of the embedder modules).
fn embedder_max_tokens(embedder_id: &str) -> Option<u64> {
    match embedder_id {
        "local-code-512" => Some(512),
        "cloud-base" => Some(256),
        _ => None,
    }
}

/// Port of `hydrateRagConfig` (91ec558 configStore): fill missing fields,
/// force `dim` to 384, and clamp `chunkTokens` to the recorded embedder's
/// max so a workspace flipped between embedders never keeps an
/// un-embeddable chunk size.
fn hydrate_rag_config(ws: &mut Value) {
    let Some(obj) = ws.as_object_mut() else {
        return;
    };
    let input: Map<String, Value> = obj
        .get("ragConfig")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let embedder_id = input
        .get("embedderId")
        .and_then(Value::as_str)
        .unwrap_or("local-code-512");
    let chunk_tokens = input
        .get("chunkTokens")
        .and_then(Value::as_u64)
        .unwrap_or(384);
    let chunk_tokens = embedder_max_tokens(embedder_id).map_or(chunk_tokens, |max| {
        chunk_tokens.min(max)
    });
    let cloud_allowed = input
        .get("cloudAllowed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    obj.insert(
        "ragConfig".to_string(),
        serde_json::json!({
            "embedderId": embedder_id,
            "dim": 384,
            "cloudAllowed": cloud_allowed,
            "chunkTokens": chunk_tokens,
        }),
    );
}


// ── M4 T2: workspace management ─────────────────────────────────────────────
//
// Port of `app/rpc/workspaces.ts` @ 91ec558. Deviations, both accepted in
// this rewrite already:
//
// - The add-workspace per-step progress pushes (`requestId` milestones over
//   the Electrobun push channel) are dropped — the Tauri shell has no
//   workspace-progress channel; `workspaceAdd` is one await like the rest.
// - `syncCoAuthorHook` is skipped (the settings.rs M-port decision: agent
//   commits no longer carry the co-author hook).
// - git detection / init / clone run on git2 instead of the git CLI; the
//   template scaffolding spawns the same `npx`/`npm` argv the TS registry
//   carried (no 600s timeout — std Command has none).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tide_store::sessions_v2_write::new_workspace_id;

use std::sync::Arc;

use crate::agent::hub::{ChatHub, ChatHubCell};
use crate::agent::sink::{iso_ms, unix_ms_now};

use super::worktree;

/// `WorkspaceAddInput` params.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAddInputWire {
    pub path: String,
    pub name: Option<String>,
    pub repository: Option<String>,
    pub template: Option<String>,
    pub scripts: Option<Vec<Value>>,
    pub init_git: Option<bool>,
    #[allow(dead_code)]
    pub request_id: Option<String>,
}

/// `workspaceDelete` response — `{ok}` or `{ok: false, error}`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceDeleteResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `WorkspaceFileReadResult` — the ok arm carries content/truncated/bytes,
/// the error arm a reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileReadOk {
    pub ok: bool,
    pub content: String,
    pub truncated: bool,
    pub bytes: u64,
}

/// The TS template registry (`src/lib/templates.ts`) — process-agnostic by
/// design, mirrored here for the scaffold steps.
struct ProjectTemplate {
    scaffold: &'static [&'static str],
    install: Option<&'static [&'static str]>,
}

fn template_of(id: &str) -> Option<ProjectTemplate> {
    match id {
        "empty" => Some(ProjectTemplate { scaffold: &[], install: None }),
        "nextjs" => Some(ProjectTemplate {
            scaffold: &[
                "npx", "create-next-app@latest", ".",
                "--ts", "--tailwind", "--eslint", "--app",
                "--import-alias", "@/*", "--use-npm", "--yes",
            ],
            install: None,
        }),
        "vite-react" => Some(ProjectTemplate {
            scaffold: &["npm", "create", "vite@latest", ".", "--", "--template", "react-ts"],
            install: Some(&["npm", "install"]),
        }),
        "tanstack-start" => Some(ProjectTemplate {
            scaffold: &[
                "npx", "@tanstack/create-router@latest", ".",
                "--package-manager", "npm", "--bundler", "vite", "--ide", "other",
                "--skip-install", "--skip-build",
            ],
            install: Some(&["npm", "install"]),
        }),
        "t3" => Some(ProjectTemplate {
            scaffold: &[
                "npx", "create-t3-app@latest", ".", "--default", "--noGit", "--noInstall",
            ],
            install: Some(&["npm", "install"]),
        }),
        "nuxt" => Some(ProjectTemplate {
            scaffold: &["npx", "nuxi@latest", "init", ".", "--packageManager", "npm"],
            install: Some(&["npm", "install"]),
        }),
        _ => None,
    }
}

// ── get / update / archive / unarchive / delete ─────────────────────────────

#[tauri::command]
pub fn workspace_get(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<Option<Value>, CommandError> {
    get_workspace(&state, &workspace_id)
}

fn get_workspace(state: &AppState, workspace_id: &str) -> Result<Option<Value>, CommandError> {
    state.read_config(|cfg| cfg.workspaces.iter().find(|ws| ws.id == workspace_id).map(workspace_wire))
}

#[tauri::command]
pub fn workspace_update(
    state: tauri::State<AppState>,
    workspace_id: String,
    patch: Value,
) -> Result<Option<Value>, CommandError> {
    update_workspace(&state, &workspace_id, patch)
}

fn update_workspace(
    state: &AppState,
    workspace_id: &str,
    patch: Value,
) -> Result<Option<Value>, CommandError> {
    // TS Object.assign at the top level, then the merged object back —
    // unknown patch keys land in the flatten-preserved extras.
    let Some(patch) = patch.as_object().cloned() else {
        return get_workspace(state, workspace_id);
    };
    state.update_config(|cfg| {
        let Some(index) = cfg.workspaces.iter().position(|ws| ws.id == workspace_id) else {
            return Ok(None);
        };
        let mut merged = serde_json::to_value(&cfg.workspaces[index]).expect("workspace serializes");
        if let Some(target) = merged.as_object_mut() {
            for (key, value) in patch {
                target.insert(key, value);
            }
        }
        cfg.workspaces[index] = serde_json::from_value::<tide_store::config::Workspace>(merged)
            .map_err(|e| CommandError::with_code(format!("patch is not a workspace: {e}"), "WORKSPACE_PATCH"))?;
        Ok(Some(workspace_wire(&cfg.workspaces[index])))
    })
}

#[tauri::command]
pub async fn workspace_archive(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    archive_workspace(&state, &hub, &workspace_id)
}

/// TS `archiveWorkspace` + cascade: archive the workspace row, then archive
/// its active main sessions (v2 rows — `listSessions` scope).
fn archive_workspace(state: &AppState, hub: &Arc<ChatHub>, workspace_id: &str) -> Result<(), CommandError> {
    let path = state.update_config(|cfg| {
        let Some(ws) = cfg.workspaces.iter_mut().find(|ws| ws.id == workspace_id) else {
            return Ok(None);
        };
        ws.archived_at = Some(iso_ms(unix_ms_now()));
        Ok(Some(ws.path.clone()))
    })?;
    if let Some(path) = path {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        writer
            .archive_workspace_sessions(&path, unix_ms_now(), true)
            .map_err(CommandError::from)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_unarchive(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    unarchive_workspace(&state, &hub, &workspace_id)
}

fn unarchive_workspace(state: &AppState, hub: &Arc<ChatHub>, workspace_id: &str) -> Result<(), CommandError> {
    let path = state.update_config(|cfg| {
        let Some(ws) = cfg.workspaces.iter_mut().find(|ws| ws.id == workspace_id) else {
            return Ok(None);
        };
        ws.archived_at = None;
        Ok(Some(ws.path.clone()))
    })?;
    if let Some(path) = path {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        writer
            .unarchive_workspace_sessions(&path)
            .map_err(CommandError::from)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_delete(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
) -> Result<WorkspaceDeleteResultWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    match delete_workspace(&state, &hub, &workspace_id) {
        Ok(()) => Ok(WorkspaceDeleteResultWire { ok: true, error: None }),
        Err(error) => Ok(WorkspaceDeleteResultWire { ok: false, error: Some(error.message) }),
    }
}

/// Errors carry the TS messages (the archived-first guard surfaces as
/// `{ok: false, error}` — never a rejection).
fn delete_workspace(state: &AppState, hub: &Arc<ChatHub>, workspace_id: &str) -> Result<(), CommandError> {
    let path = state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|ws| ws.id == workspace_id)
            .map(|ws| (ws.path.clone(), ws.archived_at.is_some()))
    })?;
    let Some((path, archived)) = path else {
        return Ok(());
    };
    if !archived {
        return Err(CommandError::with_code(
            "Workspace must be archived before deletion",
            "WORKSPACE_NOT_ARCHIVED",
        ));
    }
    // Cascade: every session under the workspace path goes, worktrees first.
    {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        for session_id in writer.session_ids_by_workspace(&path) {
            if let Some(worktree) = writer.session_worktree(&session_id) {
                if let (Some(branch), Some(root)) = (
                    worktree.get("branch").and_then(Value::as_str),
                    writer.session_workspace_path(&session_id).as_deref(),
                ) {
                    worktree::worktree_remove(Path::new(root), branch);
                }
            }
            writer.delete_session(&session_id).map_err(CommandError::from)?;
        }
    }
    state.update_config(|cfg| {
        // Dangling pointer cleanup — the TS cleared lastWorkspaceId only.
        if cfg.last_workspace_id.as_deref() == Some(workspace_id) {
            cfg.last_workspace_id = None;
        }
        cfg.workspaces.retain(|ws| ws.id != workspace_id);
        Ok(())
    })
}

// ── add ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn workspace_add(
    state: tauri::State<AppState>,
    input: WorkspaceAddInputWire,
) -> Result<Value, CommandError> {
    add_workspace(&state, input)
}

fn add_workspace(state: &AppState, input: WorkspaceAddInputWire) -> Result<Value, CommandError> {
    let template = input.template.as_deref().and_then(template_of);
    let dir_path = worktree::expand_home(&input.path);
    let dir_path = PathBuf::from(&dir_path);
    let exists = dir_path.exists();

    if input.repository.is_some() && !exists {
        let repository = input.repository.clone().unwrap_or_default();
        if let Some(parent) = dir_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CommandError::with_code(format!("Git clone failed: {e}"), "CLONE"))?;
        }
        // `git clone --depth 1` — anonymous https like the tide-tools
        // git_repo backend (private repos fail with a surfaced error).
        let mut fetch = git2::FetchOptions::new();
        fetch.depth(1);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch);
        builder
            .clone(&repository, &dir_path)
            .map_err(|e| CommandError::with_code(format!("Git clone failed: {e}"), "CLONE"))?;
    }

    if input.repository.is_none() && !exists {
        std::fs::create_dir_all(&dir_path)
            .map_err(|e| CommandError::with_code(format!("Failed to create project directory: {e}"), "MKDIR"))?;
        // Empty/new-project case: init git now — templated projects init
        // after scaffolding.
        if template.as_ref().map(|t| t.scaffold.is_empty()).unwrap_or(true) {
            git2::Repository::init(&dir_path)
                .map_err(|e| CommandError::with_code(format!("Failed to create project directory: {e}"), "MKDIR"))?;
        }
    }

    if let Some(template) = template.as_ref().filter(|t| !t.scaffold.is_empty()) {
        if input.repository.is_none() {
            if !dir_path.exists() {
                std::fs::create_dir_all(&dir_path).map_err(|e| {
                    CommandError::with_code(format!("Template '{}' failed: {e}", input.template.clone().unwrap_or_default()), "SCAFFOLD")
                })?;
            }
            run_template_step(&dir_path, "Scaffold", template.scaffold, &input.template)?;
            if let Some(install) = template.install {
                run_template_step(&dir_path, "Install", install, &input.template)?;
            }
            if !dir_path.join(".git").exists() {
                let _ = git2::Repository::init(&dir_path);
            }
        }
    }

    if input.init_git.unwrap_or(false)
        && input.repository.is_none()
        && dir_path.exists()
        && !dir_path.join(".git").exists()
    {
        let _ = git2::Repository::init(&dir_path);
    }

    let git_info = detect_git(&dir_path);
    let name = input.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        dir_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir_path.to_string_lossy().into_owned())
    });

    let mut wire = Map::new();
    wire.insert("id".into(), json!(new_workspace_id()));
    wire.insert("name".into(), json!(name));
    wire.insert("path".into(), json!(dir_path.to_string_lossy()));
    if let Some(repository) = input.repository.filter(|r| !r.is_empty()) {
        wire.insert("repository".into(), json!(repository));
    }
    wire.insert("branch".into(), json!(git_info.as_ref().map(|g| g.branch.clone()).unwrap_or_else(|| "main".into())));
    wire.insert(
        "headCommit".into(),
        json!(git_info.as_ref().map(|g| g.head_commit.clone()).unwrap_or_else(|| "unknown".into())),
    );
    wire.insert("isDefault".into(), json!(false));
    wire.insert("fileCount".into(), json!(git_info.as_ref().map(|g| g.file_count).unwrap_or(0)));
    wire.insert("worktreeLocation".into(), json!(".agent/worktrees/"));
    wire.insert("scripts".into(), json!(input.scripts.unwrap_or_default()));
    let wire = Value::Object(wire);

    let stored: Workspace = serde_json::from_value(wire.clone())
        .map_err(|e| CommandError::with_code(format!("workspace add: {e}"), "WORKSPACE_ADD"))?;
    state.update_config(|cfg| {
        cfg.workspaces.push(stored.clone());
        Ok(())
    })?;
    // The TS returned the freshly-built object (no ragConfig hydration).
    Ok(wire)
}

/// `runStep`: spawn the argv in the project dir, surface the last 6 output
/// lines on failure (the TS tail).
fn run_template_step(
    dir: &Path,
    label: &str,
    argv: &[&str],
    template_id: &Option<String>,
) -> Result<(), CommandError> {
    let result = ProcessCommand::new(argv[0])
        .args(&argv[1..])
        .current_dir(dir)
        .output();
    let output = result.map_err(|e| CommandError::with_code(
        format!("Template '{}' failed: {label} failed (exit none): {e}", template_id.clone().unwrap_or_default()),
        "SCAFFOLD",
    ))?;
    if !output.status.success() {
        let tail = String::from_utf8_lossy(if output.stderr.is_empty() { &output.stdout } else { &output.stderr });
        let lines: Vec<&str> = tail.lines().collect();
        let tail = lines
            .iter()
            .rev()
            .take(6)
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(CommandError::with_code(
            format!("Template '{}' failed: {label} failed (exit {}):\n{}", template_id.clone().unwrap_or_default(), output.status.code().unwrap_or(-1), tail),
            "SCAFFOLD",
        ));
    }
    Ok(())
}

/// `detectGit`: `{branch, headCommit, fileCount}` for a repo dir (None when
/// the path isn't a repo). Detached heads read "HEAD" like the CLI's
/// `rev-parse --abbrev-ref HEAD`.
pub(crate) struct GitInfo {
    pub branch: String,
    pub head_commit: String,
    pub file_count: usize,
}

pub(crate) fn detect_git(dir: &Path) -> Option<GitInfo> {
    if !dir.join(".git").exists() {
        return None;
    }
    let repo = git2::Repository::open(dir).ok()?;
    // Unborn HEAD: the CLI's rev-parse failed, so the TS read no git info at
    // all (branch fell back to "main" at the caller). Detached heads read
    // "HEAD" like `rev-parse --abbrev-ref HEAD` prints.
    let head = repo.head().ok()?;
    let branch = head
        .shorthand()
        .ok()
        .map(str::to_owned)
        .unwrap_or_else(|| "HEAD".into());
    let head_commit = head
        .peel_to_commit()
        .ok()
        .map(|commit| commit.id().to_string().chars().take(7).collect())
        .unwrap_or_else(|| "unknown".into());
    let file_count = repo.index().map(|index| index.len()).unwrap_or(0);
    Some(GitInfo { branch, head_commit, file_count })
}

// ── contextGet / fileRead / branches / config files / exist ─────────────────

#[tauri::command]
pub fn workspace_context_get(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<String, CommandError> {
    workspace_context(&state, &workspace_id)
}

/// The project-context assembly from the TS handler: package.json summary,
/// top-level entries, README excerpt, and the first project agent-guidance
/// file (CLAUDE.md > AGENT.md > AGENTS.md, 16k-char cap).
fn workspace_context(state: &AppState, workspace_id: &str) -> Result<String, CommandError> {
    let Some(dir_path) = workspace_path(state, workspace_id)? else {
        return Ok(String::new());
    };
    let dir_path = PathBuf::from(worktree::expand_home(&dir_path));
    let mut lines: Vec<String> = Vec::new();
    let base_name = dir_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir_path.to_string_lossy().into_owned());

    match std::fs::read_to_string(dir_path.join("package.json")) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(pkg) => {
                let name = pkg
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
                    .unwrap_or(base_name.clone());
                lines.push(format!("Project: {name}"));
                if let Some(description) = pkg.get("description").and_then(Value::as_str) {
                    lines.push(format!("Description: {description}"));
                }
                if let Some(version) = pkg.get("version").and_then(Value::as_str) {
                    lines.push(format!("Version: {version}"));
                }
                if let Some(private) = pkg.get("private") {
                    lines.push(format!("Private: {private}"));
                }
                let mut dep_keys: Vec<String> = Vec::new();
                for field in ["dependencies", "devDependencies"] {
                    if let Some(deps) = pkg.get(field).and_then(Value::as_object) {
                        dep_keys.extend(deps.keys().cloned());
                    }
                }
                if !dep_keys.is_empty() {
                    let interesting: Vec<String> = dep_keys
                        .iter()
                        .filter(|key| is_interesting_dep(key))
                        .cloned()
                        .collect();
                    let shown = if !interesting.is_empty() {
                        interesting
                    } else {
                        dep_keys.iter().take(12).cloned().collect()
                    };
                    let extra = dep_keys.len().saturating_sub(shown.len());
                    lines.push(format!(
                        "Stack: {}{}",
                        shown.join(", "),
                        if extra > 0 { format!(" (+{extra} more)") } else { String::new() }
                    ));
                }
                if let Some(scripts) = pkg.get("scripts").and_then(Value::as_object) {
                    if !scripts.is_empty() {
                        let shown: Vec<&String> = scripts.keys().take(6).collect();
                        let extra = scripts.len().saturating_sub(6);
                        lines.push(format!(
                            "Scripts: {}{}",
                            shown
                                .iter()
                                .map(|s| s.as_str())
                                .collect::<Vec<_>>()
                                .join(", "),
                            if extra > 0 { format!(" (+{extra} more)") } else { String::new() }
                        ));
                    }
                }
            }
            Err(_) => lines.push(format!("Project: {base_name} (no package.json)")),
        },
        Err(_) => lines.push(format!("Project: {base_name} (no package.json)")),
    }

    if let Ok(entries) = std::fs::read_dir(&dir_path) {
        let mut visible: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name != ".agent" {
                continue;
            }
            if matches!(name.as_str(), "node_modules" | "dist" | "build" | "release" | "target") {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            visible.push(if is_dir { format!("{name}/") } else { name });
            if visible.len() >= 40 {
                break;
            }
        }
        // Sorted for determinism (the TS order was readdir-dependent).
        visible.sort();
        if !visible.is_empty() {
            lines.push(format!("Top-level: {}", visible.join(", ")));
        }
    }

    for name in ["README.md", "README.MD", "README.txt", "README"] {
        if let Ok(readme) = std::fs::read_to_string(dir_path.join(name)) {
            let excerpt: String = readme.lines().take(40).collect::<Vec<_>>().join("\n");
            let excerpt = excerpt.trim().to_owned();
            if !excerpt.is_empty() {
                lines.push(format!("---\nREADME ({name}):\n{excerpt}"));
            }
            break;
        }
    }

    for name in ["CLAUDE.md", "AGENT.md", "AGENTS.md"] {
        if let Ok(raw) = std::fs::read_to_string(dir_path.join(name)) {
            if raw.trim().is_empty() {
                break;
            }
            let content: String = raw.chars().take(16_384).collect();
            lines.push(format!(
                "---\n{name} (project agent guidance — always apply; where these rules conflict with your defaults, these rules win):\n{content}"
            ));
            break;
        }
    }

    Ok(lines.join("\n"))
}

/// The TS interesting-deps regex is all literal prefixes — a lowercased
/// prefix match is the exact same predicate.
fn is_interesting_dep(key: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "react", "next", "vue", "nuxt", "svelte", "@angular", "electron", "vite",
        "typescript", "tailwind", "express", "fastify", "nest", "prisma", "drizzle",
        "@modelcontextprotocol", "ai", "openai", "anthropic", "zustand", "redux", "@tanstack",
    ];
    let key = key.to_ascii_lowercase();
    PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

#[tauri::command]
pub fn workspace_file_read(
    state: tauri::State<AppState>,
    workspace_id: String,
    rel_path: String,
) -> Result<Value, CommandError> {
    Ok(workspace_file_read_inner(&state, &workspace_id, &rel_path))
}

/// Sandboxed read for the viewer: containment, binary sniff, 256 KB byte
/// cap, BOM strip — `{ok: false, reason}` on any refusal.
fn workspace_file_read_inner(state: &AppState, workspace_id: &str, rel_path: &str) -> Value {
    let Ok(root) = workspace_path(state, workspace_id) else {
        return json!({ "ok": false, "reason": "workspace not found" });
    };
    let Some(root) = root.map(|p| PathBuf::from(worktree::expand_home(&p))) else {
        return json!({ "ok": false, "reason": "workspace not found" });
    };
    let full = worktree::lexical_join(&root, rel_path);
    let rel = full.strip_prefix(&root).unwrap_or_else(|_| Path::new(""));
    if rel.as_os_str().is_empty() {
        return json!({ "ok": false, "reason": "path escapes workspace root" });
    }
    let Ok(meta) = std::fs::metadata(&full) else {
        return json!({ "ok": false, "reason": "file not found" });
    };
    if !meta.is_file() {
        return json!({ "ok": false, "reason": "not a regular file" });
    }
    if is_binary_rel_path(rel_path) {
        return json!({ "ok": false, "reason": "binary file" });
    }
    const MAX_BYTES: u64 = 256 * 1024;
    let bytes_total = meta.len();
    let truncated = bytes_total > MAX_BYTES;
    let Ok(mut file) = std::fs::File::open(&full) else {
        return json!({ "ok": false, "reason": "read failed" });
    };
    use std::io::Read;
    let mut buf = vec![0u8; bytes_total.min(MAX_BYTES) as usize];
    if file.read_exact(&mut buf).is_err() {
        return json!({ "ok": false, "reason": "read failed" });
    }
    let mut content = String::from_utf8_lossy(&buf).into_owned();
    if content.starts_with('\u{feff}') {
        content = content.trim_start_matches('\u{feff}').to_owned();
    }
    serde_json::to_value(WorkspaceFileReadOk {
        ok: true,
        content,
        truncated,
        bytes: bytes_total,
    })
    .expect("file read wire serializes")
}

/// The TS binary-extension regex — a trailing `.ext` in the set (with the
/// alternation groups expanded), case-insensitive.
fn is_binary_rel_path(rel_path: &str) -> bool {
    const BINARY_EXTS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "pdf", "zip",
        "tar", "gz", "bz2", "7z", "rar", "exe", "dll", "so", "dylib", "class", "jar",
        "war", "wasm", "mp3", "mp4", "wav", "ogg", "mov", "avi", "mkv", "ttf", "otf",
        "woff", "woff2", "eot", "sumo", "db", "sqlite", "db3",
    ];
    let Some(dot) = rel_path.rfind('.') else {
        return false;
    };
    let ext = rel_path[dot + 1..].to_ascii_lowercase();
    BINARY_EXTS.contains(&ext.as_str())
}

#[tauri::command]
pub fn workspace_list_branches(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<Vec<String>, CommandError> {
    workspace_list_branches_inner(&state, &workspace_id)
}

fn workspace_list_branches_inner(
    state: &AppState,
    workspace_id: &str,
) -> Result<Vec<String>, CommandError> {
    let Some(path) = workspace_path(state, workspace_id)? else {
        return Ok(Vec::new());
    };
    let path = PathBuf::from(worktree::expand_home(&path));
    let Ok(repo) = git2::Repository::open(&path) else {
        return Ok(Vec::new());
    };
    let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    for branch in branches.flatten() {
        if let Some(name) = branch.0.name().ok().flatten() {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

#[tauri::command]
pub fn workspace_list_config_files(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<Vec<String>, CommandError> {
    workspace_list_config_files_inner(&state, &workspace_id)
}

fn workspace_list_config_files_inner(
    state: &AppState,
    workspace_id: &str,
) -> Result<Vec<String>, CommandError> {
    let Some(path) = workspace_path(state, workspace_id)? else {
        return Ok(Vec::new());
    };
    let path = PathBuf::from(worktree::expand_home(&path));
    const CANDIDATES: &[&str] = &[
        ".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.dev", ".env.prod",
    ];
    Ok(CANDIDATES
        .iter()
        .filter(|name| path.join(name).is_file())
        .map(|name| (*name).to_owned())
        .collect())
}

#[tauri::command]
pub fn workspaces_exist(
    _state: tauri::State<AppState>,
    paths: Vec<String>,
) -> Result<HashMap<String, bool>, CommandError> {
    workspaces_exist_inner(paths)
}

fn workspaces_exist_inner(paths: Vec<String>) -> Result<HashMap<String, bool>, CommandError> {
    let mut result = HashMap::new();
    for path in paths {
        let expanded = worktree::expand_home(&path);
        result.insert(path, PathBuf::from(expanded).is_dir());
    }
    Ok(result)
}

fn workspace_path(state: &AppState, workspace_id: &str) -> Result<Option<String>, CommandError> {
    state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|ws| ws.id == workspace_id)
            .map(|ws| ws.path.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_with_config(name: &str, config_json: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(dir.join("config.json"), config_json).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    #[test]
    fn passes_stored_fields_through_and_hydrates_missing_rag_config() {
        let (state, dir) = state_with_config(
            "hydrate",
            r#"{"workspaces":[{
                "id": "ws_1", "name": "tide", "path": "/repo/tide",
                "branch": "main", "headCommit": "1cd734e", "isDefault": false,
                "fileCount": 448, "worktreeLocation": ".agent/worktrees/",
                "scripts": [{ "kind": "run", "command": "pnpm dev" }]
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0],
            serde_json::json!({
                "id": "ws_1", "name": "tide", "path": "/repo/tide",
                "branch": "main", "headCommit": "1cd734e", "isDefault": false,
                "fileCount": 448, "worktreeLocation": ".agent/worktrees/",
                "scripts": [{ "kind": "run", "command": "pnpm dev" }],
                "ragConfig": {
                    "embedderId": "local-code-512", "dim": 384,
                    "cloudAllowed": false, "chunkTokens": 384
                }
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clamps_chunk_tokens_to_embedder_max_and_keeps_cloud_flag() {
        let (state, dir) = state_with_config(
            "clamp",
            r#"{"workspaces":[{
                "id": "ws_2", "name": "x", "path": "/x",
                "ragConfig": { "embedderId": "local-code-512", "chunkTokens": 999, "cloudAllowed": true }
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(
            workspaces[0]["ragConfig"],
            serde_json::json!({
                "embedderId": "local-code-512", "dim": 384,
                "cloudAllowed": true, "chunkTokens": 512
            })
        );

        let (state, dir2) = state_with_config(
            "clamp-cloud",
            r#"{"workspaces":[{
                "id": "ws_3", "name": "x", "path": "/x",
                "ragConfig": { "embedderId": "cloud-base", "chunkTokens": 384 }
            }]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces[0]["ragConfig"]["chunkTokens"], serde_json::json!(256));
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&dir2).unwrap();
    }

    #[test]
    fn archived_workspace_keeps_archived_at_and_order_follows_config() {
        let (state, dir) = state_with_config(
            "archived",
            r#"{"workspaces":[
                { "id": "ws_a", "name": "a", "path": "/a", "archivedAt": "2026-01-01T00:00:00.000Z" },
                { "id": "ws_b", "name": "b", "path": "/b" }
            ]}"#,
        );
        let workspaces = list(&state).unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0]["id"], "ws_a");
        assert_eq!(workspaces[0]["archivedAt"], "2026-01-01T00:00:00.000Z");
        assert!(workspaces[1].as_object().unwrap().get("archivedAt").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_and_unreadable_configs() {
        let (state, dir) = state_with_config("empty", "{}");
        assert!(list(&state).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();

        let (state, dir) = state_with_config("broken", "{ nope");
        let err = list(&state).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        fs::remove_dir_all(&dir).unwrap();
    }
}


#[cfg(test)]
mod management_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tide-cmd-ws-mgmt-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_over(name: &str, config: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(dir.join("config.json"), config).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    /// A git repo dir with a commit on `main` and two tracked files.
    fn seeded_repo_dir(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        let mut init_opts = git2::RepositoryInitOptions::new();
        init_opts.initial_head("main");
        let repo = git2::Repository::init_opts(&dir, &init_opts).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Tide Test").unwrap();
            config.set_str("user.email", "tide@test.local").unwrap();
        }
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        fs::write(dir.join("b.txt"), "b\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.add_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = repo.signature().unwrap();
            let commit_id = repo
                .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
            let commit = repo.find_commit(commit_id).unwrap();
            // HEAD already sits on main (initial_head); add the side branch.
            repo.branch("feature/x", &commit, true).unwrap();
        }
        dir
    }

    #[tokio::test]
    async fn add_derives_ids_names_and_git_info() {
        let repo_dir = seeded_repo_dir("add-existing");
        let (state, dir) = state_over("add-existing-cfg", "{}");
        let wire = add_workspace(
            &state,
            WorkspaceAddInputWire {
                path: repo_dir.to_string_lossy().into_owned(),
                name: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(wire["id"].as_str().unwrap().starts_with("ws_"));
        assert_eq!(wire["id"].as_str().unwrap().len(), 11);
        assert_eq!(wire["name"], json!(repo_dir.file_name().unwrap().to_string_lossy()));
        assert_eq!(wire["branch"], json!("main"));
        assert_eq!(wire["headCommit"].as_str().unwrap().len(), 7);
        assert_eq!(wire["fileCount"], json!(2));
        assert_eq!(wire["isDefault"], json!(false));
        assert_eq!(wire["worktreeLocation"], json!(".agent/worktrees/"));
        assert_eq!(wire["scripts"], json!([]));

        // Persisted into the config, readable back through workspaceGet.
        let stored = get_workspace(&state, wire["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(stored["path"], wire["path"]);
        assert_eq!(stored["fileCount"], json!(2));
        // The add response is the built object — no ragConfig hydration.
        assert!(wire.get("ragConfig").is_none());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&repo_dir).unwrap();
    }

    #[tokio::test]
    async fn add_creates_missing_folders_and_inits_git() {
        let (state, dir) = state_over("add-create", "{}");
        let target = dir.join("projects").join("fresh");
        let wire = add_workspace(
            &state,
            WorkspaceAddInputWire {
                path: target.to_string_lossy().into_owned(),
                name: Some("Custom".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(target.join(".git").is_dir(), "empty project gets a git init");
        assert_eq!(wire["name"], json!("Custom"));
        assert_eq!(wire["branch"], json!("main"));
        assert_eq!(wire["headCommit"], json!("unknown"));
        assert_eq!(wire["fileCount"], json!(0));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn update_merges_top_level_keys_and_keeps_extras() {
        let (state, dir) = state_over(
            "update",
            r#"{"workspaces":[{
                "id": "ws_1", "name": "old", "path": "/x",
                "fileCount": 7, "wsFuture": true
            }]}"#,
        );
        let updated = update_workspace(
            &state,
            "ws_1",
            serde_json::json!({ "name": "new", "fileCount": 9, "addedField": "v" }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated["name"], json!("new"));
        assert_eq!(updated["fileCount"], json!(9));
        assert_eq!(updated["addedField"], json!("v"));
        assert_eq!(updated["wsFuture"], json!(true), "unknown stored keys survive");
        // Unknown id → null, config untouched.
        assert!(update_workspace(&state, "ws_x", serde_json::json!({ "name": "n" })).unwrap().is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn archive_unarchive_cascade_into_sessions() {
        let ws = temp_dir("ws-cascade");
        let (state, dir) = state_over(
            "ws-cascade-cfg",
            &format!(r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#, ws.to_string_lossy()),
        );
        let hub = crate::agent::hub::ChatHub::open(&dir).unwrap();
        for id in ["s_main", "s_kid"] {
            hub.writer().lock().expect("sink writer poisoned").create_session(
                tide_store::sessions_v2_write::CreateSessionInput {
                    id,
                    workspace_path: &ws.to_string_lossy(),
                    title: "T",
                    model_id: "m",
                    provider_id: None,
                    parent_id: if id == "s_kid" { Some("s_main") } else { None },
                },
                10_000,
            )
            .unwrap();
        }

        archive_workspace(&state, &hub, "ws_1").unwrap();
        let listed = state.read_config(|cfg| cfg.workspaces[0].archived_at.clone()).unwrap();
        assert!(listed.is_some());
        {
            // The v2 list carries subagents too — the archived main leaves the
            // active page while the un-archived subagent child stays.
            let reader = tide_store::sessions_v2::SessionsV2::open(state.sessions_db_path()).unwrap();
            let active = reader
                .list_sessions(&ws.to_string_lossy(), tide_store::sessions_v2::SessionListOptsV2::default())
                .unwrap();
            let ids: Vec<&str> = active.sessions.iter().map(|s| s.id.as_str()).collect();
            assert_eq!(ids, ["s_kid"], "main archived out of the active list");
            let archived = reader
                .list_sessions(
                    &ws.to_string_lossy(),
                    tide_store::sessions_v2::SessionListOptsV2 { archived: true, ..Default::default() },
                )
                .unwrap();
            let ids: Vec<&str> = archived.sessions.iter().map(|s| s.id.as_str()).collect();
            assert_eq!(ids, ["s_main"], "archive cascade is mains-only like listSessions");
        }

        unarchive_workspace(&state, &hub, "ws_1").unwrap();
        assert!(state.read_config(|cfg| cfg.workspaces[0].archived_at.is_none()).unwrap());
        let reader = tide_store::sessions_v2::SessionsV2::open(state.sessions_db_path()).unwrap();
        let active = reader
            .list_sessions(&ws.to_string_lossy(), tide_store::sessions_v2::SessionListOptsV2::default())
            .unwrap();
        let ids: Vec<&str> = active.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "both rows active again");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn delete_requires_archive_then_cascades_sessions_and_pointer() {
        let ws = temp_dir("ws-delete");
        let (state, dir) = state_over(
            "ws-delete-cfg",
            &format!(
                r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}], "lastWorkspaceId": "ws_1", "lastSessionId": "s_main"}}"#,
                ws.to_string_lossy()
            ),
        );
        let hub = crate::agent::hub::ChatHub::open(&dir).unwrap();
        hub.writer().lock().expect("sink writer poisoned").create_session(
            tide_store::sessions_v2_write::CreateSessionInput {
                id: "s_main",
                workspace_path: &ws.to_string_lossy(),
                title: "T",
                model_id: "m",
                provider_id: None,
                parent_id: None,
            },
            10_000,
        )
        .unwrap();

        // Unarchored: refused, surfaced as ok:false by the command layer.
        let err = delete_workspace(&state, &hub, "ws_1").unwrap_err();
        assert!(err.message.contains("archived before deletion"));

        archive_workspace(&state, &hub, "ws_1").unwrap();
        delete_workspace(&state, &hub, "ws_1").unwrap();
        assert!(
            state.read_config(|cfg| cfg.workspaces.is_empty()).unwrap(),
            "workspace row removed"
        );
        // The TS cleared only lastWorkspaceId — the session pointer dangles.
        assert_eq!(
            state.read_config(|cfg| (cfg.last_workspace_id.clone(), cfg.last_session_id.clone())).unwrap(),
            (None, Some("s_main".into()))
        );
        let reader = tide_store::sessions_v2::SessionsV2::open(state.sessions_db_path()).unwrap();
        assert!(reader
            .list_sessions(&ws.to_string_lossy(), tide_store::sessions_v2::SessionListOptsV2::default())
            .unwrap()
            .sessions
            .is_empty());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn context_assembles_the_project_summary() {
        let ws = temp_dir("ws-ctx");
        fs::write(
            ws.join("package.json"),
            r#"{
                "name": "demo-app", "description": "A demo", "version": "1.2.3", "private": true,
                "dependencies": { "react": "19", "zustand": "5", "left-pad": "1" },
                "devDependencies": { "typescript": "5", "extra-a": "1", "extra-b": "2", "extra-c": "3" },
                "scripts": { "dev": "x", "build": "y", "test": "z", "lint": "w", "e2e": "v", "fmt": "u", "hidden": "-" }
            }"#,
        )
        .unwrap();
        fs::write(ws.join("README.md"), "line one\nline two\n").unwrap();
        fs::write(ws.join("CLAUDE.md"), "always do X\n").unwrap();
        fs::create_dir_all(ws.join("src")).unwrap();
        fs::write(ws.join(".env"), "").unwrap();
        let (state, dir) = state_over(
            "ws-ctx-cfg",
            &format!(r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#, ws.to_string_lossy()),
        );
        let context = workspace_context(&state, "ws_1").unwrap();
        assert!(context.contains("Project: demo-app"));
        assert!(context.contains("Description: A demo"));
        assert!(context.contains("Version: 1.2.3"));
        assert!(context.contains("Private: true"));
        assert!(context.contains("Stack: react, zustand, typescript (+4 more)"));
        assert!(context.contains("Scripts: build, dev, e2e, fmt, hidden, lint (+1 more)"));
        assert!(context.contains("Top-level: CLAUDE.md, README.md, package.json, src/"));
        assert!(!context.contains(".env"), "dotfiles other than .agent hidden");
        assert!(context.contains("---\nREADME (README.md):\nline one\nline two"));
        assert!(context.contains(
            "---\nCLAUDE.md (project agent guidance — always apply; where these rules conflict with your defaults, these rules win):\nalways do X"
        ));

        // Unknown workspace → empty string.
        assert_eq!(workspace_context(&state, "ws_x").unwrap(), "");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn file_read_enforces_containment_and_limits() {
        let ws = temp_dir("ws-read");
        fs::write(ws.join("ok.txt"), "hello").unwrap();
        fs::write(ws.join("big.txt"), vec![b'a'; 300 * 1024]).unwrap();
        fs::write(ws.join("pic.PNG"), "not really").unwrap();
        fs::create_dir_all(ws.join("sub")).unwrap();
        let (state, dir) = state_over(
            "ws-read-cfg",
            &format!(r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#, ws.to_string_lossy()),
        );
        let read = |rel: &str| workspace_file_read_inner(&state, "ws_1", rel);

        let ok = read("ok.txt");
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["content"], json!("hello"));
        assert_eq!(ok["truncated"], json!(false));
        assert_eq!(ok["bytes"], json!(5));

        let big = read("big.txt");
        assert_eq!(big["truncated"], json!(true));
        assert_eq!(big["bytes"], json!(300 * 1024));
        assert_eq!(big["content"].as_str().unwrap().len(), 256 * 1024);

        assert_eq!(read("../outside.txt")["reason"], json!("path escapes workspace root"));
        assert_eq!(read("missing.txt")["reason"], json!("file not found"));
        assert_eq!(read("sub")["reason"], json!("not a regular file"));
        assert_eq!(read("pic.PNG")["reason"], json!("binary file"));
        assert_eq!(read("")["reason"], json!("path escapes workspace root"));

        // Unknown workspace → workspace not found.
        assert_eq!(
            workspace_file_read_inner(&state, "ws_x", "ok.txt")["reason"],
            json!("workspace not found")
        );
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn branches_config_files_and_exist() {
        let ws = seeded_repo_dir("ws-branches");
        fs::write(ws.join(".env"), "X=1\n").unwrap();
        fs::write(ws.join(".env.local"), "X=2\n").unwrap();
        let (state, dir) = state_over(
            "ws-branches-cfg",
            &format!(r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#, ws.to_string_lossy()),
        );
        let mut branches = workspace_list_branches_inner(&state, "ws_1").unwrap();
        branches.sort();
        assert_eq!(branches, vec!["feature/x".to_owned(), "main".to_owned()]);
        assert!(workspace_list_branches_inner(&state, "ws_x").unwrap().is_empty());

        let config_files = workspace_list_config_files_inner(&state, "ws_1").unwrap();
        assert_eq!(config_files, vec![".env".to_owned(), ".env.local".to_owned()]);

        let mut exist = workspaces_exist_inner(vec![ws.to_string_lossy().into_owned(), "/definitely/not".into()]).unwrap();
        assert_eq!(exist.remove(ws.to_string_lossy().as_ref()), Some(true));
        assert_eq!(exist.remove("/definitely/not"), Some(false));
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }
}
