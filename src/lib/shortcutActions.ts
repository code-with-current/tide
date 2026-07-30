/**
 * Shortcut action dispatcher — central registry of what each shortcut id DOES.
 *
 * Called from App.tsx's keydown handler once a combo matches; the handler
 * itself only does combo-matching and dispatch. Keeping the actions here (not
 * inline in App.tsx) makes them greppable, testable, and decoupled from the
 * React tree.
 *
 * Each action is a no-arg function that returns true if it actually handled
 * the action (so the caller can preventDefault), false if it was a no-op
 * (e.g. no active session). Actions read fresh state via useUi.getState() /
 * queryClient.getQueryData() — never close over stale captures.
 *
 * Caveats: actions that need component-internal UI state with no store hook
 * (rename inline input, worktree form) fall back to window.prompt() — the IPC
 * fires; the bespoke UI doesn't open. That's the honest best-effort given the
 * current architecture; lifting that state into the store is a separate
 * refactor.
 */
import type { Session } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { queryClient } from '@/lib/queries';
import { createLogger } from '@/lib/logger';

const log = createLogger('shortcut');

type Action = () => boolean;

/** Read the active session's pending permission tool-call ids (if any). */
function pendingToolCallIds(sid: string | null): string[] {
  if (!sid) return [];
  const stream = useUi.getState().streams[sid];
  return stream?.permissionRequest?.toolCalls.map((t) => t.id) ?? [];
}

// ─── Global ──────────────────────────────────────────────────────────────

const commandPalette: Action = () => {
  // CommandDialog isn't mounted anywhere yet (no command registry consumes
  // it). Flip a store flag here once it is; for now this is a no-op that
  // surfaces as "not yet wired" in the Settings screen via implemented:false.
  void useUi;
  return false;
};

const newSession: Action = () => {
  // Mirror the SessionsPanel "+ New" button: clear active session + show the
  // new-session view. The session is created lazily on first send.
  const ui = useUi.getState();
  ui.setActiveSession(null);
  ui.setMainView('new');
  return true;
};

const openSettings: Action = () => {
  useUi.getState().setScreen('settings');
  return true;
};

const closeWindow: Action = () => {
  // No quit IPC exists; window.close() is the renderer-standard way to close
  // the focused window. On macOS this hides rather than quits (matches native
  // app behavior); on Win/Linux it closes.
  window.close();
  return true;
};

// ─── Navigation ──────────────────────────────────────────────────────────

const requireMain: Action = () => {
  // Most navigation shortcuts only make sense on the main screen (not splash,
  // onboarding, or settings). Returns true when allowed; callers gate on this.
  return useUi.getState().screen === 'main';
};

const toggleWorkspaces: Action = () => {
  if (!requireMain()) return false;
  useUi.getState().toggleLeftPanel();
  return true;
};

const toggleSessions: Action = () => {
  if (!requireMain()) return false;
  useUi.getState().toggleSessionsPanel();
  return true;
};

const toggleRightPanel: Action = () => {
  if (!requireMain()) return false;
  useUi.getState().toggleRightPanel();
  return true;
};

// ─── Chat ────────────────────────────────────────────────────────────────

const abortTurn: Action = () => {
  const sid = useUi.getState().activeSessionId;
  if (!sid) return false;
  // Direct IPC — same path useChatStream().abort takes, without needing the
  // hook mounted. The orchestrator stops the turn; the stream's permission
  // prompt (if any) is also cleared so the UI dismisses immediately.
  window.tideIpc?.abortTurn(sid);
  useUi.getState().patchStream(sid, { permissionRequest: null });
  return true;
};

const dismissPrompt: Action = () => {
  // Esc dismisses: the model-emitted options popup, then any pending
  // permission card. Both live in different store slices; clear in order.
  const sid = useUi.getState().activeSessionId;
  if (sid) {
    const ui = useUi.getState();
    if (ui.pendingOptions[sid]) {
      ui.dismissOptionsPopup(sid);
      return true;
    }
    if (ui.streams[sid]?.permissionRequest) {
      ui.patchStream(sid, { permissionRequest: null });
      return true;
    }
  }
  return false;
};

const editLastMessage: Action = () => {
  // No edit-last-message flow exists in the codebase (the composer only sends
  // new messages). Wiring requires building the edit UI first; declared
  // implemented:false in the registry. No-op here.
  return false;
};

// ─── Sessions ────────────────────────────────────────────────────────────

/** Read the sessions list from the react-query cache for the active workspace. */
function readSessions(): Session[] {
  const wsId = useUi.getState().activeWorkspaceId;
  if (!wsId) return [];
  return queryClient.getQueryData<Session[]>(['sessions', wsId]) ?? [];
}

/** Cycle active session by delta (+1 next, -1 prev), wrapping at the ends. */
function cycleSession(delta: 1 | -1): boolean {
  if (!requireMain()) return false;
  const sessions = readSessions();
  if (sessions.length === 0) return false;
  const ui = useUi.getState();
  const currentIdx = sessions.findIndex((s) => s.id === ui.activeSessionId);
  // If no active session (or not found), delta-from-end gives a sensible
  // starting point: +1 → first, -1 → last.
  const startIdx = currentIdx === -1 ? (delta === 1 ? -1 : sessions.length) : currentIdx;
  const nextIdx = (startIdx + delta + sessions.length) % sessions.length;
  ui.setActiveSession(sessions[nextIdx].id);
  return true;
}

const nextSession: Action = () => cycleSession(1);
const prevSession: Action = () => cycleSession(-1);

const renameSession: Action = () => {
  const sid = useUi.getState().activeSessionId;
  if (!sid) return false;
  // The inline rename UI is component-local state in SessionsPanel with no
  // store hook, so we can't open it from here. Fall back to window.prompt for
  // the title — the rename IPC commits the change; the sidebar re-renders
  // from the react-query invalidation. Less polished than the inline input,
  // but functional.
  const sessions = readSessions();
  const current = sessions.find((s) => s.id === sid);
  const next = window.prompt('Rename session', current?.title ?? '');
  if (!next || !next.trim() || next === current?.title) return false;
  window.tideIpc?.renameSession(sid, next.trim());
  const wsId = useUi.getState().activeWorkspaceId;
  if (wsId) queryClient.invalidateQueries({ queryKey: ['sessions', wsId] });
  return true;
};

const deleteSession: Action = () => {
  const sid = useUi.getState().activeSessionId;
  if (!sid) return false;
  // deleteSession IPC throws if the session isn't archived first (see
  // SessionsPanel — Delete only shows for archived rows). Mirror the full
  // cleanup path from useDeleteSession: archive → delete → clear store state
  // → invalidate queries.
  const confirmed = window.confirm('Delete this session? This cannot be undone.');
  if (!confirmed) return false;
  const ui = useUi.getState();
  const wsId = ui.activeWorkspaceId;
  // Best-effort: archive then delete. If archive fails (already archived or
  // other), skip straight to delete — the IPC will throw there if not allowed.
  window.tideIpc?.archiveSession(sid).catch(() => {}).finally(() => {
    window.tideIpc?.deleteSession(sid).then(() => {
      useUi.getState().clearSessionData(sid);
      useTabs.getState().clearSessionTabs(sid);
      if (wsId) queryClient.invalidateQueries({ queryKey: ['sessions', wsId] });
      // Reset active session so the chat area shows the empty state.
      useUi.getState().setActiveSession(null);
      useUi.getState().setMainView('new');
    }).catch((e) => log.warn('deleteSession failed', e));
  });
  return true;
};

// ─── Tools ───────────────────────────────────────────────────────────────

const approvePermission: Action = () => {
  const sid = useUi.getState().activeSessionId;
  const ids = pendingToolCallIds(sid);
  if (ids.length === 0) return false;
  window.tideIpc?.approveToolCalls(sid!, ids);
  useUi.getState().removePermissionCards(sid!, ids);
  return true;
};

const rejectPermission: Action = () => {
  const sid = useUi.getState().activeSessionId;
  const ids = pendingToolCallIds(sid);
  if (ids.length === 0) return false;
  window.tideIpc?.rejectToolCalls(sid!, ids);
  useUi.getState().removePermissionCards(sid!, ids);
  return true;
};

const copyDiff: Action = () => {
  const sid = useUi.getState().activeSessionId;
  if (!sid) return false;
  const ui = useUi.getState();
  const files = ui.openFiles[sid];
  const activePath = ui.activeOpenFile[sid];
  const file = files?.find((f) => f.path === activePath);
  if (!file?.diffHunks?.length) return false;
  // Format the diff as unified-diff-ish text. No formatter exists in the
  // codebase (DiffView only renders), so build it here.
  const text = file.diffHunks
    .map((h) => `${h.header}\n${h.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`).join('\n')}`)
    .join('\n');
  navigator.clipboard.writeText(text).then(
    () => {},
    (e) => log.warn('copyDiff clipboard write failed', e),
  );
  return true;
};

const branchFromWorktree: Action = () => {
  const sid = useUi.getState().activeSessionId;
  if (!sid) return false;
  // The worktree form (branchName/baseBranch) lives in EmptyChatState and is
  // only shown at new-session creation — there's no store hook to open it for
  // an existing session. Fall back to prompts for the two required inputs,
  // then call the same createWorktree IPC MainScreen uses.
  const branch = window.prompt('New branch name');
  if (!branch?.trim()) return false;
  const base = window.prompt('Base branch', 'main') ?? 'main';
  window.tideIpc?.createWorktree(sid, { branchName: branch.trim(), baseBranch: base }).then(() => {
    queryClient.invalidateQueries({ queryKey: ['sessions', 'detail', sid] });
  }).catch((e) => log.warn('createWorktree failed', e));
  return true;
};

// ─── Registry ────────────────────────────────────────────────────────────

const ACTIONS: Record<string, Action> = {
  commandPalette,
  newSession,
  openSettings,
  closeWindow,
  toggleWorkspaces,
  toggleSessions,
  toggleRightPanel,
  toggleTerminal: () => {
    if (!requireMain()) return false;
    useUi.getState().toggleTerminal();
    return true;
  },
  toggleRightPanelBare: () => {
    if (!requireMain()) return false;
    useUi.getState().toggleRightPanel();
    return true;
  },
  abortTurn,
  dismissPrompt,
  editLastMessage,
  nextSession,
  prevSession,
  renameSession,
  deleteSession,
  approvePermission,
  rejectPermission,
  copyDiff,
  branchFromWorktree,
};

/** Dispatch a matched shortcut. Returns true if the action handled it (caller
 *  should preventDefault to swallow the keystroke), false if no-op. */
export function dispatchShortcut(actionId: string): boolean {
  const fn = ACTIONS[actionId];
  if (!fn) return false;
  try {
    return fn();
  } catch (e) {
    log.warn('action threw', actionId, e);
    return false;
  }
}
