import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, terminalScopeKey } from '../ui';

// Node env — no window.tideIpc; purge's terminalKill calls are try/caught.
function reset() {
  useUi.setState({
    activeWorkspaceId: 'ws1',
    activeSessionId: null,
    activeDraftId: null,
    draftSessions: {},
    composerDrafts: {},
    terminals: {},
    activeTerminal: {},
    terminalPorts: {},
    mainView: 'new',
  });
}

describe('terminalScopeKey', () => {
  it('prefers the session, then the draft, then default', () => {
    expect(terminalScopeKey({ activeSessionId: 's1', activeDraftId: 'd1' })).toBe('s1');
    expect(terminalScopeKey({ activeSessionId: null, activeDraftId: 'd1' })).toBe('draft:d1');
    expect(terminalScopeKey({ activeSessionId: null, activeDraftId: null })).toBe('default');
  });
});

describe('draft terminal buckets', () => {
  beforeEach(reset);

  it('keeps only one draft per workspace', () => {
    useUi.setState({ activeDraftId: 'd1', draftSessions: { d1: { id: 'd1', workspaceId: 'ws1', updatedAt: 1 } }, composerDrafts: { d1: 'old text' } });
    useUi.getState().touchDraft('ws1', 'new draft text');
    const drafts = Object.values(useUi.getState().draftSessions);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe('d1');
    // Other workspaces keep their drafts.
    const other = { id: 'd2', workspaceId: 'ws2', updatedAt: 2 };
    useUi.setState({ draftSessions: { d1: drafts[0], d2: other } });
    useUi.getState().touchDraft('ws1', 'more text');
    expect(useUi.getState().draftSessions).toEqual({ d1: expect.anything(), d2: other });
  });

  it('drops the draft entry when text is emptied', () => {
    useUi.setState({ activeDraftId: 'd1', draftSessions: { d1: { id: 'd1', workspaceId: 'ws1', updatedAt: 1 } } });
    useUi.getState().touchDraft('ws1', '   ');
    expect(useUi.getState().draftSessions).toEqual({});
  });

  it('keys draft-phase terminals by draft id and adopts them on promotion', () => {
    useUi.getState().startNewDraft();
    const draftId = useUi.getState().activeDraftId!;
    const key = `draft:${draftId}`;
    useUi.getState().addTerminal(key);
    expect(useUi.getState().terminals[key]).toHaveLength(1);

    // Promotion: session created, draft terminals move under the session id.
    // Adoption runs BEFORE setActiveSession — selectSession clears the draft
    // pointer, and adoption reads it to find the bucket.
    useUi.getState().adoptDraftTerminals('s_new');
    useUi.getState().setActiveSession('s_new');
    useUi.getState().consumeDraft();

    const state = useUi.getState();
    expect(state.terminals[key]).toBeUndefined();
    expect(state.terminals.s_new).toHaveLength(1);
    expect(state.activeTerminal.s_new).toBeDefined();
    expect(state.activeTerminal[key]).toBeUndefined();
  });

  it("a later draft does not inherit the previous draft's terminals", () => {
    useUi.getState().startNewDraft();
    const firstKey = terminalScopeKey(useUi.getState());
    useUi.getState().addTerminal(firstKey);

    useUi.getState().adoptDraftTerminals('s1');
    useUi.getState().setActiveSession('s1');
    useUi.getState().consumeDraft();

    useUi.getState().startNewDraft();
    const secondKey = terminalScopeKey(useUi.getState());
    expect(secondKey).not.toBe(firstKey);
    expect(useUi.getState().terminals[secondKey] ?? []).toHaveLength(0);
    // The promoted session kept its terminals.
    expect(useUi.getState().terminals.s1).toHaveLength(1);
  });

  it('purges the draft bucket when the draft is deleted', () => {
    useUi.getState().startNewDraft();
    const draftId = useUi.getState().activeDraftId!;
    const key = `draft:${draftId}`;
    useUi.getState().addTerminal(key);
    useUi.getState().addTerminal(key);

    useUi.getState().deleteDraft(draftId);
    const state = useUi.getState();
    expect(state.terminals[key]).toBeUndefined();
    expect(state.activeTerminal[key]).toBeUndefined();
  });

  it('adoption is a no-op when no draft is active or the bucket is empty', () => {
    useUi.getState().adoptDraftTerminals('s_x');
    expect(useUi.getState().terminals.s_x).toBeUndefined();

    useUi.getState().startNewDraft();
    useUi.getState().adoptDraftTerminals('s_y');
    expect(useUi.getState().terminals.s_y).toBeUndefined();
  });
});

describe('stale draft scope after session switches', () => {
  beforeEach(reset);

  it('selectSession clears the active draft pointer so its terminals cannot resurface', () => {
    // Draft with a terminal, then the user opens a real session instead.
    useUi.getState().startNewDraft();
    const draftId = useUi.getState().activeDraftId!;
    const staleKey = `draft:${draftId}`;
    useUi.getState().addTerminal(staleKey);

    useUi.getState().setActiveSession('s1');
    expect(useUi.getState().activeDraftId).toBeNull();
    expect(terminalScopeKey(useUi.getState())).toBe('s1');

    // After deleting that session (startNewDraft), the new-session screen
    // must not fall back to the abandoned draft's bucket.
    useUi.getState().startNewDraft();
    const freshKey = terminalScopeKey(useUi.getState());
    expect(freshKey).not.toBe(staleKey);
    expect(useUi.getState().terminals[freshKey] ?? []).toHaveLength(0);
  });

  it('deleting the active draft assigns a fresh slot, never the shared default bucket', () => {
    useUi.getState().startNewDraft();
    const draftId = useUi.getState().activeDraftId!;
    useUi.getState().addTerminal(`draft:${draftId}`);

    useUi.getState().deleteDraft(draftId);
    const state = useUi.getState();
    expect(state.activeDraftId).not.toBe(draftId);
    expect(state.activeDraftId).not.toBeNull();
    expect(terminalScopeKey(state)).not.toBe('default');
  });

  it('deleting a non-active draft leaves the current scope untouched', () => {
    useUi.getState().startNewDraft();
    const activeId = useUi.getState().activeDraftId!;
    useUi.getState().selectDraft(activeId);
    useUi.getState().deleteDraft('other-draft');
    expect(useUi.getState().activeDraftId).toBe(activeId);
  });
});
