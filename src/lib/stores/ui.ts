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

/** Attachment path that carries the forked session's last answer into the
 *  new-session composer. Defined here (next to the composer keys it rides
 *  in) so the store can keep `pendingFork` and its attachment paired: every
 *  path that clears the intent also drops this attachment, so an abandoned
 *  fork never leaks its context into the next plain new session. */
export const FORK_ATTACHMENT_PATH = 'fork-result.md';

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
  /** Display text — what the user typed. Shown in the queue preview and
   *  stored as message.content in the chat bubble. */
  text: string;
  /** Enriched text — display text + inlined attachment/skill content. Sent
   *  to the orchestrator when the queue drains. Undefined when there are no
   *  attachments (falls back to `text`). */
  promptText?: string;
  /** System-generated (background dispatch result), not user-typed: no drag/
   *  edit/send-now affordances, rendered with a ↻ glyph. */
  synthetic?: boolean;
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

/** A draft (unsent) session. Created the moment the user types in the
 *  new-session composer; shows in the session list as "(draft) …" until
 *  the message is sent (promoted to a real Session) or the text is cleared.
 *  The composer text itself lives in `composerDrafts[id]` — this record
 *  only holds list metadata. Runtime only — not persisted. */
/** Fork intent shown on the new-session screen while the user hasn't sent
 *  yet. `origin` distinguishes how the fork started so the screen can say
 *  why the user landed there (model switch vs. explicit fork). */
export interface PendingFork {
  sourceSessionId: string;
  sourceTitle: string;
  sourceModelId: string;
  origin: 'menu' | 'result' | 'model';
}

export interface DraftSession {
  id: string;
  workspaceId: string;
  updatedAt: number;
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

/** Terminal-panel bucket key. Real sessions key by sessionId; the
 *  new-session draft screen keys by its draft id so terminals opened while
 *  composing belong to THAT draft instead of a shared bucket every later
 *  draft (and the next session's composer) would read; 'default' only when
 *  neither exists (no workspace selected). Draft keys are prefixed so they
 *  can never collide with a real session id. */
export function terminalScopeKey(s: { activeSessionId: string | null; activeDraftId: string | null }): string {
  if (s.activeSessionId) return s.activeSessionId;
  if (s.activeDraftId) return `draft:${s.activeDraftId}`;
  return 'default';
}

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
  /** Optional per-option one-liners, parallel to `options` (same index). Undefined entries = no description. */
  optionDescriptions?: (string | undefined)[];
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

  /** Panel visibility, keyed per terminal scope (session id / draft id) so each session remembers its own open state. */
  terminalOpen: Record<string, boolean>;
  /** Native window fullscreen state, bridged from main. The macOS
   *  traffic-light spacer collapses to zero while fullscreen (buttons hide). */
  isFullScreen: boolean;
  rightPanelOpen: boolean;
  /** Dedicated file-viewer panel (separate from the tabbed right panel). */
  fileViewerOpen: boolean;
  /** Right-sheet (file viewer / commit details) width as a viewport percentage (25–70). Persisted. */
  sheetWidth: number;
  setSheetWidth: (w: number) => void;
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

  /** Terminal panel height in pixels per scope — draggable from its top edge. */
  terminalHeight: Record<string, number>;
  setTerminalHeight: (h: number) => void;

  /** Modal visibility. */
  dialogs: Dialogs;

  /** Per-session options popup (model-emitted ```options block), keyed by sessionId so switching sessions doesn't dismiss or leak another session's popup. */
  pendingOptions: Record<string, PendingOptions>;

  /** Per-session streaming state (keyed by sessionId) so two sessions can stream in parallel without overwriting each other. Runtime only — not persisted. */
  streams: Record<string, SessionStream>;

  /** Focused sub-agent dispatch per session (the dispatch ToolCall's id) —
   *  drives the docked Agents panel's stream view. Runtime only — not
   *  persisted. */
  focusedDispatchId: Record<string, string | null>;
  /** Focus (or clear, with null) the dispatch whose stream the Agents panel shows. */
  setFocusedDispatch: (sessionId: string, dispatchId: string | null) => void;
  /** Docked Agents panel visibility. Opened only by dispatch-row clicks,
   *  closed by its header X. Runtime only — not persisted; forced false on
   *  startup like terminalOpen. Focus is kept on close so reopening returns. */
  agentsPanelOpen: boolean;
  setAgentsPanelOpen: (open: boolean) => void;

  /** Per-session composer controls (kept here so chat and empty-state stay in sync). */
  selectedModelId: string | null;
  /** Provider half of the selection — kept alongside selectedModelId because the same modelId can exist under multiple providers (keying on modelId alone would silently resolve to the first-added). Null when restored from old sessions; callers fall back to first-match. */
  selectedProviderId: string | null;
  autonomyMode: AutonomyMode;
  thinkingLevel: ThinkingLevel;
  /** Per-session composer settings keyed by session id — the source of truth on session switch. The global fields mirror the ACTIVE session's entry (applied synchronously in setActiveSession) so existing selectors keep working. */
  sessionSettings: Record<string, { modelId: string | null; providerId: string | null; autonomyMode: AutonomyMode; thinkingLevel: ThinkingLevel }>;
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
   *  session switches. Persisted to localStorage so drafts survive restarts. */
  composerDrafts: Record<string, string>;

  /** Draft (unsent) sessions, keyed by draft id. Each entry's text lives in
   *  `composerDrafts[id]`; this map holds only list metadata. Persisted. */
  draftSessions: Record<string, DraftSession>;
  /** The draft currently loaded in the new-session composer (null on the
   *  chat screen or before any new-session screen has been shown). */
  activeDraftId: string | null;

  /** Last-dismissed todo-panel signature per session (the settled list the
   *  user dismissed). The floating panel stays hidden across session
   *  switches and restarts until the todo list changes again. Persisted. */
  dismissedTodoSignatures: Record<string, string>;
  setDismissedTodo: (sessionId: string, signature: string) => void;

  /** Fork intent for the new-session screen — set by initiateFork (sidebar
   *  "Fork…", an answer's Fork button, or clicking the locked model
   *  selector). Drives the fork variant of EmptyChatState (hero + banner)
   *  so a fork looks different from a plain new session. Transient: cleared
   *  on send, dismissal, or any navigation that leaves the fork draft. */
  pendingFork: PendingFork | null;

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

  // Draft (unsent) session lifecycle — backs the "Drafts" section of the
  // session list. Text is stored in composerDrafts[id]; these manage the
  // list entries + which draft the new-session composer is bound to.
  /** Open a fresh blank new-session composer (new activeDraftId). */
  startNewDraft: () => void;
  /** Create/update the active draft from live composer text; removes the
   *  draft entry when text is empty so the list stays clean. */
  touchDraft: (workspaceId: string, text: string) => void;
  /** Load an existing draft into the new-session composer. */
  selectDraft: (id: string) => void;
  /** Remove the active draft (called after it's promoted to a real session). */
  consumeDraft: () => void;
  /** Permanently delete a draft by id. */
  deleteDraft: (id: string) => void;
  /** Set/clear the fork intent shown on the new-session screen. */
  setPendingFork: (fork: PendingFork | null) => void;
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
  applySessionSettings: (sessionId: string, s: { modelId?: string | null; providerId?: string | null; autonomyMode?: AutonomyMode; thinkingLevel?: ThinkingLevel }) => void;
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
  enqueueMessage: (sessionId: string, text: string, promptText?: string, synthetic?: boolean) => void;
  removeQueuedMessage: (sessionId: string, id: string) => void;
  editQueuedMessage: (sessionId: string, id: string, text: string) => void;
  reorderQueuedMessages: (sessionId: string, ids: string[]) => void;
  clearQueuedMessages: (sessionId: string) => void;

  // Terminal actions
  addTerminal: (sessionId: string, name?: string, pendingCommand?: string) => void;
  /** Move the ACTIVE draft's terminal bucket under the promoted session's
   *  id. Called when the draft's first message creates the real session —
   *  terminals opened while composing would otherwise die with the draft. */
  adoptDraftTerminals: (sessionId: string) => void;
  /** Kill PTYs for and drop a draft's terminal bucket (draft deleted or
   *  abandoned without sending). */
  purgeDraftTerminals: (draftId: string) => void;
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

  // ─── Diff viewer ────────────────────────────────────────────
  /** How diffs render. 'unified' = single column (default). 'split' =
   *  side-by-side old/new with word-level highlights on paired lines. */
  diffMode: 'unified' | 'split';
  setDiffMode: (mode: 'unified' | 'split') => void;

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
  terminalOpen: {},
  isFullScreen: false,
  // 220 matches the long-standing fixed height — first-run default before
  // the user drags. Clamped to [120, 720] on resize (see TerminalPanel).
  terminalHeight: {},
  setTerminalHeight: (h: number) => set((s) => ({ terminalHeight: { ...s.terminalHeight, [terminalScopeKey(s)]: h } })),
  rightPanelOpen: true,
  fileViewerOpen: false,
  sheetWidth: 40,
  setSheetWidth: (w) => set({ sheetWidth: Math.max(25, Math.min(70, w)) }),
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
  sessionSettings: {},
  starredModels: [],
  runningSessionIds: [],
  unreadSessionIds: [],
  sessionLastActive: {},
  pendingOptions: {},
  streams: {},
  focusedDispatchId: {},
  setFocusedDispatch: (sessionId, dispatchId) =>
    set((s) => ({ focusedDispatchId: { ...s.focusedDispatchId, [sessionId]: dispatchId } })),
  agentsPanelOpen: false,
  setAgentsPanelOpen: (open) => set({ agentsPanelOpen: open }),
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
  draftSessions: {},
  dismissedTodoSignatures: {},
  pendingFork: null,
  activeDraftId: null,
  titleGeneratingSessionIds: new Set<string>(),
  runningScripts: {},

  setScreen: (screen) => set({ screen }),
  setDismissedTodo: (sessionId, signature) =>
    set((state) => {
      const next = { ...state.dismissedTodoSignatures };
      delete next[sessionId];
      next[sessionId] = signature;
      const keys = Object.keys(next);
      if (keys.length > 50) delete next[keys[0]];
      return { dismissedTodoSignatures: next };
    }),
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

  startNewDraft: () => {
    const workspaceId = get().activeWorkspaceId;
    // Only assign a draft slot when there's a workspace to bind it to —
    // the no-workspace screen shows a placeholder, not a composer.
    set({
      activeDraftId: workspaceId ? crypto.randomUUID() : null,
      activeSessionId: null,
      mainView: 'new',
    });
    get().setPendingFork(null);
  },
  touchDraft: (workspaceId, text) => {
    const id = get().activeDraftId;
    if (!id) return;
    // Empty text → drop the list entry (the draft id persists in
    // activeDraftId so the composer keeps its slot; it just hides from
    // the list until the user types again).
    if (!text.trim()) {
      if (!get().draftSessions[id]) return;
      const { [id]: _d, ...rest } = get().draftSessions;
      set({ draftSessions: rest });
      return;
    }
    // One draft per workspace: saving this draft drops any other entry
    // belonging to the same workspace (their composer text goes with it —
    // only one draft can exist, so older ones are stale by definition).
    const draftSessions = { ...get().draftSessions };
    const composerDrafts = { ...get().composerDrafts };
    for (const other of Object.values(draftSessions)) {
      if (other.id !== id && other.workspaceId === workspaceId) {
        get().purgeDraftTerminals(other.id);
        delete draftSessions[other.id];
        delete composerDrafts[other.id];
      }
    }
    draftSessions[id] = { id, workspaceId, updatedAt: Date.now() };
    set({ draftSessions, composerDrafts });
  },
  selectDraft: (id) => {
    set({ activeDraftId: id, activeSessionId: null, mainView: 'new' });
    get().setPendingFork(null);
  },
  consumeDraft: () => {
    const id = get().activeDraftId;
    if (!id) return;
    // After promotion adoptDraftTerminals already emptied the bucket, so
    // this is a no-op then; for any other consume path it kills stray PTYs.
    get().purgeDraftTerminals(id);
    const { [id]: _ds, ...restDrafts } = get().draftSessions;
    const { [id]: _cd, ...restComposer } = get().composerDrafts;
    set({ draftSessions: restDrafts, composerDrafts: restComposer, activeDraftId: null });
    get().setPendingFork(null);
  },
  deleteDraft: (id) => {
    get().purgeDraftTerminals(id);
    const { [id]: _ds, ...restDrafts } = get().draftSessions;
    const { [id]: _cd, ...restComposer } = get().composerDrafts;
    const patch: Partial<UiState> = {
      draftSessions: restDrafts,
      composerDrafts: restComposer,
    };
    // Deleting the active draft keeps the user on the new-session screen —
    // assign a fresh slot immediately rather than leaving the pointer null,
    // where the terminal scope would fall through to the shared 'default'
    // bucket until EmptyChatState's effect runs.
    if (get().activeDraftId === id) {
      const workspaceId = get().activeWorkspaceId;
      patch.activeDraftId = workspaceId ? crypto.randomUUID() : null;
      patch.activeSessionId = null;
      patch.mainView = 'new';
      // The fork draft is gone — the fresh slot is a plain new session.
      get().setPendingFork(null);
    }
    set(patch);
  },
  setPendingFork: (pendingFork) =>
    set((s) => {
      const patch: Partial<UiState> = { pendingFork };
      // Clearing fork intent drops its attachment — they travel together.
      if (pendingFork === null) {
        const list = s.composerAttachments[COMPOSER_NEW_KEY];
        if (list?.some((a) => a.path === FORK_ATTACHMENT_PATH)) {
          patch.composerAttachments = {
            ...s.composerAttachments,
            [COMPOSER_NEW_KEY]: list.filter((a) => a.path !== FORK_ATTACHMENT_PATH),
          };
        }
      }
      return patch;
    }),
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
    set({ activeWorkspaceId, activeSessionId: null, activeDraftId: null, mainView: 'new', sessionsPanelOpen: true, commitDetail: null }),
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

    // Clear the active-draft pointer: a stale one would leave the terminal
    // panel scoped to an abandoned draft's bucket the next time the
    // new-session screen appears (EmptyChatState only assigns a fresh draft
    // when the pointer is null). The draft's own bucket survives —
    // selectDraft can still return to it and find its terminals alive.
    // Navigating to a real session also ends any fork intent.
    set({
      activeSessionId,
      activeDraftId: null,
      mainView: 'chat',
      sessionLastActive,
    });
    if (activeSessionId) get().setPendingFork(null);

    // Apply this session's cached composer settings synchronously. Without
    // this, the PREVIOUS session's mode/model stays visible until the async
    // session load resolves — and a mode change made in that window would
    // persist to the wrong session. Uncached (first visit) falls back to
    // defaults; applySessionSettings overwrites when the load lands.
    if (activeSessionId) {
      const cached = get().sessionSettings[activeSessionId];
      set(cached
        ? { selectedModelId: cached.modelId, selectedProviderId: cached.providerId, autonomyMode: cached.autonomyMode, thinkingLevel: cached.thinkingLevel }
        : { selectedModelId: null, selectedProviderId: null, autonomyMode: 'ask', thinkingLevel: 'medium' });
    }
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
    const { [sessionId]: _fd, ...restFocusedDispatch } = state.focusedDispatchId;
    const { [sessionId]: _la, ...restLastActive } = state.sessionLastActive;
    const { [sessionId]: _ca, ...restComposerAttachments } = state.composerAttachments;
    const { [sessionId]: _cpr, ...restComposerPendingReads } = state.composerPendingReads;
    const { [sessionId]: _cd, ...restComposerDrafts } = state.composerDrafts;
    const { [sessionId]: _ss, ...restSessionSettings } = state.sessionSettings;
    const killedIds = new Set(terms.map((t) => t.id));
    set({
      terminals: restTerminals,
      terminalPorts: Object.fromEntries(
        Object.entries(state.terminalPorts).filter(([k]) => !killedIds.has(k)),
      ),
      activeTerminal: restActiveTerminal,
      openFiles: restOpenFiles,
      activeOpenFile: restActiveOpenFile,
      streams: restStream,
      focusedDispatchId: restFocusedDispatch,
      sessionLastActive: restLastActive,
      composerAttachments: restComposerAttachments,
      composerPendingReads: restComposerPendingReads,
      composerDrafts: restComposerDrafts,
      sessionSettings: restSessionSettings,
    });
  },
  toggleTerminal: () =>
    set((s) => {
      const scope = terminalScopeKey(s);
      const turningOn = !s.terminalOpen[scope];
      // Auto-seed a terminal for the active session the first time the panel
      // is opened with zero terminals — saves the user an extra click.
      if (turningOn && s.activeSessionId) {
        const list = s.terminals[s.activeSessionId] ?? [];
        if (list.length === 0) {
          const id = `t_${Math.random().toString(36).slice(2, 9)}`;
          return {
            terminalOpen: { ...s.terminalOpen, [scope]: true },
            terminals: {
              ...s.terminals,
              [s.activeSessionId]: [{ id, name: 'Terminal 1', createdAt: Date.now() }],
            },
            activeTerminal: { ...s.activeTerminal, [s.activeSessionId]: id },
          };
        }
      }
      return { terminalOpen: { ...s.terminalOpen, [scope]: turningOn } };
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
      set((s) => ({ sessionSettings: { ...s.sessionSettings, [sid]: { modelId: s.selectedModelId, providerId: s.selectedProviderId, autonomyMode, thinkingLevel: s.thinkingLevel } } }));
      void persistSessionSettings(sid, { autonomyMode });
      // Push the change to the running turn so subsequent tool calls in the
      // SAME stream use the new mode (without waiting for the next turn).
      window.tideIpc?.updateMode(sid, autonomyMode);
    }
  },
  setThinkingLevel: (thinkingLevel) => {
    set({ thinkingLevel });
    const sid = get().activeSessionId;
    if (sid) {
      set((s) => ({ sessionSettings: { ...s.sessionSettings, [sid]: { modelId: s.selectedModelId, providerId: s.selectedProviderId, autonomyMode: s.autonomyMode, thinkingLevel } } }));
      void persistSessionSettings(sid, { thinkingLevel });
    }
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
  applySessionSettings: (sessionId, s) => {
    const prev = get().sessionSettings[sessionId] ?? { modelId: null, providerId: null, autonomyMode: 'ask' as AutonomyMode, thinkingLevel: 'medium' as ThinkingLevel };
    const merged = {
      modelId: s.modelId !== undefined ? s.modelId : prev.modelId,
      providerId: s.providerId !== undefined ? s.providerId : prev.providerId,
      autonomyMode: s.autonomyMode ?? prev.autonomyMode,
      thinkingLevel: s.thinkingLevel ?? prev.thinkingLevel,
    };
    set((state) => ({ sessionSettings: { ...state.sessionSettings, [sessionId]: merged } }));
    // The load is async — only touch the globals if this session is still
    // active; otherwise the values belong to a session the user left.
    if (get().activeSessionId !== sessionId) return;
    set({
      selectedModelId: merged.modelId,
      selectedProviderId: merged.providerId,
      autonomyMode: merged.autonomyMode,
      thinkingLevel: merged.thinkingLevel,
    });
  },

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

  enqueueMessage: (sessionId, text, promptText, synthetic) =>
    set((s) => {
      const next: QueuedMessage[] = [
        ...(s.queue[sessionId] ?? []),
        { id: `q_${Math.random().toString(36).slice(2, 9)}`, text, promptText, ...(synthetic ? { synthetic } : {}), createdAt: Date.now() },
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
        [sessionId]: (s.queue[sessionId].map((m) => (m.id === id ? { ...m, text, promptText: undefined } : m))),
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
        ...(collapsePanel ? { terminalOpen: { ...s.terminalOpen, [sessionId]: false } } : {}),
      };
    }),
  setActiveTerminal: (sessionId, id) =>
    set((s) => ({ activeTerminal: { ...s.activeTerminal, [sessionId]: id } })),
  adoptDraftTerminals: (sessionId) => {
    // MUST run before setActiveSession promotes the session — it reads
    // activeDraftId to find the draft bucket, and selectSession clears it.
    const draftId = get().activeDraftId;
    if (!draftId) return;
    const key = `draft:${draftId}`;
    const list = get().terminals[key] ?? [];
    if (list.length === 0) return;
    set((s) => {
      const { [key]: _moved, ...restTerminals } = s.terminals;
      const { [key]: _active, ...restActiveTerminal } = s.activeTerminal;
      return {
        terminals: { ...restTerminals, [sessionId]: [...(restTerminals[sessionId] ?? []), ...list] },
        activeTerminal: {
          ...restActiveTerminal,
          [sessionId]: s.activeTerminal[key] ?? restActiveTerminal[sessionId],
        },
      };
    });
  },
  purgeDraftTerminals: (draftId) => {
    const key = `draft:${draftId}`;
    const list = get().terminals[key] ?? [];
    if (list.length === 0) return;
    const killedIds = new Set(list.map((t) => t.id));
    for (const t of list) {
      try { window.tideIpc?.terminalKill(t.id); } catch { /* dead */ }
    }
    set((s) => {
      const { [key]: _dropped, ...restTerminals } = s.terminals;
      const { [key]: _active, ...restActiveTerminal } = s.activeTerminal;
      return {
        terminals: restTerminals,
        activeTerminal: restActiveTerminal,
        terminalPorts: Object.fromEntries(
          Object.entries(s.terminalPorts).filter(([k]) => !killedIds.has(k)),
        ),
      };
    });
  },
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
  reasoningView: 'phased',
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
  diffMode: 'split',
  setDiffMode: (mode) => set({ diffMode: mode }),

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
        sheetWidth: s.sheetWidth,
        terminalHeight: typeof s.terminalHeight === 'object' && s.terminalHeight !== null ? s.terminalHeight : {},
        terminals: s.terminals,
        fontScale: s.fontScale,
        reduceMotion: s.reduceMotion,
        terminalTheme: s.terminalTheme,
        terminalFontSize: s.terminalFontSize,
        appTheme: s.appTheme,
        chatView: s.chatView,
        diffMode: s.diffMode,
        activeTerminal: s.activeTerminal,
        // Draft sessions + their composer text persist across restarts so
        // unsent drafts survive. activeDraftId is runtime-only — the app
        // restores the last real session on startup, not a draft slot.
        draftSessions: s.draftSessions,
        composerDrafts: s.composerDrafts,
        dismissedTodoSignatures: s.dismissedTodoSignatures,
        // shortcutOverrides is intentionally NOT persisted here — it lives in
        // settings.json (via the tide:settings:* IPC) so it's shared across
        // windows and platform-aware. Hydrated by loadShortcuts() at startup.
      }),
      // Don't restore screen — splash always routes first to validate providers/workspaces.
      // mainView is also runtime state — start at 'new' each load.
      // terminalOpen is forced false on every startup — the terminal should
      // only open via the explicit Terminal button, never auto-restored.
      merge: (persistedState, current) => ({
        ...current,
        ...(persistedState as Partial<UiState>),
        terminalOpen: {},
        // Same for the Agents panel — it opens only via an explicit
        // dispatch-row click, never auto-restored.
        agentsPanelOpen: false,
        // Sessions can't still be running after a restart — the orchestrator
        // died with the app. Force the running set empty so a stale persisted
        // blob can't restore running indicators for dead turns.
        runningSessionIds: [],
        // Strip 'default'-bucket terminals left by the pre-draft-keying bug:
        // they were draft-phase strays that leaked into every new-session
        // screen. Real buckets are session ids or 'draft:<id>' — never bare.
        terminals: Object.fromEntries(
          Object.entries((persistedState as Partial<UiState>).terminals ?? {}).filter(
            ([k]) => k !== 'default',
          ),
        ),
      }),
      version: 1,
    },
  ),
);
