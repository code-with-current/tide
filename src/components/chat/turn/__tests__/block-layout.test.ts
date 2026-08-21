import { describe, expect, it } from 'vitest';
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from '@/types';
import { deriveLayout } from '../block-layout';

const text = (id: string, over: Partial<TextBlock> = {}): Block =>
  ({ kind: 'text', id, text: `t:${id}`, isAnswer: false, ...over }) as Block;
const reasoning = (id: string, over: Partial<ReasoningBlock> = {}): Block =>
  ({ kind: 'reasoning', id, text: `r:${id}`, ...over }) as Block;
const tool = (id: string, over: Partial<ToolBlock> = {}): Block =>
  ({ kind: 'tool', id, toolCallId: id, toolName: 'bash', category: 'commands', status: 'executed', arguments: {}, argPreview: '', riskTier: 'read_only', ...over }) as Block;

describe('deriveLayout — parented text/reasoning must not surface', () => {
  it('parented text is excluded from process and answer', () => {
    const blocks = [
      tool('dispatch_1', { toolName: 'dispatch_agent', category: 'other' }),
      text('c1', { parentToolCallId: 'dispatch_1' }),
      text('a1', { isAnswer: true }),
    ];
    const layout = deriveLayout(blocks);
    expect(layout.process.map((b) => b.id)).toEqual(['dispatch_1']);
    expect(layout.answer?.text).toBe('t:a1');
  });

  it('parented text with isAnswer set still never becomes the answer', () => {
    const blocks = [
      tool('dispatch_1', { toolName: 'dispatch_agent', category: 'other' }),
      text('c1', { parentToolCallId: 'dispatch_1', isAnswer: true }),
      text('a1', { isAnswer: true }),
    ];
    const layout = deriveLayout(blocks);
    expect(layout.answer?.text).toBe('t:a1');
    expect(layout.process.map((b) => b.id)).toEqual(['dispatch_1']);
  });

  it('parented reasoning is not folded into thinking', () => {
    const blocks = [
      reasoning('rp1', { text: 'parent thinking' }),
      tool('dispatch_1', { toolName: 'dispatch_agent', category: 'other' }),
      reasoning('rc1', { text: 'child thinking', parentToolCallId: 'dispatch_1' }),
    ];
    const layout = deriveLayout(blocks);
    expect(layout.thinking?.text).toBe('parent thinking');
  });

  it('unparented blocks unaffected alongside parented ones (totals intact)', () => {
    const blocks = [
      reasoning('rp1', { text: 'parent thinking' }),
      tool('t1', { category: 'edits', durationMs: 10 }),
      tool('c_tool', { parentToolCallId: 't1', category: 'exploration', durationMs: 5 }),
      text('c1', { parentToolCallId: 't1' }),
      reasoning('rc1', { parentToolCallId: 't1' }),
      tool('t2', { category: 'commands' }),
      text('a1', { isAnswer: true }),
    ];
    const layout = deriveLayout(blocks);
    expect(layout.totals).toEqual({ commands: 1, edits: 1, exploration: 1, other: 0, failedCount: 0, totalMs: 15 });
    expect(layout.process.map((b) => b.id)).toEqual(['t1', 't2']);
    expect(layout.answer?.text).toBe('t:a1');
    expect(layout.thinking?.text).toBe('parent thinking');
  });
});
