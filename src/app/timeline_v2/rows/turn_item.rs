//! The turn container: the settled turn's footer and the spacing that
//! separates one turn from the next. The footer is tide's assistant-turn
//! meta strip — a thin rail divider, then a 24px row reading the model, the
//! turn's wall-clock duration, and the turn's start time — with a
//! hover-revealed Copy action for the turn's last assistant reply.
//!
//! Rewind is deliberately absent: it needs the rewind command path, which
//! this pane cannot reach without the closure seam Task 17 builds. A dead
//! button would lie, so nothing renders in its place.
//!
//! This is also the structural home for the turn's outer spacing (12px
//! between turns, flush at the session's first) and — later — T17's sticky
//! user header.

use super::super::{TimelineV2Row, tools_dim, tools_rail};
use crate::model::{AgentSession, AgentTurn, MessageRole};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::tooltip::Tooltip;
use gpui::prelude::*;
use gpui::{AnyElement, ClickEvent, Div, Pixels, SharedString, Window, div, px};
use uuid::Uuid;

/// Whole-second durations as tide reads them: "5s" under the minute, then
/// "1m 0s"-style minute/second pairs. No hours — a turn that long still
/// reads honestly as minutes.
pub(crate) fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

/// The model name a footer shows: the segment after the last `/` when the
/// id is namespaced (`anthropic/claude-opus-4.6` → `claude-opus-4.6`), the
/// whole id otherwise. `None` hides the segment — the runtime's
/// probe-based display name lives on `Tide` and is not importable here, so
/// this small slice of it is copied fresh.
pub(crate) fn model_segment(model: Option<&str>) -> Option<&str> {
    model.map(|model| model.rsplit('/').next().unwrap_or(model))
}

/// A settled turn's wall-clock duration: `completed_at - started_at`,
/// floored at zero. `None` while the turn runs — the working footer owns
/// the live ticker.
pub(crate) fn turn_duration(turn: &AgentTurn) -> Option<u64> {
    turn.completed_at
        .map(|completed| completed.saturating_sub(turn.started_at))
}

/// Space above a turn's first row: the session's first turn sits flush,
/// every later one gets the 12px between-turns gap. Pure — the list applies
/// it in its row wrapper.
pub(crate) fn turn_top_spacing(is_first_turn: bool) -> Pixels {
    if is_first_turn { px(0.0) } else { px(12.0) }
}

/// The session turn a row belongs to, as an index into `session.turns`.
/// Messages resolve through their `turn_id`, activity groups through their
/// block's; the footer rows carry their turn directly. `None` when the row
/// names no turn (or one the session no longer holds). The nav rail walks
/// the same rule to find turn boundaries.
pub(crate) fn row_turn_ix(session: &AgentSession, row: TimelineV2Row) -> Option<usize> {
    let turn_id = match row {
        TimelineV2Row::Message { index } => session.messages.get(index)?.turn_id?,
        TimelineV2Row::ActivityGroup { block } => session.transcript_blocks.get(block)?.turn_id?,
        TimelineV2Row::TurnFooter { turn } => return session.turns.get(turn).map(|_| turn),
        TimelineV2Row::ChangedFiles { turn } => return session.turns.get(turn).map(|_| turn),
        TimelineV2Row::Working => return session.turns.len().checked_sub(1),
    };
    session.turns.iter().position(|turn| turn.id == turn_id)
}

/// Top spacing for row `ix` of the derived row list: 12px when the row
/// opens a turn that is not the session's first, zero otherwise. A row
/// opens its turn when the row above it belongs to a different one (or
/// nothing does); the first row to belong to any turn is the session's
/// first turn. Footers and the working row can never open a turn by
/// construction — they trail their own turn's rows — but the rule needs no
/// special case for them: their predecessor is always same-turn.
pub(crate) fn spacing_before(session: &AgentSession, rows: &[TimelineV2Row], ix: usize) -> Pixels {
    let Some(turn) = rows
        .get(ix)
        .copied()
        .and_then(|row| row_turn_ix(session, row))
    else {
        return px(0.0);
    };
    let continues_turn = ix
        .checked_sub(1)
        .and_then(|prev| rows.get(prev).copied())
        .and_then(|row| row_turn_ix(session, row))
        .is_some_and(|prev_turn| prev_turn == turn);
    if continues_turn {
        return px(0.0);
    }
    let is_first_turn = (0..ix).all(|prev| {
        rows.get(prev)
            .copied()
            .and_then(|row| row_turn_ix(session, row))
            .is_none()
    });
    turn_top_spacing(is_first_turn)
}

/// The text Copy puts on the clipboard: the turn's latest assistant reply,
/// visible form (display content when the provider-facing text was
/// decorated). `None` when the turn produced no answer to copy.
pub(crate) fn last_assistant_text(session: &AgentSession, turn_id: Uuid) -> Option<String> {
    session
        .messages
        .iter()
        .rev()
        .find(|message| message.turn_id == Some(turn_id) && message.role == MessageRole::Assistant)
        .map(|message| message.visible_content().to_owned())
}

/// The turn's start time as a local HH:MM clock reading. Tide has no
/// shared `format_time` helper the pane can reach (the legacy pane's is
/// day-relative and lives behind legacy coupling), so the footer reads the
/// clock directly — chrono is already a dependency. The user bubble's hover
/// footer reuses it, so it is `pub(crate)`.
pub(crate) fn clock_time(unix_secs: u64) -> String {
    i64::try_from(unix_secs)
        .ok()
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

/// The settled turn's footer: a thin rail divider over a 24px meta row —
/// model segment, duration, start time — with a hover-revealed Copy action
/// for the turn's last assistant reply. Missing segments hide; `on_copy`
/// is the clipboard write, threaded from `list.rs` because only it holds
/// the app context.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_turn_footer(
    turn_id: Uuid,
    model: Option<&str>,
    duration: Option<u64>,
    started_at: u64,
    copy_text: Option<&str>,
    theme: &Theme,
    on_copy: impl Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Div {
    let group = SharedString::from(format!("turn-footer-{turn_id}"));
    let mut meta: Vec<AnyElement> = Vec::new();
    if let Some(model) = model_segment(model) {
        meta.push(
            div()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(model.to_owned()))
                .into_any_element(),
        );
    }
    if let Some(secs) = duration {
        meta.push(
            div()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(format_duration(secs)))
                .into_any_element(),
        );
    }
    let clock = clock_time(started_at);
    if !clock.is_empty() {
        meta.push(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_ghost)
                .child(SharedString::from(clock))
                .into_any_element(),
        );
    }

    let row = div()
        .group(group.clone())
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .children(meta)
        .child(div().flex_1())
        // Hover-revealed actions, the legacy pane's group-hover idiom: the
        // row owns the group, the actions stay invisible until it hovers.
        // Rewind belongs here once the rewind command path is reachable —
        // T17's closure seam — and not before.
        .when(copy_text.is_some_and(|text| !text.is_empty()), |row| {
            let copy = div()
                .id(SharedString::from(format!("turn-copy-{turn_id}")))
                .size(px(22.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .hover(|style| style.bg(theme.overlay))
                .child(icon("icons/copy.svg", 12.0, tools_dim(theme)))
                .tooltip(Tooltip::text(tr!("common.copy_message")))
                .on_click(move |event, window, cx| on_copy(event, window, cx));
            row.child(
                div()
                    .flex()
                    .items_center()
                    .invisible()
                    .group_hover(group, |style| style.visible())
                    .child(copy),
            )
        });

    div()
        .flex()
        .flex_col()
        .child(div().h(px(0.5)).w_full().bg(tools_rail(theme)))
        .child(row)
}
