import { describe, expect, it } from 'vitest';
import { parseZaiQuota, parseOpenRouterKey } from '../../electron/agent/provider-usage';

const zaiPayload = (limits: unknown[], planName = 'GLM Coding Plan') => ({
  success: true,
  code: 200,
  msg: '',
  data: { planName, limits },
});

const TOKENS_5H = {
  type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40,
  usage: 120000, currentValue: 48000, remaining: 72000,
  nextResetTime: 1_800_000_000_000,
};
const TOKENS_WEEK = {
  type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 65,
  usage: 1000000, currentValue: 650000, remaining: 350000,
  nextResetTime: 1_850_000_000_000,
};

describe('parseZaiQuota', () => {
  it('parses 5-hour + weekly TOKENS_LIMIT windows with used/limit and reset', () => {
    const r = parseZaiQuota(zaiPayload([TOKENS_5H, TOKENS_WEEK]));
    expect(r).not.toBeNull();
    expect(r!.planName).toBe('GLM Coding Plan');
    const w5 = r!.windows.find((w) => w.label === '5 hours');
    expect(w5).toMatchObject({ percent: 40, used: 48000, limit: 120000, unit: 'tokens', resetsAt: 1_800_000_000_000 });
    const week = r!.windows.find((w) => w.label === '1 week');
    expect(week).toMatchObject({ percent: 65, limit: 1000000 });
  });

  it('derives percent from allowance/remaining when percentage is stale', () => {
    const r = parseZaiQuota(zaiPayload([{ ...TOKENS_5H, percentage: 0, currentValue: null, remaining: 60000 }]));
    // used = 120000-60000 = 60000 → 50%
    expect(r!.windows[0].percent).toBe(50);
  });

  it('labels the MCP TIME_LIMIT lane separately', () => {
    const r = parseZaiQuota(zaiPayload([
      TOKENS_5H,
      { type: 'TIME_LIMIT', unit: 1, number: 1, percentage: 10, usage: 1440, remaining: 1296, nextResetTime: 1_810_000_000_000 },
    ]));
    const mcp = r!.windows.find((w) => w.label === 'MCP time');
    expect(mcp).toMatchObject({ unit: 'credits', limit: 1440 });
  });

  it('rejects non-success envelopes and missing limits', () => {
    expect(parseZaiQuota({ success: false, code: 500, msg: 'denied' })).toBeNull();
    expect(parseZaiQuota({ success: true, code: 200, data: {} })).toBeNull();
    expect(parseZaiQuota(null)).toBeNull();
  });

  it('skips unknown limit types', () => {
    const r = parseZaiQuota(zaiPayload([{ type: 'SOMETHING_ELSE', unit: 3, number: 5, percentage: 1 }]));
    expect(r).toBeNull();
  });
});

describe('parseOpenRouterKey', () => {
  it('maps USD usage/limit to a credits window', () => {
    const r = parseOpenRouterKey({ data: { usage: 2.5, limit: 20 } });
    expect(r!.windows[0]).toMatchObject({ label: 'credits', percent: 12.5, used: 2.5, limit: 20, unit: 'USD' });
  });

  it('null limit (unlimited) shows usage with no percent bar', () => {
    const r = parseOpenRouterKey({ data: { usage: 3.2, limit: null } });
    expect(r!.windows[0].limit).toBeUndefined();
    expect(r!.windows[0].percent).toBe(0);
  });

  it('rejects malformed payloads', () => {
    expect(parseOpenRouterKey({})).toBeNull();
    expect(parseOpenRouterKey(null)).toBeNull();
  });
});
