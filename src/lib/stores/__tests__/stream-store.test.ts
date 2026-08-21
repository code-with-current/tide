import { describe, expect, it } from 'vitest';
import { createStreamStore } from '../stream-store';

describe('stream-store', () => {
  it('appends deltas to a per-part buffer without touching other parts', () => {
    const s = createStreamStore();
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'a' }, seq: 1 });
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p2', data: { text: 'x' }, seq: 2 });
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'b' }, seq: 3 });
    expect(s.textOf('s1', 'p1')).toBe('ab');
    expect(s.textOf('s1', 'p2')).toBe('x');
  });

  it('replay is idempotent — applying the same batch twice yields the same text', () => {
    const s = createStreamStore();
    const batch = [
      { type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'a' }, seq: 1 },
      { type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'b' }, seq: 2 },
    ] as const;
    s.applyBatch([...batch]);
    const textOnce = s.textOf('s1', 'p1');
    s.applyBatch([...batch]);
    expect(s.textOf('s1', 'p1')).toBe(textOnce);
  });

  it('part.commit freezes the buffer and exposes the final part', () => {
    const s = createStreamStore();
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'ab' }, seq: 1 });
    const committed = s.apply({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'ab' } }, seq: 2 });
    expect(committed).toMatchObject({ id: 'p1', kind: 'text' });
    expect(s.textOf('s1', 'p1')).toBe('ab'); // selector still works for a re-render
  });

  it('turn.end drops the buffers, not committed parts', () => {
    const s = createStreamStore();
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'ab' }, seq: 1 });
    s.apply({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'ab' } }, seq: 2 });
    s.apply({ type: 'turn.end', sessionId: 's1', seq: 3 });
    expect(s.bufferSize('s1')).toBe(0);
    expect(s.turnParts('s1').map((p) => p.id)).toEqual(['p1']);
  });

  it('apply never mutates the input events (frozen-input guard)', () => {
    const s = createStreamStore();
    const e = Object.freeze({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: Object.freeze({ text: 'a' }), seq: 1 });
    expect(() => s.apply(e)).not.toThrow();
  });

  it('events without seq (degraded live push) still apply', () => {
    const s = createStreamStore();
    s.apply({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'z' } });
    expect(s.textOf('s1', 'p1')).toBe('z');
  });
});
