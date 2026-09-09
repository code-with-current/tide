//! The Projects settings page: Tide's own projects presented as a mail-style
//! master–detail split — the project list on the left, the selected project's
//! configuration (identity, icon, default model, actions, git identity,
//! memory & RAG, removal) on the right.
//!
//! All project data is already in memory (`state.projects`); frames never
//! touch the filesystem.

use std::path::{Path, PathBuf};

use gpui::{KeyBinding, actions};

use super::composer::next_picker_highlight;
use super::image_preview::image_format_for_name;
use super::model_picker::{ModelPickerClear, ModelPickerConfig, ModelPickerSelect};
use crate::ui::card::{CardRow, card_body, card_rows, settings_group_head};

use super::*;

/// Key context the left pane declares around its search field.
const PROJECTS_PANE_CONTEXT: &str = "ProjectsPane";

/// The search field while focused inside the pane. The field keeps focus
/// while `up`/`down` walk the list selection, the same claim-from-under-it
/// arrangement the skills pane uses.
const PROJECTS_SEARCH_CONTEXT: &str = "ProjectsPane > TextInput";

const PROJECTS_LIST_WIDTH: f32 = 264.0;

/// Well-known repo-root icon files, in precedence order.
const WELL_KNOWN_ICONS: [&str; 4] = ["icon.png", "favicon.png", "logo.svg", "logo.png"];

/// Embedded glyphs the icon picker offers, as asset paths.
const PRESET_ICONS: [&str; 10] = [
    "icons/projects/rocket.svg",
    "icons/projects/bolt.svg",
    "icons/projects/star.svg",
    "icons/projects/heart.svg",
    "icons/projects/globe.svg",
    "icons/projects/terminal.svg",
    "icons/projects/box.svg",
    "icons/projects/flame.svg",
    "icons/projects/leaf.svg",
    "icons/projects/wrench.svg",
];

/// Fixed background palette for the icon tile, as hex.
const ICON_COLORS: [&str; 8] = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
];

const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024;

fn uploaded_icon_path(name: &str) -> PathBuf {
    store::paths::data_dir().join("project-icons").join(name)
}

/// Remove a project's older uploaded icons (best-effort), keeping only the
/// named one — every upload writes a fresh, uniquely-named file so image
/// caches (keyed by path) can't keep serving the previous avatar.
fn prune_old_uploads_in(dir: &Path, project_id: Uuid, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = project_id.to_string();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name != keep && name.starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// An action is only worth storing when its command is non-empty; a blank
/// name falls back to the command's first word.
/// The project avatar in every surface: preset glyph, uploaded image,
/// well-known repo file, or the initials fallback. `probe` is the landed
/// background result for this project, when one exists.
pub(super) fn project_avatar(
    project: &Project,
    probe: Option<&ProjectIconProbe>,
    size: f32,
) -> AnyElement {
    let tile = |child: AnyElement| {
        div()
            .w(px(size))
            .h(px(size))
            .flex_none()
            .rounded(px(size * 0.24))
            .bg(icon_tile_background(project))
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_center()
            .child(child)
            .into_any_element()
    };
    match &project.icon {
        ProjectIcon::Preset(path) => tile(
            PRESET_ICONS
                .iter()
                .copied()
                .find(|candidate| *candidate == path.as_str())
                .map(|static_path| {
                    icon(static_path, size * 0.5, rgb(0xFF_FF_FF).into()).into_any_element()
                })
                .unwrap_or_else(|| div().into_any_element()),
        ),
        ProjectIcon::Uploaded(name) => tile(
            img(uploaded_icon_path(name))
                // Pixel sizes (not size_full) keep the intrinsic
                // aspect-ratio Img injects from winning over flex
                // measurement; the img's own rounding lets the Cover
                // sprite clip itself to the tile's corners.
                .w(px(size))
                .h(px(size))
                .flex_none()
                .rounded(px(size * 0.24))
                .object_fit(gpui::ObjectFit::Cover)
                .into_any_element(),
        ),
        ProjectIcon::Auto => {
            let well_known = probe
                .filter(|probe| probe.root == project.path)
                .and_then(|probe| probe.well_known.clone());
            match well_known {
                Some(path) => tile(
                    img(path)
                        .size_full()
                        .object_fit(gpui::ObjectFit::Cover)
                        .into_any_element(),
                ),
                None => tile(
                    div()
                        .text_size(sp(size * 0.34))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(rgb(0xFF_FF_FF))
                        .child(SharedString::from(auto_initials(&project.name)))
                        .into_any_element(),
                ),
            }
        }
    }
}

fn normalize_project_action(name: String, command: &str) -> Option<ProjectAction> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let name = name.trim();
    let name = if name.is_empty() {
        command
            .split_whitespace()
            .next()
            .unwrap_or("action")
            .to_owned()
    } else {
        name.to_owned()
    };
    Some(ProjectAction {
        name,
        command: command.to_owned(),
    })
}

/// Initials for the auto fallback: the first character of up to two words.
fn auto_initials(name: &str) -> String {
    name.split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase()
}

/// Deterministic hue (0..360) for the auto fallback tile.
fn auto_hue(name: &str) -> f32 {
    let hash = name
        .bytes()
        .fold(0u32, |acc, byte| acc.wrapping_add((byte as u32) * 31));
    (hash % 360) as f32
}

/// The tile background in every icon mode: the picked color when set, the
/// name-derived hue otherwise.
fn icon_tile_background(project: &Project) -> Hsla {
    if let Some(hex) = project
        .icon_color
        .as_deref()
        .and_then(|hex| u32::from_str_radix(hex.trim_start_matches('#'), 16).ok())
    {
        return rgb(hex & 0xFF_FF_FF).into();
    }
    gpui::hsla(auto_hue(&project.name) / 360.0, 0.55, 0.5, 1.0)
}

/// One landed background probe: the root it ran against, whether the
/// directory is on disk, and the best well-known icon file, if any.
#[derive(Clone, Debug)]
pub(super) struct ProjectIconProbe {
    pub(super) root: PathBuf,
    pub(super) dir_exists: bool,
    pub(super) well_known: Option<PathBuf>,
}

/// The remove-project confirmation. `delete_history` mirrors the checkbox —
/// sessions and their transcripts go with the project when set.
pub(super) struct RemoveProjectDialog {
    pub(super) project_id: Uuid,
    pub(super) project_name: String,
    pub(super) delete_history: bool,
}

/// The selection after a removal: the row that took the removed row's place
/// (the last row when the tail was removed), kept when something else was
/// selected, `None` when nothing remains.
fn fallback_project_selection(ids: &[Uuid], removed: Uuid, current: Option<Uuid>) -> Option<Uuid> {
    if current != Some(removed) {
        return current;
    }
    let position = ids.iter().position(|id| *id == removed)?;
    // The next row, or the previous one when the tail was removed. If that
    // is still the removed row, nothing remains.
    let index = if position + 1 < ids.len() {
        position + 1
    } else {
        position.saturating_sub(1)
    };
    let candidate = ids.get(index).copied();
    candidate.filter(|id| *id != removed)
}

/// Key context the remove-project dialog declares, so `escape` dismisses it
/// without reaching other surfaces.
const REMOVE_CONTEXT: &str = "ProjectsRemoveDialog";

actions!(tide, [DismissRemoveProject]);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("down", SelectNextEntry, Some(PROJECTS_SEARCH_CONTEXT)),
        KeyBinding::new("up", SelectPreviousEntry, Some(PROJECTS_SEARCH_CONTEXT)),
        KeyBinding::new("escape", DismissRemoveProject, Some(REMOVE_CONTEXT)),
    ]);
}

/// A stable identity for list-row element reuse across refilters. Both halves
/// fold together, so ids that differ only in their low bytes stay distinct.
fn project_row_key(id: Uuid) -> u64 {
    let bytes = id.as_bytes();
    let mut key = [0u8; 8];
    for (slot, pair) in key.iter_mut().zip(bytes.chunks(2)) {
        *slot = pair[0] ^ pair[1];
    }
    u64::from_be_bytes(key)
}

/// One row of the virtualized project list. Equality drives the prefix splice
/// in [`Tide::sync_projects_rows`]: a changed row — identity or selection —
/// re-measures from that point on.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum ProjectsRow {
    Project {
        id: Uuid,
        row_key: u64,
        selected: bool,
    },
}

impl Tide {
    // ── Selection ──────────────────────────────────────────────────────────

    pub(super) fn landed_probe(&self, project_id: Uuid) -> Option<ProjectIconProbe> {
        self.projects_icon_probes.borrow().get(&project_id).cloned()
    }

    fn select_settings_project(&mut self, id: Uuid, cx: &mut Context<Self>) {
        self.projects_settings_selected = Some(id);
        self.projects_icon_error = None;
        // Each project's detail starts at its own top; a scroll position
        // carried over would land mid-panel.
        self.projects_detail_scroll
            .set_offset(gpui::Point::default());
        self.sync_project_selection_ui(cx);
        cx.notify();
    }

    /// Everything the detail panel needs for the effective selection: probe
    /// the directory, load the rename field, warm the RAG status.
    pub(super) fn sync_project_selection_ui(&mut self, cx: &mut Context<Self>) {
        let Some((id, path)) = self.projects_settings_target() else {
            return;
        };
        self.ensure_project_icon_probe(id, path, cx);
        self.load_name_input_for(id, cx);
        if self
            .rag_settings
            .status
            .as_ref()
            .is_none_or(|status| status.project_id != id.to_string())
        {
            self.rag_refresh(&id.to_string());
        }
    }

    /// Mirror `project_id`'s name into the rename field.
    fn load_name_input_for(&mut self, project_id: Uuid, cx: &mut Context<Self>) {
        let Some(name) = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.name.clone())
        else {
            return;
        };
        self.projects_name_input.update(cx, |input, cx| {
            let len = input.content().len();
            input.replace_range(0..len, &name, cx);
        });
    }

    /// Probe every ordinary project once, so avatars render with data in all
    /// surfaces (sidebar, pickers) without any frame touching the filesystem.
    pub(super) fn ensure_all_project_icon_probes(&mut self, cx: &mut Context<Self>) {
        let targets: Vec<(Uuid, PathBuf)> = self
            .state
            .projects
            .iter()
            .filter(|project| !project.is_projectless())
            .map(|project| (project.id, project.path.clone()))
            .collect();
        for (id, path) in targets {
            self.ensure_project_icon_probe(id, path, cx);
        }
    }

    /// Start a background probe of the project directory unless a
    /// current-enough one (for the same root) already landed.
    pub(super) fn ensure_project_icon_probe(
        &mut self,
        project_id: Uuid,
        root: PathBuf,
        cx: &mut Context<Self>,
    ) {
        if self
            .projects_icon_probes
            .borrow()
            .get(&project_id)
            .is_some_and(|probe| probe.root == root)
        {
            return;
        }
        self.projects_icon_probe_generation += 1;
        let generation = self.projects_icon_probe_generation;
        let probe_root = root.clone();
        cx.spawn(async move |this, cx| {
            let probe = cx
                .background_executor()
                .spawn(async move {
                    let dir_exists = probe_root.is_dir();
                    let well_known = if dir_exists {
                        WELL_KNOWN_ICONS
                            .iter()
                            .map(|name| probe_root.join(name))
                            .find(|candidate| candidate.is_file())
                    } else {
                        None
                    };
                    ProjectIconProbe {
                        root: probe_root,
                        dir_exists,
                        well_known,
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.projects_icon_probe_generation != generation {
                    // A newer probe superseded this one.
                    return;
                }
                this.projects_icon_probes
                    .borrow_mut()
                    .insert(project_id, probe);
                cx.notify();
            });
        })
        .detach();
    }

    /// The project the detail panel will show: the rail selection, or the
    /// first ordinary project. `(id, path)` so callers borrow nothing.
    pub(super) fn projects_settings_target(&self) -> Option<(Uuid, PathBuf)> {
        let id = self.projects_settings_selected.or_else(|| {
            self.state
                .projects
                .iter()
                .find(|project| !project.is_projectless())
                .map(|project| project.id)
        })?;
        let path = self
            .state
            .projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| project.path.clone())?;
        Some((id, path))
    }

    /// Walk the selection through the visible rows, the way a mailbox walks
    /// its message list. The search field keeps focus so typing keeps
    /// narrowing.
    fn step_project_selection(&mut self, key: &str, cx: &mut Context<Self>) {
        let rows = self.projects_settings_rows.borrow();
        let entries: Vec<(usize, Uuid)> = rows
            .iter()
            .enumerate()
            .filter_map(|(row_index, row)| match row {
                ProjectsRow::Project { id, .. } => Some((row_index, *id)),
            })
            .collect();
        drop(rows);
        if entries.is_empty() {
            return;
        }
        let current = self
            .projects_settings_selected
            .and_then(|selected| entries.iter().position(|(_, id)| *id == selected));
        let Some(next) = next_picker_highlight(current, entries.len(), key) else {
            return;
        };
        let (row_index, id) = entries[next];
        self.projects_settings_selected = Some(id);
        self.projects_detail_scroll
            .set_offset(gpui::Point::default());
        self.projects_settings_list.scroll_to_reveal_item(row_index);
        self.sync_project_selection_ui(cx);
        cx.notify();
    }

    // ── Page ───────────────────────────────────────────────────────────────

    pub(super) fn render_projects_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let query = self
            .projects_settings_search
            .read(cx)
            .content()
            .trim()
            .to_lowercase();

        if self
            .state
            .projects
            .iter()
            .all(|project| project.is_projectless())
        {
            return crate::ui::empty_state::EmptyState::new(
                "icons/folder.svg",
                tr!("projects.empty_title"),
            )
            .caption(tr!("projects.empty_description"))
            .size_full()
            .px(px(40.0))
            .py(px(40.0))
            .into_any_element();
        }

        let rows = self.projects_rows_from(&query);
        self.sync_projects_rows(&rows);

        // The detail pane never sits empty while projects exist: the stored
        // selection wins when visible, the first visible row otherwise.
        let selected = self
            .projects_settings_selected
            .filter(|selected| {
                rows.iter().any(|row| match row {
                    ProjectsRow::Project { id, .. } => id == selected,
                })
            })
            .or_else(|| {
                rows.first().map(|row| match row {
                    ProjectsRow::Project { id, .. } => *id,
                })
            });

        let detail: AnyElement = selected
            .and_then(|id| self.state.projects.iter().find(|project| project.id == id))
            .map(|project| self.render_project_detail(project, &theme, cx))
            .unwrap_or_else(|| projects_detail_placeholder(&theme).into_any_element());

        div()
            .size_full()
            .min_h_0()
            .flex()
            .child(self.render_projects_list_column(&query, &rows, &theme, cx))
            .child(div().flex_1().min_w_0().flex().flex_col().child(detail))
            .into_any_element()
    }

    fn render_projects_list_column(
        &self,
        query: &str,
        rows: &[ProjectsRow],
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let total = self
            .state
            .projects
            .iter()
            .filter(|project| !project.is_projectless())
            .count();
        let footer = if !query.is_empty() {
            tr!("projects.filter_caption", shown = rows.len(), total = total)
        } else if total == 1 {
            tr!("projects.count_one")
        } else {
            tr!("projects.count_many", count = total)
        };

        let body: AnyElement = if rows.is_empty() {
            projects_status_row(
                theme,
                if total == 0 {
                    tr!("projects.empty_title")
                } else {
                    tr!("projects.no_match")
                },
            )
            .into_any_element()
        } else {
            let entity = cx.entity().downgrade();
            div()
                .flex_1()
                .min_h_0()
                .relative()
                .child(
                    div().px(px(8.0)).size_full().child(
                        list(
                            self.projects_settings_list.clone(),
                            move |index, _window, cx| {
                                entity
                                    .upgrade()
                                    .map(|entity| {
                                        entity.update(cx, |this, cx| this.projects_row(index, cx))
                                    })
                                    .unwrap_or_else(|| div().into_any_element())
                            },
                        )
                        .size_full(),
                    ),
                )
                .child(scrollbar::vertical(
                    &self.projects_settings_list,
                    &self.projects_settings_scrollbar,
                ))
                .into_any_element()
        };

        div()
            .key_context(PROJECTS_PANE_CONTEXT)
            .on_action(cx.listener(|this, _: &SelectNextEntry, _, cx| {
                this.step_project_selection("down", cx);
            }))
            .on_action(cx.listener(|this, _: &SelectPreviousEntry, _, cx| {
                this.step_project_selection("up", cx);
            }))
            .w(px(PROJECTS_LIST_WIDTH))
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex_none()
                    .px(px(10.0))
                    .pt(px(22.0))
                    .pb(px(8.0))
                    .flex()
                    .flex_col()
                    .child(
                        TextField::new(
                            "projects-search-field",
                            self.projects_settings_search.clone(),
                        )
                        .icon("icons/search.svg", 13.0)
                        .w_full(),
                    ),
            )
            .child(body)
            .child(
                div()
                    .flex_none()
                    .h(px(26.0))
                    .px(px(12.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(sp(12.5))
                    .text_color(theme.text_ghost)
                    .child(SharedString::from(footer)),
            )
    }

    // ── List rows ──────────────────────────────────────────────────────────

    /// The visible rows: every ordinary project the query leaves, in stored
    /// (sidebar) order. Projectless pseudo-projects are not configurable and
    /// stay out of the list.
    fn projects_rows_from(&self, query: &str) -> Vec<ProjectsRow> {
        let query = query.to_lowercase();
        self.state
            .projects
            .iter()
            .filter(|project| !project.is_projectless())
            .filter(|project| project_matches_query(&project.name, &project.path, &query))
            .map(|project| ProjectsRow::Project {
                id: project.id,
                row_key: project_row_key(project.id),
                selected: self.projects_settings_selected == Some(project.id),
            })
            .collect()
    }

    /// Keep the virtualized list in sync with the freshly computed rows.
    /// Sharing a prefix keeps scroll position across filter keystrokes and
    /// selection moves; everything after the first change re-measures.
    fn sync_projects_rows(&self, rows: &[ProjectsRow]) {
        let mut cached = self.projects_settings_rows.borrow_mut();
        if cached.as_slice() == rows {
            return;
        }
        let prefix = cached
            .iter()
            .zip(rows.iter())
            .take_while(|(cached, fresh)| cached == fresh)
            .count();
        let old_count = cached.len();
        *cached = rows.to_vec();
        if old_count == 0 {
            self.projects_settings_list.reset(rows.len());
        } else {
            self.projects_settings_list
                .splice(prefix..old_count, rows.len() - prefix);
        }
    }

    /// One list row, built only while visible. Reads the per-frame row cache;
    /// a stale index from a frame racing a removal renders empty rather than
    /// panicking.
    fn projects_row(&self, row: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let rows = self.projects_settings_rows.borrow();
        let Some(entry) = rows.get(row) else {
            return div().into_any_element();
        };
        let ProjectsRow::Project { id, selected, .. } = entry;
        let Some(project) = self.state.projects.iter().find(|project| &project.id == id) else {
            return div().into_any_element();
        };
        let selected = *selected;
        drop(rows);
        self.render_projects_list_row(project, selected, &theme, cx)
    }

    fn render_projects_list_row(
        &self,
        project: &Project,
        selected: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = project.id;
        div()
            .w_full()
            .pb(px(1.0))
            .child(
                div()
                    .id(SharedString::from(format!(
                        "project-item-{}",
                        project_row_key(id)
                    )))
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .w_full()
                    .px(px(9.0))
                    .py(px(7.0))
                    .rounded(px(8.0))
                    .cursor_default()
                    .when(selected, |element| {
                        element.bg(theme.sidebar_item_background)
                    })
                    .when(!selected, |element| {
                        element.hover(|element| element.bg(theme.overlay))
                    })
                    .flex()
                    .items_center()
                    .gap(px(9.0))
                    .child({
                        let probe = self.landed_probe(id);
                        project_avatar(project, probe.as_ref(), 26.0)
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(sp(12.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(SharedString::from(project.name.clone())),
                            )
                            .child(
                                div()
                                    .mt(px(1.0))
                                    .truncate()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_tertiary)
                                    .child(SharedString::from(
                                        project.path.to_string_lossy().into_owned(),
                                    )),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_settings_project(id, cx);
                    })),
            )
            .into_any_element()
    }

    /// The selected project's configuration panel. Sections land in the next
    /// changes; until then the panel carries the identity header only.
    // ── Mutations ──────────────────────────────────────────────────────────

    fn set_project_icon(&mut self, project_id: Uuid, icon: ProjectIcon, cx: &mut Context<Self>) {
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.icon = icon;
        }
        self.projects_icon_error = None;
        self.dispatch_update_project_settings(project_id, cx);
    }

    fn set_project_icon_color(
        &mut self,
        project_id: Uuid,
        color: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.icon_color = color;
        }
        self.dispatch_update_project_settings(project_id, cx);
    }

    fn start_icon_upload(&mut self, project_id: Uuid, cx: &mut Context<Self>) {
        if self.daemon.is_remote() {
            self.show_toast(tr!("errors.remote_project_picker"));
            return;
        }
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = this.update(cx, |this, cx| this.finish_icon_upload(project_id, path, cx));
            }
        })
        .detach();
    }

    fn finish_icon_upload(&mut self, project_id: Uuid, picked: PathBuf, cx: &mut Context<Self>) {
        if image_format_for_name(&picked.to_string_lossy()).is_none() {
            // Keep the previous icon; surface why, inline.
            self.projects_icon_error = Some(project_id);
            cx.notify();
            return;
        }
        let extension = picked
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .unwrap_or_else(|| "png".to_owned());
        // A fresh name per upload: gpui caches images by path, so copying
        // over the same `<id>.<ext>` would leave the old pixels on screen.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or(0);
        let file_name = format!("{project_id}-{stamp}.{extension}");
        let prune_name = file_name.clone();
        let dest = uploaded_icon_path(&file_name);
        let source = picked;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let size_ok = std::fs::metadata(&source)
                        .map(|meta| meta.len() <= MAX_UPLOAD_BYTES)
                        .unwrap_or(false);
                    if !size_ok {
                        return Err("too large");
                    }
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    std::fs::copy(&source, &dest)
                        .map(|_| ())
                        .map_err(|_| "copy")?;
                    prune_old_uploads_in(
                        &store::paths::data_dir().join("project-icons"),
                        project_id,
                        &prune_name,
                    );
                    Ok(())
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        if let Some(project) = this
                            .state
                            .projects
                            .iter_mut()
                            .find(|project| project.id == project_id)
                        {
                            project.icon = ProjectIcon::Uploaded(file_name);
                        }
                        this.projects_icon_error = None;
                        // Persist like the preset/auto path — otherwise the
                        // next projects refresh reverts to the old icon.
                        this.dispatch_update_project_settings(project_id, cx);
                    }
                    Err(_) => {
                        this.projects_icon_error = Some(project_id);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The Enter-commit for the name field. Empty or unchanged text is a
    /// no-op; the value stages locally until the settings round-trip lands.
    pub(super) fn commit_project_rename(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.projects_settings_selected else {
            return;
        };
        let name = self
            .projects_name_input
            .read(cx)
            .content()
            .trim()
            .to_owned();
        if name.is_empty() {
            return;
        }
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == id)
        {
            if project.name != name {
                project.name = name;
                self.dispatch_update_project_settings(id, cx);
                return;
            }
        }
    }

    fn render_project_detail(
        &self,
        project: &Project,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id;
        let missing = self
            .projects_icon_probes
            .borrow()
            .get(&project.id)
            .is_some_and(|probe| probe.root == project.path && !probe.dir_exists);
        div()
            .id("project-detail-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                div()
                    .px(px(24.0))
                    .pt(px(22.0))
                    .pb(px(24.0))
                    .max_w(px(640.0))
                    .flex()
                    .flex_col()
                    .gap(px(20.0))
                    .child(self.render_project_header(project, missing, theme, cx))
                    .child(self.render_project_general_card(project, theme, cx))
                    .child(self.render_project_model_card(project, theme, cx))
                    .child(self.render_project_actions_card(project, theme, cx))
                    .child(
                        self.render_memory_rag_card_for(Some(project.clone()), theme, cx)
                            .into_any_element(),
                    )
                    .child(self.render_project_git_card(project, missing, theme, cx))
                    .child(
                        div()
                            .id("projects-remove-row")
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .mt(px(4.0))
                            .px(px(14.0))
                            .py(px(10.0))
                            .rounded(px(13.0))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.raised)
                            .cursor_default()
                            .hover(|element| element.bg(theme.overlay))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_size(sp(12.5))
                            .text_color(theme.danger)
                            .child(icon("icons/block.svg", 13.0, theme.danger))
                            .child(tr!("projects.remove"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_remove_project_dialog(project_id, cx);
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_project_header(
        &self,
        project: &Project,
        missing: bool,
        theme: &Theme,
        _cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(self.render_project_icon_tile(project, 40.0))
                    .child(
                        TextField::new("project-name-input", self.projects_name_input.clone())
                            .w_full(),
                    ),
            )
            .child(if missing {
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(sp(12.5))
                    .text_color(theme.warning)
                    .child(icon("icons/alert.svg", 13.0, theme.warning))
                    .child(tr!("projects.directory_missing"))
            } else {
                div()
                    .text_size(sp(12.5))
                    .text_color(theme.text_tertiary)
                    .child(SharedString::from(
                        project.path.to_string_lossy().into_owned(),
                    ))
            })
            .into_any_element()
    }

    /// The project's icon tile in every mode: preset glyph, uploaded image,
    /// well-known repo file, or the initials fallback.
    fn render_project_icon_tile(&self, project: &Project, size: f32) -> AnyElement {
        let probe = self.landed_probe(project.id);
        project_avatar(project, probe.as_ref(), size)
    }

    /// New chats in this project start on the picked model; the composer's
    /// own picker still overrides per session.
    fn render_project_model_card(
        &self,
        project: &Project,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id;
        let trigger_label = project
            .default_model
            .clone()
            .unwrap_or_else(|| tr!("projects.default_model_global"));
        let config = ModelPickerConfig {
            active: project
                .default_model
                .as_ref()
                .map(|model| (ProviderKind::Tide, model.clone())),
            refocus_composer_on_close: false,
        };
        let on_select: ModelPickerSelect = Rc::new(move |this, _kind, model, cx| {
            if let Some(project) = this
                .state
                .projects
                .iter_mut()
                .find(|project| project.id == project_id)
            {
                project.default_provider = Some(ProviderKind::Tide);
                project.default_model = Some(model.clone());
            }
            this.dispatch_update_project_settings(project_id, cx);
        });
        let clear: ModelPickerClear = Rc::new(move |this, cx| {
            if let Some(project) = this
                .state
                .projects
                .iter_mut()
                .find(|project| project.id == project_id)
            {
                project.default_provider = None;
                project.default_model = None;
            }
            this.dispatch_update_project_settings(project_id, cx);
        });
        let menu = self.render_model_picker(
            SharedString::from(format!("projects-model-picker-{project_id}")),
            config,
            Some((
                SharedString::from(tr!("projects.default_model_global")),
                clear,
            )),
            on_select,
            MenuAlign::BelowRight,
            move |open| {
                MenuChip::new(format!("projects-model-chip-{project_id}"))
                    .label(trigger_label.clone())
                    .outlined()
                    .selected(open)
                    .w(px(210.0))
                    .justify_between()
            },
            cx,
        );
        div()
            .child(settings_group_head(
                theme,
                tr!("projects.default_model"),
                Vec::new(),
            ))
            .child(card_body(theme).child(card_rows(
                theme,
                vec![CardRow::new(tr!("projects.default_model"))
                        .description(tr!("projects.default_model_hint"))
                        .control(menu)],
            )))
            .into_any_element()
    }

    /// Repo-local git identity for this project — the picker that lived on
    /// the Git page's per-project rows, remounted for one project.
    fn render_project_git_card(
        &self,
        project: &Project,
        missing: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let head = || settings_group_head(theme, tr!("projects.git_identity"), Vec::new());
        let unavailable = |theme: &Theme| {
            div()
                .child(head())
                .child(
                    card_body(theme).child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("projects.directory_unavailable")),
                    ),
                )
                .into_any_element()
        };
        let Some(snapshot) = self.git_settings.snapshot.clone() else {
            return div()
                .child(head())
                .child(
                    card_body(theme).child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git.loading")),
                    ),
                )
                .into_any_element();
        };
        let status = snapshot
            .statuses
            .iter()
            .find(|status| status.project_id == project.id);
        if missing || status.is_none_or(|status| !status.is_repo) {
            return unavailable(theme);
        }
        let status = status.expect("checked above");
        let profile = status
            .profile_id
            .as_ref()
            .and_then(|id| snapshot.profiles.iter().find(|profile| &profile.id == id));
        let label = profile
            .map(|profile| {
                profile
                    .name
                    .clone()
                    .unwrap_or_else(|| profile.user_name.clone())
            })
            .unwrap_or_else(|| tr!("git.projects.global"));
        let handle = self.menu_handle(
            SharedString::from(format!("projects-git-{}", project.id)),
            cx,
        );
        let chip = MenuChip::new(SharedString::from(format!(
            "projects-git-chip-{}",
            project.id
        )))
        .icon("icons/git-branch.svg", theme.text_tertiary)
        .label(label)
        .outlined()
        .background(theme.raised)
        .height(px(26.0))
        .selected(handle.is_open());
        let weak = cx.entity().downgrade();
        let project_path = status.path.clone();
        let active_profile_id = status.profile_id.clone();
        let profiles = std::rc::Rc::new(snapshot.profiles.iter().cloned().collect::<Vec<_>>());
        let menu = dropdown_menu(
            chip,
            SharedString::from(format!("projects-git-menu-{}", project.id)),
            &handle,
            MenuAlign::BelowRight,
            move |_| {
                let mut items = Vec::new();
                {
                    let weak = weak.clone();
                    let path = project_path.clone();
                    let no_override = active_profile_id.is_none();
                    items.push(
                        MenuItem::new(tr!("git.projects.global"), move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.git_set_project_identity(path.clone(), "global".into());
                            });
                        })
                        .icon("icons/globe.svg")
                        .selected(no_override),
                    );
                }
                for profile in profiles.iter() {
                    let weak = weak.clone();
                    let path = project_path.clone();
                    let profile_id = profile.id.clone();
                    let display = profile
                        .name
                        .clone()
                        .unwrap_or_else(|| profile.user_name.clone());
                    let selected = active_profile_id.as_deref() == Some(profile.id.as_str());
                    items.push(
                        MenuItem::new(display, move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.git_set_project_identity(path.clone(), profile_id.clone());
                            });
                        })
                        .selected(selected),
                    );
                }
                items
            },
        );
        div()
            .child(head())
            .child(card_body(theme).child(card_rows(
                theme,
                vec![CardRow::new(tr!("projects.git_identity"))
                        .description(SharedString::from(status.path.clone()))
                        .control(menu)],
            )))
            .into_any_element()
    }

    /// Enter in the add-row's name field: resolve the rail selection and add.
    pub(super) fn add_project_action_from_selection(&mut self, cx: &mut Context<Self>) {
        if let Some((id, _)) = self.projects_settings_target() {
            self.add_project_action(id, cx);
        }
    }

    fn add_project_action(&mut self, project_id: Uuid, cx: &mut Context<Self>) {
        let name = self
            .projects_action_name
            .read(cx)
            .content()
            .trim()
            .to_owned();
        let command = self
            .projects_action_command
            .read(cx)
            .content()
            .trim()
            .to_owned();
        let Some(action) = normalize_project_action(name, &command) else {
            self.projects_action_error = true;
            cx.notify();
            return;
        };
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.actions.push(action);
        }
        for input in [&self.projects_action_name, &self.projects_action_command] {
            input.update(cx, |input, cx| {
                let len = input.content().len();
                input.replace_range(0..len, "", cx);
            });
        }
        self.projects_action_error = false;
        self.dispatch_update_project_settings(project_id, cx);
    }

    fn remove_project_action(&mut self, project_id: Uuid, index: usize, cx: &mut Context<Self>) {
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.actions.remove(index);
        }
        self.dispatch_update_project_settings(project_id, cx);
    }

    fn render_project_actions_card(
        &self,
        project: &Project,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id;
        let mut rows = card_body(theme).flex().flex_col().gap(px(8.0)).when(
            project.actions.is_empty(),
            |element| {
                element.child(
                    div()
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(tr!("projects.actions_empty")),
                )
            },
        );
        for (index, action) in project.actions.iter().enumerate() {
            let remove_id = SharedString::from(format!(
                "project-action-remove-{}-{index}",
                project_row_key(project_id)
            ));
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .w(px(96.0))
                            .flex_none()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(SharedString::from(action.name.clone())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_family("Mono")
                            .text_color(theme.text_secondary)
                            .child(SharedString::from(action.command.clone())),
                    )
                    .child(
                        div()
                            .id(remove_id)
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .w(px(22.0))
                            .h(px(22.0))
                            .rounded(px(6.0))
                            .cursor_default()
                            .hover(|element| element.bg(theme.overlay))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/block.svg", 12.0, theme.text_tertiary))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.remove_project_action(project_id, index, cx);
                            })),
                    ),
            );
        }

        rows = rows.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .pt(px(2.0))
                .child(
                    TextField::new("project-action-name", self.projects_action_name.clone())
                        .w(px(96.0)),
                )
                .child(
                    TextField::new(
                        "project-action-command",
                        self.projects_action_command.clone(),
                    )
                    .flex_1()
                    .min_w_0(),
                )
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "project-action-add-{}",
                            project_row_key(project_id)
                        )))
                        .tab_index(0)
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .h(px(26.0))
                        .px(px(8.0))
                        .rounded(px(8.0))
                        .cursor_default()
                        .hover(|element| element.bg(theme.overlay))
                        .flex()
                        .items_center()
                        .text_size(sp(12.5))
                        .text_color(theme.text_secondary)
                        .child(tr!("projects.action_add"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.add_project_action(project_id, cx);
                        })),
                ),
        );
        if self.projects_action_error {
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(sp(12.5))
                    .text_color(theme.warning)
                    .child(icon("icons/alert.svg", 13.0, theme.warning))
                    .child(tr!("projects.action_needs_command")),
            );
        }

        div()
            .child(settings_group_head(
                theme,
                tr!("projects.actions"),
                Vec::new(),
            ))
            .child(rows)
            .into_any_element()
    }

    // ── Removal ──────────────────────────────────────────────────────────────

    fn open_remove_project_dialog(&mut self, project_id: Uuid, cx: &mut Context<Self>) {
        let Some(project) = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
        else {
            return;
        };
        self.projects_remove_dialog = Some(RemoveProjectDialog {
            project_id,
            project_name: project.name.clone(),
            delete_history: false,
        });
        cx.notify();
    }

    fn confirm_remove_project(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.projects_remove_dialog.take() else {
            return;
        };
        let removed = dialog.project_id;
        self.projects_remove_dialog = None;
        // The selection falls to the removed row's neighbor before the
        // snapshot lands, so the rail never points at a vanished project.
        let ids: Vec<Uuid> = self
            .projects_rows_from("")
            .iter()
            .filter_map(|row| match row {
                ProjectsRow::Project { id, .. } => Some(*id),
            })
            .collect();
        self.projects_settings_selected =
            fallback_project_selection(&ids, removed, self.projects_settings_selected);
        self.sync_project_selection_ui(cx);
        let delete_history = dialog.delete_history;
        let daemon = self.daemon.client();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    daemon.request(
                        Uuid::nil(),
                        Uuid::nil(),
                        client::Command::RemoveProject {
                            project_id: removed,
                            delete_history,
                        },
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(client::ResponsePayload::TaskState {
                    projects,
                    mut sessions,
                    ..
                }) => {
                    for session in &mut sessions {
                        session.detail_loaded = false;
                    }
                    sessions.retain(|session| session.provider == ProviderKind::Tide);
                    this.apply_remote_task_state(
                        RemoteTaskStateSnapshot { projects, sessions },
                        cx,
                    );
                }
                Err(error) => {
                    this.show_toast(tr!("projects.remove_failed", error = error));
                }
                _ => {}
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn render_projects_remove_dialog(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let dialog = self.projects_remove_dialog.as_ref()?;
        let theme = Theme::current(cx);
        let delete_history = dialog.delete_history;
        let card = div()
            .id("projects-remove-card")
            .key_context(REMOVE_CONTEXT)
            .on_action(cx.listener(|this, _: &DismissRemoveProject, _, cx| {
                this.projects_remove_dialog = None;
                cx.notify();
            }))
            .tab_group()
            .tab_stop(false)
            .w_full()
            .max_w(px(420.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(20.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("projects.remove_title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!(
                                "projects.remove_body",
                                name = dialog.project_name.clone()
                            )),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(
                div()
                    .id("projects-remove-history")
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .px(px(20.0))
                    .py(px(12.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_default()
                    .hover(|element| element.bg(theme.overlay))
                    .child(
                        div()
                            .size(px(15.0))
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(if delete_history {
                                theme.border_strong
                            } else {
                                theme.border
                            })
                            .when(delete_history, |element| {
                                element
                                    .bg(theme.accent)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(icon("icons/check.svg", 11.0, rgb(0xFF_FF_FF).into()))
                            }),
                    )
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .child(tr!("projects.remove_history")),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(dialog) = this.projects_remove_dialog.as_mut() {
                            dialog.delete_history = !dialog.delete_history;
                            cx.notify();
                        }
                    })),
            )
            .child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(8.0))
                    .flex_none()
                    .child(
                        div()
                            .id("projects-remove-cancel")
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .h(px(28.0))
                            .px(px(12.0))
                            .rounded(px(8.0))
                            .cursor_default()
                            .hover(|element| element.bg(theme.sidebar_item_background))
                            .flex()
                            .items_center()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .child(tr!("projects.remove_cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.projects_remove_dialog = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("projects-remove-confirm")
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .h(px(28.0))
                            .px(px(12.0))
                            .rounded(px(8.0))
                            .cursor_default()
                            .bg(theme.danger)
                            .hover(|element| element.bg(theme.danger.opacity(0.85)))
                            .flex()
                            .items_center()
                            .text_size(sp(12.5))
                            .text_color(rgb(0xFF_FF_FF))
                            .child(tr!("projects.remove_confirm"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.confirm_remove_project(cx);
                            })),
                    ),
            );
        Some(
            div()
                .absolute()
                .size_full()
                .bg(gpui::hsla(0.0, 0.0, 0.0, 0.4))
                .flex()
                .items_start()
                .justify_center()
                .pt(px(120.0))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.projects_remove_dialog = None;
                        cx.notify();
                    }),
                )
                .child(card)
                .into_any_element(),
        )
    }

    fn render_project_general_card(
        &self,
        project: &Project,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id;
        let upload_failed = self.projects_icon_error == Some(project_id);
        let current_preset = match &project.icon {
            ProjectIcon::Preset(path) => Some(path.clone()),
            _ => None,
        };
        let auto_selected = matches!(project.icon, ProjectIcon::Auto);

        let mut swatches = div().flex().flex_wrap().items_center().gap(px(6.0));
        swatches = swatches.child(
            div()
                .id(SharedString::from(format!(
                    "project-icon-auto-{}",
                    project_row_key(project_id)
                )))
                .tab_index(0)
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .h(px(26.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .cursor_default()
                .when(auto_selected, |element| {
                    element.bg(theme.sidebar_item_background)
                })
                .when(!auto_selected, |element| {
                    element.hover(|element| element.bg(theme.overlay))
                })
                .flex()
                .items_center()
                .text_size(sp(12.5))
                .text_color(theme.text_secondary)
                .child(tr!("projects.icon_auto"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.set_project_icon(project_id, ProjectIcon::Auto, cx);
                })),
        );
        for preset in PRESET_ICONS {
            let selected = current_preset.as_deref() == Some(preset);
            swatches = swatches.child(
                div()
                    .id(SharedString::from(format!(
                        "project-icon-{}-{}",
                        project_row_key(project_id),
                        preset
                    )))
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .w(px(26.0))
                    .h(px(26.0))
                    .rounded(px(8.0))
                    .cursor_default()
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(selected, |element| {
                        element
                            .border_1()
                            .border_color(theme.accent)
                            .bg(theme.sidebar_item_background)
                    })
                    .when(!selected, |element| {
                        element.hover(|element| element.bg(theme.sidebar_item_background))
                    })
                    .child(icon(preset, 14.0, theme.text_secondary))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.set_project_icon(
                            project_id,
                            ProjectIcon::Preset(preset.to_owned()),
                            cx,
                        );
                    })),
            );
        }
        swatches = swatches.child(
            div()
                .id(SharedString::from(format!(
                    "project-icon-upload-{}",
                    project_row_key(project_id)
                )))
                .tab_index(0)
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .h(px(26.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .cursor_default()
                .hover(|element| element.bg(theme.overlay))
                .flex()
                .items_center()
                .gap(px(5.0))
                .text_size(sp(12.5))
                .text_color(theme.text_secondary)
                .child(icon("icons/cloud-upload.svg", 12.0, theme.text_secondary))
                .child(tr!("projects.icon_upload"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.start_icon_upload(project_id, cx);
                })),
        );

        let mut colors = div().flex().flex_wrap().items_center().gap(px(6.0));
        let color_selected = |hex: Option<&str>| project.icon_color.as_deref() == hex;
        let auto_color = color_selected(None);
        colors = colors.child(
            div()
                .id(SharedString::from(format!(
                    "project-color-auto-{}",
                    project_row_key(project_id)
                )))
                .tab_index(0)
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .w(px(18.0))
                .h(px(18.0))
                .rounded_full()
                .cursor_default()
                .bg(icon_tile_background(project))
                .when(auto_color, |element| {
                    element.border_1().border_color(theme.accent)
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.set_project_icon_color(project_id, None, cx);
                })),
        );
        for hex in ICON_COLORS {
            let selected = color_selected(Some(hex));
            let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
            colors = colors.child(
                div()
                    .id(SharedString::from(format!(
                        "project-color-{}-{hex}",
                        project_row_key(project_id)
                    )))
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .w(px(18.0))
                    .h(px(18.0))
                    .rounded_full()
                    .cursor_default()
                    .bg(rgb(value))
                    .when(selected, |element| {
                        element.border_1().border_color(theme.accent)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.set_project_icon_color(project_id, Some(hex.to_owned()), cx);
                    })),
            );
        }

        div()
            .child(settings_group_head(
                &theme,
                tr!("projects.section_general"),
                Vec::new(),
            ))
            .child(
                card_body(&theme)
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .when(upload_failed, |element| {
                        element.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .text_size(sp(12.5))
                                .text_color(theme.warning)
                                .child(icon("icons/alert.svg", 13.0, theme.warning))
                                .child(tr!("projects.icon_upload_failed")),
                        )
                    })
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("projects.icon")),
                    )
                    .child(swatches)
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("projects.icon_color")),
                    )
                    .child(colors),
            )
            .into_any_element()
    }
}

fn projects_detail_placeholder(theme: &Theme) -> Div {
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .child(icon("icons/folder.svg", 22.0, theme.text_ghost))
        .child(
            div()
                .text_size(sp(12.5))
                .text_color(theme.text_ghost)
                .child(tr!("projects.select_placeholder")),
        )
}

fn projects_status_row(theme: &Theme, message: String) -> Div {
    div()
        .px(px(18.0))
        .py(px(16.0))
        .text_size(sp(12.5))
        .text_color(theme.text_tertiary)
        .child(SharedString::from(message))
}

/// A project passes the filter when the query hits its name or its path;
/// an empty query matches everything. `query` arrives pre-lowercased.
fn project_matches_query(name: &str, path: &std::path::Path, query: &str) -> bool {
    query.is_empty()
        || name.to_lowercase().contains(query)
        || path.to_string_lossy().to_lowercase().contains(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_named(name: &str) -> Project {
        let mut project = Project::from_path(PathBuf::from("/tmp/tide"));
        project.name = name.to_owned();
        project
    }

    #[test]
    fn prune_old_uploads_keeps_only_the_named_file_for_the_project() {
        let dir = std::env::temp_dir().join(format!("tide-avatar-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = Uuid::new_v4();
        let keep = format!("{id}-99.png");
        let other_project = format!("{}-1.png", Uuid::new_v4());
        for name in [
            format!("{id}.png"),          // pre-fix layout
            format!("{id}-42.png"),       // prior upload
            format!("{id}-7.jpg"),        // prior upload, other ext
            "unrelated.png".to_owned(),   // stray files
            other_project.clone(),        // another project's icon
        ] {
            std::fs::write(dir.join(&name), b"x").unwrap();
        }
        std::fs::write(dir.join(&keep), b"x").unwrap();
        super::prune_old_uploads_in(&dir, id, &keep);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        let mut expected = vec!["unrelated.png".to_owned(), other_project, keep];
        expected.sort();
        assert_eq!(left, expected);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[gpui::test]
    fn uploaded_avatar_covers_the_rounded_tile(cx: &mut gpui::TestAppContext) {
        use gpui::{ImageSource, ObjectFit, RenderImage};

        let window = cx.add_empty_window();
        let wide = std::sync::Arc::new(RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::from_pixel(200, 100, image::Rgba([255, 0, 0, 255])),
        )]));
        window.draw(
            gpui::point(px(0.), px(0.)),
            gpui::size(px(100.), px(100.)),
            |_, _| {
                div()
                    .w(px(40.))
                    .h(px(40.))
                    .flex_none()
                    .rounded(px(9.6))
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .justify_center()
                    .debug_selector(|| "avatar-tile".to_string())
                    .child(
                        img(ImageSource::Render(wide))
                            .w(px(40.))
                            .h(px(40.))
                            .flex_none()
                            .rounded(px(9.6))
                            .object_fit(ObjectFit::Cover)
                            .debug_selector(|| "avatar-img".to_string()),
                    )
                    .into_any_element()
            },
        );
        let tile_bounds = window.debug_bounds("avatar-tile").expect("tile bounds");
        let img_bounds = window.debug_bounds("avatar-img").expect("img bounds");
        assert_eq!(tile_bounds.size, gpui::size(px(40.), px(40.)));
        // The image must lay out to exactly the tile — `ObjectFit::Cover` then
        // crops the wide source to it, so a non-square upload fills the
        // rounded container instead of letterboxing or overflowing.
        assert_eq!(img_bounds, tile_bounds);
    }

    #[test]
    fn project_rows_match_name_or_path_and_skip_projectless() {
        let ordinary = project_named("Tide");
        assert!(project_matches_query(&ordinary.name, &ordinary.path, "tid"));
        assert!(project_matches_query(
            &ordinary.name,
            &ordinary.path,
            "/tmp"
        ));
        assert!(!project_matches_query(
            &ordinary.name,
            &ordinary.path,
            "nomatch"
        ));
        assert!(project_matches_query(&ordinary.name, &ordinary.path, ""));
    }

    #[test]
    fn project_row_keys_are_stable_and_distinct() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        assert_eq!(project_row_key(a), project_row_key(a));
        assert_ne!(project_row_key(a), project_row_key(b));
    }

    #[test]
    fn auto_icon_falls_back_to_initials_and_a_stable_hue() {
        assert_eq!(auto_initials("foo bar"), "FB");
        assert_eq!(auto_initials("tide"), "T");
        assert_eq!(auto_initials("  spaced   out  "), "SO");
        assert_eq!(auto_hue("tide"), auto_hue("tide"));
        assert!((0.0..360.0).contains(&auto_hue("anything")));
        assert_eq!(WELL_KNOWN_ICONS[0], "icon.png");
        assert_eq!(WELL_KNOWN_ICONS.len(), 4);
    }

    #[test]
    fn removal_moves_the_selection_to_the_removed_rows_neighbor() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let c = Uuid::from_u128(3);
        let ids = vec![a, b, c];

        // Removing the first selects the next row.
        assert_eq!(fallback_project_selection(&ids, a, Some(a)), Some(b));
        // Removing the last falls back to the new last row.
        assert_eq!(fallback_project_selection(&ids, c, Some(c)), Some(b));
        // Removing the only row leaves nothing selected.
        assert_eq!(fallback_project_selection(&[a], a, Some(a)), None);
        // Removing something else keeps the current selection.
        assert_eq!(fallback_project_selection(&ids, b, Some(c)), Some(c));
    }

    #[test]
    fn project_actions_need_a_command_and_name_from_it() {
        assert_eq!(
            normalize_project_action("run".into(), "bun run dev"),
            Some(ProjectAction {
                name: "run".into(),
                command: "bun run dev".into(),
            })
        );
        // A blank name takes the command's first word.
        assert_eq!(
            normalize_project_action("  ".into(), "bun run dev"),
            Some(ProjectAction {
                name: "bun".into(),
                command: "bun run dev".into(),
            })
        );
        // Surrounding whitespace is trimmed on both fields.
        assert_eq!(
            normalize_project_action(" run ".into(), "  bun run dev  "),
            Some(ProjectAction {
                name: "run".into(),
                command: "bun run dev".into(),
            })
        );
        // No command, no action.
        assert_eq!(normalize_project_action("run".into(), "   "), None);
    }
}
