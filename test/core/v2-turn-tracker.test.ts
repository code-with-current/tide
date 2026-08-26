import { describe, expect, it } from 'vitest';
import { createV2TurnTracker } from '../../app/core/agent/v2-turn-tracker.js';
import type { SinkEvent } from '../../app/core/agent/event-sink.js';

const usage = { inputTokens: 1, outputTokens: 2, costUsd: 0.1 };
const mk = () => createV2TurnTracker({ sessionId: 's1', messageId: 'm1' });
const types = (evts: SinkEvent[]) => evts.map((e) => e.type);
const body = (e: SinkEvent) => e.data as { kind: string; data: unknown; seq: number };

describe('v2 turn tracker', () => {
  it('sequences interleaved text/tool with monotonic part seq', () => {
    const t = mk();
    t.textDelta('b1', 'Hello');
    const start = t.toolStart('t1');
    expect(types(start)).toEqual(['part.commit']);
    expect(body(start[0])).toEqual({ kind: 'text', data: { text: 'Hello' }, seq: 0 });
    const end = t.toolEnd('t1', { toolName: 'bash', input: { command: 'ls' }, output: 'a', status: 'executed', durationMs: 5 });
    expect(types(end)).toEqual(['part.commit']);
    expect(body(end[0])).toEqual({ kind: 'tool', data: { toolName: 'bash', input: { command: 'ls' }, output: 'a', status: 'executed', durationMs: 5 }, seq: 1 });
    t.textDelta('b2', 'Done');
    const fin = t.finish(usage);
    expect(types(fin)).toEqual(['part.commit', 'message.end', 'turn.end']);
    expect(body(fin[0])).toEqual({ kind: 'text', data: { text: 'Done' }, seq: 2 });
    expect((fin[1].data as { usage: unknown }).usage).toEqual(usage);
  });

  it('appends consecutive deltas on the same block into one part', () => {
    const t = mk();
    const d1 = t.textDelta('b1', 'He');
    const d2 = t.textDelta('b1', 'llo');
    expect(types(d1)).toEqual(['part.delta']);
    expect(types(d2)).toEqual(['part.delta']);
    const fin = t.finish(usage);
    expect(types(fin)).toEqual(['part.commit', 'message.end', 'turn.end']);
    expect(body(fin[0])).toEqual({ kind: 'text', data: { text: 'Hello' }, seq: 0 });
  });

  it('opens a new text part when the block id changes (reasoning interleave)', () => {
    const t = mk();
    t.textDelta('b1', 'before thinking');
    const second = t.textDelta('b2', 'after thinking');
    expect(types(second)).toEqual(['part.commit', 'part.delta']);
    expect(body(second[0])).toEqual({ kind: 'text', data: { text: 'before thinking' }, seq: 0 });
    const fin = t.finish(usage);
    expect(body(fin[0])).toEqual({ kind: 'text', data: { text: 'after thinking' }, seq: 1 });
  });

  it('second finish/abort is a no-op', () => {
    const t = mk();
    t.textDelta('b1', 'x');
    expect(t.finish(usage).length).toBe(3);
    expect(t.finish(usage)).toEqual([]);
    expect(t.abort()).toEqual([]);
  });

  it('abort with an open text part commits it, then message.end + turn.end exactly once', () => {
    const t = mk();
    t.textDelta('b1', 'partial');
    const evts = t.abort(usage);
    expect(types(evts)).toEqual(['part.commit', 'message.end', 'turn.end']);
    expect(body(evts[0])).toEqual({ kind: 'text', data: { text: 'partial' }, seq: 0 });
    expect(t.abort()).toEqual([]);
    expect(t.textDelta('b1', 'more')).toEqual([]);
  });

  it('empty text deltas open no parts', () => {
    const t = mk();
    expect(t.textDelta('b1', '')).toEqual([]);
    const fin = t.finish(usage);
    expect(types(fin)).toEqual(['message.end', 'turn.end']);
  });

  it('tool-end without a matching tool-start is a defensive no-op', () => {
    const t = mk();
    expect(t.toolEnd('t1', { toolName: 'bash', input: {}, status: 'executed' })).toEqual([]);
    t.toolStart('t2');
    expect(t.toolEnd('t1', { toolName: 'bash', input: {}, status: 'executed' })).toEqual([]);
  });

  it('text after a tool round opens a new part at the next seq even on the same block id', () => {
    const t = mk();
    t.textDelta('b1', 'first');
    t.toolStart('t1');
    t.toolEnd('t1', { toolName: 'grep', input: {}, status: 'executed' });
    t.textDelta('b1', 'second');
    const fin = t.finish(usage);
    expect(body(fin[0])).toEqual({ kind: 'text', data: { text: 'second' }, seq: 2 });
  });

  it('parallel tool calls commit in completion order', () => {
    const t = mk();
    t.toolStart('a');
    t.toolStart('b');
    const endB = t.toolEnd('b', { toolName: 'bash', input: {}, status: 'executed' });
    const endA = t.toolEnd('a', { toolName: 'grep', input: {}, status: 'executed' });
    expect(body(endB[0]).seq).toBe(0);
    expect(body(endA[0]).seq).toBe(1);
    expect(body(endB[0]).data).toEqual({ toolName: 'bash', input: {}, output: undefined, status: 'executed', durationMs: undefined });
  });
});
