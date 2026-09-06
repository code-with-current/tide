use super::branches::{BranchPickerContext, BranchPickerSurface};
use super::model_picker::ModelPickerConfig;
use super::*;

use anyhow::Context as _;
use base64::Engine as _;

impl Tide {
    // ── Permission ─────────────────────────────────────────────────────────

    pub(super) fn render_permission(&self, cx: &mut Context<Self>) -> Option<Div> {
        // The v2 pane owns the two pending-input surfaces in-pane — the
        // question card (`parts::question_card`) and the permission card
        // (`timeline_v2::permission`) — so their legacy above-composer cards
        // stand down while it is active (the seam-guard pattern from
        // `render_transcript`). Computer approval has no v2 analog yet and
        // keeps its legacy card either way.
        let legacy_pending_cards = !self.timeline_v2;
        if legacy_pending_cards
            && let Some(input) = self.selected_runtime()?.pending_user_input.clone()
        {
            return Some(self.render_user_input(input, cx));
        }
        if let Some(permission) = self.selected_runtime()?.pending_computer_approval.as_ref() {
            return Some(self.render_computer_permission(permission, cx));
        }
        if !legacy_pending_cards {
            return None;
        }
        let permission = self.selected_runtime()?.pending_permission.as_ref()?;
        let theme = Theme::current(cx);
        let request_id = permission.request_id.clone();
        let mut buttons = div().flex().items_center().gap(px(8.0)).mt(px(10.0));
        for option in &permission.options {
            let request_id = request_id.clone();
            let option_id = option.id.clone();
            let allow = option.allow;
            buttons = buttons.child(
                div()
                    .id(SharedString::from(format!(
                        "permission-{}-{}",
                        permission.request_id, option.id
                    )))
                    .h(px(28.0))
                    .px(px(13.0))
                    .rounded(px(7.0))
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .when(allow, |element| {
                        element
                            .bg(theme.inverse)
                            .text_color(theme.on_inverse)
                            .hover(|element| element.opacity(0.9))
                    })
                    .when(!allow, |element| {
                        element
                            .border_1()
                            .border_color(theme.border_strong)
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay).text_color(theme.text))
                    })
                    .active(|element| element.opacity(0.8))
                    .child(SharedString::from(option.label.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.respond_permission(request_id.clone(), option_id.clone(), cx);
                    })),
            );
        }
        Some(
            div().px(px(20.0)).pb(px(8.0)).child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .mx_auto()
                    .p(px(12.0))
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .bg(theme.raised)
                    .shadow_md()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(icon("icons/alert.svg", 13.0, theme.warning))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(SharedString::from(permission.title.clone())),
                            ),
                    )
                    .child(
                        div()
                            .id("permission-detail")
                            .mt(px(8.0))
                            .max_h(px(92.0))
                            .overflow_y_scroll()
                            .p(px(8.0))
                            .rounded(px(7.0))
                            .bg(theme.inset)
                            .font_family(crate::md::render::MONO_FAMILY)
                            .text_size(sp(12.5))
                            .line_height(sp(16.0))
                            .text_color(theme.text_secondary)
                            .whitespace_normal()
                            .child(SharedString::from(permission.detail.clone())),
                    )
                    .child(buttons),
            ),
        )
    }

    fn render_user_input(&self, pending: PendingUserInput, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(question) = pending.current_question().cloned() else {
            return div();
        };
        let selected = pending
            .selections
            .get(&question.id)
            .cloned()
            .unwrap_or_default();
        let has_custom = pending
            .custom_answers
            .get(&question.id)
            .is_some_and(|answer| !answer.trim().is_empty());
        let can_continue = has_custom || !selected.is_empty();
        let is_last = pending.question_index + 1 == pending.questions.len();
        let request_id = pending.request_id.clone();
        let question_index = pending.question_index;
        let mut options = div().mt(px(9.0)).flex().flex_col().gap(px(4.0));
        for (index, option) in question.options.iter().enumerate() {
            let is_selected = selected.iter().any(|answer| answer == &option.label);
            let click_label = option.label.clone();
            let key_label = option.label.clone();
            let focus = self.transcript_control_focus(
                format!("user-input-{request_id}-{question_index}-option-{index}"),
                cx,
            );
            options = options.child(
                div()
                    .id(SharedString::from(format!(
                        "user-input-{request_id}-{question_index}-option-{index}"
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .tab_stop(true)
                    .min_h(px(36.0))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(if is_selected {
                        theme.accent.opacity(0.34)
                    } else {
                        theme.border.opacity(0.0)
                    })
                    .bg(if is_selected {
                        theme.accent.opacity(0.08)
                    } else {
                        theme.overlay
                    })
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .cursor_default()
                    .focus_visible(|style| style.border_color(theme.accent))
                    .when(!is_selected, |row| {
                        row.hover(|style| style.border_color(theme.border).bg(theme.overlay_strong))
                    })
                    .active(|style| style.opacity(0.85))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(SharedString::from(option.label.clone())),
                            )
                            .children(option.description.as_ref().map(|description| {
                                div()
                                    .mt(px(1.0))
                                    .text_size(sp(12.5))
                                    .line_height(sp(15.0))
                                    .text_color(theme.text_secondary)
                                    .whitespace_normal()
                                    .child(SharedString::from(description.clone()))
                            })),
                    )
                    .when(is_selected, |row| {
                        row.child(icon("icons/check.svg", 12.0, theme.accent))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_user_input_option(click_label.clone(), cx);
                    }))
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.select_user_input_option(key_label.clone(), cx);
                            cx.stop_propagation();
                        }
                    })),
            );
        }

        let next_focus = self.transcript_control_focus(
            format!("user-input-{request_id}-{question_index}-continue"),
            cx,
        );
        let back = (question_index > 0).then(|| {
            let focus = self.transcript_control_focus(
                format!("user-input-{request_id}-{question_index}-back"),
                cx,
            );
            div()
                .id(SharedString::from(format!(
                    "user-input-{request_id}-{question_index}-back"
                )))
                .track_focus(&focus)
                .tab_index(0)
                .tab_stop(true)
                .h(px(26.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .cursor_default()
                .text_size(sp(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_tertiary)
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .hover(|style| style.bg(theme.overlay).text_color(theme.text_secondary))
                .active(|style| style.opacity(0.8))
                .child(tr!("user_input.back"))
                .on_click(cx.listener(|this, _, _, cx| this.previous_user_input(cx)))
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        this.previous_user_input(cx);
                        cx.stop_propagation();
                    }
                }))
        });
        let continue_button = div()
            .id(SharedString::from(format!(
                "user-input-{request_id}-{question_index}-continue"
            )))
            .track_focus(&next_focus)
            .tab_index(0)
            .tab_stop(can_continue)
            .h(px(26.0))
            .px(px(10.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .cursor_default()
            .text_size(sp(12.5))
            .font_weight(FontWeight::SEMIBOLD)
            .bg(if can_continue {
                theme.inverse
            } else {
                theme.overlay
            })
            .text_color(if can_continue {
                theme.on_inverse
            } else {
                theme.text_ghost
            })
            .when(can_continue, |button| {
                button
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.opacity(0.9))
                    .active(|style| style.opacity(0.8))
                    .on_click(cx.listener(|this, _, _, cx| this.advance_user_input(cx)))
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.advance_user_input(cx);
                            cx.stop_propagation();
                        }
                    }))
            })
            .child(if is_last {
                tr!("user_input.submit")
            } else {
                tr!("user_input.next")
            });

        let progress = (pending.questions.len() > 1).then(|| {
            div()
                .h(px(18.0))
                .px(px(6.0))
                .rounded(px(5.0))
                .bg(theme.overlay)
                .flex()
                .items_center()
                .text_size(sp(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_tertiary)
                .child(tr!(
                    "user_input.progress",
                    current = question_index + 1,
                    total = pending.questions.len()
                ))
        });

        div().flex_none().px(px(20.0)).pb(px(8.0)).child(
            div()
                .id(SharedString::from(format!("user-input-{request_id}")))
                .w_full()
                .max_w(px(CONTENT_MAX_WIDTH))
                .mx_auto()
                .px(px(14.0))
                .pt(px(12.0))
                .pb(px(10.0))
                .rounded(px(13.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.composer)
                .tab_index(0)
                .tab_group()
                .tab_stop(false)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_tertiary)
                                .child(SharedString::from(question.header.clone())),
                        )
                        .children(progress),
                )
                .child(
                    div()
                        .mt(px(5.0))
                        .text_size(sp(13.0))
                        .line_height(sp(18.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .whitespace_normal()
                        .child(SharedString::from(question.question.clone())),
                )
                .children((!question.options.is_empty()).then_some(options))
                .child(
                    div()
                        .mt(px(if question.options.is_empty() {
                            9.0
                        } else {
                            4.0
                        }))
                        .h(px(34.0))
                        .px(px(10.0))
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(if has_custom {
                            theme.accent.opacity(0.34)
                        } else {
                            theme.border.opacity(0.0)
                        })
                        .bg(if has_custom {
                            theme.accent.opacity(0.06)
                        } else {
                            theme.overlay
                        })
                        .flex()
                        .items_center()
                        .gap(px(7.0))
                        .text_size(sp(12.5))
                        .line_height(sp(16.0))
                        .child(icon(
                            "icons/pencil.svg",
                            11.0,
                            if has_custom {
                                theme.accent
                            } else {
                                theme.text_ghost
                            },
                        ))
                        .child(self.user_input_answer.clone()),
                )
                .child(
                    div()
                        .mt(px(8.0))
                        .flex()
                        .items_center()
                        .children(back)
                        .child(div().flex_1())
                        .child(continue_button),
                ),
        )
    }

    fn render_computer_permission(
        &self,
        permission: &PendingComputerApproval,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let target = &permission.target;
        let mut buttons = div().mt(px(12.0)).flex().items_center().gap(px(8.0));
        let mut options = vec![
            ("task", tr!("computer_use.allow_for_task"), true),
            ("deny", tr!("common.deny"), false),
        ];
        if target.persistable() {
            options.insert(1, ("always", tr!("computer_use.always_allow_app"), false));
        }
        for (decision, label, primary) in options {
            buttons = buttons.child(
                div()
                    .id(SharedString::from(format!(
                        "computer-permission-{}-{decision}",
                        permission.request.call_id
                    )))
                    .h(px(29.0))
                    .px(px(13.0))
                    .rounded(px(7.0))
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .when(primary, |element| {
                        element
                            .bg(theme.inverse)
                            .text_color(theme.on_inverse)
                            .hover(|element| element.opacity(0.9))
                    })
                    .when(!primary, |element| {
                        element
                            .border_1()
                            .border_color(theme.border_strong)
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay).text_color(theme.text))
                    })
                    .active(|element| element.opacity(0.8))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.respond_computer_permission(decision, cx);
                    })),
            );
        }

        div().px(px(20.0)).pb(px(8.0)).child(
            div()
                .w_full()
                .max_w(px(CONTENT_MAX_WIDTH))
                .mx_auto()
                .p(px(13.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(theme.warning.opacity(0.5))
                .bg(theme.raised)
                .shadow_md()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(9.0))
                        .child(icon("icons/globe.svg", 14.0, theme.warning))
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(tr!("computer_use.allow_control", app = &target.app_name)),
                        ),
                )
                .child(
                    div()
                        .mt(px(7.0))
                        .text_size(sp(12.5))
                        .line_height(sp(14.0))
                        .text_color(theme.text_secondary)
                        .child(tr!("computer_use.screenshot_shared")),
                )
                .child(
                    div()
                        .mt(px(8.0))
                        .p(px(9.0))
                        .rounded(px(8.0))
                        .bg(theme.inset)
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .truncate()
                                .child(SharedString::from(target.window_title.clone())),
                        )
                        .child(
                            div()
                                .mt(px(4.0))
                                .text_size(sp(12.5))
                                .text_color(theme.text_secondary)
                                .child(SharedString::from(permission.request.summary())),
                        )
                        .when(permission.sensitive, |element| {
                            element.child(
                                div()
                                    .mt(px(5.0))
                                    .text_size(sp(12.5))
                                    .text_color(theme.warning)
                                    .child(tr!("computer_use.sensitive_action")),
                            )
                        }),
                )
                .child(
                    div()
                        .mt(px(7.0))
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(if target.persistable() {
                            tr!("computer_use.bundle_id", id = &target.bundle_id)
                        } else {
                            tr!("computer_use.no_bundle_id")
                        }),
                )
                .child(buttons),
        )
    }

    pub(super) fn render_computer_use_overlay(&self, cx: &mut Context<Self>) -> Option<Div> {
        let previews = self
            .selected_runtime()?
            .computer_use_previews
            .iter()
            .filter(|state| state.visible && state.phase != ComputerUsePhase::AwaitingApproval)
            .collect::<Vec<_>>();
        if previews.is_empty() {
            return None;
        }
        let theme = Theme::current(cx);
        let stack_x_offset = 14.0;
        let stack_y_offset = 24.0;
        let deepest_x_offset = (previews.len().saturating_sub(1) as f32) * stack_x_offset;
        let deepest_y_offset = (previews.len().saturating_sub(1) as f32) * stack_y_offset;
        let top_index = previews.len() - 1;
        let cards = previews
            .into_iter()
            .enumerate()
            .filter_map(|(index, state)| {
                let target = state.target.as_ref()?;
                let window_id = target.window_id;
                let app_name = target.app_name.clone();
                let app_initial = app_name.chars().next().unwrap_or('W').to_string();
                let title = target.window_title.clone();
                let screenshot = state.screenshot.clone();
                let active = state.phase == ComputerUsePhase::Running;
                let failed = state.phase == ComputerUsePhase::Failed;
                let is_top = index == top_index;
                let depth = (top_index - index) as f32;
                let x_offset = depth * stack_x_offset;
                let y_offset = depth * stack_y_offset;
                let status_color = if failed {
                    theme.danger
                } else if active {
                    theme.warning
                } else {
                    theme.accent
                };
                let status = if failed {
                    tr!("computer_use.stopped")
                } else if active {
                    tr!("computer_use.controlling")
                } else {
                    tr!("computer_use.captured")
                };

                Some(
                    div()
                        .id(SharedString::from(format!(
                            "computer-use-preview-{window_id}"
                        )))
                        .absolute()
                        .right(px(x_offset))
                        .bottom(px(y_offset))
                        .w(px(304.0))
                        .h(px(220.0))
                        .p(px(6.0))
                        .rounded(px(16.0))
                        .overflow_hidden()
                        .border_1()
                        .border_color(if is_top {
                            theme.border_strong
                        } else {
                            theme.border
                        })
                        .bg(theme.raised)
                        .shadow_lg()
                        .cursor_default()
                        .when(!is_top, |element| element.opacity(0.96))
                        .child(
                            div()
                                .h(px(38.0))
                                .px(px(5.0))
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .w(px(27.0))
                                        .h(px(27.0))
                                        .rounded(px(7.0))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .bg(theme.overlay_strong)
                                        .text_size(sp(12.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_secondary)
                                        .child(SharedString::from(app_initial)),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(
                                            div()
                                                .text_size(sp(12.5))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text)
                                                .truncate()
                                                .child(SharedString::from(app_name)),
                                        )
                                        .child(
                                            div()
                                                .mt(px(1.0))
                                                .text_size(sp(12.5))
                                                .text_color(theme.text_tertiary)
                                                .truncate()
                                                .child(SharedString::from(title)),
                                        ),
                                )
                                .when(is_top, |element| {
                                    element.child(
                                        div()
                                            .id(SharedString::from(format!(
                                                "computer-use-preview-action-{window_id}"
                                            )))
                                            .h(px(27.0))
                                            .px(px(10.0))
                                            .rounded(px(7.0))
                                            .border_1()
                                            .border_color(theme.border_strong)
                                            .flex()
                                            .items_center()
                                            .cursor_default()
                                            .text_size(sp(12.5))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(if active {
                                                theme.danger
                                            } else {
                                                theme.text_secondary
                                            })
                                            .hover(|element| element.bg(theme.overlay))
                                            .active(|element| element.opacity(0.8))
                                            .child(if active {
                                                tr!("computer_use.take_control")
                                            } else {
                                                tr!("common.close")
                                            })
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                if active {
                                                    this.cancel_turn(cx);
                                                } else {
                                                    this.dismiss_computer_use(window_id, cx);
                                                }
                                            })),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .relative()
                                .h(px(170.0))
                                .w_full()
                                .rounded(px(11.0))
                                .overflow_hidden()
                                .bg(rgb(0x101010))
                                .when_some(screenshot, |element, screenshot| {
                                    element.child(
                                        img(screenshot)
                                            .w_full()
                                            .h_full()
                                            .object_fit(ObjectFit::Contain),
                                    )
                                })
                                .when(state.screenshot.is_none(), |element| {
                                    element.child(
                                        div()
                                            .absolute()
                                            .inset_0()
                                            .flex()
                                            .flex_col()
                                            .items_center()
                                            .justify_center()
                                            .gap(px(9.0))
                                            .child(
                                                div()
                                                    .w(px(34.0))
                                                    .h(px(23.0))
                                                    .rounded(px(5.0))
                                                    .border_1()
                                                    .border_color(theme.text_tertiary)
                                                    .child(
                                                        div()
                                                            .mt(px(4.0))
                                                            .ml(px(25.0))
                                                            .w(px(3.0))
                                                            .h(px(3.0))
                                                            .rounded_full()
                                                            .bg(status_color),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .text_size(sp(12.5))
                                                    .text_color(theme.text_tertiary)
                                                    .child(tr!("computer_use.preparing_preview")),
                                            ),
                                    )
                                })
                                .child(
                                    div()
                                        .absolute()
                                        .top(px(8.0))
                                        .left(px(8.0))
                                        .h(px(24.0))
                                        .px(px(8.0))
                                        .rounded_full()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .bg(theme.canvas.opacity(0.86))
                                        .border_1()
                                        .border_color(theme.border)
                                        .child(
                                            div()
                                                .w(px(6.0))
                                                .h(px(6.0))
                                                .rounded_full()
                                                .bg(status_color),
                                        )
                                        .child(
                                            div()
                                                .text_size(sp(12.5))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text)
                                                .child(status),
                                        ),
                                ),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.bring_computer_use_to_front(window_id, cx);
                        })),
                )
            })
            .collect::<Vec<_>>();

        Some(
            div()
                .absolute()
                .right(px(16.0))
                .bottom(px(82.0))
                .w(px(304.0 + deepest_x_offset))
                .h(px(220.0 + deepest_y_offset))
                .children(cards),
        )
    }

    // ── Composer ───────────────────────────────────────────────────────────

    /// The tide provider entries for the picker rail, derived from the loaded
    /// provider list — one row per configured tide provider, in config order.
    pub(super) fn tide_provider_rail_rows(
        &self,
    ) -> Vec<(String, String, &'static str, &'static str, usize)> {
        self.tide
            .providers
            .iter()
            .map(|provider| {
                let (logo, accent) =
                    crate::app::tide_providers::brand_for(&provider.base_url, &provider.api_style);
                (
                    provider.id.clone(),
                    provider.name.clone(),
                    logo,
                    accent,
                    provider.models.len(),
                )
            })
            .collect()
    }

    /// The composer's model chip: the trigger, plus the shared model picker
    /// popover bound to the selected session — its provider opens the rail,
    /// its model is the checked row, and picking sets the session's model.
    pub(super) fn render_provider_model_control(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let session = self.selected_session();
        let provider = session.map(|session| session.provider).unwrap_or_default();
        let selected_model = session.and_then(|session| self.model_for_session(session));
        let selected_model_name = self.model_display_name(provider, selected_model);
        // The chip wears the active provider's mark. For Tide that is the
        // brand tile of the sub-provider owning the selected model (the id
        // prefix) — the picker rail's accent-filled rounded tile at chip
        // scale — falling back to tide's generic tide glyph when unresolved.
        let tide_brand = (provider == ProviderKind::Tide)
            .then(|| {
                selected_model
                    .and_then(|model| model.split_once('/'))
                    .and_then(|(prefix, _)| {
                        self.tide
                            .providers
                            .iter()
                            .find(|tide_provider| tide_provider.id == prefix)
                    })
                    .map(|tide_provider| {
                        crate::app::tide_providers::brand_for(
                            &tide_provider.base_url,
                            &tide_provider.api_style,
                        )
                    })
            })
            .flatten();
        let trigger_tile = tide_brand.map(|(logo, accent)| {
            crate::ui::brand::brand_tile(logo, accent, 16.0, 10.0, &theme).into_any_element()
        });
        let trigger_icon = provider_icon(provider);
        let trigger_tint = provider_color(&theme, provider).opacity(0.9);
        let picker_enabled = session.is_some_and(|session| session.can_choose_model(provider));

        if !picker_enabled {
            return div()
                .h(px(24.0))
                .px(px(7.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    trigger_tile.unwrap_or_else(|| {
                        icon(trigger_icon, 10.5, trigger_tint).into_any_element()
                    }),
                )
                .child(
                    div()
                        .max_w(px(210.0))
                        .truncate()
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(selected_model_name)),
                )
                .into_any_element();
        }

        // With nothing to pick from, naming a model the app cannot run would
        // be a lie. The chip says so instead, and stays a trigger because the
        // panel behind it is where the fix lives. Icon plus wording carry the
        // state on their own, so the warning tint is never the only signal.
        let no_providers = self.model_picker_has_no_providers();
        let config = ModelPickerConfig {
            active: selected_model.map(|model| (provider, model.to_owned())),
            refocus_composer_on_close: true,
        };
        self.render_model_picker(
            SharedString::from(MODEL_PICKER_MENU_ID),
            config,
            None,
            Rc::new(
                |this: &mut Tide, provider: ProviderKind, model: String, cx: &mut Context<Tide>| {
                    this.choose_model(provider, model, cx);
                },
            ),
            MenuAlign::AboveLeft,
            move |open| {
                let chip = if no_providers {
                    MenuChip::new("composer-provider-model")
                        .icon("icons/alert.svg", theme.warning)
                        .label(tr!("models.no_providers"))
                } else if let Some(tile) = trigger_tile {
                    MenuChip::new("composer-provider-model")
                        .leading_element(tile)
                        .label(selected_model_name)
                } else {
                    MenuChip::new("composer-provider-model")
                        .icon(trigger_icon, trigger_tint)
                        .label(selected_model_name)
                };
                chip.caret(false).selected(open)
            },
            cx,
        )
    }

    pub(super) fn render_model_traits_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let session = self.selected_session()?;
        let model = self.model_metadata_for_session(session)?;
        if model.reasoning_efforts.is_empty()
            && model.service_tiers.is_empty()
            && model.context_windows.is_empty()
        {
            return None;
        }

        let selected_effort = session
            .reasoning_effort
            .as_deref()
            .filter(|selected| {
                model
                    .reasoning_efforts
                    .iter()
                    .any(|option| option.id == *selected)
            })
            .or(model.default_reasoning_effort.as_deref())
            .or_else(|| {
                model
                    .reasoning_efforts
                    .first()
                    .map(|option| option.id.as_str())
            })
            .map(str::to_owned);
        // The effort reads as a tier badge — uppercase in both the chip and
        // the menu rows so the selected state matches the options.
        let effort_label = selected_effort.as_deref().and_then(|selected| {
            model
                .reasoning_efforts
                .iter()
                .find(|option| option.id == selected)
                .map(|option| option.label.to_uppercase())
        });

        let selected_tier = session
            .service_tier
            .as_deref()
            .filter(|selected| {
                *selected == "default"
                    || model
                        .service_tiers
                        .iter()
                        .any(|option| option.id == *selected)
            })
            .or(model.default_service_tier.as_deref())
            .unwrap_or("default")
            .to_owned();
        let tier_label = if selected_tier == "default" {
            tr!("models.standard")
        } else {
            model
                .service_tiers
                .iter()
                .find(|option| option.id == selected_tier)
                .map(|option| option.label.clone())
                .unwrap_or_else(|| selected_tier.clone())
        };
        let selected_window = session
            .context_window
            .as_deref()
            .filter(|selected| {
                model
                    .context_windows
                    .iter()
                    .any(|option| option.id == *selected)
            })
            .or(model.default_context_window.as_deref())
            .or_else(|| {
                model
                    .context_windows
                    .first()
                    .map(|option| option.id.as_str())
            })
            .map(str::to_owned);
        // A non-default window changes what the session costs and how much it
        // can hold, so it reads on the chip rather than only inside the menu.
        let window_label = selected_window
            .as_deref()
            .filter(|selected| model.default_context_window.as_deref() != Some(selected))
            .and_then(|selected| {
                model
                    .context_windows
                    .iter()
                    .find(|option| option.id == selected)
                    .map(|option| option.label.clone())
            });

        let fast = selected_tier == "fast" || tier_label.eq_ignore_ascii_case("fast");
        let has_effort = effort_label.is_some();
        let trigger_label = match (
            effort_label.unwrap_or_else(|| tier_label.clone()),
            window_label,
        ) {
            (label, Some(window)) => format!("{label} · {window}"),
            (label, None) => label,
        };
        let reasoning_efforts = model.reasoning_efforts.clone();
        let default_effort = model.default_reasoning_effort.clone();
        let service_tiers = model.service_tiers.clone();
        let context_windows = model.context_windows.clone();
        let default_window = model.default_context_window.clone();
        let default_tier = model
            .default_service_tier
            .clone()
            .unwrap_or_else(|| "default".to_owned());
        let weak = cx.entity().downgrade();
        let handle = self.menu_handle("model-traits", cx);
        Some(dropdown_menu(
            MenuChip::new("model-traits")
                // The chip is primarily the reasoning selector: brain whenever
                // an effort is the label; the fast tier's zap still overrides.
                .when(has_effort, |trigger| {
                    trigger.icon("icons/brain.svg", theme.text_tertiary)
                })
                .when(fast, |trigger| {
                    trigger.icon("icons/zap.svg", theme.text_secondary)
                })
                .label(trigger_label)
                .caret(false)
                .selected(handle.is_open()),
            "model-traits-menu",
            &handle,
            MenuAlign::AboveLeft,
            move |_| {
                let mut items = Vec::new();
                if !reasoning_efforts.is_empty() {
                    items.push(MenuItem::Header(tr!("models.reasoning").into()));
                    for option in reasoning_efforts.clone() {
                        let weak = weak.clone();
                        let effort = option.id;
                        let is_default = default_effort.as_deref() == Some(effort.as_str());
                        let selected = selected_effort.as_deref() == Some(effort.as_str());
                        items.push(
                            traits_choice(theme, option.label.to_uppercase(), is_default, selected)
                                .on_click(move |_, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.set_reasoning_effort(effort.clone(), cx);
                                    });
                                }),
                        );
                    }
                }
                if !service_tiers.is_empty() {
                    if !reasoning_efforts.is_empty() {
                        items.push(MenuItem::Separator);
                    }
                    items.push(MenuItem::Header(tr!("models.service_tier").into()));
                    let weak_standard = weak.clone();
                    items.push(
                        traits_choice(
                            theme,
                            tr!("models.standard"),
                            default_tier == "default",
                            selected_tier == "default",
                        )
                        .on_click(move |_, cx| {
                            let _ = weak_standard.update(cx, |this, cx| {
                                this.set_service_tier("default".to_owned(), cx);
                            });
                        }),
                    );
                    for option in service_tiers.clone() {
                        let weak = weak.clone();
                        let tier = option.id;
                        let is_default = default_tier == tier;
                        let selected = selected_tier == tier;
                        items.push(
                            traits_choice(theme, option.label, is_default, selected).on_click(
                                move |_, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.set_service_tier(tier.clone(), cx);
                                    });
                                },
                            ),
                        );
                    }
                }
                if !context_windows.is_empty() {
                    if !reasoning_efforts.is_empty() || !service_tiers.is_empty() {
                        items.push(MenuItem::Separator);
                    }
                    items.push(MenuItem::Header(tr!("models.context_window").into()));
                    for option in context_windows.clone() {
                        let weak = weak.clone();
                        let window = option.id;
                        let is_default = default_window.as_deref() == Some(window.as_str());
                        let selected = selected_window.as_deref() == Some(window.as_str());
                        items.push(
                            traits_choice(theme, option.label, is_default, selected).on_click(
                                move |_, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.set_context_window(window.clone(), cx);
                                    });
                                },
                            ),
                        );
                    }
                }
                items
            },
        ))
    }

    pub(super) fn render_interaction_mode_control(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let mode = self
            .selected_session()
            .map(|session| session.interaction_mode)
            .unwrap_or_default();
        let next_mode = if mode == InteractionMode::Plan {
            InteractionMode::Build
        } else {
            InteractionMode::Plan
        };
        let weak = cx.entity().downgrade();
        div()
            .id("interaction-mode")
            .h(px(24.0))
            .px(px(7.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .cursor_default()
            .text_size(sp(12.5))
            .line_height(sp(14.0))
            .text_color(if mode == InteractionMode::Plan {
                theme.accent
            } else {
                theme.text_secondary
            })
            .child(icon(
                if mode == InteractionMode::Plan {
                    "icons/list.svg"
                } else {
                    "icons/wrench.svg"
                },
                10.5,
                if mode == InteractionMode::Plan {
                    theme.accent
                } else {
                    theme.text_tertiary
                },
            ))
            .child(mode.label())
            .hover(|element| element.bg(theme.overlay))
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, |this, cx| {
                    this.set_interaction_mode(next_mode, cx);
                });
            })
            .into_any_element()
    }

    /// The thread-goal chip: present only while the provider reports a goal,
    /// it pairs a target icon with the status phrase (and budget consumption)
    /// and opens the goal dialog. `/goal` is the keyboard route to the same
    /// surface.
    pub(super) fn render_goal_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let session = self.selected_session()?;
        let goal = session.thread_goal.as_ref()?;
        let session_id = session.id;
        let theme = Theme::current(cx);
        let color = super::goal_dialog::goal_status_color(goal.status, &theme);
        // Elapsed pursuit time accrues only while a turn actually runs,
        // matching how the provider accounts it.
        let live_elapsed_seconds = (goal.status == crate::model::ThreadGoalStatus::Active
            && session.is_busy())
        .then(|| self.goal_observed_at.get(&session_id))
        .flatten()
        .map_or(0, |observed| observed.elapsed().as_secs() as i64);
        let label = super::goal_dialog::goal_chip_label(goal, live_elapsed_seconds);
        let objective = goal.objective.clone();
        let weak = cx.entity().downgrade();
        Some(
            div()
                .id("composer-goal")
                .h(px(24.0))
                .px(px(7.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .cursor_default()
                .text_size(sp(12.5))
                .line_height(sp(14.0))
                .text_color(color)
                .child(icon("icons/target.svg", 10.5, color))
                .child(div().max_w(px(220.0)).truncate().child(label))
                .hover(|element| element.bg(theme.overlay))
                .tooltip(Tooltip::text(objective))
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.request_goal_dialog(session_id, None, false, cx);
                    });
                })
                .into_any_element(),
        )
    }

    /// Stage files dropped onto the composer as attachment chips. The mention
    /// each chip will submit takes the autocomplete's form: relative to the
    /// project root when the file is inside it, absolute otherwise,
    /// directories with a trailing slash.
    pub(super) fn stage_dropped_files(
        &mut self,
        paths: &ExternalPaths,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.stage_attachment_paths(paths.paths(), cx) {
            return;
        }
        let focus = self.composer.read(cx).focus();
        window.focus(&focus, cx);
    }

    fn stage_attachment_paths(&mut self, paths: &[PathBuf], cx: &mut Context<Self>) -> bool {
        if paths.is_empty() {
            return false;
        }
        let paths = paths.to_vec();
        let daemon = self.daemon.clone();
        let draft_owner = self.selected_composer_draft_key();
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let mut stored = Vec::with_capacity(paths.len());
                    for source_path in paths {
                        let (name, upload, image_bytes) =
                            attachment_upload_from_path(&source_path)?;
                        let is_image = image_bytes.is_some();
                        let preview_image = image_bytes.and_then(|bytes| {
                            image_preview::image_format_for_name(&name)
                                .map(|format| Arc::new(gpui::Image::from_bytes(format, bytes)))
                        });
                        let response = daemon.client().request(
                            Uuid::nil(),
                            Uuid::nil(),
                            client::Command::ImportAttachment { name, upload },
                        )?;
                        let client::ResponsePayload::AttachmentStored { attachment } = response
                        else {
                            anyhow::bail!("the daemon returned an invalid attachment response");
                        };
                        stored.push((attachment, preview_image, is_image));
                    }
                    Ok::<_, anyhow::Error>(stored)
                })
                .await;
            let _ = tide.update(cx, |tide, cx| match result {
                Ok(stored) => {
                    if tide.selected_composer_draft_key() != draft_owner {
                        return;
                    }
                    let mut changed = false;
                    for (attachment, preview_image, is_image) in stored {
                        changed |= tide.stage_daemon_attachment(
                            attachment.path,
                            attachment.name,
                            attachment.is_dir,
                            is_image,
                            attachment.reference,
                            preview_image,
                        );
                    }
                    if changed {
                        tide.schedule_composer_draft_save(cx);
                        cx.notify();
                    }
                }
                Err(error) => {
                    tide.show_toast(error.to_string());
                    cx.notify();
                }
            });
        })
        .detach();
        true
    }

    fn stage_daemon_attachment(
        &mut self,
        path: PathBuf,
        name: String,
        is_dir: bool,
        is_image: bool,
        reference: String,
        client_preview_image: Option<Arc<gpui::Image>>,
    ) -> bool {
        if self.composer_attachments.iter().any(|attachment| {
            attachment.path == path
                || attachment.blob_reference.as_deref() == Some(reference.as_str())
        }) {
            return false;
        }
        let mut mention = path.display().to_string();
        if is_dir && !mention.ends_with('/') {
            mention.push('/');
        }
        self.composer_attachments.push(ComposerAttachment {
            path,
            client_preview_image,
            mention,
            name: SharedString::from(name),
            is_dir,
            is_image,
            blob_reference: Some(reference),
        });
        true
    }

    /// Stage the clipboard's primary image/file representation. On-disk paths
    /// reuse drop handling immediately; raw image bytes are copied into Tide's
    /// durable blob store on the background executor before their chip appears.
    pub(super) fn stage_pasted_attachments(
        &mut self,
        entries: Vec<ClipboardEntry>,
        cx: &mut Context<Self>,
    ) {
        let mut paths = Vec::new();
        let mut images = Vec::new();
        for entry in entries {
            match entry {
                ClipboardEntry::Image(image) if !image.bytes.is_empty() => images.push(image),
                ClipboardEntry::ExternalPaths(external) => {
                    paths.extend(external.paths().iter().cloned())
                }
                ClipboardEntry::String(_) | ClipboardEntry::Image(_) => {}
            }
        }
        self.stage_attachment_paths(&paths, cx);
        if images.is_empty() {
            return;
        }

        let daemon = self.daemon.clone();
        let draft_owner = self.selected_composer_draft_key();
        cx.spawn(async move |tide, cx| {
            let stored = cx
                .background_executor()
                .spawn(async move {
                    let image_count = images.len();
                    images
                        .into_iter()
                        .enumerate()
                        .map(|(index, image)| {
                            let preview_image = Arc::new(image);
                            let bytes = preview_image.bytes.clone();
                            let response = daemon
                                .client()
                                .request(
                                    Uuid::nil(),
                                    Uuid::nil(),
                                    client::Command::StoreBlob {
                                        mime_type: preview_image.format.mime_type().to_owned(),
                                        bytes,
                                    },
                                )
                                .map_err(|error| error.to_string())?;
                            let client::ResponsePayload::BlobStored { reference, path } = response
                            else {
                                return Err("the daemon returned an invalid blob response".into());
                            };
                            let extension = path
                                .extension()
                                .and_then(|extension| extension.to_str())
                                .unwrap_or("png");
                            let name = if image_count == 1 {
                                format!("image.{extension}")
                            } else {
                                format!("image-{}.{extension}", index + 1)
                            };
                            Ok::<_, String>((path, name, reference, preview_image))
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .await;
            let _ = tide.update(cx, |tide, cx| match stored {
                Ok(stored) => {
                    if tide.selected_composer_draft_key() != draft_owner {
                        return;
                    }
                    let mut staged = false;
                    for (path, name, reference, preview_image) in stored {
                        staged |= tide.stage_daemon_attachment(
                            path,
                            name,
                            false,
                            true,
                            reference,
                            Some(preview_image),
                        );
                    }
                    if staged {
                        tide.schedule_composer_draft_save(cx);
                        cx.notify();
                    }
                }
                Err(error) => {
                    tide.show_toast(tr!("errors.store_pasted_image", error = error));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The text and attachment presentation accepted from the composer. The
    /// stored prompt keeps its `@` mentions and visible command syntax, while
    /// sent-message UI uses `display_content` and retained attachment metadata.
    pub(super) fn submission_with_attachments(
        &mut self,
        prompt: &str,
        cx: &mut Context<Self>,
    ) -> Option<ComposerSubmission> {
        if self.execute_local_composer_command(prompt, cx) {
            return None;
        }
        // Nothing installed or switched on can run this. Refuse before the
        // draft is consumed, so the text and its attachments survive until a
        // provider is available — every send route lands here, so `enter`,
        // the button, and steering are all covered by this one check.
        if self.model_picker_has_no_providers() {
            return None;
        }
        for attachment in &self.composer_attachments {
            if let (Some(reference), Some(image)) = (
                attachment.blob_reference.as_ref(),
                attachment.client_preview_image.as_ref(),
            ) {
                self.remote_images
                    .borrow_mut()
                    .insert(reference.clone(), RemoteImageState::Ready(image.clone()));
            }
        }
        let attachments = self
            .composer_attachments
            .drain(..)
            .map(MessageAttachment::from)
            .collect::<Vec<_>>();
        let mentions = attachments
            .iter()
            .map(|attachment| attachment.mention.clone())
            .collect::<Vec<_>>();
        let submission = merged_submission(prompt, &mentions)?;
        let display_content = (!attachments.is_empty()).then(|| prompt.trim().to_owned());
        self.discard_current_composer_draft(cx);
        Some(ComposerSubmission {
            prompt: submission,
            display_content,
            attachments,
        })
    }

    pub(super) fn execute_local_composer_command(
        &mut self,
        prompt: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        self.execute_goal_composer_command(prompt, cx)
    }

    /// Bridge the tide-native `/goal` command without starting a turn. Reads
    /// run against the session's cached goal; mutations go to the daemon and
    /// echo back as `GoalUpdated` events.
    fn execute_goal_composer_command(&mut self, prompt: &str, cx: &mut Context<Self>) -> bool {
        use crate::composer_complete::GoalCommand;
        use crate::model::{GoalOperation, ThreadGoalStatus};
        let Some((session_id, command, current_goal)) =
            self.selected_session().and_then(|session| {
                let command = crate::composer_complete::parse_goal_submission(
                    prompt,
                    &self.slash_command_index,
                )?;
                Some((session.id, command, session.thread_goal.clone()))
            })
        else {
            return false;
        };
        match command {
            GoalCommand::Show | GoalCommand::Edit => {
                self.request_goal_dialog(session_id, None, false, cx);
            }
            GoalCommand::Pause => {
                self.dispatch_goal_operation(
                    session_id,
                    GoalOperation::Set {
                        objective: None,
                        status: Some(ThreadGoalStatus::Paused),
                        replace: false,
                    },
                    cx,
                );
            }
            GoalCommand::Resume => {
                self.dispatch_goal_operation(
                    session_id,
                    GoalOperation::Set {
                        objective: None,
                        status: Some(ThreadGoalStatus::Active),
                        replace: false,
                    },
                    cx,
                );
            }
            GoalCommand::Clear => {
                self.dispatch_goal_operation(session_id, GoalOperation::Clear, cx);
            }
            GoalCommand::Set(objective) => match &current_goal {
                // Replacing unfinished work needs a look at what it replaces;
                // the dialog carries the confirmation.
                Some(goal) if !goal.status.is_terminal() => {
                    self.request_goal_dialog(session_id, Some(objective), true, cx);
                }
                Some(_) | None => {
                    self.dispatch_goal_operation(
                        session_id,
                        GoalOperation::Set {
                            objective: Some(objective),
                            status: Some(ThreadGoalStatus::Active),
                            replace: current_goal.is_some(),
                        },
                        cx,
                    );
                }
            },
        }
        self.composer.update(cx, |input, cx| input.clear(cx));
        cx.notify();
        true
    }

    pub(super) fn restore_composer_submission(
        &mut self,
        submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        self.composer_attachments = submission
            .attachments
            .into_iter()
            .map(ComposerAttachment::from)
            .collect();
        let content = submission.display_content.unwrap_or(submission.prompt);
        self.composer
            .update(cx, |input, cx| input.set_content(content, cx));
        self.schedule_composer_draft_save(cx);
        cx.notify();
    }

    /// The pending follow-up queue between the transcript and the composer: a
    /// single card tucked against the composer's top edge, one row per queued
    /// message. A row pulls its text back into the composer on click and
    /// carries steer/remove/more controls on the right.
    pub(super) fn render_queued_messages(&self, cx: &mut Context<Self>) -> Option<Div> {
        let session_id = self.state.selected_session?;
        let session = self.selected_session()?;
        if session.queued_messages.is_empty() {
            return None;
        }
        let theme = Theme::current(cx);
        let steerable = self.session_can_steer(session);
        let mut list = div().flex().flex_col().py(px(4.0));
        for message in &session.queued_messages {
            let message_id = message.id;
            let content = if message.visible_content().trim().is_empty() {
                message
                    .attachments
                    .iter()
                    .map(|attachment| attachment.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                message.visible_content().to_owned()
            };
            let steer_control = steerable.then(|| {
                div()
                    .id(SharedString::from(format!(
                        "queued-message-steer-{message_id}"
                    )))
                    .h(px(24.0))
                    .px(px(7.0))
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .cursor_default()
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|element| element.bg(theme.overlay_strong))
                    .active(|element| element.opacity(0.8))
                    .text_size(sp(12.5))
                    .text_color(theme.text_secondary)
                    .child(icon(
                        "icons/corner-down-right.svg",
                        11.0,
                        theme.text_secondary,
                    ))
                    .child(tr!("composer.steer"))
                    .tooltip(Tooltip::text(tr!("composer.steer_current")))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.steer_queued_message(session_id, message_id, cx);
                    }))
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.steer_queued_message(session_id, message_id, cx);
                            cx.stop_propagation();
                        }
                    }))
            });
            let menu_handle = self.menu_handle(format!("queued-message-menu-{message_id}"), cx);
            let menu_open = menu_handle.is_open();
            let weak = cx.entity().downgrade();
            let more_control = dropdown_menu(
                div()
                    .id(SharedString::from(format!(
                        "queued-message-more-{message_id}"
                    )))
                    .w(px(24.0))
                    .h(px(24.0))
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .when(menu_open, |element| element.bg(theme.overlay_strong))
                    .hover(|element| element.bg(theme.overlay_strong))
                    .active(|element| element.opacity(0.8))
                    .child(icon("icons/ellipsis.svg", 12.5, theme.text_secondary)),
                SharedString::from(format!("queued-message-more-menu-{message_id}")),
                &menu_handle,
                MenuAlign::BelowRight,
                move |_| {
                    let edit_weak = weak.clone();
                    let remove_weak = weak.clone();
                    vec![
                        MenuItem::new(tr!("composer.edit_in_composer"), move |window, cx| {
                            let _ = edit_weak.update(cx, |this, cx| {
                                this.edit_queued_message(session_id, message_id, window, cx);
                            });
                        })
                        .icon("icons/pencil.svg"),
                        MenuItem::new(tr!("composer.remove_followup"), move |_, cx| {
                            let _ = remove_weak.update(cx, |this, cx| {
                                this.remove_queued_message(session_id, message_id, cx);
                            });
                        })
                        .icon("icons/trash.svg"),
                    ]
                },
            );
            list = list.child(
                div()
                    .id(SharedString::from(format!("queued-message-{message_id}")))
                    .h(px(30.0))
                    .pl(px(12.0))
                    .pr(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(9.0))
                    .cursor_default()
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|element| element.bg(theme.overlay))
                    .tooltip(Tooltip::text(tr!("composer.edit_in_composer")))
                    .child(icon("icons/queue.svg", 12.0, theme.text_tertiary))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.5))
                            .text_color(theme.text)
                            .child(SharedString::from(content)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.0))
                            .children(steer_control)
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "queued-message-remove-{message_id}"
                                    )))
                                    .w(px(24.0))
                                    .h(px(24.0))
                                    .rounded(px(6.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .cursor_default()
                                    .tab_index(0)
                                    .focus_visible(|style| {
                                        style.border_1().border_color(theme.accent)
                                    })
                                    .hover(|element| element.bg(theme.overlay_strong))
                                    .active(|element| element.opacity(0.8))
                                    .child(icon("icons/trash.svg", 12.0, theme.text_secondary))
                                    .tooltip(Tooltip::text(tr!("composer.remove_followup")))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.remove_queued_message(session_id, message_id, cx);
                                    }))
                                    .on_key_down(cx.listener(
                                        move |this, event: &KeyDownEvent, _, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.remove_queued_message(
                                                    session_id, message_id, cx,
                                                );
                                                cx.stop_propagation();
                                            }
                                        },
                                    )),
                            )
                            .child(more_control),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_queued_message(session_id, message_id, window, cx);
                    }))
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.edit_queued_message(session_id, message_id, window, cx);
                            cx.stop_propagation();
                        }
                    })),
            );
        }
        Some(
            div().flex_none().px(px(20.0)).child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .mx_auto()
                    .px(px(14.0))
                    .child(
                        div()
                            .rounded_tl(px(12.0))
                            .rounded_tr(px(12.0))
                            .border_t_1()
                            .border_l_1()
                            .border_r_1()
                            .border_color(theme.border)
                            .bg(theme.composer)
                            // Row hover fills are full-width rectangles; clip
                            // them to the card's rounded corners.
                            .overflow_hidden()
                            .child(list),
                    ),
            ),
        )
    }

    fn render_branch_selector(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let session = self.selected_session()?;
        let workspace = session.workspace.clone();
        let workspace_path = self.workspace_path_for_session(session)?.to_path_buf();
        self.selected_project()
            .filter(|project| !project.is_projectless())?;
        let branch_enabled = !session.is_busy() && !self.branch_operation_pending;
        let planned_worktree = matches!(workspace, SessionWorkspace::NewWorktree { .. });
        let pending = self.branch_operation_pending;

        let selected_from_snapshot = move |snapshot: &BranchSnapshot| {
            match &workspace {
                SessionWorkspace::Local => snapshot.display_branch().map(str::to_owned),
                SessionWorkspace::NewWorktree { base_branch } => base_branch
                    .clone()
                    .or_else(|| snapshot.default_branch.clone())
                    .or_else(|| snapshot.display_branch().map(str::to_owned)),
                SessionWorkspace::Worktree { branch, .. } => snapshot
                    .current
                    .clone()
                    .or_else(|| Some(branch.clone()))
                    .or_else(|| snapshot.detached_head.clone()),
            }
            .unwrap_or_else(|| tr!("branches.detached_head"))
        };

        self.render_branch_picker(
            BranchPickerContext {
                menu_id: BRANCH_PICKER_MENU_ID.into(),
                workspace_path,
                planned_worktree,
                surface: BranchPickerSurface::Composer,
            },
            branch_enabled,
            selected_from_snapshot,
            move |open, selected_branch| {
                MenuChip::new("workspace-branch")
                    .icon("icons/git-branch.svg", theme.text_tertiary)
                    .label(if pending {
                        tr!("branches.switching")
                    } else {
                        selected_branch.to_owned()
                    })
                    .caret(false)
                    .disabled(!branch_enabled)
                    .selected(branch_enabled && open)
                    .max_w(px(210.0))
            },
            MenuAlign::AboveLeft,
            cx,
        )
    }

    pub(super) fn render_workspace_footer(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let selected_project_id = self.state.selected_project;
        let projectless_selected = self.selected_project().is_some_and(Project::is_projectless);
        let project_name = self
            .selected_project()
            .map(|project| {
                if project.is_projectless() {
                    tr!("project.choose_project")
                } else {
                    project.display_name()
                }
            })
            .unwrap_or_else(|| tr!("project.choose_project"));
        let can_configure_workspace = self
            .selected_session()
            .is_some_and(|session| !session.has_started() && !session.is_busy());

        let project_handle = self.menu_handle("workspace-project", cx);
        let project_trigger = MenuChip::new("workspace-project")
            .icon("icons/folder.svg", theme.text_tertiary)
            .label(project_name)
            .caret(false)
            .disabled(!can_configure_workspace)
            .selected(can_configure_workspace && project_handle.is_open())
            .max_w(px(190.0));
        let project_selector = if can_configure_workspace {
            let project_options = self
                .state
                .projects
                .iter()
                .filter(|project| !project.is_projectless())
                .filter(|project| Some(project.id) == selected_project_id)
                .chain(
                    self.state
                        .projects
                        .iter()
                        .filter(|project| !project.is_projectless())
                        .filter(|project| Some(project.id) != selected_project_id),
                )
                .map(|project| (project.id, project.display_name()))
                .collect::<Vec<_>>();
            let weak = cx.entity().downgrade();
            dropdown_menu(
                project_trigger,
                "workspace-project-menu",
                &project_handle,
                MenuAlign::AboveLeft,
                move |_| {
                    let mut items = project_options
                        .clone()
                        .into_iter()
                        .map(|(project_id, project_name)| {
                            let weak = weak.clone();
                            MenuItem::new(project_name, move |_, cx| {
                                if Some(project_id) != selected_project_id {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.select_project_from_composer(project_id, cx);
                                    });
                                }
                            })
                            .selected(Some(project_id) == selected_project_id)
                        })
                        .collect::<Vec<_>>();
                    if !items.is_empty() {
                        items.push(MenuItem::Separator);
                    }
                    let add_project = weak.clone();
                    items.push(
                        MenuItem::new(tr!("project.new_project"), move |_, cx| {
                            let _ = add_project.update(cx, |this, cx| this.add_project(cx));
                        })
                        .icon("icons/folder-new.svg"),
                    );
                    let projectless = weak.clone();
                    items.push(
                        MenuItem::new(tr!("project.no_project"), move |_, cx| {
                            let _ = projectless.update(cx, |this, cx| {
                                if !this.selected_project().is_some_and(Project::is_projectless) {
                                    this.create_projectless_session_from_composer(cx);
                                }
                            });
                        })
                        .icon("icons/x.svg")
                        .selected(projectless_selected),
                    );
                    items
                },
            )
        } else {
            project_trigger.into_any_element()
        };

        let workspace = self
            .selected_session()
            .map(|session| session.workspace.clone())
            .unwrap_or_default();
        let workspace_label = match &workspace {
            SessionWorkspace::Local => SharedString::from(tr!("workspace.local")),
            SessionWorkspace::NewWorktree { .. } => {
                SharedString::from(tr!("workspace.new_worktree"))
            }
            SessionWorkspace::Worktree { branch, .. } => SharedString::from(branch.clone()),
        };
        let workspace_icon = if workspace.is_local() {
            "icons/laptop.svg"
        } else {
            "icons/fork.svg"
        };
        let worktree_handle = self.menu_handle("workspace-worktree", cx);
        let worktree_trigger = MenuChip::new("workspace-worktree")
            .icon(workspace_icon, theme.text_tertiary)
            .label(workspace_label)
            .caret(false)
            .disabled(!can_configure_workspace)
            .selected(can_configure_workspace && worktree_handle.is_open())
            .max_w(px(180.0));
        let worktree_selector = if can_configure_workspace {
            let local_selected = workspace.is_local();
            let worktree_selected = workspace.is_worktree();
            let weak = cx.entity().downgrade();
            dropdown_menu(
                worktree_trigger,
                "workspace-worktree-menu",
                &worktree_handle,
                MenuAlign::AboveLeft,
                move |_| {
                    let local = weak.clone();
                    let worktree = weak.clone();
                    vec![
                        MenuItem::Header(tr!("workspace.work_in").into()),
                        MenuItem::new(tr!("workspace.local"), move |_, cx| {
                            let _ = local.update(cx, |this, cx| {
                                this.select_workspace(SessionWorkspace::Local, cx);
                            });
                        })
                        .icon("icons/laptop.svg")
                        .selected(local_selected),
                        MenuItem::new(tr!("workspace.new_worktree"), move |_, cx| {
                            let _ = worktree.update(cx, |this, cx| {
                                this.select_workspace(
                                    SessionWorkspace::NewWorktree { base_branch: None },
                                    cx,
                                );
                            });
                        })
                        .icon("icons/fork.svg")
                        .selected(worktree_selected)
                        .disabled(projectless_selected),
                    ]
                },
            )
        } else {
            worktree_trigger.into_any_element()
        };

        let branch_selector = self.render_branch_selector(cx);

        let usage_meter = self.render_usage_meter(cx);
        div()
            .flex_none()
            .px(px(20.0))
            .pb(px(8.0))
            .pt(px(4.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .mx_auto()
                    .h(px(28.0))
                    // The chip contributes 7px, lining its icon up with the
                    // composer's 10px padding plus the controls' 7px inset.
                    .pl(px(10.0))
                    .pr(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .tab_index(0)
                    .tab_group()
                    .tab_stop(false)
                    .text_size(sp(12.5))
                    .line_height(sp(14.0))
                    .child(project_selector)
                    .child(worktree_selector)
                    .children(branch_selector)
                    .child(div().flex_1())
                    .children(usage_meter),
            )
    }
}

/// Branches matching the search, with the selected branch pinned first and
/// every other row sorted by name. Disabled worktree-owned rows stay in the
/// result; the UI needs to explain why Git cannot switch to them.
pub(super) fn visible_branch_entries(
    branches: &[crate::git_branch::BranchEntry],
    selected_branch: &str,
    normalized_query: &str,
) -> Vec<crate::git_branch::BranchEntry> {
    let normalized_query = normalized_query.to_ascii_lowercase();
    let mut visible = branches
        .iter()
        .filter(|branch| {
            normalized_query
                .split_whitespace()
                .all(|token| branch.name.to_ascii_lowercase().contains(token))
        })
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|left, right| {
        let left_selected = left.name == selected_branch;
        let right_selected = right.name == selected_branch;
        right_selected
            .cmp(&left_selected)
            .then_with(|| left.name.cmp(&right.name))
    });
    visible
}

/// The mention a dropped file submits: relative to the project root when the
/// file is inside it, absolute otherwise, directories with a trailing slash —
/// the same form the `@` autocomplete inserts. Dropping the root itself keeps
/// the absolute path rather than producing an empty mention.
// Base64 keeps the authenticated JSON transport browser-compatible but adds
// one third of wire overhead. Stay comfortably below tungstenite's default
// message limit until uploads move to a streaming content endpoint.
const MAX_ATTACHMENT_BYTES: u64 = client::attachments::MAX_ATTACHMENT_BYTES as u64;

/// Reads a client-local drop into an upload payload. This is the explicit
/// client/daemon boundary: none of these source paths are persisted or handed
/// to a provider.
fn attachment_upload_from_path(
    source: &Path,
) -> anyhow::Result<(
    String,
    client::attachments::AttachmentUpload,
    Option<Vec<u8>>,
)> {
    let metadata = std::fs::symlink_metadata(source)
        .with_context(|| format!("could not read attachment {}", source.display()))?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "symbolic-link attachments are not supported: {}",
            source.display()
        );
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow::anyhow!("attachment has no file name: {}", source.display()))?
        .to_owned();
    if metadata.is_file() {
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            anyhow::bail!("attachment is larger than 32 MB: {}", source.display());
        }
        let bytes = std::fs::read(source)
            .with_context(|| format!("could not read attachment {}", source.display()))?;
        let is_image = is_image_attachment_path(source);
        return Ok((
            name,
            client::attachments::AttachmentUpload::File {
                data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
            is_image.then_some(bytes),
        ));
    }
    if !metadata.is_dir() {
        anyhow::bail!(
            "attachment is not a file or directory: {}",
            source.display()
        );
    }

    let mut pending = vec![source.to_path_buf()];
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).with_context(|| {
            format!(
                "could not read attachment directory {}",
                directory.display()
            )
        })? {
            let entry = entry?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if entries.len() >= client::attachments::MAX_ATTACHMENT_FILES {
                anyhow::bail!(
                    "attachment directory contains more than {} files",
                    client::attachments::MAX_ATTACHMENT_FILES
                );
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > MAX_ATTACHMENT_BYTES {
                anyhow::bail!("attachment directory is larger than 32 MB");
            }
            let relative_path = path
                .strip_prefix(source)
                .context("attachment entry escaped its source directory")?
                .to_path_buf();
            let bytes = std::fs::read(&path)
                .with_context(|| format!("could not read attachment {}", path.display()))?;
            entries.push(client::attachments::AttachmentUploadEntry {
                relative_path,
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
    }
    Ok((
        name,
        client::attachments::AttachmentUpload::Directory { entries },
        None,
    ))
}

#[cfg(test)]
pub(super) fn dropped_file_mention(
    root: Option<&std::path::Path>,
    path: &std::path::Path,
    is_dir: bool,
) -> String {
    let mention = root
        .and_then(|root| path.strip_prefix(root).ok())
        .filter(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(path)
        .display()
        .to_string();
    if is_dir && !mention.ends_with('/') {
        format!("{mention}/")
    } else {
        mention
    }
}

fn is_image_attachment_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "svg"
                    | "tif"
                    | "tiff"
                    | "ico"
                    | "pnm"
                    | "pbm"
                    | "pgm"
                    | "ppm"
            )
        })
}

/// The prompt a submission sends: the typed text plus one `@` mention per
/// staged attachment, appended at the end the way T3 Code appends dropped
/// files. `None` means there is nothing to send.
pub(super) fn merged_submission(prompt: &str, mentions: &[String]) -> Option<String> {
    let mentions = mentions
        .iter()
        .map(|mention| {
            // A path containing whitespace is quoted so provider-side
            // mention scanners read one token, not one per word.
            if mention.chars().any(char::is_whitespace) {
                format!("@\"{mention}\"")
            } else {
                format!("@{mention}")
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let prompt = prompt.trim();
    match (prompt.is_empty(), mentions.is_empty()) {
        (true, true) => None,
        (false, true) => Some(prompt.to_owned()),
        (true, false) => Some(mentions),
        (false, false) => Some(format!("{prompt} {mentions}")),
    }
}

/// Where the picker's keyboard cursor lands, wrapping at both ends.
///
/// `None` for `current` means the cursor has not moved yet, so `down` opens on
/// the first row and `up` on the last. `None` in the result means the key does
/// not navigate.
pub(super) fn next_picker_highlight(
    current: Option<usize>,
    len: usize,
    key: &str,
) -> Option<usize> {
    if len == 0 {
        return None;
    }
    match key {
        "down" => Some(current.map_or(0, |index| (index + 1) % len)),
        "up" => Some(current.map_or(len - 1, |index| (index + len - 1) % len)),
        _ => None,
    }
}

/// The sidebar tabs the picker can land on, in rail order: favorites first,
/// then one tab per configured tide provider, in config order.
///
/// Shared by the rail's click gating and by `tab`'s cycle handler so the two
/// agree on which tabs are usable.
pub(super) fn visible_picker_tabs(
    tide_provider_rows: &[(String, String, &'static str, &'static str, usize)],
) -> Vec<ModelPickerTab> {
    let mut tabs = vec![ModelPickerTab::Favorites];
    tabs.extend(tide_provider_rows.iter().map(|(provider_id, _, _, _, _)| {
        ModelPickerTab::TideProvider(SharedString::from(provider_id.as_str()))
    }));
    tabs
}

/// The picker's whole body when nothing can back a session: no agent CLI
/// found on this machine, and none left switched on.
///
/// A rail holding a lone star above an empty filter field would invite the
/// user to search a list that cannot have rows, so the panel names what is
/// missing and offers the page that fixes it. Its one button also carries the
/// panel's focus, which is what `escape` dispatches up from.
pub(super) fn model_picker_empty_state(
    theme: &Theme,
    focus: &FocusHandle,
    popover: ContextMenuHandle,
    tide: WeakEntity<Tide>,
) -> AnyElement {
    let click_popover = popover.clone();
    let click_tide = tide.clone();
    div()
        .w(px(320.0))
        .rounded(px(13.0))
        .overflow_hidden()
        .border_1()
        .border_color(theme.border_strong)
        .bg(theme.raised)
        .shadow_lg()
        .child(
            crate::ui::empty_state::EmptyState::new(
                "icons/bot.svg",
                tr!("models.no_providers_title"),
            )
            .compact()
            .caption(tr!("models.no_providers_description"))
            .px(px(24.0))
            .py(px(22.0))
            .child(
                div()
                    .id("model-picker-open-providers")
                    .track_focus(focus)
                    .tab_index(0)
                    .tab_stop(true)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .mt(px(3.0))
                    .h(px(28.0))
                    .px(px(11.0))
                    .rounded(px(7.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .cursor_default()
                    .text_size(sp(12.5))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.overlay))
                    .child(icon("icons/settings.svg", 11.0, theme.text_tertiary))
                    .child(tr!("models.open_provider_settings"))
                    .on_click(move |_, window, cx| {
                        open_provider_settings_from_picker(&click_tide, &click_popover, window, cx);
                    })
                    .on_key_down(move |event: &KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            open_provider_settings_from_picker(&tide, &popover, window, cx);
                            cx.stop_propagation();
                        }
                    }),
            ),
        )
        .into_any_element()
}

/// Dismiss the picker and land on the Providers page, for both the empty
/// state's click and its keyboard activation. Closing first matters: the
/// picker returns focus to the composer as it closes, which would otherwise
/// pull focus straight back out of the settings view.
fn open_provider_settings_from_picker(
    tide: &WeakEntity<Tide>,
    popover: &ContextMenuHandle,
    window: &mut Window,
    cx: &mut App,
) {
    popover.close(window, cx);
    let _ = tide.update(cx, |this, cx| {
        this.open_settings_action(&OpenSettings, window, cx);
        this.open_settings_page(SettingsPage::Tide, cx);
    });
}

/// A tide model row's sub-line: provider · context · price, matching tide's
/// own selector.
pub(super) fn model_picker_subtitle(
    provider: ProviderKind,
    sub_provider: Option<&str>,
    model: Option<&ProviderModel>,
) -> String {
    let Some(model) = model else {
        return sub_provider
            .map(str::to_owned)
            .unwrap_or_else(|| provider.short_name().to_owned());
    };
    let base = match sub_provider.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => name.to_owned(),
        None => provider.short_name().to_owned(),
    };
    let context = super::tide_wizard::format_context(
        model
            .default_context_window
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
    );
    match &model.price_label {
        Some(price) => format!("{base} · {context} ctx · {price}"),
        None => format!("{base} · {context} ctx"),
    }
}

/// The models the picker lists, in display order.
///
/// Shared by the panel body and by `enter`'s handler so a keyboard cursor index
/// always means the same row in both.
pub(super) fn visible_picker_models(
    tide_models: &[ProviderModel],
    favorites: &[FavoriteModel],
    selected_tab: ModelPickerTab,
    normalized_query: &str,
) -> Vec<(ProviderKind, ProviderModel)> {
    let searching = !normalized_query.is_empty();
    let mut models = tide_models
        .iter()
        .cloned()
        .map(|model| (ProviderKind::Tide, model))
        .filter(|(_, model)| {
            if searching {
                let searchable = format!(
                    "{} {} {}",
                    model.name,
                    model.id,
                    model.sub_provider.as_deref().unwrap_or("")
                )
                .to_ascii_lowercase();
                return normalized_query
                    .split_whitespace()
                    .all(|token| searchable.contains(token));
            }
            match &selected_tab {
                ModelPickerTab::Favorites => favorites.iter().any(|favorite| {
                    favorite.provider == ProviderKind::Tide && favorite.model == model.id
                }),
                ModelPickerTab::TideProvider(provider_id) => {
                    model.id.starts_with(&format!("{provider_id}/"))
                }
            }
        })
        .collect::<Vec<_>>();
    if !searching && selected_tab == ModelPickerTab::Favorites {
        models.sort_by_key(|(_, model)| {
            favorites
                .iter()
                .position(|favorite| {
                    favorite.provider == ProviderKind::Tide && favorite.model == model.id
                })
                .unwrap_or(usize::MAX)
        });
    }
    models
}
