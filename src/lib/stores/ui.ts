import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AutonomyMode, ThinkingLevel, SessionStream, ToolCall, DiffHunk } from '@/types';
import { updateSessionSettings } from '@/lib/api/client';
import { setPlatformDefaults } from '@/lib/shortcuts';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui');

export type ScreenName = 'splash' | 'onboarding' | 'main' | 'settings';

// Re-export for back-compat — ThinkingLevel now lives in @/types (with 'off' added).
export type { ThinkingLevel };

/**
 * Persist per-session settings to the main process. Fire-and-forget; the
 * in-memory state has already updated, and a failed persist just means the
 * change won't survive a restart.
 */
function persistSessionSettings(
  sessionId: string,
  patch: { modelId?: string; providerId?: string; autonomyMode?: AutonomyMode; thinkingLevel?: ThinkingLevel },
): void {
  try {
    void updateSessionSettings(sessionId, patch);
  } catch {
    // Silently ignore — settings still apply in-memory for this session.
  }
}

interface Dialogs {
  addWorkspace: boolean;
  addProvider: boolean;
}

/**
 * A message the user has queued for a session that's currently running a turn.
 * Drains into the session (as a real Message) when the turn finishes.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

/** A live terminal instance inside the bottom terminal panel. */
export interface TerminalInstance {
  id: string;
  name: string;
  createdAt: number;
  /** Command to inject into the PTY once it spawns. Set when addTerminal
   *  is called from the Run-script flow — the TerminalPanel effect reads
   *  and clears it after ipc.terminalStart resolves, so the bytes hit a
   *  real PTY instead of being dropped on a not-yet-existing id. */
  pendingCommand?: string;
  /** True while a script launched via the Run button is running in this
   *  terminal. Flips to false on Stop (the shell stays alive but the
   *  foreground process is dead). Drives the Run/Stop button state in
   *  ChatSubBar — without this we'd key off "tab exists" and the button
   *  would never flip back to Run after Stop. */
  scriptRunning?: boolean;
}

/** A file opened in the right-panel viewer (per session). */
export interface OpenFile {
  /** Stable id (usually the path itself). */
  id: string;
  /** Workspace-relative path, e.g. `src/parser.ts`. */
  path: string;
  /** Language for syntax hint (derived from extension). */
  language: string;
  /** Lines that should be highlighted as recently changed. */
  changedLines?: number[];
  /** When present, the viewer renders a diff (DiffView) instead of file content. */
  diffHunks?: DiffHunk[];
}

/** Default empty stream state. Used as the fallback when no entry exists
 *  for a session — selectors return this rather than undefined so consumers
 *  don't need null checks. Module-level for stable identity (prevents
 *  useSyncExternalStore infinite loops). */
export const EMPTY_STREAM: SessionStream = Object.freeze({
  text: '',
  reasoning: '',
  toolCalls: [],
  timeline: [],
  blocks: [],
  toolBlockIndex: {},
  turn: undefined,
  usage: null,
  iteration: 0,
  permissionRequest: null,
  isStreaming: false,
  error: null,
  stopReason: null,
  finalMessage: null,
});

/**
 * Make a terminal name unique within its session by appending a numbered
 * suffix when the base name is already taken. First collision → "name (1)",
 * next → "name (2)", etc. Matches the macOS Finder / VS Code convention.
 *
 *   ["Terminal 1"]              + "Terminal 1"  → "Terminal 1 (1)"
 *   ["test", "test (1)"]        + "test"        → "test (2)"
 *   ["npm run dev", "api"]      + "build"       → "build"
 *
 * The (N) suffix is treated as part of the comparison, so re-adding "test"
 * to a list that already has "test" and "test (1)" lands on "test (2)",
 * not "test (1) (1)".
 */
function dedupeTerminalName(base: string, existing: TerminalInstance[]): string {
  const taken = new Set(existing.map((t) => t.name));
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/** Helper to build a fresh empty stream. Returns a new object each call so
 *  callers can safely mutate it during construction. */
export function freshStream(): SessionStream {
  return {
    text: '', reasoning: '', toolCalls: [], timeline: [],
    blocks: [], toolBlockIndex: {},
    turn: undefined,
    usage: null, iteration: 0,
    permissionRequest: null, isStreaming: false, error: null,
    stopReason: null, finalMessage: null,
  };
}

/** Pending options popup keyed by session — the model emits an options block,
 *  the popup blocks the composer for THAT session only. */
export interface PendingOptions {
  question: string;
  multiple: boolean;
  options: string[];
  messageId: string;
  /** The ask_followup_question tool call id. Required for the new live
   *  pause-and-resume flow — the renderer calls submitFollowup(sessionId,
   *  toolCallId, answer) so the orchestrator can resolve the awaiting
   *  tool and continue the turn. Undefined for the legacy persisted-
   *  followup path (which goes through handleSend as a new user message). */
  toolCallId?: string;
}

interface UiState {
  screen: ScreenName;
  /** When on Main: show the running chat or the new-chat empty state. */
  mainView: 'chat' | 'new';

  activeWorkspaceId: string | null;
  activeSessionId: string | null;

  /** Panel visibility. */
  terminalOpen: boolean;
  rightPanelOpen: boolean;
  /** Dedicated file-viewer panel (separate from the tabbed right panel). */
  fileViewerOpen: boolean;
  leftPanelOpen: boolean;
  sessionsPanelOpen: boolean;

  /** Monotonic counter bumped to request that the SessionsPanel focus its
   *  search input. The action runs outside React (shortcutActions), so a nonce
   *  lets the panel react via a useEffect on the change. Bump → focus. */
  sessionSearchFocus: number;
  focusSessionSearch: () => void;

  /** Terminal panel height in pixels — draggable from its top edge. */
  terminalHeight: number;
  setTerminalHeight: (h: number) => void;

  /** Modal visibility. */
  dialogs: Dialogs;

  /**
   * Per-session options popup (model-emitted ```options block). Keyed by
   * sessionId so each session's popup is independent — switching sessions
   * doesn't dismiss or leak another session's popup. Consumers read the
   * active session's entry; undefined means no popup for that session.
   */
  pendingOptions: Record<string, PendingOptions>;

  /**
   * Per-session streaming state. Keyed by sessionId — each session has its
   * own text/toolCalls/reasoning/usage/etc. so two sessions can stream in
   * parallel without overwriting each other. Mirrors the queue/terminals/
   * openFiles pattern. Not persisted (runtime only).
   */
  streams: Record<string, SessionStream>;

  /** Per-session composer controls (kept here so chat and empty-state stay in sync). */
  selectedModelId: string | null;
  /**
   * Provider half of the selection. Kept alongside `selectedModelId` because
   * the same model id can exist under multiple providers (e.g. an Anthropic-
   * style and an OpenAI-style gateway exposing the same name); keying on
   * modelId alone silently resolves to the first-added provider. Null when
   * restored from an old session that didn't persist it — callers fall back
   * to first-match by modelId.
   */
  selectedProviderId: string | null;
  autonomyMode: AutonomyMode;
  thinkingLevel: ThinkingLevel;
  /** Starred model IDs (modelId strings). Starred models pin to the top of the picker. */
  starredModels: string[];
  /**
   * Sessions currently running a turn. Populated by the chat hook on
   * stream start/end. Drives the pulsing-dot indicator in SessionsPanel
   * and disables switching mid-stream.
   */
  runningSessionIds: string[];

  /**
   * Sessions with an unread finished response. Populated when a turn ends
   * (the green dot points the user to the new content). Cleared when the
   * user views the session — like an inbox unread badge, not a permanent
   * "has messages" marker.
   */
  unreadSessionIds: string[];

  /** In-memory (not persisted) timestamps of when each session was last
   *  active (viewed). Used by the idle reaper to kill stale terminal PTYs. */
  sessionLastActive: Record<string, number>;

  /** Per-session outgoing message queue. Keyed by sessionId. */
  queue: Record<string, QueuedMessage[]>;

  /** Per-session terminal tabs. Keyed by sessionId. Empty = panel collapsed. */
  terminals: Record<string, TerminalInstance[]>;
  activeTerminal: Record<string, string | undefined>;
  /** Ports detected in each terminal's output, keyed by terminalId.
   *  Populated by TerminalPanel from `terminal:ports` events emitted
   *  by the main-process PTY watcher. Read by ChatSubBar to render
   *  clickable dev-server badges. */
  terminalPorts: Record<string, { port: number; url: string; label: string }[]>;
  setTerminalPorts: (terminalId: string, ports: { port: number; url: string; label: string }[]) => void;

  /** Per-session file tabs opened in the right-panel viewer. */
  openFiles: Record<string, OpenFile[]>;
  activeOpenFile: Record<string, string | undefined>;

  // Actions
  setScreen: (s: ScreenName) => void;
  setMainView: (v: 'chat' | 'new') => void;
  setActiveWorkspace: (id: string | null) => void;
  setActiveSession: (id: string | null) => void;
  /** Purge all session-specific data (terminals, tabs, openFiles, streams).
   *  Kills PTYs via IPC. Called on session delete. */
  clearSessionData: (sessionId: string) => void;
  toggleTerminal: () => void;
  toggleRightPanel: () => void;
  /** Explicit open/close (the toggle needs to know current state; this doesn't). */
  setRightPanel: (open: boolean) => void;
  toggleFileViewer: () => void;
  toggleLeftPanel: () => void;
  toggleSessionsPanel: () => void;
  /** Explicit open/close for the sessions panel. */
  setSessionsPanel: (open: boolean) => void;
  openDialog: (d: keyof Dialogs) => void;
  closeDialog: (d: keyof Dialogs) => void;
  closeAllDialogs: () => void;
  setSelectedModel: (providerId: string | null, modelId: string | null) => void;
  setAutonomyMode: (m: AutonomyMode) => void;
  /** Apply per-session settings from a loaded session. Called on session switch. */
  applySessionSettings: (s: { modelId?: string | null; providerId?: string | null; autonomyMode?: AutonomyMode; thinkingLevel?: ThinkingLevel }) => void;
  /** Mark a session as running (or clear). Drives the indicator. */
  setSessionRunning: (sessionId: string, running: boolean) => void;
  /** Mark a session as having unread output (or clear on view). */
  markSessionUnread: (sessionId: string) => void;
  markSessionRead: (sessionId: string) => void;
  /** Show the options popup for a session (composer blocked while open). */
  showOptionsPopup: (sessionId: string, opts: Omit<PendingOptions, never>) => void;
  /** Dismiss the options popup for a session. */
  dismissOptionsPopup: (sessionId: string) => void;
  setThinkingLevel: (l: ThinkingLevel) => void;
  toggleStarredModel: (providerId: string, modelId: string) => void;

  // Stream actions — per-session streaming state (see SessionStream type).
  /** Get a session's stream (or EMPTY_STREAM if none). Read-only helper. */
  getStream: (sessionId: string) => SessionStream;
  /** Reset a session's stream to a fresh empty state (called by start()). */
  resetStream: (sessionId: string) => void;
  /** Shallow-merge a patch into a session's stream. */
  patchStream: (sessionId: string, patch: Partial<SessionStream>) => void;
  /** Optimistically drop resolved permission cards from a session's pending
   *  set (both the inline TurnBlock card and the Inspector Review card use
   *  this so approve/reject dismisses immediately, independent of the server
   *  side and of tool_result — which no longer wipes permissionRequest). */
  removePermissionCards: (sessionId: string, toolCallIds: string[]) => void;
  /** Update a session's toolCalls via an updater function (append/map). */
  setStreamToolCalls: (sessionId: string, updater: (calls: ToolCall[]) => ToolCall[]) => void;
  /** Clear the finalMessage slot for a session (after the freeze effect
   *  consumes it). Prevents re-processing on the next render. */
  clearFinalMessage: (sessionId: string) => void;
  /** Remove a session's stream entry entirely (session deleted). */
  removeStream: (sessionId: string) => void;

  // Queue actions
  enqueueMessage: (sessionId: string, text: string) => void;
  removeQueuedMessage: (sessionId: string, id: string) => void;
  editQueuedMessage: (sessionId: string, id: string, text: string) => void;
  reorderQueuedMessages: (sessionId: string, ids: string[]) => void;
  clearQueuedMessages: (sessionId: string) => void;

  // Terminal actions
  addTerminal: (sessionId: string, name?: string, pendingCommand?: string) => void;
  /** Mark a terminal's foreground script as stopped. The tab stays open
   *  (so the user can read tail output), but `scriptRunning` flips to
   *  false so the Run/Stop button in ChatSubBar resets. */
  markTerminalStopped: (terminalId: string) => void;
  closeTerminal: (sessionId: string, id: string) => void;
  setActiveTerminal: (sessionId: string, id: string) => void;
  renameTerminal: (sessionId: string, id: string, name: string) => void;

  // Open-file actions (right-panel viewer)
  openFile: (sessionId: string, file: OpenFile) => void;
  closeOpenFile: (sessionId: string, id: string) => void;
  setActiveOpenFile: (sessionId: string, id: string) => void;

  /** Per-session set of workspace script commands that are currently running. */
  runningScripts: Record<string, string[]>;

  startScript: (sessionId: string, command: string) => void;
  stopScript: (sessionId: string, command: string) => void;
  isScriptRunning: (sessionId: string, command: string) => boolean;

  // ─── Appearance settings ─────────────────────────────────────
  fontScale: number;
  reduceMotion: boolean;
  terminalTheme: string;
  terminalFontSize: number;
  appTheme: string;
  setAppearance: (patch: Partial<Pick<UiState, 'fontScale' | 'reduceMotion' | 'terminalTheme' | 'terminalFontSize' | 'appTheme'>>) => void;

  // ─── Keyboard shortcut overrides ────────────────────────────
  /** Per-action key overrides on top of the registry defaults. Keyed by
   *  ShortcutDef.id (see lib/shortcuts.ts); value is display tokens.
   *  Absent entry → use the platform default. Persisted to settings.json
   *  (via the tide:settings:* IPC) so custom bindings survive restart AND
   *  are shared across windows. Hydrated by loadShortcuts() on app startup;
   *  empty {} until that completes (callers fall through to defaults). */
  shortcutOverrides: Record<string, string[]>;
  /** Hydrate overrides + platform defaults from the backend settings.json.
   *  Called once at app startup; sets shortcutOverrides and seeds the
   *  registry's platform-default map so the renderer shows Ctrl on Win/Linux. */
  loadShortcuts: () => Promise<void>;
  /** Set (or clear, with null/[]) the binding for one action. Persists to
   *  settings.json via IPC; updates the in-memory store immediately so the
   *  UI reflects the change before the round-trip completes. */
  setShortcut: (id: string, keys: string[] | null) => void;
  /** Reset all overrides back to platform defaults. Persists via IPC. */
  resetShortcuts: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
  screen: 'splash',
  mainView: 'new',
  activeWorkspaceId: null,
  activeSessionId: null,
  terminalOpen: false,
  // 220 matches the long-standing fixed height — first-run default before
  // the user drags. Clamped to [120, 720] on resize (see TerminalPanel).
  terminalHeight: 220,
  setTerminalHeight: (h) => set({ terminalHeight: h }),
  rightPanelOpen: true,
  fileViewerOpen: false,
  leftPanelOpen: true,
  sessionsPanelOpen: true,

  sessionSearchFocus: 0,
  focusSessionSearch: () => set((s) => ({ sessionSearchFocus: s.sessionSearchFocus + 1 })),
  dialogs: { addWorkspace: false, addProvider: false },
  selectedModelId: null,
  selectedProviderId: null,
  autonomyMode: 'ask',
  thinkingLevel: 'medium',
  starredModels: [],
  runningSessionIds: [],
  unreadSessionIds: [],
  sessionLastActive: {},
  pendingOptions: {},
  streams: {},
  queue: {},
  terminals: {},
  activeTerminal: {},
  terminalPorts: {},
  openFiles: {},
  activeOpenFile: {},
  runningScripts: {},

  setScreen: (screen) => set({ screen }),
  setMainView: (mainView) => set({ mainView }),
  setActiveWorkspace: (activeWorkspaceId) =>
    set({ activeWorkspaceId, activeSessionId: null, mainView: 'new', sessionsPanelOpen: true }),
  setActiveSession: (activeSessionId) => {
    const now = Date.now();
    const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const state = get();

    // Reap idle terminals: kill PTYs for the PREVIOUS session if it's been
    // idle longer than the threshold. Only kills the PTY process — tab
    // metadata stays so the terminal can be recreated when the user returns.
    const prevSessionId = state.activeSessionId;
    if (prevSessionId && prevSessionId !== activeSessionId) {
      const lastActive = state.sessionLastActive[prevSessionId] ?? now;
      if (now - lastActive > IDLE_THRESHOLD) {
        const terms = state.terminals[prevSessionId] ?? [];
        for (const t of terms) {
          try { window.tideIpc?.terminalKill(t.id); } catch { /* dead */ }
        }
      }
    }

    // Stamp the new session as active now.
    const sessionLastActive = activeSessionId
      ? { ...state.sessionLastActive, [activeSessionId]: now }
      : state.sessionLastActive;

    set({ activeSessionId, mainView: 'chat', sessionLastActive });
  },

  clearSessionData: (sessionId) => {
    const state = get();
    // Kill all PTYs for this session.
    const terms = state.terminals[sessionId] ?? [];
    for (const t of terms) {
      try { window.tideIpc?.terminalKill(t.id); } catch { /* dead */ }
    }
    // Purge session-specific data from the UI store.
    const { [sessionId]: _t, ...restTerminals } = state.terminals;
    const { [sessionId]: _at, ...restActiveTerminal } = state.activeTerminal;
    const { [sessionId]: _of, ...restOpenFiles } = state.openFiles;
    const { [sessionId]: _aof, ...restActiveOpenFile } = state.activeOpenFile;
    const { [sessionId]: _s, ...restStream } = state.streams;
    const { [sessionId]: _la, ...restLastActive } = state.sessionLastActive;
    set({
      terminals: restTerminals,
      activeTerminal: restActiveTerminal,
      openFiles: restOpenFiles,
      activeOpenFile: restActiveOpenFile,
      streams: restStream,
      sessionLastActive: restLastActive,
    });
  },
  toggleTerminal: () =>
    set((s) => {
      const turningOn = !s.terminalOpen;
      // Auto-seed a terminal for the active session the first time the panel
      // is opened with zero terminals — saves the user an extra click.
      if (turningOn && s.activeSessionId) {
        const list = s.terminals[s.activeSessionId] ?? [];
        if (list.length === 0) {
          const id = `t_${Math.random().toString(36).slice(2, 9)}`;
          return {
            terminalOpen: true,
            terminals: {
              ...s.terminals,
              [s.activeSessionId]: [{ id, name: 'Terminal 1', createdAt: Date.now() }],
            },
            activeTerminal: { ...s.activeTerminal, [s.activeSessionId]: id },
          };
        }
      }
      return { terminalOpen: turningOn };
    }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanel: (open) => set({ rightPanelOpen: open }),
  toggleFileViewer: () => set((s) => ({ fileViewerOpen: !s.fileViewerOpen })),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleSessionsPanel: () => set((s) => ({ sessionsPanelOpen: !s.sessionsPanelOpen })),
  setSessionsPanel: (open) => set({ sessionsPanelOpen: open }),
  openDialog: (d) => set((s) => ({ dialogs: { ...s.dialogs, [d]: true } })),
  closeDialog: (d) => set((s) => ({ dialogs: { ...s.dialogs, [d]: false } })),
  closeAllDialogs: () => set({ dialogs: { addWorkspace: false, addProvider: false } }),
  setSelectedModel: (providerId, selectedModelId) => {
    set({ selectedProviderId: providerId, selectedModelId });
    // Persist to the active session, if any. Fire-and-forget; the api client
    // is safe to call from anywhere and we don't need to await it here.
    const sid = get().activeSessionId;
    if (sid && selectedModelId) {
      void persistSessionSettings(sid, { modelId: selectedModelId, providerId: providerId ?? undefined });
    }
  },
  setAutonomyMode: (autonomyMode) => {
    set({ autonomyMode });
    const sid = get().activeSessionId;
    if (sid) {
      void persistSessionSettings(sid, { autonomyMode });
      // Push the change to the running turn so subsequent tool calls in the
      // SAME stream use the new mode (without waiting for the next turn).
      window.tideIpc?.updateMode(sid, autonomyMode);
    }
  },
  setThinkingLevel: (thinkingLevel) => {
    set({ thinkingLevel });
    const sid = get().activeSessionId;
    if (sid) void persistSessionSettings(sid, { thinkingLevel });
  },
  toggleStarredModel: (providerId, modelId) => {
    // Star by composite key — the same modelId can exist under multiple
    // providers, so a bare-modelId star would mark every copy. Key mirrors
    // the dropdown row key (`${providerId}:${modelId}`).
    const key = `${providerId}:${modelId}`;
    set((s) => ({
      starredModels: s.starredModels.includes(key)
        ? s.starredModels.filter((id) => id !== key)
        : [...s.starredModels, key],
    }));
  },

  /**
   * Apply per-session settings from a freshly loaded session. Called when
   * the active session changes — restores the model/autonomy/thinking that
   * were last used in this session.
   */
  applySessionSettings: (s) =>
    set((state) => ({
      selectedModelId: s.modelId !== undefined ? s.modelId : state.selectedModelId,
      // Restore the provider half if the session persisted it; otherwise null
      // (pre-migration session) and useModelOption falls back to first-match.
      selectedProviderId: s.providerId !== undefined && s.providerId !== null ? s.providerId : null,
      autonomyMode: s.autonomyMode ?? state.autonomyMode,
      thinkingLevel: s.thinkingLevel ?? state.thinkingLevel,
    })),

  /** Mark a session as running or idle. No-op if state already matches. */
  setSessionRunning: (sessionId, running) =>
    set((state) => {
      const has = state.runningSessionIds.includes(sessionId);
      if (running && has) return state;
      if (!running && !has) return state;
      return {
        runningSessionIds: running
          ? [...state.runningSessionIds, sessionId]
          : state.runningSessionIds.filter((id) => id !== sessionId),
      };
    }),

  markSessionUnread: (sessionId) =>
    set((state) =>
      state.unreadSessionIds.includes(sessionId)
        ? state
        : { unreadSessionIds: [...state.unreadSessionIds, sessionId] },
    ),

  markSessionRead: (sessionId) =>
    set((state) => ({
      unreadSessionIds: state.unreadSessionIds.filter((id) => id !== sessionId),
    })),

  showOptionsPopup: (sessionId, opts) =>
    set((s) => ({ pendingOptions: { ...s.pendingOptions, [sessionId]: opts } })),

  dismissOptionsPopup: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.pendingOptions)) return s;
      const next = { ...s.pendingOptions };
      delete next[sessionId];
      return { pendingOptions: next };
    }),

  // ─── Per-session streaming state ─────────────────────────────────────────
  getStream: (sessionId) => get().streams[sessionId] ?? EMPTY_STREAM,

  resetStream: (sessionId) =>
    set((s) => ({ streams: { ...s.streams, [sessionId]: freshStream() } })),

  patchStream: (sessionId, patch) =>
    set((s) => {
      const cur = s.streams[sessionId] ?? freshStream();
      return { streams: { ...s.streams, [sessionId]: { ...cur, ...patch } } };
    }),

  removePermissionCards: (sessionId, toolCallIds) =>
    set((s) => {
      const cur = s.streams[sessionId];
      if (!cur?.permissionRequest) return {} as Partial<typeof s>;
      const remove = new Set(toolCallIds);
      const remaining = cur.permissionRequest.toolCalls.filter((t) => !remove.has(t.id));
      return {
        streams: {
          ...s.streams,
          [sessionId]: {
            ...cur,
            permissionRequest: remaining.length
              ? { ...cur.permissionRequest, toolCalls: remaining }
              : null,
          },
        },
      };
    }),

  setStreamToolCalls: (sessionId, updater) =>
    set((s) => {
      const cur = s.streams[sessionId] ?? freshStream();
      return { streams: { ...s.streams, [sessionId]: { ...cur, toolCalls: updater(cur.toolCalls) } } };
    }),

  clearFinalMessage: (sessionId) =>
    set((s) => {
      const cur = s.streams[sessionId];
      if (!cur || !cur.finalMessage) return s;
      return { streams: { ...s.streams, [sessionId]: { ...cur, finalMessage: null } } };
    }),

  removeStream: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.streams)) return s;
      const next = { ...s.streams };
      delete next[sessionId];
      return { streams: next };
    }),

  enqueueMessage: (sessionId, text) =>
    set((s) => {
      const next: QueuedMessage[] = [
        ...(s.queue[sessionId] ?? []),
        { id: `q_${Math.random().toString(36).slice(2, 9)}`, text, createdAt: Date.now() },
      ];
      return { queue: { ...s.queue, [sessionId]: next } };
    }),
  removeQueuedMessage: (sessionId, id) =>
    set((s) => ({
      queue: {
        ...s.queue,
        [sessionId]: (s.queue[sessionId] ?? []).filter((m) => m.id !== id),
      },
    })),
  editQueuedMessage: (sessionId, id, text) =>
    set((s) => ({
      queue: {
        ...s.queue,
        [sessionId]: (s.queue[sessionId].map((m) => (m.id === id ? { ...m, text } : m))),
      },
    })),
  reorderQueuedMessages: (sessionId, ids) =>
    set((s) => {
      const byId = new Map((s.queue[sessionId] ?? []).map((m) => [m.id, m]));
      return { queue: { ...s.queue, [sessionId]: ids.map((id) => byId.get(id)!).filter(Boolean) } };
    }),
  clearQueuedMessages: (sessionId) =>
    set((s) => ({ queue: { ...s.queue, [sessionId]: [] } })),

  // ─── Per-session terminal tabs ───────────────────────────────────────────
  addTerminal: (sessionId, name, pendingCommand) =>
    set((s) => {
      const list = s.terminals[sessionId] ?? [];
      const id = `t_${Math.random().toString(36).slice(2, 9)}`;
      const baseName = name ?? `Terminal ${list.length + 1}`;
      const uniqueName = dedupeTerminalName(baseName, list);
      const next: TerminalInstance = {
        id,
        name: uniqueName,
        createdAt: Date.now(),
        pendingCommand,
        // Spawned from the Run button iff a pendingCommand was supplied.
        // Plain "+" new terminals (no command) get undefined → treated as
        // not-running, so they don't light up the Run/Stop button.
        scriptRunning: !!pendingCommand,
      };
      return {
        terminals: { ...s.terminals, [sessionId]: [...list, next] },
        activeTerminal: { ...s.activeTerminal, [sessionId]: id },
      };
    }),
  markTerminalStopped: (terminalId) =>
    set((s) => {
      // Find which session owns this terminal — the caller (ChatSubBar)
      // only knows the id, not the session.
      for (const [sid, list] of Object.entries(s.terminals)) {
        if (list.some((t) => t.id === terminalId)) {
          return {
            terminals: {
              ...s.terminals,
              [sid]: list.map((t) =>
                t.id === terminalId ? { ...t, scriptRunning: false } : t,
              ),
            },
            // Clear this terminal's ports too — the process is dead, so its
            // exposed dev-server port is no longer reachable. Keeps port
            // badges in sync when a process dies (crash / external kill),
            // not just on a user-initiated Stop.
            terminalPorts: Object.fromEntries(
              Object.entries(s.terminalPorts).filter(([k]) => k !== terminalId),
            ),
          };
        }
      }
      return {};
    }),
  closeTerminal: (sessionId, id) =>
    set((s) => {
      const list = (s.terminals[sessionId] ?? []).filter((t) => t.id !== id);
      const currentActive = s.activeTerminal[sessionId];
      const newActive =
        currentActive === id
          ? list.length
            ? list[list.length - 1].id
            : undefined
          : currentActive;
      // Auto-collapse the panel when the active session runs out of
      // terminals. Scoped to the active session — closing terminals in a
      // background session (which the panel isn't showing anyway) shouldn't
      // collapse the panel out from under the user.
      const collapsePanel =
        list.length === 0 && s.activeSessionId === sessionId;
      return {
        terminals: { ...s.terminals, [sessionId]: list },
        activeTerminal: { ...s.activeTerminal, [sessionId]: newActive },
        // Drop any ports detected for the closed terminal — the dev
        // server behind them is gone.
        ...(s.terminalPorts[id]
          ? { terminalPorts: Object.fromEntries(Object.entries(s.terminalPorts).filter(([k]) => k !== id)) }
          : {}),
        ...(collapsePanel ? { terminalOpen: false } : {}),
      };
    }),
  setActiveTerminal: (sessionId, id) =>
    set((s) => ({ activeTerminal: { ...s.activeTerminal, [sessionId]: id } })),
  setTerminalPorts: (terminalId, ports) =>
    set((s) => ({ terminalPorts: { ...s.terminalPorts, [terminalId]: ports } })),
  renameTerminal: (sessionId, id, name) =>
    set((s) => ({
      terminals: {
        ...s.terminals,
        [sessionId]: (s.terminals[sessionId] ?? []).map((t) =>
          t.id === id ? { ...t, name } : t,
        ),
      },
    })),

  // ─── Open-file (right-panel viewer) ───────────────────────────────────────
  openFile: (sessionId, file) =>
    set((s) => {
      const list = s.openFiles[sessionId] ?? [];
      // Opening a file reveals the dedicated File Viewer panel.
      if (list.some((f) => f.id === file.id)) {
        // Already open — just focus it.
        return {
          activeOpenFile: { ...s.activeOpenFile, [sessionId]: file.id },
          fileViewerOpen: true,
        };
      }
      return {
        openFiles: { ...s.openFiles, [sessionId]: [...list, file] },
        activeOpenFile: { ...s.activeOpenFile, [sessionId]: file.id },
        fileViewerOpen: true,
      };
    }),
  closeOpenFile: (sessionId, id) =>
    set((s) => {
      const list = (s.openFiles[sessionId] ?? []).filter((f) => f.id !== id);
      const current = s.activeOpenFile[sessionId];
      const next = current === id ? (list[list.length - 1]?.id ?? undefined) : current;
      // Auto-close the panel when the last file is closed.
      const closePanel = list.length === 0;
      return {
        openFiles: { ...s.openFiles, [sessionId]: list },
        activeOpenFile: { ...s.activeOpenFile, [sessionId]: next },
        ...(closePanel ? { fileViewerOpen: false } : {}),
      };
    }),
  setActiveOpenFile: (sessionId, id) =>
    set((s) => ({ activeOpenFile: { ...s.activeOpenFile, [sessionId]: id } })),

  // ─── Running scripts ────────────────────────────────────────────────────
  startScript: (sessionId, command) =>
    set((s) => {
      const list = s.runningScripts[sessionId] ?? [];
      if (list.includes(command)) return s;
      return { runningScripts: { ...s.runningScripts, [sessionId]: [...list, command] } };
    }),
  stopScript: (sessionId, command) =>
    set((s) => ({
      runningScripts: {
        ...s.runningScripts,
        [sessionId]: (s.runningScripts[sessionId] ?? []).filter((c) => c !== command),
      },
    })),
    isScriptRunning: (sessionId, command) => {
      const list = get().runningScripts[sessionId] ?? [];
      return list.includes(command);
    },

  // ─── Appearance ──────────────────────────────────────────────
  fontScale: 14,
  reduceMotion: false,
  terminalTheme: 'tide-dark',
  terminalFontSize: 11,
  appTheme: 'tide',
  setAppearance: (patch) => {
    set(patch);
    const state = get();
    if (patch.fontScale !== undefined) {
      document.documentElement.style.fontSize = `${state.fontScale}px`;
    }
    if (patch.appTheme !== undefined) {
      document.documentElement.setAttribute('data-theme', state.appTheme);
    }
    if (patch.reduceMotion !== undefined) {
      document.documentElement.classList.toggle('reduce-motion', patch.reduceMotion);
    }
  },

  // ─── Keyboard shortcut overrides ────────────────────────────────────
  // Empty by default — every action uses its registry default until loadShortcuts
  // hydrates from settings.json (called once at app startup). The actions
  // update the in-memory store immediately (optimistic) AND fire the IPC to
  // persist; the IPC's response is the authoritative post-write state, so we
  // set again on resolve to converge with any concurrent writer.
  shortcutOverrides: {},
  loadShortcuts: async () => {
    try {
      const result = await window.tideIpc?.getSettings();
      if (!result) return;
      // Seed the registry's platform-default map so the renderer (which can't
      // detect the OS) renders Ctrl on Windows/Linux instead of the macOS ⌘
      // fallback baked into SHORTCUTS.
      setPlatformDefaults(result.defaults ?? null);
      set({ shortcutOverrides: result.overrides ?? {} });
    } catch (e) {
      log.warn('loadShortcuts failed; using hardcoded defaults', e);
    }
  },
  setShortcut: (id, keys) => {
    // Optimistic local update — the UI reflects the change immediately.
    set((s) => {
      const next = { ...s.shortcutOverrides };
      if (!keys || keys.length === 0) delete next[id];
      else next[id] = keys;
      return { shortcutOverrides: next };
    });
    // Persist to settings.json. The IPC returns the full post-write override
    // set; set again to converge (and to pick up any normalization the
    // backend might do in future).
    window.tideIpc?.setShortcut(id, keys).then((overrides) => {
      if (overrides) set({ shortcutOverrides: overrides });
    }).catch((e) => log.warn('setShortcut IPC failed', e));
  },
  resetShortcuts: () => {
    set({ shortcutOverrides: {} });
    window.tideIpc?.resetShortcuts().then((overrides) => {
      if (overrides) set({ shortcutOverrides: overrides });
    }).catch((e) => log.warn('resetShortcuts IPC failed', e));
  },
    }),
    {
      name: 'tide-ui-state',
      // Persist layout + settings that should survive restarts.
      // Terminal tab structure persists (names, count, active) but the
      // shell processes themselves restart fresh — can't keep a PTY
      // alive across app restarts without tmux.
      partialize: (s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        activeSessionId: s.activeSessionId,
        selectedModelId: s.selectedModelId,
        selectedProviderId: s.selectedProviderId,
        autonomyMode: s.autonomyMode,
        thinkingLevel: s.thinkingLevel,
        starredModels: s.starredModels,
        leftPanelOpen: s.leftPanelOpen,
        sessionsPanelOpen: s.sessionsPanelOpen,
        rightPanelOpen: s.rightPanelOpen,
        fileViewerOpen: s.fileViewerOpen,
        terminalOpen: s.terminalOpen,
        terminalHeight: s.terminalHeight,
        terminals: s.terminals,
        fontScale: s.fontScale,
        reduceMotion: s.reduceMotion,
        terminalTheme: s.terminalTheme,
        terminalFontSize: s.terminalFontSize,
        appTheme: s.appTheme,
        activeTerminal: s.activeTerminal,
        // shortcutOverrides is intentionally NOT persisted here — it lives in
        // settings.json (via the tide:settings:* IPC) so it's shared across
        // windows and platform-aware. Hydrated by loadShortcuts() at startup.
      }),
      // Don't restore screen — splash always routes first to validate providers/workspaces.
      // mainView is also runtime state — start at 'new' each load.
      version: 1,
    },
  ),
);
