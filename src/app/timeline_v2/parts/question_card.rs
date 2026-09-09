//! The pending follow-up question card — tide's inline QuestionCard anatomy.
//! While the selected session's runtime waits on `ask_followup_question`
//! (`SessionRuntime::pending_user_input`), the pane renders this card as a
//! transient bottom section under the row list — v2's inline placement of the
//! state the legacy pane renders above the composer (`composer.rs`'s
//! `render_user_input`).
//!
//! The runtime's `PendingUserInput` is the single source of truth — per
//! question selections, the custom ("other") answer, and the current question
//! index — so the pane keeps no shadow copy of the answer: the card renders
//! the runtime's state and routes every click back through the same
//! `pub(super)` methods the legacy card drives (`select_user_input_option`,
//! `advance_user_input`). Submit therefore lands on the app's one answer
//! path: on the last question `advance_user_input` folds the runtime's
//! selections into `UserInputAnswer`s and hands them to the driver's
//! `respond_user_input(request_id, answers)`. The question model carries no
//! custom/free-text flag; like the legacy card, the custom-answer field
//! renders for every question (the model's `multi_select` decides single vs
//! multiple option picks, and both interplay with it are the runtime's).
//!
//! Keyboard focus traversal is v1-skipped, as is the legacy card's Back
//! stepper for multi-question requests.

use super::super::tools_dim;
use crate::input::TextInput;
use crate::model::{UserInputAnswer, UserInputOption, UserInputQuestion};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use gpui::prelude::*;
use gpui::{ClickEvent, Div, Entity, FontWeight, SharedString, Stateful, Window, div, px};
use std::sync::Arc;

// ── The folds, pure ──────────────────────────────────────────────────────────

/// Fold the card's current answer for one question — the pure spec of the
/// submit gate (an answer exists exactly when this returns non-empty
/// `answers`). A non-blank custom text wins, matching the runtime's own fold
/// in `PendingUserInput::answers`; otherwise the selected options' labels
/// answer, in option order whatever order the indices arrive in; nothing
/// selected and no custom text is no answer yet. Out-of-range indices
/// contribute nothing rather than panicking.
pub(crate) fn answer_for_selection(
    question_id: &str,
    options: &[UserInputOption],
    selected_indices: &[usize],
    custom_text: Option<&str>,
) -> UserInputAnswer {
    let answers = match custom_text.map(str::trim).filter(|text| !text.is_empty()) {
        Some(custom) => vec![custom.to_owned()],
        None => options
            .iter()
            .enumerate()
            .filter(|(ix, _)| selected_indices.contains(ix))
            .map(|(_, option)| option.label.clone())
            .collect(),
    };
    UserInputAnswer {
        question_id: question_id.to_owned(),
        answers,
    }
}

/// Map the runtime's selected labels back to option indices, in option order
/// (not click order); labels the options no longer carry — stale runtime
/// state from an older question — drop out rather than mis-render.
pub(crate) fn selected_indices(question: &UserInputQuestion, selected: &[String]) -> Vec<usize> {
    question
        .options
        .iter()
        .enumerate()
        .filter(|(_, option)| selected.contains(&option.label))
        .map(|(ix, _)| ix)
        .collect()
}

// ── Renderer ────────────────────────────────────────────────────────────────

/// One option pick, label-first — the group toggle's shape: `list.rs` builds
/// it where the view context lives, and the closure carries the label to the
/// runtime's `select_user_input_option` (which decides single- vs
/// multi-select behavior).
pub(crate) type SelectOption =
    Arc<dyn Fn(&str, &ClickEvent, &mut Window, &mut gpui::App) + 'static>;

/// One click the card may ask the app to perform: the submit button's action.
pub(crate) type QuestionCardAction =
    Arc<dyn Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static>;

/// Every behavior the card needs from the app: `select_option` toggles one
/// option's label; `submit` advances — to the next question or, on the last,
/// to the driver's `respond_user_input`.
#[derive(Clone)]
pub(crate) struct QuestionCardActions {
    pub select_option: SelectOption,
    pub submit: QuestionCardAction,
}

/// One option row: the radio dot (filled with the accent when chosen, ringed
/// otherwise) plus the label and its optional description — tide's bordered
/// option anatomy, hover-lit when unselected, accent-tinted when chosen.
pub(crate) fn render_option_row(
    option: &UserInputOption,
    selected: bool,
    id: &str,
    theme: &Theme,
    select: &SelectOption,
) -> Stateful<Div> {
    let label = option.label.clone();
    let select = Arc::clone(select);
    div()
        .id(SharedString::from(id))
        .min_h(px(36.0))
        .px(px(10.0))
        .py(px(5.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if selected {
            theme.accent.opacity(0.34)
        } else {
            theme.border.opacity(0.0)
        })
        .bg(if selected {
            theme.accent.opacity(0.08)
        } else {
            theme.overlay
        })
        .flex()
        .items_center()
        .gap(px(8.0))
        .cursor_default()
        .when(!selected, |row| {
            row.hover(|style| style.border_color(theme.border).bg(theme.overlay_strong))
        })
        .active(|style| style.opacity(0.85))
        .child(
            div()
                .size(px(14.0))
                .rounded_full()
                .border_1()
                .border_color(if selected {
                    theme.accent
                } else {
                    theme.border_strong
                })
                .when(selected, |dot| dot.bg(theme.accent)),
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
        .on_click(move |event, window, cx| select(&label, event, window, cx))
}

/// The submit action: a bordered row with the check glyph. Armed (an answer
/// exists) it hover-lights and clicks; unarmed it renders muted and inert —
/// the legacy continue button's gate, in tide's bordered style. `is_last`
/// picks the label: Submit on the final question, Next between questions.
pub(crate) fn render_submit_row(
    can_submit: bool,
    is_last: bool,
    id: &str,
    theme: &Theme,
    submit: &QuestionCardAction,
) -> Stateful<Div> {
    let submit = Arc::clone(submit);
    div()
        .id(SharedString::from(id))
        .h(px(26.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .flex()
        .items_center()
        .gap(px(5.0))
        .text_size(sp(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .border_1()
        .border_color(if can_submit {
            theme.accent.opacity(0.34)
        } else {
            theme.border.opacity(0.0)
        })
        .text_color(if can_submit {
            theme.text
        } else {
            theme.text_ghost
        })
        .when(can_submit, |row| {
            row.cursor_default()
                .hover(|style| style.bg(theme.overlay))
                .active(|style| style.opacity(0.8))
        })
        .child(icon(
            "icons/check.svg",
            12.0,
            if can_submit {
                theme.accent
            } else {
                theme.text_ghost
            },
        ))
        .child(if is_last {
            tr!("user_input.submit")
        } else {
            tr!("user_input.next")
        })
        .when(can_submit, |row| {
            row.on_click(move |event, window, cx| submit(event, window, cx))
        })
}

/// The whole card: header (the question's own header text, 11sp tools-dim),
/// the question, the option rows, the custom-answer field, and the submit
/// action — bordered, radius 8, on the raised surface. `selected` carries the
/// runtime's selected labels for this question and `custom_text` its custom
/// answer (the two sources the gate folds); `input` is the custom-answer
/// field entity (the app's one `user_input_answer` input, whose subscription
/// already writes typing through to the runtime and submits on Enter).
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_question_card(
    question: &UserInputQuestion,
    selected: &[String],
    custom_text: Option<&str>,
    input: &Entity<TextInput>,
    is_last: bool,
    id: &str,
    theme: &Theme,
    actions: QuestionCardActions,
) -> Stateful<Div> {
    let indices = selected_indices(question, selected);
    // The gate is the pure fold: submittable exactly when the selection or a
    // non-blank custom text provides an answer.
    let can_submit = !answer_for_selection(&question.id, &question.options, &indices, custom_text)
        .answers
        .is_empty();
    let has_custom = custom_text.is_some_and(|text| !text.trim().is_empty());

    let mut options = div().mt(px(9.0)).flex().flex_col().gap(px(4.0));
    for (ix, option) in question.options.iter().enumerate() {
        options = options.child(render_option_row(
            option,
            indices.contains(&ix),
            &format!("{id}-option-{ix}"),
            theme,
            &actions.select_option,
        ));
    }

    div()
        .id(SharedString::from(id))
        .w_full()
        .rounded(px(8.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.raised)
        .px(px(14.0))
        .py(px(12.0))
        .child(
            div()
                .text_size(sp(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(tools_dim(theme))
                .child(SharedString::from(question.header.clone())),
        )
        .child(
            div()
                .mt(px(4.0))
                .text_size(sp(12.5))
                .line_height(sp(17.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text)
                .whitespace_normal()
                .child(SharedString::from(question.question.clone())),
        )
        .when(!question.options.is_empty(), |card| card.child(options))
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
                .child(icon(
                    "icons/pencil.svg",
                    11.0,
                    if has_custom {
                        theme.accent
                    } else {
                        theme.text_ghost
                    },
                ))
                .child(input.clone()),
        )
        .child(
            div()
                .mt(px(8.0))
                .flex()
                .items_center()
                .child(div().flex_1())
                .child(render_submit_row(
                    can_submit,
                    is_last,
                    &format!("{id}-submit"),
                    theme,
                    &actions.submit,
                )),
        )
}
