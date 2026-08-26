import { describe, expect, it } from 'vitest';
import { parseZaiQuota, parseOpenRouterKey, parseDeepSeekBalance, parseFireworksSummary } from '../../app/core/agent/provider-usage';

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
    const mcp = r!.windows.find((w) => w.label === 'MCP Limit');
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

describe('parseDeepSeekBalance', () => {
  it('surfaces the USD entry as the balance window', () => {
    const r = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '100.00', granted_balance: '0', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '5.25', granted_balance: '0.25', topped_up_balance: '5.00' },
      ],
    });
    expect(r!.windows[0]).toMatchObject({ label: 'balance', used: 5.25, unit: 'USD' });
    expect(r!.windows[0].percent).toBeUndefined();
  });

  it('falls back to the first currency when no USD', () => {
    const r = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.00' }],
    });
    expect(r!.windows[0].label).toBe('balance (CNY)');
  });

  it('rejects malformed payloads', () => {
    expect(parseDeepSeekBalance({})).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: 'x' }] })).toBeNull();
  });
});

describe('parseFireworksSummary', () => {
  it('sums rated line items (units + nanos/1e9) into 30-day spend', () => {
    const r = parseFireworksSummary({
      lineItems: [
        { cost: { units: '0', nanos: '300000000', currencyCode: 'USD' } },
        { cost: { units: '1', nanos: 250000000, currencyCode: 'USD' } },
      ],
    }, 'acct-1');
    expect(r!.windows[0]).toMatchObject({ label: '30-day spend', used: 1.55, unit: 'USD' });
    expect(r!.planName).toBe('acct-1');
  });

  it('empty line items are valid zero spend', () => {
    const r = parseFireworksSummary({ lineItems: [] }, 'acct');
    expect(r!.windows[0].used).toBe(0);
  });

  it('rejects payloads without lineItems', () => {
    expect(parseFireworksSummary({}, 'acct')).toBeNull();
  });
});
