//! Provider token-window tracking — the port of
//! `app/core/agent/usage-windows.ts`. Claude-style rolling usage
//! windows (5-hour, weekly) per provider: one `usage_event` row per turn
//! (time, provider_id, tokens, cost), summed over the window for metering
//! against user-configured limits. WAL sqlite in the app data dir
//! (`usage.db`); rows older than the longest window + slack are pruned on
//! write, so the table stays tiny.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub const FIVE_HOUR_MS: i64 = 5 * 60 * 60 * 1000;
pub const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Longest tracked window + slack — rows older than this can never query in.
const PRUNE_MS: i64 = WEEK_MS + 24 * 60 * 60 * 1000;

/// The billable token classes the orchestrator reports at turn end.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageDelta {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
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

pub fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_db(data_dir: &Path) -> rusqlite::Result<Connection> {
    let _ = std::fs::create_dir_all(data_dir);
    let conn = Connection::open(data_dir.join("usage.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_event (
            time INTEGER NOT NULL,
            provider_id TEXT NOT NULL,
            tokens INTEGER NOT NULL,
            cost REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_provider_time ON usage_event(provider_id, time);",
    )?;
    Ok(conn)
}

/// Record a turn's usage against its provider and prune rows that can no
/// longer fall inside any window. Zero-token/zero-cost turns write nothing.
pub fn record_provider_usage(
    data_dir: &Path,
    provider_id: &str,
    usage: &UsageDelta,
    now: i64,
) -> rusqlite::Result<()> {
    let tokens = window_tokens(usage);
    if tokens <= 0 && usage.cost_usd <= 0.0 {
        return Ok(());
    }
    let conn = open_db(data_dir)?;
    conn.execute(
        "INSERT INTO usage_event (time, provider_id, tokens, cost) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![now, provider_id, tokens, usage.cost_usd],
    )?;
    conn.execute("DELETE FROM usage_event WHERE time < ?1", rusqlite::params![now - PRUNE_MS])?;
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
        "SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(MIN(time), 0) AS oldest, \
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

    #[test]
    fn window_tokens_sums_billable_classes_excluding_reasoning() {
        let delta = UsageDelta {
            input_tokens: 100,
            output_tokens: 20,
            cache_read: 5,
            cache_write: 5,
            cost_usd: 0.01,
        };
        assert_eq!(window_tokens(&delta), 130);
    }

    #[test]
    fn record_then_window_sums_only_recent_rows() {
        let dir = temp_dir("windows");
        let now = 1_000_000_000_000i64;
        let delta = UsageDelta {
            input_tokens: 1_000,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            cost_usd: 0.0,
        };
        record_provider_usage(&dir, "p_1", &delta, now - 6 * 60 * 60 * 1000).unwrap();
        record_provider_usage(&dir, "p_1", &delta, now - 60_000).unwrap();
        record_provider_usage(&dir, "p_2", &delta, now - 60_000).unwrap();

        let five = provider_window_usage(&dir, "p_1", FIVE_HOUR_MS, now);
        assert_eq!(five.tokens, 1_000, "the 6h-old row fell out of the window");
        assert_eq!(five.newest_at, now - 60_000);

        let week = provider_window_usage(&dir, "p_1", WEEK_MS, now);
        assert_eq!(week.tokens, 2_000);
        assert_eq!(week.oldest_at, now - 6 * 60 * 60 * 1000);

        // Other providers never leak in; absent providers read zeroed.
        assert_eq!(provider_window_usage(&dir, "p_2", WEEK_MS, now).tokens, 1_000);
        let empty = provider_window_usage(&dir, "p_none", WEEK_MS, now);
        assert_eq!(empty, WindowUsage::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zero_usage_writes_nothing_and_prune_drops_ancient_rows() {
        let dir = temp_dir("prune");
        let now = 1_000_000_000_000i64;
        record_provider_usage(&dir, "p_1", &UsageDelta::default(), now).unwrap();
        assert_eq!(provider_window_usage(&dir, "p_1", WEEK_MS, now).tokens, 0);

        let delta = UsageDelta {
            input_tokens: 10,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            cost_usd: 0.0,
        };
        record_provider_usage(&dir, "p_1", &delta, now - PRUNE_MS - 1).unwrap();
        // The prune runs on write: recording a fresh row drops the ancient one.
        record_provider_usage(&dir, "p_1", &delta, now).unwrap();
        assert_eq!(provider_window_usage(&dir, "p_1", WEEK_MS, now).tokens, 10);
        fs::remove_dir_all(&dir).unwrap();
    }
}
