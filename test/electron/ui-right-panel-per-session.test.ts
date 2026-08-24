import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, isRightPanelOpen } from '@/lib/stores/ui';

function reset() {
  useUi.setState({
    mainView: 'chat',
    activeSessionId: 's1',
    activeDraftId: null,
    rightPanelOpen: {},
    sessionLastActive: {},
  });
}

describe('per-session right panel open state', () => {
  beforeEach(reset);

  it('reads closed for a session with no remembered state', () => {
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('setRightPanel writes only the active session entry', () => {
    useUi.getState().setRightPanel(true);
    expect(useUi.getState().rightPanelOpen).toEqual({ s1: true });
    useUi.setState({ activeSessionId: 's2' });
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('toggleRightPanel flips only the active session', () => {
    useUi.setState({ rightPanelOpen: { s1: false, s2: true } });
    useUi.getState().toggleRightPanel();
    expect(useUi.getState().rightPanelOpen).toEqual({ s1: true, s2: true });
  });

  it('switching sessions restores the remembered open state', () => {
    useUi.setState({ rightPanelOpen: { s1: true, s2: false } });
    useUi.getState().setActiveSession('s2');
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
    useUi.getState().setActiveSession('s1');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
  });

  it('first message into a fresh session leaves the panel closed', () => {
    useUi.setState({ mainView: 'new', activeSessionId: 'fresh', rightPanelOpen: { s1: true } });
    useUi.getState().setMainView('chat');
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
    expect(useUi.getState().rightPanelOpen.s1).toBe(true);
  });

  it('clearSessionData drops the deleted session entry', () => {
    useUi.setState({ rightPanelOpen: { s1: true, s2: true } });
    useUi.getState().clearSessionData('s1');
    expect(useUi.getState().rightPanelOpen).toEqual({ s2: true });
  });

  it('reads closed for a materialized false entry', () => {
    useUi.setState({ rightPanelOpen: { s1: false } });
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
    expect(useUi.getState().rightPanelOpen).toEqual({ s1: false });
  });
});
