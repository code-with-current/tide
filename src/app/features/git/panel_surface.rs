//! The Git panel surface as rendered inside the right panel: working tree,
//! history, branches, conflicts, commit detail, and the per-file diff
//! sub-view.

use crate::app::RightPanelSurface;
use crate::app::SettingsPage;
use crate::app::Tide;
use crate::app::features::git::GitChangesRow;
use crate::app::features::git::GitFileSection;
use crate::app::features::git::GitPanelTab;
use crate::app::features::git::HistoryActionStage;
use crate::app::features::git::branches::BranchPickerContext;
use crate::app::features::git::branches::BranchPickerSurface;
use crate::app::features::git::git_history;
use crate::app::features::git::git_history::{GRAPH_WIDTH, HISTORY_ROW_H};
use crate::app::features::right_panel::bulk_item;
use crate::app::features::right_panel::diff::DiffRowStyle;
use crate::app::features::right_panel::diff::GIT_BAR_H;
use crate::app::features::right_panel::diff::GIT_BAR_PAD_X;
use crate::app::features::right_panel::diff::absolute_commit_date;
use crate::app::features::right_panel::diff::commit_hue;
use crate::app::features::right_panel::diff::commit_initials;
use crate::app::features::right_panel::diff::file_status_color;
use crate::app::features::right_panel::diff::git_change_at;
use crate::app::features::right_panel::diff::git_conflict_at;
use crate::app::features::right_panel::diff::relative_commit_date;
use crate::app::features::right_panel::diff::render_diff_code_row;
use crate::app::features::right_panel::diff::render_history_action_button;
use crate::app::features::right_panel::diff::render_history_action_item;
use crate::app::features::right_panel::diff::review_diff_gap_directions;
use crate::app::features::right_panel::diff::review_diff_gap_icon_path;
use crate::app::features::right_panel::diff::review_diff_gap_tooltip;
use crate::app::features::right_panel::diff::static_chip;
use crate::app::features::right_panel::diff::strip_subject;
use crate::app::features::right_panel::files::{file_icon_for_path, file_menu_items};
use crate::app::features::right_panel::remote_item;
use crate::app::features::right_panel::worktree_badge;
use crate::app::single_line_label;
use crate::input::TextInput;
use crate::md;
use crate::model::CheckpointStatus;
use crate::model::compact_path;
use crate::query::Query;
use crate::review_diff::Snapshot as ReviewDiffSnapshot;
use crate::review_diff::Source as ReviewDiffSource;
use crate::theme::Theme;
use crate::theme::sp;
use crate::ui::ActivationExt;
use crate::ui::MenuChip;
use crate::ui::file_icon;
use crate::ui::icon;
use crate::ui::menu::ContextMenuHandle;
use crate::ui::menu::MenuAlign;
use crate::ui::menu::MenuItem;
use crate::ui::menu::context_menu;
use crate::ui::menu::dropdown_menu;
use crate::ui::menu::popover;
use crate::ui::motion;
use crate::ui::scrollbar;
use crate::ui::tooltip::Tooltip;
use gpui::AnyElement;
use gpui::App;
use gpui::ClipboardItem;
use gpui::Div;
use gpui::FontWeight;
use gpui::KeyDownEvent;
use gpui::MouseButton;
use gpui::SharedString;
use gpui::Stateful;
use gpui::Window;
use gpui::canvas;
use gpui::div;
use gpui::list;
use gpui::prelude::*;
use gpui::px;
use protocol::git_panel::PanelCommit;
use std::fs;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

impl Tide {
    pub(in crate::app) fn render_right_panel_unified_diff(
        &self,
        snapshot: Arc<ReviewDiffSnapshot>,
        escalate: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity().downgrade();
        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .relative()
            .flex()
            .flex_col()
            .child(md::render::frame_reset(
                self.git_panel_diff_selection.clone(),
            ))
            .child(
                list(
                    self.git_panel_diff_list_state.clone(),
                    move |index, _window, cx| {
                        entity
                            .upgrade()
                            .map(|entity| {
                                entity.update(cx, |this, cx| {
                                    this.render_right_panel_diff_line(
                                        &snapshot, index, escalate, cx,
                                    )
                                })
                            })
                            .unwrap_or_else(|| div().into_any_element())
                    },
                )
                .flex_1()
                .min_h_0(),
            )
            .child(scrollbar::vertical(
                &self.git_panel_diff_list_state,
                &self.git_panel_diff_scrollbar,
            ))
            .child(self.git_panel_diff_selection_input())
            .into_any_element()
    }

    pub(in crate::app) fn render_right_panel_diff_line(
        &self,
        snapshot: &ReviewDiffSnapshot,
        index: usize,
        escalate: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(line) = snapshot.lines.get(index) else {
            return div().into_any_element();
        };
        let Some(file) = snapshot.files.get(line.file_index) else {
            return div().into_any_element();
        };
        let theme = Theme::current(cx);
        let style = DiffRowStyle::review(self.state.code_font_size);
        // Chrome rows keep their gutters flush with the code rows'.
        let gutter_width = style.gutter_width();

        match &line.kind {
            crate::review_diff::LineKind::FileHeader => div()
                .id(SharedString::from(format!("review-diff-file-{index}")))
                .w_full()
                .min_w_0()
                .h(px(36.0))
                .px(px(12.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .child(file_icon(file_icon_for_path(&file.path), 14.0))
                .child(
                    div()
                        .id(SharedString::from(format!("review-diff-file-path-{index}")))
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .tooltip(Tooltip::text(file.path.clone()))
                        .child(file.path.clone()),
                )
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(theme.success)
                        .child(format!("+{}", file.additions)),
                )
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(theme.danger)
                        .child(format!("-{}", file.deletions)),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Gap(gap) => {
                // A selected-file diff's gaps hold no hidden rows: the label
                // escalates context by refetching instead of revealing here.
                let expandable = !escalate && gap.is_expandable();
                let chunked = gap.count() > crate::review_diff::DEFAULT_EXPANSION_LINE_COUNT as u32;
                let directions = review_diff_gap_directions(gap.position, chunked);
                let two_directions = directions.len() > 1;
                let gutter = div()
                    .w(px(gutter_width))
                    .h_full()
                    .flex_none()
                    .flex()
                    .when(two_directions, |gutter| gutter.flex_col())
                    .border_r_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .when(expandable, |mut gutter| {
                        for (button_index, direction) in directions.iter().copied().enumerate() {
                            gutter = gutter.child(self.render_right_panel_diff_gap_action(
                                index,
                                gap.id,
                                direction,
                                review_diff_gap_icon_path(direction),
                                review_diff_gap_tooltip(direction),
                                two_directions,
                                two_directions && button_index == 0,
                                cx,
                            ));
                        }
                        gutter
                    });
                let label_focus = self
                    .transcript_control_focus(format!("right-panel-diff-gap-{}-label", gap.id), cx);
                let label = div()
                    .id(SharedString::from(format!(
                        "right-panel-diff-gap-{}-label",
                        gap.id
                    )))
                    .track_focus(&label_focus)
                    .h_full()
                    .min_w_0()
                    .flex_1()
                    .px(px(12.0))
                    .flex()
                    .items_center()
                    .bg(theme.overlay)
                    .child(tr!("diff.unmodified_lines", count = gap.count()))
                    .when(expandable || escalate, |label| {
                        label
                            .tab_index(0)
                            .cursor_default()
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .hover(|style| {
                                style
                                    .bg(theme.overlay_strong)
                                    .text_color(theme.text_secondary)
                            })
                            .active(|style| style.bg(theme.overlay))
                            .tooltip(Tooltip::text(tr!("diff.expand_context")))
                            .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                                let direction = if event.modifiers().shift {
                                    crate::review_diff::ExpansionDirection::All
                                } else {
                                    crate::review_diff::ExpansionDirection::Both
                                };
                                this.expand_git_panel_diff_gap(index, direction, escalate, cx);
                                cx.stop_propagation();
                            }))
                            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    let direction = if event.keystroke.modifiers.shift {
                                        crate::review_diff::ExpansionDirection::All
                                    } else {
                                        crate::review_diff::ExpansionDirection::Both
                                    };
                                    this.expand_git_panel_diff_gap(index, direction, escalate, cx);
                                    cx.stop_propagation();
                                }
                            }))
                    });
                div()
                    .h(px(32.0))
                    .w_full()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .text_size(px(12.5))
                    .text_color(theme.text_tertiary)
                    .child(gutter)
                    .child(label)
                    .into_any_element()
            }
            crate::review_diff::LineKind::HunkHeader => div()
                .min_h(px(24.0))
                .w_full()
                .min_w_0()
                .flex()
                .items_stretch()
                .font_family(md::render::MONO_FAMILY)
                .text_size(px(12.5))
                .line_height(px(16.0))
                .text_color(theme.text_tertiary)
                .child(
                    div()
                        .w(px(gutter_width))
                        .min_h(px(24.0))
                        .self_stretch()
                        .flex_none()
                        .border_r_1()
                        .border_color(theme.border)
                        .bg(theme.overlay),
                )
                .child(
                    div()
                        .min_h(px(24.0))
                        .min_w_0()
                        .flex_1()
                        .px(px(12.0))
                        .py(px(4.0))
                        .flex()
                        .items_start()
                        .overflow_hidden()
                        .whitespace_normal()
                        .bg(theme.overlay)
                        .child(line.content.clone()),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Meta => div()
                .min_h(px(24.0))
                .w_full()
                .min_w_0()
                .flex()
                .items_stretch()
                .font_family(md::render::MONO_FAMILY)
                .text_size(px(12.5))
                .line_height(px(16.0))
                .text_color(theme.text_tertiary)
                .child(
                    div()
                        .w(px(gutter_width))
                        .min_h(px(24.0))
                        .self_stretch()
                        .flex_none(),
                )
                .child(
                    div()
                        .min_h(px(24.0))
                        .min_w_0()
                        .flex_1()
                        .py(px(4.0))
                        .overflow_hidden()
                        .whitespace_normal()
                        .pr(px(10.0))
                        .child(line.content.clone()),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Context
            | crate::review_diff::LineKind::Addition
            | crate::review_diff::LineKind::Deletion => render_diff_code_row(
                line,
                index,
                "review-diff",
                &self.git_panel_diff_selection,
                style,
                &theme,
            ),
        }
    }

    /// Route a gap expand to whichever model owns the visible list.
    pub(in crate::app) fn expand_git_panel_diff_gap(
        &mut self,
        line_index: usize,
        direction: crate::review_diff::ExpansionDirection,
        escalate: bool,
        cx: &mut Context<Self>,
    ) {
        if escalate {
            self.expand_selected_file_diff_context(line_index, cx);
        } else {
            self.expand_last_turn_review_gap(line_index, direction, cx);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::app) fn render_right_panel_diff_gap_action(
        &self,
        line_index: usize,
        gap_id: u64,
        direction: crate::review_diff::ExpansionDirection,
        icon_path: &'static str,
        tooltip: String,
        compact_half: bool,
        border_bottom: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let direction_name = match direction {
            crate::review_diff::ExpansionDirection::Start => "start",
            crate::review_diff::ExpansionDirection::End => "end",
            crate::review_diff::ExpansionDirection::Both => "both",
            crate::review_diff::ExpansionDirection::All => "all",
        };
        let focus = self.transcript_control_focus(
            format!("right-panel-diff-gap-{gap_id}-button-{direction_name}"),
            cx,
        );
        div()
            .id(SharedString::from(format!(
                "right-panel-diff-gap-{gap_id}-button-{direction_name}"
            )))
            .track_focus(&focus)
            .tab_index(0)
            .w_full()
            .h_full()
            .min_w_0()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .when(compact_half, |button| button.h(px(16.0)).flex_none())
            .when(border_bottom, |button| {
                button.border_b_1().border_color(theme.border)
            })
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay_strong))
            .active(|style| style.bg(theme.overlay))
            .tooltip(Tooltip::text(tooltip))
            .child(icon(icon_path, 11.0, theme.text_tertiary))
            .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                let direction = if event.modifiers().shift {
                    crate::review_diff::ExpansionDirection::All
                } else {
                    direction
                };
                this.expand_last_turn_review_gap(line_index, direction, cx);
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    let direction = if event.keystroke.modifiers.shift {
                        crate::review_diff::ExpansionDirection::All
                    } else {
                        direction
                    };
                    this.expand_last_turn_review_gap(line_index, direction, cx);
                    cx.stop_propagation();
                }
            }))
    }

    /// One listener set covers every selectable code line registered while
    /// the virtualized diff list paints this frame.
    pub(in crate::app) fn git_panel_diff_selection_input(&self) -> impl IntoElement {
        let selection = self.git_panel_diff_selection.clone();
        canvas(
            |_, _, _| (),
            move |_, _, window, _| md::render::install_selection_input(window, &selection, None),
        )
        .absolute()
        .w(px(0.0))
        .h(px(0.0))
    }

    /// The Git surface skeleton: the Changes/History tab switcher plus
    /// per-query placeholder bodies. The change list, history list, commit
    /// draft, and dialogs arrive with the rendering tasks of the port.
    pub(in crate::app) fn render_right_panel_git(
        &mut self,
        _width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Snapshot everything the body reads before the header borrows `cx`
        // for its click listeners.
        let tab = self.git_panel.tab;
        let error = self.git_panel.error.clone();
        let not_a_repository = matches!(
            &self.git_panel.branch_info,
            Query::Ready(info) if info.branch.is_none() && info.head_commit.is_none()
        );
        let branch = match &self.git_panel.branch_info {
            Query::Ready(info) => info.branch.clone(),
            _ => None,
        };

        let header = self.render_git_panel_tab_bar(branch, cx);

        let body = if let Some(error) = error {
            self.render_right_panel_empty_message(tr!("git_panel.error"), error, cx)
        } else if not_a_repository {
            self.render_right_panel_empty_message(
                tr!("git_panel.not_a_repository"),
                tr!("git_panel.not_a_repository_description"),
                cx,
            )
        } else {
            match tab {
                GitPanelTab::Changes => self.render_git_panel_changes(window, cx),
                GitPanelTab::History => self.render_git_panel_history(cx),
                GitPanelTab::Worktrees => self.render_git_panel_worktrees(cx),
            }
        };

        div()
            .id("right-panel-git")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .when(self.git_panel.stash_dialog_open, |panel| {
                panel.child(self.render_git_stash_dialog(cx))
            })
            .into_any_element()
    }

    /// Top section, first row: the Changes/History/Worktrees tab switcher,
    /// with the current branch as a quiet right-aligned label.
    pub(in crate::app) fn render_git_panel_tab_bar(
        &mut self,
        branch: Option<String>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let tab = self.git_panel.tab;
        let mut bar = div()
            .id("git-panel-tabs")
            .h(px(GIT_BAR_H))
            .flex_none()
            .px(px(GIT_BAR_PAD_X))
            .flex()
            .items_center()
            .gap(px(4.0))
            .border_b_1()
            .border_color(theme.border);
        for (candidate, key) in [
            (GitPanelTab::Changes, "git_panel.changes"),
            (GitPanelTab::History, "git_panel.history"),
            (GitPanelTab::Worktrees, "git_panel.worktrees"),
        ] {
            let active = tab == candidate;
            bar = bar.child(
                div()
                    .id(key)
                    .px(px(10.0))
                    .h(px(24.0))
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .text_size(sp(12.0))
                    .font_weight(if active {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .text_color(if active {
                        theme.text
                    } else {
                        theme.text_tertiary
                    })
                    .when(active, |element| element.bg(theme.overlay))
                    .hover(|element| element.bg(theme.overlay))
                    .cursor_pointer()
                    .child(tr!(key))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_git_panel_tab(candidate, cx);
                    })),
            );
        }
        if let Some(branch) = branch
            && !branch.is_empty()
        {
            bar = bar.child(
                div().flex_1().min_w_0().flex().justify_end().child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(sp(11.5))
                        .text_color(theme.text_tertiary)
                        .child(single_line_label(&branch)),
                ),
            );
        }
        bar
    }

    /// The stash viewer dialog — port of tide's "View Stash" dialog: the
    /// stash list with per-row Pop actions over a scrim, mounted on the
    /// git-dialogs deferred-scrim pattern. Pop closes the dialog and pops
    /// the top stash; the service's git2 behavior means a conflicting pop
    /// still reports `ok` (with markers in the worktree), so only real
    /// failures toast.
    pub(in crate::app) fn render_git_stash_dialog(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let stashes = match &self.git_panel.stashes {
            Query::Ready(stashes) => Some(stashes.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let busy = self.git_panel.busy.is_some();
        let count = stashes.as_ref().map_or(0, |stashes| stashes.len());

        let body: AnyElement = match stashes {
            None => div()
                .py(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .text_size(sp(12.5))
                .text_color(theme.text_tertiary)
                .child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    14.0,
                    theme.text_tertiary,
                )))
                .child(tr!("git_panel.loading"))
                .into_any_element(),
            Some(stashes) if stashes.is_empty() => div()
                .py(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(sp(12.5))
                .text_color(theme.text_tertiary)
                .child(tr!("git_panel.stash_empty"))
                .into_any_element(),
            Some(stashes) => {
                let mut list_div = div()
                    .id("git-stash-list")
                    .max_h(px(300.0))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col();
                for stash in stashes.iter() {
                    let message = if stash.message.is_empty() {
                        tr!("git_panel.stash_no_message")
                    } else {
                        stash.message.clone()
                    };
                    list_div = list_div.child(
                        div()
                            .px(px(20.0))
                            .py(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUITMonospaced")
                                    .text_size(sp(10.5))
                                    .text_color(theme.accent.opacity(0.8))
                                    .child(single_line_label(&stash.stash_ref)),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_secondary)
                                    .child(single_line_label(&message)),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "git-stash-pop-{}",
                                        stash.stash_ref
                                    )))
                                    .tab_index(0)
                                    .focus_visible(|style| {
                                        style.border_1().border_color(theme.accent)
                                    })
                                    .h(px(22.0))
                                    .px(px(8.0))
                                    .rounded(px(6.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .cursor_default()
                                    .text_size(sp(11.0))
                                    .text_color(if busy {
                                        theme.text_ghost
                                    } else {
                                        theme.text_secondary
                                    })
                                    .when(!busy, |button| {
                                        button.hover(|button| button.bg(theme.overlay))
                                    })
                                    .child(tr!("git_panel.pop"))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.pop_git_panel_stash(cx);
                                    }),
                            ),
                    );
                }
                list_div.into_any_element()
            }
        };

        let card = div()
            .id("git-stash-card")
            .key_context("GitStashDialog")
            .on_action(cx.listener(
                |this, _: &crate::app::features::git::DismissGitStash, _, cx| {
                    this.git_panel.stash_dialog_open = false;
                    cx.notify();
                },
            ))
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
                            .child(tr!("git_panel.stash_title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git_panel.stash_count", count = count)),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(body)
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
                    .flex_none()
                    .child(
                        div()
                            .id("git-stash-close")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(12.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .hover(|button| button.bg(theme.overlay))
                            .child(tr!("common.close"))
                            .on_activation(cx, |this, _, cx| {
                                this.git_panel.stash_dialog_open = false;
                                cx.notify();
                            }),
                    ),
            );
        crate::ui::modal::deferred_scrim("git-stash-layer", card, &theme)
    }

    // ── History tab ─────────────────────────────────────────────────────────

    /// The History tab: count + refresh header, column header, then the
    /// virtualized 24px commit rows with the lane graph painted behind
    /// their transparent 64px gutter.
    pub(in crate::app) fn render_git_panel_history(&mut self, cx: &mut Context<Self>) -> Div {
        if self.git_panel.commit_detail.is_some() {
            return self.render_git_commit_detail(cx);
        }
        let theme = Theme::current(cx);
        let log = match &self.git_panel.log {
            Query::Ready(log) => Some(log.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let graph = self.git_panel.history_graph.clone();
        let refreshing = self.git_panel.refresh_in_flight;

        let refresh_focus = self.transcript_control_focus("git-history-refresh", cx);
        let header = div()
            .h(px(26.0))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .child(
                div()
                    .text_size(sp(11.5))
                    .text_color(theme.text_tertiary)
                    .child(tr!(
                        "git_panel.history_count",
                        count = log.as_ref().map_or(0, |log| log.len())
                    )),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("git-history-refresh")
                    .track_focus(&refresh_focus)
                    .tab_index(0)
                    .size(px(22.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        "icons/refresh.svg",
                        12.0,
                        if refreshing {
                            theme.accent
                        } else {
                            theme.text_tertiary
                        },
                    ))
                    .tooltip(|window, cx| {
                        Tooltip::new(tr!("git_panel.refresh_history")).build(window, cx)
                    })
                    .on_activation(cx, |this, _, cx| {
                        this.refresh_git_panel(cx);
                    }),
            );

        let column_header = div()
            .h(px(20.0))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(sp(10.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text_ghost)
            .child(div().w(px(GRAPH_WIDTH)).flex_none())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(single_line_label(&tr!("git_panel.column_subject"))),
            )
            .child(
                div()
                    .flex_none()
                    .child(single_line_label(&tr!("git_panel.column_date"))),
            )
            .child(
                div()
                    .w(px(112.0))
                    .flex_none()
                    .flex()
                    .justify_end()
                    .child(single_line_label(&tr!("git_panel.column_author"))),
            );

        let body = if log.is_none() {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        } else if log.as_ref().is_some_and(|log| log.is_empty()) {
            self.render_right_panel_empty_message(
                tr!("git_panel.no_commits"),
                tr!("git_panel.no_commits_description"),
                cx,
            )
            .into_any_element()
        } else {
            let entity = cx.entity().downgrade();
            let list_state = self.git_panel_history_list_state.clone();
            let graph_layer = div()
                .id("git-history-graph")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .when_some(graph, |layer, graph| {
                    layer.child(git_history::graph_column(graph, list_state.clone(), &theme))
                })
                .into_any_element();
            div()
                .id("git-history-rows")
                .flex_1()
                .min_h_0()
                .min_w_0()
                .relative()
                .child(graph_layer)
                .child(
                    list(
                        self.git_panel_history_list_state.clone(),
                        move |index, _w, cx| {
                            entity
                                .upgrade()
                                .map(|entity| {
                                    entity.update(cx, |this, cx| {
                                        this.render_git_history_row(index, cx)
                                    })
                                })
                                .unwrap_or_else(|| div().into_any_element())
                        },
                    )
                    .size_full(),
                )
                .child(scrollbar::vertical(
                    &self.git_panel_history_list_state,
                    &self.git_panel_history_scrollbar,
                ))
                .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(column_header)
            .child(body)
    }

    /// One 24px History row: transparent 64px graph gutter, then branch/tag
    /// chips + subject, relative date, and the initials avatar + author.
    /// Click/enter opens the commit details; the "…" button opens actions.
    pub(in crate::app) fn render_git_history_row(
        &self,
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(commit) = matches!(&self.git_panel.log, Query::Ready(log) if log.len() > index)
            .then(|| match &self.git_panel.log {
                Query::Ready(log) => log[index].clone(),
                _ => unreachable!(),
            })
        else {
            return div().h(px(HISTORY_ROW_H)).into_any_element();
        };
        let lane = self
            .git_panel
            .history_graph
            .as_ref()
            .map(|graph| graph.lane_at(index))
            .unwrap_or(0);
        let lane_color = git_history::lane_color(&theme, lane);
        let active = self
            .git_panel
            .commit_detail
            .as_ref()
            .is_some_and(|detail| detail.sha == commit.sha);
        let sha = commit.sha.clone();

        let row_focus = self.transcript_control_focus(format!("git-history-row-{sha}"), cx);
        let mut subject_row = div().flex().min_w_0().flex_1().items_center().gap(px(3.0));
        let has_chips = !commit.branch_heads.is_empty() || !commit.tags.is_empty();
        if has_chips {
            for (position, name) in commit.branch_heads.iter().enumerate() {
                let head_branch = commit.is_head && position == 0;
                subject_row = subject_row.child(
                    div()
                        .max_w(px(112.0))
                        .flex_none()
                        .h(px(16.0))
                        .px(px(1.0))
                        .rounded(px(3.0))
                        .border_1()
                        .border_color(lane_color.opacity(0.7))
                        .bg(if head_branch {
                            theme.accent.opacity(0.15)
                        } else {
                            theme.overlay
                        })
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .pr(px(4.0))
                        .id(SharedString::from(format!(
                            "git-history-branch-chip-{name}"
                        )))
                        .tooltip(Tooltip::text(name.clone()))
                        .child(
                            div()
                                .flex_none()
                                .size(px(14.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon(
                                    "icons/git-branch.svg",
                                    10.0,
                                    if theme.is_dark {
                                        gpui::black()
                                    } else {
                                        gpui::white()
                                    },
                                ))
                                .when(true, |chip| chip.bg(lane_color)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(".SystemUIFontMonospaced")
                                .text_size(sp(10.0))
                                .text_color(if head_branch {
                                    theme.accent
                                } else {
                                    theme.text_secondary
                                })
                                .child(name.clone()),
                        ),
                );
            }
            for tag in &commit.tags {
                subject_row = subject_row.child(
                    div()
                        .max_w(px(96.0))
                        .flex_none()
                        .h(px(16.0))
                        .px(px(4.0))
                        .rounded(px(3.0))
                        .bg(theme.warning.opacity(0.15))
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .id(SharedString::from(format!("git-history-tag-chip-{tag}")))
                        .tooltip(Tooltip::text(format!("tag {tag}")))
                        .child(icon("icons/star.svg", 9.0, theme.warning))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(".SystemUIFontMonospaced")
                                .text_size(sp(10.0))
                                .text_color(theme.warning)
                                .child(tag.clone()),
                        ),
                );
            }
        }
        subject_row = subject_row.child(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_size(sp(11.5))
                .text_color(theme.text.opacity(0.9))
                .child(single_line_label(&commit.subject)),
        );

        let hue = commit_hue(&commit.sha);
        let initials = commit_initials(&commit.author);
        let author_cell = div()
            .w(px(112.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .overflow_hidden()
            .child(
                div()
                    .size(px(14.0))
                    .flex_none()
                    .rounded_full()
                    .bg(gpui::hsla(hue, 0.4, 0.42, 1.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(sp(8.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(gpui::white())
                    .id(SharedString::from(format!("git-history-avatar-{sha}")))
                    .tooltip(Tooltip::text(commit.author.clone()))
                    .child(initials),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(10.0))
                    .text_color(theme.text_tertiary)
                    .child(single_line_label(&commit.author)),
            );

        let date_cell = div()
            .flex_none()
            .text_size(sp(10.0))
            .text_color(theme.text_ghost)
            .id(SharedString::from(format!("git-history-date-{sha}")))
            .tooltip(Tooltip::text(absolute_commit_date(&commit.date)))
            .child(relative_commit_date(&commit.date));

        // The actions popover: one handle per commit, created lazily like
        // the row focus. Opening records the sha so the card knows whose
        // actions it carries.
        let handle = {
            let sha = sha.clone();
            let weak = cx.entity().downgrade();
            self.menu_handle_with(
                SharedString::from(format!("git-history-action-{sha}")),
                cx,
                move |open, _window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        if open {
                            this.git_panel.history_action =
                                Some(crate::app::features::git::HistoryRowAction {
                                    sha: sha.clone(),
                                    stage: HistoryActionStage::Menu,
                                    branch_input: None,
                                });
                        } else {
                            this.git_panel.history_action = None;
                        }
                        cx.notify();
                    });
                },
            )
        };
        let weak = cx.entity().downgrade();
        let actions_card = Rc::new(
            move |handle: &ContextMenuHandle, window: &mut Window, cx: &mut App| {
                weak.upgrade()
                    .map(|entity| {
                        entity.update(cx, |this, cx| {
                            this.render_git_history_action_card(handle, window, cx)
                        })
                    })
                    .unwrap_or_else(|| div().into_any_element())
            },
        );
        let actions = popover(
            div()
                .id(SharedString::from(format!("git-history-action-{sha}")))
                .size(px(18.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .child(icon("icons/ellipsis.svg", 13.0, theme.text_ghost)),
            &handle,
            MenuAlign::BelowRight,
            move |handle, window, cx| actions_card(handle, window, cx),
        );

        let open_sha = sha.clone();
        div()
            .id(SharedString::from(format!("git-history-{sha}")))
            .track_focus(&row_focus)
            .tab_index(0)
            .w_full()
            .h(px(HISTORY_ROW_H))
            .flex()
            .items_center()
            .min_w_0()
            .cursor_default()
            .when(active, |row| row.bg(theme.accent.opacity(0.08)))
            .focus_visible(|row| row.bg(theme.accent.opacity(0.10)))
            .on_activation(cx, move |this, _, cx| {
                this.open_git_commit_detail(open_sha.clone(), cx);
            })
            .child(div().w(px(GRAPH_WIDTH)).flex_none().h_full())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .pr(px(8.0))
                    .hover(|row| {
                        if active {
                            row
                        } else {
                            row.bg(theme.overlay.opacity(0.6))
                        }
                    })
                    .child(subject_row)
                    .child(date_cell)
                    .child(author_cell)
                    .child(actions),
            )
            .into_any_element()
    }

    /// The "…" card: the actions menu, the armed revert confirmation, or
    /// the branch-from-here input, per the open stage.
    pub(in crate::app) fn render_git_history_action_card(
        &mut self,
        handle: &ContextMenuHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(action) = self.git_panel.history_action.clone() else {
            return div().into_any_element();
        };
        // The branch-name input materializes here (the profile-dialog
        // pattern): `TextInput::new` needs a window, which the card has.
        let branch_input = match (&action.stage, &action.branch_input) {
            (HistoryActionStage::Branch, Some(input)) => Some(input.clone()),
            (HistoryActionStage::Branch, None) => {
                let input = cx.new(|cx| {
                    TextInput::new(window, cx).placeholder(tr!("git_panel.branch_name_placeholder"))
                });
                if let Some(action) = self.git_panel.history_action.as_mut() {
                    action.branch_input = Some(input.clone());
                }
                Some(input)
            }
            _ => None,
        };
        let sha = action.sha.clone();
        let subject = match &self.git_panel.log {
            Query::Ready(log) => log
                .iter()
                .find(|commit| commit.sha == sha)
                .map(|commit| commit.subject.clone())
                .unwrap_or_default(),
            Query::Pending | Query::Missing(_) => String::new(),
        };

        let mut card = div()
            .id("git-history-action-card")
            .w(px(236.0))
            .p(px(8.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.raised)
            .shadow_lg()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(10.5))
                    .text_color(theme.text_ghost)
                    .child(format!("{sha} · {subject}")),
            );

        match action.stage {
            HistoryActionStage::Menu => {
                let checkout_handle = handle.clone();
                let checkout_sha = sha.clone();
                let copy_handle = handle.clone();
                let copy_sha = sha.clone();
                card = card
                    .child(render_history_action_item(
                        "git-history-action-branch",
                        "icons/git-branch.svg",
                        tr!("git_panel.branch_from_here"),
                        false,
                        self.transcript_control_focus("git-history-action-branch", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.set_history_action_stage(HistoryActionStage::Branch, window, cx);
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-checkout",
                        "icons/corner-down-right.svg",
                        tr!("git_panel.checkout_detached"),
                        false,
                        self.transcript_control_focus("git-history-action-checkout", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.close_history_row_action(cx);
                            checkout_handle.close(window, cx);
                            this.run_git_history_checkout(
                                false,
                                checkout_sha.clone(),
                                Some(checkout_sha.clone()),
                                cx,
                            );
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-copy",
                        "icons/copy.svg",
                        tr!("git_panel.copy_sha"),
                        false,
                        self.transcript_control_focus("git-history-action-copy", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.close_history_row_action(cx);
                            copy_handle.close(window, cx);
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_sha.clone()));
                            this.show_toast(tr!("git_panel.sha_copied"));
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-revert",
                        "icons/rotate-cw.svg",
                        tr!("git_panel.revert_commit"),
                        true,
                        self.transcript_control_focus("git-history-action-revert", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.set_history_action_stage(HistoryActionStage::Revert, window, cx);
                        },
                    ));
            }
            HistoryActionStage::Revert => {
                let cancel_handle = handle.clone();
                let confirm_handle = handle.clone();
                let confirm_sha = sha.clone();
                card = card
                    .child(
                        div()
                            .px(px(6.0))
                            .pt(px(6.0))
                            .pb(px(2.0))
                            .text_size(sp(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git_panel.revert_title")),
                    )
                    .child(
                        div()
                            .px(px(6.0))
                            .pb(px(6.0))
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git_panel.revert_description", sha = sha.clone())),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.0))
                            .pt(px(2.0))
                            .child(render_history_action_button(
                                "git-history-revert-cancel",
                                tr!("common.cancel"),
                                false,
                                self.transcript_control_focus("git-history-revert-cancel", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    cancel_handle.close(window, cx);
                                },
                            ))
                            .child(render_history_action_button(
                                "git-history-revert-confirm",
                                tr!("git_panel.revert_confirm"),
                                true,
                                self.transcript_control_focus("git-history-revert-confirm", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    confirm_handle.close(window, cx);
                                    this.run_git_panel_revert(confirm_sha.clone(), cx);
                                },
                            )),
                    );
            }
            HistoryActionStage::Branch => {
                let cancel_handle = handle.clone();
                let confirm_handle = handle.clone();
                card = card
                    .child(
                        div()
                            .px(px(6.0))
                            .pt(px(6.0))
                            .pb(px(4.0))
                            .text_size(sp(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git_panel.branch_from_title", sha = sha.clone())),
                    )
                    .child(
                        div()
                            .px(px(6.0))
                            .pb(px(6.0))
                            .when_some(branch_input, |field, input| field.child(input)),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.0))
                            .pt(px(2.0))
                            .child(render_history_action_button(
                                "git-history-branch-cancel",
                                tr!("common.cancel"),
                                false,
                                self.transcript_control_focus("git-history-branch-cancel", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    cancel_handle.close(window, cx);
                                },
                            ))
                            .child(render_history_action_button(
                                "git-history-branch-confirm",
                                tr!("git_panel.branch_create_and_switch"),
                                true,
                                self.transcript_control_focus("git-history-branch-confirm", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    confirm_handle.close(window, cx);
                                    this.submit_history_branch(cx);
                                },
                            )),
                    );
            }
        }
        card.into_any_element()
    }

    /// The commit-details sub-view: back header with sha + tags, then the
    /// subject/body, author row, clickable parents, and the changed-file
    /// list with inline per-file diffs — port of tide's
    /// `CommitDetailsPanel`.
    pub(in crate::app) fn render_git_commit_detail(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(detail) = self.git_panel.commit_detail.as_ref() else {
            return div();
        };
        let commit: Option<PanelCommit> = match &self.git_panel.log {
            Query::Ready(log) => log.iter().find(|c| c.sha == detail.sha).cloned(),
            Query::Pending | Query::Missing(_) => None,
        };
        let detail_sha = detail.sha.clone();
        let message = match &detail.message {
            Query::Ready(message) => Some(message.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let files = match &detail.files {
            Query::Ready(files) => Some(files.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let file_diff_path = detail.file_diff.as_ref().map(|diff| diff.path.clone());
        let file_diff_snapshot = detail
            .file_diff
            .as_ref()
            .and_then(|diff| diff.snapshot.clone());
        let file_diff_loading = detail.file_diff.as_ref().is_some_and(|diff| {
            matches!(diff.hunks, Query::Pending | Query::Missing(_)) && diff.snapshot.is_none()
        });

        let back_focus = self.transcript_control_focus("git-commit-detail-back", cx);
        let header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-commit-detail-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_git_commit_detail(cx);
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(12.0))
                    .text_color(theme.text_secondary)
                    .child(detail_sha.clone()),
            )
            .when_some(commit.clone(), |header: Div, commit: PanelCommit| {
                header.child(div().flex().flex_none().items_center().gap(px(3.0)).when(
                    !commit.tags.is_empty(),
                    |tags| {
                        tags.children(commit.tags.iter().take(3).map(|tag| {
                            div()
                                .h(px(16.0))
                                .px(px(4.0))
                                .rounded(px(3.0))
                                .bg(theme.warning.opacity(0.15))
                                .flex()
                                .items_center()
                                .gap(px(3.0))
                                .id(SharedString::from(format!("git-commit-detail-tag-{tag}")))
                                .tooltip(Tooltip::text(format!("tag {tag}")))
                                .child(icon("icons/star.svg", 9.0, theme.warning))
                                .child(
                                    div()
                                        .font_family(".SystemUIFontMonospaced")
                                        .text_size(sp(10.0))
                                        .text_color(theme.warning)
                                        .child(tag.clone()),
                                )
                        }))
                    },
                ))
            });

        // Body: metadata first, then the changed files with inline diffs.
        let mut body = div()
            .id("git-commit-detail-body")
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .when_some(commit.clone(), |body: Stateful<Div>, commit: PanelCommit| {
                let hue = commit_hue(&commit.sha);
                body.child(
                    div()
                        .px(px(12.0))
                        .pt(px(10.0))
                        .pb(px(6.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .border_b_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(commit.subject.clone()),
                        )
                        .when_some(message.clone(), |block, message| {
                            let body_text = strip_subject(&message, &commit.subject);
                            block.when(!body_text.is_empty(), |block| {
                                block.child(
                                    div()
                                        .text_size(sp(11.5))
                                        .text_color(theme.text_secondary)
                                        .child(body_text),
                                )
                            })
                        })
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(5.0))
                                .min_w_0()
                                .child(
                                    div()
                                        .size(px(16.0))
                                        .flex_none()
                                        .rounded_full()
                                        .bg(gpui::hsla(hue, 0.4, 0.42, 1.0))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(sp(8.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(gpui::white())
                                        .id("git-commit-detail-avatar")
                                        .child(commit_initials(&commit.author)),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(sp(11.0))
                                        .text_color(theme.text_secondary)
                                        .child(commit.author.clone()),
                                )
                                .child(
                                    div().text_color(theme.text_ghost).child("·"),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(sp(11.0))
                                        .text_color(theme.text_tertiary)
                                        .id("git-commit-detail-date")
                                        .tooltip(Tooltip::text(absolute_commit_date(
                                            &commit.date,
                                        )))
                                        .child(relative_commit_date(&commit.date)),
                                ),
                        )
                        .when(!commit.parents.is_empty(), |block| {
                            block.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.0))
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.5))
                                    .text_color(theme.text_ghost)
                                    .child(icon(
                                        if commit.parents.len() > 1 {
                                            "icons/git-fork.svg"
                                        } else {
                                            "icons/git-commit-horizontal.svg"
                                        },
                                        12.0,
                                        theme.text_ghost,
                                    ))
                                    .children(commit.parents.iter().enumerate().map(
                                        |(position, parent)| {
                                            let known = matches!(&self.git_panel.log, Query::Ready(log) if log.iter().any(|c| c.sha == *parent));
                                            let parent = parent.clone();
                                            let focus = self.transcript_control_focus(
                                                format!("git-commit-parent-{parent}"),
                                                cx,
                                            );
                                            div()
                                                .id(SharedString::from(format!(
                                                    "git-commit-parent-{parent}"
                                                )))
                                                .track_focus(&focus)
                                                .tab_index(if known { 0 } else { -1 })
                                                .px(px(3.0))
                                                .rounded(px(4.0))
                                                .cursor_default()
                                                .text_color(if known {
                                                    theme.accent.opacity(0.8)
                                                } else {
                                                    theme.text_ghost
                                                })
                                                .focus_visible(|style| {
                                                    style.bg(theme.accent.opacity(0.1))
                                                })
                                                .hover(|style| {
                                                    if known {
                                                        style.bg(theme.accent.opacity(0.1))
                                                    } else {
                                                        style
                                                    }
                                                })
                                                .tooltip(Tooltip::text(if known {
                                                    tr!("git_panel.go_to_commit", sha = parent.clone())
                                                } else {
                                                    tr!(
                                                        "git_panel.parent_outside_history",
                                                        sha = parent.clone()
                                                    )
                                                }))
                                                .when(position > 0, |chip| chip.child("+"))
                                                .child(parent.clone())
                                                .on_activation(
                                                    cx,
                                                    move |this, _, cx| {
                                                        this.select_git_commit(
                                                            parent.clone(),
                                                            cx,
                                                        );
                                                    },
                                                )
                                        },
                                    )),
                            )
                        }),
                )
            });

        match files {
            None => {
                body = body.child(
                    div()
                        .px(px(12.0))
                        .py(px(10.0))
                        .text_size(sp(11.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("git_panel.loading")),
                );
            }
            Some(files) if files.is_empty() => {}
            Some(files) => {
                let mut section = div().flex().flex_col();
                for file in files.iter() {
                    let path = file.path.clone();
                    let expanded = file_diff_path.as_deref() == Some(file.path.as_str());
                    let focus =
                        self.transcript_control_focus(format!("git-commit-file-{}", file.path), cx);
                    let basename = file
                        .path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&file.path)
                        .to_owned();
                    let directory = file
                        .path
                        .strip_suffix(&basename)
                        .unwrap_or_default()
                        .to_owned();
                    section = section.child(
                        div()
                            .id(SharedString::from(format!("git-commit-file-{}", file.path)))
                            .track_focus(&focus)
                            .tab_index(0)
                            .w_full()
                            .min_h(px(26.0))
                            .px(px(12.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .cursor_default()
                            .focus_visible(|style| style.bg(theme.overlay))
                            .hover(|style| style.bg(theme.overlay))
                            .on_activation(cx, move |this, _, cx| {
                                this.toggle_git_commit_file_diff(path.clone(), cx);
                            })
                            .child(div().flex_none().w(px(8.0)).flex().justify_center().child(
                                icon(
                                    if expanded {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    },
                                    11.0,
                                    theme.text_ghost,
                                ),
                            ))
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(52.0))
                                    .text_size(sp(10.0))
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_color(file_status_color(&theme, &file.status))
                                    .child(file.status.clone()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex()
                                    .flex_1()
                                    .flex_col()
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(sp(11.0))
                                            .text_color(theme.text_secondary)
                                            .child(basename.clone()),
                                    )
                                    .when(!directory.is_empty(), |column| {
                                        column.child(
                                            div()
                                                .min_w_0()
                                                .truncate()
                                                .text_size(sp(9.5))
                                                .text_color(theme.text_ghost)
                                                .child(directory.clone()),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.0))
                                    .text_color(theme.success)
                                    .child(format!("+{}", file.additions)),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.0))
                                    .text_color(theme.danger)
                                    .child(format!("\u{2212}{}", file.deletions)),
                            ),
                    );
                    if expanded {
                        if let Some(snapshot) = file_diff_snapshot.clone() {
                            let entity = cx.entity().downgrade();
                            // The inline diff must own a definite height: a
                            // `list` sizes itself from its container, so
                            // `max_h`-only styling collapses it to zero rows
                            // inside the flex-column body. Give it the FULL
                            // content height — the details body's
                            // overflow_y_scroll owns the scrolling, so the
                            // whole diff rides the body's scrollbar instead
                            // of fighting it in a nested capped viewport.
                            let row_height =
                                DiffRowStyle::review(self.state.code_font_size).row_height;
                            let diff_height = snapshot.lines.len() as f32 * row_height;
                            section = section.child(
                                div()
                                    .border_t_1()
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .child(
                                        list(
                                            self.git_panel_diff_list_state.clone(),
                                            move |index, _window, cx| {
                                                entity
                                                    .upgrade()
                                                    .map(|entity| {
                                                        entity.update(cx, |this, cx| {
                                                            this.render_right_panel_diff_line(
                                                                &snapshot, index, false, cx,
                                                            )
                                                        })
                                                    })
                                                    .unwrap_or_else(|| div().into_any_element())
                                            },
                                        )
                                        .h(px(diff_height))
                                        .flex_none(),
                                    ),
                            );
                        } else if file_diff_loading {
                            section = section.child(
                                div()
                                    .px(px(12.0))
                                    .py(px(8.0))
                                    .text_size(sp(10.5))
                                    .text_color(theme.text_tertiary)
                                    .child(tr!("git_panel.loading")),
                            );
                        }
                    }
                }
                body = body.child(section);
            }
        }

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// The Changes tab: identity bar, branch toolbar, summary + bulk row,
    /// conflict band, the staged/unstaged sections over one virtualized row
    /// list, and the commit bar footer.
    /// The Worktrees tab: every working tree linked to the session's
    /// repository, main first, with the session that owns each linked tree
    /// and a two-step armed removal (tide/* branches go with their tree).
    pub(in crate::app) fn render_git_panel_worktrees(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let worktrees = match &self.git_panel.worktrees {
            Query::Ready(worktrees) => Some(worktrees.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let busy = self.git_panel.busy.is_some();
        let armed = self.git_panel.confirm_remove_worktree.clone();
        let cwd = self.selected_workspace_path().map(Path::to_path_buf);

        let body: AnyElement = match worktrees {
            None => self
                .render_git_panel_loading_rows(&theme)
                .into_any_element(),
            Some(worktrees) if worktrees.is_empty() => self
                .render_right_panel_empty_message(
                    tr!("git_panel.worktrees_empty"),
                    tr!("git_panel.worktrees_empty_description"),
                    cx,
                )
                .into_any_element(),
            Some(worktrees) => {
                let mut list_div = div()
                    .id("git-worktree-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col();
                for entry in worktrees.iter() {
                    let is_armed = armed.as_deref() == Some(entry.path.as_path());
                    let is_current = cwd.as_deref().is_some_and(|cwd| {
                        fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()) == entry.path
                    });
                    let owner = self.worktree_session(&entry.path);
                    let owner_busy = owner.is_some_and(|session| session.is_busy());
                    let removable = !entry.main && !busy && !owner_busy;

                    let name = if let Some(branch) = entry.branch.as_deref() {
                        branch.to_owned()
                    } else if entry.bare {
                        tr!("git_panel.worktree_bare")
                    } else {
                        tr!("git_panel.worktree_detached", sha = entry.head.clone())
                    };
                    let mut badges = div().flex().flex_none().items_center().gap(px(6.0));
                    if is_current {
                        badges = badges.child(worktree_badge(
                            tr!("git_panel.worktree_current"),
                            theme.accent,
                        ));
                    }
                    if entry.main {
                        badges = badges.child(worktree_badge(
                            tr!("git_panel.worktree_main"),
                            theme.text_tertiary,
                        ));
                    }
                    if entry.dirty {
                        badges = badges.child(worktree_badge(
                            tr!("git_panel.worktree_dirty"),
                            theme.warning,
                        ));
                    }
                    if entry.locked {
                        badges = badges.child(worktree_badge(
                            tr!("git_panel.worktree_locked"),
                            theme.text_tertiary,
                        ));
                    }

                    let detail = match owner {
                        Some(session) if !entry.main => tr!(
                            "git_panel.worktree_in_use",
                            title = session.display_title().to_owned()
                        ),
                        _ => compact_path(&entry.path),
                    };

                    let action: AnyElement = if entry.main {
                        div().into_any_element()
                    } else if is_armed {
                        let cancel_path = entry.path.clone();
                        let entry = entry.clone();
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .id("git-worktree-remove-confirm")
                                    .tab_index(0)
                                    .focus_visible(|style| {
                                        style.border_1().border_color(theme.danger)
                                    })
                                    .h(px(22.0))
                                    .px(px(7.0))
                                    .rounded(px(6.0))
                                    .border_1()
                                    .border_color(theme.danger)
                                    .bg(theme.danger.opacity(0.12))
                                    .flex()
                                    .items_center()
                                    .cursor_default()
                                    .text_size(sp(11.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.danger)
                                    .child(tr!("common.confirm"))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.remove_worktree(&entry, cx);
                                    }),
                            )
                            .child(
                                div()
                                    .id("git-worktree-remove-cancel")
                                    .tab_index(0)
                                    .focus_visible(|style| {
                                        style.border_1().border_color(theme.accent)
                                    })
                                    .h(px(22.0))
                                    .px(px(7.0))
                                    .rounded(px(6.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .flex()
                                    .items_center()
                                    .cursor_default()
                                    .text_size(sp(11.0))
                                    .text_color(theme.text_secondary)
                                    .child(tr!("common.cancel"))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.toggle_worktree_removal(cancel_path.clone(), cx);
                                    }),
                            )
                            .into_any_element()
                    } else {
                        let remove_path = entry.path.clone();
                        div()
                            .id("git-worktree-remove")
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .size(px(24.0))
                            .rounded(px(6.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .when(removable, |element| {
                                element
                                    .cursor_default()
                                    .hover(|style| style.bg(theme.overlay))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.toggle_worktree_removal(remove_path.clone(), cx);
                                    })
                            })
                            .child(icon(
                                "icons/trash.svg",
                                13.0,
                                if removable {
                                    theme.text_tertiary
                                } else {
                                    theme.text_ghost
                                },
                            ))
                            .tooltip({
                                let tooltip = if owner_busy {
                                    tr!("git_panel.worktree_in_use_busy")
                                } else {
                                    tr!("git_panel.worktree_remove")
                                };
                                move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx)
                            })
                            .into_any_element()
                    };

                    list_div = list_div.child(
                        div()
                            .id(SharedString::from(format!(
                                "git-worktree-{}",
                                entry.path.display()
                            )))
                            .px(px(12.0))
                            .py(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.0))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.0))
                                            .child(
                                                div()
                                                    .min_w_0()
                                                    .truncate()
                                                    .font_family(".SystemUITMonospaced")
                                                    .text_size(sp(11.5))
                                                    .text_color(theme.text_secondary)
                                                    .child(single_line_label(&name)),
                                            )
                                            .child(badges),
                                    )
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(sp(11.0))
                                            .text_color(if owner.is_some() && !entry.main {
                                                theme.accent.opacity(0.8)
                                            } else {
                                                theme.text_tertiary
                                            })
                                            .child(single_line_label(&detail)),
                                    ),
                            )
                            .child(action),
                    );
                }
                list_div.into_any_element()
            }
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(body)
            .into()
    }

    pub(in crate::app) fn render_git_panel_changes(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        // The two sub-views own the whole Changes body: an open file diff or
        // a last-turn review replaces the branch bar and the list, each with
        // its own back affordance.
        if self.git_panel.last_turn_review.is_some() {
            return self.render_git_last_turn_review(cx);
        }
        if self.git_panel.selected_file_diff.is_some() {
            return self.render_git_file_diff_sub_view(cx);
        }
        let theme = Theme::current(cx);

        // The panel's three sections share one vertical rhythm
        // (GIT_BAR_H / GIT_BAR_PAD_X): Top = tab bar + toolbar, Mid = the
        // main list, Bottom = branch / commit / identity bars.

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            // Top: the toolbar under the tab bar (the tab bar itself is
            // rendered by the surface header).
            .child(self.render_git_panel_top_bar(cx))
            // Mid: the changes list/tree.
            .child(self.render_git_panel_main_view(&theme, cx))
            // Bottom: branch, commit, and identity bars — the branch bar
            // always renders, even on a clean tree: its bulk menu is also
            // where the stash actions live.
            .child(self.render_git_panel_branch_bar(cx))
            .child(self.render_git_panel_commit_bar(window, cx))
            .child(self.render_git_panel_identity_bar(cx))
    }

    /// Mid section: the main list/tree view of working-tree changes, with
    /// the loading and clean-tree placeholders.
    pub(in crate::app) fn render_git_panel_main_view(
        &mut self,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status_pending = matches!(self.git_panel.status, Query::Pending | Query::Missing(_));
        let changes = match &self.git_panel.status {
            Query::Ready(changes) => Some(changes.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let conflicts_empty = match &self.git_panel.conflicts {
            Query::Ready(conflicts) => conflicts.is_empty(),
            Query::Pending | Query::Missing(_) => true,
        };
        let changes_count = changes.as_ref().map_or(0, |changes| changes.len());
        if status_pending {
            return self.render_git_panel_loading_rows(theme).into_any_element();
        }
        if changes_count == 0 && conflicts_empty {
            return self
                .render_right_panel_empty_message(
                    tr!("git_panel.clean_tree"),
                    tr!("git_panel.clean_tree_description"),
                    cx,
                )
                .into_any_element();
        }
        let entity = cx.entity().downgrade();
        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .relative()
            .child(
                list(
                    self.git_panel_changes_list_state.clone(),
                    move |index, _window, cx| {
                        entity
                            .upgrade()
                            .map(|entity| {
                                entity.update(cx, |this, cx| this.render_git_changes_row(index, cx))
                            })
                            .unwrap_or_else(|| div().into_any_element())
                    },
                )
                .size_full(),
            )
            .child(scrollbar::vertical(
                &self.git_panel_changes_list_state,
                &self.git_panel_changes_scrollbar,
            ))
            .into_any_element()
    }

    /// Bottom section, last row — the identity bar: the "Committing as"
    /// dropdown, port of tide's CommitIdentityBar, compressed to a chip
    /// (profile dot, resolved identity, chevron). The dropdown applies
    /// identities through the same GitSetIdentity dispatch the settings
    /// page uses.
    pub(in crate::app) fn render_git_panel_identity_bar(
        &mut self,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let identity = match &self.git_panel.current_identity {
            Query::Ready(identity) => Some(identity.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let profiles: Vec<protocol::git_settings::GitProfileWire> = self
            .git_settings
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.profiles.clone())
            .unwrap_or_default();
        let applied_dot = identity
            .as_ref()
            .and_then(|identity| identity.profile_id.as_ref())
            .and_then(|profile_id| profiles.iter().find(|p| &p.id == profile_id))
            .map(|profile| {
                crate::app::screens::settings::pages::git::page::git_dot_color(
                    &profile.color,
                    &theme,
                )
            });
        let no_identity = identity
            .as_ref()
            .is_some_and(|identity| identity.name.is_none() && identity.email.is_none());
        let label = if no_identity {
            tr!("git_panel.no_identity")
        } else {
            identity
                .as_ref()
                .and_then(|identity| {
                    Some(format!(
                        "{} <{}>",
                        identity.name.as_deref()?,
                        identity.email.as_deref()?
                    ))
                })
                .unwrap_or_else(|| tr!("git_panel.committing_as"))
        };

        let handle = self.menu_handle("git-panel-identity", cx);
        let weak = cx.entity().downgrade();
        let active_profile_id = identity.as_ref().and_then(|i| i.profile_id.clone());
        let has_profiles = !profiles.is_empty();
        let menu_profiles = std::rc::Rc::new(profiles);
        let trigger = div()
            .id("git-panel-identity-trigger")
            .h(px(24.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .cursor_default()
            .text_size(sp(11.5))
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay))
            .child(if no_identity {
                icon("icons/triangle-alert.svg", 12.0, theme.warning).into_any_element()
            } else {
                div()
                    .size(px(7.0))
                    .flex_none()
                    .rounded_full()
                    .bg(applied_dot.unwrap_or(theme.text_tertiary))
                    .into_any_element()
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(if no_identity {
                        theme.warning
                    } else {
                        theme.text_secondary
                    })
                    .child(single_line_label(&label)),
            )
            .child(icon("icons/chevron-down.svg", 10.0, theme.text_tertiary));
        let menu = dropdown_menu(
            trigger,
            "git-panel-identity-menu",
            &handle,
            MenuAlign::AboveLeft,
            move |_| {
                let mut items = vec![
                    MenuItem::new(tr!("git.projects.global"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.set_git_panel_identity("global".to_owned());
                            });
                        }
                    })
                    .icon("icons/globe.svg")
                    .selected(active_profile_id.is_none()),
                ];
                if has_profiles {
                    items.push(MenuItem::Separator);
                }
                for menu_profile in menu_profiles.iter() {
                    let weak = weak.clone();
                    let profile_id = menu_profile.id.clone();
                    let display = menu_profile
                        .name
                        .clone()
                        .unwrap_or_else(|| menu_profile.user_name.clone());
                    let email = menu_profile.user_email.clone();
                    let dot = crate::app::screens::settings::pages::git::page::git_dot_color(
                        &menu_profile.color,
                        &theme,
                    );
                    let selected = active_profile_id.as_deref() == Some(menu_profile.id.as_str());
                    items.push(
                        MenuItem::custom(move |_, _| {
                            div()
                                .w(px(252.0))
                                .py(px(4.0))
                                .flex()
                                .items_center()
                                .gap(px(9.0))
                                .child(div().size(px(7.0)).flex_none().rounded_full().bg(dot))
                                .child(
                                    div().flex_1().min_w_0().child(
                                        div()
                                            .w_full()
                                            .truncate()
                                            .text_size(sp(12.5))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(display.clone()),
                                    ),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .font_family(".SystemUIFontMonospaced")
                                        .text_size(sp(10.5))
                                        .text_color(theme.text_tertiary)
                                        .child(email.clone()),
                                )
                                .when(selected, |element| {
                                    element.child(icon(
                                        "icons/check.svg",
                                        11.0,
                                        theme.text_tertiary,
                                    ))
                                })
                                .into_any_element()
                        })
                        .on_click(move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.set_git_panel_identity(profile_id.clone());
                            });
                        }),
                    );
                }
                items.push(MenuItem::Separator);
                items.push(
                    MenuItem::new(tr!("git_panel.manage_identities"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.open_settings_page(SettingsPage::Git, cx);
                            });
                        }
                    })
                    .icon("icons/settings.svg"),
                );
                items
            },
        );

        div()
            .id("git-panel-identity-bar")
            .flex_none()
            .h(px(GIT_BAR_H))
            .px(px(GIT_BAR_PAD_X))
            .flex()
            .items_center()
            .min_w_0()
            .child(menu)
            .child(div().flex_1())
            .into_any_element()
    }

    /// Bottom section, second row — the commit bar: one boxed message
    /// editor with the generate and commit actions floating in its corner.
    pub(in crate::app) fn render_git_panel_commit_bar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.ensure_git_panel_commit_draft(window, cx);
        let theme = Theme::current(cx);
        let Some(draft) = self.git_panel_commit_draft() else {
            return div().id("git-panel-commit-bar");
        };
        let message = draft.message.clone();
        let amend = draft.amend;
        let message_text = draft.message.read(cx).content().trim().to_owned();
        let busy = self.git_panel.busy.is_some();
        let generating = self.git_panel.generating_message;
        let flash_sha = self.git_panel.flash_sha.clone();
        let has_conflicts =
            matches!(&self.git_panel.conflicts, Query::Ready(conflicts) if !conflicts.is_empty());
        let has_changes =
            matches!(&self.git_panel.status, Query::Ready(changes) if !changes.is_empty());
        let can_submit =
            !message_text.is_empty() && !has_conflicts && !busy && (amend || has_changes);

        let generate_focus = self.transcript_control_focus("git-commit-generate", cx);
        let generate = div()
            .id("git-commit-generate")
            .track_focus(&generate_focus)
            .tab_index(0)
            .size(px(22.0))
            .flex_none()
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(!generating, |button| {
                button.hover(|style| style.bg(theme.overlay))
            })
            .child(if generating {
                motion::spin(icon("icons/loader-circle.svg", 13.0, theme.accent)).into_any_element()
            } else {
                icon("icons/sparkle.svg", 13.0, theme.text_tertiary).into_any_element()
            })
            .when(!generating, |button| {
                button.on_activation(cx, move |this, _, cx| {
                    this.generate_git_panel_commit_message(cx);
                })
            });

        let message_field = div()
            .key_context("GitPanelCommitMessage")
            .on_action(cx.listener(
                |this, _: &crate::app::features::git::ConfirmGitPanelCommit, _, cx| {
                    this.confirm_git_panel_commit(cx);
                },
            ))
            .flex()
            .flex_col()
            .min_w_0()
            // Three visible lines at the 22px auto-height metric (66px),
            // plus a reserved strip so the floating actions never cover
            // text; the field itself grows to five lines before scrolling.
            .min_h(px(96.0))
            .pb(px(30.0))
            .child(message);

        let primary_focus = self.transcript_control_focus("git-commit-primary", cx);
        let primary_label = if flash_sha.is_some() {
            String::new()
        } else if busy {
            String::new()
        } else if amend {
            tr!("git_panel.amend_last_commit")
        } else {
            tr!("git_panel.commit")
        };
        let primary_enabled = can_submit && flash_sha.is_none();
        let primary = div()
            .id("git-commit-primary")
            .track_focus(&primary_focus)
            .when(primary_enabled, |button| button.tab_index(0))
            .h(px(24.0))
            .px(px(9.0))
            .rounded(px(7.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(5.0))
            .cursor_default()
            .text_size(sp(11.5))
            .font_weight(FontWeight::MEDIUM)
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(primary_enabled, |button| {
                if amend {
                    button.bg(theme.danger).text_color(theme.text)
                } else {
                    button.bg(theme.accent).text_color(theme.text)
                }
            })
            .when(!primary_enabled, |button| {
                button.bg(theme.overlay_strong).text_color(theme.text_ghost)
            })
            .child(if let Some(sha) = &flash_sha {
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(icon("icons/check.svg", 12.0, theme.success))
                    .child(
                        div()
                            .font_family(".SystemUIFontMonospaced")
                            .child(single_line_label(sha)),
                    )
                    .into_any_element()
            } else if busy {
                motion::spin(icon("icons/loader-circle.svg", 12.0, theme.text_secondary))
                    .into_any_element()
            } else {
                icon(
                    "icons/git-commit-horizontal.svg",
                    12.0,
                    if primary_enabled {
                        theme.text
                    } else {
                        theme.text_ghost
                    },
                )
                .into_any_element()
            })
            .when(!primary_label.is_empty(), |button| {
                button.child(div().child(primary_label))
            })
            .when(primary_enabled, |button| {
                button.on_activation(cx, move |this, _, cx| {
                    this.confirm_git_panel_commit(cx);
                })
            });

        // The branch bar above draws the bottom region's top hairline, so
        // the commit box itself stays borderless — its boxed editor card
        // is the visual boundary.
        div()
            .id("git-panel-commit-bar")
            .flex_none()
            .px(px(GIT_BAR_PAD_X))
            .py(px(6.0))
            .flex()
            .flex_col()
            .min_w_0()
            // The message editor: one boxed card, at least five lines tall,
            // with the actions floating in its bottom-right corner.
            .child(
                div()
                    .relative()
                    .rounded(px(9.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .px(px(8.0))
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .child(message_field)
                    .child(
                        div()
                            .absolute()
                            .bottom_1()
                            .right_1()
                            .flex()
                            .flex_col()
                            .items_end()
                            .gap(px(3.0))
                            .child(div().flex().items_center().gap(px(4.0)).child(generate))
                            .child(primary),
                    ),
            )
    }

    /// The branch selector fragment the footer carries: the shared branch
    /// picker chip (with its static fallback while the snapshot loads) and
    /// the ahead/behind pill when an upstream exists.
    pub(in crate::app) fn render_git_panel_branch_selector(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let branch = match &self.git_panel.branch_info {
            Query::Ready(info) => info.branch.clone(),
            _ => None,
        };
        let ahead_behind = self.git_panel.ahead_behind.clone();
        let busy = self.git_panel.busy;

        let mut row = div()
            .id("git-panel-branch-selector")
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0();
        if let Some(branch_label) = branch
            && !branch_label.is_empty()
        {
            let cwd = self.selected_workspace_path().map(Path::to_path_buf);
            let chip: AnyElement = match cwd {
                None => static_chip(&branch_label, &theme).into_any_element(),
                Some(cwd) => {
                    // The picker reads the sidebar's shared `InspectBranches`
                    // snapshot; a miss starts the fetch and falls back to the
                    // static chip until it lands.
                    let fallback_label = branch_label.clone();
                    let static_label = branch_label.clone();
                    self.render_branch_picker(
                        BranchPickerContext {
                            menu_id: SharedString::from("git-panel-branch"),
                            workspace_path: cwd,
                            planned_worktree: false,
                            surface: BranchPickerSurface::GitPanel,
                        },
                        busy.is_none() && !self.branch_operation_pending,
                        move |snapshot| {
                            snapshot
                                .current
                                .clone()
                                .unwrap_or_else(|| fallback_label.clone())
                        },
                        move |open, _| {
                            MenuChip::new("git-panel-branch")
                                .icon("icons/git-branch.svg", theme.text_tertiary)
                                .label(branch_label.clone())
                                .caret(true)
                                .height(px(22.0))
                                .background(theme.surface)
                                .max_w(px(180.0))
                                .disabled(busy.is_some())
                                .selected(open)
                        },
                        MenuAlign::AboveLeft,
                        cx,
                    )
                    .unwrap_or_else(|| static_chip(&static_label, &theme).into_any_element())
                }
            };
            row = row.child(chip);
        }
        if let Some(ahead_behind) = ahead_behind
            && ahead_behind.ahead + ahead_behind.behind > 0
        {
            row = row.child(
                div()
                    .id("git-panel-ahead-behind")
                    .flex_none()
                    .h(px(18.0))
                    .px(px(5.0))
                    .rounded(px(9.0))
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .gap(px(3.0))
                    .text_size(sp(10.5))
                    .font_family(".SystemUIFontMonospaced")
                    .child(
                        div()
                            .text_color(theme.text_tertiary)
                            .child(format!("↓{}", ahead_behind.behind)),
                    )
                    .child(
                        div()
                            .text_color(theme.text_tertiary)
                            .child(format!("↑{}", ahead_behind.ahead)),
                    ),
            );
        }
        row
    }

    /// The ellipsis actions menu — refresh, the three remote ops, and —
    /// when a checkpoint-ready turn exists — the last-turn review.
    pub(in crate::app) fn render_git_panel_actions_menu(
        &mut self,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let refreshing = self.git_panel.refresh_in_flight;
        let busy = self.git_panel.busy;
        let review_source = self.latest_review_turn_source();
        let actions_handle = self.menu_handle("git-panel-actions", cx);
        let weak = cx.entity().downgrade();
        let remote_busy = busy.is_some();
        let refreshing_now = refreshing;
        dropdown_menu(
            div()
                .id("git-panel-actions")
                .h(px(24.0))
                .w(px(28.0))
                .flex_none()
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .when(actions_handle.is_open(), |button| button.bg(theme.overlay))
                .hover(|button| button.bg(theme.overlay))
                .child(if refreshing_now {
                    motion::spin(icon("icons/rotate-cw.svg", 12.0, theme.accent)).into_any_element()
                } else {
                    icon("icons/ellipsis.svg", 12.0, theme.text_tertiary).into_any_element()
                })
                .tooltip(|window, cx| {
                    Tooltip::new(tr!("git_panel.more_actions")).build(window, cx)
                }),
            "git-panel-actions-menu",
            &actions_handle,
            MenuAlign::BelowRight,
            move |_| {
                let fetch = MenuItem::new(tr!("git_panel.fetch"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.run_git_panel_remote("fetch", true, false, cx)
                        });
                    }
                })
                .icon("icons/download.svg")
                .disabled(remote_busy);
                let pull = MenuItem::new(tr!("git_panel.pull"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.run_git_panel_remote("pull", false, false, cx)
                        });
                    }
                })
                .icon("icons/arrow-down.svg")
                .disabled(remote_busy);
                let push = MenuItem::new(tr!("git_panel.push"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak.update(cx, |this, cx| this.run_git_panel_push(cx));
                    }
                })
                .icon("icons/cloud-upload.svg")
                .disabled(remote_busy);
                let mut items = vec![fetch, pull, push];
                if let Some(source) = review_source {
                    items.push(MenuItem::Separator);
                    items.push(
                        MenuItem::new(tr!("diff.source_last_turn"), {
                            let weak = weak.clone();
                            move |_, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.open_last_turn_review(source.clone(), cx)
                                });
                            }
                        })
                        .icon("icons/file-diff.svg"),
                    );
                }
                items
            },
        )
    }

    /// Top section, second row — the toolbar: the actions menu (remote ops,
    /// last-turn review) and the tree/list view toggle side by side,
    /// pushed to the row's end.
    pub(in crate::app) fn render_git_panel_top_bar(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let tree_mode = self.git_panel.tree_mode;

        let toggle_focus = self.transcript_control_focus("git-panel-view-toggle", cx);
        let view_toggle = div()
            .id("git-panel-view-toggle")
            .track_focus(&toggle_focus)
            .tab_index(0)
            .size(px(24.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay))
            .child(icon(
                if tree_mode {
                    "icons/list.svg"
                } else {
                    "icons/folder-tree.svg"
                },
                13.0,
                theme.text_tertiary,
            ))
            .tooltip({
                let tooltip = if tree_mode {
                    tr!("git_panel.list_view")
                } else {
                    tr!("git_panel.tree_view")
                };
                move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx)
            })
            .on_activation(cx, move |this, _, cx| {
                this.set_git_panel_tree_mode(!tree_mode, cx);
            });

        let actions_menu = self.render_git_panel_actions_menu(cx);

        div()
            .id("git-panel-top-bar")
            .h(px(GIT_BAR_H))
            .flex_none()
            .px(px(GIT_BAR_PAD_X))
            .flex()
            .items_center()
            .gap(px(4.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(div().flex_1())
            .child(actions_menu)
            .child(view_toggle)
    }

    /// Bottom section, first row — the branch bar: the branch selector on
    /// the left, the staged numstat and the Stage all menu (with its armed
    /// two-step discard confirmation and the stash actions) on the right.
    pub(in crate::app) fn render_git_panel_branch_bar(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let busy = self.git_panel.busy.is_some();
        let armed = self.git_panel.confirm_discard_all;
        let stash_count = match &self.git_panel.stashes {
            Query::Ready(stashes) => stashes.len(),
            Query::Pending | Query::Missing(_) => 0,
        };

        let right_side: AnyElement = if armed {
            let confirm_focus = self.transcript_control_focus("git-panel-discard-all-confirm", cx);
            div()
                .id("git-panel-discard-all-confirm")
                .track_focus(&confirm_focus)
                .tab_index(0)
                .h(px(22.0))
                .px(px(7.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(theme.danger)
                .bg(theme.danger.opacity(0.12))
                .flex()
                .items_center()
                .gap(px(4.0))
                .cursor_default()
                .text_size(sp(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.danger)
                .focus_visible(|style| style.border_2().border_color(theme.danger))
                .child(tr!("common.confirm"))
                .on_activation(cx, |this, _, cx| {
                    this.git_panel.confirm_discard_all = false;
                    this.run_git_panel_bulk_op("restore-all", cx);
                })
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    if this.git_panel.confirm_discard_all {
                        this.git_panel.confirm_discard_all = false;
                        cx.notify();
                    }
                }))
                .into_any_element()
        } else {
            let handle = self.menu_handle("git-panel-bulk", cx);
            let weak = cx.entity().downgrade();
            let stash_count = stash_count;
            dropdown_menu(
                MenuChip::new("git-panel-bulk")
                    .label(tr!("git_panel.stage_all"))
                    .height(px(24.0))
                    .background(theme.surface)
                    .selected(handle.is_open())
                    .disabled(busy),
                "git-panel-bulk-menu",
                &handle,
                MenuAlign::AboveRight,
                move |_| {
                    let stage = bulk_item(
                        &weak,
                        "icons/plus.svg",
                        tr!("git_panel.stage_all"),
                        "stage-all",
                        busy,
                    );
                    let unstage = bulk_item(
                        &weak,
                        "icons/x.svg",
                        tr!("git_panel.unstage_all"),
                        "unstage-all",
                        busy,
                    );
                    let discard = MenuItem::new(tr!("git_panel.discard_all"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.git_panel.confirm_discard_all = true;
                                cx.notify();
                            });
                        }
                    })
                    .icon("icons/rewind.svg");
                    let stash = bulk_item(
                        &weak,
                        "icons/package.svg",
                        tr!("git_panel.stash_all"),
                        "stash",
                        busy,
                    );
                    let stash_pop = MenuItem::new(tr!("git_panel.stash_pop"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.run_git_panel_bulk_op("stash-pop", cx);
                            });
                        }
                    })
                    .icon("icons/package.svg")
                    .disabled(busy || stash_count == 0);
                    let view_stash = MenuItem::new(tr!("git_panel.view_stash"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.git_panel.stash_dialog_open = true;
                                cx.notify();
                            });
                        }
                    })
                    .icon("icons/eye.svg");
                    // The remote group rides the same menu: fetch, both
                    // pull flavors, and push.
                    vec![
                        stage,
                        unstage,
                        discard,
                        MenuItem::Separator,
                        stash,
                        stash_pop,
                        view_stash,
                        MenuItem::Separator,
                        remote_item(
                            &weak,
                            "icons/download.svg",
                            tr!("git_panel.fetch"),
                            "fetch",
                            true,
                            false,
                            busy,
                        ),
                        remote_item(
                            &weak,
                            "icons/arrow-down.svg",
                            tr!("git_panel.pull"),
                            "pull",
                            false,
                            false,
                            busy,
                        ),
                        remote_item(
                            &weak,
                            "icons/corner-down-right.svg",
                            tr!("git_panel.pull_rebase"),
                            "pull-rebase",
                            false,
                            true,
                            busy,
                        ),
                        {
                            let weak = weak.clone();
                            MenuItem::new(tr!("git_panel.push"), move |_, cx| {
                                let _ = weak.update(cx, |this, cx| this.run_git_panel_push(cx));
                            })
                            .icon("icons/cloud-upload.svg")
                            .disabled(busy)
                        },
                    ]
                },
            )
            .into_any_element()
        };

        let branch_selector = self.render_git_panel_branch_selector(cx);

        // The staged numstat rides beside the Stage All menu, hiding when
        // nothing is staged yet.
        let (staged_add, staged_del) = match &self.git_panel.status {
            Query::Ready(changes) => changes.iter().fold((0u64, 0u64), |(add, del), change| {
                (
                    add + change.additions * u64::from(change.staged),
                    del + change.deletions * u64::from(change.staged),
                )
            }),
            Query::Pending | Query::Missing(_) => (0, 0),
        };
        let staged_counts = div()
            .id("git-panel-staged-counts")
            .flex()
            .flex_none()
            .items_center()
            .gap(px(3.0))
            .font_family(".SystemUIFontMonospaced")
            .text_size(sp(10.5))
            .when(staged_add + staged_del > 0, |counts| {
                counts
                    .child(
                        div()
                            .text_color(theme.success)
                            .child(format!("+{staged_add}")),
                    )
                    .child(
                        div()
                            .text_color(theme.danger)
                            .child(format!("−{staged_del}")),
                    )
            });

        div()
            .id("git-panel-branch-bar")
            .flex_none()
            .h(px(GIT_BAR_H))
            .px(px(GIT_BAR_PAD_X))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_t_1()
            .border_color(theme.border)
            .child(branch_selector)
            .child(div().flex_1())
            .child(staged_counts)
            .child(right_side)
    }

    /// Dispatches one of the panel's bulk operations by its wire name.
    pub(in crate::app) fn run_git_panel_bulk_op(
        &mut self,
        op: &'static str,
        cx: &mut Context<Self>,
    ) {
        let Some(cwd) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            return;
        };
        self.run_git_panel_op(
            op,
            client::WorkspaceOperation::GitBulk {
                cwd,
                op: op.to_owned(),
                message: None,
            },
            cx,
        );
    }

    /// The selected-file diff sub-view: back header (basename bold, its
    /// directory, a staged/unstaged badge, numstat) over the shared
    /// unified-diff list with gap-driven context escalation.
    pub(in crate::app) fn render_git_file_diff_sub_view(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(selected) = self.git_panel.selected_file_diff.as_ref() else {
            return div();
        };
        let path = selected.path.clone();
        let staged = selected.staged;
        let loading = matches!(selected.hunks, Query::Pending | Query::Missing(_))
            && selected.snapshot.is_none();
        let snapshot = selected.snapshot.clone();
        let (additions, deletions) = snapshot
            .as_ref()
            .map_or((0, 0), |snapshot| (snapshot.additions, snapshot.deletions));

        let basename = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let directory = path.strip_suffix(&basename).unwrap_or_default().to_owned();
        let badge = if staged {
            tr!("git_panel.staged")
        } else {
            tr!("git_panel.unstaged")
        };

        let back_focus = self.transcript_control_focus("git-file-diff-back", cx);
        let header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-file-diff-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_git_panel_file_diff(cx);
                    }),
            )
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("git-file-diff-path")
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .tooltip(Tooltip::text(path.clone()))
                            .child(basename),
                    )
                    .when(!directory.is_empty(), |column| {
                        column.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(10.5))
                                .text_color(theme.text_tertiary)
                                .child(directory),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .h(px(18.0))
                    .px(px(6.0))
                    .rounded(px(5.0))
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .text_size(sp(10.5))
                    .text_color(theme.text_secondary)
                    .child(badge),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.success)
                    .child(format!("+{additions}")),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.danger)
                    .child(format!("\u{2212}{deletions}")),
            );

        let body = if loading {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        } else if let Some(snapshot) = snapshot {
            self.render_right_panel_unified_diff(snapshot, true, cx)
        } else {
            self.render_right_panel_empty_message(
                tr!("diff.no_changes"),
                tr!("diff.no_changes_description"),
                cx,
            )
            .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// The last-turn agent-review sub-view: back header with the turn label
    /// and numstat over the shared unified-diff list with local gap
    /// expansion.
    pub(in crate::app) fn render_git_last_turn_review(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(review) = self.git_panel.last_turn_review.as_ref() else {
            return div();
        };
        let label = self.last_turn_review_label(review.source);
        let snapshot = review.snapshot.clone();
        let loading = review.loading;
        let error = review.error.clone();
        let (additions, deletions) = snapshot
            .as_ref()
            .map_or((0, 0), |snapshot| (snapshot.additions, snapshot.deletions));

        let back_focus = self.transcript_control_focus("git-review-back", cx);
        let mut header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-review-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_last_turn_review(cx);
                    }),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_secondary)
                    .child(label),
            );
        if let Some(error) = error.as_ref() {
            header = header.child(
                div()
                    .id("git-review-error")
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(theme.danger)
                    .tooltip(Tooltip::text(error.clone()))
                    .child(single_line_label(error)),
            );
        }
        let header = header
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.success)
                    .child(format!("+{additions}")),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.danger)
                    .child(format!("\u{2212}{deletions}")),
            )
            .when(loading, |row| {
                row.child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    12.0,
                    theme.text_tertiary,
                )))
            });

        let body = if let Some(snapshot) = snapshot {
            self.render_right_panel_unified_diff(snapshot, false, cx)
        } else if let Some(error) = error {
            self.render_right_panel_empty_message(tr!("diff.unavailable"), error, cx)
                .into_any_element()
        } else {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// Loading placeholders while the first status query is in flight.
    pub(in crate::app) fn render_git_panel_loading_rows(&self, theme: &Theme) -> Div {
        let mut list = div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .px(px(12.0))
            .py(px(8.0));
        for index in 0..4 {
            list = list.child(
                div()
                    .h(px(16.0))
                    .my(px(5.0))
                    .rounded(px(4.0))
                    .bg(theme.overlay)
                    .w(gpui::relative((0.55 + index as f32 * 0.1).clamp(0.0, 0.98))),
            );
        }
        list
    }

    /// One row of the Changes tab's virtualized list, dispatched by kind.
    pub(in crate::app) fn render_git_changes_row(
        &self,
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(row) = self.git_panel_changes_rows.borrow().get(index).cloned() else {
            return div().h(px(28.0)).into_any_element();
        };
        match row {
            GitChangesRow::ConflictHeader { count } => self.render_git_conflict_header(count, cx),
            GitChangesRow::ConflictFile { index } => self.render_git_conflict_row(index, cx),
            GitChangesRow::SectionHeader { section, count } => {
                self.render_git_section_header(section, count, cx)
            }
            GitChangesRow::Directory {
                key,
                name,
                depth,
                file_count,
            } => self.render_git_directory_row(key, name, depth, file_count, cx),
            GitChangesRow::File {
                section,
                index,
                depth,
                show_path,
            } => self.render_git_changed_file_row(section, index, depth, show_path, cx),
        }
    }

    /// The danger-tinted header of the conflict band.
    pub(in crate::app) fn render_git_conflict_header(
        &self,
        count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        div()
            .w_full()
            .h(px(28.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .bg(theme.danger.opacity(0.06))
            .border_b_1()
            .border_color(theme.danger.opacity(0.3))
            .child(icon("icons/alert.svg", 13.0, theme.danger))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(11.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.danger)
                    .child(tr!("git_panel.conflicts", count = count)),
            )
            .into_any_element()
    }

    /// One conflicted path with its resolve actions.
    pub(in crate::app) fn render_git_conflict_row(
        &self,
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(conflict) = git_conflict_at(&self.git_panel.conflicts, index) else {
            return div().h(px(28.0)).into_any_element();
        };
        let state = conflict.state.replace('-', " ");
        let mut row = div()
            .w_full()
            .h(px(28.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .bg(theme.danger.opacity(0.04))
            .hover(|style| style.bg(theme.danger.opacity(0.09)))
            .child(
                div()
                    .id(SharedString::from(format!("git-conflict-path-{index}")))
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(11.0))
                    .text_color(theme.text_secondary)
                    .tooltip(Tooltip::text(conflict.path.clone()))
                    .child(conflict.path.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(10.0))
                    .text_color(theme.text_tertiary)
                    .child(single_line_label(&state)),
            );
        for (side_key, label) in [
            ("ours", tr!("git_panel.use_ours")),
            ("theirs", tr!("git_panel.use_theirs")),
        ] {
            let focus =
                self.transcript_control_focus(format!("git-conflict-{index}-{side_key}"), cx);
            let path = conflict.path.clone();
            let side = side_key.to_owned();
            row = row.child(
                div()
                    .id(SharedString::from(format!(
                        "git-conflict-{index}-{side_key}"
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .h(px(20.0))
                    .px(px(6.0))
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex_none()
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(10.5))
                    .text_color(theme.text_secondary)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay).text_color(theme.text))
                    .child(label)
                    .on_activation(cx, move |this, _, cx| {
                        let Some(cwd) = this
                            .selected_workspace_path()
                            .map(std::path::Path::to_path_buf)
                        else {
                            return;
                        };
                        this.run_git_panel_op(
                            "resolve",
                            client::WorkspaceOperation::GitResolveFile {
                                cwd,
                                path: path.clone(),
                                side: side.clone(),
                            },
                            cx,
                        );
                    }),
            );
        }
        row.into_any_element()
    }

    /// A "Staged" / "Changes" collapsible header with its bulk icon actions.
    pub(in crate::app) fn render_git_section_header(
        &self,
        section: GitFileSection,
        count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let open = match section {
            GitFileSection::Staged => self.git_panel.staged_open,
            GitFileSection::Unstaged => self.git_panel.unstaged_open,
        };
        let label = match section {
            GitFileSection::Staged => tr!("git_panel.staged"),
            GitFileSection::Unstaged => tr!("git_panel.unstaged"),
        };
        let section_id = section.key();
        let header_focus =
            self.transcript_control_focus(format!("git-section-header-{section_id}"), cx);

        let mut actions = div().flex().flex_none().items_center().gap(px(2.0));
        match section {
            GitFileSection::Staged => {
                let focus = self.transcript_control_focus("git-section-unstage-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-unstage-all")
                        .track_focus(&focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/x.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.unstage_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.run_git_panel_bulk_op("unstage-all", cx);
                        }),
                );
            }
            GitFileSection::Unstaged => {
                let discard_focus = self.transcript_control_focus("git-section-discard-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-discard-all")
                        .track_focus(&discard_focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/rewind.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.discard_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.git_panel.confirm_discard_all = true;
                            cx.notify();
                        }),
                );
                let stage_focus = self.transcript_control_focus("git-section-stage-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-stage-all")
                        .track_focus(&stage_focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/plus.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.stage_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.run_git_panel_bulk_op("stage-all", cx);
                        }),
                );
            }
        }

        div()
            .w_full()
            .h(px(28.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .min_w_0()
            .child(
                div()
                    .id(SharedString::from(format!(
                        "git-section-header-{section_id}"
                    )))
                    .track_focus(&header_focus)
                    .tab_index(0)
                    .min_w_0()
                    .flex_1()
                    .h(px(28.0))
                    .pl(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        10.0,
                        theme.text_ghost,
                    ))
                    .child(
                        div()
                            .truncate()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_secondary)
                            .child(label),
                    )
                    .child(
                        div()
                            .flex_none()
                            .min_w(px(16.0))
                            .h(px(15.0))
                            .px(px(4.0))
                            .rounded(px(7.0))
                            .bg(theme.accent.opacity(0.1))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(sp(10.0))
                            .text_color(theme.accent)
                            .child(count.to_string()),
                    )
                    .on_activation(cx, move |this, _, cx| {
                        this.toggle_git_panel_section(section, cx);
                    }),
            )
            .child(actions)
            .into_any_element()
    }

    /// A tree-mode directory row: chevron, folder, name, and file count.
    pub(in crate::app) fn render_git_directory_row(
        &self,
        key: String,
        name: String,
        depth: u32,
        file_count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let open = !self.git_panel.closed_dirs.contains(&key);
        let focus =
            self.transcript_control_focus(format!("git-dir-{}", key.replace('/', "\\")), cx);
        div()
            .w_full()
            .h(px(28.0))
            .pr(px(8.0))
            .relative()
            .flex()
            .items_center()
            // Tree rows share the section header's 10px leading inset so the
            // depth-0 chevron lines up with the header chevron and the flat
            // list's status-letter column; deeper rows indent by 14px a level.
            // One vertical guide per ancestor level, the session-tree idiom:
            // 1px lines at each indent step spanning the row, connecting
            // across rows into continuous rails.
            .children((1..=depth).map(|k| {
                div()
                    .absolute()
                    .left(px(10.0 + k as f32 * 14.0 - 6.0))
                    .top_0()
                    .bottom_0()
                    .w(px(1.0))
                    .bg(theme.border.opacity(0.6))
            }))
            .child(
                div()
                    .id(SharedString::from(format!(
                        "git-dir-{}",
                        key.replace('/', "\\")
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .min_w_0()
                    .flex_1()
                    .h(px(24.0))
                    .pl(px(10.0 + depth as f32 * 14.0))
                    .pr(px(6.0))
                    .my(px(2.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        10.0,
                        theme.text_ghost,
                    ))
                    .child(icon(
                        if open {
                            "icons/folder-open.svg"
                        } else {
                            "icons/folder.svg"
                        },
                        13.0,
                        theme.text_tertiary,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(13.0))
                            .text_color(theme.text_secondary)
                            .child(name),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(sp(10.0))
                            .text_color(theme.text_ghost)
                            .child(file_count.to_string()),
                    )
                    .on_activation(cx, move |this, _, cx| {
                        this.toggle_git_panel_directory(key.clone(), cx);
                    }),
            )
            .into_any_element()
    }

    /// The ChangedFileRow port: status letter, basename + truncated
    /// directory, numstat chips, and the stage/discard actions.
    pub(in crate::app) fn render_git_changed_file_row(
        &self,
        section: GitFileSection,
        index: usize,
        depth: u32,
        show_path: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(change) = git_change_at(&self.git_panel.status, index) else {
            return div().h(px(28.0)).into_any_element();
        };
        let (letter, letter_color) = match change.status.as_str() {
            "added" => ("A", theme.success),
            "deleted" => ("D", theme.danger),
            "untracked" => ("U", theme.text_secondary),
            "renamed" => ("R", theme.warning),
            _ => ("M", theme.accent),
        };
        let basename = change
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&change.path)
            .to_owned();
        let directory = change
            .path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_owned())
            .unwrap_or_default();
        let staged = change.staged;
        let row_id = format!("git-file-{}-{}", section.key(), change.path);

        let mut row = div()
            .id(SharedString::from(row_id.clone()))
            .w_full()
            .h(px(28.0))
            .pl(px(10.0 + depth as f32 * 14.0))
            .pr(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .hover(|style| style.bg(theme.overlay));
        if self
            .git_panel
            .selected_file_diff
            .as_ref()
            .is_some_and(|selected| selected.path == change.path && selected.staged == staged)
        {
            row = row.bg(theme.accent.opacity(0.08));
        }
        row = row
            .child(
                div()
                    .flex_none()
                    .w(px(14.0))
                    .text_center()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(11.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(letter_color)
                    .child(letter),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .items_baseline()
                    .gap(px(4.0))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(basename.clone()),
                    )
                    .when(show_path && !directory.is_empty(), |row| {
                        row.child(
                            div()
                                .id(SharedString::from(format!("{row_id}-dir")))
                                .min_w_0()
                                .truncate()
                                .text_size(sp(10.5))
                                .text_color(theme.text_tertiary)
                                .tooltip(Tooltip::text(directory.clone()))
                                .child(crate::ui::text::middle_ellipsis(&directory, 32)),
                        )
                    }),
            );
        if change.additions > 0 || change.deletions > 0 {
            row = row.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(3.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(10.5))
                    .when(change.additions > 0, |chips| {
                        chips.child(
                            div()
                                .px(px(3.0))
                                .rounded(px(3.0))
                                .bg(theme.success.opacity(0.1))
                                .text_color(theme.success)
                                .child(format!("+{}", change.additions)),
                        )
                    })
                    .when(change.deletions > 0, |chips| {
                        chips.child(
                            div()
                                .px(px(3.0))
                                .rounded(px(3.0))
                                .bg(theme.danger.opacity(0.1))
                                .text_color(theme.danger)
                                .child(format!("−{}", change.deletions)),
                        )
                    }),
            );
        }

        // Stage/unstage toggle.
        let toggle_focus = self.transcript_control_focus(format!("{row_id}-stage"), cx);
        let path = change.path.clone();
        let click_path = change.path.clone();
        let row_focus = self.transcript_control_focus(row_id.clone(), cx);
        let row = row
            .track_focus(&row_focus)
            .tab_index(0)
            .focus_visible(|style| style.bg(theme.accent.opacity(0.08)))
            .child(
                div()
                    .id(SharedString::from(format!("{row_id}-stage")))
                    .track_focus(&toggle_focus)
                    .tab_index(0)
                    .size(px(22.0))
                    .flex_none()
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if staged {
                            "icons/x.svg"
                        } else {
                            "icons/plus.svg"
                        },
                        12.0,
                        theme.text_tertiary,
                    ))
                    .tooltip({
                        let tooltip = if staged {
                            tr!("git_panel.unstage")
                        } else {
                            tr!("git_panel.stage")
                        };
                        move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx)
                    })
                    .on_activation(cx, move |this, _, cx| {
                        let Some(cwd) = this
                            .selected_workspace_path()
                            .map(std::path::Path::to_path_buf)
                        else {
                            return;
                        };
                        this.run_git_panel_op(
                            "stage",
                            client::WorkspaceOperation::GitStageFile {
                                cwd,
                                path: path.clone(),
                                stage: !staged,
                            },
                            cx,
                        );
                    }),
            )
            // Clicking the row away from its actions opens the file's diff;
            // the actions stop propagation, so they never reach here.
            .on_activation(cx, move |this, _, cx| {
                this.open_git_panel_file_diff(click_path.clone(), staged, cx);
            });
        // The row's right-click menu: stage/unstage and discard — which used
        // to be hover icons — plus the file utilities.
        let file_menu = self.menu_handle_with(
            SharedString::from(format!("git-file-menu-{row_id}")),
            cx,
            |_, _, _| {},
        );
        let menu_cwd = self.selected_workspace_path().map(Path::to_path_buf);
        let menu_path = change.path.clone();
        let tide = cx.entity().downgrade();
        let row = context_menu(
            row,
            SharedString::from(format!("git-file-menu-{row_id}")),
            &file_menu,
            move |cx| file_menu_items(menu_cwd.clone(), menu_path.clone(), staged, &tide, cx),
        );
        // Tree leaves get the same per-ancestor vertical guides as directory
        // rows, on a relative wrapper so the absolute lines span the row.
        if show_path {
            row.into_any_element()
        } else {
            div()
                .relative()
                .w_full()
                .children((1..=depth).map(|k| {
                    div()
                        .absolute()
                        .left(px(10.0 + k as f32 * 14.0 - 6.0))
                        .top_0()
                        .bottom_0()
                        .w(px(1.0))
                        .bg(theme.border.opacity(0.6))
                }))
                .child(row)
                .into_any_element()
        }
    }

    pub(in crate::app) fn render_right_panel_empty_message(
        &self,
        title: String,
        description: String,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .pb(px(32.0))
            .child(
                div()
                    .text_size(sp(13.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(title),
            )
            .child(
                div()
                    .mt(px(6.0))
                    .max_w(px(300.0))
                    .text_center()
                    .text_size(sp(12.5))
                    .line_height(sp(17.0))
                    .text_color(theme.text_tertiary)
                    .child(description),
            )
    }

    /// Re-reads whichever workspace surface is on screen.
    pub(in crate::app) fn refresh_workspace_surfaces(&mut self, cx: &mut Context<Self>) {
        match self.active_right_panel_surface() {
            Some(RightPanelSurface::Git) => self.refresh_git_panel(cx),
            Some(RightPanelSurface::Files | RightPanelSurface::File(_)) => {
                self.refresh_right_panel_working_tree(cx)
            }
            _ => {}
        }
    }

    /// Re-walks the project's working tree.
    ///
    /// `read_dir` plus a `stat` per entry, recursively over expanded
    /// directories — filesystem I/O, so it runs on the background executor and
    /// the panel keeps drawing the previous listing until the result lands.
    /// Called when the tree's inputs change, never from a frame.
    pub(in crate::app) fn latest_review_turn_source(&self) -> Option<ReviewDiffSource> {
        let session = self.selected_session()?;
        session
            .turns
            .iter()
            .rev()
            .find(|turn| {
                turn.turn_count > 0
                    && turn
                        .checkpoint
                        .as_ref()
                        .is_some_and(|checkpoint| checkpoint.status == CheckpointStatus::Ready)
            })
            .map(|turn| ReviewDiffSource::LastTurn {
                session_id: session.id,
                turn_id: turn.id,
                turn_count: turn.turn_count,
            })
    }

    pub(in crate::app) fn last_turn_review_label(&self, source: ReviewDiffSource) -> String {
        match source {
            ReviewDiffSource::LastTurn { .. }
                if self.latest_review_turn_source() == Some(source) =>
            {
                tr!("diff.source_last_turn")
            }
            ReviewDiffSource::LastTurn { turn_count, .. } => {
                tr!("diff.source_turn", turn = turn_count)
            }
            _ => tr!("diff.source_last_turn"),
        }
    }
}
