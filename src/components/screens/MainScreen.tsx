import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ChevronDown, AlertCircle, RotateCw, Loader2 } from "lucide-react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { WorkspacesPanel } from "@/components/sidebar/WorkspacesPanel";
import { SessionsPanel } from "@/components/sidebar/SessionsPanel";
import { WindowTopBar } from "@/components/layout/WindowTopBar";
import { ChatSubBar } from "@/components/chat/ChatSubBar";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { EmptyChatState } from "@/components/chat/EmptyChatState";
import { LoadingRows } from "@/components/ui/loading-rows";
import { NoWorkspaceState } from "@/components/chat/NoWorkspaceState";
import { MissingWorkspaceScreen } from "./MissingWorkspaceScreen";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { VirtualizedChatList } from "@/components/chat/VirtualizedChatList";
import { StickyScroll } from "@/lib/sticky-scroll";
import { OptionsPopup } from "@/components/chat/OptionsPopup";
import { TodoFloatingPanel } from "@/components/chat/TodoFloatingPanel";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { RightPanel } from "@/components/right-panel/RightPanel";
import { FileViewerPanel } from "@/components/right-panel/FileViewerPanel";
import { FloatingPermissionCard } from "@/components/chat/FloatingPermissionCard";
import { useUi } from "@/lib/stores/ui";
import { useModelOption, useWorkspaces, useSessions } from "@/lib/queries";
import { useChatStream } from "@/hooks/useChatStream";
import * as api from "@/lib/api/client";
import { stripCommandPrefix } from "@/lib/session-title";
import { buildSystemPrompt } from "@/lib/prompts/tide-system-prompt";
import { buildReferencedFilesBlock } from "@/lib/prompts/file-context";
import { migrateMessagesToBlocks } from "@/lib/stream/blockMigration";
import type { Message, MessageAttachment } from "@/types";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { createLogger } from "@/lib/logger";
import { toast } from "@/lib/toast";
import { cn, isMac } from "@/lib/utils";

const log = createLogger("main-screen");

function ResizeHandle() {
  return (
    <Separator
      className={
        "group relative flex-shrink-0 w-px bg-input hover:bg-accent/60 " +
        "data-[separator-state=drag]:bg-accent transition-colors"
      }
    >
      <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="block w-1 h-1 rounded-full bg-muted-foreground/40 group-hover:bg-accent" />
        <span className="block w-1 h-1 rounded-full bg-muted-foreground/40 group-hover:bg-accent" />
        <span className="block w-1 h-1 rounded-full bg-muted-foreground/40 group-hover:bg-accent" />
      </span>
    </Separator>
  );
}

export function MainScreen() {
  const leftPanelOpen = useUi((s) => s.leftPanelOpen);
  const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);
  const rightPanelOpen = useUi((s) => s.rightPanelOpen);
  const fileViewerOpen = useUi((s) => s.fileViewerOpen);
  // Whether this screen is the active top-level view. App.tsx keeps MainScreen
  // always-mounted (so TerminalPanel + xterm state survive Settings visits);
  // this flag lets effects no-op while hidden to avoid wasted work (auto-
  // scroll, streaming re-renders) on a display:none element.
  const setSessionsPanelOpen = useUi((s) => s.toggleSessionsPanel);
  const setRightPanelOpen = useUi((s) => s.toggleRightPanel);
  const mainView = useUi((s) => s.mainView);
  // The right panel is hidden on the new-session screen — it shows session-specific data (Inspector, files, terminal) that doesn't exist before the first message creates a session. Derived locally (NOT written to the store) so the user's rightPanelOpen preference is preserved when they return to chat.
  const showRightPanel = rightPanelOpen && mainView !== "new";
  const [fileViewerWidth, setFileViewerWidth] = useState(50); // percent
  const cardRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize the File Viewer overlay. Tracks pointer from the left
  // edge handle and adjusts the panel's width as a percentage of the card.
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const card = cardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const pct = ((cardRect.right - ev.clientX) / cardRect.width) * 100;
      setFileViewerWidth(Math.max(25, Math.min(70, pct)));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);
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

  // Store actions for stream management.
  const clearFinalMessage = useUi((s) => s.clearFinalMessage);
  // Subscribe to "any stream has a finalMessage pending" so the freeze effect
  // fires for sessions that finished while the user was viewing another one.
  // Returns a derived boolean; only changes when the set of pending
  // finalMessages changes, so the effect doesn't re-fire on every token.
  const hasAnyFinalMessage = useUi((s) =>
    Object.values(s.streams).some((st) => st.finalMessage),
  );
  const streamsRef = useUi.getState;
  // Keep a ref so the freeze effect can read the latest streams without
  // re-subscribing on every store update.
  useEffect(() => {
    streamsRef;
  }, [streamsRef]);

  // Local chat state — mirrors the persisted session.
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
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
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSessionRef = useRef<string | null>(activeSessionId);

  // Load session messages when activeSessionId changes.
  useEffect(() => {
    currentSessionRef.current = activeSessionId;
    if (!activeSessionId) {
      setChatHistory([]);
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
              createdAt: m.createdAt,
              toolCalls: m.toolCalls,
              // Re-hydrate the structured turn fields. Without these, the
              // TurnBlock collapses to a bare text answer after refresh.
              timeline: m.timeline,
              turn: m.turn,
              blocks: m.blocks,
              attachments: m.attachments,
            })),
          ),
        );
        applySessionSettings({
          modelId: s.modelId,
          providerId: s.providerId,
          // Preserve the live autonomy mode if the user escalated mid-turn
          // (e.g. switched from 'plan' to 'edit' via permission card). The
          // persisted record may not have the update yet (race between
          // updateSessionSettings and the session re-fetch).
          autonomyMode: useUi.getState().autonomyMode !== 'ask'
            ? useUi.getState().autonomyMode
            : (s.autonomyMode ?? undefined),
          thinkingLevel: s.thinkingLevel,
        });
      }
      setSessionLoading(false);
    }).catch(() => {
      // IPC failure loading the session — clear loading + history so the user
      // isn't stuck on a skeleton, and they can retry by re-selecting.
      setSessionLoading(false);
      setChatHistory([]);
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
      // Transition into having a session — expand panels if they're closed.
      if (!sessionsPanelOpen) setSessionsPanelOpen();
      if (!rightPanelOpen) setRightPanelOpen();
      prevHadSessionRef.current = true;
    } else if (!shouldShowPanels && prevHadSessionRef.current) {
      // Transitioned out of having a session — collapse.
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

  // StickyScroll — manages auto-scroll-to-bottom during streaming, unpin
  // when user scrolls up, and the scroll-to-bottom button visibility.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const stickyRef = useRef<StickyScroll | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl) return;
    const sticky = new StickyScroll(scrollEl, { threshold: 80 });
    sticky.onPinChange = (pinned) => setIsAtBottom(pinned);
    if (contentEl) sticky.observe(contentEl);
    stickyRef.current = sticky;
    return () => { sticky.disconnect(); stickyRef.current = null; };
  }, []);

  // When the user sends a message, snap to bottom and re-pin.
  const prevHistoryLenRef = useRef(0);
  useEffect(() => {
    const newLen = chatHistory.length;
    if (newLen > prevHistoryLenRef.current) {
      const lastMsg = chatHistory[newLen - 1];
      if (lastMsg?.role === "user") {
        stickyRef.current?.scrollToBottom();
      }
    }
    prevHistoryLenRef.current = newLen;
  }, [chatHistory]);

  // When switching sessions, snap to bottom.
  useEffect(() => {
    stickyRef.current?.scrollToBottom();
  }, [activeSessionId]);

  const scrollToBottom = useCallback(() => {
    stickyRef.current?.scrollToBottom({ smooth: true });
  }, []);

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
      setSubmitting(true);

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

        // Invalidate the sessions list so the sidebar picks up the new entry
        // immediately — without this, it stays hidden until streaming ends
        // (the freeze effect also invalidates, but that's seconds away).
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
      const [workspaceContext, referencedFiles] = await Promise.all([
        activeWorkspaceId
          ? api.getWorkspaceContext(activeWorkspaceId).catch(() => "")
          : Promise.resolve(""),
        activeWorkspaceId
          ? buildReferencedFilesBlock(activeWorkspaceId, text)
          : Promise.resolve(""),
      ]);
      const systemPrompt = buildSystemPrompt({
        workspacePath: workspace?.path,
        gitBranch: workspace?.branch,
        modelAlias: modelOption?.alias,
        workspaceContext,
        referencedFiles,
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
        setSubmitting(false);
        return;
      }
      setSessionRunning(sessionId, true);
      // Streaming is about to begin — the pre-stream window is over. From
      // here the turn drives the button via isStreaming/inProgress, so clear
      // submitting so it doesn't fight with the streaming indicator.
      setSubmitting(false);
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

  // When any session's stream finishes (finalMessage lands), freeze + persist that session's assistant message. Iterates over ALL streams rather than reading a single finalMessage slot — critical for parallel turns where two sessions may finish close together and would otherwise overwrite each other's slot before the effect processes them. Subscribes to `hasAnyFinalMessage` so the effect fires whenever any session's finalMessage becomes set, regardless of which is active.
  useEffect(() => {
    if (!hasAnyFinalMessage) return;
    const streams = useUi.getState().streams;
    for (const [sid, stream] of Object.entries(streams)) {
      if (stream.isStreaming || !stream.finalMessage) continue;
      const fm = stream.finalMessage;
      const assistantMsg: Message = {
        id: `m_${Date.now().toString(36)}`,
        role: "assistant",
        content: fm.content,
        blocks: fm.blocks,
        timeline: fm.timeline,
        turn: fm.turn,
        reasoning: fm.reasoning,
        reasoningTokens: fm.reasoningTokens,
        createdAt: new Date().toISOString(),
        toolCalls: fm.toolCalls,
        stopReason: stream.stopReason,
      };
      // Only push to the visible chatHistory if the user is currently viewing
      // the session that just finished. Other sessions' histories will refresh
      // from storage on next switch.
      if (sid === activeSessionId) {
        setChatHistory((h) => [...h, assistantMsg]);
      }
      api.addAssistantMessage(sid, assistantMsg);
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
    }
  }, [
    hasAnyFinalMessage,
    activeSessionId,
    activeWorkspaceId,
    qc,
    setSessionRunning,
    clearFinalMessage,
    markSessionUnread,
    markSessionRead,
  ]);

  // Persist the active session/workspace to the main-process config so the
  // app reopens to the same session on restart. Independent of localStorage
  // (which is scoped to the dev server port and may change between runs).
  useEffect(() => {
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
      if (activeSessionId) dismissOptionsPopup(activeSessionId);
      if (toolCallId && activeSessionId) {
        // Live pause flow — resume the paused turn with the pick.
        submitFollowup(activeSessionId, toolCallId, answer);
      } else {
        // Legacy persisted flow — send as a new user message.
        handleSend({ text: `I picked: ${answer}` });
      }
    },
    [dismissOptionsPopup, handleSend, submitFollowup, activeSessionId],
  );

  return (
    <div className="backdrop-blur-xl frosted flex-1 flex min-h-0">
      {/* Frosted workspace sidebar — fills the left edge with vibrancy. */}
      {leftPanelOpen && <WorkspacesPanel />}

      {/* Content card — top bar + sessions + chat + right panel grouped
          into one floating surface. Opaque bg, rounded corners, margin
          from the window edges, shadow to lift it off the wallpaper.
          The transparent window shows the desktop around this card. */}
      <div
        ref={cardRef}
        className={cn("flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden border border-input rounded-2xl drop-shadow-lg bg-background relative",
          isMac ? "my-3 mr-3" : ""
        )}
      >
        {/* Top bar — spans sessions → right panel, inside the card.
            Panel toggle icons (left), drag region (center), terminal +
            right-panel toggles (right). */}
        <WindowTopBar />
        <Group
          orientation="horizontal"
          className="flex-1 min-h-0 overflow-hidden"
        >
          {sessionsPanelOpen && !workspaceMissing && (
            <Panel
              id="sessions"
              defaultSize="15"
              minSize="12"
              maxSize="25"
              className="h-full"
            >
              <SessionsPanel />
            </Panel>
          )}
          {sessionsPanelOpen && !workspaceMissing && <ResizeHandle />}

          <Panel
            id="chat"
            minSize="30"
            className="h-full min-h-0"
            // The library sets inline `overflow:auto` on the inner wrapper;
            // override via the style prop (spread *after* the default) so the
            // chat column never scrolls as a whole — children own their scroll.
            style={{ overflow: "hidden", height: "100%" }}
          >
            <main className="flex h-full w-full flex-col min-w-0 min-h-0 overflow-hidden">
              {!workspaceMissing && <ChatSubBar />}

              {/* Body column — holds chat scroll + optional terminal + composer.
                  This is the column flex container; everything below ChatSubBar
                  must sum to (100% - 32px) so the composer never overflows. */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
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
                    {/* Chat scroll — flex-1 absorbs leftover height so terminal
                      + composer shrink it rather than pushing it off-screen.
                      Wrapped in a relative container so the floating todo
                      panel can anchor to the top-right of the chat column. */}
                    <div className="flex-1 min-h-0 flex flex-col relative">
                      <TodoFloatingPanel sessionId={activeSessionId} />
                      <div
                        ref={scrollRef}
                        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll px-6 py-5"
                      >
                        <div ref={contentRef} className="max-w-3xl mx-auto flex flex-col min-w-0 overflow-hidden">
                          {sessionLoading && chatHistory.length === 0 ? (
                            // Session messages are loading on switch — show a
                            // skeleton instead of flashing an empty chat.
                            <LoadingRows count={4} className="px-1" rowClassName="h-12" />
                          ) : (
                            <VirtualizedChatList messages={chatHistory} />
                          )}

                          {streamingMessage && (
                            <>
                              {activeStream?.compacting && (
                                <div className="flex items-center gap-2 px-3.5 py-2 mx-1 mb-1 rounded-lg border border-primary/15 bg-primary/[0.04] text-[11px] text-muted-foreground font-mono">
                                  <Loader2 className="size-3 animate-spin text-primary/60" />
                                  <span>Compacting context</span>
                                  <span className="text-muted-foreground/40">— summarizing earlier turns to fit the context window</span>
                                </div>
                              )}
                            <ChatMessage
                              message={streamingMessage}
                              streaming
                              pendingToolCallIds={pendingToolCallIds}
                              stopReason={activeStream?.stopReason}
                              onApproveToolCalls={
                                activeSessionId
                                  ? (ids, newMode, remember) =>
                                      approveToolCalls(
                                        activeSessionId,
                                        ids,
                                        newMode,
                                        remember,
                                      )
                                  : undefined
                              }
                              onRejectToolCalls={
                                activeSessionId
                                  ? (ids, reason) =>
                                      rejectToolCalls(
                                        activeSessionId,
                                        ids,
                                        reason,
                                      )
                                  : undefined
                              }
                            />
                            </>
                          )}

                          {/* Terminal error — shown when the turn fails.
                              Retry re-sends the last user message. */}
                          {error && !isStreaming && (
                            <div className="flex flex-col gap-2 px-3.5 py-3 rounded-lg border border-destructive/20 bg-destructive/[0.06]">
                              <div className="flex items-start gap-2.5">
                                <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12px] font-medium text-destructive">
                                    Turn failed
                                  </div>
                                  <div className="text-[11px] text-muted-foreground/60 mt-0.5 leading-relaxed break-words">
                                    {error}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  className="text-[11px] font-medium text-foreground hover:text-foreground transition-colors flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary/70 hover:bg-secondary"
                                  onClick={() => {
                                    if (!activeSessionId || !modelOption) return;
                                    // Remove the failed assistant message from chatHistory
                                    // so the retry produces a fresh one, not a duplicate.
                                    setChatHistory((h) => {
                                      const last = h[h.length - 1];
                                      if (last && last.role === 'assistant') {
                                        return h.slice(0, -1);
                                      }
                                      return h;
                                    });
                                    // Clear the error state.
                                    useUi.getState().patchStream(activeSessionId, { error: null });
                                    // Re-invoke the turn with the existing conversation
                                    // (last user message is already in chatHistory).
                                    const retryMessages = chatHistory
                                      .filter((m) => m.role === 'user' || m.role === 'assistant')
                                      .filter((m) => {
                                        // Drop the failed assistant message.
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
                                </button>
                                <button
                                  className="text-[11px] font-medium text-muted-foreground/60 hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-secondary/50"
                                  onClick={() => {
                                    if (activeSessionId) {
                                      useUi.getState().patchStream(activeSessionId, { error: null });
                                    }
                                  }}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Composer — pinned to the bottom of the chat column. */}
                    <div className="flex-shrink-0 px-6 pb-4 pt-2 bg-gradient-to-b from-transparent to-bg relative">
                      {/* Floating scroll-to-bottom button — appears above the
                        composer when the user has scrolled up. Shows a "new"
                        badge while streaming to indicate unseen content. */}
                      {!isAtBottom && (
                        <Button
                          onClick={scrollToBottom}
                          className="absolute -top-9 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary border border-border shadow-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                          <ChevronDown className="size-3.5" />
                          {isStreaming ? (
                            <span className="flex items-center gap-1.5">
                              New activity
                              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                            </span>
                          ) : (
                            "Scroll to bottom"
                          )}
                        </Button>
                      )}
                      <div className="max-w-4xl mx-auto relative">
                        {/* Options popover — anchored above the composer, matches
                          its width via the relative parent. No backdrop; floats
                          over the chat scroll without blocking interaction. */}
                        <OptionsPopup onSubmit={handleOptionsSubmit} />
                        <ChatComposer
                          compact
                          sessionId={activeSessionId ?? undefined}
                          placeholder={
                            pendingOptions
                              ? "Answer the popup above first…"
                              : isStreaming
                                ? "Stop to abort, or queue a message…"
                                : "Send a message…"
                          }
                          inProgress={isStreaming || !!pendingOptions || submitting}
                          onSubmit={handleSend}
                          onStop={() => {
                            // abort() requires an explicit sessionId — without binding here, the composer's onStop() would pass no arg and ipc.abortTurn(undefined) would silently no-op (orchestrator can't match a session). Always abort the active session: the stop button represents "stop what I'm looking at".
                            if (activeSessionId) abort(activeSessionId);
                          }}
                        />
                      </div>
                    </div>
                    {/* Terminal — always mounted so xterm state survives
                          collapse/expand. TerminalPanel hides itself via
                          display:none when !terminalOpen. */}
                    <TerminalPanel />
                  </>
                ) : (
                  <EmptyChatState
                    onSend={(p) => handleSend(p)}
                    isStreaming={isStreaming}
                  />
                )}
              </div>
            </main>
          </Panel>

          {showRightPanel && !workspaceMissing && <ResizeHandle />}
          {showRightPanel && !workspaceMissing && (
            <Panel
              id="right"
              defaultSize="22"
              minSize="20"
              maxSize="35"
              className="h-full relative"
            >
              <RightPanel />
              {/* Floating permission card — anchored inside the right panel so
                it inherits the panel's width. Sits above the panel content,
                pinned to the bottom, only visible when there are pending prompts. */}
              <FloatingPermissionCard sessionId={activeSessionId} />
            </Panel>
          )}
        </Group>

        {/* File viewer — floating overlay (z-index: 2). Starts BELOW the
            WindowTopBar (top-10) so the toggle icons stay clickable.
            Left edge is a drag handle to resize the panel width. */}
        {fileViewerOpen && (
          <div
            className="absolute top-10 right-0 bottom-0 z-[2] shadow-2xl bg-card flex"
            style={{ width: `${fileViewerWidth}%`, minWidth: 320 }}
          >
            {/* Drag handle */}
            <div
              onPointerDown={handleResizeStart}
              className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors flex items-center justify-center group"
            >
              <div className="absolute flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="block w-1 h-1 rounded-full bg-muted-foreground/40" />
                <span className="block w-1 h-1 rounded-full bg-muted-foreground/40" />
                <span className="block w-1 h-1 rounded-full bg-muted-foreground/40" />
              </div>
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <FileViewerPanel />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
