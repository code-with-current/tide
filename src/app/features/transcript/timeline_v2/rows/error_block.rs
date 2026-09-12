//! The failed turn's error card — tide's turn-error block. A failed turn
//! (`TurnStatus::Failed`) closes with a collapsible danger card above the
//! footer's divider: collapsed it is a single 24px row reading "Turn failed"
//! under an alert glyph; expanded it shows the recorded error text in a
//! danger-washed, mono, scroll-capped viewport plus a Retry button that
//! re-sends the turn's prompt.
//!
//! ## Where the error text lives (the discovery this module encodes)
//!
//! Nothing on [`AgentTurn`] records the failure. `streaming.rs`'s
//! `DriverEvent::Error` handler appends the compacted error as an
//! **assistant message attached to the active turn** — but only when the
//! turn has no assistant message yet and the session stopped working — and
//! `DriverEvent::ProcessExited` does the same for its captured
//! `last_driver_error` (or the "exited before response" fallback). So in
//! session data the convention is: **a failed turn's error text is its last
//! assistant message**, which in the normal failure case is exactly the
//! appended error. [`error_text_for_turn`] reads that message with a
//! "The turn failed" fallback for the cases the append did not cover (no
//! message at all, or an empty one). The one blind spot: a turn that
//! streamed a partial reply before failing keeps that reply as its last
//! assistant message — the error itself then lives only in runtime state
//! (`last_driver_error`) and a toast — so the card may show the partial
//! reply where the app never recorded the error. Nothing session-side can
//! distinguish those; rendering the fallback for every failed turn would
//! hide real errors, so the message wins.
//!
//! `TurnStatus::Interrupted` is a user stop, not a failure — the card
//! renders nothing for it (the pure fn answers `None` for every non-failed
//! status).
//!
//! ## Retry
//!
//! Retry re-sends the turn's prompt through the composer submission path
//! (`Tide::submit_composer_submission`): it starts a fresh turn when the
//! session is idle and honestly queues a follow-up when it is busy. The
//! text is the turn's **first** user message — the prompt that opened the
//! turn. Steered messages are later user messages folded into the same
//! running turn, and re-sending one alone would misrepresent the request;
//! the opening prompt is the retry. The handler closure is threaded from
//! `list.rs` (the only place with the app context) as [`RetryAction`],
//! `None` when the turn has no prompt to resend — no button renders then.

use super::super::{Status, status_color};
use super::activity_group::GroupToggle;
use crate::model::{AgentTurn, Message, MessageRole, TurnStatus};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use gpui::prelude::*;
use gpui::{Div, SharedString, div, px};
use uuid::Uuid;

// ── The fold, pure ──────────────────────────────────────────────────────────

/// What the card says when a failed turn recorded no usable error text.
pub(crate) const TURN_FAILED_FALLBACK: &str = "The turn failed";

/// The error text a failed turn's card shows. `None` for every non-failed
/// status — interrupted is a user stop, not an error — and `Some` for every
/// failed one: the turn's last assistant message per the streaming.rs
/// append convention, or [`TURN_FAILED_FALLBACK`] when that message is
/// missing or empty. A failed turn always has something honest to say.
pub(crate) fn error_text_for_turn(turn: &AgentTurn, messages: &[Message]) -> Option<String> {
    if turn.status != TurnStatus::Failed {
        return None;
    }
    let text = messages
        .iter()
        .rev()
        .find(|message| message.turn_id == Some(turn.id) && message.role == MessageRole::Assistant)
        .map(|message| message.visible_content().trim().to_owned())
        .unwrap_or_default();
    Some(if text.is_empty() {
        TURN_FAILED_FALLBACK.to_owned()
    } else {
        text
    })
}

/// The prompt Retry re-sends: the visible content of the turn's first user
/// message. `None` when the turn opened without one (the provider-initiated
/// pursuit turns) — there is nothing to retry, so no button renders.
pub(crate) fn retry_text_for_turn(turn_id: Uuid, messages: &[Message]) -> Option<String> {
    let text = messages
        .iter()
        .find(|message| message.turn_id == Some(turn_id) && message.role == MessageRole::User)
        .map(|message| message.visible_content().trim().to_owned())
        .unwrap_or_default();
    (!text.is_empty()).then_some(text)
}

/// The card's disclosure id — `error-{turn_id}`, the same turn-anchored
/// synthetic-id rule as the files card. The id names no activity, so
/// `list.rs` wires its toggle with a direct remeasure.
pub(crate) fn error_block_id(turn_id: Uuid) -> String {
    format!("error-{turn_id}")
}

/// The expanded body's scroll cap, tide's error-viewport budget.
pub(crate) const ERROR_VIEWPORT_HEIGHT: f32 = 200.0;

// ── Renderer ────────────────────────────────────────────────────────────────

/// The retry click, built by `list.rs` where the app context lives.
pub(crate) type RetryAction =
    std::sync::Arc<dyn Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App)>;

/// The error card: a 24px header row — alert glyph and "Turn failed" in the
/// error token, a chevron, the whole row toggling the disclosure — and,
/// expanded, the error body (mono, danger-washed, capped at
/// [`ERROR_VIEWPORT_HEIGHT`] with its own scroll) over a right-aligned
/// bordered Retry button in the skills-screen action idiom. `toggle` is the
/// synthetic-id disclosure flip `list.rs` wires; `on_retry` is `None` when
/// the turn has no prompt to resend.
pub(crate) fn render_error_block(
    text: &str,
    theme: &Theme,
    expanded: bool,
    id: &str,
    toggle: GroupToggle,
    on_retry: Option<RetryAction>,
) -> Div {
    let error = status_color(theme, Status::Error);
    let disclosure = id.to_owned();
    let header = div()
        .id(SharedString::from(format!("error-toggle-{id}")))
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|style| style.bg(theme.overlay))
        .child(icon("icons/alert.svg", 12.0, error))
        .child(
            div()
                .flex_none()
                .text_size(sp(11.5))
                .text_color(error)
                .child(SharedString::from("Turn failed")),
        )
        .child(div().flex_1())
        .child(icon(
            if expanded {
                "icons/chevron-up.svg"
            } else {
                "icons/chevron-down.svg"
            },
            11.0,
            error.opacity(0.7),
        ))
        .on_click(move |event, window, cx| toggle(&disclosure, event, window, cx));

    let mut block = div().w_full().flex().flex_col().child(header);
    if expanded {
        block = block
            .child(
                div()
                    .id(SharedString::from(format!("error-text-{id}")))
                    .mt(px(4.0))
                    .max_h(px(ERROR_VIEWPORT_HEIGHT))
                    .overflow_y_scroll()
                    .border_1()
                    .border_color(theme.danger.opacity(0.35))
                    .bg(theme.danger.opacity(0.08))
                    .rounded(px(8.0))
                    .px(px(10.0))
                    .py(px(8.0))
                    .font_family(crate::md::render::MONO_FAMILY)
                    .text_size(sp(11.0))
                    .line_height(sp(16.0))
                    .text_color(theme.danger)
                    .child(SharedString::from(text)),
            )
            .when_some(on_retry, |block, on_retry| {
                block.child(
                    div()
                        .mt(px(6.0))
                        .flex()
                        .items_center()
                        .child(div().flex_1())
                        .child(retry_button(id, on_retry, theme)),
                )
            });
    }
    block
}

/// The bordered 24px-ish action button (the skills-screen idiom: h26, px10,
/// rounded 6, border-strong, 12.5sp secondary text, overlay hover) with the
/// refresh glyph. Clicks stop propagating so the header's toggle never
/// hears them.
fn retry_button(id: &str, on_retry: RetryAction, theme: &Theme) -> gpui::Stateful<Div> {
    div()
        .id(SharedString::from(format!("error-retry-{id}")))
        .h(px(26.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(theme.border_strong)
        .flex()
        .flex_none()
        .items_center()
        .gap(px(5.0))
        .cursor_default()
        .text_size(sp(12.5))
        .text_color(theme.text_secondary)
        .hover(|style| style.bg(theme.overlay))
        .child(icon("icons/refresh.svg", 11.0, theme.text_tertiary))
        .child(SharedString::from(tr!("common.retry")))
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |event, window, cx| {
            cx.stop_propagation();
            on_retry(event, window, cx);
        })
}
