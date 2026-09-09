//! Perf gate for the sessions-v2 read paths — successor to the old
//! `scripts/perf-gate-v2.mjs`. Runs as a normal test (CI-enforced via
//! `cargo test --workspace` in ci.yml's rust job).
//!
//! Seeds a synthetic db with the writer's own schema (`sessions_v2_write::
//! SCHEMA` — no drift possible): one workspace holding a 500-message session
//! (2–3 parts per message, mixed text/thinking/tool kinds, ~200–800-char
//! payloads) plus 5 sibling sessions, then gates the three hot read paths:
//!
//!   1. `list_sessions` first page (default limit 50)      — old budget 10 ms
//!   2. `session_messages` first 200-window (max window)   — old budget 25 ms
//!      at 50 messages; 200 is 4x the rows, so 25 -> 100 ms
//!   3. `list_session_headers` (legacy sidebar shape, per-session COUNT) —
//!      no old number; sized like the window query it shares work with
//!
//! Budgets carry 3x CI-runner headroom over the old local-machine numbers
//! (30 ms / 300 ms / 100 ms). Timing methodology matches the old script:
//! one warm-up run (statement compile + page cache), then best of 5.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use rusqlite::{params, Connection};
use store::sessions_v2::{SessionListOptsV2, SessionWindowOptsV2, SessionsV2};
use store::sessions_v2_write::SCHEMA;

const WORKSPACE: &str = "/home/dev/projects/demo-app";
const MAIN_SESSION: &str = "s_perf_main";
const MESSAGE_COUNT: usize = 500;
const SIBLING_SESSIONS: usize = 5;
const WINDOW_SIZE: usize = 200;

const LIST_BUDGET_MS: u128 = 30;
const WINDOW_BUDGET_MS: u128 = 300;
const HEADERS_BUDGET_MS: u128 = 100;
const RUNS: usize = 5;

/// Zero-padded decimal keeps ids chronologically sortable as plain text —
/// the ordering contract the window cursors rely on (writer ids are
/// time-prefixed base36 for the same reason).
fn message_id(i: usize) -> String {
    format!("m_{i:08}_perf")
}

fn text_payload(repeat: usize) -> String {
    serde_json::json!({
        "text": "lorem ipsum dolor sit amet, consectetur adipiscing elit — ".repeat(repeat),
    })
    .to_string()
}

fn thinking_payload() -> String {
    serde_json::json!({
        "text": "the request touches several files, plan before editing. ".repeat(4),
    })
    .to_string()
}

fn tool_payload(i: usize) -> String {
    serde_json::json!({
        "toolName": "bash",
        "input": { "command": format!("cargo test -p store --lib {}", i % 97) },
        "output": "   Compiling store v0.4.0\n    Finished dev profile\n".repeat(11),
        "status": "completed",
        "durationMs": 1_200 + (i % 800),
    })
    .to_string()
}

struct TempDb {
    dir: PathBuf,
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn seed() -> TempDb {
    let dir = std::env::temp_dir().join(format!("store-perf-gate-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("sessions-v2.db");

    let conn = Connection::open(&db_path).unwrap();
    let _: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();

    let t0: i64 = 1_700_000_000_000;

    // One transaction for the whole seed, like the old script's db.transaction.
    conn.execute_batch("BEGIN").unwrap();
    {
        let mut insert_session = conn
            .prepare(
                "INSERT INTO session (id, workspace_path, parent_id, title, model_id, provider_id, \
                 time_created, time_updated) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
            )
            .unwrap();
        let mut insert_message = conn
            .prepare(
                "INSERT INTO message (id, session_id, role, model, time_created, time_completed) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .unwrap();
        let mut insert_part = conn
            .prepare(
                "INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            )
            .unwrap();

        insert_session
            .execute(params![
                MAIN_SESSION,
                WORKSPACE,
                "Perf gate main session",
                "test-model",
                "test-provider",
                t0,
                t0
            ])
            .unwrap();
        for i in 0..MESSAGE_COUNT {
            let id = message_id(i);
            let t = t0 + i as i64;
            let is_user = i % 2 == 0;
            insert_message
                .execute(params![
                    id,
                    MAIN_SESSION,
                    if is_user { "user" } else { "assistant" },
                    if is_user { None } else { Some("test-model") },
                    t,
                    if is_user { None } else { Some(t + 500) },
                ])
                .unwrap();

            // 2–3 parts per message, mixed kinds, ~200–800 chars each.
            let mut seq: i64 = 0;
            let mut part = |kind: &str, data: String| {
                insert_part
                    .execute(params![
                        format!("p_{i}_{seq}"),
                        id,
                        MAIN_SESSION,
                        seq,
                        kind,
                        data,
                        t
                    ])
                    .unwrap();
                seq += 1;
            };
            if is_user {
                part("text", text_payload(4));
                part("text", text_payload(3));
            } else if i % 4 == 0 {
                part("thinking", thinking_payload());
                part("text", text_payload(6));
                part("tool", tool_payload(i));
            } else {
                part("text", text_payload(6));
                part("tool", tool_payload(i));
            }
        }
        for i in 0..SIBLING_SESSIONS {
            insert_session
                .execute(params![
                    format!("s_sibling_{i}"),
                    WORKSPACE,
                    format!("Sibling session {i}"),
                    "test-model",
                    "test-provider",
                    t0 + 10_000 + i as i64,
                    t0 + 10_000 + i as i64,
                ])
                .unwrap();
        }
    }
    conn.execute_batch("COMMIT").unwrap();

    // WAL checkpoint so the read-only handle measures steady-state page reads,
    // not WAL growth from the seed.
    conn.pragma_update(None, "wal_checkpoint(TRUNCATE)", "")
        .ok();
    drop(conn);
    TempDb { dir }
}

fn measure(label: &str, budget_ms: u128, mut f: impl FnMut()) {
    f(); // warm-up — discards cold-start noise (statement compile, page cache)
    let mut best = f64::INFINITY;
    for run in 1..=RUNS {
        let start = Instant::now();
        f();
        let elapsed = start.elapsed().as_secs_f64() * 1_000.0;
        println!("  {label} run {run}: {elapsed:.3} ms");
        best = best.min(elapsed);
    }
    println!("{label} — budget {budget_ms} ms, best of {RUNS}: {best:.3} ms");
    assert!(
        best < budget_ms as f64,
        "{label}: best of {RUNS} was {best:.3} ms, budget is {budget_ms} ms"
    );
}

#[test]
fn perf_gate_list_and_window_at_500_messages() {
    let db = seed();
    let store = SessionsV2::open(db.dir.join("sessions-v2.db")).unwrap();

    // Sanity: the gate must exercise real data, not pass vacuously.
    let page = store
        .list_sessions(WORKSPACE, SessionListOptsV2::default())
        .unwrap();
    assert_eq!(page.sessions.len(), 1 + SIBLING_SESSIONS);
    assert_eq!(page.next_cursor, None, "6 sessions fit one default page");
    let window = store
        .session_messages(
            MAIN_SESSION,
            SessionWindowOptsV2 {
                limit: Some(WINDOW_SIZE),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(window.messages.len(), WINDOW_SIZE);
    assert!(window
        .messages
        .iter()
        .all(|m| (2..=3).contains(&m.parts.len())));
    assert_eq!(
        window.next_before,
        Some(message_id(MESSAGE_COUNT - WINDOW_SIZE))
    );
    let headers = store.list_session_headers(WORKSPACE, "ws_perf").unwrap();
    assert_eq!(headers.len(), 1 + SIBLING_SESSIONS);
    assert_eq!(
        headers
            .iter()
            .find(|h| h.id == MAIN_SESSION)
            .unwrap()
            .message_count,
        MESSAGE_COUNT as i64
    );
    println!(
        "perf gate: {} sessions, {} messages, {} parts in the main session",
        1 + SIBLING_SESSIONS,
        MESSAGE_COUNT,
        MESSAGE_COUNT / 2 * 2 + MESSAGE_COUNT / 4 * 3 + MESSAGE_COUNT / 4 * 2,
    );

    measure("gate 1: list_sessions (first page)", LIST_BUDGET_MS, || {
        let page = store
            .list_sessions(WORKSPACE, SessionListOptsV2::default())
            .unwrap();
        assert_eq!(page.sessions.len(), 6);
    });

    measure(
        "gate 2: session_messages (first 200-message window)",
        WINDOW_BUDGET_MS,
        || {
            let page = store
                .session_messages(
                    MAIN_SESSION,
                    SessionWindowOptsV2 {
                        limit: Some(WINDOW_SIZE),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(page.messages.len(), WINDOW_SIZE);
        },
    );

    measure(
        "gate 3: list_session_headers (legacy sidebar)",
        HEADERS_BUDGET_MS,
        || {
            let headers = store.list_session_headers(WORKSPACE, "ws_perf").unwrap();
            assert_eq!(headers.len(), 6);
        },
    );
}
