import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_HIGHLIGHT_BLOCK_CHARS,
  highlightCacheSize,
  highlightLine,
  shouldHighlight,
} from '../highlight';

const PLAIN = '';

describe('shouldHighlight', () => {
  it('gates on total chars when totalChars is passed', () => {
    expect(shouldHighlight(['x'], MAX_HIGHLIGHT_BLOCK_CHARS)).toBe(true);
    expect(shouldHighlight(['x'], MAX_HIGHLIGHT_BLOCK_CHARS + 1)).toBe(false);
  });

  it('computes total chars from lines when omitted', () => {
    const lines = ['a'.repeat(300), 'b'.repeat(300)];
    expect(shouldHighlight(lines)).toBe(true);
    expect(shouldHighlight(['x'.repeat(MAX_HIGHLIGHT_BLOCK_CHARS + 1)])).toBe(false);
  });
});

describe('highlightLine', () => {
  beforeEach(() => {
    expect(highlightCacheSize()).toBeGreaterThanOrEqual(0);
  });

  it('returns a single plain span for unknown languages', () => {
    expect(highlightLine('const x = 1', 'text')).toEqual([{ text: 'const x = 1', cls: PLAIN }]);
    expect(highlightLine('some words', 'markdown')).toEqual([{ text: 'some words', cls: PLAIN }]);
  });

  it('returns an empty array for empty text', () => {
    expect(highlightLine('', 'typescript')).toEqual([]);
  });

  it('tokenizes keywords, numbers, and comments in typescript', () => {
    const spans = highlightLine('const answer = 42; // note', 'typescript');
    expect(spans.find((s) => s.cls.includes('reasoning'))?.text).toBe('const');
    expect(spans.find((s) => s.cls.includes('warning'))?.text).toBe('42');
    expect(spans.find((s) => s.cls.includes('italic'))?.text).toBe('// note');
  });

  it('tokenizes strings and function calls', () => {
    const spans = highlightLine('greet("world")', 'typescript');
    expect(spans.find((s) => s.cls.includes('info'))?.text).toBe('greet');
    expect(spans.find((s) => s.cls.includes('success'))?.text).toBe('"world"');
  });

  it('tokenizes python comments and defs', () => {
    const spans = highlightLine('def foo():  # hi', 'python');
    expect(spans.find((s) => s.cls.includes('reasoning'))?.text).toBe('def');
    expect(spans.find((s) => s.cls.includes('italic'))?.text).toBe('# hi');
  });

  it('tokenizes json strings and constants', () => {
    const spans = highlightLine('"key": true', 'json');
    expect(spans.find((s) => s.cls.includes('success'))?.text).toBe('"key"');
    expect(spans.find((s) => s.cls.includes('warning'))?.text).toBe('true');
  });

  it('treats capitalized identifiers as types', () => {
    const spans = highlightLine('const user: UserPrefs = load();', 'typescript');
    expect(spans.find((s) => s.text === 'UserPrefs')?.cls).not.toBe(PLAIN);
    expect(spans.find((s) => s.text === 'load')?.cls).toContain('info');
  });

  it('is lossless — concatenated span text equals the input', () => {
    const samples = [
      '  if (x <= 42) { return `t${x}`; }',
      "name: 'o''brien', flag: true",
      '# hash comment with "quotes" inside',
      'a=b+c // trailing',
      'no tokens at all here',
    ];
    for (const text of samples) {
      const joined = highlightLine(text, 'typescript').map((s) => s.text).join('');
      expect(joined).toBe(text);
    }
  });

  it('memoizes results — same text+lang returns the same array', () => {
    const a = highlightLine('const same = 1;', 'typescript');
    const b = highlightLine('const same = 1;', 'typescript');
    expect(b).toBe(a);
  });

  it('keeps the module cache bounded', () => {
    for (let i = 0; i < 4100; i++) {
      highlightLine(`line number ${i} = ${i};`, 'typescript');
    }
    expect(highlightCacheSize()).toBeLessThanOrEqual(4000);
  });
});
