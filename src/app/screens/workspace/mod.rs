//! The Workspace screen: the sidebar, transcript/composer column, inspector,
//! and right panel as one composition, including the new-task and empty
//! states it shows before a conversation exists.

mod empty;
mod new_task;

use gpui::prelude::*;
use gpui::{AnyElement, Context, StyleRefinement, Window, div, px};

use crate::app::PanelResizeTarget;
use crate::app::Tide;
use crate::app::inspector;
use crate::app::layouts::panels::PanelFrame;
use crate::model::AgentSession;
use crate::theme::Theme;
use crate::ui::menu::MenuAlign;

fn should_render_empty_state(session: Option<&AgentSession>) -> bool {
    // Turns count as content even before any message exists: a
    // provider-initiated turn (Codex goal continuation) reasons for a while
    // before its first text delta, and the transcript's working indicator —
    // not the new-task greeting — is what represents that state.
    session
        .map(|session| {
            session.detail_loaded && session.messages.is_empty() && session.turns.is_empty()
        })
        .unwrap_or(true)
}

impl Tide {
    pub(in crate::app) fn sidebar_pane_content(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (sidebar_width, _) = self.effective_panel_widths(window);
        self.render_sidebar(sidebar_width, window, cx)
            .into_any_element()
    }

    /// [`TidePane`] delegate for the transcript island.
    pub(in crate::app) fn transcript_pane_content(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let chat_viewport_width = self.chat_viewport_width(window);
        // The transcript's own element sizes itself with `flex_1`, which only
        // stretches inside a flex parent. A cached pane lays its content out
        // as a root, so give it that parent here or its height collapses to
        // the zero flex basis.
        div()
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .child(self.render_transcript(window, chat_viewport_width, cx))
            .into_any_element()
    }

    /// [`TidePane`] delegate for the right-panel island.
    pub(in crate::app) fn right_panel_pane_content(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (_, right_panel_width) = self.effective_panel_widths(window);
        self.render_right_panel(right_panel_width, window, cx)
            .into_any_element()
    }

    /// Measure live frame rate by counting renders over a sliding one-second
    /// window and keep requesting animation frames so the counter stays current.

    /// The Workspace screen composition: the action-wired root, the three
    /// panel islands, and the conversation column with its overlays.
    pub(in crate::app) fn render_workspace(
        &mut self,
        panels: PanelFrame,
        image_preview: Option<AnyElement>,
        task_switcher: Option<AnyElement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Re-armed every frame this window shows time labels; parks while
        // settings covers them and while the window isn't drawing at all.
        self.schedule_time_label_wake(cx);

        let theme = Theme::current(cx);
        let empty = should_render_empty_state(self.selected_session());
        let permission = self.render_permission(cx);
        let computer_use = self.render_computer_use_overlay(cx);
        let command_palette = self.render_command_palette(window, cx);
        let commit_dialog = self.render_commit_dialog(cx);
        let goal_dialog = self.render_goal_dialog(window, cx);
        let tide_wizard = self.render_tide_wizard(window, cx);
        let toast = self.render_active_toast(cx);
        // The inspector column's conditions resolved once per frame: a
        // session past the new-task greeting (empty covers both no selection
        // and the greeting itself), the right panel not occupying width, and
        // a wide-enough viewport. Everything it renders is in-memory state.
        let inspector_shown = inspector::inspector_visible(
            !empty,
            panels.right_panel <= 0.0,
            f32::from(window.viewport_size().width),
        );
        // Publish the footprint the column consumes this frame so the
        // transcript's content measurement matches its narrowed bounds; the
        // pane's geometry-keyed cache re-renders it when this changes.
        self.inspector_rendered_width = inspector::inspector_consumed_width(inspector_shown);
        let content = div()
            .key_context("Tide")
            .on_action(cx.listener(Self::close_window_or_right_panel_tab_action))
            .on_action(cx.listener(Self::new_session_action))
            .on_action(cx.listener(Self::new_project_action))
            .on_action(cx.listener(Self::open_settings_action))
            .on_action(cx.listener(Self::toggle_remote_control_action))
            .on_action(cx.listener(Self::toggle_sidebar_action))
            .on_action(cx.listener(Self::toggle_right_panel_action))
            .on_action(cx.listener(Self::toggle_command_palette_action))
            .on_action(cx.listener(Self::toggle_fps_counter_action))
            .on_action(cx.listener(Self::navigate_back_action))
            .on_action(cx.listener(Self::navigate_forward_action))
            .on_action(cx.listener(Self::switch_task_forward_action))
            .on_action(cx.listener(Self::switch_task_backward_action))
            .on_action(cx.listener(Self::select_first_task_action))
            .on_action(cx.listener(Self::select_last_task_action))
            .on_action(cx.listener(Self::confirm_task_switch_action))
            .on_action(cx.listener(Self::cancel_task_switch_action))
            .on_action(cx.listener(Self::focus_composer_action))
            .on_action(cx.listener(Self::toggle_model_picker_action))
            .on_action(cx.listener(Self::toggle_usage_panel_action))
            .on_action(cx.listener(Self::save_right_panel_file_action))
            .on_action(cx.listener(Self::cancel_turn_action))
            .on_action(cx.listener(Self::copy_selection_action))
            .on_action(cx.listener(Self::open_find_action))
            .on_action(cx.listener(Self::open_find_replace_action))
            .on_action(cx.listener(Self::close_find_action))
            .on_action(cx.listener(Self::find_next_action))
            .on_action(cx.listener(Self::find_previous_action))
            .on_action(cx.listener(Self::toggle_find_case_action))
            .on_action(cx.listener(Self::toggle_find_whole_word_action))
            .on_action(cx.listener(Self::toggle_find_regex_action))
            .on_action(cx.listener(Self::replace_all_matches_action))
            .on_modifiers_changed(cx.listener(Self::task_switcher_modifiers_changed))
            .capture_any_mouse_down(cx.listener(Self::navigation_mouse_down))
            .on_mouse_move(cx.listener(Self::resize_panel_mouse_move))
            .capture_any_mouse_up(cx.listener(Self::finish_panel_resize))
            .size_full()
            .relative()
            .flex()
            .text_color(theme.text)
            .font_family(".SystemUIFont")
            // Both panels slide through a container that narrows while their
            // content keeps its full width and is clipped: the sidebar list
            // and the right panel's surfaces never reflow on the way in or
            // out, and their bounds stay put so only the clip moves.
            .when(panels.sidebar > 0.0, |root| {
                root.child(
                    div()
                        .h_full()
                        .flex_none()
                        .w(px(panels.sidebar))
                        .when(panels.sidebar_sliding, |element| element.overflow_hidden())
                        .child(
                            self.sidebar_pane.clone().cached(
                                StyleRefinement::default()
                                    .w(px(panels.sidebar_content))
                                    .h_full()
                                    .flex_none(),
                            ),
                        ),
                )
            })
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .bg(theme.surface)
                    .when(panels.sidebar > 0.0, |element| {
                        element.border_l_1().border_color(theme.sidebar_border)
                    })
                    .child(self.render_header(window, cx))
                    // The chat's working region — transcript through
                    // composer and the workspace footer beneath it — laid
                    // out as a row with the inspector column as an in-flow
                    // sibling: the card consumes layout width, so the
                    // transcript and everything that aligns with it
                    // (permission, queued messages, the composer, the
                    // footer) genuinely narrow instead of being overlaid.
                    // Only the header stays full-width chrome.
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.0))
                            .w_full()
                            .flex()
                            .flex_row()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(if empty {
                                        // The new-session screen composes
                                        // its own centered composer and
                                        // workspace chips; the bottom
                                        // chrome below stays empty-state
                                        // only.
                                        if self.selected_project().is_some() {
                                            self.render_new_session_screen(window, cx)
                                                .into_any_element()
                                        } else {
                                            self.render_empty_state(cx).into_any_element()
                                        }
                                    } else {
                                        self.transcript_pane
                                            .clone()
                                            .cached(
                                                StyleRefinement::default()
                                                    .flex_1()
                                                    .min_h(px(0.0))
                                                    .w_full(),
                                            )
                                            .into_any_element()
                                    })
                                    .children(permission)
                                    .when(self.selected_project().is_some() && !empty, |element| {
                                        element
                                            .children(self.render_composer_todo(cx))
                                            .children(self.render_queued_messages(cx))
                                            .child(self.render_composer(window, cx))
                                            .child(
                                                self.render_workspace_footer(
                                                    cx,
                                                    MenuAlign::AboveLeft,
                                                ),
                                            )
                                    }),
                            )
                            // The inspector island: mounted as a pane so
                            // targeted notifies (pulse ticks, stream
                            // commits to the transcript) replay it instead
                            // of rebuilding its sections per frame.
                            .when(inspector_shown, |element| {
                                element.child(
                                    div()
                                        .h_full()
                                        .flex_none()
                                        .w(px(inspector::INSPECTOR_TOTAL_WIDTH))
                                        .flex()
                                        .child(
                                            self.inspector_pane.clone().cached(
                                                StyleRefinement::default().w_full().h_full(),
                                            ),
                                        ),
                                )
                            }),
                    )
                    .relative()
                    .children(toast)
                    .children(computer_use)
                    .when(self.sidebar_visible, |element| {
                        element.child(self.render_panel_resize_handle(
                            "sidebar-resize-handle",
                            PanelResizeTarget::Sidebar,
                            cx,
                        ))
                    }),
            )
            .when(panels.right_panel > 0.0, |root| {
                root.child(
                    div()
                        .h_full()
                        .flex_none()
                        .w(px(panels.right_panel))
                        .flex()
                        .relative()
                        .when(panels.right_panel_sliding, |element| {
                            element.overflow_hidden()
                        })
                        // Pinned to the window's right edge, so the panel is
                        // uncovered from that edge inward rather than dragged
                        // across the screen.
                        .child(
                            self.right_panel_pane.clone().cached(
                                StyleRefinement::default()
                                    .absolute()
                                    .top_0()
                                    .right_0()
                                    .w(px(panels.right_panel_content))
                                    .h_full(),
                            ),
                        ),
                )
            })
            .children(command_palette)
            .children(commit_dialog)
            .children(goal_dialog)
            .children(tide_wizard)
            .children(image_preview)
            .children(task_switcher)
            .into_any_element();

        content
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::model::ProviderKind;
    use uuid::Uuid;

    #[test]
    fn unloaded_history_never_renders_the_new_task_prompt() {
        let mut stored = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
        stored.detail_loaded = false;

        assert!(!should_render_empty_state(Some(&stored)));

        let draft = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
        assert!(should_render_empty_state(Some(&draft)));
        assert!(should_render_empty_state(None));
    }
}
