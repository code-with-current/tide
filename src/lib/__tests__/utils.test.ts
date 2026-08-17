import { describe, expect, it } from 'vitest';
import { formatContext } from '../utils';

describe('formatContext', () => {
  it('compacts millions to at most one decimal', () => {
    expect(formatContext(1_040_000)).toBe('1M');
    expect(formatContext(1_048_576)).toBe('1M');
    expect(formatContext(1_500_000)).toBe('1.5M');
    expect(formatContext(2_621_440)).toBe('2.6M');
  });

  it('rounds K-range to 2 significant figures', () => {
    expect(formatContext(131_072)).toBe('130K');
    expect(formatContext(128_000)).toBe('130K');
    expect(formatContext(200_000)).toBe('200K');
    expect(formatContext(65_536)).toBe('66K');
    expect(formatContext(32_768)).toBe('33K');
    expect(formatContext(16_384)).toBe('16K');
    expect(formatContext(8_192)).toBe('8K');
  });

  it('rolls boundary values up to the next unit', () => {
    expect(formatContext(950_000)).toBe('1M');
    expect(formatContext(999_999)).toBe('1M');
  });

  it('shows sub-1K and invalid values raw', () => {
    expect(formatContext(512)).toBe('512');
    expect(formatContext(null)).toBe('0');
    expect(formatContext(undefined)).toBe('0');
    expect(formatContext(NaN)).toBe('0');
  });
});
