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

    // A settled turn closes after its final row — answer text or trailing
    // activity, whichever came last — with a footer, plus a file-change
    // summary when the turn's work edited files.
    let mut last_row_by_turn: HashMap<usize, usize> = HashMap::new();
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
        if session.turns[turn].status != TurnStatus::Running {
            // Facts arrive in order, so the last insert per turn wins.
            last_row_by_turn.insert(turn, fact_index);
        }
    }
    let footer_after: HashMap<usize, usize> = last_row_by_turn
        .into_iter()
        .map(|(turn, fact_index)| (fact_index, turn))
        .collect();

    let mut with_footers = Vec::with_capacity(facts.len() + footer_after.len() * 2);
    for (fact_index, fact) in facts.into_iter().enumerate() {
        with_footers.push(fact);
        if let Some(&turn) = footer_after.get(&fact_index) {
            let turn_data = &session.turns[turn];
            with_footers.push(RowFact::TurnFooter {
                turn,
                turn_id: turn_data.id,
                status: turn_data.status,
            });
            if turn_changed_files(session, turn_data.id) {
                with_footers.push(RowFact::ChangedFiles {
                    turn,
                    turn_id: turn_data.id,
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
