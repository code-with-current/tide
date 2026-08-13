import { describe, it, expect } from 'vitest';
import {
  pruneToolOutputs,
  estimateTokens,
  shouldCompact,
  usableInputBudget,
  isContextOverflow,
  DEFAULT_AUTO_COMPACT_CONFIG,
  type AutoCompactConfig,
} from '../agent/context/auto-compact.js';
import type { ModelMessage } from 'ai';

// ── Helpers ─────────────────────────────────────────────────────────────

function userMsg(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): ModelMessage {
  return { role: 'assistant', content: text };
}

function toolMsg(text: string): ModelMessage {
  return { role: 'tool', content: text };
}

/** Build N messages of synthetic conversation with large tool outputs. */
function buildConversation(toolOutputSize: number, toolCount: number): ModelMessage[] {
  const msgs: ModelMessage[] = [userMsg('Start'), assistantMsg('OK')];
  for (let i = 0; i < toolCount; i++) {
    msgs.push(toolMsg('x'.repeat(toolOutputSize)));
  }
  msgs.push(userMsg('Final question'));
  return msgs;
}

const testConfig: AutoCompactConfig = {
  ...DEFAULT_AUTO_COMPACT_CONFIG,
  contextWindow: 50_000,
  maxOutputTokens: 4_000,
  threshold: 0.75,
};

// ── Layer 1: Tool output pruning ────────────────────────────────────────

describe('pruneToolOutputs', () => {
  it('returns messages unchanged when no tool messages exist', () => {
    const msgs = [userMsg('hi'), assistantMsg('hello')];
    const result = pruneToolOutputs(msgs);
    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(msgs);
  });

  it('protects the last 40K tokens of tool output and prunes older ones', () => {
    // Each tool message is ~10K tokens (35K chars). Protect the last ~4
    // (40K), prune the rest. 6 tool messages = ~60K total, prune ~2.
    const bigOutput = 'x'.repeat(35_000);
    const msgs: ModelMessage[] = [];
    msgs.push(userMsg('Start'));
    msgs.push(assistantMsg('Working'));
    for (let i = 0; i < 6; i++) {
      msgs.push(toolMsg(bigOutput));
    }
    msgs.push(userMsg('Done'));

    const result = pruneToolOutputs(msgs);
    expect(result.prunedCount).toBeGreaterThan(0);
    expect(result.tokensReclaimed).toBeGreaterThanOrEqual(20_000);

    // Pruned messages should have marker text, not the original
    const prunedToolMsgs = result.messages.filter(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('[pruned'),
    );
    expect(prunedToolMsgs.length).toBe(result.prunedCount);
  });

  it('does not prune when reclaimable tokens are below PRUNE_MINIMUM', () => {
    const msgs = [userMsg('hi'), toolMsg('small output'), assistantMsg('ok')];
    const result = pruneToolOutputs(msgs);
    expect(result.prunedCount).toBe(0);
  });
});

// ── Token estimation ────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~1 token per 3.5 chars + overhead', () => {
    const tokens = estimateTokens([userMsg('hello world')]); // 11 chars + 14 overhead
    expect(tokens).toBe(Math.ceil((11 + 14) / 3.5));
  });

  it('handles array content with tool-result parts', () => {
    const msg: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', output: 'result text' }] as any,
    };
    const tokens = estimateTokens([msg]);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ── Threshold check ─────────────────────────────────────────────────────

describe('shouldCompact', () => {
  it('fires when tokens exceed threshold fraction of usable budget', () => {
    const config = { ...testConfig, contextWindow: 10_000, maxOutputTokens: 1_000, threshold: 0.75 };
    // usable = 9000, threshold = 6750
    expect(shouldCompact([], config, 0, 7_000)).toBe(true);
    expect(shouldCompact([], config, 0, 5_000)).toBe(false);
  });

  it('circuit-breaks after MAX_CONSECUTIVE_FAILURES', () => {
    expect(shouldCompact([], testConfig, 3, 999_999)).toBe(false);
  });

  it('falls back to char heuristic when actualInputTokens is missing', () => {
    const big = 'x'.repeat(100_000);
    const config = { ...testConfig, contextWindow: 1_000, maxOutputTokens: 100, threshold: 0.5 };
    expect(shouldCompact([userMsg(big)], config, 0)).toBe(true);
  });
});

// ── Usable budget ───────────────────────────────────────────────────────

describe('usableInputBudget', () => {
  it('subtracts maxOutputTokens from contextWindow', () => {
    const config = { ...testConfig, contextWindow: 200_000, maxOutputTokens: 8_000 };
    expect(usableInputBudget(config)).toBe(192_000);
  });

  it('uses maxInputTokens when provided', () => {
    const config: AutoCompactConfig = {
      ...testConfig,
      contextWindow: 200_000,
      maxInputTokens: 150_000,
      maxOutputTokens: 8_000,
    };
    expect(usableInputBudget(config)).toBe(142_000);
  });
});

// ── Overflow detection ──────────────────────────────────────────────────

describe('isContextOverflow', () => {
  it('detects common overflow error messages', () => {
    expect(isContextOverflow('Prompt too long: maximum context length is 8192 tokens')).toBe(true);
    expect(isContextOverflow('This request exceeds the input token limit')).toBe(true);
    expect(isContextOverflow('code: 1261')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflow('Rate limited')).toBe(false);
    expect(isContextOverflow('Internal server error')).toBe(false);
    expect(isContextOverflow('')).toBe(false);
  });
});
