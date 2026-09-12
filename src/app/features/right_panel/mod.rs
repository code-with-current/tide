//! The right panel: the tabbed surface shell — header, chooser, and card —
//! mounting the Files, Git, Browser, and Terminal surfaces.

use crate::app::PanelResizeTarget;
use crate::app::features::right_panel::tabs::TAB_SCROLL_FADE_WIDTH;
use crate::app::features::right_panel::tabs::{
    reusable_surface_index, right_panel_tab_icon, right_panel_tab_label, tab_scroll_reveal_guard,
};
use crate::app::single_line_label;
use crate::app::{RightPanelSurface, Tide};
use crate::theme::{Theme, sp};
use crate::ui::file_icon;
use crate::ui::menu::{ContextMenuHandle, MenuAlign, MenuItem, dropdown_menu};
use crate::ui::{icon, icon_button, tooltip::Tooltip};
use gpui::Focusable;
use gpui::prelude::*;
use gpui::{
    App, Context, Div, FontWeight, MouseButton, SharedString, Stateful, WeakEntity, Window, div, px,
};

mod browser;
pub(in crate::app) mod diff;
pub(in crate::app) mod files;
mod project_actions;
pub(in crate::app) mod state;
pub(in crate::app) mod tabs;
pub(in crate::app) mod terminal;

pub(in crate::app) fn worktree_badge(label: String, color: gpui::Hsla) -> Div {
    div()
        .h(px(16.0))
        .px(px(5.0))
        .rounded(px(4.0))
        .flex()
        .flex_none()
        .items_center()
        .bg(color.opacity(0.12))
        .text_size(sp(10.0))
        .text_color(color)
        .child(single_line_label(&label))
}

/// One bulk-action menu row: label, icon, and the wire op it dispatches.
pub(in crate::app) fn bulk_item(
    weak: &WeakEntity<Tide>,
    icon_path: &'static str,
    label: String,
    op: &'static str,
    busy: bool,
) -> MenuItem {
    let weak = weak.clone();
    MenuItem::new(label, move |_, cx| {
        let _ = weak.update(cx, |this, cx| this.run_git_panel_bulk_op(op, cx));
    })
    .icon(icon_path)
    .disabled(busy)
}

/// One remote-sync menu row: `op` is "fetch", "pull", or "pull-rebase".
pub(in crate::app) fn remote_item(
    weak: &WeakEntity<Tide>,
    icon_path: &'static str,
    label: String,
    op: &'static str,
    fetch: bool,
    rebase: bool,
    busy: bool,
) -> MenuItem {
    let weak = weak.clone();
    MenuItem::new(label, move |_, cx| {
        let _ = weak.update(cx, |this, cx| {
            this.run_git_panel_remote(op, fetch, rebase, cx)
        });
    })
    .icon(icon_path)
    .disabled(busy)
}

/// The changed-file row's context menu: the row actions that used to sit on
/// the hover icons, plus the file utilities. Rebuilt on every open, so the
/// items always reflect the section the row is in.

impl Tide {
    pub(in crate::app) fn render_right_panel(
        &mut self,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let active_terminal_id = self
            .active_right_panel_surface()
            .and_then(RightPanelSurface::terminal_id);
        if self.right_panel_pending_terminal_focus == active_terminal_id
            && let Some(terminal_id) = active_terminal_id
            && let Some(terminal) = self.right_panel_terminals.get(&terminal_id)
        {
            let focus_handle = terminal.read(cx).focus_handle(cx);
            window.focus(&focus_handle, cx);
            self.right_panel_pending_terminal_focus = None;
        }
        let body = match self.active_right_panel_surface().cloned() {
            None => self.render_right_panel_chooser(cx).into_any_element(),
            Some(RightPanelSurface::BackgroundWork { key, .. }) => self
                .render_background_work_surface(&key, cx)
                .into_any_element(),
            Some(RightPanelSurface::Agents) => self.render_right_panel_agents(cx),
            Some(RightPanelSurface::Files) => self
                .render_right_panel_files(width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Git) => self
                .render_right_panel_git(width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Terminal(terminal_id)) => self
                .right_panel_terminals
                .get(&terminal_id)
                .cloned()
                .inspect(|terminal| {
                    terminal.update(cx, |terminal, _| terminal.set_panel_width(width));
                })
                .map(IntoElement::into_any_element)
                .unwrap_or_else(|| {
                    self.render_right_panel_empty_message(
                        tr!("right_panel.terminal_unavailable"),
                        tr!("right_panel.terminal_unavailable_description"),
                        cx,
                    )
                    .into_any_element()
                }),
            Some(RightPanelSurface::File(path)) => self
                .render_right_panel_file(path, width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Browser(browser_id)) => {
                let browser = self.ensure_right_panel_browser(browser_id, window, cx);
                if self
                    .right_panel_pending_browser_focus
                    .take_if(|pending| *pending == browser_id)
                    .is_some()
                {
                    browser.update(cx, |view, cx| view.focus_default(window, cx));
                }
                browser.into_any_element()
            }
        };

        div()
            .id("right-panel")
            .w(px(width))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .min_w_0()
            .border_l_1()
            .border_color(theme.border_strong)
            .bg(theme.surface)
            .relative()
            .child(self.render_right_panel_header(window, cx))
            .child(body)
            .child(self.render_panel_resize_handle(
                "right-panel-resize-handle",
                PanelResizeTarget::RightPanel,
                cx,
            ))
    }

    pub(in crate::app) fn any_overlay_open(&self, cx: &App) -> bool {
        self.menus.borrow().values().any(ContextMenuHandle::is_open)
            || self.command_palette.is_open()
            || self.task_switcher.is_open()
            || self.commit_dialog.is_some()
            || self.image_preview.is_some()
            || self.composer.read(cx).context_menu_open(cx)
            || self
                .right_panel_browsers
                .values()
                .any(|browser| browser.read(cx).overlay_open(cx))
    }

    /// Once per frame, from the very top of the app's render: push down to
    /// every browser whether its native view belongs on screen. This is the
    /// single authority — tab switches, panel toggles, session switches, the
    /// settings page and overlay menus all funnel through here, so a webview
    /// can never linger over unrelated UI. The inline mermaid surfaces ride
    /// the same authority.
    pub(in crate::app) fn sync_browser_webviews(&mut self, cx: &mut Context<Self>) {
        if !self.right_panel_browsers.is_empty() {
            // With the scene overlay compositing GPUI's deferred draws above
            // native views, open menus never occlude the webview — the snapshot
            // swap is purely the fallback for a window where enabling it failed.
            let overlay_open = !self.scene_overlay_enabled && self.any_overlay_open(cx);
            // A webview composites above the GPUI scene, so the panel's clip does
            // not apply to it: shown mid-slide it would hang over the transcript
            // at full width. Keep it down until the panel has finished moving.
            let active_browser = if self.settings_page.is_none()
                && self.right_panel_visible
                && self.right_panel_slide.is_none()
            {
                self.active_right_panel_surface()
                    .and_then(RightPanelSurface::browser_id)
            } else {
                None
            };
            for (browser_id, browser) in &self.right_panel_browsers {
                let surface_visible = active_browser == Some(*browser_id);
                browser.update(cx, |view, cx| {
                    view.sync_native_state(surface_visible, overlay_open, cx);
                });
            }
        }
    }

    pub(in crate::app) fn render_right_panel_header(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let active_surface = self.right_panel_active_surface;
        let mut tabs = div()
            .id("right-panel-tabs")
            .h_full()
            .min_w_0()
            .flex_1()
            .flex()
            .items_center()
            .gap(px(4.0))
            .overflow_x_scroll()
            .track_scroll(&self.right_panel_tabs_scroll_handle);
        for (index, surface) in self.right_panel_surfaces.iter().cloned().enumerate() {
            let active = active_surface == Some(index);
            let dirty = self.right_panel_surface_is_dirty(&surface);
            let label = SharedString::from(match &surface {
                // Browser tabs read like browser tabs: the page title once
                // known, the address until then.
                RightPanelSurface::Browser(browser_id) => self
                    .right_panel_browsers
                    .get(browser_id)
                    .and_then(|browser| browser.read(cx).tab_label())
                    .unwrap_or_else(|| surface.label()),
                _ => {
                    right_panel_tab_label(&surface, self.right_panel_files_selected_path.as_deref())
                }
            });
            let icon_path =
                right_panel_tab_icon(&surface, self.right_panel_files_selected_path.as_deref());
            let uses_file_icon = matches!(&surface, RightPanelSurface::File(_))
                || matches!(&surface, RightPanelSurface::Files)
                    && self.right_panel_files_selected_path.is_some();
            let activate_weak = cx.entity().downgrade();
            let close_weak = cx.entity().downgrade();
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("right-panel-tab-{index}")))
                    .h(px(28.0))
                    .min_w(px(100.0))
                    .max_w(px(176.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .cursor_default()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .when(active, |element| element.bg(theme.overlay_strong))
                    .when(!active, |element| {
                        element.hover(|element| element.bg(theme.overlay))
                    })
                    .child(if uses_file_icon {
                        file_icon(icon_path, 13.0).into_any_element()
                    } else {
                        icon(icon_path, 13.0, theme.text_secondary).into_any_element()
                    })
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .text_color(if active {
                                theme.text
                            } else {
                                theme.text_secondary
                            })
                            .child(label),
                    )
                    .when(dirty, |element| {
                        element.child(
                            div()
                                .id(SharedString::from(format!("right-panel-tab-dirty-{index}")))
                                .size(px(7.0))
                                .flex_none()
                                .rounded_full()
                                .bg(theme.warning)
                                .tooltip(|window, cx| {
                                    Tooltip::new(tr!(
                                        "files.unsaved_changes",
                                        shortcut =
                                            crate::platform::primary_shortcut("⌘S", "Ctrl+S")
                                    ))
                                    .build(window, cx)
                                }),
                        )
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("close-right-panel-tab-{index}")))
                            .w(px(16.0))
                            .h(px(16.0))
                            .rounded(px(4.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .hover(|element| element.bg(theme.overlay_strong))
                            .child(icon("icons/x.svg", 10.0, theme.text_tertiary))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let _ = close_weak.update(cx, |this, cx| {
                                    this.close_right_panel_surface(index, cx);
                                });
                            }),
                    )
                    .on_click(move |_, _, cx| {
                        let _ = activate_weak.update(cx, |this, cx| {
                            this.right_panel_active_surface = Some(index);
                            this.reveal_right_panel_tab(index);
                            this.request_active_terminal_focus();
                            cx.notify();
                        });
                    }),
            );
        }
        tabs = tabs.child(div().w(px(TAB_SCROLL_FADE_WIDTH)).h(px(1.0)).flex_none());

        let mut header = div()
            .id("right-panel-header")
            .h(px(48.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.0))
            .pl(px(10.0))
            .pr(px(14.0))
            .child(
                div()
                    .relative()
                    .h_full()
                    .min_w_0()
                    .flex_1()
                    .overflow_hidden()
                    .child(tabs)
                    .when_some(self.right_panel_pending_tab_reveal, |element, tab_index| {
                        element.child(tab_scroll_reveal_guard(
                            self.right_panel_tabs_scroll_handle.clone(),
                            tab_index,
                            cx.entity().downgrade(),
                        ))
                    })
                    .child(crate::ui::scroll_fade::overlay(
                        self.right_panel_tabs_scroll_handle.clone(),
                        gpui::Axis::Horizontal,
                        crate::ui::scroll_fade::ScrollFadeSide::Start,
                        TAB_SCROLL_FADE_WIDTH,
                        theme.surface,
                    ))
                    .child(crate::ui::scroll_fade::overlay(
                        self.right_panel_tabs_scroll_handle.clone(),
                        gpui::Axis::Horizontal,
                        crate::ui::scroll_fade::ScrollFadeSide::End,
                        TAB_SCROLL_FADE_WIDTH,
                        theme.surface,
                    )),
            );

        if !self.right_panel_surfaces.is_empty() {
            let weak = cx.entity().downgrade();
            let existing_surfaces = self.right_panel_surfaces.clone();
            let options = [
                RightPanelSurface::new_browser(),
                RightPanelSurface::new_terminal(),
                RightPanelSurface::Files,
                RightPanelSurface::Agents,
                RightPanelSurface::Git,
            ];
            let handle = self.menu_handle("add-right-panel-surface", cx);
            header = header.child(
                div()
                    .flex_none()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(dropdown_menu(
                        icon_button("add-right-panel-surface", "icons/plus.svg", theme),
                        "add-right-panel-surface-menu",
                        &handle,
                        MenuAlign::BelowRight,
                        move |_| {
                            options
                                .clone()
                                .into_iter()
                                .map(|surface| {
                                    let weak = weak.clone();
                                    let open_surface = surface.clone();
                                    let already_open =
                                        reusable_surface_index(&existing_surfaces, &surface)
                                            .is_some();
                                    MenuItem::new(surface.label(), move |_, cx| {
                                        let _ = weak.update(cx, |this, cx| {
                                            this.open_right_panel_surface(open_surface.clone(), cx);
                                        });
                                    })
                                    .icon(surface.icon_path())
                                    .selected(already_open)
                                })
                                .collect()
                        },
                    )),
            );
        }

        self.window_drag_region(
            header.child(self.render_right_panel_toggle(cx)).children(
                self.render_client_window_controls(
                    crate::app::layouts::window::WindowControlSide::Right,
                    window,
                    cx,
                ),
            ),
            cx,
        )
    }

    pub(in crate::app) fn render_right_panel_chooser(
        &self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        div()
            .id("right-panel-chooser")
            .flex_1()
            .min_h_0()
            .flex()
            .items_center()
            .justify_center()
            .px(px(20.0))
            .pb(px(32.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(420.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(
                        div()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("right_panel.open_surface")),
                    )
                    .child(
                        div()
                            .mt(px(5.0))
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("right_panel.choose_surface")),
                    )
                    .child(
                        div()
                            .mt(px(18.0))
                            .w_full()
                            .flex()
                            .gap(px(8.0))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::new_browser(),
                                tr!("right_panel.browser_description"),
                                None,
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::new_terminal(),
                                tr!("right_panel.terminal_description"),
                                None,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .mt(px(8.0))
                            .w_full()
                            .flex()
                            .gap(px(8.0))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Files,
                                tr!("right_panel.files_description"),
                                None,
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Agents,
                                tr!("right_panel.agents_description"),
                                Some(self.selected_session_agents_count()),
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Git,
                                tr!("right_panel.git_description"),
                                None,
                                cx,
                            )),
                    ),
            )
    }

    pub(in crate::app) fn render_right_panel_card(
        &self,
        surface: RightPanelSurface,
        description: String,
        badge: Option<usize>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let icon_path = surface.icon_path();
        let label = surface.label();
        div()
            .id(SharedString::from(format!(
                "right-panel-card-{}",
                label.to_lowercase()
            )))
            .h(px(112.0))
            .flex_1()
            .min_w_0()
            .p(px(14.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.composer)
            .flex()
            .flex_col()
            .items_start()
            .cursor_default()
            .hover(|element| element.bg(theme.raised).border_color(theme.text_ghost))
            .active(|element| element.bg(theme.overlay_strong))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(icon(icon_path, 18.0, theme.text_secondary))
                    .when_some(badge.filter(|count| *count > 0), |row, count| {
                        row.child(
                            div()
                                .id(SharedString::from(format!(
                                    "right-panel-card-badge-{}",
                                    label.to_lowercase()
                                )))
                                .h(px(16.0))
                                .px(px(6.0))
                                .rounded_full()
                                .bg(theme.overlay_strong)
                                .flex()
                                .items_center()
                                .text_size(sp(10.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_secondary)
                                .child(SharedString::from(count.to_string())),
                        )
                    }),
            )
            .child(
                div()
                    .mt(px(12.0))
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(label),
            )
            .child(
                div()
                    .mt(px(4.0))
                    .text_size(sp(12.5))
                    .line_height(sp(15.0))
                    .text_color(theme.text_tertiary)
                    .whitespace_normal()
                    .line_clamp(2)
                    .text_overflow(gpui::TextOverflow::Truncate("...".into()))
                    .child(description),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_right_panel_surface(surface.clone(), cx);
            }))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::path::Path;
    use uuid::Uuid;

    use crate::model::{BackgroundWorkKey, BackgroundWorkKind};

    use crate::app::{DEFAULT_FILE_TREE_WIDTH, RightPanelSessionState, RightPanelSurface};
    use crate::review_diff::{ExpansionDirection, GapPosition};

    use super::diff::{
        diff_row_selection_key, review_diff_gap_directions, review_diff_gap_icon_path,
        review_diff_gap_tooltip,
    };
    use super::files::{
        TranscriptLinkRoute, file_highlighter_language, file_icon_for_name, normalized_path,
        transcript_link_route, visible_working_tree_entries,
    };
    use super::tabs::{
        TAB_SCROLL_FADE_WIDTH, reusable_surface_index, right_panel_tab_icon, right_panel_tab_label,
    };
    use super::terminal::scan_exposed_port;
    use crate::md::highlight::{Carry, Lang, TokenClass, lang_for_tag, tokenize_line};

    #[test]
    pub(in crate::app) fn transcript_file_links_route_by_the_active_workspace() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
        let project_file = workspace.join("src/app/right_panel.rs");
        let project_file_with_line = format!("{}:1596", project_file.display());
        let project_file_with_column = format!("{}:1596:8", project_file.display());
        let relative_project_file = Path::new("src")
            .join("app")
            .join("right_panel.rs")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            transcript_link_route(&project_file_with_line, Some(workspace)),
            TranscriptLinkRoute::ProjectFile(relative_project_file.clone())
        );
        assert_eq!(
            transcript_link_route(&project_file_with_column, Some(workspace)),
            TranscriptLinkRoute::ProjectFile(relative_project_file)
        );

        let encoded_file_url =
            url::Url::from_file_path(workspace.join("My File.rs")).expect("absolute file path");
        assert_eq!(
            transcript_link_route(&format!("{encoded_file_url}#L12C4"), Some(workspace)),
            TranscriptLinkRoute::ProjectFile("My File.rs".into())
        );

        let outside_file = workspace.join("../kero/src/app.rs");
        let outside_file_with_line = format!("{}:20", outside_file.display());
        assert_eq!(
            transcript_link_route(&outside_file_with_line, Some(workspace)),
            TranscriptLinkRoute::Finder(normalized_path(&outside_file))
        );
        assert_eq!(
            transcript_link_route("https://example.com/file.rs:12", Some(workspace)),
            TranscriptLinkRoute::External
        );
    }

    /// Selection resolves rows by key, so a repeated key makes a drag jump
    /// between the duplicates. Numbered rows keep their number-derived keys
    /// (stable across Review's gap expansion); rows a provider never
    /// positioned fall back to the row index.
    #[test]
    pub(in crate::app) fn diff_row_selection_keys_are_unique_even_without_line_numbers() {
        let positionless =
            crate::review_diff::from_file_changes(&[crate::model::ActivityFileChange {
                path: "a.md".into(),
                additions: Some(2),
                deletions: Some(0),
                status: None,
                diff: Some("@@\n+one\n+two\n \n+three\n".into()),
            }]);
        let keys = positionless
            .lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                matches!(
                    line.kind,
                    crate::review_diff::LineKind::Context
                        | crate::review_diff::LineKind::Addition
                        | crate::review_diff::LineKind::Deletion
                )
            })
            .map(|(index, line)| diff_row_selection_key("activity", line, index))
            .collect::<Vec<_>>();
        let unique = keys.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), keys.len(), "{keys:?}");

        let numbered = crate::review_diff::Line {
            file_index: 0,
            old_line: Some(4),
            new_line: Some(6),
            kind: crate::review_diff::LineKind::Context,
            content: "kept".into(),
            tokens: Vec::new(),
        };
        assert_eq!(
            diff_row_selection_key("review-diff", &numbered, 9),
            "review-diff-line-0-context-4-6",
        );
    }

    #[test]
    pub(in crate::app) fn review_gap_expansion_icons_match_pierre_visual_directions() {
        assert_eq!(
            review_diff_gap_directions(GapPosition::Leading, true),
            &[ExpansionDirection::End]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Trailing, true),
            &[ExpansionDirection::Start]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Between, false),
            &[ExpansionDirection::Both]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Between, true),
            &[ExpansionDirection::Start, ExpansionDirection::End]
        );

        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::Start),
            "icons/chevron-down.svg"
        );
        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::End),
            "icons/chevron-up.svg"
        );
        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::Both),
            "icons/chevrons-up-down.svg"
        );
    }

    #[test]
    pub(in crate::app) fn review_render_path_only_reads_the_in_memory_snapshot() {
        let source = include_str!("../git/panel_surface.rs");
        let start = source
            .find("\n    pub(in crate::app) fn render_git_file_diff_sub_view(")
            .expect("git diff render fn");
        let body = &source[start + 1..];
        let end = body
            .find("\n    pub(in crate::app) fn render_right_panel_empty_message(")
            .expect("git diff render end");
        let body = &body[..end];

        for forbidden in [
            "Command::new",
            "std::fs::",
            "review_diff::collect",
            "capture_worktree_commit",
        ] {
            assert!(
                !body.contains(forbidden),
                "Git diff rendering must not call `{forbidden}`; prepare it in the request tasks"
            );
        }
    }

    /// A wrapped diff line must grow its row rather than be clipped by it.
    /// Both the panel's own rows and the shared code row have to hold this,
    /// and the shared one is also what the transcript's diff paints with.
    #[test]
    pub(in crate::app) fn diff_text_rows_soft_wrap() {
        let panel_source = include_str!("../git/panel_surface.rs");
        let panel = panel_source
            .split_once("\n    pub(in crate::app) fn render_right_panel_diff_line(")
            .expect("review diff line renderer")
            .1
            .split_once("\n    #[allow(clippy::too_many_arguments)]")
            .expect("review diff line renderer end")
            .0;
        let shared_source = include_str!("diff.rs");
        let shared = shared_source
            .split_once("pub(in crate::app) fn render_diff_code_row(")
            .expect("shared diff code row")
            .1
            .split_once("\nfn review_diff_flat_text(")
            .expect("shared diff code row end")
            .0;

        for body in [panel, shared] {
            assert!(!body.contains(".whitespace_nowrap()"));
        }
        assert!(panel.matches(".whitespace_normal()").count() >= 2);
        assert!(shared.contains(".whitespace_normal()"));
        assert!(shared.contains(".min_h(px(style.row_height))"));
        assert!(!shared.contains(".h(px(style.row_height))"));
    }

    /// The render path must never reach the filesystem. This reads the source
    /// rather than the behaviour, because the cost of a regression here is a
    /// syscall per directory entry on every frame — invisible until a project
    /// is large or its volume is slow.
    #[test]
    pub(in crate::app) fn the_working_tree_render_path_does_no_filesystem_work() {
        let source = include_str!("files.rs");
        // Anchored on the definition's indentation so this test does not match
        // its own string literals.
        let start = source
            .find("\n    pub(in crate::app) fn render_right_panel_working_tree(")
            .expect("render fn");
        let body = &source[start + 1..];
        let end = body.find("\n    fn ").unwrap_or(body.len());
        let body = &body[..end];

        for forbidden in [
            "visible_working_tree_entries",
            "read_dir",
            "std::fs::",
            "metadata(",
        ] {
            assert!(
                !body.contains(forbidden),
                "render_right_panel_working_tree must not call `{forbidden}`; \
                 walk the tree in refresh_right_panel_working_tree instead"
            );
        }
    }

    /// Same guard for the file editor, which `render_right_panel_file` reaches
    /// on every frame that draws a file tab. Opening a large file used to read
    /// it inline, so the frame that revealed the tab paid for the whole file.
    #[test]
    pub(in crate::app) fn the_file_editor_render_path_does_no_filesystem_work() {
        let source = include_str!("files.rs");
        let start = source
            .find("\n    pub(in crate::app) fn ensure_right_panel_file_editor(")
            .expect("ensure fn");
        let body = &source[start + 1..];
        let end = body
            .find("\n    /// Reads a file into its editor")
            .unwrap_or(body.len());
        let body = &body[..end];

        for forbidden in ["read_right_panel_file(", "std::fs::", "metadata("] {
            assert!(
                !body.contains(forbidden),
                "ensure_right_panel_file_editor must not call `{forbidden}`; \
                 read the file in read_right_panel_file_into_editor instead"
            );
        }
    }

    #[test]
    pub(in crate::app) fn working_tree_only_descends_into_expanded_directories() {
        let root = std::env::temp_dir().join(format!("tide-working-tree-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "# Tide\n").unwrap();

        let collapsed = visible_working_tree_entries(&root, &HashSet::new());
        assert_eq!(
            collapsed
                .iter()
                .map(|entry| entry.relative_path.clone())
                .collect::<Vec<_>>(),
            vec!["src".to_owned(), "README.md".to_owned()]
        );

        let expanded = HashSet::from([root.join("src")]);
        let visible = visible_working_tree_entries(&root, &expanded);
        let nested = Path::new("src")
            .join("nested")
            .to_string_lossy()
            .into_owned();
        let main_rs = Path::new("src")
            .join("main.rs")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            visible
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.depth))
                .collect::<Vec<_>>(),
            vec![
                ("src".to_owned(), 0),
                (nested, 1),
                (main_rs, 1),
                ("README.md".to_owned(), 0)
            ]
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    pub(in crate::app) fn file_highlighter_language_follows_file_name_and_extension() {
        assert_eq!(file_highlighter_language("src/app.rs"), "rust");
        assert_eq!(file_highlighter_language("ui/panel.tsx"), "tsx");
        assert_eq!(file_highlighter_language("Sources/App.swift"), "swift");
        assert_eq!(file_highlighter_language("Makefile"), "make");
        assert_eq!(file_highlighter_language("src/native.hpp"), "cpp");
        assert_eq!(file_highlighter_language("LICENSE"), "text");

        for (path, expected_language) in [
            ("bun.lock", "json"),
            ("package-lock.json", "json"),
            ("deno.lock", "json"),
            ("composer.lock", "json"),
            ("Pipfile.lock", "json"),
            ("Package.resolved", "json"),
            ("Cargo.lock", "toml"),
            ("uv.lock", "toml"),
            ("poetry.lock", "toml"),
            ("pnpm-lock.yaml", "yaml"),
            ("yarn.lock", "yaml"),
            ("Podfile.lock", "yaml"),
            ("Gemfile.lock", "yaml"),
            ("mix.lock", "elixir"),
        ] {
            assert_eq!(file_highlighter_language(path), expected_language, "{path}");
        }
    }

    /// The editor colours code with the in-house lexer, so what matters is that
    /// the names `file_highlighter_language` produces are ones the lexer knows.
    /// The few it does not are listed here deliberately: they render as plain
    /// monospace rather than silently looking broken.
    #[test]
    pub(in crate::app) fn mapped_languages_resolve_in_the_in_house_lexer() {
        for (language, expected) in [
            ("rust", Some(Lang::Rust)),
            ("tsx", Some(Lang::Script)),
            ("swift", Some(Lang::Swift)),
            ("json", Some(Lang::Json)),
            ("toml", Some(Lang::Toml)),
            ("yaml", Some(Lang::Yaml)),
            ("make", Some(Lang::Shell)),
            ("cpp", Some(Lang::C)),
            ("markdown", Some(Lang::Markdown)),
            // Not yet lexed; these fall back to unhighlighted monospace.
            ("elixir", None),
            ("text", None),
        ] {
            assert_eq!(lang_for_tag(language), expected, "{language}");
        }
    }

    #[test]
    pub(in crate::app) fn the_editor_lexer_colours_code_it_recognises() {
        let line = r#"export function Card({ title }: { title: string }) {"#;
        let spans = tokenize_line(Lang::Script, line, Carry::None)
            .0
            .into_iter()
            .map(|token| (&line[token.range], token.class))
            .collect::<Vec<_>>();

        assert!(spans.contains(&("export", TokenClass::Keyword)));
        assert!(spans.contains(&("function", TokenClass::Keyword)));
        assert!(spans.contains(&("Card", TokenClass::Function)));
    }

    #[test]
    pub(in crate::app) fn working_tree_file_icons_follow_names_and_extensions() {
        assert_eq!(file_icon_for_name("main.rs"), "icons/file-types/rust.svg");
        assert_eq!(
            file_icon_for_name("Panel.tsx"),
            "icons/file-types/react.svg"
        );
        assert_eq!(
            file_icon_for_name("README.md"),
            "icons/file-types/readme.svg"
        );
        assert_eq!(
            file_icon_for_name("Dockerfile.dev"),
            "icons/file-types/docker.svg"
        );
        assert_eq!(file_icon_for_name("bun.lock"), "icons/file-types/bun.svg");
        assert_eq!(
            file_icon_for_name("pnpm-lock.yaml"),
            "icons/file-types/pnpm.svg"
        );
        assert_eq!(
            file_icon_for_name("vite.config.ts"),
            "icons/file-types/vite.svg"
        );
        assert_eq!(
            file_icon_for_name("unknown.data"),
            "icons/file-types/file.svg"
        );
    }

    #[test]
    pub(in crate::app) fn transcript_link_route_resolves_workspace_files_to_the_files_tab() {
        let workspace = std::path::Path::new("/ws");
        // An in-workspace absolute path opens the Files surface.
        assert!(matches!(
            transcript_link_route("/ws/src/a.rs", Some(workspace)),
            TranscriptLinkRoute::ProjectFile(relative) if relative == "src/a.rs"
        ));
        // Relative targets are NOT file links — mention pills must anchor
        // their targets to the workspace root or the click no-ops.
        assert!(matches!(
            transcript_link_route("src/a.rs", Some(workspace)),
            TranscriptLinkRoute::External
        ));
        // Outside the workspace routes to the file manager, not Files.
        assert!(matches!(
            transcript_link_route("/Users/x/.claude/skills/a/SKILL.md", Some(workspace)),
            TranscriptLinkRoute::Finder(_)
        ));
    }

    #[test]
    pub(in crate::app) fn files_tab_uses_the_selected_file_name_and_icon() {
        let files = RightPanelSurface::Files;
        assert_eq!(right_panel_tab_label(&files, None), "Files");
        assert_eq!(
            right_panel_tab_label(&files, Some("packages/desktop/bun.lock")),
            "bun.lock"
        );
        assert_eq!(
            right_panel_tab_icon(&files, Some("packages/desktop/bun.lock")),
            "icons/file-types/bun.svg"
        );

        let file = RightPanelSurface::File("src/main.rs".into());
        assert_eq!(right_panel_tab_label(&file, None), "main.rs");
        assert_eq!(
            right_panel_tab_icon(&file, None),
            "icons/file-types/rust.svg"
        );
    }

    #[test]
    pub(in crate::app) fn right_panel_tab_titles_stay_on_one_line() {
        let source = include_str!("mod.rs");
        let header = source
            .split_once("\n    pub(in crate::app) fn render_right_panel_header(")
            .expect("right panel header renderer")
            .1
            .split_once("\n    pub(in crate::app) fn render_right_panel_chooser(")
            .expect("right panel header renderer end")
            .0;

        assert!(header.contains(".truncate()"));
        assert!(!header.contains(".line_clamp(1)"));

        let background = RightPanelSurface::BackgroundWork {
            key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
            title: "node -e '\n  const value = 1'".into(),
        };
        assert_eq!(
            right_panel_tab_label(&background, None),
            "node -e ' const value = 1'"
        );
    }

    #[test]
    pub(in crate::app) fn only_reuses_single_instance_surface_tabs() {
        let browser = RightPanelSurface::new_browser();
        let terminal = RightPanelSurface::new_terminal();
        let background = RightPanelSurface::BackgroundWork {
            key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
            title: "Process one".into(),
        };
        let surfaces = vec![
            browser,
            terminal,
            background,
            RightPanelSurface::Files,
            RightPanelSurface::Agents,
            RightPanelSurface::Git,
        ];

        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::new_browser()),
            None
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::new_terminal()),
            None
        );
        assert_eq!(
            reusable_surface_index(
                &surfaces,
                &RightPanelSurface::BackgroundWork {
                    key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
                    title: "Renamed process".into(),
                },
            ),
            Some(2)
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Files),
            Some(3)
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Agents),
            Some(4),
            "the Agents tab is single-instance: reopening reuses it"
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Git),
            Some(5),
            "the Git tab is single-instance: reopening reuses it"
        );
    }

    #[test]
    pub(in crate::app) fn right_panel_state_isolated_by_session() {
        let session_with_terminal = Uuid::new_v4();
        let other_session = Uuid::new_v4();
        let terminal_id = Uuid::new_v4();
        let mut states = HashMap::new();
        let mut terminal_state = RightPanelSessionState::empty(true);
        terminal_state.surfaces = vec![RightPanelSurface::Terminal(terminal_id)];
        terminal_state.active_surface = Some(0);
        terminal_state.file_tree_width = 248.0;
        states.insert(session_with_terminal, terminal_state);

        let other_state = RightPanelSessionState::take_or_closed(&mut states, other_session);
        assert!(!other_state.visible);
        assert!(other_state.surfaces.is_empty());
        assert_eq!(other_state.active_surface, None);
        assert_eq!(other_state.file_tree_width, DEFAULT_FILE_TREE_WIDTH);

        let restored = RightPanelSessionState::take_or_closed(&mut states, session_with_terminal);
        assert!(restored.visible);
        assert_eq!(
            restored.surfaces,
            vec![RightPanelSurface::Terminal(terminal_id)]
        );
        assert_eq!(restored.active_surface, Some(0));
        assert_eq!(restored.file_tree_width, 248.0);
    }

    // The fade visibility and inset-clamp math live in `ui::scroll_fade`
    // and are covered by its own tests; this module only consumes them.
}

#[cfg(test)]
mod action_run_tests {

    use super::terminal::scan_exposed_port;

    #[test]
    pub(in crate::app) fn exposed_ports_are_scanned_from_run_output() {
        assert_eq!(
            scan_exposed_port("Local: http://localhost:5173/"),
            Some(5173)
        );
        // Servers colorize the URL; ANSI sequences must not break the scan.
        assert_eq!(
            scan_exposed_port("\x1b[32m➜ Local:\x1b[0m http://localhost:\x1b[4m5173\x1b[0m/"),
            Some(5173)
        );
        assert_eq!(scan_exposed_port("ready on 127.0.0.1:3000"), Some(3000));
        assert_eq!(scan_exposed_port("listening on 0.0.0.0:8080"), Some(8080));
        // Port 0 is never a real server.
        assert_eq!(scan_exposed_port("on localhost:0 now"), None);
        assert_eq!(scan_exposed_port("compiled successfully"), None);
        assert_eq!(scan_exposed_port(""), None);
    }
}
