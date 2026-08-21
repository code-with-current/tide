import { describe, it, expect } from 'vitest';
import {
  clampContextLines,
  hunkHasCollapsedContextAfter,
  hunkHasCollapsedContextBefore,
  hunkOldEnd,
  hunkOldStart,
  nextExpandWidth,
} from '../expand-context';
import type { DiffHunk, DiffLine } from '@/types';

/** Build a git-style hunk — exactly what parseUnifiedDiff yields. */
function hunk(header: string, lines: Partial<DiffLine>[]): DiffHunk {
  return { header, lines: lines as DiffLine[] };
}

describe('hunkOldStart', () => {
  it('parses the old-side start from the @@ header', () => {
    expect(hunkOldStart(hunk('@@ -12,5 +13,6 @@ fn foo', []))).toBe(12);
  });

  it('uses the header for all-add hunks whose lines carry no oldNo', () => {
    const h = hunk('@@ -5,0 +6,2 @@', [{ type: 'add', newNo: 6, text: '+a' }]);
    expect(hunkOldStart(h)).toBe(5);
  });

  it('returns 0 for an unparseable header', () => {
    expect(hunkOldStart(hunk('garbage', []))).toBe(0);
  });
});

describe('hunkOldEnd', () => {
  it('is the last old-side line number', () => {
    const h = hunk('@@ -10,4 +10,4 @@', [
      { type: 'context', oldNo: 10, newNo: 10, text: ' a' },
      { type: 'del', oldNo: 11, text: '-b' },
      { type: 'add', newNo: 11, text: '+c' },
      { type: 'context', oldNo: 12, newNo: 12, text: ' d' },
    ]);
    expect(hunkOldEnd(h)).toBe(12);
  });

  it('is oldStart - 1 for a pure-addition hunk (zero old lines)', () => {
    const h = hunk('@@ -5,0 +6,2 @@', [
      { type: 'add', newNo: 6, text: '+a' },
      { type: 'add', newNo: 7, text: '+b' },
    ]);
    expect(hunkOldEnd(h)).toBe(4);
  });
});

describe('hunkHasCollapsedContextBefore', () => {
  it('is true when the first hunk starts beyond line 1', () => {
    const h = hunk('@@ -9,3 +9,3 @@', [{ type: 'context', oldNo: 9, newNo: 9, text: ' x' }]);
    expect(hunkHasCollapsedContextBefore(h)).toBe(true);
  });

  it('is false when the first hunk starts at line 1', () => {
    const h = hunk('@@ -1,3 +1,3 @@', [{ type: 'context', oldNo: 1, newNo: 1, text: ' x' }]);
    expect(hunkHasCollapsedContextBefore(h)).toBe(false);
  });

  it('is true when the hunk starts more than one line past the previous hunk end', () => {
    const h = hunk('@@ -20,3 +20,3 @@', [{ type: 'context', oldNo: 20, newNo: 20, text: ' x' }]);
    expect(hunkHasCollapsedContextBefore(h, 15)).toBe(true);
  });

  it('is false when the hunk starts exactly one line past the previous hunk end', () => {
    const h = hunk('@@ -16,3 +16,3 @@', [{ type: 'context', oldNo: 16, newNo: 16, text: ' x' }]);
    expect(hunkHasCollapsedContextBefore(h, 15)).toBe(false);
  });
});

describe('hunkHasCollapsedContextAfter', () => {
  const h = hunk('@@ -10,4 +10,4 @@', [
    { type: 'context', oldNo: 10, newNo: 10, text: ' a' },
    { type: 'context', oldNo: 11, newNo: 11, text: ' b' },
    { type: 'context', oldNo: 12, newNo: 12, text: ' c' },
    { type: 'context', oldNo: 13, newNo: 13, text: ' d' },
  ]);

  it('is true when the next hunk starts beyond this hunk end + 1', () => {
    expect(hunkHasCollapsedContextAfter(h, 40)).toBe(true);
  });

  it('is false when the next hunk starts exactly at this hunk end + 1', () => {
    expect(hunkHasCollapsedContextAfter(h, 14)).toBe(false);
  });

  it('is false for the last hunk (EOF is unknowable from hunks alone)', () => {
    expect(hunkHasCollapsedContextAfter(h)).toBe(false);
  });
});

describe('nextExpandWidth', () => {
  it('walks the ladder 3 → 12 → 24 → 48 → 96 → 200', () => {
    expect(nextExpandWidth(3)).toBe(12);
    expect(nextExpandWidth(12)).toBe(24);
    expect(nextExpandWidth(24)).toBe(48);
    expect(nextExpandWidth(48)).toBe(96);
    expect(nextExpandWidth(96)).toBe(200);
  });

  it('caps at 200', () => {
    expect(nextExpandWidth(200)).toBe(200);
    expect(nextExpandWidth(500)).toBe(200);
  });

  it('snaps below-ladder values up to the next rung', () => {
    expect(nextExpandWidth(1)).toBe(3);
    expect(nextExpandWidth(2)).toBe(3);
    expect(nextExpandWidth(7)).toBe(12);
  });
});

describe('clampContextLines', () => {
  it('passes absent / non-finite through as undefined (git default context)', () => {
    expect(clampContextLines(undefined)).toBeUndefined();
    expect(clampContextLines(null)).toBeUndefined();
    expect(clampContextLines(Number.NaN)).toBeUndefined();
    expect(clampContextLines(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('clamps expand-ladder values into 1..200', () => {
    expect(clampContextLines(0)).toBe(1);
    expect(clampContextLines(-5)).toBe(1);
    expect(clampContextLines(3)).toBe(3);
    expect(clampContextLines(200)).toBe(200);
    expect(clampContextLines(500)).toBe(200);
  });

  it('rounds fractional widths', () => {
    expect(clampContextLines(2.6)).toBe(3);
  });

  it('preserves the full-file sentinel (>= 1000) unclamped', () => {
    expect(clampContextLines(1000)).toBe(1000);
    expect(clampContextLines(100000)).toBe(100000);
  });
});
