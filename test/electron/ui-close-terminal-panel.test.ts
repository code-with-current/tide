import { describe, it, expect, beforeEach } from 'vitest';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';

function reset() {
  useUi.setState({
    activeSessionId: 's1',
    activeDraftId: null,
    terminals: {},
    activeTerminal: {},
    terminalPorts: {},
    rightPanelOpen: true,
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
    expect(useUi.getState().rightPanelOpen).toBe(false);
  });

  it('keeps the panel open when other terminals remain', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }] },
      activeTerminal: { s1: 't1' },
    });
    useTabs.setState({ active: { s1: 'terminal' } });
    useUi.getState().closeTerminal('s1', 't1');
    expect(useUi.getState().rightPanelOpen).toBe(true);
    expect(useUi.getState().activeTerminal.s1).toBe('t2');
  });

  it('keeps the panel open when a different tab is showing', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'bash' }] },
      activeTerminal: { s1: 't1' },
    });
    useTabs.setState({ active: { s1: 'files' } });
    useUi.getState().closeTerminal('s1', 't1');
    expect(useUi.getState().rightPanelOpen).toBe(true);
  });

  it('terminal close on a non-viewed session does not close the panel', () => {
    useUi.setState({
      terminals: { s1: [{ id: 't1', name: 'a' }], s2: [{ id: 't2', name: 'b' }] },
      activeTerminal: { s1: 't1', s2: 't2' },
    });
    useTabs.setState({ active: { s1: 'files' } });
    useUi.getState().closeTerminal('s2', 't2');
    expect(useUi.getState().rightPanelOpen).toBe(true);
  });
});
