/**
 * Contract-aware reasoning resolver. Maps the user's ThinkingLevel +
 * the model's reasoning contracts (from models.dev) + the active protocol
 * into a single `ReasoningInstruction` that both protocol builders consume.
 *
 * This replaces the old fixed budget map (THINKING_BUDGET) + the
 * effortFromBudget collapse that lost precision for effort-based providers.
 *
 * Resolution priority picks the best contract for the protocol:
 *  - effort + OpenAI       → send effort string directly (no precision loss)
 *  - budget_tokens + Anthropic → compute budget via clamped formula
 *  - effort + Anthropic    → adaptive thinking + effort string
 *  - budget_tokens + OpenAI → compute budget, derive effort (lossy)
 *  - toggle                → just enable, no level distinction
 *  - no contracts          → fall back to legacy fixed budget map
 */
import type { ApiStyle, ReasoningOption, ThinkingLevel } from '../../../../src/types/index.js';

/** The resolved reasoning instruction — one of these is passed to the
 *  protocol builder instead of the old `ThinkingConfig`. */
export interface ReasoningInstruction {
  contract: 'effort' | 'budget_tokens' | 'toggle';
  /** For `effort` contract: the effort string to send. */
  effort?: string;
  /** For `budget_tokens` contract: the computed token budget. */
  budgetTokens?: number;
  /** Human-readable label for the diagnostic log. */
  label: string;
}

/** ThinkingLevel → effort_ratio, matching OpenRouter's published formula. */
const EFFORT_RATIOS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  extra: 0.9,
  max: 0.95,
};

/** Legacy fixed budget map — used when the model has no contracts (backward
 *  compat for pre-enrichment or manually-entered models). */
const LEGACY_BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 512,
  low: 1_024,
  medium: 8_000,
  high: 24_000,
  extra: 48_000,
  max: 64_000,
};

/** Map ThinkingLevel to the closest effort string the model supports.
 *  If the model publishes an effort contract with specific values, snaps
 *  to the nearest supported value. Otherwise maps to a canonical string. */
function levelToEffort(
  level: Exclude<ThinkingLevel, 'off'>,
  supportedValues?: string[],
): string {
  const canonical: Record<Exclude<ThinkingLevel, 'off'>, string> = {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    extra: 'xhigh',
    max: 'max',
  };
  const target = canonical[level];

  // If the model publishes supported effort values, snap to the nearest one.
  if (supportedValues && supportedValues.length > 0) {
    const lower = supportedValues.map((v) => v.toLowerCase());
    // Exact match?
    if (lower.includes(target)) return target;
    // 'xhigh' not supported → try 'max' then 'high'
    if (target === 'xhigh') {
      if (lower.includes('max')) return 'max';
      if (lower.includes('high')) return 'high';
    }
    // 'max' not supported → try 'xhigh' then 'high'
    if (target === 'max') {
      if (lower.includes('xhigh')) return 'xhigh';
      if (lower.includes('high')) return 'high';
    }
    // Snap to the nearest supported level (walk from lowest to highest,
    // return the first one that is >= the target's rank in the standard order).
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const targetRank = order.indexOf(target);
    for (const level of order) {
      if (lower.includes(level) && order.indexOf(level) >= targetRank) {
        return level;
      }
    }
    // Target is above all supported levels → return the highest.
    for (let i = order.length - 1; i >= 0; i--) {
      if (lower.includes(order[i])) return order[i];
    }
    return lower[lower.length - 1];
  }

  return target;
}

/** Compute a token budget from a ThinkingLevel using the clamped formula.
 *  budget = min(max(maxOutput × ratio, 1024), maxOutput − 1024)
 *  The upper clamp guarantees at least 1024 tokens for the response,
 *  preventing the API error when budget ≥ max_tokens. */
function computeBudgetTokens(
  level: Exclude<ThinkingLevel, 'off'>,
  maxOutputTokens: number,
): number {
  const ratio = EFFORT_RATIOS[level];
  const raw = Math.floor(maxOutputTokens * ratio);
  const floored = Math.max(raw, 1024);
  // Upper clamp: leave at least 1024 tokens for the response.
  const ceiling = Math.max(maxOutputTokens - 1024, 1024);
  return Math.min(floored, ceiling);
}

/** Derive an effort string from a token budget (lossy inverse of the formula).
 *  Used when a budget_tokens contract model is served via an effort-only
 *  protocol (e.g. OpenAI-compatible). */
export function budgetToEffort(budget: number): string {
  if (budget >= 48_000) return 'max';
  if (budget >= 24_000) return 'high';
  if (budget >= 8_000) return 'medium';
  return 'low';
}

/** Does the model have an `effort` contract? */
function hasEffort(contracts: ReasoningOption[]): ReasoningOption | undefined {
  return contracts.find((c) => c.type === 'effort');
}

/** Does the model have a `budget_tokens` contract? */
function hasBudget(contracts: ReasoningOption[]): ReasoningOption | undefined {
  return contracts.find((c) => c.type === 'budget_tokens');
}

/** Does the model have a `toggle` contract? */
function hasToggle(contracts: ReasoningOption[]): boolean {
  return contracts.some((c) => c.type === 'toggle');
}

/** Resolve a ThinkingLevel + contracts + protocol into a wire-format instruction.
 *
 *  The resolution picks the best contract for the active protocol:
 *  - For OpenAI protocol: prefer `effort` (sends the string directly, no
 *    precision loss). If only `budget_tokens` is available, compute the
 *    budget then derive an effort string (lossy but correct degradation).
 *  - For Anthropic protocol: prefer `budget_tokens` (native thinking block).
 *    If only `effort` is available, use adaptive thinking + effort.
 *  - For `toggle`-only models: just enable thinking, no level distinction.
 *  - If no contracts: fall back to the legacy fixed budget map.
 *
 *  Returns null when thinkingLevel is 'off'. */
export function resolveReasoning(
  thinkingLevel: ThinkingLevel,
  contracts: ReasoningOption[] | undefined,
  apiStyle: ApiStyle,
  maxOutputTokens: number,
): ReasoningInstruction | null {
  if (thinkingLevel === 'off') {
    // Models that publish 'none' as an effort value (gpt-5.1+) expect an
    // explicit reasoning_effort='none' — omitting the param leaves the
    // provider default active, so 'off' would silently still reason.
    const noneContract = contracts?.find((c) => c.type === 'effort');
    if (apiStyle === 'openai' && noneContract?.values?.some((v) => v.toLowerCase() === 'none')) {
      return { contract: 'effort', effort: 'none', label: 'reasoning_effort=none (explicit off)' };
    }
    return null;
  }

  const level = thinkingLevel;

  // No contracts → legacy fixed budget map (backward compat).
  if (!contracts || contracts.length === 0) {
    const budgetTokens = LEGACY_BUDGET[level];
    return {
      contract: 'budget_tokens',
      budgetTokens,
      label: `budget_tokens=${budgetTokens} (legacy, no contracts)`,
    };
  }

  const effortContract = hasEffort(contracts);
  const budgetContract = hasBudget(contracts);
  const toggleOnly = !effortContract && !budgetContract && hasToggle(contracts);

  // Toggle-only model: enable thinking, no level control.
  if (toggleOnly) {
    return {
      contract: 'toggle',
      label: `thinking=on (toggle-only, level=${level} ignored)`,
    };
  }

  if (apiStyle === 'openai') {
    // OpenAI protocol: prefer effort (no precision loss).
    if (effortContract) {
      const effort = levelToEffort(level, effortContract.values);
      return {
        contract: 'effort',
        effort,
        label: `reasoning_effort=${effort}`,
      };
    }
    // Only budget_tokens available: compute budget, derive effort.
    if (budgetContract) {
      const budgetTokens = computeBudgetTokens(level, maxOutputTokens);
      const effort = budgetToEffort(budgetTokens);
      return {
        contract: 'effort',
        effort,
        budgetTokens,
        label: `reasoning_effort=${effort} (derived from budget=${budgetTokens})`,
      };
    }
  }

  if (apiStyle === 'anthropic') {
    // Anthropic protocol: prefer budget_tokens (native thinking block).
    if (budgetContract) {
      const budgetTokens = computeBudgetTokens(level, maxOutputTokens);
      return {
        contract: 'budget_tokens',
        budgetTokens,
        label: `thinking.budget_tokens=${budgetTokens}`,
      };
    }
    // Only effort available: adaptive thinking + effort string.
    if (effortContract) {
      const effort = levelToEffort(level, effortContract.values);
      return {
        contract: 'effort',
        effort,
        label: `thinking.adaptive effort=${effort}`,
      };
    }
  }

  // Cross-protocol fallback: if we have effort and landed here (shouldn't
  // normally happen since both branches above cover it), send effort.
  if (effortContract) {
    const effort = levelToEffort(level, effortContract.values);
    return {
      contract: 'effort',
      effort,
      label: `reasoning_effort=${effort} (cross-protocol fallback)`,
    };
  }

  // Last resort: legacy budget.
  const budgetTokens = LEGACY_BUDGET[level];
  return {
    contract: 'budget_tokens',
    budgetTokens,
    label: `budget_tokens=${budgetTokens} (fallback)`,
  };
}
