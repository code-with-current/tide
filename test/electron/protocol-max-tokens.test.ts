/**
 * Task 3.4 — per-protocol max_output_tokens sourced from the catalog.
 *
 * The protocol builders (anthropic.ts / openai.ts) read
 * `ProtocolContext.maxOutputTokens` as the base output cap instead of a
 * hardcoded 8192. The arithmetic semantics:
 *   - Anthropic: maxBase is the WIRE TOTAL; the thinking budget is carved
 *     out of it (the SDK stacks budgetTokens on top of maxOutputTokens, so
 *     answer + budget must equal maxBase to respect provider caps).
 *   - OpenAI: maxBase is the total output pool (reasoning is spent inside
 *     it server-side via reasoning_effort); the 65535 cap applies to
 *     Gemini-backed endpoints only.
 * The builders stay pure (no catalog import) — the caller resolves the cap
 * and threads it in via ctx.
 */
import { describe, it, expect } from 'vitest';
import { anthropicCallOptions } from '../../app/core/agent/protocols/anthropic.js';
import { openaiCallOptions } from '../../app/core/agent/protocols/openai.js';
import type { ProtocolContext } from '../../app/core/agent/protocols/types.js';

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
  it('openai uses ctx.maxOutputTokens as the total (thinking on, non-gemini)', () => {
    const ctx: ProtocolContext = { hasTools: false, maxOutputTokens: 64000 };
    const r = openaiCallOptions({ budgetTokens: 8000 }, ctx);
    // The effort string carries no token count — no stacking, no universal cap.
    expect(r.maxOutputTokens).toBe(64000);
  });
  it('openai falls back to 8192 base when ctx has no maxOutputTokens', () => {
    const r = openaiCallOptions({ budgetTokens: 8000 });
    expect(r.maxOutputTokens).toBe(8192);
  });
  it('openai tools-present branch still respects ctx.maxOutputTokens', () => {
    // The hasTools branch raises the output floor (16K) for tool-call args
    // but still applies reasoning_effort for non-Gemini models.
    const ctx: ProtocolContext = { hasTools: true, maxOutputTokens: 70000 };
    const r = openaiCallOptions({ budgetTokens: 8000 }, ctx);
    expect(r.maxOutputTokens).toBe(70000);
    expect(r.label).toContain('reasoning_effort');
  });
});
