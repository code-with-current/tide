/** Provider-API usage reports (CodexBar-style): fetch real limits/usage
 *  straight from the provider's own quota endpoints using the stored API
 *  key — z.ai's monitor API and OpenRouter's key API today. Parsed shapes
 *  are exported pure for tests; the dispatcher matches providers by their
 *  preset/baseUrl and returns null for providers without an API (the UI
 *  then falls back to locally-metered windows). */

import { matchPresetByBaseUrl } from '../../src/lib/provider-presets.js';
import type { Provider } from '../../src/types';

export interface UsageWindow {
  label: string;
  /** Percent used, 0-100 — every provider reports this even when absolute
   *  numbers are absent. */
  percent: number;
  /** Used amount in the window's unit. */
  used?: number;
  /** Total allowance in the window's unit (null/undefined = unlimited). */
  limit?: number;
  unit: 'tokens' | 'USD' | 'credits';
  /** Epoch ms when the window resets, when the provider reports it. */
  resetsAt?: number;
}

export interface ProviderUsageReport {
  source: 'zai' | 'openrouter';
  planName?: string;
  windows: UsageWindow[];
}

// ─── z.ai ───────────────────────────────────────────────────────────────
// GET https://api.z.ai/api/monitor/usage/quota/limit (Bearer)
// { success, code, msg, data: { planName?, limits: [...] } }
// limit entry: { type: TOKENS_LIMIT|TIME_LIMIT|CREDIT_LIMIT, unit, number,
//   percentage, usage?, currentValue?, remaining?, nextResetTime? }
// `usage` is the ALLOWANCE (confusingly named); unit enum maps to minutes.

const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };

function windowLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) return '5 hours';
  if (windowMinutes === null) return 'window';
  if (windowMinutes % 10080 === 0) return `${windowMinutes / 10080} week${windowMinutes > 10080 ? 's' : ''}`;
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440} day${windowMinutes > 1440 ? 's' : ''}`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60} hour${windowMinutes > 60 ? 's' : ''}`;
  return `${windowMinutes}m`;
}

export function parseZaiQuota(json: unknown): ProviderUsageReport | null {
  const root = json as {
    success?: boolean; code?: number; msg?: string;
    data?: { planName?: string; plan?: string; plan_type?: string; packageName?: string; level?: string; limits?: unknown[] };
  };
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  if (root.success !== true || root.code !== 200 || !root.data || !Array.isArray(root.data.limits)) return null;
  const planName = [root.data.planName, root.data.plan, root.data.plan_type, root.data.packageName, root.data.level]
    .find((v): v is string => typeof v === 'string' && v.length > 0);

  const windows: UsageWindow[] = [];
  for (const raw of root.data.limits) {
    const e = raw as {
      type?: string; unit?: number; number?: number; percentage?: number;
      usage?: number | null; currentValue?: number | null; remaining?: number | null;
      nextResetTime?: number | null;
    };
    if (!e || typeof e.type !== 'string' || typeof e.unit !== 'number' || typeof e.number !== 'number' || typeof e.percentage !== 'number') continue;

    let percent = e.percentage;
    const allowance = typeof e.usage === 'number' ? e.usage : null;
    const current = typeof e.currentValue === 'number' ? e.currentValue : null;
    const remaining = typeof e.remaining === 'number' ? e.remaining : null;
    if (allowance !== null && allowance > 0) {
      let used: number | null = null;
      if (remaining !== null) used = Math.max(allowance - remaining, current ?? allowance - remaining);
      else if (current !== null) used = current;
      if (used !== null) percent = Math.max(0, Math.min(100, (used / allowance) * 100));
    }

    const windowMinutes = e.number > 0 && ZAI_UNIT_MINUTES[e.unit]
      ? e.number * ZAI_UNIT_MINUTES[e.unit]
      : null;

    if (e.type === 'TOKENS_LIMIT') {
      windows.push({
        label: windowLabel(windowMinutes),
        percent,
        used: current ?? (remaining !== null && allowance !== null ? allowance - remaining : undefined) ?? undefined,
        limit: allowance ?? undefined,
        unit: 'tokens',
        ...(typeof e.nextResetTime === 'number' && e.nextResetTime > 0 ? { resetsAt: e.nextResetTime } : {}),
      });
    } else if (e.type === 'TIME_LIMIT') {
      // The MCP lane — minutes of tool-server time, not model tokens.
      windows.push({
        label: 'MCP time',
        percent,
        limit: allowance ?? undefined,
        unit: 'credits',
        ...(typeof e.nextResetTime === 'number' && e.nextResetTime > 0 ? { resetsAt: e.nextResetTime } : {}),
      });
    }
    // CREDIT_LIMIT: credit-denominated plans; surface as a credits window.
    if (e.type === 'CREDIT_LIMIT') {
      windows.push({
        label: windowLabel(windowMinutes),
        percent,
        used: current ?? undefined,
        limit: allowance ?? undefined,
        unit: 'credits',
        ...(typeof e.nextResetTime === 'number' && e.nextResetTime > 0 ? { resetsAt: e.nextResetTime } : {}),
      });
    }
  }

  // Shortest window first — the 5-hour window is the primary meter.
  windows.sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));
  return windows.length > 0 ? { source: 'zai', ...(planName ? { planName } : {}), windows } : null;
}

async function fetchZaiReport(apiKey: string): Promise<ProviderUsageReport | null> {
  const res = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return parseZaiQuota(await res.json().catch(() => null));
}

// ─── OpenRouter ─────────────────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/key (Bearer) →
// { data: { usage, limit (USD, null = unlimited), rate_limit } }

export function parseOpenRouterKey(json: unknown): ProviderUsageReport | null {
  const data = (json as { data?: { usage?: number; limit?: number | null } })?.data;
  if (!data || typeof data.usage !== 'number') return null;
  return {
    source: 'openrouter',
    windows: [{
      label: 'credits',
      percent: typeof data.limit === 'number' && data.limit > 0
        ? Math.min(100, (data.usage / data.limit) * 100)
        : 0,
      used: data.usage,
      limit: data.limit ?? undefined,
      unit: 'USD',
    }],
  };
}

async function fetchOpenRouterReport(apiKey: string): Promise<ProviderUsageReport | null> {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return parseOpenRouterKey(await res.json().catch(() => null));
}

// ─── Dispatch ───────────────────────────────────────────────────────────

/** Fetch the provider-API usage report for a configured provider, or null
 *  when the provider has no usage API / the key is missing / the call
 *  fails. Never throws. */
export async function providerUsageReport(provider: Provider): Promise<ProviderUsageReport | null> {
  if (!provider.apiKey) return null;
  const preset = matchPresetByBaseUrl(provider.baseUrl);
  try {
    switch (preset?.id) {
      case 'zai': return await fetchZaiReport(provider.apiKey);
      case 'openrouter': return await fetchOpenRouterReport(provider.apiKey);
      default: return null;
    }
  } catch {
    return null;
  }
}
