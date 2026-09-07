//! The Projects settings page: Tide's own projects presented as a mail-style
//! master–detail split — the project list on the left, the selected project's
//! configuration (identity, icon, default model, actions, git identity,
//! memory & RAG, removal) on the right.
//!
//! All project data is already in memory (`state.projects`); frames never
//! touch the filesystem.

use gpui::KeyBinding;

use super::composer::next_picker_highlight;

use super::*;

/// Key context the left pane declares around its search field.
const PROJECTS_PANE_CONTEXT: &str = "ProjectsPane";

/// The search field while focused inside the pane. The field keeps focus
/// while `up`/`down` walk the list selection, the same claim-from-under-it
/// arrangement the skills pane uses.
const PROJECTS_SEARCH_CONTEXT: &str = "ProjectsPane > TextInput";

const PROJECTS_LIST_WIDTH: f32 = 264.0;

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("down", SelectNextEntry, Some(PROJECTS_SEARCH_CONTEXT)),
        KeyBinding::new("up", SelectPreviousEntry, Some(PROJECTS_SEARCH_CONTEXT)),
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

    fn select_settings_project(&mut self, id: Uuid, cx: &mut Context<Self>) {
        self.projects_settings_selected = Some(id);
        // Each project's detail starts at its own top; a scroll position
        // carried over would land mid-panel.
        self.projects_detail_scroll
            .set_offset(gpui::Point::default());
        cx.notify();
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
                    .child(
                        div()
                            .w(px(26.0))
                            .h(px(26.0))
                            .flex_none()
                            .rounded(px(6.0))
                            .bg(theme.overlay)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/folder.svg", 13.0, theme.text_secondary)),
                    )
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
                                        project
                                            .path
                                            .file_name()
                                            .map(|name| name.to_string_lossy().into_owned())
                                            .unwrap_or_else(|| {
                                                project.path.to_string_lossy().into_owned()
                                            }),
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
    fn render_project_detail(
        &self,
        project: &Project,
        theme: &Theme,
        _cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .id("project-detail-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(project_detail_placeholder(project, theme))
            .into_any_element()
    }
}

fn project_detail_placeholder(project: &Project, theme: &Theme) -> Div {
    div()
        .px(px(24.0))
        .pt(px(22.0))
        .child(
            div()
                .text_size(sp(15.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text)
                .child(SharedString::from(project.name.clone())),
        )
        .child(
            div()
                .mt(px(2.0))
                .text_size(sp(12.5))
                .text_color(theme.text_tertiary)
                .child(SharedString::from(
                    project.path.to_string_lossy().into_owned(),
                )),
        )
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
        let mut project = Project::from_path(PathBuf::from("/tmp/waku"));
        project.name = name.to_owned();
        project
    }

    #[test]
    fn project_rows_match_name_or_path_and_skip_projectless() {
        let ordinary = project_named("Waku");
        assert!(project_matches_query(&ordinary.name, &ordinary.path, "wak"));
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
}
