import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AlertCircle, RotateCw } from "lucide-react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { WorkspacesPanel } from "@/components/sidebar/workspaces-panel";
import { SessionsPanel } from "@/components/sidebar/sessions-panel";
import { IntegratedSidebar } from "@/components/sidebar/integrated-sidebar";
import { WindowTopBar } from "@/components/layout/window-top-bar";
import { ChatComposer } from "@/components/chat/chat-composer";
import { EmptyChatState } from "@/components/chat/empty-chat-state";
import { TimelineSkeleton } from "@/components/chat/turn/turn-skeleton";
import { NoWorkspaceState } from "@/components/chat/no-workspace-state";
import { MissingWorkspaceScreen } from "./missing-workspace-screen";
import { ChatTimeline } from "@/components/chat/timeline/ChatTimeline";
import { OptionsPopup } from "@/components/chat/options-popup";
import { TodoFloatingPanel } from "@/components/chat/todo-floating-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { RightPanel } from "@/components/right-panel/right-panel";
import { useRightPanelOverlay } from '@/lib/right-panel-layout';
import { FileViewerPanel } from "@/components/right-panel/file-viewer-panel";
import { CommitDetailsPanel } from "@/components/git/commit-details-panel";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import { FloatingPermissionCard } from "@/components/chat/permissions/floating-permission-card";
import { useUi, terminalScopeKey } from "@/lib/stores/ui";
import { useModelOption, useWorkspaces, useSessions } from "@/lib/queries";
import { useChatStream } from "@/hooks/use-chat-stream";
import * as api from "@/lib/api/client";
import { stripCommandPrefix } from "@/lib/session-title";
import { buildSystemPrompt } from "@/lib/prompts/tide-system-prompt";
import { buildReferencedFilesBlock } from "@/lib/prompts/file-context";
import { migrateMessageToBlocks, migrateMessagesToBlocks } from "@/lib/stream/block-migration";
import type { Message, MessageAttachment, Session } from "@/types";
import { useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";
import { toast } from "@/lib/toast";
import { cn, isMac } from "@/lib/utils";
import { Button } from "../ui/button";

const log = createLogger("main-screen");

export function MainScreen() {
  const leftPanelOpen = useUi((s) => s.leftPanelOpen);
  const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);
  const sidebarMode = useUi((s) => s.sidebarMode);
  const setSidebarMode = useUi((s) => s.setSidebarMode);
  // Dual sidebar needs ~1024px of panels; below that fall back to integrated
  // (and restore the user's choice when the window is wide again).
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const apply = () => {
      if (mq.matches && useUi.getState().sidebarMode === 'dual') {
        autoSwitchedRef.current = true;
        setSidebarMode('integrated');
      } else if (!mq.matches && autoSwitchedRef.current) {
        autoSwitchedRef.current = false;
        setSidebarMode('dual');
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [setSidebarMode]);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const setSidebarWidth = useUi((s) => s.setSidebarWidth);
  const rightPanelOpen = useUi((s) => s.rightPanelOpen);
  const fileViewerOpen = useUi((s) => s.fileViewerOpen);
  const commitDetail = useUi((s) => s.commitDetail);
  const setCommitDetail = useUi((s) => s.setCommitDetail);
  const sheetWidth = useUi((s) => s.sheetWidth);
  // Only one overlay Sheet at a time — if both are open the later-rendered
  // Sheet's overlay (z-50 fixed inset-0) blocks clicks on the other's content.
  useEffect(() => { if (fileViewerOpen && commitDetail) setCommitDetail(null); }, [fileViewerOpen]);
  useEffect(() => { if (commitDetail && fileViewerOpen) useUi.setState({ fileViewerOpen: false }); }, [commitDetail]);
  // Whether this screen is the active top-level view. App.tsx keeps MainScreen
  // always-mounted (so TerminalPanel + xterm state survive Settings visits);
  // this flag lets effects no-op while hidden to avoid wasted work (auto-
  // scroll, streaming re-renders) on a display:none element.
  const setSessionsPanelOpen = useUi((s) => s.toggleSessionsPanel);
  const setRightPanelOpen = useUi((s) => s.toggleRightPanel);
  const mainView = useUi((s) => s.mainView);
  // The right panel is hidden on the new-session screen — it shows session-specific data (Inspector, files, terminal) that doesn't exist before the first message creates a session. Derived locally (NOT written to the store) so the user's rightPanelOpen preference is preserved when they return to chat.
  const showRightPanel = rightPanelOpen && mainView !== "new";
  // Narrow windows: the right panel becomes a Sheet overlay instead of competing
  // with the chat column for in-flow space (t3code-style inline↔overlay switch).
  const rightPanelOverlay = useRightPanelOverlay();
  // When the window narrows, the inline panel swaps to an overlay Sheet; dismissing
  // that Sheet closes the panel. Remember it was open before the switch so we can
  // re-expand it once the window is wide enough for the inline layout again. A
  // manual close at wide width is never overridden — the ref only holds "collapsed
  // by the narrow-window switch", not user intent.
  const openBeforeOverlayRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (rightPanelOverlay) {
      if (openBeforeOverlayRef.current === null) {
        openBeforeOverlayRef.current = rightPanelOpen;
      } else if (openBeforeOverlayRef.current && !rightPanelOpen) {
        // The only way to close it mid-overlay is the user (Sheet dismiss or
        // toggle) — drop the restore so their close sticks.
        openBeforeOverlayRef.current = false;
      }
    } else if (openBeforeOverlayRef.current !== null) {
      const restore = openBeforeOverlayRef.current;
      openBeforeOverlayRef.current = null;
      if (restore && !rightPanelOpen) setRightPanelOpen();
    }
  }, [rightPanelOverlay, rightPanelOpen, setRightPanelOpen]);
  const terminalScope = useUi(terminalScopeKey);
  const terminalOpen = useUi((s) => !!s.terminalOpen[terminalScope]);
  const terminalHeight = useUi((s) => s.terminalHeight[terminalScope] ?? 220);
  const setTerminalHeight = useUi((s) => s.setTerminalHeight);
  const screen = useUi((s) => s.screen);
  // Imperative ref on the terminal ResizablePanel — collapse/expand it from
  // the terminal toggle (which still just flips the persisted `terminalOpen`).
  const terminalPanelRef = useRef<PanelImperativeHandle>(null);
  useEffect(() => {
    const ref = terminalPanelRef.current;
    if (!ref) return;
    if (terminalOpen) ref.expand();
    else ref.collapse();
  }, [terminalOpen, screen]);

  const activeSessionId = useUi((s) => s.activeSessionId);
  const selectedModelId = useUi((s) => s.selectedModelId);
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const autonomyMode = useUi((s) => s.autonomyMode);
  // On first mount, load the configured default autonomy from Settings → Permissions & Caps.
  // Only applies the default if the persisted mode is the initial 'ask' —
  // don't override a mode the user escalated to mid-session (e.g. 'edit' via
  // the permission card).
  useEffect(() => {
    window.tideIpc?.getAgentSettings().then((s) => {
      const current = useUi.getState().autonomyMode;
      // Only apply the default on first-ever launch (current is still 'ask'
      // AND the user hasn't explicitly set a mode in the UI).
      // If the user escalated to 'edit'/'full'/'plan', respect that choice.
      if (s?.defaultAutonomy && current === 'ask' && s.defaultAutonomy !== 'ask') {
        useUi.getState().setAutonomyMode(s.defaultAutonomy as "plan" | "ask" | "edit" | "full");
      }
    });
  }, []);
  const thinkingLevel = useUi((s) => s.thinkingLevel);
  const applySessionSettings = useUi((s) => s.applySessionSettings);
  const setSessionRunning = useUi((s) => s.setSessionRunning);
  const addTitleGenerating = useUi((s) => s.addTitleGenerating);
  const removeTitleGenerating = useUi((s) => s.removeTitleGenerating);
  const markSessionUnread = useUi((s) => s.markSessionUnread);
  const markSessionRead = useUi((s) => s.markSessionRead);
  const pendingOptions = useUi((s) =>
    activeSessionId ? s.pendingOptions[activeSessionId] : undefined,
  );
  const dismissOptionsPopup = useUi((s) => s.dismissOptionsPopup);
  const setMainView = useUi((s) => s.setMainView);
  const setActiveSession = useUi((s) => s.setActiveSession);
  const { data: sessions } = useSessions(activeWorkspaceId);
  const modelOption = useModelOption(selectedProviderId, selectedModelId);
  const { data: workspaces } = useWorkspaces();
  const qc = useQueryClient();

  const { start, abort, approveToolCalls, rejectToolCalls, submitFollowup } =
    useChatStream();

  // Per-session streaming state lives in the store now. Read the active
  // session's entry so two sessions can stream independently — switching
  // between them shows each one's live state without losing the other.
  const activeStream = useUi((s) =>
    activeSessionId ? s.streams[activeSessionId] : undefined,
  );
  const isStreaming = !!activeStream?.isStreaming;
  const streamingText = activeStream?.text ?? "";
  const streamingReasoning = activeStream?.reasoning ?? "";
  const streamingToolCalls = activeStream?.toolCalls ?? [];
  const streamingTimeline = activeStream?.timeline ?? [];
  const streamingUsage = activeStream?.usage ?? null;
  const permissionRequest = activeStream?.permissionRequest ?? null;
  const error = activeStream?.error ?? null;
  const retry = activeStream?.retry ?? null;

  // Store actions for stream management.
  const clearFinalMessage = useUi((s) => s.clearFinalMessage);
  // Subscribe to the list of sessions with a pending finalMessage (stable
  // string key) so the freeze effect fires whenever a NEW session finishes —
  // a boolean `.some()` would skip a turn_end that lands while another
  // finalMessage is already pending, losing that session's unread dot.
  const pendingFinalSessionIds = useUi((s) =>
    Object.entries(s.streams)
      .filter(([, st]) => st.finalMessage)
      .map(([sid]) => sid)
      .sort()
      .join(","),
  );
  const streamsRef = useUi.getState;
  // Keep a ref so the freeze effect can read the latest streams without
  // re-subscribing on every store update.
  useEffect(() => {
    streamsRef;
  }, [streamsRef]);

  // Local chat state — mirrors the persisted session.
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  // Session that owns `chatHistory`. On switch the old history keeps rendering
  // while the new session loads — this id routes followup popups and stream
  // reads to the owning session instead of the newly-active one.
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  // True while a session's messages are loading from IPC (on session switch).
  // Drives a skeleton so switching sessions doesn't flash a blank/empty chat.
  const [sessionLoading, setSessionLoading] = useState(false);
  // True when the active workspace's folder is missing on disk. Drives the
  // MissingWorkspaceScreen (warns the user + offers Delete / re-check) instead
  // of letting tools fail mid-turn. Re-probed whenever the active workspace or
  // mainView changes; cleared on success so the normal chat/new view returns.
  const activeWorkspace = workspaces?.find((w) => w.id === activeWorkspaceId);
  const [workspaceMissing, setWorkspaceMissing] = useState(false);
  useEffect(() => {
    if (!activeWorkspace) { setWorkspaceMissing(false); return; }
    let cancelled = false;
    window.tideIpc?.workspacesExist([activeWorkspace.path]).then((map) => {
      if (!cancelled) setWorkspaceMissing(map?.[activeWorkspace.path] === false);
    }).catch(() => { if (!cancelled) setWorkspaceMissing(false); });
    return () => { cancelled = true; };
  }, [activeWorkspace]);
  // True during the pre-stream window (session create + worktree + message
  // add + context build) — closes the dead window between clicking send and
  // the first token, where the app otherwise looks frozen.
  // Which session is in the pre-stream window ("Preparing…") — keyed by
  // session id (null = the no-session draft) so one session preparing never
  // blocks another session's composer. false = idle.
  const [submittingSession, setSubmittingSession] = useState<
    string | null | false
  >(false);
  const currentSessionRef = useRef<string | null>(activeSessionId);

  // Load session messages when activeSessionId changes.
  useEffect(() => {
    currentSessionRef.current = activeSessionId;
    if (!activeSessionId) {
      setChatHistory([]);
      setHistorySessionId(null);
      setSessionLoading(false);
      return;
    }
    // Viewing a session clears its unread badge.
    markSessionRead(activeSessionId);
    // Show a skeleton while messages load so a session switch doesn't read
    // as an empty chat before the IPC resolves.
    setSessionLoading(true);
    api.getSession(activeSessionId).then((s) => {
      // Stale session id (deleted since last run) — clear so we don't keep
      // trying to load a session that doesn't exist.
      if (!s) {
        setActiveSession(null);
        setChatHistory([]);
        setHistorySessionId(null);
        setSessionLoading(false);
        return;
      }
      if (currentSessionRef.current === activeSessionId) {
        setChatHistory(
          migrateMessagesToBlocks(
            (s.messages ?? []).map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              reasoning: m.reasoning,
              reasoningTokens: m.reasoningTokens,
              reasoningMs: m.reasoningMs,
              totalMs: m.totalMs,
              createdAt: m.createdAt,
              toolCalls: m.toolCalls,
              // Re-hydrate the structured turn fields. Without these, the
              // TurnBlock collapses to a bare text answer after refresh.
              timeline: m.timeline,
              turn: m.turn,
              blocks: m.blocks,
              attachments: m.attachments,
              compactionInfo: m.compactionInfo,
            })),
          ),
        );
        setHistorySessionId(activeSessionId);
        // First load of a session (nothing cached): hydrate autonomy/thinking
        // from the persisted record. On re-fetches prefer the cache —
        // setAutonomyMode/setThinkingLevel write it synchronously, so a
        // mid-turn escalation (e.g. 'plan' → 'edit' via permission card)
        // survives even though the persisted record hasn't caught up yet.
        const hasCachedSettings = !!useUi.getState().sessionSettings[activeSessionId];
        applySessionSettings(activeSessionId, {
          modelId: s.modelId,
          providerId: s.providerId,
          autonomyMode: hasCachedSettings ? undefined : s.autonomyMode,
          thinkingLevel: hasCachedSettings ? undefined : s.thinkingLevel,
        });
      }
      setSessionLoading(false);
    }).catch(() => {
      // IPC failure loading the session — clear loading + history so the user
      // isn't stuck on a skeleton, and they can retry by re-selecting.
      setSessionLoading(false);
      setChatHistory([]);
      setHistorySessionId(null);
    });
  }, [activeSessionId, markSessionRead, setActiveSession]);

  // Auto-collapse the sessions + right panels when there's no session to
  // show in them (no active session, or workspace has zero sessions).
  // Auto-expand when a session becomes available. Edge-triggered via a ref
  // so the user's manual toggles aren't overridden on every render.
  const prevHadSessionRef = useRef<boolean>(false);
  useEffect(() => {
    const hasSessions = (sessions?.length ?? 0) > 0;
    const hasActive = !!activeSessionId;
    const shouldShowPanels = hasSessions && hasActive;

    // Only act on the false→true and true→false transitions.
    if (shouldShowPanels && !prevHadSessionRef.current) {
      if (!sessionsPanelOpen) setSessionsPanelOpen();
      if (!rightPanelOpen) setRightPanelOpen();
      prevHadSessionRef.current = true;
    } else if (!shouldShowPanels && prevHadSessionRef.current) {
      if (sessionsPanelOpen) setSessionsPanelOpen();
      if (rightPanelOpen) setRightPanelOpen();
      prevHadSessionRef.current = false;
    }
  }, [
    sessions?.length,
    activeSessionId,
    sessionsPanelOpen,
    rightPanelOpen,
    setSessionsPanelOpen,
    setRightPanelOpen,
  ]);

  // When a git-state-mutating tool completes in the active session, refetch
  // git status + branch + history so the Git Panel, the Inspector's Git
  // section, and the top-bar branch reflect changes the agent made (new
  // branch, checkout, commit, etc.) immediately. Covers both the dedicated
  // `git` tool and `git …` run through `bash`.
  const seenGitToolsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const calls = activeStream?.toolCalls ?? [];
    let changed = false;
    for (const c of calls) {
      const name = (c.toolName || '').replace(/^(server_|mcp_)/, '');
      const terminal = c.status === 'executed' || c.status === 'failed' || c.status === 'rejected';
      if (!terminal || seenGitToolsRef.current.has(c.id)) continue;
      // Dedicated git tool — any subcommand may mutate state, so always refresh.
      if (name === 'git') {
        seenGitToolsRef.current.add(c.id);
        changed = true;
        continue;
      }
      // git run through bash — only refresh on branch/state-mutating subcommands.
      if (name === 'bash') {
        const cmd = String(c.arguments?.command ?? '');
        if (/\bgit\b\s+(?:checkout|switch|branch|reset|merge|rebase|stash|commit|pull|cherry-pick|revert|restore|rm)\b/.test(cmd)) {
          seenGitToolsRef.current.add(c.id);
          changed = true;
        }
      }
    }
    if (changed && activeWorkspaceId) {
      qc.invalidateQueries({ queryKey: ['gitStatus', activeWorkspaceId] });
      qc.invalidateQueries({ queryKey: ['gitBranch', activeWorkspaceId] });
      qc.invalidateQueries({ queryKey: ['gitLog', activeWorkspaceId] });
    }
  }, [activeStream?.toolCalls, activeWorkspaceId, qc]);

  // The streaming assistant message — built from the active session's stream.
  // Reads from the per-session state in the store, so switching sessions
  // shows whichever one is currently streaming (and other sessions keep
  // streaming in the background). Returns null when no turn is in flight.
  const streamingMessage: Message | null = useMemo(() => {
    if (!isStreaming) return null;
    return {
      id: "__streaming__",
      role: "assistant",
      content: streamingText,
      // Canonical block list — built incrementally by the streamReducer.
      // Drives the block-stream UI. Back-compat fields below stay in sync
      // via applyLegacyEvent until all components are rewired.
      blocks: activeStream?.blocks,
      // Live timeline — preserves text/tool interleaving during streaming
      // so the 1code view (and any timeline-aware renderer) shows tools in
      // their true emission position, not all stacked at the bottom.
      timeline: streamingTimeline.length > 0 ? streamingTimeline : undefined,
      // Structured turn view — built incrementally by useChatStream's
      // rebuildTurn helper on every state change. Drives the turn-block UI.
      turn: activeStream?.turn,
      reasoning: streamingReasoning || undefined,
      reasoningTokens: streamingUsage?.reasoningTokens || undefined,
      createdAt: new Date().toISOString(),
      toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
    };
  }, [
    isStreaming,
    streamingText,
    streamingTimeline,
    activeStream?.blocks,
    activeStream?.turn,
    streamingReasoning,
    streamingToolCalls,
    streamingUsage,
  ]);

  // Permission prompts render only when the active session has one pending.
  // Each session's permissionRequest is independent — switching to another
  // session shows its own prompt (or none).
  const pendingToolCallIds = permissionRequest
    ? permissionRequest.toolCalls.map((tc) => tc.id)
    : [];

  const handleSend = useCallback(
    async (payload: {
      text: string;
      promptText?: string;
      mentions?: Array<{
        name: string;
        kind: string;
        source?: string;
        filePath?: string;
        description?: string;
      }>;
      attachments?: MessageAttachment[];
      worktree?: {
        enabled: boolean;
        branchName: string;
        baseBranch: string;
        configFiles?: string[];
      };
    }) => {
      const text = payload.text;
      const promptText = payload.promptText ?? text;
      const attachments = payload.attachments ?? [];

      // ── Built-in slash commands ──
      // /compact — manually trigger context compaction for the active session.
      if (text.trim().toLowerCase() === '/compact') {
        if (!activeSessionId) {
          toast.error('No active session to compact');
          return;
        }
        if (isStreaming) {
          toast.error('Cannot compact while streaming');
          return;
        }
        toast.info('Compacting context…');
        // Send a marker message — the orchestrator detects it and forces
        // compaction in prepareStep before the model responds.
        payload.text = '[[FORCE_COMPACT]]Summarize our conversation so far. Keep the key decisions, files touched, and current task state.';
        payload.promptText = '[[FORCE_COMPACT]]Summarize our conversation so far. Keep the key decisions, files touched, and current task state.';
      }

      // Only abort if the ACTIVE session is already streaming. A different
      // session streaming in the background should not block this send.
      if (isStreaming && activeSessionId) {
        abort(activeSessionId);
        return;
      }
      if (!activeWorkspaceId) {
        log.warn("No workspace selected");
        return;
      }
      if (!modelOption || !selectedModelId) {
        log.warn("No model selected");
        return;
      }

      // Pre-stream window begins: session create + worktree + message add +
      // context build all run before the first token. Flip submitting so the
      // send button shows "Preparing…" instead of looking frozen.
      setSubmittingSession(activeSessionId);

      let sessionId = activeSessionId;
      let isNewSession = false;

      // Create a new session if none active.
      if (!sessionId && activeWorkspaceId) {
        // Placeholder title: stripped of /skill and @agent prefixes so the
        // sidebar never shows the raw command. Refined to a concise title by
        // the LLM call below once it returns.
        const placeholderTitle =
          stripCommandPrefix(text).slice(0, 50) || text.slice(0, 50);
        const newSession = await api.createSession(
          activeWorkspaceId,
          placeholderTitle,
          selectedModelId,
          {
            autonomyMode,
            thinkingLevel,
            providerId: selectedProviderId ?? undefined,
          },
        );
        sessionId = newSession.id;
        isNewSession = true;
        // Re-key the submitting flag to the newly created session so the
        // composer stays in "Preparing…" across the draft→session promotion.
        setSubmittingSession(newSession.id);
        // Terminals opened while composing were keyed by the draft id — move
        // them under the new session id BEFORE the draft pointer is dropped
        // (setActiveSession clears it; adoption reads it).
        useUi.getState().adoptDraftTerminals(newSession.id);
        // Consume BEFORE setActiveSession — setActiveSession nulls
        // activeDraftId, and consumeDraft keys off it, so the promoted draft
        // would survive in the sidebar list.
        useUi.getState().consumeDraft();
        // Seed the per-session settings cache with what createSession just
        // persisted. Without this, setActiveSession's cache-miss branch resets
        // the composer to defaults (ask/medium) — losing the thinking level
        // (and autonomy mode) picked on the new-session screen.
        useUi.getState().applySessionSettings(newSession.id, {
          modelId: selectedModelId,
          providerId: selectedProviderId,
          autonomyMode,
          thinkingLevel,
        });
        setActiveSession(sessionId);
        currentSessionRef.current = sessionId;
        // Title generation moved below — it must run AFTER addMessage persists
        // the first user message, otherwise the handler finds no user message.

        // Worktree isolation — if the user opted in from the new-session screen, create a git worktree for this session now (before the turn starts). The orchestrator picks up session.worktree.path automatically. On failure (branch exists, base missing), warn and continue without isolation — the user can still chat.
        if (payload.worktree?.enabled && sessionId) {
          try {
            await api.createWorktree(sessionId, {
              branchName: payload.worktree.branchName,
              baseBranch: payload.worktree.baseBranch,
              configFiles: payload.worktree.configFiles,
            });
            qc.invalidateQueries({
              queryKey: ["sessions", "detail", sessionId],
            });
          } catch (e) {
            log.warn("worktree create failed, continuing without isolation", e);
          }
        }

        // Optimistically insert the new session at the top of the sidebar list
        // so it appears INSTANTLY. invalidateQueries alone marks the query
        // stale and refetches, but that round-trip reads as a visible delay
        // before the entry shows up. Insert into the cache now; the invalidate
        // right after reconciles ordering/fields with the backend's list.
        qc.setQueryData<Session[]>(["sessions", activeWorkspaceId], (prev) =>
          prev ? [newSession, ...prev] : [newSession],
        );
        qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
      }

      // Add user message locally + persist.
      const userMsg: Message = {
        id: `m_${Date.now().toString(36)}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        attachments: attachments.length > 0 ? attachments : undefined,
        mentions:
          payload.mentions && payload.mentions.length > 0
            ? (payload.mentions as Message["mentions"])
            : undefined,
      };
      setChatHistory((h) => [...h, userMsg]);
      if (sessionId) {
        // Persist basic shape (sessions.ts handles the StoredMessage projection).
        // Pass attachments + mentions so chips survive reload — without these
        // the viewer can't reopen attached files (no absPath/isImage to match).
        await api.addMessage(sessionId, "user", text, {
          attachments: attachments.length > 0 ? attachments : undefined,
          mentions:
            payload.mentions && payload.mentions.length > 0
              ? (payload.mentions as Message["mentions"])
              : undefined,
        });
        // addMessage bumps the session's updatedAt — invalidate so the sidebar
        // re-sorts (latest activity on top) and the title updates if it was
        // auto-derived from the first user message.
        if (activeWorkspaceId) {
          qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
        }

        // Title generation: fire AFTER addMessage persists the user message.
        // The handler reads session.messages to find the first user message —
        // if it runs before addMessage, it finds nothing and returns null.
        if (isNewSession && sessionId) {
          addTitleGenerating(sessionId);
          void api
            .generateSessionTitle(sessionId)
            .then((generated) => {
              if (generated && activeWorkspaceId) {
                qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
              }
            })
            .finally(() => removeTitleGenerating(sessionId));
        }
      }

      setMainView("chat");

      // Resolve workspace context for the system prompt.
      const workspace = workspaces?.find((w) => w.id === activeWorkspaceId);
      const [workspaceContext, referencedFiles, envInfo, git] = await Promise.all([
        activeWorkspaceId
          ? api.getWorkspaceContext(activeWorkspaceId).catch(() => "")
          : Promise.resolve(""),
        activeWorkspaceId
          ? buildReferencedFilesBlock(activeWorkspaceId, text)
          : Promise.resolve(""),
        api.getEnvInfo().catch(() => undefined),
        // Turn-start git snapshot (worktree-aware when a session exists) —
        // branch/HEAD, dirty files, recent commits. Saves the model a
        // `git status` probe at the start of every task.
        activeWorkspaceId
          ? Promise.all([
              api.gitBranchInfo(activeWorkspaceId, sessionId ?? undefined).catch(() => ({ branch: null, headCommit: null })),
              api.gitStatus(activeWorkspaceId, sessionId ?? undefined).catch(() => [] as api.GitFileChange[]),
              api.gitLog(activeWorkspaceId, sessionId ?? undefined, 5).catch(() => [] as api.GitCommit[]),
            ])
          : Promise.resolve(null),
      ]);
      const systemPrompt = buildSystemPrompt({
        workspacePath: workspace?.path,
        gitBranch: workspace?.branch,
        modelAlias: modelOption?.alias,
        workspaceContext,
        referencedFiles,
        envInfo,
        gitSnapshot: git
          ? { branch: git[0].branch, headCommit: git[0].headCommit, status: git[1], log: git[2] }
          : undefined,
        // Tell the model when it's working inside an isolated worktree so
        // it understands edits don't land on the user's main checkout.
        worktree: payload.worktree?.enabled
          ? {
              branch: payload.worktree.branchName,
              baseBranch: payload.worktree.baseBranch,
            }
          : undefined,
      });

      // Build conversation history for the orchestrator.
      const apiMessages = [
        { role: "system" as const, content: systemPrompt },
        ...chatHistory
          .filter(
            (m): m is Message => m.role === "user" || m.role === "assistant",
          )
          .map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments,
          })),
        {
          role: "user" as const,
          content: promptText,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      ];

      if (!sessionId) {
        setSubmittingSession(false);
        return;
      }
      setSessionRunning(sessionId, true);
      setSubmittingSession(false);
      // Capture the git HEAD sha before the turn starts — used by per-file
      // undo in FileChangesSummary to revert edits to pre-turn state.
      if (activeWorkspaceId) {
        api.gitHeadSha(activeWorkspaceId, sessionId).then((sha) => {
          if (sha) useUi.getState().setPreTurnSha(sessionId, sha);
        }).catch(() => {});
      }
      await start({
        sessionId,
        messages: apiMessages,
        modelId: selectedModelId,
        providerId: selectedProviderId ?? modelOption?.providerId,
        autonomyMode,
        thinkingLevel,
      });
    },
    [
      isStreaming,
      abort,
      modelOption,
      selectedModelId,
      selectedProviderId,
      activeSessionId,
      activeWorkspaceId,
      chatHistory,
      workspaces,
      autonomyMode,
      thinkingLevel,
      setActiveSession,
      setMainView,
      setSessionRunning,
      addTitleGenerating,
      removeTitleGenerating,
      start,
    ],
  );

  // Queue refs — the freeze effect (below) reads these to auto-drain queued
  // messages and handle "send now" overrides. handleSendRef lets the effect
  // call the latest handleSend without re-subscribing on every identity change.
  // forceSendRef holds a message the user explicitly jumped the queue for
  // (via "Send now" — aborts the current turn, then sends on turn_end).
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const forceSendRef = useRef<{ text: string; promptText?: string } | null>(null);

  // "Send now" override — abort the current turn and force-send this message
  // when the abort's turn_end arrives. Clears the queue (user chose to jump).
  const onSendNow = useCallback(
    (text: string, promptText?: string) => {
      forceSendRef.current = { text, promptText };
      if (activeSessionId) abort(activeSessionId);
    },
    [activeSessionId, abort],
  );

  // When any session's stream finishes (finalMessage lands), freeze + persist that session's assistant message. Iterates over ALL streams rather than reading a single finalMessage slot — critical for parallel turns where two sessions may finish close together and would otherwise overwrite each other's slot before the effect processes them. Subscribes to `hasAnyFinalMessage` so the effect fires whenever any session's finalMessage becomes set, regardless of which is active.
  useEffect(() => {
    if (!pendingFinalSessionIds) return;

    // Auto-drain queued messages after a turn finishes. Two paths:
    //  1. Force-send override ("Send now" was clicked) — aborts the current
    //     turn, then sends this message. Clears the rest of the queue.
    //  2. Normal drain — send the first queued message in order.
    // At this point isStreaming is false for the session (the freeze effect
    // only processes sessions where stream.isStreaming === false), so
    // handleSend's abort guard won't fire.
    const drainQueue = (sid: string) => {
      if (forceSendRef.current && sid === activeSessionId) {
        const { text, promptText } = forceSendRef.current;
        forceSendRef.current = null;
        useUi.getState().clearQueuedMessages(sid);
        handleSendRef.current({ text, promptText, attachments: [] });
        return;
      }
      const q = useUi.getState().queue[sid];
      if (q && q.length > 0) {
        const next = q[0];
        useUi.getState().removeQueuedMessage(sid, next.id);
        handleSendRef.current({ text: next.text, promptText: next.promptText, attachments: [] });
      }
    };

    const streams = useUi.getState().streams;
    for (const [sid, stream] of Object.entries(streams)) {
      if (stream.isStreaming || !stream.finalMessage) continue;
      const fm = stream.finalMessage;
      // Skip empty turns — no text, no tool calls, no blocks. The model
      // produced nothing usable (empty response, pre-output error, etc.).
      // Persisting a bare { content: "" } leaves a blank bubble in the chat
      // and corrupts forks (the next turn's context includes an empty
      // assistant message the model can't interpret). Still clear streaming
      // state so the composer unblocks. An error turn (stopReason refusal /
      // max_tokens / iteration_limit) is kept even when text is empty so the
      // user sees something happened.
      const isEmpty =
        !fm.content?.trim() &&
        !(fm.toolCalls ?? []).length &&
        !(fm.blocks ?? []).length;
      const isErrorStop =
        stream.stopReason === 'refusal' ||
        stream.stopReason === 'max_tokens' ||
        stream.stopReason === 'iteration_limit' ||
        stream.stopReason === 'content_filter';
      if (isEmpty && !isErrorStop) {
        setSessionRunning(sid, false);
        if (sid === activeSessionId) markSessionRead(sid);
        clearFinalMessage(sid);
        // Auto-drain: send the next queued message (or a force-send override).
        drainQueue(sid);
        continue;
      }
      const messageId = fm.messageId ?? `m_${Date.now().toString(36)}`;
      // The orchestrator's turn_end blocks never contain followup blocks (only
      // the renderer's live reducer spawns them), so an unanswered/answered
      // question card would vanish the moment the streaming message unmounts.
      // Heal through the same idempotent migration the reload path uses —
      // spawns `${toolCallId}#followup` blocks matching the live ids, and is
      // a no-op for messages that already have them.
      const assistantMsg: Message = migrateMessageToBlocks({
        id: messageId,
        role: "assistant",
        content: fm.content,
        blocks: fm.blocks,
        timeline: fm.timeline,
        turn: fm.turn,
        reasoning: fm.reasoning,
        reasoningTokens: fm.reasoningTokens,
        totalMs: fm.totalMs,
        createdAt: new Date().toISOString(),
        toolCalls: fm.toolCalls,
        stopReason: stream.stopReason,
        compactionInfo: stream.compactedTokens
          ? { tokensBefore: stream.compactedTokens.before, tokensAfter: stream.compactedTokens.after }
          : undefined,
      });
      // Only push to the visible chatHistory if the user is currently viewing
      // the session that just finished. Other sessions' histories will refresh
      // from storage on next switch.
      if (sid === activeSessionId) {
        setChatHistory((h) => [...h, assistantMsg]);
      }
      api.finalizeAssistantMessage(sid, messageId, assistantMsg);
      if (fm.usage) api.addSessionUsage(sid, fm.usage, fm.lastStepUsage ?? fm.usage);
      setSessionRunning(sid, false);
      if (sid === activeSessionId) markSessionRead(sid);
      else markSessionUnread(sid);
      if (activeWorkspaceId) {
        qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
      }
      qc.invalidateQueries({ queryKey: ["sessions", "detail", sid] });
      // Clear just this session's finalMessage so we don't reprocess it.
      clearFinalMessage(sid);
      // Auto-drain: send the next queued message (or a force-send override).
      drainQueue(sid);
    }
  }, [
    pendingFinalSessionIds,
    activeSessionId,
    activeWorkspaceId,
    qc,
    setSessionRunning,
    clearFinalMessage,
    markSessionUnread,
    markSessionRead,
  ]);

  // Idle-session drain — a synthetic queued message (background dispatch
  // result) can land AFTER the turn already ended, so the freeze effect
  // above never fires for it. Send it through the same handleSend path the
  // freeze effect's drainQueue uses. Only the active session: handleSend
  // persists + streams into the session it's called on, so draining another
  // session's synthetic message here would misroute it. Non-active sessions
  // keep theirs queued until that session's next turn ends (normal drain).
  // The busy flag serializes parallel dispatch results — without it, two
  // results completing together would race two handleSend calls into one
  // session; the runner-up synthetics drain when the started turn ends.
  const syntheticDrainBusyRef = useRef(false);
  const drainSyntheticRef = useRef<() => void>(() => {});
  drainSyntheticRef.current = () => {
    const sid = activeSessionId;
    if (!sid || syntheticDrainBusyRef.current) return;
    if (useUi.getState().streams[sid]?.isStreaming) return;
    const next = useUi.getState().queue[sid]?.find((m) => m.synthetic);
    if (!next) return;
    syntheticDrainBusyRef.current = true;
    useUi.getState().removeQueuedMessage(sid, next.id);
    void handleSendRef.current({ text: next.text, promptText: next.promptText, attachments: [] })
      .finally(() => {
        syntheticDrainBusyRef.current = false;
        drainSyntheticRef.current();
      });
  };
  const pendingSyntheticCount = useUi((s) =>
    activeSessionId ? (s.queue[activeSessionId] ?? []).filter((m) => m.synthetic).length : 0,
  );
  useEffect(() => {
    if (pendingSyntheticCount) drainSyntheticRef.current();
  }, [pendingSyntheticCount]);

  // Persist the active session/workspace to the main-process config so the
  // app reopens to the same session on restart. Independent of localStorage
  // (which is scoped to the dev server port and may change between runs).
  // Guarded: MainScreen is always-mounted, so on a fresh start (before the
  // splash restore resolves) both values are null — persisting that would
  // clobber the saved last-session and break the next restart's restore.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    api.setLastSession(activeSessionId, activeWorkspaceId);
  }, [activeSessionId, activeWorkspaceId]);

  // Notify the main process when the active workspace changes so the MCP pool can connect project-scoped servers (.mcp.json at the workspace root) and MCP IPC handlers know which config file to mutate for project-scoped add/update/remove. The main side keeps `activeWorkspace` fresh (see `tide:mcp:workspaceActivated` in main.ts). Fires once `workspaces` has loaded and the active entry resolves to a path; re-fires only when either changes. Fire-and-forget — the IPC is best-effort and a missed signal just means project servers stay down until the next change (user-scoped servers are unaffected).
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ws = workspaces?.find((w) => w.id === activeWorkspaceId);
    if (!ws?.path) return;
    window.tideIpc?.mcpWorkspaceActivated?.(activeWorkspaceId, ws.path);
  }, [activeWorkspaceId, workspaces]);

  // NOTE: The legacy ```options-block text parsing that used to trigger the
  // OptionsPopup has been removed. Popup triggering now happens via the
  // FollowupPrompt component (in the 1code/turn-block path), which routes
  // directly from ask_followup_question tool args — no text regex needed.

  // Submit handler for the popup. Live pause flow (toolCallId present): the turn is paused waiting for this answer — call submitFollowup IPC, the orchestrator resolves the awaiting tool and the turn continues (no new user message). Legacy persisted path (no toolCallId): fall back to handleSend, which adds a new user message and starts a fresh turn.
  const handleOptionsSubmit = useCallback(
    (selection: string[]) => {
      const opts = activeSessionId
        ? useUi.getState().pendingOptions[activeSessionId]
        : undefined;
      const toolCallId = opts?.toolCallId;
      const answer =
        selection.length === 1 ? selection[0] : selection.join(", ");
      const sid = activeSessionId;
      if (sid) dismissOptionsPopup(sid);
      const deliverAsMessage = () => handleSend({ text: `I picked: ${answer}` });
      if (toolCallId && sid) {
        // Live pause flow — resume the paused turn with the pick. If the
        // resolver is gone (the turn already ended — e.g. the popup fired
        // from a stale persisted followup block), the answer would be lost;
        // deliver it as a regular user message instead. Only when the
        // session isn't streaming — a running turn means the pick is live
        // and a stray new message would clobber it.
        submitFollowup(sid, toolCallId, answer).then((resolved) => {
          if (!resolved && !useUi.getState().getStream(sid).isStreaming) deliverAsMessage();
        });
      } else {
        // Legacy persisted flow — send as a new user message.
        deliverAsMessage();
      }
    },
    [dismissOptionsPopup, handleSend, submitFollowup, activeSessionId],
  );

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 min-w-0 overflow-hidden bg-sidebar border-none">
      {/* Sidebar — integrated (resizable) or dual (fixed workspace panel).
          Integrated panel uses leftPanelOpen (workspace toggle), not
          sessionsPanelOpen — it replaces the workspace panel, not the sessions panel. */}
      {leftPanelOpen && sidebarMode === 'integrated' ? (
        <>
          <ResizablePanel
            id="sidebar"
            defaultSize={sidebarWidth}
            minSize={260}
            maxSize={260}
            className="min-h-0 min-w-0 overflow-hidden"
            onResize={(size) => setSidebarWidth(size.inPixels)}
          >
            <IntegratedSidebar />
          </ResizablePanel>
          <ResizableHandle className="!bg-transparent" />
        </>
      ) : leftPanelOpen && sidebarMode === 'dual' ? (
        <>
          <ResizablePanel id="workspaces" defaultSize={200} minSize={200} maxSize={250} className="min-h-0">
            <WorkspacesPanel />
          </ResizablePanel>
          <ResizableHandle className="!bg-transparent" />
        </>
      ) : null}

      {/* Content card — top bar + sessions + chat + right panel grouped
          into one floating surface. Opaque bg, rounded corners, margin
          from the window edges, shadow to lift it off the wallpaper.
          The transparent window shows the desktop around this card. */}
      <ResizablePanel id="card" minSize={600} className={cn("min-h-0", isMac && "py-0 pr-0")}>
        <div
          className="flex h-full w-full flex-col min-w-0 min-h-0 overflow-hidden bg-background border-l relative"
        >
        <WindowTopBar />
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 min-h-0"
        >
          {/* Dual-mode sessions panel */}
          {sessionsPanelOpen && sidebarMode === 'dual' && !workspaceMissing && (
            <ResizablePanel
              id="sessions"
              defaultSize={200} minSize={200} maxSize={250}
              className="min-h-0"
            >
              <SessionsPanel />
            </ResizablePanel>
          )}
          {sessionsPanelOpen && sidebarMode === 'dual' && !workspaceMissing && <ResizableHandle />}

          <ResizablePanel
            id="chat"
            className="h-full min-h-0 min-w-0"
          >
            <main className="flex h-full w-full flex-col min-w-0 min-h-0 overflow-hidden">
              {/* Body — vertical ResizablePanelGroup: chat body + collapsible
                  terminal. The terminal panel stays mounted when collapsed so
                  xterm/PTY state survives hide/show + chat↔new-session switches. */}
              <ResizablePanelGroup orientation="vertical" className="flex-1 min-h-0">
                <ResizablePanel id="chat-body" minSize="40" className="min-h-0">
                  <div className="flex h-full w-full flex-col min-h-0 overflow-hidden">
                {!activeWorkspaceId ? (
                  <NoWorkspaceState />
                ) : workspaceMissing && activeWorkspace ? (
                  // Active workspace's folder is gone — warn + offer recovery
                  // instead of letting tools fail mid-turn.
                  <MissingWorkspaceScreen
                    workspace={activeWorkspace}
                    onRestored={() => {
                      setWorkspaceMissing(false);
                      setMainView("new");
                    }}
                  />
                ) : mainView === "chat" || isStreaming ? (
                  <>
                    {/* Chat timeline — flex-1 absorbs leftover height so terminal
                      + composer shrink it rather than pushing it off-screen.
                      Wrapped in a relative container so the floating todo
                      panel can anchor to the top-right of the chat column. */}
                    <div className="flex-1 min-h-0 flex flex-col relative">
                      <TodoFloatingPanel sessionId={activeSessionId} />
                      <ChatTimeline
                        messages={chatHistory}
                        sessionId={historySessionId}
                        streamingMessage={streamingMessage}
                        isStreaming={isStreaming}
                        pendingToolCallIds={pendingToolCallIds}
                        stopReason={activeStream?.stopReason}
                        sessionLoading={sessionLoading && chatHistory.length === 0}
                        onApproveToolCalls={
                          activeSessionId
                            ? (ids, newMode, remember) =>
                                approveToolCalls(activeSessionId, ids, newMode, remember)
                            : undefined
                        }
                        onRejectToolCalls={
                          activeSessionId
                            ? (ids, reason) =>
                                rejectToolCalls(activeSessionId, ids, reason)
                            : undefined
                        }
                        loadingFallback={<TimelineSkeleton />}
                        retryActive={!!retry}
                        errorBlock={error && !isStreaming ? (
                          <div className="flex flex-col gap-2 px-3.5 py-3 rounded-lg border border-primary/20 bg-primary/[0.06] max-w-[75%]">
                            <div className="flex items-start gap-2.5">
                              <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] font-medium text-destructive">
                                  Turn Failed
                                </div>
                                <div className="text-[11px] text-muted-foreground/60 mt-0.5 leading-relaxed break-words">
                                  {error}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">

                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => {
                                  if (activeSessionId) {
                                    useUi.getState().patchStream(activeSessionId, { error: null });
                                  }
                                }}
                              >
                                Dismiss
                              </Button>
                              <Button
                                size="xs"
                                onClick={() => {
                                  if (!activeSessionId || !modelOption) return;
                                  setChatHistory((h) => {
                                    const last = h[h.length - 1];
                                    if (last && last.role === 'assistant') {
                                      return h.slice(0, -1);
                                    }
                                    return h;
                                  });
                                  useUi.getState().patchStream(activeSessionId, { error: null });
                                  const retryMessages = chatHistory
                                    .filter((m) => m.role === 'user' || m.role === 'assistant')
                                    .filter((m) => {
                                      const arr = chatHistory;
                                      return m !== arr[arr.length - 1] || m.role !== 'assistant';
                                    })
                                    .map((m) => ({ role: m.role, content: m.content }));
                                  start({
                                    sessionId: activeSessionId,
                                    messages: retryMessages as any,
                                    modelId: selectedModelId ?? modelOption.modelId,
                                    providerId: selectedProviderId ?? modelOption.providerId,
                                    autonomyMode,
                                    thinkingLevel,
                                  });
                                }}
                              >
                                <RotateCw className="size-3" />
                                Retry
                              </Button>
                            </div>
                          </div>
                        ) : undefined}
                      />
                    </div>

                    {/* Composer — pinned to the bottom of the chat column. */}
                    <div className="flex-shrink-0 px-6 pb-4 pt-2 bg-gradient-to-b from-transparent to-bg relative">
                      {/* Retry indicator — floating above the composer while
                          the orchestrator auto-retries a failed request. */}
                      {retry && (
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border shadow-lg text-xs animate-shimmer-pill overflow-hidden">
                          <svg className="size-3.5 -rotate-90" viewBox="0 0 36 36">
                            <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
                            <circle
                              cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3"
                              strokeLinecap="round"
                              strokeDasharray={`${(retry.attempt / retry.maxAttempts) * 94.25} 94.25`}
                              className="text-primary transition-all duration-300"
                            />
                          </svg>
                          <span className="text-muted-foreground font-mono tabular-nums">
                            Retrying {retry.attempt}/{retry.maxAttempts}
                          </span>
                        </div>
                      )}
                      <div className="relative w-[90%] max-w-4xl mx-auto">
                        {/* Options popover — anchored above the composer, matches
                          its width via the relative parent. No backdrop; floats
                          over the chat scroll without blocking interaction. */}
                        <OptionsPopup onSubmit={handleOptionsSubmit} />
                        <ChatComposer
                          key={activeSessionId}
                          compact
                          sessionId={activeSessionId ?? undefined}
                          placeholder={
                            pendingOptions
                              ? "Answer the popup above first…"
                              : isStreaming
                                ? "Stop to abort, or queue a message…"
                                : "Send a message…"
                          }
                          inProgress={
                            isStreaming ||
                            !!pendingOptions ||
                            submittingSession === (activeSessionId ?? null)
                          }
                          onSubmit={handleSend}
                          onSendNow={onSendNow}
                          onStop={() => {
                            // abort() requires an explicit sessionId — without binding here, the composer's onStop() would pass no arg and ipc.abortTurn(undefined) would silently no-op (orchestrator can't match a session). Always abort the active session: the stop button represents "stop what I'm looking at".
                            if (activeSessionId) abort(activeSessionId);
                          }}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <EmptyChatState
                    onSend={(p) => handleSend(p)}
                    isStreaming={isStreaming}
                  />
                )}
                  </div>
                </ResizablePanel>

                {/* Terminal — collapsible panel (stays mounted → PTY preserved).
                    toggleTerminal flips the persisted terminalOpen; the effect
                    near the top collapse/expand()s this panel via panelRef. */}
                <ResizableHandle />
                <ResizablePanel
                  id="terminal"
                  collapsible
                  collapsedSize={0}
                  defaultSize={terminalOpen ? terminalHeight : 0}
                  minSize={120}
                  maxSize={720}
                  panelRef={terminalPanelRef}
                  onResize={(size) => setTerminalHeight(size.inPixels)}
                  className="min-h-0"
                >
                  <TerminalPanel />
                </ResizablePanel>
              </ResizablePanelGroup>
            </main>
          </ResizablePanel>

          {showRightPanel && !workspaceMissing && !rightPanelOverlay && <ResizableHandle />}
          {showRightPanel && !workspaceMissing && !rightPanelOverlay && (
            <ResizablePanel
              id="right"
              defaultSize="25"
              minSize="25"
              maxSize="30"
              className="h-full relative min-w-0"
            >
              <RightPanel />
              <FloatingPermissionCard sessionId={activeSessionId} />
            </ResizablePanel>
          )}
        </ResizablePanelGroup>

        {/* Right panel, narrow-window mode — same Sheet treatment as t3code:
            below the media-query breakpoint the panel stops competing with the
            chat column for in-flow space and overlays instead. Dismissing the
            Sheet just closes the panel (same as the inline toggle). */}
        <Sheet
          open={rightPanelOverlay && showRightPanel && !workspaceMissing}
            onOpenChange={(o) => { if (!o) setRightPanelOpen(); }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 w-[42vw] sm:max-w-[28rem] sm:min-w-[20rem]"
            style={{ top: '40px', height: 'auto' }}
          >
            <RightPanel />
            <FloatingPermissionCard sessionId={activeSessionId} />
          </SheetContent>
        </Sheet>

        {/* File viewer — Sheet positioned below the topbar (top:40px). */}
        <Sheet open={fileViewerOpen} onOpenChange={(o) => { if (!o) useUi.setState({ fileViewerOpen: false }); }}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0" style={{ top: '40px', height: 'auto', width: `${sheetWidth}vw`, maxWidth: '100vw' }}>
            <SheetResizeHandle />
            <FileViewerPanel />
          </SheetContent>
        </Sheet>

        {/* Commit details — Sheet positioned below the topbar. */}
        <Sheet open={!!commitDetail} onOpenChange={(o) => { if (!o) setCommitDetail(null); }}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0" style={{ top: '40px', height: 'auto', width: `${sheetWidth}vw`, maxWidth: '100vw' }}>
            <SheetResizeHandle />
            {commitDetail && <CommitDetailsPanel commit={commitDetail} />}
          </SheetContent>
        </Sheet>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
