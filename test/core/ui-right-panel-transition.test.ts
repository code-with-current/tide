import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, isRightPanelOpen } from '@/lib/stores/ui';

function reset() {
  useUi.setState({
    mainView: 'new',
    rightPanelOpen: {},
    activeSessionId: null,
    activeDraftId: null,
    sessionLastActive: {},
  });
}

describe('right panel on new-session → chat transition', () => {
  beforeEach(reset);

  it('closes the panel when the first message flips mainView to chat', () => {
    useUi.setState({ activeSessionId: 'fresh' });
    useUi.getState().setMainView('chat');
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('enters a session with no remembered panel state closed', () => {
    useUi.getState().setActiveSession('s1');
    expect(useUi.getState().mainView).toBe('chat');
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('restores the target session remembered state on chat → chat switches', () => {
    useUi.setState({ mainView: 'chat', activeSessionId: 's1', rightPanelOpen: { s1: false, s2: true } });
    useUi.getState().setActiveSession('s2');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
    useUi.getState().setActiveSession('s1');
    expect(isRightPanelOpen(useUi.getState())).toBe(false);
  });

  it('preserves the panel when staying on chat (redundant setMainView)', () => {
    useUi.setState({ mainView: 'chat', activeSessionId: 's1', rightPanelOpen: { s1: true } });
    useUi.getState().setMainView('chat');
    expect(isRightPanelOpen(useUi.getState())).toBe(true);
  });
});
