import { describe, expect, it } from 'vitest';
import { ScrollbackBuffer } from '../../electron/ipc/terminal-scrollback';

describe('ScrollbackBuffer', () => {
  it('assigns monotonic sequences and concatenates on snapshot', () => {
    const b = new ScrollbackBuffer(1024);
    expect(b.append('a')).toBe(1);
    expect(b.append('b')).toBe(2);
    expect(b.snapshot()).toEqual({ data: 'ab', seq: 2 });
  });

  it('trims oldest whole chunks at the cap, staying UTF-8 safe', () => {
    const b = new ScrollbackBuffer(10);
    b.append('hello'); // seq 1
    b.append(' '); // seq 2
    b.append('wörld'); // seq 3 — multibyte chunk must never be split
    b.append('!!'); // seq 4 → over cap, 'hello' dropped
    const snap = b.snapshot();
    expect(snap.data).toBe(' wörld!!');
    expect(snap.seq).toBe(4);
  });

  it('never trims a single chunk larger than the cap', () => {
    const b = new ScrollbackBuffer(4);
    b.append('abcdefgh');
    expect(b.snapshot()).toEqual({ data: 'abcdefgh', seq: 1 });
  });

  it('empty buffer snapshots as empty data with seq 0', () => {
    const b = new ScrollbackBuffer(64);
    expect(b.snapshot()).toEqual({ data: '', seq: 0 });
  });
});
