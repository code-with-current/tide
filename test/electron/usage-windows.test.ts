import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  _setUsageDbForTests,
  recordProviderUsage,
  providerWindowUsage,
  windowTokens,
  FIVE_HOUR_MS,
  WEEK_MS,
} from '../../electron/agent/usage-windows';
import type { Usage } from '../../src/types';

const u = (over: Partial<Usage>): Usage => ({
  inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
  reasoningTokens: 0, calls: 0, costUsd: 0, ...over,
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-usage-'));
  _setUsageDbForTests(path.join(dir, 'usage.db'));
});
afterEach(() => {
  _setUsageDbForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('windowTokens', () => {
  it('sums billable classes, excludes reasoning (double-counted in output)', () => {
    expect(windowTokens(u({ inputTokens: 100, outputTokens: 50, cacheRead: 25, cacheWrite: 5, reasoningTokens: 999 }))).toBe(180);
  });
});

describe('providerWindowUsage — rolling windows', () => {
  it('sums events inside the window and excludes older ones', () => {
    const t0 = 1_000_000_000_000;
    recordProviderUsage('p1', u({ inputTokens: 100 }), t0);
    recordProviderUsage('p1', u({ inputTokens: 200 }), t0 + 60_000);
    recordProviderUsage('p1', u({ inputTokens: 400 }), t0 + FIVE_HOUR_MS); // first event drains out
    const now = t0 + FIVE_HOUR_MS + 1;
    const w = providerWindowUsage('p1', FIVE_HOUR_MS, now);
    // 100 drains (older than window), 200 is 1ms inside, 400 inside.
    expect(w.tokens).toBe(600);
    expect(w.oldestAt).toBe(t0 + 60_000);
    expect(w.newestAt).toBe(t0 + FIVE_HOUR_MS);
  });

  it('weekly window keeps events the 5-hour window dropped', () => {
    const t0 = 2_000_000_000_000;
    recordProviderUsage('p1', u({ inputTokens: 100 }), t0);
    const now = t0 + FIVE_HOUR_MS + 1;
    expect(providerWindowUsage('p1', FIVE_HOUR_MS, now).tokens).toBe(0);
    expect(providerWindowUsage('p1', WEEK_MS, now).tokens).toBe(100);
  });

  it('providers are isolated and empty windows are zeroed', () => {
    recordProviderUsage('a', u({ inputTokens: 50 }));
    expect(providerWindowUsage('b', WEEK_MS).tokens).toBe(0);
    expect(providerWindowUsage('b', WEEK_MS).oldestAt).toBe(0);
  });

  it('prunes rows older than the longest window on write', () => {
    const t0 = 3_000_000_000_000;
    recordProviderUsage('p', u({ inputTokens: 10 }), t0);
    const now = t0 + WEEK_MS + 2 * 24 * 60 * 60 * 1000;
    recordProviderUsage('p', u({ inputTokens: 20 }), now);
    // The ancient row is gone even from the weekly window.
    expect(providerWindowUsage('p', WEEK_MS, now).tokens).toBe(20);
  });

  it('ignores zero-usage events', () => {
    recordProviderUsage('p', u({}));
    expect(providerWindowUsage('p', WEEK_MS).tokens).toBe(0);
  });
});
