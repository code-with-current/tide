/** Provider token-window tracking: Claude-style rolling usage windows
 *  (5-hour, weekly) per provider. Usage events are recorded at turn end by
 *  the orchestrator and summed over the window for metering against
 *  user-configured limits. Backed by a small sqlite db in the app data dir
 *  (platform driver seam, WAL) — event volume is one row per turn, so the
 *  table stays tiny; rows older than the longest window (7d + slack) are
 *  pruned on write. */

import { openDatabase, type TideDatabase } from '../../platform/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';
import { appDataDir } from '../../platform/paths.js';
import type { Usage } from '../../../src/types';

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest tracked window + slack — rows older than this can never query in. */
const PRUNE_MS = WEEK_MS + 24 * 60 * 60 * 1000;

/** All billable token classes summed — a conservative "tokens processed"
 *  figure. Reasoning is already inside output on most providers; including
 *  it separately only double-counts when the provider reports both, so it
 *  is deliberately excluded. */
export function windowTokens(u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheRead' | 'cacheWrite'>): number {
  return u.inputTokens + u.outputTokens + u.cacheRead + u.cacheWrite;
}

export interface WindowUsage {
  /** Summed tokens within the window. */
  tokens: number;
  /** Time of the OLDEST contributing event — the window starts draining
   *  at oldestAt + windowMs. 0 when there are no events. */
  oldestAt: number;
  /** Time of the NEWEST contributing event — usage drops to zero at
   *  newestAt + windowMs. 0 when there are no events. */
  newestAt: number;
}

let db: TideDatabase | null = null;

function getDb(): TideDatabase {
  if (db) return db;
  const dir = appDataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = openDatabase(path.join(dir, 'usage.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_event (
      time INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      cost REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_provider_time ON usage_event(provider_id, time);
  `);
  return db;
}

/** Test seam: point the store at a fresh temp db. */
export function _setUsageDbForTests(p: string | null): void {
  db?.close();
  db = null;
  if (p) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    db = openDatabase(p);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_event (
        time INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        cost REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_provider_time ON usage_event(provider_id, time);
    `);
  }
}

export function recordProviderUsage(providerId: string, usage: Usage, now = Date.now()): void {
  const d = getDb();
  const tokens = windowTokens(usage);
  if (tokens <= 0 && usage.costUsd <= 0) return;
  d.prepare('INSERT INTO usage_event (time, provider_id, tokens, cost) VALUES (?, ?, ?, ?)')
    .run(now, providerId, tokens, usage.costUsd);
  d.prepare('DELETE FROM usage_event WHERE time < ?').run(now - PRUNE_MS);
}

export function providerWindowUsage(providerId: string, windowMs: number, now = Date.now()): WindowUsage {
  const d = getDb();
  const row = d.prepare(
    'SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(MIN(time), 0) AS oldest, COALESCE(MAX(time), 0) AS newest FROM usage_event WHERE provider_id = ? AND time >= ?',
  ).get(providerId, now - windowMs) as { tokens: number; oldest: number; newest: number } | undefined;
  return { tokens: row?.tokens ?? 0, oldestAt: row?.oldest ?? 0, newestAt: row?.newest ?? 0 };
}
