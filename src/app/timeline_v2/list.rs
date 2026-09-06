//! The v2 virtualized list: derives rows from the selected session, then
//! dispatches each to its row renderer — the activity group from
//! `rows::activity_group`, the turn footer and working footer from
//! `rows::turn_item` / `rows::working_footer`, the file-changes card from
//! `rows::changed_files`; rows without a rich renderer yet keep the plain
//! pass. Each row opens with the turn spacing `rows::turn_item` computes.

use super::parts::question_card::{QuestionCardActions, SelectOption, render_question_card};
use super::parts::reasoning_part::ReasoningMarkdown;
use super::parts::text_part::render_assistant_text;
use super::parts::user_bubble::{
    UserBubbleActions, UserBubbleAttachment, clamp_id, edit_removals, render_user_bubble,
};
use super::permission::{
    PermissionRespond, permission_deadline, render_permission_card, seconds_left,
};
use super::rows::activity_group::{GroupToggle, render_activities};
use super::rows::changed_files::{files_card_id, render_changed_files, summarize_changes};
use super::rows::error_block::{
    RetryAction, error_block_id, error_text_for_turn, render_error_block, retry_text_for_turn,
};
use super::rows::turn_item::{
    last_assistant_text, render_turn_footer, spacing_before, turn_duration,
};
use super::rows::working_footer::render_working_footer;
use super::{
    EditingMessage, TimelineV2Row, TranscriptActions, TranscriptV2, derive_rows, rows_fingerprint,
};
use crate::app::Tide;
use crate::app::navigation_rail::{
    ConversationNavigationRailSnapshot, NavigationTurnOpening, active_navigation_turn_index,
    navigation_turns, should_show_navigation_rail,
};
use crate::app::transcript::message_opens_turn;
use crate::input::TextInput;
use crate::model::{
    ActivityFileChange, ActivityItem, ActivityKind, AgentSession, Message, MessageRole, TurnStatus,
    unix_time,
};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use gpui::prelude::*;
use gpui::{
    AnyElement, Context, Div, Pixels, ScrollWheelEvent, SharedString, Window, div, list, px,
};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

/// The v2 pane's content column width. Copied deliberately (not imported)
/// from the app-shell `CONTENT_MAX_WIDTH` (720) so the pane owns its own
/// measure and can diverge from the legacy transcript in later phases.
const V2_CONTENT_MAX_WIDTH: f32 = 720.0;
/// Rows at the tail that re-measure when streamed text grows. Matches the
/// legacy `STREAM_REMEASURE_TAIL_ROWS`.
const STREAM_REMEASURE_TAIL_ROWS: usize = 3;
/// Characters of a message's visible content the plain pass shows.
const PLAIN_SNIPPET_CHARS: usize = 80;

/// The pane's honest "is this session streaming" signal: the session is busy
/// AND has a turn still running. Mirrors the legacy fold's working-indicator
/// condition — the busy check matters because a driver error can fail the
/// session while its turn is still marked running, and "working…" over a
/// failure misleads.
pub(crate) fn is_streaming(session: &AgentSession) -> bool {
    session.is_busy() && session.active_turn_id().is_some()
}

/// Cheap tail-growth signal. The row fingerprint hashes ids and statuses, not
/// text, so a streaming reply that only grows its last message leaves the
/// fingerprint — and therefore the list's cached row heights — untouched.
/// This epoch folds the message count with the last message's visible
/// content length; a bump means the tail rows' measurements are stale.
fn text_epoch(session: &AgentSession) -> u64 {
    let mut epoch = session.messages.len() as u64;
    if let Some(last) = session.messages.last() {
        epoch = (epoch << 32) ^ (last.visible_content().len() as u64);
    }
    epoch
}

/// The pane's stick-to-bottom state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FollowState {
    /// Pinned to the tail: growth re-scrolls the list to its end.
    Following,
    /// The reader left the tail; growth leaves their position alone until
    /// they return to the bottom (or press the jump button).
    Released,
}

/// Events that move the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScrollSignal {
    /// The wheel moved content toward the top — the reader left the tail.
    ScrolledUp,
    /// The viewport rests on the last content — following may re-engage.
    AtBottom,
    /// The reader sent a message. Absorbed by both states on purpose: a
    /// released reader keeps their place (and the jump button) so a send
    /// never yanks them down mid-read.
    UserSent,
}

/// Fold one signal into the follow state. Pure so the release/re-pin rules
/// stay unit-testable without a window.
pub(crate) fn next_follow(state: FollowState, signal: ScrollSignal) -> FollowState {
    match (state, signal) {
        (FollowState::Following, ScrollSignal::ScrolledUp) => FollowState::Released,
        (FollowState::Released, ScrollSignal::AtBottom) => FollowState::Following,
        (state, _) => state,
    }
}

/// The re-pin affordance shows exactly while following is released.
pub(crate) fn show_jump(state: FollowState) -> bool {
    matches!(state, FollowState::Released)
}

// ── The send-time anchor (the legacy pane's scroll behavior) ────────────────
//
// The legacy transcript does not simply follow its tail while a turn runs.
// On a send it switches to a TOP-aligned list state with the sent prompt
// pinned at the viewport top, and reserves blank space below the content
// (`end_space`, painted as the list's bottom padding). The reply then
// streams INTO that reservation: the span from the anchor row's top to the
// viewport's bottom stays constant, so the prompt holds still instead of
// jumping as rows measure in below it. Once the reply outgrows the
// viewport the reservation collapses to zero and the pin moves to the
// tail, still on the anchored list. A wheel-up releases the pin (the
// reader keeps their place and the jump button); settling the turn exits
// anchor mode back to the bottom-aligned follower.

/// The anchor machine's state, carried while one turn streams.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AnchorState {
    /// The anchored turn. Settle detection keys on its status and the
    /// anchor row re-resolves through it every frame (rows shift under
    /// splices — re-anchored blocks, footer insertions — so a stored row
    /// index alone would drift).
    pub turn: uuid::Uuid,
    /// The turn's opening prompt row, as of the last sync. Informational
    /// for render consumers; the machine re-resolves before using it.
    pub row: usize,
    /// Blank space reserved below the content, in pixels. Seeded at a full
    /// viewport on send, trued up against the measured anchor-to-tail
    /// height each frame, and held (not zeroed) through frames whose tail
    /// rows are unmeasured — missing bounds mean unknown, not empty.
    pub end_space: Pixels,
}

/// The list the pane currently renders: the anchored (top-aligned) twin
/// while an anchor is set, the bottom-aligned follower otherwise — the
/// legacy `active_transcript_rows` selection.
pub(crate) fn active_rows(state: &TranscriptV2) -> &gpui::ListState {
    if state.anchor.is_some() {
        &state.anchored_rows
    } else {
        &state.rows
    }
}

/// The reservation that keeps the anchored prompt put: whatever of the
/// viewport the measured anchor-to-tail span does not fill. Clamped at
/// zero — once the reply outgrows the viewport there is nothing to
/// reserve and the pin moves to the tail.
pub(crate) fn anchor_end_space(viewport_height: Pixels, anchored_tail_height: Pixels) -> Pixels {
    (viewport_height - anchored_tail_height).max(Pixels::ZERO)
}

/// Whether the list rests on the end of its content — the tail row's
/// bottom (plus the anchor's reserved space, which is part of the
/// document) within half a pixel of the viewport's bottom. `None` while
/// the tail row is unmeasured: the stream pump remeasures tail rows at
/// commit cadence, so a frame genuinely cannot answer, and a caller must
/// hold its previous answer rather than conclude either way.
pub(crate) fn rests_at_tail(
    viewport_bottom: Pixels,
    tail_bottom: Option<Pixels>,
    end_space: Pixels,
) -> Option<bool> {
    Some(tail_bottom? + end_space <= viewport_bottom + px(0.5))
}

/// The wheel classifier's at-tail answer: the measured [`rests_at_tail`],
/// defaulting to TRUE while the tail is unmeasured. The tolerance fix —
/// the old `is_scrolled_to_end` mapping answered `None` into "cannot
/// re-pin", so a toward-bottom tick landing on a remeasured frame never
/// re-engaged following for as long as the stream kept the tail
/// unmeasured; an unmeasured tail must not block the re-pin.
pub(crate) fn tolerant_rests_at_tail(
    viewport_bottom: Pixels,
    tail_bottom: Option<Pixels>,
    end_space: Pixels,
) -> bool {
    rests_at_tail(viewport_bottom, tail_bottom, end_space).unwrap_or(true)
}

/// The turn a trailing user message opens, when it opens a RUNNING one —
/// the send signal that enters anchor mode. A mid-turn steer lands as a
/// user message too but does not open its turn, so it never re-anchors
/// (legacy anchors only in the submission path, on the turn's opening
/// prompt). `None` when the tail is not a turn-opening prompt or its
/// turn already settled.
pub(crate) fn anchor_send_turn(session: &AgentSession) -> Option<uuid::Uuid> {
    let index = session.messages.len().checked_sub(1)?;
    let turn_id = session.messages[index]
        .turn_id
        .filter(|_| message_opens_turn(&session.messages, index))?;
    session
        .turns
        .iter()
        .any(|turn| turn.id == turn_id && turn.status == TurnStatus::Running)
        .then_some(turn_id)
}

/// Whether the anchored turn is still running — the anchor's lease.
pub(crate) fn anchor_turn_running(session: &AgentSession, turn: uuid::Uuid) -> bool {
    session
        .turns
        .iter()
        .any(|candidate| candidate.id == turn && candidate.status == TurnStatus::Running)
}

/// The row index of `turn`'s opening prompt in the cached rows — the
/// anchor's position, re-resolved from the turn id every sync because row
/// indices shift under splices. `None` when the session no longer holds
/// the prompt or the cache no longer holds its row.
pub(crate) fn anchor_row_for_turn(
    session: &AgentSession,
    rows: &[TimelineV2Row],
    turn: uuid::Uuid,
) -> Option<usize> {
    let message = session
        .messages
        .iter()
        .position(|message| message.role == MessageRole::User && message.turn_id == Some(turn))?;
    rows.iter()
        .position(|row| matches!(row, TimelineV2Row::Message { index } if *index == message))
}

/// How long a session switch paints the gray placeholder blocks before the
/// real rows land — tide's flash, held one breathing window rather than one
/// frame so the swap never strobes on a slow fold.
pub(crate) const SESSION_SWITCH_SKELETON: std::time::Duration =
    std::time::Duration::from_millis(150);

/// Whether the switch skeleton still owns the pane: armed, and the window
/// unexpired at `now`. Pure so the arm/expiry rules stay unit-testable. The
/// boundary is exclusive — the frame that lands exactly at `until` already
/// shows rows — and expiry alone clears the paint: any frame after the window
/// renders rows whatever the stored mark says.
pub(crate) fn skeleton_active(
    skeleton_until: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    skeleton_until.is_some_and(|until| now < until)
}

/// Classify one wheel tick from its vertical pixel delta and the list's
/// at-bottom answer. GPUI's sign convention (see the list element's own
/// scroll handler): a positive `delta.y` scrolls toward the top — content
/// moves down, away from the bottom — so that is the release signal. A
/// negative delta scrolls toward the bottom but only re-pins once the end
/// is actually reached; `None` (list unscrollable or content unmeasured)
/// cannot claim the bottom, and a zero vertical component (horizontal
/// scroll) carries no signal.
pub(crate) fn wheel_signal(delta_y: Pixels, at_bottom: Option<bool>) -> Option<ScrollSignal> {
    if delta_y > Pixels::ZERO {
        Some(ScrollSignal::ScrolledUp)
    } else if delta_y < Pixels::ZERO && at_bottom == Some(true) {
        Some(ScrollSignal::AtBottom)
    } else {
        None
    }
}

/// When a row above (or at) the viewport top grows/shrinks by `height_delta`,
/// the scroll offset must move by the same amount to keep the clicked header
/// stationary. Rows BELOW the viewport top never affect the offset.
///
/// `row_top_offsets` carries each row's top y-offset in pixels (content
/// coordinates) and `viewport_top` the current scroll offset in the same
/// space. Returns the offset adjustment to apply: `height_delta` for a row at
/// or above the viewport top, zero for one below it (the reader sees that
/// header, and GPUI's anchoring keeps it put well enough on its own). The
/// adjustment is floored so a collapsing row can never drag the offset past
/// the list's start (`viewport_top + adjustment >= 0`); the caller applies it
/// with the fork's `ListState::scroll_by`, which performs the same floor in
/// pixels.
pub(crate) fn disclosure_scroll_adjustment(
    row_top_offsets: &[f32],
    toggled_row: usize,
    height_delta: f32,
    viewport_top: f32,
) -> f32 {
    // A row the caller can't place has no position to answer for.
    let Some(&row_top) = row_top_offsets.get(toggled_row) else {
        return 0.0;
    };
    if row_top > viewport_top {
        return 0.0;
    }
    height_delta.max(-viewport_top)
}

/// A disclosure toggle whose height change has not yet been folded back into
/// the scroll offset. Created by [`Tide::toggle_disclosure`], consumed by
/// [`apply_pending_disclosure_scroll`] across two render-sync passes.
pub(crate) struct PendingScrollAnchor {
    /// Row index of the toggled part, captured before the toggle. Disclosure
    /// state is not part of the row fingerprint, so the index stays valid
    /// across the toggle; a structural reset that shifts it invalidates the
    /// anchor (the sync drops it when the index leaves the list).
    pub row: usize,
    /// The list's total scroll height at toggle time, from
    /// `ListState::max_offset_for_scrollbar` — the fork exposes no per-row
    /// heights, so the sync measures the disclosure's delta by diffing the
    /// total across the remeasure.
    pub scroll_height_before: f32,
    /// Whether the remeasure request has gone out. Pass one requests it;
    /// pass two measures, applies, and clears.
    pub remeasure_requested: bool,
}

/// Fold a pending disclosure toggle's height change back into the scroll
/// offset so the clicked header stays put.
///
/// v1, documented honestly: exact row heights are not knowable until the
/// remeasure lands, so the anchor runs for exactly two sync passes after a
/// toggle. Pass one invalidates the toggled row's measurement (no layout has
/// run between the toggle handler and that render, so the new height cannot
/// have landed yet). Pass two measures the height delta by diffing the list's
/// total scroll height against the captured pre-toggle value and applies
/// [`disclosure_scroll_adjustment`] through `ListState::scroll_by`, which
/// floors the resulting offset at the list's start in pixels.
///
/// Two known v1 limits, both left for the tool-card tasks once disclosed rows
/// have real heights: the total-height diff can be polluted by concurrent tail
/// growth in the same two frames, and until Task 10 renders disclosures the
/// delta always measures zero (the plain pass ignores the disclosure set), so
/// this is dormant wiring with the math already in place. The two-pass cap
/// keeps the anchor from ever outliving its toggle and claiming a later
/// stream's growth as its own.
fn apply_pending_disclosure_scroll(state: &mut TranscriptV2) {
    let Some(anchor) = state.pending_scroll_anchor.take() else {
        return;
    };
    let rows = active_rows(state);
    // A structural reset between the toggle and now shifted row indices;
    // the anchor's row no longer names the toggled part.
    if anchor.row >= rows.item_count() {
        return;
    }
    if !anchor.remeasure_requested {
        rows.remeasure_items(anchor.row..anchor.row + 1);
        state.pending_scroll_anchor = Some(PendingScrollAnchor {
            remeasure_requested: true,
            ..anchor
        });
        return;
    }
    let height_delta = f32::from(rows.max_offset_for_scrollbar().y) - anchor.scroll_height_before;
    // The pane tracks no per-row pixel offsets, but the fork's viewport top is
    // an item index, and the pure rule over unit-spaced offsets reduces to
    // exactly that comparison: row <= top item means at-or-above the viewport
    // top. The probe delta is +1 so the pure fn's start-of-list clamp stays
    // inert (it lives in index space here); the pixel floor that matters is
    // `scroll_by`'s own.
    let viewport_top = rows.logical_scroll_top().item_ix as f32;
    let probe_offsets: Vec<f32> = (0..=anchor.row).map(|ix| ix as f32).collect();
    let decides_above = disclosure_scroll_adjustment(&probe_offsets, anchor.row, 1.0, viewport_top);
    if decides_above != 0.0 {
        rows.scroll_by(px(height_delta));
    }
}

/// The row index of the part a disclosure id names, if the cached rows know
/// it. Tide's tool-block-id rule: a part's disclosure id is its activity's
/// `source_id`, and the row is the `ActivityGroup` whose block carries that
/// activity.
pub(crate) fn disclosure_row(
    state: &TranscriptV2,
    session: Option<&AgentSession>,
    id: &str,
) -> Option<usize> {
    let session = session?;
    let block = session.transcript_blocks.iter().position(|block| {
        block
            .activities
            .iter()
            .any(|activity| activity.source_id.as_deref() == Some(id))
    })?;
    state
        .row_cache
        .iter()
        .position(|row| matches!(row, TimelineV2Row::ActivityGroup { block: b } if *b == block))
}

impl Tide {
    /// Toggle a part's disclosure and keep the clicked header stationary.
    ///
    /// Flips the part's membership in the disclosure set, marks a remeasure
    /// due, and parks a [`PendingScrollAnchor`] for the render sync (see
    /// [`apply_pending_disclosure_scroll`]) — the scroll correction happens
    /// there, once the new height has landed. Tool cards call this from their
    /// header clicks with the part's disclosure id; callers that cannot
    /// resolve a row still get the set flip, just without an anchor.
    pub(super) fn toggle_disclosure(&mut self, id: &str, cx: &mut Context<Self>) {
        let row = disclosure_row(&self.timeline_v2_state, self.selected_session(), id);
        let state = &mut self.timeline_v2_state;
        if !state.disclosures.remove(id) {
            state.disclosures.insert(id.to_string());
        }
        state.remeasure_due = true;
        state.pending_scroll_anchor = row.map(|row| {
            let scroll_height_before = f32::from(active_rows(state).max_offset_for_scrollbar().y);
            PendingScrollAnchor {
                row,
                scroll_height_before,
                remeasure_requested: false,
            }
        });
        cx.notify();
    }

    /// Open the v2 edit-and-resend editor for a user message. The `TextInput`
    /// entity needs a window, and the click handler has one, so the editor is
    /// created right here and parked on the pane state; the row re-measures
    /// so the bubble-to-editor swap lands.
    pub(super) fn timeline_v2_begin_edit(
        &mut self,
        message_id: uuid::Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((row, initial)) = self.selected_session().and_then(|session| {
            let row = message_row_ix(&self.timeline_v2_state, session, message_id)?;
            let initial = session
                .messages
                .iter()
                .find(|message| message.id == message_id)?
                .visible_content()
                .to_owned();
            Some((row, initial))
        }) else {
            return;
        };
        let input = cx.new(|cx| TextInput::new(window, cx).multi_line().auto_height());
        input.update(cx, |input, cx| input.set_content(initial, cx));
        self.timeline_v2_state.editing = Some(EditingMessage {
            message_id,
            input: input.clone(),
            confirm_removals: None,
        });
        active_rows(&self.timeline_v2_state).remeasure_items(row..row + 1);
        let focus = input.read(cx).focus();
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Leave edit mode: the bubble comes back and focus returns to the
    /// composer. A rewind already preparing ignores the cancel — the legacy
    /// editor enforces the same rule.
    pub(super) fn timeline_v2_cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.timeline_v2_state.editing.is_some()
            && self
                .selected_session()
                .is_some_and(|session| self.submission_preparations.contains(&session.id))
        {
            return;
        }
        let Some(editing) = self.timeline_v2_state.editing.take() else {
            return;
        };
        self.remeasure_editing_row(editing.message_id);
        let focus = self.composer_focus(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Step an armed resend confirmation back to the editor.
    pub(super) fn timeline_v2_disarm_confirm(&mut self, cx: &mut Context<Self>) {
        if let Some(editing) = self.timeline_v2_state.editing.as_mut() {
            editing.confirm_removals = None;
        }
        cx.notify();
    }

    /// Send the edited message — the pane's edit-and-resend. A first Send on
    /// a message with downstream work arms the inline confirmation (the
    /// counts come from [`edit_removals`]); Confirm — or a Send with nothing
    /// to remove — runs the resend through the same chain the legacy
    /// user-message footer's rewind button drives: `begin_message_edit`
    /// parks the legacy `MessageEdit` (validating editability, toasting when
    /// it fails), its input is overwritten with the edited text, and
    /// `submit_message_edit` rolls the session back to the message and
    /// resubmits it. The editor steps aside only when the rewind actually
    /// started — a rejected begin keeps it open beside the rejection's toast.
    pub(super) fn timeline_v2_send_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((message_id, new_text, confirming)) =
            self.timeline_v2_state.editing.as_ref().map(|editing| {
                (
                    editing.message_id,
                    editing.input.read(cx).content().trim().to_owned(),
                    editing.confirm_removals.is_some(),
                )
            })
        else {
            return;
        };
        if new_text.is_empty() {
            self.show_toast(tr!("session.edited_message_empty"));
            cx.notify();
            return;
        }
        let located = self.selected_session().and_then(|session| {
            let index = session
                .messages
                .iter()
                .position(|message| message.id == message_id)?;
            let turn_count = session.messages[index]
                .turn_id
                .and_then(|turn_id| session.turns.iter().find(|turn| turn.id == turn_id))
                .map(|turn| turn.turn_count)?;
            Some((session.id, turn_count, index))
        });
        let Some((session_id, turn_count, message_index)) = located else {
            self.show_toast(tr!("session.message_unavailable"));
            cx.notify();
            return;
        };

        if !confirming {
            let removals = self
                .selected_session()
                .map(|session| edit_removals(session, message_index))
                .unwrap_or((0, 0));
            if removals != (0, 0) {
                if let Some(editing) = self.timeline_v2_state.editing.as_mut() {
                    editing.confirm_removals = Some(removals);
                }
                cx.notify();
                return;
            }
        }

        // The resend chain — see the method doc.
        self.begin_message_edit(
            crate::app::UserMessageAction {
                session_id,
                message_id,
                turn_count,
            },
            window,
            cx,
        );
        let legacy_input = self
            .message_edit
            .as_ref()
            .filter(|edit| edit.message_id == message_id)
            .map(|edit| edit.input.clone());
        if let Some(input) = legacy_input {
            input.update(cx, |input, cx| input.set_content(new_text, cx));
            self.submit_message_edit(cx);
        }
        if self.submission_preparations.contains(&session_id) {
            self.timeline_v2_state.editing = None;
            self.remeasure_editing_row(message_id);
            let focus = self.composer_focus(cx);
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    /// Re-measure the row holding `message_id` after an edit-state swap.
    fn remeasure_editing_row(&mut self, message_id: uuid::Uuid) {
        let Some(row) = self
            .selected_session()
            .and_then(|session| message_row_ix(&self.timeline_v2_state, session, message_id))
        else {
            return;
        };
        active_rows(&self.timeline_v2_state).remeasure_items(row..row + 1);
    }
}

/// The row index of a message index in the pane's cached rows, when the
/// cache still holds it. The find bar resolves its hits through this.
pub(super) fn message_index_row(state: &TranscriptV2, message_index: usize) -> Option<usize> {
    state
        .row_cache
        .iter()
        .position(|row| matches!(row, TimelineV2Row::Message { index } if *index == message_index))
}

/// The row index of a message id in the pane's cached rows, when both the
/// session and the cache still know it.
fn message_row_ix(
    state: &TranscriptV2,
    session: &AgentSession,
    message_id: uuid::Uuid,
) -> Option<usize> {
    let index = session
        .messages
        .iter()
        .position(|message| message.id == message_id)?;
    message_index_row(state, index)
}

/// How to reconcile the list state with a freshly derived row list. A full
/// `reset` re-measures everything and disturbs the scroll anchor, so every
/// cheaper shape that can be named honestly gets its own plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SplicePlan {
    /// Row count/content identical — nothing to do.
    None,
    /// Same row count, but trailing rows' content changed (streaming text
    /// growth, activity completion) — remeasure the tail only.
    TailRemeasure { from: usize },
    /// Rows appended at the end — splice them in, keep prior measurements.
    Append { from: usize },
    /// The whole tail from `from` down was rewritten with a DIFFERENT row
    /// count: everything before `from` is identical, everything after is new.
    /// This is the streaming workhorse shape — the trailing `Working` row
    /// occupies the slot that new blocks and messages insert before and that
    /// the turn footer replaces — so it must splice the tail, not reset the
    /// list (the reset's full remeasure plus cleared scroll anchor is the
    /// visible stream-cadence jump).
    TailReplace { from: usize },
    /// Structure changed mid-list — full reset (the honest fallback).
    Reset,
}

/// Compare two row lists (same length prefix compare) → plan.
///
/// The table, in decision order: identical lists pass as [`SplicePlan::None`].
/// A prefix-equal longer list is a pure [`SplicePlan::Append`] at the old
/// end. Same-length lists whose first difference sits after index zero are a
/// [`SplicePlan::TailRemeasure`] from that index — the rows before it keep
/// both identity and measurement. Differing-length lists whose first
/// difference also sits after index zero are a [`SplicePlan::TailReplace`]:
/// everything before the difference is identical, so the region from it down
/// is one contiguous tail rewrite however its length moved (the
/// streaming-insert and turn-end shapes). Everything else — a difference at
/// index zero (the whole list shifted under the pane), or a prefix-equal
/// shrink, which names no first difference to anchor a rewrite on and reads
/// as a rewind — is a structural change and falls back to
/// [`SplicePlan::Reset`], whose viewport preservation keeps the reader put.
pub(crate) fn splice_decision(old: &[TimelineV2Row], new: &[TimelineV2Row]) -> SplicePlan {
    let common = old.len().min(new.len());
    match (0..common).find(|&ix| old[ix] != new[ix]) {
        None if new.len() == old.len() => SplicePlan::None,
        None if new.len() > old.len() => SplicePlan::Append { from: old.len() },
        // A prefix-equal shrink: no first difference anchors a tail rewrite,
        // and a shorter list (a rewind, a pruned tail) deserves a fresh fold.
        None => SplicePlan::Reset,
        // The first row itself moved: the whole list shifted under the pane.
        Some(0) => SplicePlan::Reset,
        Some(from) if new.len() == old.len() => SplicePlan::TailRemeasure { from },
        // Lengths differ but everything before the first difference is
        // identical: one contiguous tail rewrite, grown or shrunk.
        Some(from) => SplicePlan::TailReplace { from },
    }
}

/// The structural plan for a fold, accounting for WHERE the rows came from:
/// a session switch always resets. Rows are index-based, so two sessions can
/// fold to the same row list while their cached heights describe entirely
/// different content — the switch wants fresh measurements and the
/// bottom-aligned follower's tail pin, not a coincidental prefix match.
pub(crate) fn sync_plan(
    session_switch: bool,
    old: &[TimelineV2Row],
    new: &[TimelineV2Row],
) -> SplicePlan {
    if session_switch {
        SplicePlan::Reset
    } else {
        splice_decision(old, new)
    }
}

/// Apply a structural [`SplicePlan`] to BOTH list states (the legacy pane's
/// discipline — its splice/reset/remeasure helpers touch the anchored twin
/// whenever an anchor is set, extended to run always so the anchor
/// entry/exit switches can never land on a stale item count).
///
/// `new_count` is the fresh row count and the plan's indices speak against
/// the cached rows still held in `state.row_cache` (the caller swaps the
/// cache after this runs). `preserve_scroll_on_reset` captures each list's
/// logical offset before a reset and restores it after: a genuine mid-list
/// reset must re-measure without yanking the reader, while a session switch
/// passes `false` to keep the reset's own landing (the follower's tail pin).
pub(crate) fn apply_splice_plan(
    state: &mut TranscriptV2,
    plan: SplicePlan,
    new_count: usize,
    preserve_scroll_on_reset: bool,
) {
    let old_count = state.row_cache.len();
    match plan {
        SplicePlan::None => {}
        // Splice the new rows in (the legacy transcript's append form:
        // `splice(current..current, count - current)`); the splice
        // re-arms measurement for the added range.
        SplicePlan::Append { from } => {
            state.rows.splice(from..from, new_count - from);
            state.anchored_rows.splice(from..from, new_count - from);
            state.rows.remeasure_items(from..new_count);
            state.anchored_rows.remeasure_items(from..new_count);
        }
        // Content changed in place: invalidate just the affected range —
        // `remeasure_items` preserves the reader's scroll position.
        SplicePlan::TailRemeasure { from } => {
            state.rows.remeasure_items(from..new_count);
            state.anchored_rows.remeasure_items(from..new_count);
        }
        // The tail was rewritten with a different count: splice the old tail
        // out and the new one in (the splice keeps every measurement above
        // `from`, and shifts or clamps the scroll anchor honestly), then
        // remeasure the rewritten range.
        SplicePlan::TailReplace { from } => {
            state.rows.splice(from..old_count, new_count - from);
            state
                .anchored_rows
                .splice(from..old_count, new_count - from);
            state.rows.remeasure_items(from..new_count);
            state.anchored_rows.remeasure_items(from..new_count);
        }
        SplicePlan::Reset => {
            let restore = preserve_scroll_on_reset.then(|| {
                (
                    state.rows.logical_scroll_top(),
                    state.anchored_rows.logical_scroll_top(),
                )
            });
            state.rows.reset(new_count);
            state.anchored_rows.reset(new_count);
            if let Some((top, anchored_top)) = restore {
                // `scroll_to` re-establishes the captured item as the
                // viewport's top while it re-measures; an item past the new
                // end clamps to the end (the closest honest position).
                state.rows.scroll_to(top);
                state.anchored_rows.scroll_to(anchored_top);
            }
        }
    }
}

/// Enter anchor mode for a send: pin the turn's opening prompt at the
/// viewport top of the top-aligned twin and seed a full viewport of end
/// space. The seed is provisional — the anchored list has no measured
/// bounds until its first paint, and a zero reservation cannot hold the
/// prompt at the top (without scroll room past the tail the list clamps
/// to its end and the prompt paints a frame at the bottom before the
/// first measured frame lifts it). The overshoot is invisible under the
/// top anchor and the first measured frame trues it up.
///
/// The send also re-pins following: the anchor IS the send's pin — the
/// pane holds the prompt in view for the turn's life, whatever the
/// follow machine held before (legacy sets its anchor-following flag
/// unconditionally at send time). The machine's `UserSent` absorption
/// still holds for the tail follower; this seam supersedes it while the
/// anchor machine owns the pane.
pub(crate) fn enter_anchor(state: &mut TranscriptV2, turn: uuid::Uuid, row: usize) {
    let mut viewport = state.rows.viewport_bounds().size.height;
    if viewport <= Pixels::ZERO {
        viewport = state.anchored_rows.viewport_bounds().size.height;
    }
    state.anchor = Some(AnchorState {
        turn,
        row,
        end_space: viewport,
    });
    state.follow = FollowState::Following;
    state.anchored_rows.scroll_to(gpui::ListOffset {
        item_ix: row,
        offset_in_item: Pixels::ZERO,
    });
}

/// Leave anchor mode. A following reader lands pinned to the tail of the
/// bottom-aligned follower; a released one keeps their place — their
/// offset carries over to `rows` first so the list switch does not jump
/// them (the jump button stays theirs until they use it).
pub(crate) fn exit_anchor(state: &mut TranscriptV2) {
    let released = state.follow == FollowState::Released;
    if released {
        let offset = state.anchored_rows.logical_scroll_top();
        state.rows.scroll_to(offset);
    }
    state.anchor = None;
    if !released {
        state.follow = FollowState::Following;
        state.rows.scroll_to_end();
    }
}

/// True up the anchor's reserved space against the measured layout — the
/// port of the legacy `update_transcript_anchor_end_space`. The span from
/// the anchor row's top to the last row's bottom is measured off the
/// anchored list's rendered bounds; unmeasured tail rows (every stream
/// commit remeasures them) mean unknown, not zero — and also not
/// "measured-so-far": a span whose tail row carries a stale or partial
/// measurement is just as unknown, because the reservation computed from it
/// would be wrong in whichever direction the missing height points, and a
/// wrong reservation oscillates against the next measured frame at stream
/// cadence. So the previous space stands through ANY unanswerable span; only
/// a fully measured anchor-to-tail run trues it up. `fallback_viewport`
/// stands in while the list has no laid-out bounds of its own yet.
pub(crate) fn update_anchor_end_space(
    state: &mut TranscriptV2,
    anchor_row: usize,
    fallback_viewport: Pixels,
) -> Pixels {
    let mut viewport = state.anchored_rows.viewport_bounds().size.height;
    if viewport <= Pixels::ZERO {
        // The first frame after the switch has no prior bounds; the full
        // window is a conservative fallback that still guarantees the top
        // anchor until the list measures.
        viewport = fallback_viewport;
    }
    let anchored_tail_height =
        state
            .anchored_rows
            .item_count()
            .checked_sub(1)
            .and_then(|last_row| {
                let anchor = state.anchored_rows.bounds_for_item(anchor_row)?;
                let last = state.anchored_rows.bounds_for_item(last_row)?;
                Some((last.bottom() - anchor.top()).max(Pixels::ZERO))
            });
    let end_space = match anchored_tail_height {
        Some(height) => anchor_end_space(viewport, height),
        None => state
            .anchor
            .map(|anchor| anchor.end_space)
            .unwrap_or(Pixels::ZERO),
    };
    if let Some(anchor) = state.anchor.as_mut() {
        anchor.end_space = end_space;
    }
    end_space
}

/// The anchor machine's per-frame pass. Runs inside the render sync after
/// the splice reconciliation, and owns the pane's scroll while anchored:
///
/// - Settled (or failed/interrupted) turn, or an anchor the session no
///   longer backs: exit anchor mode.
/// - Re-resolve the anchor row from the turn (indices shift under
///   splices), then true up the end space.
/// - While following: re-assert the anchor row at the viewport top for as
///   long as the reservation holds — a remeasured response row briefly
///   overflows against the retained spacer and the overflow is taken from
///   the top of the prompt unless the anchor is reasserted in the same
///   layout pass. Once the reservation collapses the pin moves to the
///   tail (still on the anchored list): `scroll_to_end` parks past the
///   last item so layout walks backwards from the row's bottom as it
///   grows.
/// - Released: no re-assertion. The reader keeps their place; the
///   reservation still trues up (it is part of the document geometry, not
///   the pin).
fn maintain_anchor(tide: &mut Tide, window: &Window) {
    let Some(anchor) = tide.timeline_v2_state.anchor else {
        return;
    };
    // The session queries are read-only and finish before the state
    // mutation begins (borrow splitting: `selected_session` shares `tide`).
    let running = tide
        .selected_session()
        .is_some_and(|session| anchor_turn_running(session, anchor.turn));
    let row = tide.selected_session().and_then(|session| {
        anchor_row_for_turn(session, &tide.timeline_v2_state.row_cache, anchor.turn)
    });
    let state = &mut tide.timeline_v2_state;
    let row = match (running, row) {
        (true, Some(row)) => row,
        _ => {
            exit_anchor(state);
            return;
        }
    };
    if let Some(anchor) = state.anchor.as_mut() {
        anchor.row = row;
    }
    let end_space = update_anchor_end_space(state, row, window.viewport_size().height);
    if state.follow != FollowState::Following {
        return;
    }
    if end_space > Pixels::ZERO {
        state.anchored_rows.scroll_to(gpui::ListOffset {
            item_ix: row,
            offset_in_item: Pixels::ZERO,
        });
    } else if row + 1 < state.anchored_rows.item_count() {
        state.anchored_rows.scroll_to_end();
    }
}

/// Resolve the nav rail's turn openings from the v2 fold: each user message's
/// row (every message keeps its row in v2 — no fold hides a prompt) via the
/// same ascending cursor walk the legacy pane runs over its row kinds, plus
/// the next user message bounding the turn's response scan. Pure over the
/// fold so the opening rule stays unit-testable.
pub(crate) fn navigation_openings(
    session: &AgentSession,
    rows: &[TimelineV2Row],
) -> Vec<NavigationTurnOpening> {
    let user_message_indexes = session
        .messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| (message.role == MessageRole::User).then_some(index))
        .collect::<Vec<_>>();
    let mut row_cursor = 0;
    let mut openings = Vec::with_capacity(user_message_indexes.len());
    for (turn_index, message_index) in user_message_indexes.iter().copied().enumerate() {
        let row_index = loop {
            match rows.get(row_cursor) {
                None => break None,
                Some(TimelineV2Row::Message { index }) if *index >= message_index => {
                    break (*index == message_index).then_some(row_cursor);
                }
                Some(_) => row_cursor += 1,
            }
        };
        let Some(row_index) = row_index else {
            continue;
        };
        openings.push(NavigationTurnOpening {
            message_index,
            row_index,
            next_user_index: user_message_indexes
                .get(turn_index + 1)
                .copied()
                .unwrap_or(session.messages.len()),
        });
    }
    openings
}

/// Build the v2 transcript list: reconcile `ListState` with the derived rows,
/// then hand GPUI a virtualized list of plain rows.
pub(super) fn render_list(
    tide: &mut Tide,
    actions: TranscriptActions,
    window: &mut Window,
    cx: &mut Context<Tide>,
) -> AnyElement {
    let fingerprint = tide
        .selected_session()
        .map(|session| rows_fingerprint(session, is_streaming(session)));
    let epoch = tide.selected_session().map(text_epoch);
    // Whether this frame is the first folding a newly selected session —
    // anchor entry must not fire on it (legacy arms anchors only at
    // submission; a session switched into mid-stream shows its tail, not
    // a prompt pin). Computed before the reconcile so the switch branch
    // below can reuse it.
    let selected_id = tide.selected_session().map(|session| session.id);
    let session_switch = tide.timeline_v2_state.last_session_id != selected_id;

    let mut content_grew = false;
    // The stream pump marks `remeasure_due` at its commit cadence (see
    // `Tide::timeline_v2_remeasure_tail`); this sync consumes the mark by
    // running the epoch pass even when nothing else moved, then clears it
    // either way.
    let remeasure_due = std::mem::take(&mut tide.timeline_v2_state.remeasure_due);
    if tide.timeline_v2_state.last_fingerprint != fingerprint {
        // Row identity moved: refold and reconcile the list state with the
        // fresh rows via a splice plan instead of a blanket reset — the
        // reset's full re-measure is what flickered and un-anchored the
        // reader under stream cadence.
        //
        // The structural fold is also the switch skeleton's early yield (the
        // arm sits below, after this branch, so a switch frame clears-then-
        // arms rather than disarming itself): once content actually moves
        // under the pane, real rows outrank the gray flash, and the stored
        // mark never lingers behind rows that already reconciled.
        tide.timeline_v2_state.skeleton_until = None;
        let rows = tide
            .selected_session()
            .map(|session| derive_rows(session, is_streaming(session)))
            .unwrap_or_default();
        let count = rows.len();
        // A switch always resets (see [`sync_plan`]); every other fold takes
        // the honest plan, with the reset's viewport preservation on so a
        // genuine structural change re-measures without yanking the reader.
        let plan = sync_plan(session_switch, &tide.timeline_v2_state.row_cache, &rows);
        apply_splice_plan(&mut tide.timeline_v2_state, plan, count, !session_switch);
        let state = &mut tide.timeline_v2_state;
        state.row_cache = rows;
        state.last_fingerprint = fingerprint;
        // Reset already re-arms full measurement; adopting the epoch here
        // avoids a redundant tail remeasure on the same frame.
        state.last_text_epoch = epoch;
        content_grew = !matches!(plan, SplicePlan::None);
        // A user message landing at the tail is a send. Fold it through the
        // machine even though every state absorbs it: the tail follower must
        // not re-pin a released reader, and routing it here keeps the
        // composer wiring from having to reach into scroll state directly.
        // When the message OPENS a running turn, the send also enters anchor
        // mode — the prompt pins at the viewport top for the turn's life
        // (see [`enter_anchor`]). The session queries run before the state
        // mutation (borrow splitting).
        let detected = tide.selected_session().map(|session| {
            let send_tail = session
                .messages
                .last()
                .is_some_and(|message| message.role == MessageRole::User);
            let entry = anchor_send_turn(session).and_then(|turn| {
                anchor_row_for_turn(session, &tide.timeline_v2_state.row_cache, turn)
                    .map(|row| (turn, row))
            });
            (send_tail, entry)
        });
        if let Some((send_tail, entry)) = detected {
            let state = &mut tide.timeline_v2_state;
            if send_tail {
                state.follow = next_follow(state.follow, ScrollSignal::UserSent);
            }
            if let Some((turn, row)) = entry
                && !session_switch
                && state.anchor.map(|anchor| anchor.turn) != Some(turn)
            {
                enter_anchor(state, turn, row);
            }
        }
    } else if remeasure_due || tide.timeline_v2_state.last_text_epoch != epoch {
        // Fingerprint stable: the row list is not moving. Either the epoch
        // moved on its own (streamed text grew, tail heights stale) or the
        // pump asked for a pass — the mark alone changes nothing when the
        // epoch agrees, but it guarantees the check ran.
        if tide.timeline_v2_state.last_text_epoch != epoch {
            let count = tide.timeline_v2_state.row_cache.len();
            tide.timeline_v2_state.last_text_epoch = epoch;
            let from = count.saturating_sub(STREAM_REMEASURE_TAIL_ROWS);
            tide.timeline_v2_state.rows.remeasure_items(from..count);
            tide.timeline_v2_state
                .anchored_rows
                .remeasure_items(from..count);
            content_grew = true;
        }
    }

    // A disclosure toggle parks an anchor that survives exactly two passes:
    // request the remeasure, then fold the measured height delta back into
    // the scroll offset. Runs after the reconcile branches (a toggle moves
    // neither fingerprint nor epoch) and before the follow pin below, so a
    // frame that both grows the tail and closes an anchor still ends pinned
    // while following.
    apply_pending_disclosure_scroll(&mut tide.timeline_v2_state);

    // While following, growth must not strand the reader a viewport behind
    // the tail. `scroll_to_end` parks the list past the last item so layout
    // walks backwards from the row's bottom as it grows — the same anchor
    // the legacy pane leans on. A remeasure preserves the explicit anchor,
    // so the pin has to be re-asserted rather than assumed. While an anchor
    // is set the anchor machine owns this instead (its pin is the sent
    // prompt, not the tail).
    if tide.timeline_v2_state.anchor.is_some() {
        maintain_anchor(tide, window);
    } else if content_grew && tide.timeline_v2_state.follow == FollowState::Following {
        tide.timeline_v2_state.rows.scroll_to_end();
    }

    // The shared nav rail's snapshot — the legacy pane's compare-swap with v2
    // inputs. The turn list rebuild is keyed to the row fingerprint (the
    // legacy cache's shape, over the v2 fold), and the at-tail answer is the
    // follow machine's: following the follower list rests on the tail, while
    // everything else — released or anchored — reads the ACTIVE list's
    // logical top (the anchored twin pins the streaming turn's prompt there).
    // Runs before the skeleton return below so a switch frame hands the rail
    // the fresh session's turns.
    if tide.timeline_v2_state.navigation_turns_fingerprint != fingerprint {
        let turns = tide
            .selected_session()
            .map(|session| {
                navigation_turns(
                    session,
                    &navigation_openings(session, &tide.timeline_v2_state.row_cache),
                )
            })
            .unwrap_or_default();
        let state = &mut tide.timeline_v2_state;
        *state.navigation_turns.borrow_mut() = Rc::new(turns);
        state.navigation_turns_fingerprint = fingerprint;
    }
    let rail_turns = tide.timeline_v2_state.navigation_turns.borrow().clone();
    {
        let list = active_rows(&tide.timeline_v2_state);
        let viewport_bounds = list.viewport_bounds();
        let scrollable = viewport_bounds.size.height > Pixels::ZERO
            && list.max_offset_for_scrollbar().y > px(0.5);
        // The chat column's painted width — the legacy `chat_viewport_width`
        // formula, which the rail's visibility rule measures the content
        // column's left margin against. The inspector column's footprint is
        // part of that formula now that it consumes layout width.
        let chat_viewport_width = f32::from(window.viewport_size().width)
            - tide.sidebar_rendered_width
            - tide.right_panel_rendered_width
            - tide.inspector_rendered_width;
        let turn_rows = rail_turns
            .iter()
            .map(|turn| turn.row_index)
            .collect::<Vec<_>>();
        let at_tail = tide.timeline_v2_state.anchor.is_none()
            && tide.timeline_v2_state.follow == FollowState::Following;
        let active_turn =
            active_navigation_turn_index(&turn_rows, list.logical_scroll_top().item_ix, at_tail)
                .map(|index| rail_turns[index].message_id);
        let snapshot = ConversationNavigationRailSnapshot {
            visible: should_show_navigation_rail(scrollable, rail_turns.len(), chat_viewport_width),
            turns: rail_turns,
            viewport_height: f32::from(viewport_bounds.size.height),
            active_turn,
            reset_generation: tide.navigation_rail_reset_generation.get(),
            theme_is_dark: Theme::current(cx).is_dark,
        };
        if tide.navigation_rail.read(cx).snapshot != snapshot {
            tide.navigation_rail
                .update(cx, |rail, cx| rail.set_snapshot(snapshot, cx));
        }
    }

    // Session-switch skeleton: a changed selection arms a 150ms gray flash —
    // tide's placeholder while the new transcript lands. The arm runs AFTER
    // the reconcile above so a switch frame folds the new rows first (the
    // fingerprint branch's clear can never disarm a fresh arm) and only then
    // paints the blocks over them; the rows behind stay folded, unmeasured
    // until the flash yields. Idle sessions guarantee no wake at expiry (the
    // 120ms pump only ticks while streaming), so the flash may outlast its
    // window there until any next notify — acceptable v1: expiry clears on
    // the very next frame, and structural movement yields the flash early
    // through the branch's clear above.
    let selected_id = tide.selected_session().map(|session| session.id);
    if session_switch {
        tide.timeline_v2_state.last_session_id = selected_id;
        // The old session's anchor names a turn the new one cannot answer
        // for; drop it with the switch (the legacy pane clears its anchor
        // fields on selection change) so the pane lands on the
        // bottom-aligned follower.
        tide.timeline_v2_state.anchor = None;
        // A find bar holding the previous session's matches would misreveal
        // against the new one: close it with the switch (the field entity
        // drops with the state).
        tide.timeline_v2_state.search = None;
        tide.timeline_v2_state.skeleton_until =
            Some(std::time::Instant::now() + SESSION_SWITCH_SKELETON);
    }
    if skeleton_active(
        tide.timeline_v2_state.skeleton_until,
        std::time::Instant::now(),
    ) {
        return render_switch_skeleton(&Theme::current(cx));
    }

    // The list's item callback receives `&mut App`, not the view context, so
    // rows reach back into `Tide` through a weak entity — the legacy
    // transcript's pattern. The actions travel with the closure: rows never
    // touch `Tide` for behaviors. The rendered state is the ACTIVE list —
    // the anchored twin while a turn streams, the follower otherwise.
    let list_state = active_rows(&tide.timeline_v2_state).clone();
    // The anchor's reserved space rides as the list's bottom padding —
    // GPUI's list folds its padding into the document height, so the
    // reservation scrolls like content and keeps the anchored prompt put
    // while the reply grows into it. Zero while no anchor is set.
    let anchor_end_space = tide
        .timeline_v2_state
        .anchor
        .map(|anchor| anchor.end_space)
        .unwrap_or(Pixels::ZERO);
    let entity = cx.entity().downgrade();
    let list = list(list_state, move |ix, window, cx| {
        entity
            .upgrade()
            .map(|entity| {
                entity.update(cx, |this, cx| {
                    timeline_v2_row(this, ix, &actions, window, cx)
                })
            })
            .unwrap_or_else(|| div().into_any_element())
    })
    .size_full()
    // A constant breathing room below the last row before the composer, so
    // a settled transcript never kisses the input — folded into the list's
    // document height alongside the anchor reservation.
    .pb(px(16.0) + anchor_end_space);

    // Bubble-phase dispatch runs listeners in reverse registration order,
    // so the list's own scroll handling has already applied this tick by
    // the time the wrapper classifies it — the at-tail answer below speaks
    // for the post-tick position, not the pre-tick one.
    //
    // The wrapper is the pane column's flexible child (`flex_1` + `min_h_0`),
    // NOT `size_full`: a 100%-height sibling would consume the whole column
    // and push the pane's transient bottom sections (the permission and
    // follow-up question cards) past the fold, where the pane never shows
    // them.
    div()
        .id("timeline-v2-list")
        .w_full()
        .flex_1()
        .min_h_0()
        .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
            let delta_y = event.delta.pixel_delta(px(20.0)).y;
            let list = active_rows(&this.timeline_v2_state);
            let at_bottom = tolerant_rests_at_tail(
                list.viewport_bounds().bottom(),
                list.item_count()
                    .checked_sub(1)
                    .and_then(|last| list.bounds_for_item(last))
                    .map(|bounds| bounds.bottom()),
                this.timeline_v2_state
                    .anchor
                    .map(|anchor| anchor.end_space)
                    .unwrap_or(Pixels::ZERO),
            );
            if let Some(signal) = wheel_signal(delta_y, Some(at_bottom)) {
                let next = next_follow(this.timeline_v2_state.follow, signal);
                if next != this.timeline_v2_state.follow {
                    this.timeline_v2_state.follow = next;
                    cx.notify();
                }
            }
        }))
        .child(list)
        .into_any_element()
}

/// The floating re-pin affordance: a circular jump-to-bottom button pinned
/// bottom-right inside the pane. Shown only while following is released; the
/// click re-pins directly rather than through a signal — the reader is
/// explicitly asking to follow again.
pub(super) fn render_jump_button(tide: &Tide, cx: &mut Context<Tide>) -> Option<AnyElement> {
    // The legacy button's visibility rule: hidden while anchored-following
    // or unscrollable; a None (unmeasured tail) at-tail answer HOLDS the
    // previous value instead of flickering, via the same cached-cell trick
    // as `transcript_scroll_to_bottom_visible`.
    let state = &tide.timeline_v2_state;
    let scrollable = state.rows.max_offset_for_scrollbar().y > px(0.5);
    let anchored_following =
        state.anchor.is_some() && matches!(state.follow, FollowState::Following);
    let visible = if anchored_following || !scrollable {
        Some(false)
    } else {
        // Unmeasured tail (None) holds the previous frame's answer, the
        // legacy cell's trick; measured answers gate on follow state.
        state
            .rows
            .is_scrolled_to_end()
            .map(|at_end| !at_end && show_jump(state.follow))
    };
    let held = tide.timeline_v2_state.jump_visible.get();
    let visible = visible.or(held).unwrap_or(false);
    tide.timeline_v2_state.jump_visible.set(Some(visible));
    if !visible {
        return None;
    }
    let theme = Theme::current(cx);
    let focus = tide.transcript_control_focus("timeline-v2-scroll-to-bottom", cx);
    // The legacy construction: centered pill at the pane's bottom, full
    // focus + keyboard treatment.
    Some(
        div()
            .id("timeline-v2-scroll-to-bottom-layer")
            .absolute()
            .left_0()
            .bottom(px(8.0))
            .w_full()
            .flex()
            .justify_center()
            .child(
                div()
                    .id("timeline-v2-scroll-to-bottom")
                    .track_focus(&focus)
                    .tab_index(0)
                    .size(px(32.0))
                    .rounded_full()
                    .border_1()
                    .border_color(theme.border_strong)
                    .bg(theme.composer)
                    .shadow_xs()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_color(theme.accent))
                    .hover(|style| style.bg(theme.raised))
                    .active(|style| style.bg(theme.overlay_strong))
                    .child(icon("icons/arrow-down.svg", 16.0, theme.text))
                    .on_click(cx.listener(|this, _: &gpui::ClickEvent, _, cx| {
                        this.timeline_v2_state.follow = FollowState::Following;
                        active_rows(&this.timeline_v2_state).scroll_to_end();
                        cx.notify();
                        cx.stop_propagation();
                    }))
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.timeline_v2_state.follow = FollowState::Following;
                            active_rows(&this.timeline_v2_state).scroll_to_end();
                            cx.notify();
                            cx.stop_propagation();
                        }
                    })),
            )
            .into_any_element(),
    )
}

/// The gray blocks that flash while a freshly switched session's rows land:
/// tide's one-frame placeholder, held for [`SESSION_SWITCH_SKELETON`] — a
/// right-aligned user-bubble block, a reasoning line, a tool row, and a
/// left-aligned answer block, all `theme.overlay` fills in the pane's own
/// content column so the flash reads as the transcript it stands in for.
pub(crate) fn render_switch_skeleton(theme: &Theme) -> AnyElement {
    // The row wrapper's own geometry — full-width flex row centering the
    // bounded content column, 20px horizontal padding — so the gray blocks
    // land exactly where the timeline's rows will.
    div()
        .size_full()
        .flex()
        .justify_center()
        .px(px(20.0))
        .pt(px(16.0))
        .child(
            div()
                .w_full()
                .max_w(px(V2_CONTENT_MAX_WIDTH))
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(10.0))
                // The user bubble: right-aligned, bubble-shaped.
                .child(
                    div()
                        .self_end()
                        .min_w(px(320.0))
                        .max_w(px(540.0))
                        .h(px(40.0))
                        .rounded(px(12.0))
                        .bg(theme.overlay),
                )
                // The reasoning line.
                .child(
                    div()
                        .w(px(480.0))
                        .h(px(12.0))
                        .rounded(px(6.0))
                        .bg(theme.overlay),
                )
                // The tool row.
                .child(
                    div()
                        .w_full()
                        .h(px(24.0))
                        .rounded(px(7.0))
                        .bg(theme.overlay),
                )
                // The assistant answer block.
                .child(
                    div()
                        .w(px(560.0))
                        .h(px(60.0))
                        .rounded(px(10.0))
                        .bg(theme.overlay),
                ),
        )
        .into_any_element()
}

/// The pane's transient bottom section: the pending follow-up question card,
/// shown while the selected session's runtime waits on `ask_followup_question`
/// — v2's inline placement of the state the legacy pane renders above the
/// composer. The runtime's `PendingUserInput` answers everything (current
/// question, selections, custom answer, last-question flag); clicks route to
/// the same `pub(super)` answer methods the legacy card drives, so the
/// multi-question flow and the final `respond_user_input` submission are the
/// app's one path. The custom-answer field is the app's single
/// `user_input_answer` entity — its subscription already writes typing
/// through to the runtime and submits on Enter — shared with the legacy card
/// exactly the way the selection state is: only one pane renders at a time.
pub(super) fn render_pending_question(tide: &Tide, cx: &mut Context<Tide>) -> Option<AnyElement> {
    // The switch flash owns the pane's tail too: no card over gray blocks.
    if skeleton_active(
        tide.timeline_v2_state.skeleton_until,
        std::time::Instant::now(),
    ) {
        return None;
    }
    let pending = tide.selected_runtime()?.pending_user_input.as_ref()?;
    let question = pending.current_question()?;
    let selected = pending
        .selections
        .get(&question.id)
        .cloned()
        .unwrap_or_default();
    let custom_text = pending.custom_answers.get(&question.id).map(String::as_str);
    let is_last = pending.question_index + 1 == pending.questions.len();
    let card_id = format!("question-card-{}", pending.request_id);
    let theme = Theme::current(cx);

    // The group-toggle pattern for the label-carrying pick: the closure runs
    // outside the view context, so it upgrades the weak entity itself.
    let entity = cx.entity().downgrade();
    let select: SelectOption = Arc::new(
        move |label: &str, _: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
            let Some(entity) = entity.upgrade() else {
                return;
            };
            let label = label.to_owned();
            entity.update(cx, |this, cx| this.select_user_input_option(label, cx));
        },
    );
    let submit =
        Arc::new(cx.listener(|this, _: &gpui::ClickEvent, _, cx| this.advance_user_input(cx)));
    let input = tide.user_input_answer.clone();

    Some(
        div()
            .flex_none()
            .flex()
            .justify_center()
            .px(px(20.0))
            .pb(px(8.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(V2_CONTENT_MAX_WIDTH))
                    .min_w_0()
                    .child(render_question_card(
                        question,
                        &selected,
                        custom_text,
                        &input,
                        is_last,
                        &card_id,
                        &theme,
                        QuestionCardActions {
                            select_option: select,
                            submit,
                        },
                    )),
            )
            .into_any_element(),
    )
}

/// The pane's transient bottom section for permission asks: the pending
/// permission card, shown while the selected session's runtime waits on a
/// driver permission — v2's inline placement of the state the legacy pane
/// renders above the composer (`composer.rs`'s `render_permission`, which
/// stands down while the v2 pane is active). The runtime's
/// `PendingPermission` answers everything (title, detail, the driver's own
/// option ids and labels); every click routes through the same
/// `pub(super)` respond method the legacy card's buttons drive
/// (`Tide::respond_permission`), so the decision reaches the driver through
/// the app's one path. The chevron menu reuses the app's shared menu-handle
/// registry under one pane-scoped id — one card at a time — and floats on
/// the menu surface priority above this priority-0 pane.
pub(super) fn render_pending_permission(tide: &Tide, cx: &mut Context<Tide>) -> Option<AnyElement> {
    // The switch flash owns the pane's tail too: no card over gray blocks.
    if skeleton_active(
        tide.timeline_v2_state.skeleton_until,
        std::time::Instant::now(),
    ) {
        return None;
    }
    let permission = tide.selected_runtime()?.pending_permission.as_ref()?;
    let theme = Theme::current(cx);

    // The group-toggle pattern for the response: the closures run outside
    // the view context (the menu's items especially), so they upgrade the
    // weak entity themselves.
    let request_id = permission.request_id.clone();
    let entity = cx.entity().downgrade();
    let respond: PermissionRespond = Arc::new(
        move |option_id: &str, _: &mut gpui::Window, cx: &mut gpui::App| {
            let Some(entity) = entity.upgrade() else {
                return;
            };
            let option_id = option_id.to_owned();
            entity.update(cx, |this, cx| {
                this.respond_permission(request_id.clone(), option_id, cx)
            });
        },
    );

    let countdown = seconds_left(permission_deadline(permission), unix_time())
        .map(|left| tr!("permission.expires_in", seconds = left));
    let menu_handle = tide.menu_handle("timeline-v2-permission-menu", cx);

    Some(
        div()
            .flex_none()
            .flex()
            .justify_center()
            .px(px(20.0))
            .pb(px(8.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(V2_CONTENT_MAX_WIDTH))
                    .min_w_0()
                    .child(render_permission_card(
                        &permission.title,
                        &permission.detail,
                        &permission.options,
                        countdown.as_deref(),
                        &format!("permission-card-{}", permission.request_id),
                        &menu_handle,
                        &theme,
                        &respond,
                    )),
            )
            .into_any_element(),
    )
}

/// Render row `ix` of the cached derived rows: the rich row renderers where
/// the phase-3 anatomy exists (activity groups, the turn and working
/// footers), the plain pass elsewhere.
fn timeline_v2_row(
    tide: &mut Tide,
    ix: usize,
    actions: &TranscriptActions,
    _window: &mut Window,
    cx: &mut Context<Tide>,
) -> AnyElement {
    let Some(row) = tide.timeline_v2_state.row_cache.get(ix).copied() else {
        return div().into_any_element();
    };
    let theme = Theme::current(cx);
    let session = tide.selected_session();
    // Turn spacing rides the wrapper, not the body: every row kind the turn
    // opens (message or activity group) gets the same 12px above it, flush
    // at the session's first turn.
    let top_spacing = match session {
        Some(session) => spacing_before(session, &tide.timeline_v2_state.row_cache, ix),
        // No session means no cached rows either; nothing to space.
        None => px(0.0),
    };

    let body = match row {
        TimelineV2Row::Message { index } => match session.and_then(|s| s.messages.get(index)) {
            Some(message) if message.role == MessageRole::User => {
                render_user_message(tide, session, message, index, ix, &theme, cx)
            }
            // v1: every assistant message of a turn renders its text part
            // (multi-message turns are rare); the turn footer stays the only
            // turn-level chrome.
            Some(message) if message.role == MessageRole::Assistant => {
                render_assistant_message(tide, message, index, &theme, cx)
            }
            Some(message) => {
                let role = match message.role {
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                    MessageRole::System => "system",
                };
                let snippet: String = message
                    .visible_content()
                    .chars()
                    .take(PLAIN_SNIPPET_CHARS)
                    .collect();
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .py_1()
                    .child(plain_text(role, &theme))
                    .child(plain_text(snippet, &theme))
            }
            None => div(),
        },
        TimelineV2Row::ActivityGroup { block } => {
            let Some(block_data) = session.and_then(|s| s.transcript_blocks.get(block)) else {
                return div().into_any_element();
            };
            // The workspace every edit description relativizes against; owned
            // so the renderer borrows nothing from `tide` while it renders.
            let workspace = tide
                .selected_workspace_path()
                .map(std::path::Path::to_path_buf);
            let fallback_workspace = Path::new("");
            let activities: Vec<&ActivityItem> = block_data.activities.iter().collect();
            // Click wiring only this module can build — it owns the view
            // context and the toggle's list-row bookkeeping. Tool-card ids
            // lean on the anchor `toggle_disclosure` parks, whose render sync
            // owns the re-measure.
            let entity = cx.entity().downgrade();
            let card_toggle: GroupToggle = Arc::new(
                move |id: &str, _: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
                    let Some(entity) = entity.upgrade() else {
                        return;
                    };
                    entity.update(cx, |this, cx| this.toggle_disclosure(id, cx));
                },
            );
            // The reasoning bodies render through the shared per-activity
            // markdown cache — the legacy pane's own map — borrowed for the
            // list's render exactly the way the assistant body borrows the
            // message cache: the RefCell borrow spans this render and no
            // other markdown state is touched while it is held.
            let reasoning_metrics =
                tide.scaled_markdown_metrics(crate::md::render::Metrics::COMPACT);
            let reasoning_selection = tide.transcript_selection.clone();
            let reasoning_link_handler = tide.markdown_link_handler.clone();
            let reasoning_mermaid_handler = tide.markdown_mermaid_handler.clone();
            let reasoning_mermaid_host = tide.markdown_mermaid_host.clone();
            let reduce_motion = cx.reduce_motion();
            let mut reasoning_views = tide.activity_markdown.borrow_mut();
            let mut reasoning_markdown = ReasoningMarkdown {
                views: &mut reasoning_views,
                metrics: reasoning_metrics,
                selection: reasoning_selection,
                link_handler: Some(reasoning_link_handler),
                mermaid_handler: Some(reasoning_mermaid_handler),
                mermaid_host: Some(reasoning_mermaid_host),
                reduce_motion,
            };
            render_activities(
                &activities,
                &tide.timeline_v2_state.disclosures,
                workspace.as_deref().unwrap_or(fallback_workspace),
                actions,
                &theme,
                &mut reasoning_markdown,
                card_toggle,
            )
        }
        TimelineV2Row::TurnFooter { turn } => match session.and_then(|s| s.turns.get(turn)) {
            Some(turn_data) => {
                let copy_text = session
                    .and_then(|s| last_assistant_text(s, turn_data.id))
                    .filter(|text| !text.is_empty());
                let copy_for_click = copy_text.clone();
                let footer = render_turn_footer(
                    turn_data.id,
                    session.and_then(|s| s.model.as_deref()),
                    turn_duration(turn_data),
                    turn_data.started_at,
                    copy_text.as_deref(),
                    &theme,
                    // The clipboard write lives here — the only place with
                    // the app context — while the row owns the button.
                    move |_, _, cx| {
                        if let Some(text) = copy_for_click.as_deref() {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.to_owned()));
                        }
                    },
                );
                // A failed turn carries its error card above the footer's
                // divider — inside the footer row's flow, no new row kind.
                // Interrupted is a user stop, not an error; the pure fn
                // answers None for it and the footer stands alone.
                let error_block = match session.filter(|_| turn_data.status == TurnStatus::Failed) {
                    Some(s) => error_text_for_turn(turn_data, &s.messages).map(|text| {
                        render_turn_error_block(tide, s, ix, turn_data.id, &text, &theme, cx)
                    }),
                    None => None,
                };
                match error_block {
                    Some(block) => div().flex().flex_col().child(block).child(footer),
                    None => footer,
                }
            }
            None => div(),
        },
        TimelineV2Row::ChangedFiles { turn } => {
            let Some(turn_data) = session.and_then(|s| s.turns.get(turn)) else {
                return div().into_any_element();
            };
            // Gather every prepared change the turn's edit work produced —
            // the same blocks-and-FileChange-kind walk that gates the row —
            // and fold them once into the card's summary.
            let changes: Vec<&ActivityFileChange> = session
                .map(|session| {
                    session
                        .transcript_blocks
                        .iter()
                        .filter(|block| block.turn_id == Some(turn_data.id))
                        .flat_map(|block| block.activities.iter())
                        .filter(|activity| activity.kind == ActivityKind::FileChange)
                        .flat_map(|activity| activity.file_changes.iter())
                        .collect()
                })
                .unwrap_or_default();
            let summary = summarize_changes(changes);
            // The row gates on edit-kind activities, not on prepared changes:
            // a provider that filed the work without change records has
            // nothing for the card to say, so the row renders empty rather
            // than a card over zero files.
            if summary.files.is_empty() {
                return div().into_any_element();
            }
            let id = files_card_id(turn_data.id);
            let expanded = tide.timeline_v2_state.disclosures.contains(&id);
            let workspace = tide
                .selected_workspace_path()
                .map(std::path::Path::to_path_buf);
            // Synthetic-id toggle wiring, the cluster header's pattern: the
            // id names no activity so no scroll anchor resolves, and the row
            // re-measures directly inside the same update.
            let entity = cx.entity().downgrade();
            let row_ix = ix;
            let toggle: GroupToggle = Arc::new(
                move |id: &str, _: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
                    let Some(entity) = entity.upgrade() else {
                        return;
                    };
                    entity.update(cx, |this, cx| {
                        this.toggle_disclosure(id, cx);
                        active_rows(&this.timeline_v2_state).remeasure_items(row_ix..row_ix + 1);
                    });
                },
            );
            render_changed_files(
                &summary,
                workspace.as_deref().unwrap_or(Path::new("")),
                actions,
                &theme,
                expanded,
                &id,
                toggle,
            )
        }
        TimelineV2Row::Working => {
            // The ticker reads the running turn's start — full wall clock,
            // recomputed at render on the pump's wake cadence.
            let started_at = session
                .and_then(|s| s.active_turn_id())
                .and_then(|turn_id| {
                    session.and_then(|s| s.turns.iter().find(|turn| turn.id == turn_id))
                })
                .map(|turn| turn.started_at);
            render_working_footer(started_at, unix_time(), &theme)
        }
    };

    // Centered content column — the legacy pattern: a full-width flex row
    // that justifies its bounded child to center (`mx_auto` is not honored
    // inside the list's stretch column). `min_w_0` keeps the row honest
    // about long content so the cards inside can contain their overflow.
    div()
        .w_full()
        .min_w_0()
        .flex()
        .justify_center()
        .px(px(20.0))
        .when(top_spacing > Pixels::ZERO, |row| row.mt(top_spacing))
        .child(
            div()
                .w_full()
                .max_w(px(V2_CONTENT_MAX_WIDTH))
                .min_w_0()
                .child(body),
        )
        .into_any_element()
}

/// The failed turn's error card with its two click seams wired. The toggle
/// is the synthetic-id pattern (the id names no activity, so no scroll
/// anchor resolves — the row re-measures directly inside the same update);
/// Retry re-sends the turn's opening prompt through the composer submission
/// path, the app's one clean send seam: a fresh turn when the session is
/// idle, an honestly queued follow-up when it is busy. `None` when the turn
/// has no prompt to resend — the card renders without the button.
fn render_turn_error_block(
    tide: &Tide,
    session: &AgentSession,
    row_ix: usize,
    turn_id: uuid::Uuid,
    text: &str,
    theme: &Theme,
    cx: &mut Context<Tide>,
) -> gpui::Div {
    let id = error_block_id(turn_id);
    let expanded = tide.timeline_v2_state.disclosures.contains(&id);

    let entity = cx.entity().downgrade();
    let toggle: GroupToggle = Arc::new(
        move |id: &str, _: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
            let Some(entity) = entity.upgrade() else {
                return;
            };
            entity.update(cx, |this, cx| {
                this.toggle_disclosure(id, cx);
                this.timeline_v2_state
                    .rows
                    .remeasure_items(row_ix..row_ix + 1);
            });
        },
    );

    let on_retry = retry_text_for_turn(turn_id, &session.messages).map(|prompt| {
        let entity = cx.entity().downgrade();
        Arc::new(
            move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
                let Some(entity) = entity.upgrade() else {
                    return;
                };
                entity.update(cx, |this, cx| {
                    this.submit_composer_submission(
                        crate::app::ComposerSubmission::plain(prompt.clone()),
                        cx,
                    );
                });
            },
        ) as RetryAction
    });

    render_error_block(text, theme, expanded, &id, toggle, on_retry)
}

/// Plain-pass body text: secondary color, 12.5sp — enough to read the row's
/// identity without the rich renderers.
fn plain_text(content: impl Into<gpui::SharedString>, theme: &Theme) -> gpui::Div {
    div()
        .text_size(sp(12.5))
        .text_color(theme.text_secondary)
        .child(content.into())
}

/// The user-message row: the bubble anatomy from `parts::user_bubble` with
/// every click seam wired here, the only depth that holds the view context.
/// Read-only over `Tide` — the state it touches (disclosures, the open
/// editor) is read behind the same shared borrow as the session.
fn render_user_message(
    tide: &Tide,
    session: Option<&AgentSession>,
    message: &Message,
    index: usize,
    row_ix: usize,
    theme: &Theme,
    cx: &mut Context<Tide>,
) -> Div {
    let message_id = message.id;
    let content = message.visible_content().to_owned();
    let clamp = clamp_id(message_id);
    let expanded = tide.timeline_v2_state.disclosures.contains(&clamp);
    // The pencil's gate is the legacy action's rule: an editable session (not
    // busy, rollback-capable provider) and the turn's opening prompt — a
    // steer mid-turn is no rewind boundary. `begin_message_edit` re-checks
    // everything at click time, so a gate raced busy degrades to its toast.
    let editable = session.is_some_and(|s| {
        !s.status.is_busy()
            && s.provider.supports_conversation_rollback()
            && message_opens_turn(&s.messages, index)
    });
    let editing = tide
        .timeline_v2_state
        .editing
        .as_ref()
        .filter(|editing| editing.message_id == message_id);

    let actions = UserBubbleActions {
        edit: std::sync::Arc::new(cx.listener(move |this, _: &gpui::ClickEvent, window, cx| {
            this.timeline_v2_begin_edit(message_id, window, cx);
        })),
        cancel: std::sync::Arc::new(cx.listener(|this, _: &gpui::ClickEvent, window, cx| {
            this.timeline_v2_cancel_edit(window, cx);
        })),
        send: std::sync::Arc::new(cx.listener(|this, _: &gpui::ClickEvent, window, cx| {
            this.timeline_v2_send_edit(window, cx);
        })),
        confirm: std::sync::Arc::new(cx.listener(|this, _: &gpui::ClickEvent, window, cx| {
            this.timeline_v2_send_edit(window, cx);
        })),
        disarm: std::sync::Arc::new(cx.listener(|this, _: &gpui::ClickEvent, _, cx| {
            this.timeline_v2_disarm_confirm(cx);
        })),
    };

    // The clamp toggle, the synthetic-id pattern (the id names no activity so
    // no scroll anchor resolves): the row re-measures directly inside the
    // same update.
    let entity = cx.entity().downgrade();
    let toggle: GroupToggle = std::sync::Arc::new(
        move |id: &str, _: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut gpui::App| {
            let Some(entity) = entity.upgrade() else {
                return;
            };
            entity.update(cx, |this, cx| {
                this.toggle_disclosure(id, cx);
                this.timeline_v2_state
                    .rows
                    .remeasure_items(row_ix..row_ix + 1);
            });
        },
    );

    // The sent attachments: images resolve through the app's in-memory image
    // cache (a miss schedules its background fetch and lands on a later
    // frame), and the preview/menu wiring is built here where the listener
    // context lives. The frame path never touches the filesystem.
    let can_reveal = !tide.daemon.is_remote();
    let attachments = message
        .attachments
        .iter()
        .enumerate()
        .map(|(index, attachment)| {
            let image = if attachment.is_image {
                attachment.blob_reference.as_deref().and_then(|reference| {
                    tide.image_for_reference(
                        reference,
                        Some(&attachment.path),
                        Some(&attachment.name),
                        cx,
                    )
                })
            } else {
                None
            };
            let open_preview = image.as_ref().map(|image| {
                let image = Arc::clone(image);
                let name = SharedString::from(attachment.name.clone());
                std::sync::Arc::new(cx.listener(move |this, _: &gpui::ClickEvent, window, cx| {
                    this.open_image_preview(image.clone(), name.clone(), window, cx);
                })) as crate::app::timeline_v2::parts::user_bubble::UserBubbleAction
            });
            UserBubbleAttachment {
                key: format!("{message_id}-{index}"),
                name: SharedString::from(attachment.name.clone()),
                is_dir: attachment.is_dir,
                is_image: attachment.is_image,
                image,
                open_preview,
                menu: tide.menu_handle(
                    format!("timeline-v2-message-{message_id}-attachment-{index}"),
                    cx,
                ),
                reveal_path: attachment.path.clone(),
                can_reveal,
            }
        })
        .collect::<Vec<_>>();

    render_user_bubble(
        message_id,
        &content,
        message.created_at,
        expanded,
        editable,
        editing,
        &attachments,
        theme,
        actions,
        toggle,
    )
}

/// The assistant-message row: the markdown body (or, on a settled turn whose
/// whole reply parses as JSON, the generated-json card) from
/// `parts::text_part`. Read-only over `Tide` — the markdown state it touches
/// lives behind `RefCell`s, so the shared immutable borrow the session holds
/// stays valid. The per-message `MarkdownView` is the legacy pane's own
/// cache: parse state survives a pane switch, and the per-row context key
/// (`message-{id}`) matches the legacy rows exactly, so the view's flatten
/// caches line up across surfaces.
fn render_assistant_message(
    tide: &Tide,
    message: &Message,
    index: usize,
    theme: &Theme,
    cx: &Context<Tide>,
) -> Div {
    let palette = crate::md::render::Palette::from_theme(theme);
    let metrics = tide.scaled_markdown_metrics(crate::md::render::Metrics::BODY);
    let selection = tide.transcript_selection.clone();
    let link_handler = tide.markdown_link_handler.clone();
    let mermaid_handler = tide.markdown_mermaid_handler.clone();
    let mermaid_host = tide.markdown_mermaid_host.clone();
    let animate_streaming = message.streaming && !cx.reduce_motion();
    let search = tide.timeline_v2_search_highlights(index);
    // Parse only visible rows, the legacy row's discipline: the RefCell
    // borrow spans just this body render and no other markdown state is
    // touched while it is held.
    let mut views = tide.message_markdown.borrow_mut();
    let body = render_assistant_text(
        message,
        views.entry(message.id).or_default(),
        &palette,
        metrics,
        selection,
        Some(link_handler),
        Some(mermaid_handler),
        Some(mermaid_host),
        animate_streaming,
        search,
        theme,
    );
    drop(views);

    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .py(px(4.0))
        .child(body)
}
