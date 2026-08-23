import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, COMPOSER_NEW_KEY, FORK_ATTACHMENT_PATH } from '@/lib/stores/ui';
import type { PendingFork } from '@/lib/stores/ui';

const fork: PendingFork = {
  sourceSessionId: 's1',
  sourceTitle: 'fix the auth leak',
  sourceModelId: 'claude-4',
  origin: 'model',
};

// Node env — no window.tideIpc; purge's terminalKill calls are try/caught.
function reset() {
  useUi.setState({
    activeWorkspaceId: 'ws1',
    activeSessionId: null,
    activeDraftId: null,
    draftSessions: {},
    composerDrafts: {},
    composerAttachments: {},
    terminals: {},
    activeTerminal: {},
    terminalPorts: {},
    pendingFork: null,
    mainView: 'new',
  });
}

describe('pendingFork lifecycle', () => {
  beforeEach(reset);

  it('setPendingFork(null) drops the fork attachment but keeps others', () => {
    useUi.setState({
      pendingFork: fork,
      composerAttachments: {
        [COMPOSER_NEW_KEY]: [
          { path: FORK_ATTACHMENT_PATH, kind: 'paste', content: 'answer text' },
          { path: 'notes.md', kind: 'text', content: 'user notes' },
        ],
      },
    });

    useUi.getState().setPendingFork(null);

    const list = useUi.getState().composerAttachments[COMPOSER_NEW_KEY];
    expect(useUi.getState().pendingFork).toBeNull();
    expect(list?.map((a) => a.path)).toEqual(['notes.md']);
  });

  it('setting a fork keeps attachments untouched', () => {
    useUi.getState().setPendingFork(fork);
    expect(useUi.getState().pendingFork).toEqual(fork);
    expect(useUi.getState().composerAttachments).toEqual({});
  });

  it('startNewDraft clears a pending fork and its attachment', () => {
    useUi.setState({
      pendingFork: fork,
      composerAttachments: {
        [COMPOSER_NEW_KEY]: [{ path: FORK_ATTACHMENT_PATH, kind: 'paste', content: 'x' }],
      },
    });

    useUi.getState().startNewDraft();

    expect(useUi.getState().pendingFork).toBeNull();
    expect(useUi.getState().composerAttachments[COMPOSER_NEW_KEY] ?? []).toHaveLength(0);
    expect(useUi.getState().mainView).toBe('new');
  });

  it('selectDraft clears the fork (loading another draft is not the fork draft)', () => {
    useUi.setState({ pendingFork: fork, activeDraftId: 'd1' });

    useUi.getState().selectDraft('d2');

    expect(useUi.getState().activeDraftId).toBe('d2');
    expect(useUi.getState().pendingFork).toBeNull();
  });

  it('consumeDraft clears the fork when the draft is sent', () => {
    useUi.setState({ pendingFork: fork, activeDraftId: 'd1' });

    useUi.getState().consumeDraft();

    expect(useUi.getState().activeDraftId).toBeNull();
    expect(useUi.getState().pendingFork).toBeNull();
  });

  it('setActiveSession(non-null) clears the fork; null does not', () => {
    useUi.setState({ pendingFork: fork });

    useUi.getState().setActiveSession(null);
    expect(useUi.getState().pendingFork).toEqual(fork);

    useUi.getState().setActiveSession('s2');
    expect(useUi.getState().pendingFork).toBeNull();
  });

  it('deleteDraft clears the fork only when the active draft is deleted', () => {
    useUi.setState({
      pendingFork: fork,
      activeDraftId: 'd1',
      draftSessions: {
        d1: { id: 'd1', workspaceId: 'ws1', updatedAt: 1 },
        d2: { id: 'd2', workspaceId: 'ws1', updatedAt: 2 },
      },
    });

    useUi.getState().deleteDraft('d2');
    expect(useUi.getState().pendingFork).toEqual(fork);

    useUi.getState().deleteDraft('d1');
    expect(useUi.getState().pendingFork).toBeNull();
    // Fresh slot assigned — terminal scope never falls to 'default'.
    expect(useUi.getState().activeDraftId).not.toBeNull();
  });
});
