import { describe, expect, it } from 'vitest';
import { remapTabKind } from '../tabs';

describe('remapTabKind', () => {
  it('passes through live kinds', () => {
    for (const k of ['git', 'files', 'agents', 'terminal', 'browser'] as const)
      expect(remapTabKind(k)).toBe(k);
  });
  it('removes inspector → files', () => expect(remapTabKind('inspector')).toBe('files'));
  it('folds review → git', () => expect(remapTabKind('review')).toBe('git'));
  it('folds changes → git', () => expect(remapTabKind('changes')).toBe('git'));
  it('unknown → files', () => expect(remapTabKind('whatever' as never)).toBe('files'));
});
