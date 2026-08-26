import { describe, expect, it } from 'vitest';
import { nextEngagement } from '@/hooks/use-follow-scroll';

describe('nextEngagement', () => {
  it('stays engaged while active with no user input', () => {
    expect(nextEngagement({ engaged: true, active: true, userScrolledUp: false, nearBottom: true })).toBe(true);
  });
  it('disengages when the user scrolls up', () => {
    expect(nextEngagement({ engaged: true, active: true, userScrolledUp: true, nearBottom: false })).toBe(false);
  });
  it('re-engages when the user returns to the bottom', () => {
    expect(nextEngagement({ engaged: false, active: true, userScrolledUp: false, nearBottom: true })).toBe(true);
  });
  it('stays disengaged mid-panel while active', () => {
    expect(nextEngagement({ engaged: false, active: true, userScrolledUp: false, nearBottom: false })).toBe(false);
  });
  it('inactive clears engagement', () => {
    expect(nextEngagement({ engaged: true, active: false, userScrolledUp: false, nearBottom: true })).toBe(false);
  });
});
