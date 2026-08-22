import { describe, expect, it } from 'vitest';
import { panelTransition } from '../panel-transitions';

describe('panelTransition', () => {
  it('expands only the sessions panel when a session becomes available', () => {
    expect(panelTransition({ hasSessions: true, hasActive: true, prevHadSession: false }))
      .toEqual({ sessionsPanel: 'expand', rightPanel: 'keep' });
  });

  it('collapses both panels when the last session goes away', () => {
    expect(panelTransition({ hasSessions: false, hasActive: true, prevHadSession: true }))
      .toEqual({ sessionsPanel: 'collapse', rightPanel: 'collapse' });
  });

  it('never auto-expands the right panel', () => {
    const transitions = [
      panelTransition({ hasSessions: true, hasActive: true, prevHadSession: false }),
      panelTransition({ hasSessions: true, hasActive: false, prevHadSession: false }),
      panelTransition({ hasSessions: false, hasActive: false, prevHadSession: true }),
      panelTransition({ hasSessions: true, hasActive: true, prevHadSession: true }),
    ];
    expect(transitions.map((t) => t.rightPanel)).not.toContain('expand');
  });

  it('does nothing outside the transitions', () => {
    expect(panelTransition({ hasSessions: true, hasActive: true, prevHadSession: true }))
      .toEqual({ sessionsPanel: 'keep', rightPanel: 'keep' });
    expect(panelTransition({ hasSessions: false, hasActive: false, prevHadSession: false }))
      .toEqual({ sessionsPanel: 'keep', rightPanel: 'keep' });
  });
});
