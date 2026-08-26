import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createCoalescer } from '../../../app/platform/coalescer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCoalescer', () => {
  it('batches items pushed within the interval', () => {
    const out: number[][] = [];
    const c = createCoalescer<number>((items) => out.push(items), { intervalMs: 16 });
    c.push(1); c.push(2); c.push(3);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(out).toEqual([[1, 2, 3]]);
  });
  it('flushes early at maxItems', () => {
    const out: number[][] = [];
    const c = createCoalescer<number>((items) => out.push(items), { intervalMs: 16, maxItems: 2 });
    c.push(1); c.push(2); c.push(3);
    expect(out).toEqual([[1, 2]]);
    vi.advanceTimersByTime(16);
    expect(out).toEqual([[1, 2], [3]]);
  });
  it('empty flush is a no-op', () => {
    const out: number[][] = [];
    const c = createCoalescer<number>((items) => out.push(items), { intervalMs: 16 });
    c.flush();
    expect(out).toEqual([]);
  });
  it('timer does not double-fire after manual flush', () => {
    const out: number[][] = [];
    const c = createCoalescer<number>((items) => out.push(items), { intervalMs: 16 });
    c.push(1); c.flush(); vi.advanceTimersByTime(32);
    expect(out).toEqual([[1]]);
  });
});
