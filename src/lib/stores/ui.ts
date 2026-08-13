import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AutonomyMode, ThinkingLevel, SessionStream, ToolCall, DiffHunk } from '@/types';
import { updateSessionSettings } from '@/lib/api/client';
import { setPlatformDefaults } from '@/lib/shortcuts';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui');

/** Sentinel key for the new-session (empty-state) composer, which has no
 *  sessionId yet. Per-session composer state (draft, attachments, pending
 *  paste reads) is keyed by sessionId — or this when no session exists yet. */
export const COMPOSER_NEW_KEY = '__new__';

export type ScreenName = 'splash' | 'onboarding' | 'consent' | 'main' | 'settings';

// Re-export for back-compat — ThinkingLevel now lives in @/types (with 'off' added).
export type { ThinkingLevel };

/** Persist per-session settings to the main process. Only autonomyMode/thinkingLevel are mutable (model is locked at creation; changing it requires forking). Fire-and-forget. */
function persistSessionSettings(
  sessionId: string,
  patch: { autonomyMode?: AutonomyMode; thinkingLevel?: ThinkingLevel },
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
  /** True while a Run-button-launched script runs in this terminal; flips to false on Stop (shell stays alive). Drives the ChatSubBar Run/Stop button — without it the button would never reset to Run. */
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
  /** When present, the viewer renders this content directly instead of
   *  reading from disk. Used for composer attachments whose inline content
   *  was already read (pasted files, browsed external files) and that may
   *  live outside the workspace. */
  inlineContent?: string;
  /** True for composer attachments (not workspace files) — the viewer must NEVER workspace-disk-read these (may live outside workspace; inline content gone after reload). An image attachment sets external=true with no inlineContent and shows a placeholder. */
  external?: boolean;
  /** Byte count of the original file, when known (shown in the header). */
  bytes?: number;
  /** True when the file is a binary image — the viewer renders an <img>
   *  preview instead of a text/code block. */
  isImage?: boolean;
  /** Absolute on-disk path for external files (browsed/pasted attachments).
   *  When set with external=true, the viewer reads via readExternalFile
   *  (no workspace sandbox). Survives reload because it's encoded in the
   *  content link target. */
  absPath?: string;
}

/** A file attached to the composer (browsed or pasted). Mirrors AttachedFile
 *  from the composer's AttachButton module; redeclared here so the store
 *  doesn't import from a component. */
export interface ComposerAttachment {
  path: string;
  kind: 'code' | 'image' | 'text' | 'paste';
  content?: string;
  bytes?: number;
  truncated?: boolean;
  /** Absolute on-disk path (when known). Browsed/pasted files keep it so the
   *  viewer can re-read the file via readExternalFile even after a reload,
   *  when the inline content is gone. The short display name stays in `path`. */
  absPath?: string;
}

/** Module-level stable empty array — never re-create the fallback, or
 *  Zustand's selector sees a "new" snapshot every render and loops. */
export const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachment[] = [];

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
  usage: null, sessionCostUsd: 0,
  iteration: 0,
  permissionRequest: null,
  isStreaming: false,
  error: null,
  retry: null,
  compacting: false,
  compactedTokens: null,
  stopReason: null,
  finalMessage: null,
});

/** Make a terminal name unique within a session by appending a numbered suffix ("name (1)", "name (2)") when the base name is taken — Finder/VS Code convention. The (N) suffix counts toward comparison so re-adding "test" with "test (1)" present lands on "test (2)". */
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
    usage: null, sessionCostUsd: 0, iteration: 0,
    permissionRequest: null, isStreaming: false, error: null, retry: null,
    compacting: false, compactedTokens: null, stopReason: null, finalMessage: null,
  };
}

/** Pending options popup keyed by session — the model emits an options block,
 *  the popup blocks the composer for THAT session only. */
export interface PendingOptions {
  question: string;
  multiple: boolean;
  options: string[];
  messageId: string;
  /** The ask_followup_question tool call id — required for live pause-and-resume (submitFollowup resolves the awaiting tool); undefined for the legacy persisted-followup path. */
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
  /** File-viewer panel width as a percentage of the card (25–70). Persisted. */
  fileViewerWidth: number;
  setFileViewerWidth: (w: number) => void;
  /** Commit shown in the floating commit-details panel; null while closed.
   *  Set from the Git Panel → History tab on row click. */
  commitDetail: { sha: string; author: string; date: string; subject: string } | null;
  setCommitDetail: (c: { sha: string; author: string; date: string; subject: string } | null) => void;
  leftPanelOpen: boolean;
  sessionsPanelOpen: boolean;
  /** Sidebar layout: 'dual' = separate workspace + sessions panels;
   *  'integrated' = sessions nested inside workspace items (single panel). */
  sidebarMode: 'dual' | 'integrated';
  setSidebarMode: (mode: 'dual' | 'integrated') => void;
  /** Width of the integrated sidebar in px (resizable via drag handle). */
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;

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

  /** Per-session options popup (model-emitted ```options block), keyed by sessionId so switching sessions doesn't dismiss or leak another session's popup. */
  pendingOptions: Record<string, PendingOptions>;

  /** Per-session streaming state (keyed by sessionId) so two sessions can stream in parallel without overwriting each other. Runtime only — not persisted. */
  streams: Record<string, SessionStream>;

  /** Per-session composer controls (kept here so chat and empty-state stay in sync). */
  selectedModelId: string | null;
  /** Provider half of the selection — kept alongside selectedModelId because the same modelId can exist under multiple providers (keying on modelId alone would silently resolve to the first-added). Null when restored from old sessions; callers fall back to first-match. */
  selectedProviderId: string | null;
  autonomyMode: AutonomyMode;
  thinkingLevel: ThinkingLevel;
  /** Starred model IDs (modelId strings). Starred models pin to the top of the picker. */
  starredModels: string[];
  /** Sessions currently running a turn — drives the pulsing-dot indicator in SessionsPanel and disables switching mid-stream. */
  runningSessionIds: string[];

  /** Sessions with an unread finished response (green dot) — cleared on view, like an inbox unread badge rather than a permanent "has messages" marker. */
  unreadSessionIds: string[];

  /** In-memory (not persisted) timestamps of when each session was last
   *  active (viewed). Used by the idle reaper to kill stale terminal PTYs. */
  sessionLastActive: Record<string, number>;

  /** Per-session outgoing message queue. Keyed by sessionId. */
  queue: Record<string, QueuedMessage[]>;

  /** Pre-turn git HEAD sha keyed by sessionId. Captured when a user sends a
   *  message so per-file undo can revert files to pre-turn state. */
  preTurnShas: Record<string, string>;
  /** Record the git HEAD sha for a session's turn (called before runTurn). */
  setPreTurnSha: (sessionId: string, sha: string) => void;

  /** Per-session prompt history for arrow-key navigation in the composer.
   *  Most-recent-first (index 0 = last sent). Capped at 50 entries. */
  promptHistory: Record<string, string[]>;
  /** Push a sent prompt to the session's history (deduped, most-recent-first). */
  pushPromptHistory: (sessionId: string, text: string) => void;

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

  /** Per-session composer attachments, keyed by sessionId (or COMPOSER_NEW_KEY
   *  for the empty-state composer). Keying per session isolates drafts so a
   *  pasted file / typed text in session A never leaks into session B — same
   *  model as the queue and prompt history. */
  composerAttachments: Record<string, ComposerAttachment[]>;
  /** Per-session in-flight paste-file reads; the active session's send button
   *  is gated on its own count reaching 0. */
  composerPendingReads: Record<string, number>;
  /** Per-session plain-text draft (keyed by sessionId, or COMPOSER_NEW_KEY).
   *  Restored into the contentEditable on mount so in-progress typing survives
   *  session switches. Runtime only — not persisted. */
  composerDrafts: Record<string, string>;

  /** Session ids whose title is currently being LLM-generated. Drives a
   *  shimmer animation on the sidebar title while the fire-and-forget
   *  generateSessionTitle call is in flight. */
  titleGeneratingSessionIds: Set<string>;

  // Composer attachment + draft actions (all keyed by sessionId-or-COMPOSER_NEW_KEY)
  addComposerAttachment: (key: string, f: ComposerAttachment) => void;
  removeComposerAttachment: (key: string, path: string) => void;
  clearComposerAttachments: (key: string) => void;
  bumpComposerPendingReads: (key: string, delta: number) => void;
  setComposerDraft: (key: string, text: string) => void;
  /** Title-generation flag actions (shimmer on the sidebar title). */
  addTitleGenerating: (sessionId: string) => void;
  removeTitleGenerating: (sessionId: string) => void;

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
  /** Optimistically drop resolved permission cards from a session's pending set so approve/reject dismisses immediately (used by both the inline TurnBlock card and the Inspector Review card). */
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

  // ─── Chat stream ────────────────────────────────────────────
  /** How the reasoning/thinking block renders in the chat stream.
   *  'flat' = one collapsible block (the original behaviour).
   *  'phased' = grouped into Planning / Search / Coding / Verifying segments. */
  reasoningView: 'flat' | 'phased';
  setReasoningView: (mode: 'flat' | 'phased') => void;

  // ─── Chat stream layout ─────────────────────────────────────
  /** How a turn renders. 'compact' = thinking + process grouped into
   *  collapsible sections (the default). 'stream' = every block shown
   *  inline in emission order, nothing hoisted or grouped. */
  chatView: 'compact' | 'stream';
  setChatView: (mode: 'compact' | 'stream') => void;

  // ─── Keyboard shortcut overrides ────────────────────────────
  /** Per-action key overrides on top of the registry defaults (keyed by ShortcutDef.id). Persisted to settings.json so they survive restart and are shared across windows; hydrated by loadShortcuts() at startup, empty {} until then. */
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
  fileViewerWidth: 50,
  setFileViewerWidth: (w) => set({ fileViewerWidth: Math.max(25, Math.min(70, w)) }),
  commitDetail: null,
  leftPanelOpen: true,
  sessionsPanelOpen: true,
  sidebarMode: 'integrated',
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
  sidebarWidth: 300,
  setSidebarWidth: (w) => set({ sidebarWidth: w }),

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
  preTurnShas: {},
  promptHistory: {},
  terminals: {},
  activeTerminal: {},
  terminalPorts: {},
  openFiles: {},
  activeOpenFile: {},
  composerAttachments: {},
  composerPendingReads: {},
  composerDrafts: {},
  titleGeneratingSessionIds: new Set<string>(),
  runningScripts: {},

  setScreen: (screen) => set({ screen }),
  setMainView: (mainView) => set({ mainView }),
  addComposerAttachment: (key, f) =>
    set((state) => {
      const list = state.composerAttachments[key] ?? [];
      return {
        composerAttachments: {
          ...state.composerAttachments,
          [key]: list.some((x) => x.path === f.path) ? list : [...list, f],
        },
      };
    }),
  removeComposerAttachment: (key, path) =>
    set((state) => ({
      composerAttachments: {
        ...state.composerAttachments,
        [key]: (state.composerAttachments[key] ?? []).filter((x) => x.path !== path),
      },
    })),
  clearComposerAttachments: (key) =>
    set((s) => ({ composerAttachments: { ...s.composerAttachments, [key]: [] } })),
  bumpComposerPendingReads: (key, delta) =>
    set((state) => ({
      composerPendingReads: {
        ...state.composerPendingReads,
        [key]: Math.max(0, (state.composerPendingReads[key] ?? 0) + delta),
      },
    })),
  setComposerDraft: (key, text) =>
    set((s) => ({ composerDrafts: { ...s.composerDrafts, [key]: text } })),
  // Set-based add/remove so the sidebar title re-renders (and starts/stops
  // shimmering) the instant the flag flips. New Set identity each update so
  // Zustand's shallow-equality subscribers detect the change.
  addTitleGenerating: (sessionId) =>
    set((state) => {
      if (state.titleGeneratingSessionIds.has(sessionId)) return {};
      return { titleGeneratingSessionIds: new Set(state.titleGeneratingSessionIds).add(sessionId) };
    }),
  removeTitleGenerating: (sessionId) =>
    set((state) => {
      if (!state.titleGeneratingSessionIds.has(sessionId)) return {};
      const next = new Set(state.titleGeneratingSessionIds);
      next.delete(sessionId);
      return { titleGeneratingSessionIds: next };
    }),
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
    const { [sessionId]: _ca, ...restComposerAttachments } = state.composerAttachments;
    const { [sessionId]: _cpr, ...restComposerPendingReads } = state.composerPendingReads;
    const { [sessionId]: _cd, ...restComposerDrafts } = state.composerDrafts;
    set({
      terminals: restTerminals,
      activeTerminal: restActiveTerminal,
      openFiles: restOpenFiles,
      activeOpenFile: restActiveOpenFile,
      streams: restStream,
      sessionLastActive: restLastActive,
      composerAttachments: restComposerAttachments,
      composerPendingReads: restComposerPendingReads,
      composerDrafts: restComposerDrafts,
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
  setCommitDetail: (c) => set({ commitDetail: c }),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleSessionsPanel: () => set((s) => ({ sessionsPanelOpen: !s.sessionsPanelOpen })),
  setSessionsPanel: (open) => set({ sessionsPanelOpen: open }),
  openDialog: (d) => set((s) => ({ dialogs: { ...s.dialogs, [d]: true } })),
  closeDialog: (d) => set((s) => ({ dialogs: { ...s.dialogs, [d]: false } })),
  closeAllDialogs: () => set({ dialogs: { addWorkspace: false, addProvider: false } }),
  setSelectedModel: (providerId, selectedModelId) => {
    set({ selectedProviderId: providerId, selectedModelId });
    // Model is locked at session creation — don't persist to an existing session.
    // This selection only affects the NEXT session created (new-session screen).
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

  /** Apply per-session settings from a freshly loaded session (called when the active session changes — restores the model/autonomy/thinking last used in this session). */
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

  setPreTurnSha: (messageId, sha) =>
    set((s) => ({ preTurnShas: { ...s.preTurnShas, [messageId]: sha } })),

  // Per-session prompt history for arrow-key navigation in the composer.
  // Most-recent-first; deduped against the last entry; capped at 50.
  pushPromptHistory: (sessionId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      const existing = s.promptHistory[sessionId] ?? [];
      // Dedupe against the most recent entry — avoids consecutive duplicates
      // when the user re-sends the same prompt (e.g. after a retry).
      if (existing[0] === trimmed) return s;
      const next = [trimmed, ...existing].slice(0, 50);
      return { promptHistory: { ...s.promptHistory, [sessionId]: next } };
    }),

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

  // ─── Chat stream ──────────────────────────────────────────────
  reasoningView: 'flat',
  chatView: 'compact',
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
  setReasoningView: (mode) => set({ reasoningView: mode }),
  setChatView: (mode) => set({ chatView: mode }),

  // ─── Keyboard shortcut overrides ────────────────────────────────────
  // Empty by default until loadShortcuts() hydrates from settings.json at startup. Actions update optimistically AND persist via IPC; the IPC response is authoritative, so we set again on resolve to converge with concurrent writers.
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
        sidebarMode: s.sidebarMode,
        sidebarWidth: s.sidebarWidth,
        rightPanelOpen: s.rightPanelOpen,
        fileViewerOpen: s.fileViewerOpen,
        fileViewerWidth: s.fileViewerWidth,
        terminalOpen: s.terminalOpen,
        terminalHeight: s.terminalHeight,
        terminals: s.terminals,
        fontScale: s.fontScale,
        reduceMotion: s.reduceMotion,
        terminalTheme: s.terminalTheme,
        terminalFontSize: s.terminalFontSize,
        appTheme: s.appTheme,
        reasoningView: s.reasoningView,
        chatView: s.chatView,
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
