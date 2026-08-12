/**
 * Task 3.4 — per-protocol max_output_tokens sourced from the catalog.
 *
 * The protocol builders (anthropic.ts / openai.ts) read
 * `ProtocolContext.maxOutputTokens` as the base output cap instead of a
 * hardcoded 8192. The arithmetic semantics are unchanged:
 *   - Anthropic: `maxOutputTokens` is the ANSWER budget only; the SDK adds
 *     `thinking.budgetTokens` on top. We do NOT add the budget here.
 *   - OpenAI: `budgetTokens + maxBase`, capped at MAX_OUTPUT_TOKENS_CAP.
 * The builders stay pure (no catalog import) — the caller resolves the cap
 * and threads it in via ctx.
 */
import { describe, it, expect } from 'vitest';
import { anthropicCallOptions } from '../agent/protocols/anthropic.js';
import { openaiCallOptions } from '../agent/protocols/openai.js';
import type { ProtocolContext } from '../agent/protocols/types.js';

describe('protocol maxOutputTokens from catalog context', () => {
  it('anthropic uses ctx.maxOutputTokens when provided (off branch)', () => {
    const ctx: ProtocolContext = { hasTools: false, maxOutputTokens: 64000 };
    const r = anthropicCallOptions(null, ctx);
    expect(r.maxOutputTokens).toBe(64000);
  });
  it('anthropic falls back to 8192 when ctx has no maxOutputTokens', () => {
    const r = anthropicCallOptions(null);
    expect(r.maxOutputTokens).toBe(8192);
  });
  it('openai uses ctx.maxOutputTokens as the base (thinking on, under cap)', () => {
    const ctx: ProtocolContext = { hasTools: false, maxOutputTokens: 64000 };
    const r = openaiCallOptions({ budgetTokens: 8000 }, ctx);
    // budgetTokens + maxBase, capped at 65535
    expect(r.maxOutputTokens).toBe(Math.min(8000 + 64000, 65535));
  });
  it('openai falls back to 8192 base when ctx has no maxOutputTokens', () => {
    const r = openaiCallOptions({ budgetTokens: 8000 });
    expect(r.maxOutputTokens).toBe(Math.min(8000 + 8192, 65535));
  });
  it('openai tools-present branch still respects ctx.maxOutputTokens and cap', () => {
    // The hasTools branch raises the output floor (16K) for tool-call args
    // but still applies reasoning_effort for non-Gemini models, min'd
    // against MAX_OUTPUT_TOKENS_CAP.
    const ctx: ProtocolContext = { hasTools: true, maxOutputTokens: 70000 };
    const r = openaiCallOptions({ budgetTokens: 8000 }, ctx);
    expect(r.maxOutputTokens).toBe(Math.min(8000 + 70000, 65535)); // = 65535
    expect(r.label).toContain('reasoning_effort');
  });
});
