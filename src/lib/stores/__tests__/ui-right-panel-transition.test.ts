import { describe, it, expect, beforeEach } from 'vitest';
import { useUi } from '../ui';

function reset() {
  useUi.setState({
    mainView: 'new',
    rightPanelOpen: true,
    activeSessionId: null,
    activeDraftId: null,
    sessionLastActive: {},
  });
}

describe('right panel on new-session → chat transition', () => {
  beforeEach(reset);

  it('closes the panel when the first message flips mainView to chat', () => {
    useUi.getState().setMainView('chat');
    expect(useUi.getState().rightPanelOpen).toBe(false);
  });

  it('closes the panel when setActiveSession enters a session from the new screen', () => {
    useUi.getState().setActiveSession('s1');
    expect(useUi.getState().mainView).toBe('chat');
    expect(useUi.getState().rightPanelOpen).toBe(false);
  });

  it('preserves the panel preference on chat → chat session switches', () => {
    useUi.setState({ mainView: 'chat', activeSessionId: 's1' });
    useUi.getState().setActiveSession('s2');
    expect(useUi.getState().rightPanelOpen).toBe(true);
  });

  it('preserves the panel when staying on chat (redundant setMainView)', () => {
    useUi.setState({ mainView: 'chat' });
    useUi.getState().setMainView('chat');
    expect(useUi.getState().rightPanelOpen).toBe(true);
  });
});
