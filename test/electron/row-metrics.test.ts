import { describe, expect, it } from 'vitest';
import { estimateRowSize, timelineRowKey } from '@/components/chat/timeline/row-metrics';
import type { Block, Message, ToolCall } from '@/types';

function userMsg(id: string, content = 'hi'): Message {
  return { id, role: 'user', content, createdAt: '2026-01-01T00:00:00Z' };
}

function assistantMsg(id: string, content = '', extra?: Partial<Message>): Message {
  return { id, role: 'assistant', content, createdAt: '2026-01-01T00:00:00Z', ...extra };
}

function textBlock(id: string, text: string): Block {
  return { kind: 'text', id, text, isAnswer: false } as Block;
}

function toolBlock(id: string): Block {
  return { kind: 'tool', id, toolCallId: id, name: 'bash', status: 'executed' } as unknown as Block;
}

describe('timelineRowKey', () => {
  it('uses the message id for persisted rows', () => {
    const msgs = [userMsg('m1'), assistantMsg('m2')];
    expect(timelineRowKey(msgs, 0, 's1')).toBe('m1');
    expect(timelineRowKey(msgs, 1, 's1')).toBe('m2');
  });

  it('scopes the streaming row key to the session — the cache outlives session switches', () => {
    const msgs = [userMsg('m1')];
    expect(timelineRowKey(msgs, 1, 's1')).toBe('s1:__streaming__');
    expect(timelineRowKey(msgs, 1, 's2')).toBe('s2:__streaming__');
    expect(timelineRowKey(msgs, 1, 's1')).not.toBe(timelineRowKey(msgs, 1, 's2'));
  });

  it('falls back to a stable key when sessionId is null', () => {
    expect(timelineRowKey([userMsg('m1')], 1, null)).toBe('s:__streaming__');
    expect(timelineRowKey([userMsg('m1')], 1, undefined)).toBe('s:__streaming__');
  });
});

describe('estimateRowSize', () => {
  it('returns the flat user-bubble estimate regardless of content', () => {
    expect(estimateRowSize(userMsg('m1', 'x'.repeat(5000)))).toBe(88);
  });

  it('returns the floor for undefined and empty assistant messages', () => {
    expect(estimateRowSize(undefined)).toBe(88);
    expect(estimateRowSize(assistantMsg('m1'))).toBe(200);
  });

  it('grows with content length and clamps at the ceiling', () => {
    const atFloor = estimateRowSize(assistantMsg('m1', 'x'.repeat(80 * 8))); // 40 + 8×20 = 200 exactly
    const medium = estimateRowSize(assistantMsg('m2', 'x'.repeat(80 * 40))); // 40 + 40×20 = 840
    const huge = estimateRowSize(assistantMsg('m3', 'x'.repeat(80 * 5000))); // clamped
    expect(atFloor).toBe(200);
    expect(medium).toBe(840);
    expect(huge).toBe(2000);
  });

  it('prefers blocks over content — the renderer ignores content when blocks exist', () => {
    const withBlocks = assistantMsg('m1', 'x'.repeat(80 * 100), { blocks: [textBlock('b1', 'short')] });
    expect(estimateRowSize(withBlocks)).toBe(200);
  });

  it('counts tool blocks as flat chip rows', () => {
    const one = estimateRowSize(assistantMsg('m1', '', { blocks: [toolBlock('t1')] }));
    const five = estimateRowSize(assistantMsg('m2', '', { blocks: [toolBlock('t1'), toolBlock('t2'), toolBlock('t3'), toolBlock('t4'), toolBlock('t5')] }));
    expect(one).toBe(200); // 40 + 36 clamps up to the floor
    expect(five).toBe(40 + 5 * 36);
  });

  it('falls back to toolCalls for legacy messages without blocks', () => {
    const call = { id: 't1', messageId: 'm1', toolName: 'bash', arguments: {}, argPreview: '', status: 'executed', riskTier: 'safe' } as unknown as ToolCall;
    const legacy = assistantMsg('m1', '', { toolCalls: [call] });
    expect(estimateRowSize(legacy)).toBe(200); // 40 + 1×36 still under the floor
  });
});
