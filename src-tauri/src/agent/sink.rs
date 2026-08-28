//! EventSink — port of `app/core/agent/event-sink.ts` onto the
//! tide-store write path. One per app (NOT per session): turn tasks `emit`
//! [`SinkEventWire`]s into an unbounded mpsc; a single flush task commits
//! every ~50ms as ONE WAL transaction ([`SessionsV2Writer::commit_batch`])
//! and forwards per-session [`FlushBatchWire`] partitions to the push
//! broadcast for subscribed (live) sessions.
//!
//! Semantics ported verbatim:
//! - **Per-session batches**: a flush partitions stamped events by session
//!   (first-event order) — the renderer's `orchestratorEvents` deliveries.
//! - **Live gating**: batches are pushed only for sessions in the live set
//!   (`events_subscribe`); delivering a persisted batch advances that
//!   session's floor to `lastSeq + 1` so `turn.end` pruning tracks
//!   consumption. Degraded (unpersisted) batches carry no watermark and do
//!   not advance the floor.
//! - **Sync-atomicity**: replay → markLive → live-flag happen under ONE
//!   writer lock with no await between (an interleaved flush could otherwise
//!   prune past a cursor that was read but never registered).
//! - **Push-only degradation**: `commit_batch` never fails — a DB error
//!   degrades the batch to unstamped events with `firstSeq`/`lastSeq` 0 and
//!   streaming continues.
//! - **Drain-on-commit**: a failed commit still consumes the buffer.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tide_store::sessions_v2_write::{
    FlushBatchWire, SessionsV2Writer, SinkEventWire, WriteBatch,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use super::events::ChatPush;

const DEFAULT_FLUSH_MS: u64 = 50;
const REPLAY_PAGE: usize = 500;

enum SinkCommand {
    Event(SinkEventWire),
    FlushNow(oneshot::Sender<()>),
}

/// Shared sink state the flush task and the handle both touch.
struct SinkShared {
    writer: Arc<StdMutex<SessionsV2Writer>>,
    live: StdMutex<HashSet<String>>,
    push_tx: broadcast::Sender<ChatPush>,
}

/// The handle turn tasks and commands use. Cloning is cheap; when the last
/// clone drops the flush task drains its buffer and exits (dispose).
pub struct EventSink {
    cmd_tx: mpsc::UnboundedSender<SinkCommand>,
    shared: Arc<SinkShared>,
    _task: tokio::task::JoinHandle<()>,
}

impl EventSink {
    /// Spawns the flush task (must be called inside a tokio runtime).
    pub fn spawn(
        writer: Arc<StdMutex<SessionsV2Writer>>,
        push_tx: broadcast::Sender<ChatPush>,
    ) -> Self {
        Self::spawn_with_flush(writer, push_tx, Duration::from_millis(DEFAULT_FLUSH_MS))
    }

    /// Test seam: same construction with an explicit flush interval.
    pub fn spawn_with_flush(
        writer: Arc<StdMutex<SessionsV2Writer>>,
        push_tx: broadcast::Sender<ChatPush>,
        flush_every: Duration,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(SinkShared {
            writer,
            live: StdMutex::new(HashSet::new()),
            push_tx,
        });
        let task = tokio::spawn(flush_loop(cmd_rx, Arc::clone(&shared), flush_every));
        Self {
            cmd_tx,
            shared,
            _task: task,
        }
    }

    /// Buffer one event; persisted and pushed at the next flush tick.
    pub fn emit(&self, event: SinkEventWire) {
        let _ = self.cmd_tx.send(SinkCommand::Event(event));
    }

    /// Force a flush and wait for it to land (tests, and the pre-turn
    /// barrier that guarantees the just-persisted user message is visible to
    /// the history reader).
    pub async fn flush(&self) {
        let (ack_tx, ack_rx) = oneshot::channel();
        if self.cmd_tx.send(SinkCommand::FlushNow(ack_tx)).is_ok() {
            let _ = ack_rx.await;
        }
    }

    /// `eventsSubscribe`: replay the session's pending events strictly after
    /// `last_seq` (paged), advance the floor past the replayed cursor, and
    /// mark the session live — under one writer lock, no await between.
    pub fn subscribe_session(&self, session_id: &str, last_seq: Option<i64>) -> Vec<FlushBatchWire> {
        let mut writer = self.shared.writer.lock().expect("sink writer poisoned");
        let mut batches = Vec::new();
        let mut cursor = last_seq.unwrap_or(0);
        loop {
            let page = match writer.replay_events(session_id, cursor, Some(REPLAY_PAGE)) {
                Ok(page) => page,
                Err(_) => break,
            };
            if page.is_empty() {
                break;
            }
            let last = page.last().and_then(|e| e.seq).unwrap_or(cursor);
            batches.push(FlushBatchWire {
                first_seq: page.first().and_then(|e| e.seq).unwrap_or(0),
                last_seq: last,
                events: page,
            });
            cursor = last;
            if (batches.last().map(|b| b.events.len()).unwrap_or(0)) < REPLAY_PAGE {
                break;
            }
        }
        if cursor > 0 {
            writer.mark_live(session_id, cursor + 1);
        }
        drop(writer);
        self.shared
            .live
            .lock()
            .expect("sink live set poisoned")
            .insert(session_id.to_owned());
        batches
    }

    /// `eventsUnsubscribe`: a session switch must not leak pushes (the
    /// renderer stops consuming them) for the departed session.
    pub fn unsubscribe_session(&self, session_id: &str) {
        self.shared
            .live
            .lock()
            .expect("sink live set poisoned")
            .remove(session_id);
    }

    pub fn writer(&self) -> &Arc<StdMutex<SessionsV2Writer>> {
        &self.shared.writer
    }
}

async fn flush_loop(
    mut cmd_rx: mpsc::UnboundedReceiver<SinkCommand>,
    shared: Arc<SinkShared>,
    flush_every: Duration,
) {
    let mut ticker = tokio::time::interval(flush_every);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut buffer: Vec<SinkEventWire> = Vec::new();
    let mut acks: Vec<oneshot::Sender<()>> = Vec::new();
    loop {
        tokio::select! {
            maybe = cmd_rx.recv() => match maybe {
                None | Some(SinkCommand::FlushNow(_)) => {
                    // Shutdown (all handles dropped) or an explicit flush:
                    // drain the queue, flush, ack, exit only on None.
                    let shutdown = maybe.is_none();
                    drain(&mut cmd_rx, &mut buffer, &mut acks);
                    flush(&shared, &mut buffer);
                    for ack in acks.drain(..) {
                        let _ = ack.send(());
                    }
                    if shutdown {
                        break;
                    }
                }
                Some(SinkCommand::Event(event)) => buffer.push(event),
            },
            _ = ticker.tick() => {
                drain(&mut cmd_rx, &mut buffer, &mut acks);
                if !buffer.is_empty() || !acks.is_empty() {
                    flush(&shared, &mut buffer);
                    for ack in acks.drain(..) {
                        let _ = ack.send(());
                    }
                }
            }
        }
    }
}

fn drain(
    cmd_rx: &mut mpsc::UnboundedReceiver<SinkCommand>,
    buffer: &mut Vec<SinkEventWire>,
    acks: &mut Vec<oneshot::Sender<()>>,
) {
    while let Ok(cmd) = cmd_rx.try_recv() {
        match cmd {
            SinkCommand::Event(event) => buffer.push(event),
            SinkCommand::FlushNow(ack) => acks.push(ack),
        }
    }
}

/// One flush: commit the buffer in a single transaction, then per session —
/// push (live sessions only) and advance the floor past the delivered seq.
fn flush(shared: &SinkShared, buffer: &mut Vec<SinkEventWire>) {
    if buffer.is_empty() {
        return;
    }
    let events: Vec<SinkEventWire> = std::mem::take(buffer);
    let mut batch = WriteBatch::new();
    batch.extend(events);
    let outcome = {
        let writer = shared.writer.lock().expect("sink writer poisoned");
        writer.commit_batch(&mut batch, unix_ms_now())
    };
    let live = {
        let live = shared.live.lock().expect("sink live set poisoned");
        outcome
            .batches
            .iter()
            .filter(|b| {
                b.events
                    .first()
                    .map(|e| live.contains(&e.session_id))
                    .unwrap_or(false)
            })
            .map(|b| b.events[0].session_id.clone())
            .collect::<Vec<_>>()
    };
    for batch in outcome.batches {
        let session_id = batch
            .events
            .first()
            .map(|e| e.session_id.clone())
            .unwrap_or_default();
        if !live.contains(&session_id) {
            continue;
        }
        // Degraded batches (lastSeq 0) carry no watermark — skip the floor.
        if batch.last_seq > 0 {
            let mut writer = shared.writer.lock().expect("sink writer poisoned");
            writer.mark_live(&session_id, batch.last_seq + 1);
        }
        let _ = shared.push_tx.send(ChatPush::Orchestrator { batch });
    }
}

pub(crate) fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// ISO-8601 UTC with millisecond precision — the legacy wire's timestamp
/// format (`1970-01-01T00:00:04.000Z`).
pub(crate) fn iso_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Days-since-epoch → (y, m, d) — Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Chronological per-session AgentEvent seq source — the TS `seqCounters`
/// map: in-memory only, monotonic for the process lifetime.
#[derive(Default)]
pub struct SeqCounters {
    counters: StdMutex<HashMap<String, u64>>,
}

impl SeqCounters {
    pub fn next(&self, session_id: &str) -> u64 {
        let mut counters = self.counters.lock().expect("seq counters poisoned");
        let next = counters.get(session_id).copied().unwrap_or(0) + 1;
        counters.insert(session_id.to_owned(), next);
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tide_store::sessions_v2_write::{
        CreateSessionInput, InsertMessageInput, SinkEventType,
    };

    fn delta(sid: &str, mid: &str, pid: &str, text: &str) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::PartDelta,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: Some(pid.to_owned()),
            data: Some(json!({ "text": text })),
            seq: None,
        }
    }

    fn turn_end(sid: &str, mid: &str) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::TurnEnd,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: None,
            data: None,
            seq: None,
        }
    }

    struct TempDb(#[allow(dead_code)] tempfile::TempDir);

    fn temp_db(name: &str) -> (TempDb, Arc<StdMutex<SessionsV2Writer>>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("sink-{name}.db"));
        let writer = SessionsV2Writer::open(&path).unwrap();
        (TempDb(dir), Arc::new(StdMutex::new(writer)))
    }

    #[allow(clippy::type_complexity)]
    fn seeded(
        name: &str,
        sessions: &[&str],
    ) -> (TempDb, Arc<StdMutex<SessionsV2Writer>>, EventSink, broadcast::Sender<ChatPush>) {
        let (dir, writer) = temp_db(name);
        {
            let w = writer.lock().unwrap();
            for sid in sessions {
                w.create_session(
                    CreateSessionInput {
                        id: sid,
                        workspace_path: "/ws",
                        title: sid,
                        model_id: "m",
                        provider_id: None,
                        parent_id: None,
                    },
                    1_000,
                )
                .unwrap();
                w.insert_message(
                    InsertMessageInput { id: &format!("m_{sid}"), session_id: sid, role: "assistant", model: None },
                    1_000,
                )
                .unwrap();
            }
        }
        let (push_tx, _) = broadcast::channel(64);
        let sink = EventSink::spawn_with_flush(
            Arc::clone(&writer),
            push_tx.clone(),
            Duration::from_millis(10_000), // effectively never — flush() drives tests
        );
        (dir, writer, sink, push_tx)
    }

    #[tokio::test]
    async fn flush_persists_partitions_and_advances_floor_for_live_sessions() {
        let (_dir, writer, sink, push_tx) = seeded("live", &["s_a"]);
        let mut push = push_tx.subscribe();
        sink.subscribe_session("s_a", None);

        sink.emit(delta("s_a", "m_1", "p_1", "a"));
        sink.emit(delta("s_a", "m_1", "p_1", "b"));
        sink.emit(turn_end("s_a", "m_1"));
        sink.flush().await;

        let ChatPush::Orchestrator { batch } = push.try_recv().expect("batch pushed") else {
            panic!("expected orchestrator push");
        };
        assert_eq!(batch.events.len(), 3);
        assert!(batch.events.iter().all(|e| e.seq.is_some()));
        assert_eq!(batch.first_seq, 1);
        assert_eq!(batch.last_seq, 3);

        // Floor advanced past the delivered batch (lastSeq + 1 = 4): the
        // turn.end prune removed everything below it, marker stays.
        {
            let w = writer.lock().unwrap();
            assert_eq!(w.live_floor("s_a"), Some(4));
            let replay = w.replay_events("s_a", 0, None).unwrap();
            let kinds: Vec<&str> = replay.iter().map(|e| e.r#type.as_str()).collect();
            assert_eq!(kinds, ["turn.end"]);
        }
    }

    #[tokio::test]
    async fn non_live_sessions_persist_but_do_not_push_or_mark() {
        let (_dir, writer, sink, push_tx) = seeded("dead", &["s_a"]);
        let mut push = push_tx.subscribe();

        sink.emit(delta("s_a", "m_1", "p_1", "x"));
        sink.emit(turn_end("s_a", "m_1"));
        sink.flush().await;

        assert!(push.try_recv().is_err(), "no live consumer → no push");
        let w = writer.lock().unwrap();
        assert_eq!(w.live_floor("s_a"), None);
    }

    #[tokio::test]
    async fn subscribe_session_replays_pending_then_registers_live() {
        let (_dir, _writer, sink, _push_tx) = seeded("replay", &["s_a"]);
        // Turn 1 ran with no consumer: everything but the marker pruned.
        sink.emit(delta("s_a", "m_1", "p_1", "old"));
        sink.emit(turn_end("s_a", "m_1"));
        sink.flush().await;

        // Turn 2 events arrive BEFORE the consumer subscribes mid-turn.
        sink.emit(delta("s_a", "m_1", "p_2", "new"));
        sink.flush().await;

        let batches = sink.subscribe_session("s_a", Some(0));
        // Replay covers the surviving rows (turn.end marker + new delta),
        // seq-stamped and ascending.
        let all: Vec<i64> = batches
            .iter()
            .flat_map(|b| b.events.iter().filter_map(|e| e.seq))
            .collect();
        assert!(all.windows(2).all(|w| w[0] < w[1]));
        assert!(all.len() >= 2, "marker + live delta replayed: {all:?}");
    }

    #[tokio::test]
    async fn unsubscribe_stops_pushes() {
        let (_dir, _writer, sink, push_tx) = seeded("unsub", &["s_a"]);
        let mut push = push_tx.subscribe();
        sink.subscribe_session("s_a", None);
        sink.emit(delta("s_a", "m_1", "p_1", "a"));
        sink.flush().await;
        assert!(push.try_recv().is_ok());

        sink.unsubscribe_session("s_a");
        sink.emit(delta("s_a", "m_1", "p_1", "b"));
        sink.flush().await;
        assert!(push.try_recv().is_err());
    }

    #[tokio::test]
    async fn multi_session_flush_partitions_by_session() {
        let (_dir, _writer, sink, push_tx) = seeded("multi", &["s_a", "s_b"]);
        let mut push = push_tx.subscribe();
        sink.subscribe_session("s_a", None);
        sink.subscribe_session("s_b", None);

        sink.emit(delta("s_a", "m_s_a", "p_1", "a"));
        sink.emit(delta("s_b", "m_s_b", "p_1", "b"));
        sink.emit(delta("s_a", "m_s_a", "p_1", "a2"));
        sink.flush().await;

        let mut seen = Vec::new();
        while let Ok(push) = push.try_recv() {
            let ChatPush::Orchestrator { batch } = push else {
                panic!("expected orchestrator push");
            };
            let sessions: HashSet<_> =
                batch.events.iter().map(|e| e.session_id.clone()).collect();
            assert_eq!(sessions.len(), 1, "per-session partitions");
            seen.push(sessions.into_iter().next().unwrap());
        }
        assert_eq!(seen.len(), 2, "one batch per live session");
    }

    #[test]
    fn iso_ms_formats_like_the_legacy_wire() {
        assert_eq!(iso_ms(4_000), "1970-01-01T00:00:04.000Z");
        assert_eq!(iso_ms(1_759_000_000_123), "2025-09-27T19:06:40.123Z");
        assert_eq!(iso_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
