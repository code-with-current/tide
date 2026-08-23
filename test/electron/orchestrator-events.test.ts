import { describe, expect, it } from 'vitest';
import {
  newV2MessageId,
  newV2PartId,
  orchestratorEventToSink,
  type OrchestratorStreamEvent,
} from '../../electron/agent/orchestrator-events.js';

describe('orchestrator event translation', () => {
  it('maps a text delta to part.delta', () => {
    expect(orchestratorEventToSink('s1', 'm1', 'p1', { type: 'text-delta', text: 'hi' }))
      .toEqual({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'hi' } });
  });

  it('maps a completed text block to part.commit', () => {
    expect(orchestratorEventToSink('s1', 'm1', 'p1', { type: 'text-end', text: 'hi there' }))
      .toEqual({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'hi there' }, seq: 0 } });
  });

  it('maps turn completion with usage to message.end', () => {
    const e = orchestratorEventToSink('s1', 'm1', undefined, { type: 'finish', usage: { inputTokens: 1, outputTokens: 2 } });
    expect(e?.type).toBe('message.end');
    expect(e?.data).toEqual({ usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it('returns undefined for unmappable event types', () => {
    expect(orchestratorEventToSink('s1', 'm1', 'p1', { type: 'unknown-thing' } as unknown as OrchestratorStreamEvent)).toBeUndefined();
  });

  it('maps a completed tool call to a tool part.commit', () => {
    expect(orchestratorEventToSink('s1', 'm1', 'p9', {
      type: 'tool-end',
      toolName: 'bash',
      input: { command: 'ls' },
      output: 'a\nb',
      status: 'executed',
      durationMs: 42,
    })).toEqual({
      type: 'part.commit',
      sessionId: 's1',
      messageId: 'm1',
      partId: 'p9',
      data: {
        kind: 'tool',
        data: { toolName: 'bash', input: { command: 'ls' }, output: 'a\nb', status: 'executed', durationMs: 42 },
        seq: 0,
      },
    });
  });

  it('omits absent optional tool fields from the committed data', () => {
    const e = orchestratorEventToSink('s1', 'm1', 'p1', { type: 'tool-end', toolName: 'grep', input: {}, status: 'failed' });
    expect(e?.data).toEqual({ kind: 'tool', data: { toolName: 'grep', input: {}, output: undefined, status: 'failed', durationMs: undefined }, seq: 0 });
  });

  it('maps the turn boundary to turn.end with no data', () => {
    expect(orchestratorEventToSink('s1', 'm1', undefined, { type: 'turn-end' }))
      .toEqual({ type: 'turn.end', sessionId: 's1', messageId: 'm1' });
  });

  it('threads partIndex as the committed seq for text parts', () => {
    const e = orchestratorEventToSink('s1', 'm1', 'p2', { type: 'text-end', text: 'x' }, 3);
    expect(e?.data).toEqual({ kind: 'text', data: { text: 'x' }, seq: 3 });
  });

  it('threads partIndex as the committed seq for tool parts', () => {
    const e = orchestratorEventToSink('s1', 'm1', 'p4', { type: 'tool-end', toolName: 'bash', input: {}, status: 'executed' }, 7);
    expect(e).toBeDefined();
    expect((e as { data: { seq: number } }).data.seq).toBe(7);
  });

  it('passes full turn usage through to message.end untouched', () => {
    const usage = { inputTokens: 10, outputTokens: 20, cacheRead: 1, cacheWrite: 2, reasoningTokens: 3, calls: 4, costUsd: 0.5 };
    const e = orchestratorEventToSink('s1', 'm1', undefined, { type: 'finish', usage });
    expect(e?.data).toEqual({ usage });
  });
});

describe('v2 id generation', () => {
  it('generates chronologically sortable message ids', () => {
    const id = newV2MessageId();
    expect(id).toMatch(/^m_[0-9a-z]+_[0-9a-z]{1,8}$/);
  });

  it('generates part ids under the p_ prefix', () => {
    expect(newV2PartId()).toMatch(/^p_[0-9a-z]+_[0-9a-z]{1,8}$/);
  });

  it('sorts by timestamp across a straddled clock reading', () => {
    const before = Date.now();
    const a = newV2MessageId();
    const b = newV2MessageId();
    const after = Date.now();
    const ts = (id: string) => parseInt(id.slice(2, id.indexOf('_', 2)), 36);
    expect(ts(a)).toBeGreaterThanOrEqual(before);
    expect(ts(b)).toBeLessThanOrEqual(after);
    expect(ts(a) <= ts(b)).toBe(true);
  });
});
