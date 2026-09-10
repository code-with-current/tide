//! The v2 row model: folding an [`AgentSession`] into the flat list the pane
//! renders, plus the cheap identity the frame path uses to skip refolding.
//!
//! Fresh implementation sharing the legacy fold's ordering semantics — a
//! block anchors by persisted-message count (`after_message == n` renders
//! after the first `n` messages, before message `n`), blocks sharing an
//! anchor keep insertion order — without importing any legacy code.
//!
//! The phase-3 row renderers live under this tree too: the model stays here,
//! one file per row anatomy below.

pub(crate) mod activity_group;
pub(crate) mod changed_files;
pub(crate) mod error_block;
pub(crate) mod turn_item;
pub(crate) mod working_footer;

use crate::model::{ActivityItem, ActivityKind, AgentSession, MessageRole, TurnStatus};
use std::collections::HashMap;
use uuid::Uuid;

/// One rendered row of the v2 transcript. Indices point into the session's
/// own vectors, so a row stays meaningful across folds and list rebuilds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TimelineV2Row {
    /// `session.messages[index]`.
    Message { index: usize },
    /// `session.transcript_blocks[block]`, rendered at its anchor.
    ActivityGroup { block: usize },
    /// End-of-turn summary for `session.turns[turn]`.
    TurnFooter { turn: usize },
    /// File-change summary for `session.turns[turn]`.
    ChangedFiles { turn: usize },
    /// Live-work indicator, present only while the selected session streams.
    Working,
}

/// One step of the single walk both consumers share. A fact carries the
/// indices its [`TimelineV2Row`] needs plus the identity bits the
/// fingerprint folds, so the row list and its fingerprint can never drift
/// apart: anything that moves one moves the other.
#[derive(Clone, Copy, Debug)]
enum RowFact<'a> {
    /// Last 8 bytes of the message's uuid — its hex tail — which is all the
    /// identity a fingerprint needs from an id that is already unique.
    Message {
        index: usize,
        role: MessageRole,
        id_tail: u64,
    },
    ActivityGroup {
        block: usize,
        /// The clamped anchor the group rendered at; in-flight blocks
        /// re-anchor as messages arrive, which moves rows.
        anchor: usize,
        turn_id: Option<Uuid>,
        activities: &'a [ActivityItem],
    },
    TurnFooter {
        turn: usize,
        turn_id: Uuid,
        status: TurnStatus,
    },
    ChangedFiles {
        turn: usize,
        turn_id: Uuid,
    },
    Working,
}

impl RowFact<'_> {
    fn row(self) -> TimelineV2Row {
        match self {
            RowFact::Message { index, .. } => TimelineV2Row::Message { index },
            RowFact::ActivityGroup { block, .. } => TimelineV2Row::ActivityGroup { block },
            RowFact::TurnFooter { turn, .. } => TimelineV2Row::TurnFooter { turn },
            RowFact::ChangedFiles { turn, .. } => TimelineV2Row::ChangedFiles { turn },
            RowFact::Working => TimelineV2Row::Working,
        }
    }
}

/// Fold the session into v2 rows (flat, top-to-bottom). Free fn — testable.
pub(crate) fn derive_rows(session: &AgentSession, streaming: bool) -> Vec<TimelineV2Row> {
    walk(session, streaming).map(|fact| fact.row()).collect()
}

/// Cheap identity of the derived row list: counts + ids. Like tide's block
/// ids, a tool card's identity is its activity id. Same-process stability is
/// the contract; the mixing is FNV-1a style, so it also happens to be
/// deterministic across runs.
pub(crate) fn rows_fingerprint(session: &AgentSession, streaming: bool) -> u64 {
    // Streaming is folded before the walk because it also covers state the
    // rows alone cannot see: the Working row aside, the streaming flag can
    // flip while every other fact holds still.
    let mut hash = mix(FINGERPRINT_SEED, streaming as u64);
    hash = mix(hash, session.messages.len() as u64);
    hash = mix(hash, session.turns.len() as u64);
    // Turn statuses move rows for the footer's sake, but a Completed → Failed
    // flip leaves the row list shape intact, so fold every status explicitly.
    for turn in &session.turns {
        hash = mix(hash, turn.status as u64);
    }
    for fact in walk(session, streaming) {
        hash = match fact {
            RowFact::Message {
                index,
                role,
                id_tail,
            } => mix(
                mix(mix(mix(hash, FACT_MESSAGE), index as u64), role as u64),
                id_tail,
            ),
            RowFact::ActivityGroup {
                block,
                anchor,
                turn_id,
                activities,
            } => {
                let hash = mix(
                    mix(
                        mix(mix(hash, FACT_ACTIVITY_GROUP), block as u64),
                        anchor as u64,
                    ),
                    turn_option_tail(turn_id),
                );
                activities.iter().fold(hash, |hash, activity| {
                    mix(
                        mix(hash, activity.id.as_u128() as u64),
                        (activity.complete as u64) | ((activity.failed as u64) << 1),
                    )
                })
            }
            RowFact::TurnFooter {
                turn,
                turn_id,
                status,
            } => mix(
                mix(
                    mix(mix(hash, FACT_TURN_FOOTER), turn as u64),
                    turn_id.as_u128() as u64,
                ),
                status as u64,
            ),
            RowFact::ChangedFiles { turn, turn_id } => mix(
                mix(mix(hash, FACT_CHANGED_FILES), turn as u64),
                turn_id.as_u128() as u64,
            ),
            RowFact::Working => mix(hash, FACT_WORKING),
        };
    }
    hash
}

/// The one traversal both public fns consume: base rows in transcript order,
/// footer facts spliced after each settled turn's last row, and — while
/// streaming — a trailing Working fact.
fn walk(session: &AgentSession, streaming: bool) -> impl Iterator<Item = RowFact<'_>> {
    let message_count = session.messages.len();
    let mut blocks_after = vec![Vec::new(); message_count + 1];
    for (block, anchor) in session
        .transcript_blocks
        .iter()
        .map(|block| block.after_message)
        .enumerate()
    {
        blocks_after[anchor.min(message_count)].push(block);
    }
    let group_fact = |block: usize| {
        let block_data = &session.transcript_blocks[block];
        RowFact::ActivityGroup {
            block,
            anchor: block_data.after_message.min(message_count),
            turn_id: block_data.turn_id,
            activities: &block_data.activities,
        }
    };

    let mut facts = Vec::with_capacity(
        message_count
            + session.transcript_blocks.len()
            + session.turns.len() * 2
            + usize::from(streaming),
    );
    facts.extend(blocks_after[0].iter().map(|&block| group_fact(block)));
    for index in 0..message_count {
        let message = &session.messages[index];
        facts.push(RowFact::Message {
            index,
            role: message.role,
            id_tail: message.id.as_u128() as u64,
        });
        facts.extend(
            blocks_after[index + 1]
                .iter()
                .map(|&block| group_fact(block)),
        );
    }

    // A turn's closing rows anchor after its final row so far — answer text
    // or trailing activity, whichever came last. A settled turn closes with
    // a footer plus a file-change summary when the turn's work edited
    // files; a running turn shows that summary the moment edit work lands
    // (re-anchoring down as the turn grows) and still owes its footer.
    let mut last_row_by_turn: HashMap<usize, (usize, bool)> = HashMap::new();
    for (fact_index, fact) in facts.iter().enumerate() {
        let turn_id = match *fact {
            RowFact::Message { index, .. } => session.messages[index].turn_id,
            RowFact::ActivityGroup { turn_id, .. } => turn_id,
            _ => None,
        };
        let Some(turn_id) = turn_id else {
            continue;
        };
        let Some(turn) = session.turns.iter().position(|turn| turn.id == turn_id) else {
            continue;
        };
        // Facts arrive in order, so the last insert per turn wins.
        last_row_by_turn.insert(
            turn,
            (fact_index, session.turns[turn].status != TurnStatus::Running),
        );
    }
    let closing_after: HashMap<usize, (usize, bool)> = last_row_by_turn
        .into_iter()
        .map(|(turn, (fact_index, settled))| (fact_index, (turn, settled)))
        .collect();

    let mut with_footers = Vec::with_capacity(facts.len() + closing_after.len() * 2);
    for (fact_index, fact) in facts.into_iter().enumerate() {
        with_footers.push(fact);
        if let Some(&(turn, settled)) = closing_after.get(&fact_index) {
            if turn_changed_files(session, session.turns[turn].id) {
                with_footers.push(RowFact::ChangedFiles {
                    turn,
                    turn_id: session.turns[turn].id,
                });
            }
            if settled {
                let turn_data = &session.turns[turn];
                with_footers.push(RowFact::TurnFooter {
                    turn,
                    turn_id: turn_data.id,
                    status: turn_data.status,
                });
            }
        }
    }
    if streaming {
        with_footers.push(RowFact::Working);
    }
    with_footers.into_iter()
}

/// Whether the turn's activities include any file-change work (the
/// edit/write/notebook families all classify as [`ActivityKind::FileChange`]).
fn turn_changed_files(session: &AgentSession, turn_id: Uuid) -> bool {
    session
        .transcript_blocks
        .iter()
        .filter(|block| block.turn_id == Some(turn_id))
        .any(|block| {
            block
                .activities
                .iter()
                .any(|activity| activity.kind == ActivityKind::FileChange)
        })
}

/// A row that can belong to a turn's narration fold — the work folded
/// under the collapsed group header once the turn settles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NarrationRow {
    Message { index: usize },
    Block { index: usize },
}

/// The turn's narration span as message indices: its opening prompt and its
/// final message. `None` when the turn holds a single message (nothing
/// between them could fold) or names no messages the session still has.
fn narration_span(session: &AgentSession, turn: usize) -> Option<(usize, usize)> {
    let turn_id = session.turns.get(turn)?.id;
    let mut span: Option<(usize, usize)> = None;
    for (index, message) in session.messages.iter().enumerate() {
        if message.turn_id == Some(turn_id) {
            match span {
                None => span = Some((index, index)),
                Some((first, _)) => span = Some((first, index)),
            }
        }
    }
    let (first, last) = span?;
    (last > first).then_some((first, last))
}

/// Whether a message row is the turn's narration: an assistant message
/// strictly between the turn's opening prompt and its final message — the
/// model's running commentary, not the answer. The prompt and the answer
/// never fold; a mid-turn user message stays visible too (it is not the
/// model's voice).
pub(crate) fn is_narration_message(session: &AgentSession, index: usize) -> bool {
    let Some(turn_id) = session.messages.get(index).and_then(|message| message.turn_id) else {
        return false;
    };
    let Some(turn) = session.turns.iter().position(|turn| turn.id == turn_id) else {
        return false;
    };
    narration_span(session, turn).is_some_and(|(first, last)| {
        index > first && index < last && session.messages[index].role == MessageRole::Assistant
    })
}

/// Whether a block row sits inside the same fold: anchored after the
/// turn's prompt and no later than its final message. A block anchored at
/// `n` renders after message `n-1`, so `n` past the final message is
/// trailing work — it followed the answer and stays visible.
pub(crate) fn is_narration_block(session: &AgentSession, block: usize) -> bool {
    let Some(block_data) = session.transcript_blocks.get(block) else {
        return false;
    };
    let Some(turn_id) = block_data.turn_id else {
        return false;
    };
    let Some(turn) = session.turns.iter().position(|turn| turn.id == turn_id) else {
        return false;
    };
    narration_span(session, turn)
        .is_some_and(|(first, last)| block_data.after_message > first && block_data.after_message <= last)
}

/// The fold's header host: the first narration row in walk order. A block
/// anchored at `n` renders after message `n-1`, so its order key sits just
/// under message `n`'s — blocks and messages interleave honestly.
pub(crate) fn narration_head(session: &AgentSession, turn: usize) -> Option<NarrationRow> {
    narration_edge(session, turn, true)
}

/// The fold's LAST row in walk order — the expanded section's closing
/// footer lands below it.
pub(crate) fn narration_tail(session: &AgentSession, turn: usize) -> Option<NarrationRow> {
    narration_edge(session, turn, false)
}

/// The fold's first (`first`) or last row in walk order. A block anchored
/// at `n` renders after message `n-1`, so its order key sits just under
/// message `n`'s — blocks and messages interleave honestly.
fn narration_edge(session: &AgentSession, turn: usize, first: bool) -> Option<NarrationRow> {
    let (first_msg, last_msg) = narration_span(session, turn)?;
    let turn_id = session.turns[turn].id;
    let mut edge: Option<(u64, NarrationRow)> = None;
    let consider = |key: u64, row: NarrationRow, edge: &mut Option<(u64, NarrationRow)>| {
        let better = edge
            .as_ref()
            .is_none_or(|(best, _)| if first { key < *best } else { key > *best });
        if better {
            *edge = Some((key, row));
        }
    };
    for index in first_msg + 1..last_msg {
        if session.messages[index].turn_id == Some(turn_id)
            && session.messages[index].role == MessageRole::Assistant
        {
            consider(index as u64 * 2 + 1, NarrationRow::Message { index }, &mut edge);
        }
    }
    for (block, block_data) in session.transcript_blocks.iter().enumerate() {
        if block_data.turn_id == Some(turn_id)
            && block_data.after_message > first_msg
            && block_data.after_message <= last_msg
        {
            consider(
                block_data.after_message as u64 * 2,
                NarrationRow::Block { index: block },
                &mut edge,
            );
        }
    }
    edge.map(|(_, row)| row)
}

/// FNV-1a offset basis and prime: cheap, order-sensitive mixing that stays
/// stable within a process (and, being FNV, across runs too).
const FINGERPRINT_SEED: u64 = 0xcbf2_9ce4_8422_2325;
const FINGERPRINT_PRIME: u64 = 0x0000_0100_0000_01b3;

const FACT_MESSAGE: u64 = 0x4d;
const FACT_ACTIVITY_GROUP: u64 = 0x47;
const FACT_TURN_FOOTER: u64 = 0x46;
const FACT_CHANGED_FILES: u64 = 0x43;
const FACT_WORKING: u64 = 0x57;

fn mix(hash: u64, value: u64) -> u64 {
    (hash ^ value).wrapping_mul(FINGERPRINT_PRIME)
}

/// Tail of an optional turn id, kept distinct from every present id's tail.
fn turn_option_tail(turn_id: Option<Uuid>) -> u64 {
    match turn_id {
        Some(turn_id) => turn_id.as_u128() as u64,
        None => u64::MAX,
    }
}
