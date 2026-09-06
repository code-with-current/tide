use super::list::{
    AnchorState, FollowState, ScrollSignal, SplicePlan, active_rows, anchor_end_space,
    anchor_row_for_turn, anchor_send_turn, anchor_turn_running, apply_splice_plan, disclosure_row,
    disclosure_scroll_adjustment, enter_anchor, exit_anchor, is_streaming, navigation_openings,
    next_follow, render_switch_skeleton, rests_at_tail, show_jump, skeleton_active,
    splice_decision, sync_plan, tolerant_rests_at_tail, update_anchor_end_space, wheel_signal,
};
use super::parts::diff_rows::{LineKind, MAX_DIFF_ROWS, classify_diff_line, diff_truncation};
use super::parts::question_card::{
    QuestionCardAction, SelectOption, answer_for_selection, render_option_row, render_submit_row,
    selected_indices,
};
use super::parts::reasoning_part::{
    ReasoningMarkdown, reasoning_content, reasoning_streaming, reasoning_summary,
    render_reasoning_body, render_reasoning_header,
};
use super::parts::static_tool_row::{ActivityPresentation, presentation_for};
use super::parts::text_part::{FinalizeKind, finalize_kind};
use super::parts::tool_part::{
    TodoState, agent_name, captured_output, content_body_source, description_for, diff_stat,
    disclosure_id, edit_path, failure_text, first_path_token, followup_parts, has_body,
    header_status_icon, is_content_tool, is_dispatch, is_followup_question, is_listing_tool,
    is_todo_write, label_for_activity, listing_path, looks_like_json, one_line, parse_todo_line,
    parse_todo_output, render_activity_body, todo_item, trailing_failure_icon,
};
use super::parts::user_bubble::{
    CLAMP_MAX_HEIGHT, UserBubbleActions, UserBubbleAttachment, clamp_id, clamp_needed,
    edit_removals, editor_actions_row, render_user_bubble,
};
use super::permission::{
    PermissionRespond, permission_deadline, permission_layout, render_permission_card, seconds_left,
};
use super::rows::activity_group::{GroupToggle, render_activities};
use super::rows::changed_files::{
    ChangesSummary, MAX_VISIBLE_FILES, counts_chip, files_card_id, header_title,
    render_changed_files, summarize_changes, visible_files,
};
use super::rows::error_block::{
    TURN_FAILED_FALLBACK, error_block_id, error_text_for_turn, render_error_block,
    retry_text_for_turn,
};
use super::rows::turn_item::{
    format_duration, last_assistant_text, model_segment, render_turn_footer, spacing_before,
    turn_duration, turn_top_spacing,
};
use super::rows::working_footer::{elapsed_since, render_working_footer};
use super::search::find_matches;
use super::*;
use crate::app::navigation_rail::NavigationTurnOpening;
use crate::model::{
    ActivityFileChange, ActivityFileChangeStatus, ActivityItem, ActivityKind, AgentSession,
    AgentTurn, MessageRole, PendingPermission, PermissionOption, ProviderKind, ReasoningBlock,
    SessionStatus, TranscriptBlock, TurnStatus, UserInputOption, UserInputQuestion,
};
use crate::ui::menu::ContextMenuHandle;
use gpui::Pixels;
use gpui::TestAppContext;
use gpui::px;
use uuid::Uuid;

/// A turn that did tool work before answering: one activity block anchored
/// after the prompt, then the assistant's reply. The v2 workhorse shape.
fn session_with_completed_turn(kind: ActivityKind) -> AgentSession {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn_id = session.begin_turn("Build it");
    session.transcript_blocks.push(TranscriptBlock {
        // A block anchored at `n` renders after the first `n` messages —
        // here: after the prompt (message 0), before the reply.
        after_message: 1,
        turn_id: Some(turn_id),
        activities: vec![ActivityItem::new(None, kind, "Did the work", None, true)],
    });
    session.push_message(MessageRole::Assistant, "Done.");
    session.finish_active_turn(TurnStatus::Completed);
    session
}

#[test]
fn rows_mirror_turn_order() {
    let session = session_with_completed_turn(ActivityKind::Command);

    assert_eq!(
        derive_rows(&session, false),
        vec![
            TimelineV2Row::Message { index: 0 },
            TimelineV2Row::ActivityGroup { block: 0 },
            TimelineV2Row::Message { index: 1 },
            TimelineV2Row::TurnFooter { turn: 0 },
        ],
        "user prompt, its anchored activity block, the reply, then the footer"
    );

    // A turn still running renders its work in the same order but no footer.
    let mut streaming_session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn_id = streaming_session.begin_turn("Build it");
    streaming_session.transcript_blocks.push(TranscriptBlock {
        after_message: 1,
        turn_id: Some(turn_id),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::Command,
            "Working",
            None,
            false,
        )],
    });
    streaming_session.push_message(MessageRole::Assistant, "Partial answer");
    assert_eq!(
        derive_rows(&streaming_session, false),
        vec![
            TimelineV2Row::Message { index: 0 },
            TimelineV2Row::ActivityGroup { block: 0 },
            TimelineV2Row::Message { index: 1 },
        ],
        "a running turn has no footer yet"
    );
}

#[test]
fn streaming_tail_appends_working_row() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("Build it");
    session.push_message(MessageRole::Assistant, "Thinking…");

    let idle = derive_rows(&session, false);
    let streaming = derive_rows(&session, true);
    assert!(
        matches!(streaming.last(), Some(TimelineV2Row::Working)),
        "the working row closes the list while streaming: {streaming:?}"
    );
    assert_eq!(streaming.len(), idle.len() + 1);
    assert!(
        !idle.iter().any(|row| matches!(row, TimelineV2Row::Working)),
        "no working row once the stream settles: {idle:?}"
    );
    assert_ne!(
        rows_fingerprint(&session, true),
        rows_fingerprint(&session, false),
        "the streaming flag is part of the row identity"
    );
}

#[test]
fn fingerprint_stable_when_session_unchanged() {
    let mut session = session_with_completed_turn(ActivityKind::FileChange);

    // A second turn keeps both fact streams interesting: settled work above,
    // live work below.
    session.begin_turn("One more thing");
    session.push_message(MessageRole::Assistant, "Part way");

    assert_eq!(
        rows_fingerprint(&session, true),
        rows_fingerprint(&session, true),
        "an unchanged session must hash equal"
    );
    assert_eq!(
        rows_fingerprint(&session, false),
        rows_fingerprint(&session, false)
    );
}

#[test]
fn fingerprint_moves_on_activity_completion() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn_id = session.begin_turn("Build it");
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 1,
        turn_id: Some(turn_id),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::Command,
            "Ran tests",
            None,
            false,
        )],
    });
    session.push_message(MessageRole::Assistant, "Done.");

    let before = rows_fingerprint(&session, false);

    // The activity finishing is the only change.
    session.transcript_blocks[0].activities[0].complete = true;
    assert_ne!(
        rows_fingerprint(&session, false),
        before,
        "a completion flip must move the fingerprint"
    );
}

#[test]
fn fingerprint_moves_on_new_message_or_activity() {
    let mut session = session_with_completed_turn(ActivityKind::Command);

    let before = rows_fingerprint(&session, false);

    session.begin_turn("One more thing");
    assert_ne!(
        rows_fingerprint(&session, false),
        before,
        "a new message must move the fingerprint"
    );

    let with_turn = rows_fingerprint(&session, false);
    session.transcript_blocks.push(TranscriptBlock {
        after_message: session.messages.len(),
        turn_id: session.active_turn_id(),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::Command,
            "More work",
            None,
            false,
        )],
    });
    assert_ne!(
        rows_fingerprint(&session, false),
        with_turn,
        "a new activity must move the fingerprint"
    );

    let with_block = rows_fingerprint(&session, false);
    session.transcript_blocks[1]
        .activities
        .push(ActivityItem::new(
            None,
            ActivityKind::FileRead,
            "Read a file",
            None,
            false,
        ));
    assert_ne!(
        rows_fingerprint(&session, false),
        with_block,
        "an activity appended to an existing block must move the fingerprint"
    );
}

#[test]
fn changed_files_row_only_for_file_edits() {
    let mut session = session_with_completed_turn(ActivityKind::FileChange);
    let edit_turn = 0;
    session.begin_turn("Look around");
    session.transcript_blocks.push(TranscriptBlock {
        after_message: session.messages.len(),
        turn_id: session.active_turn_id(),
        activities: vec![
            ActivityItem::new(None, ActivityKind::FileRead, "Read main.rs", None, true),
            ActivityItem::new(None, ActivityKind::Command, "cargo check", None, true),
        ],
    });
    session.push_message(MessageRole::Assistant, "All clean.");
    session.finish_active_turn(TurnStatus::Completed);

    let rows = derive_rows(&session, false);
    assert_eq!(
        rows.iter()
            .filter(|row| matches!(row, TimelineV2Row::ChangedFiles { .. }))
            .count(),
        1,
        "exactly one file-change summary, for the editing turn: {rows:?}"
    );
    assert!(
        rows.contains(&TimelineV2Row::ChangedFiles { turn: edit_turn }),
        "the changed-files row names the turn that edited files: {rows:?}"
    );
    let footer_position = rows
        .iter()
        .position(|row| matches!(row, TimelineV2Row::TurnFooter { turn } if *turn == edit_turn));
    let changed_position = rows
        .iter()
        .position(|row| *row == TimelineV2Row::ChangedFiles { turn: edit_turn });
    assert!(
        footer_position
            .zip(changed_position)
            .is_some_and(|(footer, changed)| footer < changed),
        "the file-change summary follows the turn footer: {rows:?}"
    );

    // A read-only turn shows neither footer extras nor a changed-files row
    // while it is still running, edits or not.
    let mut running = session_with_completed_turn(ActivityKind::FileChange);
    running.begin_turn("Edit live");
    running.transcript_blocks.push(TranscriptBlock {
        after_message: running.messages.len(),
        turn_id: running.active_turn_id(),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::FileChange,
            "Editing live",
            None,
            false,
        )],
    });
    let rows = derive_rows(&running, true);
    assert!(
        !rows.contains(&TimelineV2Row::ChangedFiles { turn: 1 }),
        "a running turn keeps its file changes out of the summary until it settles: {rows:?}"
    );
    assert!(
        !rows.contains(&TimelineV2Row::TurnFooter { turn: 1 }),
        "nor does it render a footer: {rows:?}"
    );
    assert!(
        rows.contains(&TimelineV2Row::ChangedFiles { turn: 0 }),
        "the settled turn above keeps its summary: {rows:?}"
    );
}

#[test]
fn follow_transitions() {
    use FollowState::{Following, Released};
    use ScrollSignal::{AtBottom, ScrolledUp, UserSent};

    // Leaving the tail by wheel releases the pin.
    assert_eq!(next_follow(Following, ScrolledUp), Released);
    // Resting on the bottom again re-pins.
    assert_eq!(next_follow(Released, AtBottom), Following);
    // At-bottom while already following changes nothing.
    assert_eq!(next_follow(Following, AtBottom), Following);
    // Scrolling up while released stays released.
    assert_eq!(next_follow(Released, ScrolledUp), Released);
    // A send never re-pins a released reader: the jump button remains until
    // they return to the bottom on their own.
    assert_eq!(next_follow(Released, UserSent), Released);
    assert_eq!(next_follow(Following, UserSent), Following);
}

#[test]
fn jump_button_visibility() {
    assert!(
        !show_jump(FollowState::Following),
        "no affordance while pinned to the tail"
    );
    assert!(
        show_jump(FollowState::Released),
        "the re-pin affordance shows exactly while released"
    );
}

#[test]
fn wheel_ticks_classified() {
    use ScrollSignal::{AtBottom, ScrolledUp};
    // GPUI's convention: positive vertical delta scrolls toward the top —
    // content moves down and the reader leaves the tail.
    assert_eq!(wheel_signal(px(10.0), Some(true)), Some(ScrolledUp));
    assert_eq!(wheel_signal(px(3.0), Some(false)), Some(ScrolledUp));
    // A toward-bottom tick only re-pins once the list reports the end
    // reached; part-way down is still released.
    assert_eq!(wheel_signal(px(-10.0), Some(false)), None);
    assert_eq!(wheel_signal(px(-10.0), Some(true)), Some(AtBottom));
    // Unknown position (unscrollable or unmeasured content) cannot claim the
    // bottom, and a purely horizontal tick carries no signal.
    assert_eq!(wheel_signal(px(-10.0), None), None);
    assert_eq!(wheel_signal(Pixels::ZERO, Some(true)), None);
}

// ── The send-time anchor (the legacy scroll behavior) ──────────────────────

#[test]
fn anchor_end_space_reserves_what_the_reply_has_not_filled() {
    // A fresh send: only the prompt sits below the anchor's top, so the
    // reservation is nearly the whole viewport.
    assert_eq!(anchor_end_space(px(700.0), px(40.0)), px(660.0));
    // The reply grows INTO the reservation: the span from the anchor's
    // top to the viewport's bottom stays constant.
    assert_eq!(anchor_end_space(px(700.0), px(512.0)), px(188.0));
    // A reply taller than the viewport collapses the reservation to zero
    // — the pin moves to the tail.
    assert_eq!(anchor_end_space(px(700.0), px(900.0)), px(0.0));
}

#[test]
fn rests_at_tail_counts_the_reservation_and_tolerates_the_unmeasured() {
    // Tail flush with the viewport bottom: at rest.
    assert_eq!(
        rests_at_tail(px(700.0), Some(px(700.0)), px(0.0)),
        Some(true)
    );
    // The reservation is part of the document: the tail row may sit above
    // the bottom by exactly that much and still be at rest.
    assert_eq!(
        rests_at_tail(px(700.0), Some(px(500.0)), px(200.0)),
        Some(true)
    );
    // Half a pixel of tolerance, no more.
    assert_eq!(
        rests_at_tail(px(700.0), Some(px(500.5)), px(200.0)),
        Some(true)
    );
    assert_eq!(
        rests_at_tail(px(700.0), Some(px(500.6)), px(200.0)),
        Some(false)
    );
    // An unmeasured tail row is unknowable, not false — the stream pump
    // remeasures the tail at commit cadence.
    assert_eq!(rests_at_tail(px(700.0), None, px(0.0)), None);
    // The wheel classifier's tolerance: the unmeasured frame defaults to
    // at-rest so streaming growth cannot swallow a legitimate re-pin.
    assert!(tolerant_rests_at_tail(px(700.0), None, px(0.0)));
    assert!(!tolerant_rests_at_tail(
        px(700.0),
        Some(px(600.0)),
        px(200.0)
    ));
}

#[test]
fn anchor_send_turn_requires_a_running_turn_the_tail_opens() {
    // A send: the prompt opens a running turn.
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn = session.begin_turn("Build it");
    assert_eq!(anchor_send_turn(&session), Some(turn));
    assert!(anchor_turn_running(&session, turn));

    // A steer lands as the new tail but does not OPEN the turn, so it
    // never re-anchors — the turn's opening prompt keeps the pin.
    session.push_message(MessageRole::User, "and hurry");
    assert_eq!(anchor_send_turn(&session), None, "a steer never re-anchors");
    assert!(
        anchor_turn_running(&session, turn),
        "the turn itself runs on"
    );

    // Streaming: the tail is the assistant's — no send signal while the
    // reply grows.
    let mut streaming = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    streaming.begin_turn("Build it");
    streaming.push_message(MessageRole::Assistant, "Part");
    assert_eq!(anchor_send_turn(&streaming), None);

    // Settled: the anchor's lease ends (completed, failed, or interrupted).
    let mut settled = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let done = settled.begin_turn("Build it");
    settled.push_message(MessageRole::Assistant, "Done.");
    settled.finish_active_turn(TurnStatus::Completed);
    assert_eq!(anchor_send_turn(&settled), None);
    assert!(!anchor_turn_running(&settled, done));
}

#[test]
fn anchor_row_resolves_the_opening_prompt_and_survives_row_shifts() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn = session.begin_turn("Build it");
    let rows = derive_rows(&session, true);
    assert_eq!(anchor_row_for_turn(&session, &rows, turn), Some(0));

    // Tail appends never move the prompt's row.
    session.push_message(MessageRole::Assistant, "Part");
    let rows = derive_rows(&session, true);
    assert_eq!(anchor_row_for_turn(&session, &rows, turn), Some(0));

    // Rows landing ABOVE the anchor (a settled earlier turn owns the
    // prompt row and its footer) shift the resolved index — exactly why
    // the machine re-resolves from the turn id every sync instead of
    // trusting a stored row.
    let mut two_turns = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let first = two_turns.begin_turn("Earlier question");
    two_turns.finish_active_turn(TurnStatus::Completed);
    let second = two_turns.begin_turn("Build it");
    let rows = derive_rows(&two_turns, false);
    assert_eq!(anchor_row_for_turn(&two_turns, &rows, first), Some(0));
    assert_eq!(anchor_row_for_turn(&two_turns, &rows, second), Some(2));

    // An anchor the rows no longer back — session switched, prompt pruned,
    // unknown turn — resolves to nothing: the machine's exit condition.
    let empty: Vec<TimelineV2Row> = Vec::new();
    assert_eq!(anchor_row_for_turn(&two_turns, &empty, second), None);
    assert_eq!(
        anchor_row_for_turn(&two_turns, &rows, Uuid::new_v4()),
        None,
        "an unknown turn has no prompt row"
    );
}

#[test]
fn active_list_follows_the_anchor() {
    let mut state = TranscriptV2::new();
    assert!(
        std::ptr::eq(active_rows(&state), &state.rows),
        "no anchor: the bottom-aligned follower renders"
    );
    state.anchor = Some(AnchorState {
        turn: Uuid::new_v4(),
        row: 0,
        end_space: px(0.0),
    });
    assert!(
        std::ptr::eq(active_rows(&state), &state.anchored_rows),
        "an anchor set: the top-aligned twin renders"
    );
}

#[test]
fn enter_and_exit_anchor_drive_the_follow_state() {
    let mut state = TranscriptV2::new();
    state.follow = FollowState::Released;
    let turn = Uuid::new_v4();
    enter_anchor(&mut state, turn, 3);
    assert_eq!(
        state.anchor.map(|anchor| (anchor.turn, anchor.row)),
        Some((turn, 3))
    );
    assert_eq!(
        state.follow,
        FollowState::Following,
        "the send re-pins: the anchor is the send's pin, whatever followed before"
    );

    // A settled exit hands the pane back to the follower, pinned to the
    // tail.
    exit_anchor(&mut state);
    assert!(state.anchor.is_none());
    assert_eq!(state.follow, FollowState::Following);

    // A released exit keeps the reader's place: following stays released
    // and the jump button remains theirs.
    enter_anchor(&mut state, turn, 1);
    state.follow = FollowState::Released;
    exit_anchor(&mut state);
    assert_eq!(state.follow, FollowState::Released);
}

/// Shorthand row builders so the splice table reads as a row list, not a
/// pile of struct literals.
mod rows {
    use super::super::TimelineV2Row;

    pub fn message(index: usize) -> TimelineV2Row {
        TimelineV2Row::Message { index }
    }

    pub fn group(block: usize) -> TimelineV2Row {
        TimelineV2Row::ActivityGroup { block }
    }

    pub fn footer(turn: usize) -> TimelineV2Row {
        TimelineV2Row::TurnFooter { turn }
    }

    pub fn working() -> TimelineV2Row {
        TimelineV2Row::Working
    }
}

#[test]
fn splice_identical_lists_pass_as_none() {
    let rows = vec![rows::message(0), rows::message(1), rows::working()];
    assert_eq!(splice_decision(&rows, &rows), SplicePlan::None);
    // Two empty lists are just as identical.
    assert_eq!(splice_decision(&[], &[]), SplicePlan::None);
}

#[test]
fn splice_pure_growth_appends() {
    // A prefix-equal longer list splices at the old end; every measurement
    // before it survives.
    let old = vec![rows::message(0), rows::message(1)];
    let new = vec![
        rows::message(0),
        rows::message(1),
        rows::message(2),
        rows::footer(0),
    ];
    assert_eq!(splice_decision(&old, &new), SplicePlan::Append { from: 2 });

    // The first rows ever derived are an append from zero.
    let first = vec![rows::message(0)];
    assert_eq!(splice_decision(&[], &first), SplicePlan::Append { from: 0 });
}

#[test]
fn splice_tail_change_remeasures_from_first_difference() {
    // Same count, first difference mid-list: the prefix keeps its
    // measurements, everything from the difference re-measures.
    let old = vec![rows::message(0), rows::working(), rows::message(1)];
    let new = vec![rows::message(0), rows::footer(0), rows::message(1)];
    assert_eq!(
        splice_decision(&old, &new),
        SplicePlan::TailRemeasure { from: 1 }
    );

    // Boundary: a difference confined to the very last row remeasures just
    // that row — the streaming case the plan exists for.
    let old = vec![rows::message(0), rows::message(1), rows::working()];
    let new = vec![rows::message(0), rows::message(1), rows::footer(0)];
    assert_eq!(
        splice_decision(&old, &new),
        SplicePlan::TailRemeasure { from: 2 },
        "from must be len-1 when only the last row moved"
    );
}

#[test]
fn splice_head_change_resets() {
    // Boundary: a same-length difference at index zero means the whole list
    // shifted under the pane — nothing is trustworthy, so the honest plan is
    // a full reset, not a remeasure-from-zero.
    let old = vec![rows::message(0), rows::message(1), rows::message(2)];
    let new = vec![rows::footer(0), rows::message(1), rows::message(2)];
    assert_eq!(splice_decision(&old, &new), SplicePlan::Reset);
}

#[test]
fn splice_pure_shrink_still_resets() {
    // Rows removed from the end with an identical prefix: the shrink has no
    // first difference to anchor a tail rewrite on, and the honest reading of
    // a shorter list (a rewind, a pruned tail) is a fresh fold — reset, with
    // the reset's viewport preservation keeping the reader put.
    let old = vec![rows::message(0), rows::working()];
    let new = vec![rows::message(0)];
    assert_eq!(splice_decision(&old, &new), SplicePlan::Reset);

    // A prefix-equal shrink mid-conversation rewinds the same way.
    let old = vec![rows::message(0), rows::footer(0), rows::message(1)];
    let new = vec![rows::message(0), rows::footer(0)];
    assert_eq!(splice_decision(&old, &new), SplicePlan::Reset);
}

// ── Tail rewrites: streaming must never reset the whole list ────────────────

#[test]
fn turn_end_replaces_the_tail_instead_of_resetting() {
    // Streaming with file-edit work: prompt, one edit block, the partial
    // reply, then the working row.
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("Fix it");
    session.status = SessionStatus::Working;
    let turn = session.active_turn_id().expect("turn runs");
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 1,
        turn_id: Some(turn),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::FileChange,
            "edit_file",
            None,
            false,
        )],
    });
    session.push_message(MessageRole::Assistant, "Par");

    let streaming = derive_rows(&session, true);
    assert_eq!(
        streaming,
        vec![
            TimelineV2Row::Message { index: 0 },
            TimelineV2Row::ActivityGroup { block: 0 },
            TimelineV2Row::Message { index: 1 },
            TimelineV2Row::Working,
        ],
        "the working row closes the streaming list"
    );

    // The turn settles: the working row leaves while the footer and the
    // file-change summary arrive — the count differs AND the diff sits at
    // the tail, exactly where the reader is reading.
    session.finish_active_turn(TurnStatus::Completed);
    session.status = SessionStatus::Idle;
    let settled = derive_rows(&session, false);
    assert_eq!(
        settled,
        vec![
            TimelineV2Row::Message { index: 0 },
            TimelineV2Row::ActivityGroup { block: 0 },
            TimelineV2Row::Message { index: 1 },
            TimelineV2Row::TurnFooter { turn: 0 },
            TimelineV2Row::ChangedFiles { turn: 0 },
        ]
    );

    // The honest plan rewrites the tail: rows above the working row keep
    // their measurements and their scroll offset — no full reset yank at
    // the moment the turn's content stops moving.
    assert_eq!(
        splice_decision(&streaming, &settled),
        SplicePlan::TailReplace { from: 3 },
        "working → footer(+changed-files) is a tail rewrite, not a reset"
    );

    // The same settle without file edits is same-count — the existing
    // TailRemeasure path.
    let mut plain = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    plain.begin_turn("Look");
    plain.status = SessionStatus::Working;
    plain.push_message(MessageRole::Assistant, "Par");
    let plain_streaming = derive_rows(&plain, true);
    plain.finish_active_turn(TurnStatus::Completed);
    plain.status = SessionStatus::Idle;
    assert_eq!(
        splice_decision(&plain_streaming, &derive_rows(&plain, false)),
        SplicePlan::TailRemeasure { from: 2 }
    );
}

#[test]
fn streaming_insertions_before_the_working_row_replace_the_tail() {
    // A block landing while the working row holds the tail: the insertion
    // sits BEFORE it, so the shared prefix differs at the working row with a
    // longer new list — every streaming turn hits this shape.
    let streaming = vec![rows::message(0), rows::working()];
    let with_block = vec![rows::message(0), rows::group(0), rows::working()];
    assert_eq!(
        splice_decision(&streaming, &with_block),
        SplicePlan::TailReplace { from: 1 }
    );

    // The reply's first message landing — same shape, one slot further down.
    let with_reply = vec![
        rows::message(0),
        rows::group(0),
        rows::message(1),
        rows::working(),
    ];
    assert_eq!(
        splice_decision(&with_block, &with_reply),
        SplicePlan::TailReplace { from: 2 }
    );

    // A second block after the partial reply.
    let with_second = vec![
        rows::message(0),
        rows::group(0),
        rows::message(1),
        rows::group(1),
        rows::working(),
    ];
    assert_eq!(
        splice_decision(&with_reply, &with_second),
        SplicePlan::TailReplace { from: 3 }
    );

    // A tail rewrite may also SHRINK: rows from the first difference down
    // are replaced by fewer rows (a failed turn's footer replacing the
    // working row and a dangling block).
    let pruned = vec![rows::message(0), rows::footer(0)];
    assert_eq!(
        splice_decision(&with_block, &pruned),
        SplicePlan::TailReplace { from: 1 }
    );
}

#[test]
fn full_streaming_sequence_never_resets_after_the_initial_fold() {
    // The reducer-level simulation of one whole streaming turn: send →
    // reasoning block → tool block → deltas → completion flips → turn end →
    // next send. Every structural frame is classified against the previous
    // cache exactly the way `render_list` does.
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let mut cache: Vec<TimelineV2Row> = Vec::new();
    let mut plans: Vec<SplicePlan> = Vec::new();
    let fold =
        |session: &AgentSession, cache: &mut Vec<TimelineV2Row>, plans: &mut Vec<SplicePlan>| {
            let rows = derive_rows(session, is_streaming(session));
            plans.push(splice_decision(cache, &rows));
            *cache = rows;
        };

    // Seed one settled turn so the pane has history above the stream: the
    // prompt folds first, the footer lands when the turn settles.
    session.begin_turn("Earlier question");
    fold(&session, &mut cache, &mut plans); // [] → prompt: the initial fold
    session.finish_active_turn(TurnStatus::Completed);
    fold(&session, &mut cache, &mut plans); // footer lands: append
    assert_eq!(plans[0], SplicePlan::Append { from: 0 });
    assert_eq!(plans[1], SplicePlan::Append { from: 1 });

    // Send: a new turn opens and the pane starts streaming.
    session.begin_turn("Fix it");
    session.status = SessionStatus::Working;
    fold(&session, &mut cache, &mut plans); // prompt + working row append

    // A reasoning block lands after the prompt, then completes.
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 2,
        turn_id: session.active_turn_id(),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::Reasoning,
            "Thinking",
            None,
            false,
        )],
    });
    fold(&session, &mut cache, &mut plans); // block before the working row
    session.transcript_blocks[0].activities[0].complete = true;
    fold(&session, &mut cache, &mut plans); // completion: rows unchanged

    // The reply starts streaming, then grows a delta.
    session.push_message(MessageRole::Assistant, "Par");
    fold(&session, &mut cache, &mut plans); // message before the working row
    session
        .messages
        .last_mut()
        .expect("reply exists")
        .content
        .push_str("tial answer");
    fold(&session, &mut cache, &mut plans); // text growth: rows unchanged

    // An edit block after the partial reply completes with changes.
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 3,
        turn_id: session.active_turn_id(),
        activities: vec![ActivityItem::new(
            None,
            ActivityKind::FileChange,
            "edit_file",
            None,
            false,
        )],
    });
    fold(&session, &mut cache, &mut plans); // second block before the working row
    session.transcript_blocks[1].activities[0].complete = true;
    fold(&session, &mut cache, &mut plans); // completion: rows unchanged

    // The turn settles: working leaves, footer + changed-files arrive.
    session.finish_active_turn(TurnStatus::Completed);
    session.status = SessionStatus::Idle;
    fold(&session, &mut cache, &mut plans);

    // The next send opens the following turn.
    session.begin_turn("One more");
    session.status = SessionStatus::Working;
    fold(&session, &mut cache, &mut plans);

    assert!(
        !plans.contains(&SplicePlan::Reset),
        "no frame of a streaming turn may reset the list — the reset's \
         full remeasure plus lost scroll anchor is the visible jump; plans: \
         {plans:?}"
    );
    // And the shape of the sequence: the seed appends, the send appends, the
    // three inserts before the working row and the turn end are tail
    // rewrites, and content-only frames (completions, text deltas) never
    // touch the structure.
    assert_eq!(plans[2], SplicePlan::Append { from: 2 });
    assert_eq!(plans[3], SplicePlan::TailReplace { from: 3 });
    assert_eq!(plans[4], SplicePlan::None);
    assert_eq!(plans[5], SplicePlan::TailReplace { from: 4 });
    assert_eq!(plans[6], SplicePlan::None);
    assert_eq!(plans[7], SplicePlan::TailReplace { from: 5 });
    assert_eq!(plans[8], SplicePlan::None);
    assert_eq!(plans[9], SplicePlan::TailReplace { from: 6 });
    assert_eq!(
        *plans.last().expect("non-empty"),
        SplicePlan::Append { from: 8 }
    );
}

#[test]
fn session_switches_reset_even_when_row_shapes_coincide() {
    // Rows are index-based, so two sessions can fold to the same row list —
    // but the cached heights belong to the old session's content. A switch
    // always resets (fresh heights, tail pin for the bottom-aligned
    // follower), whatever the shapes claim.
    let rows = vec![rows::message(0), rows::footer(0)];
    assert_eq!(sync_plan(true, &rows, &rows), SplicePlan::Reset);
    assert_eq!(sync_plan(false, &rows, &rows), SplicePlan::None);

    let longer = vec![rows::message(0), rows::footer(0), rows::message(1)];
    assert_eq!(sync_plan(true, &rows, &longer), SplicePlan::Reset);
    assert_eq!(
        sync_plan(false, &rows, &longer),
        SplicePlan::Append { from: 2 }
    );
}

#[test]
fn tail_replace_splices_both_lists_and_keeps_rows_above_the_scroll() {
    let mut pane = TranscriptV2::new();
    pane.rows.reset(5);
    pane.anchored_rows.reset(5);
    pane.row_cache = (0..5).map(rows::message).collect();

    // A reader parked on row 1 — above every streaming tail rewrite — keeps
    // their exact offset on both lists.
    pane.rows.scroll_to(gpui::ListOffset {
        item_ix: 1,
        offset_in_item: px(8.0),
    });
    pane.anchored_rows.scroll_to(gpui::ListOffset {
        item_ix: 1,
        offset_in_item: px(0.0),
    });
    apply_splice_plan(&mut pane, SplicePlan::TailReplace { from: 3 }, 6, true);
    assert_eq!(pane.rows.item_count(), 6, "the tail grew by one row");
    assert_eq!(pane.anchored_rows.item_count(), 6);
    let top = pane.rows.logical_scroll_top();
    assert_eq!((top.item_ix, top.offset_in_item), (1, px(8.0)));
    let anchored_top = pane.anchored_rows.logical_scroll_top();
    assert_eq!(
        (anchored_top.item_ix, anchored_top.offset_in_item),
        (1, px(0.0))
    );

    // A reader parked INSIDE the replaced range lands at the range's start —
    // clamped to the first rewritten row, never thrown to either end of the
    // list the way a reset would.
    let mut pane = TranscriptV2::new();
    pane.rows.reset(5);
    pane.row_cache = (0..5).map(rows::message).collect();
    pane.rows.scroll_to(gpui::ListOffset {
        item_ix: 4,
        offset_in_item: px(5.0),
    });
    apply_splice_plan(&mut pane, SplicePlan::TailReplace { from: 3 }, 4, true);
    assert_eq!(pane.rows.item_count(), 4, "the tail shrank by one row");
    let top = pane.rows.logical_scroll_top();
    assert_eq!(
        (top.item_ix, top.offset_in_item),
        (3, px(0.0)),
        "the scroll-top item inside a replaced range clamps to the range start"
    );
}

#[test]
fn reset_preserves_the_viewport_when_asked() {
    // A genuine mid-list reset (real structural change above the tail) must
    // not yank the reader: both lists' logical offsets are captured before
    // the reset and restored after, so the same item stays at the viewport
    // top while it re-measures.
    let mut pane = TranscriptV2::new();
    pane.rows.reset(6);
    pane.anchored_rows.reset(6);
    pane.row_cache = (0..6).map(rows::message).collect();
    pane.rows.scroll_to(gpui::ListOffset {
        item_ix: 2,
        offset_in_item: px(14.0),
    });
    pane.anchored_rows.scroll_to(gpui::ListOffset {
        item_ix: 1,
        offset_in_item: px(3.0),
    });

    apply_splice_plan(&mut pane, SplicePlan::Reset, 6, true);
    let top = pane.rows.logical_scroll_top();
    assert_eq!((top.item_ix, top.offset_in_item), (2, px(14.0)));
    let anchored_top = pane.anchored_rows.logical_scroll_top();
    assert_eq!(
        (anchored_top.item_ix, anchored_top.offset_in_item),
        (1, px(3.0))
    );

    // A reset that SHRINKS below the reader's item clamps to the new end —
    // the closest honest position, not the alignment default.
    pane.rows.scroll_to(gpui::ListOffset {
        item_ix: 5,
        offset_in_item: px(0.0),
    });
    apply_splice_plan(&mut pane, SplicePlan::Reset, 3, true);
    let top = pane.rows.logical_scroll_top();
    assert_eq!(
        (top.item_ix, top.offset_in_item),
        (3, px(0.0)),
        "an item past the new end clamps to the end"
    );
}

#[test]
fn reset_without_preservation_falls_back_to_the_alignment_default() {
    // The session switch wants the legacy landing: the bottom-aligned
    // follower tail-pins (its None offset answers "past the last item") and
    // the anchored twin goes to its top.
    let mut pane = TranscriptV2::new();
    pane.rows.reset(6);
    pane.anchored_rows.reset(6);
    pane.row_cache = (0..6).map(rows::message).collect();
    pane.rows.scroll_to(gpui::ListOffset {
        item_ix: 2,
        offset_in_item: px(0.0),
    });
    pane.anchored_rows.scroll_to(gpui::ListOffset {
        item_ix: 1,
        offset_in_item: px(0.0),
    });

    apply_splice_plan(&mut pane, SplicePlan::Reset, 4, false);
    assert_eq!(
        pane.rows.logical_scroll_top().item_ix,
        4,
        "the follower's cleared offset is its tail pin"
    );
    assert_eq!(
        pane.anchored_rows.logical_scroll_top().item_ix,
        0,
        "the top-aligned twin's cleared offset is the list's start"
    );
}

#[test]
fn anchor_end_space_holds_while_the_tail_is_unmeasured() {
    // The reservation must HOLD through frames whose anchor-to-tail span
    // cannot be measured (the stream pump remeasures tail rows at commit
    // cadence, so every commit is followed by an unmeasured frame). A
    // zero-or-viewport-clamped read would flip the pin phase at stream
    // cadence — the end-space oscillation jump.
    let mut pane = TranscriptV2::new();
    pane.anchored_rows.reset(3);
    pane.anchor = Some(AnchorState {
        turn: Uuid::new_v4(),
        row: 0,
        end_space: px(480.0),
    });
    assert_eq!(
        update_anchor_end_space(&mut pane, 0, px(700.0)),
        px(480.0),
        "unmeasured bounds mean unknown, not empty"
    );
    assert_eq!(
        pane.anchor.expect("anchor kept").end_space,
        px(480.0),
        "the stored reservation holds the previous value through the silence"
    );

    // No anchor set: nothing to hold, nothing to say.
    let mut bare = TranscriptV2::new();
    bare.anchored_rows.reset(3);
    assert_eq!(update_anchor_end_space(&mut bare, 0, px(700.0)), px(0.0));
}

#[test]
fn disclosure_above_viewport_growth_adjusts_by_delta() {
    // Four 40px rows; the viewport top sits at row 1's top (40px). Toggling
    // row 0 grows content above the viewport, so the offset must follow by
    // the same amount or everything the reader sees shifts.
    let offsets = [0.0, 40.0, 80.0, 120.0];
    assert_eq!(
        disclosure_scroll_adjustment(&offsets, 0, 120.0, 40.0),
        120.0
    );
    // A row whose top is strictly above the top edge behaves the same.
    assert_eq!(disclosure_scroll_adjustment(&offsets, 1, 12.5, 80.0), 12.5);
}

#[test]
fn disclosure_below_viewport_is_noop() {
    // The toggled row's top is below the viewport top: the reader sees the
    // header, and GPUI's own anchoring keeps it put without help.
    let offsets = [0.0, 40.0, 80.0, 120.0];
    assert_eq!(disclosure_scroll_adjustment(&offsets, 3, 120.0, 40.0), 0.0);
    // Even far below — the delta never leaks in.
    assert_eq!(disclosure_scroll_adjustment(&offsets, 2, 999.0, 40.0), 0.0);
    // A row the list doesn't know (out of range) has no position to answer
    // for; no adjustment rather than a panic.
    assert_eq!(disclosure_scroll_adjustment(&offsets, 9, 120.0, 40.0), 0.0);
}

#[test]
fn disclosure_at_viewport_top_boundary_adjusts() {
    // The boundary is inclusive: a row whose top sits exactly on the
    // viewport top is the anchor row itself — growth there still shifts
    // everything below it, so the offset follows.
    let offsets = [0.0, 40.0, 80.0];
    assert_eq!(disclosure_scroll_adjustment(&offsets, 1, 60.0, 40.0), 60.0);
    // The degenerate boundary: the very first row with the list at its start.
    assert_eq!(disclosure_scroll_adjustment(&offsets, 0, 60.0, 0.0), 60.0);
}

#[test]
fn disclosure_collapse_clamps_at_list_start() {
    // A collapsing row above the viewport scrolls the offset toward the
    // list's start, but never past it: the adjustment can't be more negative
    // than the current offset.
    let offsets = [0.0, 40.0, 80.0];
    assert_eq!(
        disclosure_scroll_adjustment(&offsets, 0, -30.0, 30.0),
        -30.0
    );
    // Collapsing by more than the offset itself floors at zero offset.
    assert_eq!(
        disclosure_scroll_adjustment(&offsets, 0, -100.0, 30.0),
        -30.0
    );
    // Growth is never clamped — it scrolls away from the start.
    assert_eq!(
        disclosure_scroll_adjustment(&offsets, 0, 100.0, 30.0),
        100.0
    );
}

#[test]
fn disclosure_row_resolves_the_activitys_block() {
    let mut session = session_with_completed_turn(ActivityKind::Command);
    // Give the activity its tool-block id — tide's disclosure-id rule.
    session.transcript_blocks[0].activities[0].source_id = Some("toolu_abc123".into());

    let mut pane = TranscriptV2::new();
    // Rows: prompt, anchored activity block, reply, footer — the block is row 1.
    pane.row_cache = derive_rows(&session, false);
    assert_eq!(
        disclosure_row(&pane, Some(&session), "toolu_abc123"),
        Some(1)
    );

    // An id no activity carries, or no session at all, resolves nothing —
    // the toggle still flips, it just parks no scroll anchor.
    assert_eq!(disclosure_row(&pane, Some(&session), "toolu_other"), None);
    assert_eq!(disclosure_row(&pane, None, "toolu_abc123"), None);
    // A pane that has not derived rows yet cannot resolve even a real id.
    let empty = TranscriptV2::new();
    assert_eq!(disclosure_row(&empty, Some(&session), "toolu_abc123"), None);
}

#[test]
fn toggle_defaults_from_env() {
    // unset → ON in every build; explicit values win; 0 stays the rollback
    assert_eq!(timeline_v2_enabled(None, true), true);
    assert_eq!(timeline_v2_enabled(None, false), true);
    assert_eq!(timeline_v2_enabled(Some("1"), false), true);
    assert_eq!(timeline_v2_enabled(Some("0"), true), false);
    // unrecognized values fall back to the default
    assert_eq!(timeline_v2_enabled(Some("yes"), false), true);
}

#[test]
fn no_op_actions_construct() {
    // Construction is the contract: three shareable handlers exist before
    // the app wires real ones. (&mut App isn't buildable in a plain unit
    // test, so invoking them is left to the pane integration.)
    let actions = TranscriptActions::no_op();
    let _shared = std::sync::Arc::clone(&actions.view_file);
    let _shared = std::sync::Arc::clone(&actions.view_diff);
    let _shared = std::sync::Arc::clone(&actions.open_dispatch);
}

#[test]
fn status_color_maps_to_theme_fields() {
    let theme = crate::theme::Theme::dark();
    assert_eq!(status_color(&theme, Status::Success), theme.accent);
    assert_eq!(status_color(&theme, Status::Warning), theme.warning);
    assert_eq!(status_color(&theme, Status::Error), theme.danger);
    assert_eq!(status_color(&theme, Status::Info), theme.text_tertiary);
}

#[test]
fn tools_tokens_map_to_theme_fields() {
    let theme = crate::theme::Theme::light();
    assert_eq!(tools_dim(&theme), theme.text_tertiary);
    assert_eq!(tools_rail(&theme), theme.border);
    assert_eq!(tools_title(&theme), theme.text);
    assert_eq!(tools_description(&theme), theme.text_secondary);
}

/// Every builtin tools name the table must answer for.
const BUILTIN_TOOLS: &[&str] = &[
    "bash",
    "bash_output",
    "kill_shell",
    "read_file",
    "list_dir",
    "directory_tree",
    "read_media_file",
    "glob",
    "grep",
    "edit_file",
    "multi_edit",
    "write_file",
    "notebook_edit",
    "git",
    "git_repo",
    "web_fetch",
    "web_search",
    "dispatch_agent",
    "todo_write",
    "ask_followup_question",
    "exit_plan_mode",
    "compact",
    "slash_command",
    "memory",
    "init",
    "load_skill",
];

#[test]
fn tool_labels_follow_tide_conventions() {
    // tide's expansion defaults: shell cards open, edit cards collapse
    // behind their diff stat.
    let edit = label_for("edit_file");
    assert_eq!(edit.family, ToolFamily::Edit);
    assert!(!edit.default_expanded, "edits collapse to a diff stat");
    assert_eq!(edit.display_name, "Edit File");

    let bash = label_for("bash");
    assert!(bash.default_expanded, "shell cards start expanded");
    assert_eq!(bash.family, ToolFamily::Bash);

    // dispatch is the Task family with the agent glyph.
    let dispatch = label_for("dispatch_agent");
    assert_eq!(dispatch.family, ToolFamily::Task);
    assert_eq!(dispatch.icon, "icons/bot.svg");
}

#[test]
fn builtin_tool_table_is_complete() {
    for tool in BUILTIN_TOOLS {
        let label = label_for(tool);
        assert_ne!(
            label.family,
            ToolFamily::Other,
            "{tool} is a builtin and deserves a real family"
        );
        assert_ne!(
            label.icon, "icons/wrench.svg",
            "{tool} should not fall through to the generic wrench"
        );
        assert!(!label.display_name.is_empty());
    }
}

#[test]
fn unknown_tools_fall_back_without_panicking() {
    let unknown = label_for("definitely_not_a_builtin");
    assert_eq!(unknown.family, ToolFamily::Other);
    assert!(!unknown.default_expanded, "unknown tools stay collapsed");
    // The table keeps answering after a miss.
    assert_eq!(label_for("read_file").family, ToolFamily::Read);
}

#[test]
fn every_mapped_icon_exists_in_assets() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut icons: Vec<&str> = BUILTIN_TOOLS
        .iter()
        .map(|tool| label_for(tool).icon)
        .collect();
    // The unknown-tool fallback glyph must exist too.
    icons.push(label_for("definitely_not_a_builtin").icon);
    for icon in icons {
        let path = manifest.join("assets").join(icon);
        assert!(path.exists(), "mapped icon is missing on disk: {icon}");
    }
}

#[test]
fn split_path_separates_dir_from_file() {
    assert_eq!(
        split_path_display("src/app/mod.rs"),
        ("src/app".to_owned(), "mod.rs".to_owned())
    );
    // A bare filename carries no directory half.
    assert_eq!(
        split_path_display("mod.rs"),
        (String::new(), "mod.rs".to_owned())
    );
}

#[test]
fn relative_display_strips_workspace_prefix() {
    let workspace = std::path::Path::new("/tmp/ws");
    assert_eq!(
        relative_display(workspace, "/tmp/ws/src/app/mod.rs"),
        "src/app/mod.rs",
        "a short dir survives whole"
    );
    // A file at the workspace root has no dir segment at all.
    assert_eq!(
        relative_display(workspace, "/tmp/ws/Cargo.toml"),
        "Cargo.toml"
    );
    // Outside the workspace the path stands on its own, still split.
    assert_eq!(
        relative_display(workspace, "/elsewhere/x.rs"),
        "/elsewhere/x.rs"
    );
}

#[test]
fn relative_display_truncates_long_dirs_from_the_left() {
    let workspace = std::path::Path::new("/tmp/ws");
    let shown = relative_display(
        workspace,
        "/tmp/ws/very/deeply/nested/directory/structure/with/many/components/labels.rs",
    );
    assert!(
        shown.starts_with('…'),
        "a long dir truncates from the left like tide's rtl rule: {shown}"
    );
    assert!(
        shown.ends_with("labels.rs"),
        "the filename never truncates: {shown}"
    );
}

#[test]
fn bash_first_line_takes_the_first_command_line() {
    assert_eq!(bash_first_line("cd foo\nbar"), "cd foo");
    assert_eq!(bash_first_line("cd foo\r\nbar"), "cd foo");
    assert_eq!(bash_first_line("  cargo test  "), "cargo test");
    assert_eq!(bash_first_line("only"), "only");
    assert_eq!(bash_first_line(""), "");
}

// ── One-line headers ────────────────────────────────────────────────────────

#[test]
fn one_line_collapses_multi_line_text_to_its_first_line() {
    // Multi-line sources (listings, todo checklists, multi-line arguments)
    // read as their opening line in the one-line headers.
    assert_eq!(one_line("src/\nfile_a\nfile_b"), "src/");
    assert_eq!(one_line("[x] 1. Done\n[ ] 2. Later"), "[x] 1. Done");
    // A trailing newline is not a second line.
    assert_eq!(one_line("done\n"), "done");
    assert_eq!(one_line("done\r\nnext"), "done");
    // A lone line passes through trimmed; empty stays empty.
    assert_eq!(one_line("  cargo test  "), "cargo test");
    assert_eq!(one_line("only"), "only");
    assert_eq!(one_line(""), "");
    assert_eq!(one_line("\nsecond"), "");
}

#[test]
fn description_for_collapses_multi_line_details_to_one_line() {
    // A multi-line detail — the todo checklist, the listing preview — never
    // wraps the header: the description column gets its first line.
    let mut todo = tool_activity(
        ActivityKind::Tool,
        "todo_write",
        Some("[x] 1. Ship it\n[ ] 2. Write tests\n[ ] 3. Refactor"),
    );
    todo.output = Some("[x] 1. Ship it\n[ ] 2. Write tests".to_owned());
    assert_eq!(description_for(&todo, test_workspace()), "[x] 1. Ship it");

    // Single-line details pass through untouched.
    let read = tool_activity(ActivityKind::FileRead, "read_file", Some("src/main.rs"));
    assert_eq!(description_for(&read, test_workspace()), "src/main.rs");
}

/// The workspace every tool-part test relativizes against.
fn test_workspace() -> &'static std::path::Path {
    std::path::Path::new("/tmp/ws")
}

/// A settled tool activity titled by its wire name.
fn tool_activity(kind: ActivityKind, title: &str, detail: Option<&str>) -> ActivityItem {
    ActivityItem::new(None, kind, title, detail.map(str::to_owned), true)
}

/// A reasoning activity carrying a settled trace of `content`.
fn reasoning_activity(content: &str) -> ActivityItem {
    ActivityItem::from_reasoning(
        ReasoningBlock {
            content: content.to_owned(),
            started_at_ms: 0,
            finished_at_ms: 0,
        },
        true,
    )
}

/// One prepared file change carrying the stat fields the badge reads.
fn change(path: &str, additions: u64, deletions: u64) -> ActivityFileChange {
    ActivityFileChange {
        path: path.to_owned(),
        additions: Some(additions),
        deletions: Some(deletions),
        status: None,
        diff: None,
    }
}

#[test]
fn header_status_icon_states() {
    let mut edit = tool_activity(ActivityKind::FileChange, "edit_file", None);

    // Running: the tool's own icon holds the slot (the spinner overlays it).
    edit.complete = false;
    assert_eq!(header_status_icon(&edit, false), "icons/pencil.svg");
    assert_eq!(header_status_icon(&edit, true), "icons/pencil.svg");

    // Settled: the reveal chevron — down once expanded, right when collapsed
    // (what hover would reveal).
    edit.complete = true;
    assert_eq!(header_status_icon(&edit, true), "icons/chevron-down.svg");
    assert_eq!(header_status_icon(&edit, false), "icons/chevron-right.svg");

    // Failure never claims the icon column — the glyph keeps naming the
    // tool, running or settled — the ✗ moves to the trailing edge.
    edit.failed = true;
    assert_eq!(header_status_icon(&edit, false), "icons/chevron-right.svg");
    assert_eq!(header_status_icon(&edit, true), "icons/chevron-down.svg");
    edit.complete = false;
    assert_eq!(header_status_icon(&edit, false), "icons/pencil.svg");
    assert_eq!(header_status_icon(&edit, true), "icons/pencil.svg");
    assert_eq!(trailing_failure_icon(&edit), Some("icons/x.svg"));
    assert_eq!(
        trailing_failure_icon(&tool_activity(ActivityKind::FileChange, "edit_file", None)),
        None
    );
}

#[test]
fn header_status_icon_assets_exist() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let edit = tool_activity(ActivityKind::FileChange, "edit_file", None);
    let mut icons = vec![
        header_status_icon(&edit, true),
        header_status_icon(&edit, false),
    ];
    let mut failed = edit.clone();
    failed.failed = true;
    icons.push(header_status_icon(&failed, true));
    icons.extend(trailing_failure_icon(&failed));
    for icon in icons {
        let path = manifest.join("assets").join(icon);
        assert!(path.exists(), "status icon is missing on disk: {icon}");
    }
}

#[test]
fn diff_stat_joins_counts_with_token_colors() {
    let theme = crate::theme::Theme::dark();
    let (stat, additions_color, deletions_color) = diff_stat(&theme, 3, 1);
    assert_eq!(stat, "+3/-1");
    // Additions are the diff-added green, deletions the danger red.
    assert_eq!(additions_color, diff_added());
    assert_eq!(deletions_color, diff_removed(&theme));
    // The join splits cleanly at the '/' so the halves color separately.
    assert_eq!(stat.split_once('/'), Some(("+3", "-1")));
    // Zero sums still format — a change that only touched lines reads 0.
    assert_eq!(diff_stat(&theme, 0, 0).0, "+0/-0");
}

#[test]
fn label_for_activity_falls_back_by_kind_for_generic_titles() {
    // A wire name answers from the table untouched.
    let bash = tool_activity(ActivityKind::Command, "bash", None);
    assert_eq!(label_for_activity(&bash).family, ToolFamily::Bash);

    // Localized generic titles still find their family through the kind.
    let edit = tool_activity(ActivityKind::FileChange, "Edit file", None);
    let label = label_for_activity(&edit);
    assert_eq!(label.family, ToolFamily::Edit);
    assert_eq!(label.icon, "icons/pencil.svg");

    let read = tool_activity(ActivityKind::FileRead, "Read file", None);
    assert_eq!(label_for_activity(&read).family, ToolFamily::Read);

    // Truly unknown tools keep the wrench caution default.
    let unknown = tool_activity(ActivityKind::Tool, "definitely_not_a_builtin", None);
    assert_eq!(label_for_activity(&unknown).family, ToolFamily::Other);
}

#[test]
fn first_path_token_finds_bare_and_quoted_paths() {
    assert_eq!(
        first_path_token("edit src/app/mod.rs now"),
        Some("src/app/mod.rs")
    );
    assert_eq!(first_path_token("'src/lib.rs' changed"), Some("src/lib.rs"));
    // JSON-ish detail: quotes and punctuation glued to the token strip.
    assert_eq!(
        first_path_token(r#"{"path": "/tmp/ws/src/main.rs", "old": "a"}"#),
        Some("/tmp/ws/src/main.rs")
    );
    // A bare filename with an extension counts; a dotfile does not.
    assert_eq!(first_path_token("rewrote mod.rs entirely"), Some("mod.rs"));
    assert_eq!(first_path_token("updated .gitignore today"), None);
    assert_eq!(first_path_token("replace line 42"), None);
    assert_eq!(first_path_token(""), None);
}

#[test]
fn edit_path_prefers_prepared_change_then_target_then_detail() {
    let mut edit = tool_activity(ActivityKind::FileChange, "edit_file", None);

    // The prepared change's path wins over everything.
    edit.file_changes = vec![change("/tmp/ws/src/lib.rs", 1, 2)];
    edit.detail = Some("touched /tmp/ws/other.rs somehow".to_owned());
    assert_eq!(edit_path(&edit).as_deref(), Some("/tmp/ws/src/lib.rs"));

    // Without changes, a path-shaped display target answers.
    edit.file_changes.clear();
    edit.display_target = Some("/tmp/ws/Cargo.toml".to_owned());
    assert_eq!(edit_path(&edit).as_deref(), Some("/tmp/ws/Cargo.toml"));

    // A non-path target is skipped in favor of the detail's first token.
    edit.display_target = Some("apply the patch".to_owned());
    assert_eq!(edit_path(&edit).as_deref(), Some("/tmp/ws/other.rs"));

    // Nothing path-looking anywhere: no path, no guesses.
    edit.detail = Some("replaced a string".to_owned());
    assert_eq!(edit_path(&edit), None);
}

#[test]
fn description_for_dispatches_per_family() {
    // Edit: the touched path, workspace-relative.
    let mut edit = tool_activity(ActivityKind::FileChange, "edit_file", None);
    edit.file_changes = vec![change("/tmp/ws/src/main.rs", 3, 1)];
    assert_eq!(
        description_for(&edit, test_workspace()),
        "src/main.rs",
        "the prepared change path relativizes against the workspace"
    );

    // Edit without a path: the detail itself stands in, unrelativized.
    edit.file_changes.clear();
    edit.detail = Some("replaced a string".to_owned());
    assert_eq!(
        description_for(&edit, test_workspace()),
        "replaced a string"
    );

    // Bash: the command's first line — prepared description, then prepared
    // target, then the detail.
    let mut bash = tool_activity(ActivityKind::Command, "bash", None);
    bash.detail = Some("cd foo\nbar".to_owned());
    assert_eq!(description_for(&bash, test_workspace()), "cd foo");
    bash.display_target = Some("cargo test\n--all".to_owned());
    assert_eq!(description_for(&bash, test_workspace()), "cargo test");
    bash.display_description = Some("verify the build".to_owned());
    assert_eq!(description_for(&bash, test_workspace()), "verify the build");

    // Task: the task description, verbatim.
    let task = tool_activity(
        ActivityKind::Tool,
        "dispatch_agent",
        Some("Investigate the flake"),
    );
    assert_eq!(
        description_for(&task, test_workspace()),
        "Investigate the flake"
    );

    // Others: detail as-is — reads keep their path string untouched.
    let read = tool_activity(ActivityKind::FileRead, "read_file", Some("src/main.rs"));
    assert_eq!(description_for(&read, test_workspace()), "src/main.rs");

    // No detail at all: an empty column, not a placeholder.
    let bare = tool_activity(ActivityKind::FileRead, "read_file", None);
    assert_eq!(description_for(&bare, test_workspace()), "");
}

#[test]
fn disclosure_id_prefers_the_tool_block_source() {
    let mut activity = tool_activity(ActivityKind::Command, "bash", None);

    // Tide's rule: the provider's tool-block id is the part's disclosure id.
    activity.source_id = Some("toolu_abc123".to_owned());
    assert_eq!(disclosure_id(&activity), "toolu_abc123");

    // Source-less rows still toggle — the uuid stands in.
    activity.source_id = None;
    assert_eq!(disclosure_id(&activity), activity.id.to_string());
}

// ── Expanded bodies: diff classification ───────────────────────────────────

#[test]
fn classify_diff_line_marks_markers() {
    assert_eq!(classify_diff_line("+added"), LineKind::Addition);
    assert_eq!(classify_diff_line("+"), LineKind::Addition);
    assert_eq!(classify_diff_line("-removed"), LineKind::Deletion);
    assert_eq!(classify_diff_line("@@ -1,3 +1,4 @@"), LineKind::HunkHeader);
    // The bare `@@` the model documents for synthesized replacement diffs.
    assert_eq!(classify_diff_line("@@"), LineKind::HunkHeader);
    // Context: undecorated lines, the leading-space form, and empty lines.
    assert_eq!(classify_diff_line(" unchanged"), LineKind::Context);
    assert_eq!(classify_diff_line("plain"), LineKind::Context);
    assert_eq!(classify_diff_line(""), LineKind::Context);
    // File headers carry no change semantics — they read as context, not as
    // a giant deletion or addition.
    assert_eq!(classify_diff_line("--- a/src/lib.rs"), LineKind::Context);
    assert_eq!(classify_diff_line("+++ b/src/lib.rs"), LineKind::Context);
}

#[test]
fn diff_truncation_bounds_the_budget() {
    // At or under the cap: everything shows.
    assert_eq!(diff_truncation(0, Some(MAX_DIFF_ROWS)), None);
    assert_eq!(diff_truncation(MAX_DIFF_ROWS, Some(MAX_DIFF_ROWS)), None);
    // One past the cap hides exactly the overflow.
    assert_eq!(
        diff_truncation(MAX_DIFF_ROWS + 1, Some(MAX_DIFF_ROWS)),
        Some(1)
    );
    assert_eq!(
        diff_truncation(MAX_DIFF_ROWS + 500, Some(MAX_DIFF_ROWS)),
        Some(500)
    );
    // An uncapped budget (the output dialog's) hides nothing, whatever the
    // line count.
    assert_eq!(diff_truncation(0, None), None);
    assert_eq!(diff_truncation(MAX_DIFF_ROWS + 500, None), None);
}

// ── Expanded bodies: JSON detection ────────────────────────────────────────

#[test]
fn looks_like_json_accepts_objects_and_arrays_only() {
    // Objects and arrays parse and open with a brace.
    let object = looks_like_json(r#"{"ok": true, "n": 1}"#).expect("object parses");
    assert_eq!(object, serde_json::json!({"ok": true, "n": 1}));
    let array = looks_like_json("[1, 2, 3]").expect("array parses");
    assert_eq!(array, serde_json::json!([1, 2, 3]));

    // Whitespace-padded valid JSON still counts.
    assert!(looks_like_json("\n  {\"a\": 1}\n").is_some());

    // Bare JSON scalars parse fine but are not JSON output worth a card.
    assert!(looks_like_json("42").is_none());
    assert!(looks_like_json("\"just a string\"").is_none());
    assert!(looks_like_json("null").is_none());

    // Non-JSON and broken JSON never make a card.
    assert!(looks_like_json("not json").is_none());
    assert!(looks_like_json("").is_none());
    assert!(looks_like_json(r#"{"a": 1"#).is_none());
}

// ── Assistant text part: JSON finalize ──────────────────────────────────────

#[test]
fn finalize_kind_streams_as_markdown_and_finalizes_json_when_settled() {
    // Streaming always markdown, whatever the body's shape — the card is a
    // finalize, never a live view over a still-growing body.
    assert_eq!(
        finalize_kind(r#"{"a": 1}"#, true),
        FinalizeKind::Markdown,
        "a JSON-shaped body stays markdown while streaming"
    );
    assert_eq!(
        finalize_kind("thinking about it…", true),
        FinalizeKind::Markdown,
        "prose stays markdown while streaming"
    );

    // Settled: a whole-body JSON object or array becomes the card.
    assert_eq!(
        finalize_kind(r#"{"ok": true, "items": [1, 2]}"#, false),
        FinalizeKind::JsonCard
    );
    assert_eq!(finalize_kind("[1, 2, 3]", false), FinalizeKind::JsonCard);

    // Settled prose — and a bare JSON scalar, which `looks_like_json`
    // rejects — stays markdown.
    assert_eq!(
        finalize_kind("Done: the fix landed.", false),
        FinalizeKind::Markdown
    );
    assert_eq!(finalize_kind("42", false), FinalizeKind::Markdown);
    assert_eq!(finalize_kind("", false), FinalizeKind::Markdown);
}

// ── Expanded bodies: family specials ───────────────────────────────────────

#[test]
fn agent_name_reads_dispatch_arguments() {
    let mut dispatch = tool_activity(ActivityKind::Tool, "dispatch_agent", None);
    dispatch.arguments = Some(r#"{"agent": "Explorer", "prompt": "look"}"#.to_owned());
    assert_eq!(agent_name(&dispatch).as_deref(), Some("Explorer"));

    // The Claude-style subagent_type field answers too.
    dispatch.arguments = Some(r#"{"subagent_type": "general-purpose"}"#.to_owned());
    assert_eq!(agent_name(&dispatch).as_deref(), Some("general-purpose"));

    // Arguments without an agent field, non-JSON arguments, and none at all.
    dispatch.arguments = Some(r#"{"prompt": "look"}"#.to_owned());
    assert_eq!(agent_name(&dispatch), None);
    dispatch.arguments = Some("not json".to_owned());
    assert_eq!(agent_name(&dispatch), None);
    dispatch.arguments = None;
    assert_eq!(agent_name(&dispatch), None);
}

#[test]
fn dispatch_and_todo_detection() {
    // Dispatch: a Task-family tool whose title names the dispatch.
    let dispatch = tool_activity(ActivityKind::Tool, "dispatch_agent", None);
    assert!(is_dispatch(&dispatch));
    let localized = tool_activity(ActivityKind::Tool, "Dispatch Agent", None);
    assert!(is_dispatch(&localized));
    // Other Task-family members are not dispatches.
    let todo = tool_activity(ActivityKind::Tool, "todo_write", None);
    assert!(!is_dispatch(&todo));

    // Todo writes: the wire name or the semantic Plan kind.
    assert!(is_todo_write(&todo));
    let plan = tool_activity(ActivityKind::Plan, "Update plan", None);
    assert!(is_todo_write(&plan));
    // A bash command is neither.
    let bash = tool_activity(ActivityKind::Command, "bash", None);
    assert!(!is_dispatch(&bash));
    assert!(!is_todo_write(&bash));
}

#[test]
fn todo_item_strips_list_markers() {
    assert_eq!(todo_item("- write tests"), "write tests");
    assert_eq!(todo_item("* write tests"), "write tests");
    assert_eq!(todo_item("• write tests"), "write tests");
    // Indented markers and marker-free lines both settle to the bare text.
    assert_eq!(todo_item("  - indented"), "indented");
    assert_eq!(todo_item("plain line"), "plain line");
    // A line of literal dashes never becomes empty-and-lost, just trimmed.
    assert_eq!(todo_item("--"), "");
}

#[test]
fn parse_todo_line_reads_tide_marks_and_markdown() {
    // tide's todo_write result lines: mark, optional number, content.
    assert_eq!(
        parse_todo_line("[x] 1. Done work"),
        Some((TodoState::Done, "Done work".to_owned()))
    );
    assert_eq!(
        parse_todo_line("[~] 2. Active work"),
        Some((TodoState::InProgress, "Active work".to_owned()))
    );
    assert_eq!(
        parse_todo_line("[-] 3. Dropped work"),
        Some((TodoState::Cancelled, "Dropped work".to_owned()))
    );
    assert_eq!(
        parse_todo_line("[ ] 4. Future work"),
        Some((TodoState::Pending, "Future work".to_owned()))
    );
    // Unnumbered marks parse too.
    assert_eq!(
        parse_todo_line("[x] done"),
        Some((TodoState::Done, "done".to_owned()))
    );

    // Plain task-list markdown: leading marker + mark.
    assert_eq!(
        parse_todo_line("- [x] done"),
        Some((TodoState::Done, "done".to_owned()))
    );
    assert_eq!(
        parse_todo_line("* [ ] pending"),
        Some((TodoState::Pending, "pending".to_owned()))
    );
    assert_eq!(
        parse_todo_line("- [~] half way"),
        Some((TodoState::InProgress, "half way".to_owned()))
    );
    assert_eq!(
        parse_todo_line("- [-] dropped"),
        Some((TodoState::Cancelled, "dropped".to_owned()))
    );

    // Capital X still reads as done; decimal-looking labels never lose a
    // genuine ". " that follows a non-number.
    assert_eq!(
        parse_todo_line("[X] 10. many"),
        Some((TodoState::Done, "many".to_owned()))
    );
    assert_eq!(
        parse_todo_line("[ ] v1. ships eventually"),
        Some((TodoState::Pending, "v1. ships eventually".to_owned()))
    );

    // Anything without a checkbox mark is not a todo line.
    assert_eq!(parse_todo_line("- plain item"), None);
    assert_eq!(parse_todo_line("plain text"), None);
    assert_eq!(parse_todo_line(""), None);
    assert_eq!(parse_todo_line("[?] unknown mark"), None);
}

#[test]
fn parse_todo_output_reads_lines_and_json_arrays() {
    // The marked-line form — tide's todo_write display text verbatim.
    let lines = "[x] 1. Done work\n[~] 2. Active work\n[-] 3. Dropped\n[ ] 4. Future";
    assert_eq!(
        parse_todo_output(lines),
        Some(vec![
            (TodoState::Done, "Done work".to_owned()),
            (TodoState::InProgress, "Active work".to_owned()),
            (TodoState::Cancelled, "Dropped".to_owned()),
            (TodoState::Pending, "Future".to_owned()),
        ])
    );

    // The JSON-array form tide's app renderer reads.
    let json = r#"[{"content":"a","status":"completed"},{"content":"b","status":"in_progress"},{"content":"c","status":"cancelled"},{"content":"d","status":"pending"}]"#;
    assert_eq!(
        parse_todo_output(json),
        Some(vec![
            (TodoState::Done, "a".to_owned()),
            (TodoState::InProgress, "b".to_owned()),
            (TodoState::Cancelled, "c".to_owned()),
            (TodoState::Pending, "d".to_owned()),
        ])
    );

    // Non-todo output (including non-todo JSON) answers None so the caller
    // falls back to plain rows.
    assert_eq!(parse_todo_output("all plain text\nmore text"), None);
    assert_eq!(parse_todo_output(""), None);
    assert_eq!(parse_todo_output(r#"{"summary": "not a list"}"#), None);
}

#[test]
fn has_body_answers_per_content_shape() {
    // Output alone discloses.
    let mut bash = tool_activity(ActivityKind::Command, "bash", None);
    assert!(!has_body(&bash), "a bare command row has no body yet");
    bash.output = Some("test result: ok".to_owned());
    assert!(has_body(&bash));

    // A file change with a diff discloses; a stat-only change does not.
    let mut edit = tool_activity(ActivityKind::FileChange, "edit_file", None);
    assert!(!has_body(&edit));
    edit.file_changes = vec![change("/tmp/ws/src/lib.rs", 1, 1)];
    assert!(
        !has_body(&edit),
        "a prepared change without a diff body has nothing to expand"
    );
    edit.file_changes[0].diff = Some("@@\n-old\n+new".to_owned());
    assert!(has_body(&edit));

    // A failure the failure card would render discloses.
    let mut failed = tool_activity(ActivityKind::Command, "bash", Some("exit 1"));
    failed.failed = true;
    assert!(has_body(&failed));

    // Dispatch runs always disclose (their report section).
    let dispatch = tool_activity(ActivityKind::Tool, "dispatch_agent", None);
    assert!(has_body(&dispatch));

    // Follow-up questions always disclose (question + options section).
    let question = tool_activity(ActivityKind::Tool, "ask_followup_question", None);
    assert!(is_followup_question(&question));
    assert!(has_body(&question));

    // The bash command input section discloses on its own.
    let mut command = tool_activity(ActivityKind::Command, "bash", None);
    command.display_target = Some("cargo test".to_owned());
    assert!(has_body(&command));

    // Generic tools: meaningful arguments disclose, JSON noise does not.
    let mut generic = tool_activity(ActivityKind::Tool, "mcp_tool", None);
    assert!(!has_body(&generic));
    generic.arguments = Some("{}".to_owned());
    assert!(
        !has_body(&generic),
        "a bare object is argument noise, not a body"
    );
    generic.arguments = Some(r#"{"query": "gpui list"}"#.to_owned());
    assert!(has_body(&generic));
    // Read-only tools never count their arguments even when meaningful.
    let mut read = tool_activity(ActivityKind::FileRead, "read_file", None);
    read.arguments = Some(r#"{"path": "/tmp/ws/src/lib.rs"}"#.to_owned());
    assert!(!has_body(&read));

    // Detail alone — the driver's output preview — never discloses.
    let preview_only = tool_activity(ActivityKind::Tool, "mcp_tool", Some("did the thing"));
    assert!(!has_body(&preview_only));
}

// ── Read-only content bodies: the five expandable tools ────────────────────

#[test]
fn has_body_counts_captured_content_for_read_only_tools() {
    // The five read-only tools: output present → body (the content viewport).
    for (kind, title) in [
        (ActivityKind::FileRead, "read_file"),
        (ActivityKind::FileRead, "read_media_file"),
        (ActivityKind::Search, "web_fetch"),
        (ActivityKind::FileSearch, "glob"),
        (ActivityKind::FileSearch, "grep"),
    ] {
        let mut tool = tool_activity(kind, title, None);
        assert!(
            !has_body(&tool),
            "{title} without captured content stays a single line"
        );
        tool.output = Some("  captured content  ".to_owned());
        assert!(has_body(&tool), "{title} with output discloses");
    }

    // Display text standing in when the output is absent — some providers
    // leave the content only there.
    let mut display_only = tool_activity(ActivityKind::FileRead, "read_file", None);
    display_only.display_target = Some("src/main.rs".to_owned());
    assert!(
        has_body(&display_only),
        "display text alone discloses the read"
    );

    // Blank display text is no content.
    display_only.display_target = Some("   ".to_owned());
    assert!(!has_body(&display_only));
}

#[test]
fn content_tools_cover_listings_and_the_read_only_families() {
    // The listing tools, whatever family the provider filed them under.
    assert!(is_content_tool(&tool_activity(
        ActivityKind::Tool,
        "list_dir",
        None
    )));
    assert!(is_content_tool(&tool_activity(
        ActivityKind::FileList,
        "directory_tree",
        None
    )));
    // The read-only families by label — wire names and localized titles.
    for (kind, title) in [
        (ActivityKind::FileRead, "read_file"),
        (ActivityKind::FileRead, "read_media_file"),
        (ActivityKind::FileRead, "Read file"),
        (ActivityKind::FileSearch, "grep"),
        (ActivityKind::FileSearch, "Find files"),
        (ActivityKind::Search, "web_fetch"),
        (ActivityKind::Search, "web_search"),
    ] {
        assert!(
            is_content_tool(&tool_activity(kind, title, None)),
            "{title} renders the content viewport"
        );
    }
    // Acting families keep their own body treatments.
    for (kind, title) in [
        (ActivityKind::Command, "bash"),
        (ActivityKind::FileChange, "edit_file"),
        (ActivityKind::Tool, "dispatch_agent"),
        (ActivityKind::Tool, "definitely_not_a_builtin"),
    ] {
        assert!(
            !is_content_tool(&tool_activity(kind, title, None)),
            "{title} is not a content tool"
        );
    }
}

// ── Directory listings: list_dir / directory_tree ───────────────────────────

#[test]
fn listing_tools_resolve_by_wire_name() {
    // The wire names, whatever semantic kind the provider's classification
    // landed on (tide files list_dir under Tool; others under FileList).
    assert!(is_listing_tool(&tool_activity(
        ActivityKind::Tool,
        "list_dir",
        None
    )));
    assert!(is_listing_tool(&tool_activity(
        ActivityKind::FileList,
        "directory_tree",
        None
    )));
    // Localized titles match their wire names once normalized.
    assert!(is_listing_tool(&tool_activity(
        ActivityKind::FileList,
        "List Directory",
        None
    )));
    assert!(is_listing_tool(&tool_activity(
        ActivityKind::FileList,
        "Directory Tree",
        None
    )));
    // Other read-only tools are not listings.
    assert!(!is_listing_tool(&tool_activity(
        ActivityKind::FileRead,
        "read_file",
        None
    )));
    assert!(!is_listing_tool(&tool_activity(
        ActivityKind::FileSearch,
        "grep",
        None
    )));
    assert!(!is_listing_tool(&tool_activity(
        ActivityKind::FileList,
        "ls",
        None
    )));
}

#[test]
fn listing_path_reads_arguments_then_display_target() {
    let mut list = tool_activity(ActivityKind::Tool, "list_dir", Some("api-doc/\nbdd/"));
    // The detail holds the listing preview; it is never the path source.
    list.arguments = Some(r#"{ "path": "/tmp/ws/src/" }"#.to_owned());
    assert_eq!(listing_path(&list).as_deref(), Some("/tmp/ws/src/"));

    // Without parseable arguments the display target answers, first line only.
    list.arguments = None;
    list.display_target = Some("crates/\n(and more)".to_owned());
    assert_eq!(listing_path(&list).as_deref(), Some("crates/"));

    // Blank or missing everywhere: no path, no guesses.
    list.display_target = Some("   ".to_owned());
    assert_eq!(listing_path(&list), None);
    list.display_target = None;
    assert_eq!(listing_path(&list), None);

    // A non-path JSON object never answers a path.
    list.arguments = Some(r#"{"query": "gpui"}"#.to_owned());
    assert_eq!(listing_path(&list), None);
}

#[test]
fn listing_description_is_the_path_never_the_listing() {
    let mut list = tool_activity(
        ActivityKind::Tool,
        "list_dir",
        Some("api-doc/\nbdd/\nclient/"),
    );
    list.arguments = Some(r#"{"path": "/tmp/ws/src/"}"#.to_owned());
    list.output = Some("api-doc/\nbdd/\nclient/\ncmd/".to_owned());
    let description = description_for(&list, test_workspace());
    assert_eq!(description, "src/", "the header shows the directory path");
    assert!(
        !description.contains("api-doc"),
        "the listing never pollutes the header"
    );

    // Without arguments the display target answers, relativized the same way.
    list.arguments = None;
    list.display_target = Some("/tmp/ws/crates/".to_owned());
    assert_eq!(description_for(&list, test_workspace()), "crates/");

    // Nothing to read: an empty column, not the listing preview.
    list.display_target = None;
    assert_eq!(description_for(&list, test_workspace()), "");
}

#[test]
fn content_body_source_reads_output_then_display_text() {
    let mut list = tool_activity(ActivityKind::Tool, "list_dir", Some("api-doc/\nbdd/"));
    assert_eq!(
        content_body_source(&list),
        None,
        "the detail preview is not the content body"
    );

    // The output answers, trimmed.
    list.output = Some("  api-doc/\nbdd/\n".to_owned());
    assert_eq!(content_body_source(&list), Some("api-doc/\nbdd/"));
    assert_eq!(captured_output(&list), Some("api-doc/\nbdd/"));

    // Blank output falls through to the display text.
    list.output = Some("   \n".to_owned());
    list.display_target = Some("src/".to_owned());
    assert_eq!(content_body_source(&list), Some("src/"));
    assert_eq!(
        captured_output(&list),
        None,
        "blank output is no captured output, whatever the display text says"
    );

    // Neither carries anything: no body.
    list.display_target = Some("   ".to_owned());
    assert_eq!(content_body_source(&list), None);
}

#[test]
fn has_body_counts_the_listing_viewport() {
    // A listing tool with no listing yet has nothing to expand.
    let mut list = tool_activity(ActivityKind::Tool, "list_dir", Some("api-doc/\nbdd/"));
    assert!(
        !has_body(&list),
        "the detail preview alone never discloses a listing"
    );

    // The output's listing discloses.
    list.output = Some("api-doc/\nbdd/\n".to_owned());
    assert!(has_body(&list));

    // So does the display text standing in when the output is absent.
    let mut target_only = tool_activity(ActivityKind::Tool, "directory_tree", None);
    target_only.display_target = Some("crates/".to_owned());
    assert!(has_body(&target_only));
}

#[test]
fn followup_parts_reads_question_and_options() {
    let mut question = tool_activity(ActivityKind::Tool, "ask_followup_question", None);
    question.arguments = Some(
        r#"{"question": "Which DB?", "options": [{"label": "SQLite", "description": "local"}, {"label": "Postgres"}]}"#.to_owned(),
    );
    assert_eq!(
        followup_parts(&question),
        Some((
            "Which DB?".to_owned(),
            vec![
                ("SQLite".to_owned(), Some("local".to_owned())),
                ("Postgres".to_owned(), None),
            ],
        ))
    );

    // Open-ended questions carry an empty option list.
    question.arguments = Some(r#"{"question": "Why?"}"#.to_owned());
    assert_eq!(
        followup_parts(&question),
        Some(("Why?".to_owned(), Vec::new()))
    );

    // Missing question text, non-JSON arguments, and no arguments at all.
    question.arguments = Some(r#"{"options": []}"#.to_owned());
    assert_eq!(followup_parts(&question), None);
    question.arguments = Some("not json".to_owned());
    assert_eq!(followup_parts(&question), None);
    question.arguments = None;
    assert_eq!(followup_parts(&question), None);
}

#[test]
fn failure_text_prefers_detail_then_output() {
    let mut failed = tool_activity(ActivityKind::Command, "bash", None);
    failed.failed = true;
    failed.complete = true;

    failed.detail = Some("exit 1".to_owned());
    failed.output = Some("error: build failed".to_owned());
    assert_eq!(failure_text(&failed), Some("exit 1"));

    // Without a detail the output stands in.
    failed.detail = None;
    assert_eq!(failure_text(&failed), Some("error: build failed"));

    // Blank strings never feed the card.
    failed.detail = Some("   ".to_owned());
    failed.output = Some("   ".to_owned());
    assert_eq!(failure_text(&failed), None);
}

// ── Expanded bodies: renderers construct without an app ───────────────────

/// The body renderer builds plain element trees — no window, no app context
/// — so every family's shape is smoke-testable headlessly.
#[test]
fn render_activity_body_constructs_for_every_family() {
    let theme = crate::theme::Theme::dark();

    // Bash: command input, output result.
    let mut bash = tool_activity(ActivityKind::Command, "bash", None);
    bash.display_target = Some("cargo test".to_owned());
    bash.output = Some("test result: ok".to_owned());
    let _ = render_activity_body(&bash, test_workspace(), &theme);

    // Edit: prepared diff body under the file's relative path.
    let mut edit = tool_activity(ActivityKind::FileChange, "edit_file", None);
    edit.file_changes = vec![ActivityFileChange {
        path: "/tmp/ws/src/lib.rs".to_owned(),
        additions: Some(1),
        deletions: Some(1),
        status: None,
        diff: Some("@@\n-old\n+new".to_owned()),
    }];
    let _ = render_activity_body(&edit, test_workspace(), &theme);

    // JSON-valued output gets the JSON card instead of the plain viewport.
    let mut json = tool_activity(ActivityKind::Tool, "memory", None);
    json.output = Some(r#"{"saved": ["a"]}"#.to_owned());
    let _ = render_activity_body(&json, test_workspace(), &theme);

    // Dispatch: badge + plain report.
    let mut dispatch = tool_activity(ActivityKind::Tool, "dispatch_agent", Some("Look into it"));
    dispatch.arguments = Some(r#"{"agent": "Explorer"}"#.to_owned());
    dispatch.output = Some("Found the flake.".to_owned());
    let _ = render_activity_body(&dispatch, test_workspace(), &theme);

    // Failed: the error-token card replaces the result section.
    let mut failed = tool_activity(ActivityKind::Command, "bash", None);
    failed.failed = true;
    failed.complete = true;
    failed.detail = Some("exit 1".to_owned());
    failed.output = Some("error: no such file".to_owned());
    let _ = render_activity_body(&failed, test_workspace(), &theme);

    // Directory listing: the tree listing in the scroll viewport under its
    // directory path.
    let mut listing = tool_activity(ActivityKind::Tool, "list_dir", Some("api-doc/\nbdd/"));
    listing.arguments = Some(r#"{"path": "src/"}"#.to_owned());
    listing.output = Some("api-doc/\nbdd/\nclient/\ncmd/".to_owned());
    let _ = render_activity_body(&listing, test_workspace(), &theme);
    // A listing whose output never landed keeps the empty body column.
    let mut bare_listing = tool_activity(ActivityKind::Tool, "directory_tree", None);
    bare_listing.display_target = Some("crates/".to_owned());
    let _ = render_activity_body(&bare_listing, test_workspace(), &theme);

    // Read-only tools: the captured output as the content viewport — the
    // five the pane owes (read, media read, fetch, glob, grep) and a
    // display-only read riding the blockquote/input fallback.
    let mut read = tool_activity(ActivityKind::FileRead, "read_file", Some("src/main.rs"));
    read.output = Some("fn main() {\n    println!(\"hi\");\n}".to_owned());
    let _ = render_activity_body(&read, test_workspace(), &theme);

    let mut media = tool_activity(ActivityKind::FileRead, "read_media_file", None);
    media.output = Some("[image: 640x480 png, 3.2 KB]".to_owned());
    let _ = render_activity_body(&media, test_workspace(), &theme);

    let mut fetch = tool_activity(ActivityKind::Search, "web_fetch", None);
    fetch.display_target = Some("https://example.com".to_owned());
    fetch.output = Some("<!doctype html>\n<h1>Example</h1>".to_owned());
    let _ = render_activity_body(&fetch, test_workspace(), &theme);

    let mut glob = tool_activity(ActivityKind::FileSearch, "glob", None);
    glob.arguments = Some(r#"{"pattern": "**/*.rs"}"#.to_owned());
    glob.output = Some("src/main.rs\nsrc/lib.rs".to_owned());
    let _ = render_activity_body(&glob, test_workspace(), &theme);

    let mut grep = tool_activity(ActivityKind::FileSearch, "grep", None);
    grep.arguments = Some(r#"{"pattern": "TODO"}"#.to_owned());
    grep.output = Some("src/main.rs:42: // TODO ship".to_owned());
    let _ = render_activity_body(&grep, test_workspace(), &theme);

    let mut display_only = tool_activity(ActivityKind::FileRead, "read_file", None);
    display_only.display_target = Some("src/main.rs".to_owned());
    display_only.arguments = Some(r#"{"path": "/tmp/ws/src/main.rs"}"#.to_owned());
    let _ = render_activity_body(&display_only, test_workspace(), &theme);

    // The quietest case: no inputs, no output — an empty body column.
    let bare = tool_activity(ActivityKind::FileRead, "read_file", None);
    let _ = render_activity_body(&bare, test_workspace(), &theme);
}

// ── Presentation classification ────────────────────────────────────────────

#[test]
fn presentation_classifies_by_family_and_kind() {
    // Every tool renders as a card — the read-only families (reads, media
    // reads, searches, fetches, listings) included, because their expanded
    // bodies render the captured content.
    let cards = [
        (ActivityKind::Command, "bash"),
        (ActivityKind::FileChange, "edit_file"),
        (ActivityKind::FileChange, "write_file"),
        (ActivityKind::Tool, "dispatch_agent"),
        (ActivityKind::Tool, "todo_write"),
        (ActivityKind::Tool, "definitely_not_a_builtin"),
        // The read-only five: file reads, media reads, fetches, glob, grep.
        (ActivityKind::FileRead, "read_file"),
        (ActivityKind::FileRead, "read_media_file"),
        (ActivityKind::Search, "web_fetch"),
        (ActivityKind::FileSearch, "glob"),
        (ActivityKind::FileSearch, "grep"),
        // And their wider families, whatever the provider's classification.
        (ActivityKind::Search, "web_search"),
        (ActivityKind::FileList, "ls"),
        (ActivityKind::FileList, "listFiles"),
        // Localized generic titles classify through the semantic kind.
        (ActivityKind::FileRead, "Read file"),
        (ActivityKind::FileSearch, "Find files"),
        // Directory listings: the header carries the directory path and the
        // expanded body the listing itself.
        (ActivityKind::Tool, "list_dir"),
        (ActivityKind::FileList, "directory_tree"),
        (ActivityKind::FileList, "List Directory"),
    ];
    for (kind, title) in cards {
        assert_eq!(
            presentation_for(&tool_activity(kind, title, None)),
            ActivityPresentation::Card,
            "{title} renders the expandable card"
        );
    }

    // Reasoning is its own presentation — the dim disclosure part.
    let reasoning = tool_activity(ActivityKind::Reasoning, "Reasoning", None);
    assert_eq!(
        presentation_for(&reasoning),
        ActivityPresentation::Reasoning
    );
}

// ── Activity list: the bare rows the block renders ──────────────────────────

/// One block of every kind the list renders — a reasoning part, tool cards
/// of several families, a read (a Read-family card), and a directory listing
/// — so the render test walks every presentation.
fn mixed_activities() -> Vec<ActivityItem> {
    let mut listing = tool_activity(
        ActivityKind::Tool,
        "list_dir",
        Some("api-doc/\nbdd/\nclient/\ncmd/"),
    );
    listing.arguments = Some(r#"{"path": "src/"}"#.to_owned());
    listing.output = Some("api-doc/\nbdd/\nclient/\ncmd/".to_owned());
    vec![
        reasoning_activity("The user asked for a build, so read the entry point first."),
        tool_activity(ActivityKind::Reasoning, "Reasoning", None),
        tool_activity(ActivityKind::FileChange, "edit_file", None),
        tool_activity(ActivityKind::Command, "bash", None),
        tool_activity(ActivityKind::Command, "bash", None),
        tool_activity(ActivityKind::Command, "bash", None),
        tool_activity(ActivityKind::FileRead, "read_file", Some("src/main.rs")),
        listing,
    ]
}

/// No-op click wiring: the renderer only threads it through, so the tree
/// builds headlessly exactly as the tool-part renderers do.
fn noop_toggles() -> GroupToggle {
    std::sync::Arc::new(|_, _, _, _| {})
}

/// The reasoning bodies' markdown state, built headlessly: an empty view
/// cache, the authored compact metrics, and motion off (the tree builds the
/// same either way — only the fade animation reads the flag).
fn test_reasoning_markdown(
    views: &mut std::collections::HashMap<Uuid, crate::md::render::MarkdownView>,
) -> ReasoningMarkdown<'_> {
    ReasoningMarkdown {
        views,
        metrics: crate::md::render::Metrics::COMPACT,
        selection: crate::md::render::TranscriptSelection::default(),
        link_handler: None,
        mermaid_handler: None,
        mermaid_host: None,
        reduce_motion: true,
    }
}

#[test]
fn render_activities_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let actions = TranscriptActions::no_op();
    let activities = mixed_activities();
    let refs: Vec<&ActivityItem> = activities.iter().collect();
    let closed = std::collections::HashSet::new();
    let mut open = std::collections::HashSet::new();
    open.insert("block-t".to_owned());
    let mut views = std::collections::HashMap::new();

    // The two shapes the pane renders: everything closed (the default) and
    // a disclosure set holding an id.
    let _ = render_activities(
        &refs,
        &closed,
        test_workspace(),
        &actions,
        &theme,
        &mut test_reasoning_markdown(&mut views),
        noop_toggles(),
    );
    let _ = render_activities(
        &refs,
        &open,
        test_workspace(),
        &actions,
        &theme,
        &mut test_reasoning_markdown(&mut views),
        noop_toggles(),
    );
}

// ── Reasoning part (T19) ────────────────────────────────────────────────────

#[test]
fn reasoning_summary_passes_short_text_through() {
    assert_eq!(
        reasoning_summary("Consider the entry point."),
        "Consider the entry point.",
        "a short trace keeps its text, ellipsis-free"
    );
}

#[test]
fn reasoning_summary_truncates_long_text_with_an_ellipsis() {
    let summary = reasoning_summary(&"x".repeat(120));
    assert_eq!(
        summary.chars().count(),
        81,
        "the cap shows 80 content characters plus the ellipsis"
    );
    assert!(summary.ends_with('…'), "the cut is marked");
    assert_eq!(summary.trim_end_matches('…'), "x".repeat(80));

    // Exactly the cap stays whole — the ellipsis marks a cut, not a length.
    assert_eq!(reasoning_summary(&"y".repeat(80)), "y".repeat(80));
}

#[test]
fn reasoning_summary_strips_and_collapses_whitespace() {
    assert_eq!(
        reasoning_summary("  What   about\n\nthe\ttabs?  "),
        "What about the tabs?",
        "leading/trailing whitespace drops and internal runs collapse"
    );
}

#[test]
fn reasoning_summary_empties_for_blank_text() {
    assert_eq!(reasoning_summary(""), "");
    assert_eq!(reasoning_summary("   \n\t "), "");
}

#[test]
fn reasoning_content_reads_the_carried_trace() {
    assert_eq!(
        reasoning_content(&reasoning_activity("  The plan.  ")),
        Some("The plan."),
        "the trace trims before it is judged non-empty"
    );
    assert_eq!(
        reasoning_content(&reasoning_activity("   ")),
        None,
        "a whitespace-only trace discloses nothing"
    );
    assert_eq!(
        reasoning_content(&tool_activity(ActivityKind::Reasoning, "Reasoning", None)),
        None,
        "a reasoning-kind row without a block (a generic think tool) has no part body"
    );
}

#[test]
fn reasoning_streams_until_the_activity_settles() {
    let mut activity = reasoning_activity("Thinking it through");
    activity.complete = false;
    assert!(reasoning_streaming(&activity), "unsettled means streaming");
    activity.complete = true;
    assert!(
        !reasoning_streaming(&activity),
        "settled means not streaming"
    );
}

#[test]
fn reasoning_header_assets_exist() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for asset in [
        "icons/brain.svg",
        "icons/chevron-down.svg",
        "icons/chevron-right.svg",
    ] {
        let path = manifest.join("assets").join(asset);
        assert!(path.exists(), "reasoning asset is missing on disk: {asset}");
    }
}

#[test]
fn render_reasoning_part_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let mut views = std::collections::HashMap::new();
    let activity = reasoning_activity("First **this**, then that.");

    // Collapsed and expanded, settled and streaming — the four shapes the
    // part renders, built headlessly exactly as the group composes them.
    let _ = render_reasoning_header(&activity, false, &theme);
    let _ = render_reasoning_header(&activity, true, &theme);
    let mut streaming = reasoning_activity("Still thinking");
    streaming.complete = false;
    let _ = render_reasoning_header(&streaming, true, &theme);
    let _ = render_reasoning_body(&activity, &mut test_reasoning_markdown(&mut views), &theme);
    let _ = render_reasoning_body(&streaming, &mut test_reasoning_markdown(&mut views), &theme);
    // The view the body seeded stays cached by the stable activity id.
    assert!(
        views.contains_key(&activity.id),
        "the body caches its markdown view"
    );
}

// ── Turn item + working footer (T14) ───────────────────────────────────────

/// A settled turn pinned to explicit timestamps: the same shape
/// `finish_active_turn` produces, without leaning on the wall clock.
fn turn_at(started_at: u64, completed_at: Option<u64>) -> AgentTurn {
    AgentTurn {
        id: Uuid::new_v4(),
        turn_count: 1,
        status: match completed_at {
            Some(_) => TurnStatus::Completed,
            None => TurnStatus::Running,
        },
        provider_turn_started: true,
        provider_resume_at: None,
        started_at,
        completed_at,
        checkpoint: None,
    }
}

/// Two settled prompt/answer turns, the minimum that exhibits the
/// between-turns spacing rule.
fn session_with_two_turns() -> AgentSession {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("First");
    session.push_message(MessageRole::Assistant, "One.");
    session.finish_active_turn(TurnStatus::Completed);
    session.begin_turn("Second");
    session.push_message(MessageRole::Assistant, "Two.");
    session.finish_active_turn(TurnStatus::Completed);
    session
}

#[test]
fn format_duration_reads_plain_seconds_under_the_minute() {
    assert_eq!(format_duration(5), "5s");
    assert_eq!(format_duration(59), "59s");
}

#[test]
fn format_duration_carries_minutes_past_the_minute() {
    assert_eq!(format_duration(60), "1m 0s");
    assert_eq!(format_duration(125), "2m 5s");
}

#[test]
fn elapsed_since_counts_seconds_and_floors_clock_skew() {
    assert_eq!(elapsed_since(100, 160), 60);
    assert_eq!(
        elapsed_since(300, 120),
        0,
        "a clock behind the turn's start floors at zero, never negative"
    );
}

#[test]
fn turn_top_spacing_separates_all_but_the_first_turn() {
    assert_eq!(
        turn_top_spacing(true),
        px(0.0),
        "the session's first turn sits flush at the top"
    );
    assert_eq!(turn_top_spacing(false), px(12.0));
}

#[test]
fn turn_duration_reads_settled_turns_and_floors_skew() {
    assert_eq!(turn_duration(&turn_at(100, Some(160))), Some(60));
    assert_eq!(
        turn_duration(&turn_at(200, Some(100))),
        Some(0),
        "a completion stamped before the start reads zero, never negative"
    );
    assert_eq!(
        turn_duration(&turn_at(100, None)),
        None,
        "a running turn has no duration to show"
    );
}

#[test]
fn model_segment_takes_the_tail_after_the_slash() {
    assert_eq!(
        model_segment(Some("anthropic/claude-opus-4.6")),
        Some("claude-opus-4.6")
    );
    assert_eq!(model_segment(Some("gpt-5.2")), Some("gpt-5.2"));
    assert_eq!(model_segment(None), None);
}

#[test]
fn only_turn_openers_carry_the_between_turns_spacing() {
    let session = session_with_two_turns();
    let rows = derive_rows(&session, false);
    // [prompt0, answer0, footer0, prompt1, answer1, footer1] — the prompt of
    // the second turn is the only opener: everything inside a turn continues
    // it, and the session's first turn sits flush.
    for (ix, expected) in [(0, 0.0), (1, 0.0), (2, 0.0), (3, 12.0), (4, 0.0), (5, 0.0)] {
        assert_eq!(
            spacing_before(&session, &rows, ix),
            px(expected),
            "row {ix} of {:?}",
            rows
        );
    }
}

#[test]
fn last_assistant_text_picks_the_turns_latest_assistant_reply() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn_id = session.begin_turn("Build it");
    session.push_message(MessageRole::Assistant, "First attempt.");
    session.push_message(MessageRole::Assistant, "The real answer.");
    session.finish_active_turn(TurnStatus::Completed);

    assert_eq!(
        last_assistant_text(&session, turn_id),
        Some("The real answer.".to_owned())
    );
    assert_eq!(
        last_assistant_text(&session, Uuid::new_v4()),
        None,
        "a turn the session never held has no reply to copy"
    );
}

#[test]
fn render_turn_footer_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    // With every segment present, and with each optional one absent — the
    // renderer hides what it lacks rather than rendering empty meta.
    let _ = render_turn_footer(
        Uuid::new_v4(),
        Some("anthropic/claude-opus-4.6"),
        Some(125),
        1_700_000_000,
        Some("The real answer."),
        &theme,
        |_, _, _| {},
    );
    let _ = render_turn_footer(
        Uuid::new_v4(),
        None,
        None,
        1_700_000_000,
        None,
        &theme,
        |_, _, _| {},
    );
}

#[test]
fn render_working_footer_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let _ = render_working_footer(Some(1_700_000_000), 1_700_000_060, &theme);
    let _ = render_working_footer(None, 1_700_000_060, &theme);
}

// ── Changed files card (T15) ────────────────────────────────────────────────

/// One prepared change with the stat fields and status the fold reads.
fn status_change(
    path: &str,
    additions: Option<u64>,
    deletions: Option<u64>,
    status: Option<ActivityFileChangeStatus>,
) -> ActivityFileChange {
    ActivityFileChange {
        path: path.to_owned(),
        additions,
        deletions,
        status,
        diff: None,
    }
}

#[test]
fn summarize_dedupes_by_path_summing_stats() {
    let changes = vec![
        status_change("src/lib.rs", Some(3), Some(2), None),
        status_change("src/lib.rs", Some(1), Some(2), None),
        status_change("src/main.rs", Some(5), Some(0), None),
    ];
    let summary = summarize_changes(&changes);

    assert_eq!(summary.files.len(), 2, "one row per path");
    let lib = summary
        .files
        .iter()
        .find(|file| file.path == "src/lib.rs")
        .expect("lib.rs folds in");
    assert_eq!((lib.additions, lib.deletions), (4, 4));
    // Totals fold every change, deduped or not.
    assert_eq!(summary.additions, 9);
    assert_eq!(summary.deletions, 4);
}

#[test]
fn summarize_marks_created_only_for_added_status() {
    let changes = vec![
        status_change("a.rs", Some(1), None, Some(ActivityFileChangeStatus::Added)),
        status_change(
            "b.rs",
            Some(1),
            None,
            Some(ActivityFileChangeStatus::Modified),
        ),
        status_change(
            "c.rs",
            None,
            Some(1),
            Some(ActivityFileChangeStatus::Deleted),
        ),
        status_change("d.rs", None, None, None),
    ];
    let summary = summarize_changes(&changes);

    let created = |path: &str| {
        summary
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} missing"))
            .created
    };
    assert!(created("a.rs"), "Added is the only created claim");
    assert!(!created("b.rs"), "Modified reads as edited");
    assert!(!created("c.rs"), "Deleted reads as edited, not created");
    assert!(!created("d.rs"), "an unstated status never overclaims");
    assert_eq!(summary.created, 1);
    assert_eq!(summary.edited, 3);
}

#[test]
fn summarize_sorts_created_first_then_alphabetical() {
    let changes = vec![
        status_change("b.rs", None, None, Some(ActivityFileChangeStatus::Added)),
        status_change("a.rs", None, None, Some(ActivityFileChangeStatus::Modified)),
        status_change("c.rs", None, None, Some(ActivityFileChangeStatus::Added)),
        status_change("0.rs", None, None, None),
    ];
    let summary = summarize_changes(&changes);

    let paths: Vec<&str> = summary
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec!["b.rs", "c.rs", "0.rs", "a.rs"],
        "created bucket first (alphabetical inside), then edited (alphabetical inside)"
    );
}

#[test]
fn summarize_keeps_created_sticky_across_dedupe() {
    // A file created then re-edited inside one turn: still created, still
    // one row, stats summed.
    let changes = vec![
        status_change(
            "new.rs",
            Some(10),
            None,
            Some(ActivityFileChangeStatus::Added),
        ),
        status_change(
            "new.rs",
            Some(2),
            Some(3),
            Some(ActivityFileChangeStatus::Modified),
        ),
    ];
    let summary = summarize_changes(&changes);

    assert_eq!(summary.files.len(), 1);
    assert!(summary.files[0].created);
    assert_eq!(
        (summary.files[0].additions, summary.files[0].deletions),
        (12, 3)
    );
    assert_eq!((summary.created, summary.edited), (1, 0));
}

#[test]
fn summarize_treats_missing_stats_as_zero() {
    let changes = vec![status_change("gone.rs", None, None, None)];
    let summary = summarize_changes(&changes);

    assert_eq!(
        (summary.files[0].additions, summary.files[0].deletions),
        (0, 0)
    );
    assert_eq!((summary.additions, summary.deletions), (0, 0));
}

#[test]
fn summarize_empty_changes_answer_an_empty_summary() {
    let summary = summarize_changes(&[] as &[ActivityFileChange]);

    assert_eq!(
        summary,
        ChangesSummary {
            files: Vec::new(),
            created: 0,
            edited: 0,
            additions: 0,
            deletions: 0,
        }
    );
}

#[test]
fn header_title_reads_singular_only_for_one_file() {
    assert_eq!(header_title(1), "1 file changed");
    assert_eq!(header_title(2), "2 files changed");
    assert_eq!(header_title(0), "0 files changed");
}

#[test]
fn counts_chip_omits_zero_segments() {
    assert_eq!(counts_chip(2, 1).as_deref(), Some("2 created · 1 edited"));
    assert_eq!(counts_chip(3, 0).as_deref(), Some("3 created"));
    assert_eq!(counts_chip(0, 4).as_deref(), Some("4 edited"));
    assert_eq!(counts_chip(0, 0), None, "nothing to distinguish, no chip");
}

#[test]
fn visible_files_budgets_the_collapsed_list() {
    // At the budget everything fits with no expander.
    assert_eq!(visible_files(MAX_VISIBLE_FILES, false), (5, None));
    assert_eq!(visible_files(1, false), (1, None));
    // One past it: four rows plus the expander naming the rest.
    assert_eq!(visible_files(6, false), (4, Some(2)));
    assert_eq!(visible_files(50, false), (4, Some(46)));
    // Expanded shows everything, whatever the size.
    assert_eq!(visible_files(50, true), (50, None));
}

#[test]
fn files_card_id_anchors_on_the_turn() {
    let turn_id = Uuid::new_v4();
    assert_eq!(files_card_id(turn_id), format!("files-{turn_id}"));
}

#[test]
fn render_changed_files_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let actions = TranscriptActions::no_op();
    let toggle: GroupToggle = std::sync::Arc::new(|_, _, _, _| {});

    // A turn's worth of shapes: created + edited, one statless, and a list
    // past the budget so the expander row exists.
    let changes: Vec<ActivityFileChange> = (0..8)
        .map(|n| {
            status_change(
                &format!("/tmp/ws/src/file{n}.rs"),
                Some(n),
                Some(n),
                (n % 3 == 0).then_some(ActivityFileChangeStatus::Added),
            )
        })
        .chain([status_change("/tmp/ws/statless.rs", None, None, None)])
        .collect();
    let summary = summarize_changes(&changes);

    // Collapsed (the settled default) and expanded.
    let _ = render_changed_files(
        &summary,
        test_workspace(),
        &actions,
        &theme,
        false,
        "files-t",
        std::sync::Arc::clone(&toggle),
    );
    let _ = render_changed_files(
        &summary,
        test_workspace(),
        &actions,
        &theme,
        true,
        "files-t",
        toggle,
    );

    // The quietest real card: one statless edit, no chip, no totals.
    let single = summarize_changes(&[status_change("/tmp/ws/one.rs", None, None, None)]);
    let _ = render_changed_files(
        &single,
        test_workspace(),
        &actions,
        &theme,
        false,
        "files-t",
        std::sync::Arc::new(|_, _, _, _| {}),
    );
}

#[test]
fn changed_files_card_icons_exist_in_assets() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for icon in [
        "icons/file-diff.svg",
        "icons/chevron-down.svg",
        "icons/chevron-up.svg",
        "icons/git-commit-horizontal.svg",
    ] {
        assert!(
            manifest.join("assets").join(icon).exists(),
            "card icon is missing on disk: {icon}"
        );
    }
}

// ── Error block (T16) ───────────────────────────────────────────────────────

/// A failed turn shaped the way streaming.rs leaves one: the prompt, then —
/// when the failure path had text to record — the error appended as the
/// turn's assistant message before the turn settled.
fn session_with_failed_turn(error: Option<&str>) -> AgentSession {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("Fix the build");
    if let Some(error) = error {
        session.push_message(MessageRole::Assistant, error);
    }
    session.finish_active_turn(TurnStatus::Failed);
    session
}

#[test]
fn error_text_answers_none_for_non_failed_turns() {
    // Completed and running carry no error, and — the case the task pins —
    // neither does interrupted: a user stop is not a failure, even when the
    // turn had text.
    let completed = session_with_completed_turn(ActivityKind::Command);
    assert_eq!(
        error_text_for_turn(&completed.turns[0], &completed.messages),
        None
    );

    let mut interrupted = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    interrupted.begin_turn("Fix the build");
    interrupted.push_message(MessageRole::Assistant, "Half an answer");
    interrupted.finish_active_turn(TurnStatus::Interrupted);
    assert_eq!(
        error_text_for_turn(&interrupted.turns[0], &interrupted.messages),
        None,
        "an interrupted turn renders no error card"
    );
}

#[test]
fn error_text_reads_the_failed_turns_last_assistant_message() {
    // The streaming.rs append convention: the error lands as the failed
    // turn's assistant message. Several messages means the latest — the same
    // rule the footer's Copy uses.
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("Fix the build");
    session.push_message(MessageRole::Assistant, "Partial reply");
    session.push_message(MessageRole::Assistant, "driver exited unexpectedly");
    session.finish_active_turn(TurnStatus::Failed);
    assert_eq!(
        error_text_for_turn(&session.turns[0], &session.messages),
        Some("driver exited unexpectedly".to_owned())
    );

    // Only the turn's own messages count: a later turn's reply never reads
    // as this turn's error.
    let failed = session_with_failed_turn(None);
    let mut with_later_reply = failed.clone();
    with_later_reply.begin_turn("Try again");
    with_later_reply.push_message(MessageRole::Assistant, "All good now.");
    with_later_reply.finish_active_turn(TurnStatus::Completed);
    assert_eq!(
        error_text_for_turn(&with_later_reply.turns[0], &with_later_reply.messages),
        Some(TURN_FAILED_FALLBACK.to_owned()),
        "a failed turn without its own error message falls back, never borrowing a later turn's reply"
    );
}

#[test]
fn error_text_falls_back_when_the_recorded_error_is_empty_or_absent() {
    // Empty-string error message: the append happened but said nothing.
    let empty = session_with_failed_turn(Some("   "));
    assert_eq!(
        error_text_for_turn(&empty.turns[0], &empty.messages),
        Some(TURN_FAILED_FALLBACK.to_owned()),
        "blank error text still reads as a failure"
    );
    // No assistant message at all (the append never fired): the turn still
    // failed, and the card still has something honest to say.
    let silent = session_with_failed_turn(None);
    assert_eq!(
        error_text_for_turn(&silent.turns[0], &silent.messages),
        Some(TURN_FAILED_FALLBACK.to_owned())
    );
}

#[test]
fn retry_text_picks_the_turns_opening_prompt() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let turn_id = session.begin_turn("Fix the build");
    // A steer folded into the same running turn: a later user message that
    // must not become the retry — re-sending it alone would misrepresent
    // the request.
    session.push_user_message_with_presentation("use cargo", None, Vec::new());
    session.finish_active_turn(TurnStatus::Failed);

    assert_eq!(
        retry_text_for_turn(turn_id, &session.messages),
        Some("Fix the build".to_owned())
    );
    assert_eq!(
        retry_text_for_turn(Uuid::new_v4(), &session.messages),
        None,
        "a turn the session never held has no prompt to resend"
    );
}

#[test]
fn error_block_id_anchors_on_the_turn() {
    let turn_id = Uuid::new_v4();
    assert_eq!(error_block_id(turn_id), format!("error-{turn_id}"));
}

#[test]
fn render_error_block_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let toggle: GroupToggle = std::sync::Arc::new(|_, _, _, _| {});
    let retry: super::rows::error_block::RetryAction =
        std::sync::Arc::new(|_: &gpui::ClickEvent, _: &mut gpui::Window, _: &mut gpui::App| {});

    // Collapsed (the settled default) and expanded, with the Retry button
    // and without it (a pursuit turn with no prompt to resend).
    let _ = render_error_block(
        "driver exited unexpectedly",
        &theme,
        false,
        "error-t",
        std::sync::Arc::clone(&toggle),
        Some(std::sync::Arc::clone(&retry)),
    );
    let _ = render_error_block(
        "driver exited unexpectedly",
        &theme,
        true,
        "error-t",
        toggle,
        None,
    );
}

#[test]
fn error_block_icons_exist_in_assets() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for icon in [
        "icons/alert.svg",
        "icons/refresh.svg",
        "icons/chevron-down.svg",
        "icons/chevron-up.svg",
    ] {
        assert!(
            manifest.join("assets").join(icon).exists(),
            "error card icon is missing on disk: {icon}"
        );
    }
}

// ── User bubble: edit-and-resend removal accounting (T17) ───────────────────

#[test]
fn edit_removals_counts_nothing_for_the_last_message() {
    // Editing the session's final user message — nothing followed it, so a
    // resend rewinds nothing: the immediate-send case.
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    session.begin_turn("Last prompt");
    assert_eq!(edit_removals(&session, 0), (0, 0));

    // Nor does an empty session claim removals for any index.
    let empty = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    assert_eq!(edit_removals(&empty, 0), (0, 0));
}

#[test]
fn edit_removals_counts_assistant_replies_after_the_edit() {
    let session = session_with_two_turns();
    // Messages: [user0, assistant1, user2, assistant3].
    assert_eq!(
        edit_removals(&session, 0),
        (2, 0),
        "editing the first prompt removes both turns' replies"
    );
    assert_eq!(
        edit_removals(&session, 2),
        (1, 0),
        "editing the second prompt removes only its reply"
    );
    // A user steer after the edit point is removed by the rewind too, but it
    // is not a *reply* — only assistant messages count.
    let mut steered = session;
    let turn_id = steered.turns[0].id;
    steered.messages.push(crate::model::Message::new_for_turn(
        MessageRole::User,
        "use cargo",
        turn_id,
    ));
    assert_eq!(
        edit_removals(&steered, 0),
        (2, 0),
        "later user messages never count as replies"
    );
}

#[test]
fn edit_removals_counts_tool_runs_in_blocks_anchored_after_the_edit() {
    let mut session = AgentSession::new(Uuid::new_v4(), ProviderKind::Tide);
    let first = session.begin_turn("First");
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 1,
        turn_id: Some(first),
        activities: vec![
            tool_activity(ActivityKind::Command, "bash", None),
            tool_activity(ActivityKind::Command, "bash", None),
        ],
    });
    session.push_message(MessageRole::Assistant, "One.");
    session.finish_active_turn(TurnStatus::Completed);
    let second = session.begin_turn("Second");
    session.transcript_blocks.push(TranscriptBlock {
        after_message: 3,
        turn_id: Some(second),
        activities: vec![tool_activity(ActivityKind::FileChange, "edit_file", None)],
    });
    session.push_message(MessageRole::Assistant, "Two.");
    session.finish_active_turn(TurnStatus::Completed);
    // A block anchored before the edit point survives the rewind — its runs
    // must stay out of the count.
    session.transcript_blocks.insert(
        0,
        TranscriptBlock {
            after_message: 0,
            turn_id: Some(first),
            activities: vec![tool_activity(ActivityKind::FileRead, "read_file", None)],
        },
    );

    assert_eq!(
        edit_removals(&session, 0),
        (2, 3),
        "both replies plus the three activities in blocks anchored after the prompt"
    );
    assert_eq!(
        edit_removals(&session, 2),
        (1, 1),
        "editing the second prompt counts only the block anchored after it"
    );
}

#[test]
fn edit_removals_out_of_range_answers_zero() {
    let session = session_with_two_turns();
    assert_eq!(edit_removals(&session, 999), (0, 0));
}

// ── User bubble: clamp accounting + renderers ───────────────────────────────

#[test]
fn clamp_id_anchors_on_the_message() {
    let id = Uuid::new_v4();
    assert_eq!(clamp_id(id), format!("clamp-{id}"));
}

#[test]
fn clamp_needed_estimates_tall_content() {
    // Short single-line content never clamps.
    assert!(!clamp_needed("Ship it"));
    // Eight 20px lines fit the 160px budget…
    assert!(!clamp_needed(&"one line\n".repeat(8)));
    // …the ninth tips past it.
    assert!(clamp_needed(&"one line\n".repeat(9)));
    // A single very long line wraps into many rendered lines and clamps too.
    assert!(clamp_needed(&"word ".repeat(200)));
    // Blank content is no bubble at all, never a clamped one.
    assert!(!clamp_needed("   "));
    // The budget the estimator serves is the documented clamp height.
    assert_eq!(CLAMP_MAX_HEIGHT, 160.0);
}

/// No-op click wiring so the renderer builds headlessly.
fn noop_user_actions() -> UserBubbleActions {
    fn noop(_: &gpui::ClickEvent, _: &mut gpui::Window, _: &mut gpui::App) {}
    UserBubbleActions {
        edit: std::sync::Arc::new(noop),
        cancel: std::sync::Arc::new(noop),
        send: std::sync::Arc::new(noop),
        confirm: std::sync::Arc::new(noop),
        disarm: std::sync::Arc::new(noop),
    }
}

#[test]
fn render_user_bubble_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let toggle: GroupToggle = std::sync::Arc::new(|_, _, _, _| {});

    // Short editable message: bubble + hover footer.
    let _ = render_user_bubble(
        Uuid::new_v4(),
        "Ship it",
        1_700_000_000,
        false,
        true,
        None,
        &[],
        &theme,
        noop_user_actions(),
        std::sync::Arc::clone(&toggle),
    );
    // Long content clamps collapsed, opens expanded, and hides the pencil
    // while the session is busy.
    let long = "one line\n".repeat(30);
    for (expanded, editable) in [(false, true), (true, false)] {
        let _ = render_user_bubble(
            Uuid::new_v4(),
            &long,
            1_700_000_000,
            expanded,
            editable,
            None,
            &[],
            &theme,
            noop_user_actions(),
            std::sync::Arc::clone(&toggle),
        );
    }
    // Blank content renders the footer alone, like the legacy pane hides the
    // empty bubble.
    let _ = render_user_bubble(
        Uuid::new_v4(),
        "   ",
        1_700_000_000,
        false,
        false,
        None,
        &[],
        &theme,
        noop_user_actions(),
        toggle,
    );
}

#[test]
fn editor_actions_row_constructs_both_states() {
    let theme = crate::theme::Theme::dark();
    let actions = noop_user_actions();

    // The quiet editor row: Cancel + Send.
    let _ = editor_actions_row(Uuid::new_v4(), None, &theme, &actions);
    // The armed confirmation: the removal count plus Confirm + Cancel.
    let _ = editor_actions_row(Uuid::new_v4(), Some((2, 3)), &theme, &actions);
}

#[test]
fn user_bubble_icons_exist_in_assets() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for icon in [
        "icons/pencil.svg",
        "icons/copy.svg",
        "icons/check.svg",
        "icons/x.svg",
        "icons/chevron-down.svg",
        "icons/chevron-up.svg",
    ] {
        assert!(
            manifest.join("assets").join(icon).exists(),
            "user bubble icon is missing on disk: {icon}"
        );
    }
}

// ── Question card (T20) ──────────────────────────────────────────────────────

/// One answer option, label only.
fn input_option(label: &str) -> UserInputOption {
    UserInputOption {
        label: label.to_owned(),
        description: None,
    }
}

/// A one-question follow-up with two options.
fn followup_question() -> UserInputQuestion {
    UserInputQuestion {
        id: "q-1".to_owned(),
        header: "Question".to_owned(),
        question: "Which database?".to_owned(),
        options: vec![input_option("Postgres"), input_option("SQLite")],
        multi_select: false,
    }
}

#[test]
fn answer_for_selection_maps_selected_options_to_labels() {
    let options = vec![input_option("Postgres"), input_option("SQLite")];

    // The selected option answers with its label under the question's id.
    let answer = answer_for_selection("q-1", &options, &[1], None);
    assert_eq!(answer.question_id, "q-1");
    assert_eq!(answer.answers, vec!["SQLite".to_owned()]);

    // Multi-select keeps option order, not click order.
    let answer = answer_for_selection("q-1", &options, &[1, 0], None);
    assert_eq!(
        answer.answers,
        vec!["Postgres".to_owned(), "SQLite".to_owned()]
    );

    // An out-of-range index contributes nothing rather than panicking.
    let answer = answer_for_selection("q-1", &options, &[9], None);
    assert!(answer.answers.is_empty());
}

#[test]
fn answer_for_selection_prefers_non_blank_custom_text() {
    let options = vec![input_option("Postgres")];

    // A custom answer trims and wins over the selection — the runtime's own
    // fold in `PendingUserInput::answers`.
    let answer = answer_for_selection("q-1", &options, &[0], Some("  MariaDB  "));
    assert_eq!(answer.answers, vec!["MariaDB".to_owned()]);

    // Blank custom text is no answer of its own; the selection answers.
    let answer = answer_for_selection("q-1", &options, &[0], Some("   "));
    assert_eq!(answer.answers, vec!["Postgres".to_owned()]);
}

#[test]
fn answer_for_selection_without_answer_is_empty() {
    // Nothing selected and no custom text is not yet an answer — the submit
    // gate stays closed.
    let answer = answer_for_selection("q-1", &[input_option("Postgres")], &[], None);
    assert_eq!(answer.question_id, "q-1");
    assert!(answer.answers.is_empty());
}

#[test]
fn selected_indices_map_labels_back_to_option_order() {
    let question = followup_question();
    assert_eq!(
        selected_indices(&question, &["SQLite".to_owned()]),
        vec![1],
        "one label resolves to its option's index"
    );
    assert_eq!(
        selected_indices(&question, &["SQLite".to_owned(), "Postgres".to_owned()]),
        vec![0, 1],
        "the indices come back in option order"
    );
    // A label the options do not carry (stale runtime state) drops out.
    assert_eq!(
        selected_indices(&question, &["MySQL".to_owned()]),
        Vec::<usize>::new()
    );
    assert_eq!(selected_indices(&question, &[]), Vec::<usize>::new());
}

/// No-op click wiring, the bubble's pattern: the renderer only threads these
/// through, so the tree builds headlessly.
fn noop_select() -> SelectOption {
    std::sync::Arc::new(|_: &str, _, _, _| {})
}

#[test]
fn render_option_row_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let option = UserInputOption {
        label: "Postgres".to_owned(),
        description: Some("Relational".to_owned()),
    };
    let select = noop_select();

    // Unselected (hover-lit) and selected (accent-tinted) — the two states
    // the card composes.
    let _ = render_option_row(
        &option,
        false,
        "question-card-q-1-option-0",
        &theme,
        &select,
    );
    let _ = render_option_row(&option, true, "question-card-q-1-option-0", &theme, &select);
}

#[test]
fn render_submit_row_constructs_both_states() {
    let theme = crate::theme::Theme::dark();
    let submit: QuestionCardAction = std::sync::Arc::new(|_, _, _| {});

    // Armed submit and armed next; the unarmed gate renders inert.
    let _ = render_submit_row(true, true, "question-card-q-1-submit", &theme, &submit);
    let _ = render_submit_row(true, false, "question-card-q-1-submit", &theme, &submit);
    let _ = render_submit_row(false, true, "question-card-q-1-submit", &theme, &submit);
}

// ── Session-switch skeleton (T20) ────────────────────────────────────────────

#[test]
fn skeleton_active_only_inside_the_switch_window() {
    let now = std::time::Instant::now();

    // No switch armed: rows render.
    assert!(!skeleton_active(None, now));
    // Armed and inside the window: the gray blocks own the pane.
    assert!(skeleton_active(
        Some(now + std::time::Duration::from_millis(150)),
        now
    ));
    // Expired: rows render again.
    assert!(!skeleton_active(
        Some(now - std::time::Duration::from_millis(1)),
        now
    ));
    // The boundary itself counts as expired — the frame landing exactly at
    // `until` already shows rows.
    assert!(!skeleton_active(Some(now), now));
}

#[test]
fn render_switch_skeleton_constructs_headlessly() {
    let theme = crate::theme::Theme::dark();
    let _ = render_switch_skeleton(&theme);
}

// ── Permission card (T21) ────────────────────────────────────────────────────

/// One driver option: id, label, allow flag.
fn permission_option(id: &str, label: &str, allow: bool) -> PermissionOption {
    PermissionOption {
        id: id.to_owned(),
        label: label.to_owned(),
        allow,
    }
}

/// The tide driver's three-option ask — the shape with the chevron menu.
fn tide_permission() -> PendingPermission {
    PendingPermission {
        request_id: "req-1".to_owned(),
        title: "Tide wants to run bash".to_owned(),
        detail: "rm -rf /tmp/build".to_owned(),
        options: vec![
            permission_option("allow", "Allow", true),
            permission_option("always", "Always allow", true),
            permission_option("deny", "Deny", false),
        ],
    }
}

#[test]
fn seconds_left_is_none_without_a_deadline() {
    // No timeout carried: no countdown line at all — the honest answer for
    // every permission the drivers send today.
    assert_eq!(seconds_left(None, 1_000), None);
}

#[test]
fn seconds_left_counts_whole_seconds_to_the_deadline() {
    assert_eq!(seconds_left(Some(1_045), 1_000), Some("45s".to_owned()));
    assert_eq!(seconds_left(Some(1_001), 1_000), Some("1s".to_owned()));
}

#[test]
fn seconds_left_expires_clamped_at_zero() {
    // The deadline second itself and any past deadline both read "0s" — the
    // line never shows a growing negative.
    assert_eq!(seconds_left(Some(1_000), 1_000), Some("0s".to_owned()));
    assert_eq!(seconds_left(Some(999), 1_000), Some("0s".to_owned()));
}

#[test]
fn permission_deadline_is_none_until_a_driver_carries_one() {
    // The seam the countdown reads from: `PendingPermission` has no timeout
    // field today, so the answer is None and the countdown stays dormant.
    assert_eq!(permission_deadline(&tide_permission()), None);
}

#[test]
fn permission_layout_primes_allow_menus_the_rest_and_rejects() {
    let permission = tide_permission();
    let layout = permission_layout(&permission.options);

    assert_eq!(layout.allow.map(|option| option.id.as_str()), Some("allow"));
    assert_eq!(
        layout
            .allow_more
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["always"],
        "later allow options fold into the chevron menu"
    );
    assert_eq!(
        layout
            .denies
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["deny"]
    );
}

#[test]
fn permission_layout_without_extra_allows_has_no_menu() {
    // The claude driver's two-option ask: primary allow + reject, no chevron.
    let claude = vec![
        permission_option("allow", "Allow once", true),
        permission_option("deny", "Deny", false),
    ];
    let layout = permission_layout(&claude);

    assert_eq!(layout.allow.map(|option| option.id.as_str()), Some("allow"));
    assert!(layout.allow_more.is_empty());
    assert_eq!(layout.denies.len(), 1);
}

#[test]
fn permission_layout_survives_one_sided_and_empty_option_sets() {
    // Deny-only: no allow button, the reject path stays reachable.
    let deny_only = vec![permission_option("reject", "Reject", false)];
    let layout = permission_layout(&deny_only);
    assert!(layout.allow.is_none());
    assert!(layout.allow_more.is_empty());
    assert_eq!(layout.denies.len(), 1);

    // Nothing sent: nothing renders.
    let layout = permission_layout(&[]);
    assert!(layout.allow.is_none());
    assert!(layout.allow_more.is_empty());
    assert!(layout.denies.is_empty());
}

/// No-op response wiring, the bubble's pattern: the card only threads the
/// closure through, so the tree builds headlessly.
fn noop_respond() -> PermissionRespond {
    std::sync::Arc::new(|_: &str, _: &mut gpui::Window, _: &mut gpui::App| {})
}

#[gpui::test]
fn render_permission_card_constructs_headlessly(cx: &mut TestAppContext) {
    let theme = crate::theme::Theme::dark();
    let handle = cx.update(ContextMenuHandle::new);
    let respond = noop_respond();

    // The tide shape: split button with the chevron menu, no countdown.
    let permission = tide_permission();
    let _ = render_permission_card(
        &permission.title,
        &permission.detail,
        &permission.options,
        None,
        "permission-card-req-1",
        &handle,
        &theme,
        &respond,
    );

    // The claude shape (no menu entries) with the countdown line present —
    // dormant today, but the renderer must compose it when handed one.
    let claude = PendingPermission {
        request_id: "req-2".to_owned(),
        title: "Run bash?".to_owned(),
        detail: "cargo test".to_owned(),
        options: vec![
            permission_option("allow", "Allow once", true),
            permission_option("deny", "Deny", false),
        ],
    };
    let _ = render_permission_card(
        &claude.title,
        &claude.detail,
        &claude.options,
        Some("expires in 42s"),
        "permission-card-req-2",
        &handle,
        &theme,
        &respond,
    );
}

#[test]
fn permission_card_icons_exist_in_assets() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for icon in [
        "icons/alert.svg",
        "icons/check.svg",
        "icons/chevron-down.svg",
    ] {
        assert!(
            manifest.join("assets").join(icon).exists(),
            "permission card icon is missing on disk: {icon}"
        );
    }
}

// ── Find-in-page (search.rs) ──────────────────────────────────────────────

fn search_message(role: MessageRole, content: &str) -> crate::model::Message {
    crate::model::Message::new(role, content)
}

#[test]
fn find_matches_reports_multiple_hits_per_message() {
    let messages = vec![search_message(MessageRole::User, "tide tide TIDE")];

    let found = find_matches(&messages, "tide", false);

    assert_eq!(
        found.iter().map(|hit| hit.span).collect::<Vec<_>>(),
        vec![(0, 4), (5, 9), (10, 14)],
        "three hits, spans ascending inside the one message"
    );
    assert!(found.iter().all(|hit| hit.message_index == 0));
}

#[test]
fn find_matches_empty_query_is_empty() {
    let messages = vec![search_message(MessageRole::Assistant, "needle")];
    assert!(find_matches(&messages, "", false).is_empty());
}

#[test]
fn find_matches_without_hits_is_empty() {
    let messages = vec![search_message(MessageRole::Assistant, "haystack")];
    assert!(find_matches(&messages, "needle", false).is_empty());
}

#[test]
fn find_matches_folds_case_by_default_and_honors_case_sensitive() {
    let messages = vec![search_message(
        MessageRole::Assistant,
        "Needle needle NEEDLE",
    )];

    assert_eq!(find_matches(&messages, "needle", false).len(), 3);
    let sensitive = find_matches(&messages, "needle", true);
    assert_eq!(sensitive.len(), 1);
    assert_eq!(sensitive[0].span, (7, 13));
}

#[test]
fn find_matches_orders_by_message_then_position_and_skips_other_roles() {
    let messages = vec![
        search_message(MessageRole::System, "needle"),
        search_message(MessageRole::User, "needle one"),
        search_message(MessageRole::Assistant, "two needle needle"),
    ];

    let found = find_matches(&messages, "needle", false);

    assert_eq!(
        found
            .iter()
            .map(|hit| (hit.message_index, hit.span))
            .collect::<Vec<_>>(),
        vec![(1, (0, 6)), (2, (4, 10)), (2, (11, 17))],
        "message order first, position within a message second, system skipped"
    );
}

#[test]
fn find_matches_spans_live_in_the_flattened_markdown_text() {
    // Marker syntax never reaches the screen; a hit names the painted
    // glyphs, so the range sits in the flattened text (and carries the
    // element ordinal the highlight quads key on).
    let messages = vec![search_message(MessageRole::Assistant, "**needle** tail")];

    let found = find_matches(&messages, "needle", false);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].span, (0, 6));
    assert_eq!(found[0].ordinal, 0);
}

// ── Navigation rail (the shared ConversationNavigationRail) ────────────────

#[test]
fn rail_openings_map_each_user_message_row() {
    let session = session_with_two_turns();
    // Rows: user(T0), assistant(T0), footer(T0), user(T1), assistant(T1),
    // footer(T1) — the openings point at the user-message rows and bound
    // each turn's response scan at the next user message.
    let rows = derive_rows(&session, false);

    let openings = navigation_openings(&session, &rows);

    assert_eq!(
        openings,
        vec![
            NavigationTurnOpening {
                message_index: 0,
                row_index: 0,
                next_user_index: 2,
            },
            NavigationTurnOpening {
                message_index: 2,
                row_index: 3,
                next_user_index: 4,
            },
        ]
    );
}

#[test]
fn rail_openings_skip_messages_without_a_row() {
    let session = session_with_two_turns();
    // A fold that renders no rows at all resolves no openings — the cursor
    // walk finds no Message row, so the rail simply has no turns.
    assert_eq!(navigation_openings(&session, &[]), Vec::new());
}

#[test]
fn rail_openings_survive_rows_between_user_messages() {
    let session = session_with_two_turns();
    let mut rows = derive_rows(&session, false);
    // Splice extra non-message rows ahead of the second user message — the
    // walk must step over anything that is not a Message row.
    rows.insert(3, TimelineV2Row::TurnFooter { turn: 0 });
    rows.insert(0, TimelineV2Row::TurnFooter { turn: 0 });

    let openings = navigation_openings(&session, &rows);

    assert_eq!(
        openings,
        vec![
            NavigationTurnOpening {
                message_index: 0,
                row_index: 1,
                next_user_index: 2,
            },
            NavigationTurnOpening {
                message_index: 2,
                row_index: 5,
                next_user_index: 4,
            },
        ]
    );
}
