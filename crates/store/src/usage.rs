//! Provider token-window tracking — the port of
//! `app/core/agent/usage-windows.ts`. Claude-style rolling usage
//! windows (5-hour, weekly) per provider: one `usage_event` row per turn
//! (time, provider, model, workspace, token classes, cost), summed over the
//! window for metering against user-configured limits. The same rows are
//! the Settings → Usage ledger: per-provider, per-model historical stats.
//! WAL sqlite in the app data dir (`usage.db`); rows older than the
//! 12-month reporting window + slack are pruned on write, so the table
//! stays small.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub const FIVE_HOUR_MS: i64 = 5 * 60 * 60 * 1000;
pub const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The Usage page's monthly view covers 12 calendar months; keep rows
/// beyond that (plus slack) so the report window never clips.
const HISTORY_MS: i64 = 372 * 24 * 60 * 60 * 1000;

/// The billable token classes the orchestrator reports at turn end.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageDelta {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
}

/// All billable token classes summed — a conservative "tokens processed"
/// figure. Reasoning is already inside output on most providers; including
/// it separately only double-counts when the provider reports both, so it
/// is deliberately excluded (TS `windowTokens`).
pub fn window_tokens(u: &UsageDelta) -> i64 {
    u.input_tokens + u.output_tokens + u.cache_read + u.cache_write
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowUsage {
    /// Summed tokens within the window.
    pub tokens: i64,
    /// Time of the OLDEST contributing event — the window starts draining
    /// at oldest_at + window_ms. 0 when there are no events.
    pub oldest_at: i64,
    /// Time of the NEWEST contributing event — usage drops to zero at
    /// newest_at + window_ms. 0 when there are no events.
    pub newest_at: i64,
}

/// One recorded turn, as the Usage report reads it back.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageEvent {
    pub time_ms: i64,
    pub provider_id: String,
    pub model: String,
    pub workspace: String,
    pub session: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
}

pub fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const USAGE_EVENT_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS usage_event (
    time INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    session TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_provider_time ON usage_event(provider_id, time);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_event(time);";

fn open_db(data_dir: &Path) -> rusqlite::Result<Connection> {
    let _ = std::fs::create_dir_all(data_dir);
    let conn = Connection::open(data_dir.join("usage.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // The pre-ledger shape (time, provider_id, tokens, cost) never had a
    // writer — nothing was ever recorded into it — so an old table is
    // dropped rather than altered: the leftover `tokens` column would
    // otherwise shadow the per-class sums forever.
    let legacy = conn
        .query_row("SELECT COUNT(*) = 1 FROM pragma_table_info('usage_event') WHERE name = 'model'", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        == 0
        && conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('usage_event') WHERE name = 'tokens'", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            > 0;    if legacy {
        conn.execute_batch("DROP TABLE usage_event;")?;
    }
    conn.execute_batch(USAGE_EVENT_SCHEMA)?;
    Ok(conn)
}

/// Record a turn's usage against its provider and model, and prune rows
/// that can no longer fall inside any window. Zero-token/zero-cost turns
/// write nothing.
pub fn record_provider_usage(
    data_dir: &Path,
    provider_id: &str,
    model: &str,
    workspace: &str,
    session: &str,
    usage: &UsageDelta,
    now: i64,
) -> rusqlite::Result<()> {
    let tokens = window_tokens(usage);
    if tokens <= 0 && usage.cost_usd <= 0.0 {
        return Ok(());
    }
    let conn = open_db(data_dir)?;
    conn.execute(
        "INSERT INTO usage_event (time, provider_id, model, workspace, session, \
         input_tokens, output_tokens, cache_read, cache_write, reasoning_tokens, cost) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            now,
            provider_id,
            model,
            workspace,
            session,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read,
            usage.cache_write,
            usage.reasoning_tokens,
            usage.cost_usd
        ],
    )?;
    conn.execute(
        "DELETE FROM usage_event WHERE time < ?1",
        rusqlite::params![now - HISTORY_MS],
    )?;
    Ok(())
}

/// Sum a provider's usage over the rolling window ending now.
pub fn provider_window_usage(
    data_dir: &Path,
    provider_id: &str,
    window_ms: i64,
    now: i64,
) -> WindowUsage {
    let Ok(conn) = open_db(data_dir) else {
        return WindowUsage::default();
    };
    conn.query_row(
        "SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) AS tokens, \
         COALESCE(MIN(time), 0) AS oldest, \
         COALESCE(MAX(time), 0) AS newest FROM usage_event WHERE provider_id = ?1 AND time >= ?2",
        rusqlite::params![provider_id, now - window_ms],
        |row| {
            Ok(WindowUsage {
                tokens: row.get(0)?,
                oldest_at: row.get(1)?,
                newest_at: row.get(2)?,
            })
        },
    )
    .unwrap_or_default()
}

/// Every recorded turn from `since_ms` on, oldest first — the Usage
/// report's raw material. The table holds at most one row per turn and is
/// pruned to the reporting horizon, so this stays a small, bounded read.
pub fn fetch_usage_events(data_dir: &Path, since_ms: i64) -> Vec<UsageEvent> {
    let Ok(conn) = open_db(data_dir) else {
        return Vec::new();
    };
    let Ok(mut statement) = conn.prepare(
        "SELECT time, provider_id, model, workspace, session, input_tokens, output_tokens, \
         cache_read, cache_write, reasoning_tokens, cost \
         FROM usage_event WHERE time >= ?1 ORDER BY time",
    ) else {
        return Vec::new();
    };
    let rows = statement.query_map(rusqlite::params![since_ms], |row| {
        Ok(UsageEvent {
            time_ms: row.get(0)?,
            provider_id: row.get(1)?,
            model: row.get(2)?,
            workspace: row.get(3)?,
            session: row.get(4)?,
            input_tokens: row.get(5)?,
            output_tokens: row.get(6)?,
            cache_read: row.get(7)?,
            cache_write: row.get(8)?,
            reasoning_tokens: row.get(9)?,
            cost_usd: row.get(10)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn delta(input: i64) -> UsageDelta {
        UsageDelta {
            input_tokens: input,
            ..UsageDelta::default()
        }
    }

    #[test]
    fn window_tokens_sums_billable_classes_excluding_reasoning() {
        let delta = UsageDelta {
            input_tokens: 100,
            output_tokens: 20,
            cache_read: 5,
            cache_write: 5,
            reasoning_tokens: 40,
            cost_usd: 0.01,
        };
        assert_eq!(window_tokens(&delta), 130);
    }

    #[test]
    fn record_then_window_sums_only_recent_rows() {
        let dir = temp_dir("windows");
        let now = 1_000_000_000_000i64;
        record_provider_usage(
            &dir, "p_1", "m-a", "/w", "s1", &delta(1_000), now - 6 * 60 * 60 * 1000,
        )
        .unwrap();
        record_provider_usage(&dir, "p_1", "m-b", "/w", "s1", &delta(1_000), now - 60_000)
            .unwrap();
        record_provider_usage(&dir, "p_2", "m-a", "/w", "s2", &delta(1_000), now - 60_000)
            .unwrap();

        let five = provider_window_usage(&dir, "p_1", FIVE_HOUR_MS, now);
        assert_eq!(five.tokens, 1_000, "the 6h-old row fell out of the window");
        assert_eq!(five.newest_at, now - 60_000);

        let week = provider_window_usage(&dir, "p_1", WEEK_MS, now);
        assert_eq!(week.tokens, 2_000);
        assert_eq!(week.oldest_at, now - 6 * 60 * 60 * 1000);

        // Other providers never leak in; absent providers read zeroed.
        assert_eq!(
            provider_window_usage(&dir, "p_2", WEEK_MS, now).tokens,
            1_000
        );
        let empty = provider_window_usage(&dir, "p_none", WEEK_MS, now);
        assert_eq!(empty, WindowUsage::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zero_usage_writes_nothing_and_prune_drops_ancient_rows() {
        let dir = temp_dir("prune");
        let now = 1_000_000_000_000i64;
        record_provider_usage(&dir, "p_1", "m-a", "/w", "s1", &UsageDelta::default(), now)
            .unwrap();
        assert_eq!(provider_window_usage(&dir, "p_1", WEEK_MS, now).tokens, 0);

        record_provider_usage(&dir, "p_1", "m-a", "/w", "s1", &delta(10), now - HISTORY_MS - 1)
            .unwrap();
        // The prune runs on write: recording a fresh row drops the ancient one.
        record_provider_usage(&dir, "p_1", "m-a", "/w", "s1", &delta(10), now).unwrap();
        assert_eq!(provider_window_usage(&dir, "p_1", WEEK_MS, now).tokens, 10);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fetch_reads_recorded_columns_in_time_order() {
        let dir = temp_dir("fetch");
        let now = 1_000_000_000_000i64;
        record_provider_usage(
            &dir,
            "p_1",
            "m-a",
            "/w1",
            "s1",
            &UsageDelta {
                input_tokens: 100,
                output_tokens: 20,
                cache_read: 5,
                cache_write: 5,
                reasoning_tokens: 40,
                cost_usd: 0.01,
            },
            now - 60_000,
        )
        .unwrap();
        record_provider_usage(&dir, "p_1", "m-b", "/w1", "s1", &delta(50), now).unwrap();

        let events = fetch_usage_events(&dir, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].model, "m-a");
        assert_eq!(events[0].workspace, "/w1");
        assert_eq!(events[0].session, "s1");
        assert_eq!(events[0].reasoning_tokens, 40);
        assert_eq!(events[0].cost_usd, 0.01);
        assert_eq!(events[1].time_ms, now);

        // The window floor clips old rows.
        assert_eq!(fetch_usage_events(&dir, now - 30_000).len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_tokens_table_is_replaced_not_altered() {
        let dir = temp_dir("legacy");
        let conn = Connection::open(dir.join("usage.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_event (
                time INTEGER NOT NULL,
                provider_id TEXT NOT NULL,
                tokens INTEGER NOT NULL,
                cost REAL NOT NULL DEFAULT 0
            );
            INSERT INTO usage_event (time, provider_id, tokens, cost)
                VALUES (1, 'p_1', 10, 0.0);",
        )
        .unwrap();
        drop(conn);

        // The next open rebuilds the ledger shape and the stale row is gone.
        let now = 1_000_000_000_000i64;
        record_provider_usage(&dir, "p_1", "m-a", "/w", "s1", &delta(7), now).unwrap();
        let events = fetch_usage_events(&dir, 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 7);
        fs::remove_dir_all(&dir).unwrap();
    }
}
