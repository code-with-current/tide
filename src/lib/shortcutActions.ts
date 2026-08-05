/** Shortcut action dispatcher — central registry mapping shortcut ids to handler functions. */
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
  // ⌘K / Ctrl+K focuses the SessionsPanel search box on the main screen.
  if (useUi.getState().screen !== 'main') return false;
  if (!useUi.getState().sessionsPanelOpen) {
    useUi.getState().toggleSessionsPanel();
  }
  useUi.getState().focusSessionSearch();
  return true;
};

const newSession: Action = () => {
  // Clear active session and show the new-session view.
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
  // window.close() hides on macOS, closes on Win/Linux.
  window.close();
  return true;
};

// ─── Navigation ──────────────────────────────────────────────────────────

const requireMain: Action = () => {
  // Gate: only allow shortcuts on the main screen.
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
  // Direct IPC abort; clears permission prompt too.
  window.tideIpc?.abortTurn(sid);
  useUi.getState().patchStream(sid, { permissionRequest: null });
  return true;
};

const dismissPrompt: Action = () => {
  // Esc dismisses: options popup first, then permission card.
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
  // Not yet implemented — no edit-last-message flow exists.
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
  // No active session: +1 → first, -1 → last.
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
  // Falls back to window.prompt (inline rename is component-local state).
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
  // Mirror useDeleteSession: confirm → archive → delete → clear state.
  const confirmed = window.confirm('Delete this session? This cannot be undone.');
  if (!confirmed) return false;
  const ui = useUi.getState();
  const wsId = ui.activeWorkspaceId;
  // Best-effort: skip archive on failure, go straight to delete.
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
  // Format diff hunks as unified-diff text (no formatter exists in codebase).
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
  // Falls back to prompts (worktree form is component-local in EmptyChatState).
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

/** Dispatch a matched shortcut. Returns true if handled (caller should preventDefault). */
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
