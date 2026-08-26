import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, isRightPanelOpen } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';

function reset() {
  useUi.setState({
    activeSessionId: 's1',
    activeDraftId: null,
    terminals: {},
    activeTerminal: {},
    terminalPorts: {},
    rightPanelOpen: { s1: true },
  });
  useTabs.setState({ active: {}, bySession: {} });
}

describe('closeTerminal → right panel', () => {
  beforeEach(reset);

  it('closes the panel when the last terminal closes while the terminal tab is showing', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'bash' }] },
      activeTerminal: { s1: 't1' },
    });
    useTabs.setState({ active: { s1: 'terminal' } });
    useUi.getState().closeTerminal('s1', 't1');
    expect(useUi.getState().terminals.s1).toHaveLength(0);
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('keeps the panel open when other terminals remain', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }] },
      activeTerminal: { s1: 't1' },
    });
    useTabs.setState({ active: { s1: 'terminal' } });
    useUi.getState().closeTerminal('s1', 't1');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
    expect(useUi.getState().activeTerminal.s1).toBe('t2');
  });

  it('keeps the panel open when a different tab is showing', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'bash' }] },
      activeTerminal: { s1: 't1' },
    });
    useTabs.setState({ active: { s1: 'files' } });
    useUi.getState().closeTerminal('s1', 't1');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
  });

  it('terminal close on a non-viewed session does not close the panel', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'a' }], s2: [{ id: 't2', name: 'b' }] },
      activeTerminal: { s1: 't1', s2: 't2' },
    });
    useTabs.setState({ active: { s1: 'files' } });
    useUi.getState().closeTerminal('s2', 't2');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
  });

  it('closing the last terminal of the viewed session leaves other sessions untouched', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'bash' }] },
      activeTerminal: { s1: 't1' },
      rightPanelOpen: { s1: true, s2: true },
    });
    useTabs.setState({ active: { s1: 'terminal' } });
    useUi.getState().closeTerminal('s1', 't1');
    // Auto-close materializes s1: false (reads closed) and leaves s2 intact.
    expect(useUi.getState().rightPanelOpen).toEqual({ s1: false, s2: true });
  });
});
