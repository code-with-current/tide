import { describe, expect, it } from 'vitest';
import { effectiveTurnExpanded } from '../../../src/components/chat/timeline/lib/turns/effective-turn-expansion.js';

describe('effectiveTurnExpanded', () => {
  const ui = (expanded?: boolean) => ({ isExpanded: expanded });

  it('stream mode is always expanded', () => {
    expect(effectiveTurnExpanded('stream', ui(false))).toBe(true);
    expect(effectiveTurnExpanded('stream', undefined)).toBe(true);
  });

  it('compact: finished turn defaults to collapsed', () => {
    expect(effectiveTurnExpanded('compact', undefined)).toBe(false);
  });

  it('compact: manual toggle wins over default', () => {
    expect(effectiveTurnExpanded('compact', ui(true))).toBe(true);
    expect(effectiveTurnExpanded('compact', ui(false))).toBe(false);
  });
});
