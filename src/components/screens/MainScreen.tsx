import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { WorkspacesPanel } from "@/components/sidebar/WorkspacesPanel";
import { SessionsPanel } from "@/components/sidebar/SessionsPanel";
import { WindowTopBar } from "@/components/layout/WindowTopBar";
import { ChatSubBar } from "@/components/chat/ChatSubBar";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { EmptyChatState } from "@/components/chat/EmptyChatState";
import { NoWorkspaceState } from "@/components/chat/NoWorkspaceState";
import { ChatMessage } from "@/components/chat/ChatMessage";
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
  const setSessionsPanelOpen = useUi((s) => s.toggleSessionsPanel);
  const setRightPanelOpen = useUi((s) => s.toggleRightPanel);
  const mainView = useUi((s) => s.mainView);
  // The right panel is hidden on the new-session screen — it shows session-
  // specific data (Inspector, files, terminal) that doesn't exist yet before
  // the first message creates a session. Derived locally (NOT written to the
  // store) so the user's rightPanelOpen preference is preserved when they
  // return to chat.
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
  // On first mount, load the configured default autonomy from Settings → Permissions & caps.
  useEffect(() => {
    window.tideIpc?.getAgentSettings().then((s) => {
      if (
        s?.defaultAutonomy &&
        s.defaultAutonomy !== useUi.getState().autonomyMode
      ) {
        useUi
          .getState()
          .setAutonomyMode(
            s.defaultAutonomy as "plan" | "ask" | "edit" | "full",
          );
      }
    });
  }, []);
  const thinkingLevel = useUi((s) => s.thinkingLevel);
  const applySessionSettings = useUi((s) => s.applySessionSettings);
  const setSessionRunning = useUi((s) => s.setSessionRunning);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSessionRef = useRef<string | null>(activeSessionId);

  // Load session messages when activeSessionId changes.
  useEffect(() => {
    currentSessionRef.current = activeSessionId;
    if (!activeSessionId) {
      setChatHistory([]);
      return;
    }
    // Viewing a session clears its unread badge.
    markSessionRead(activeSessionId);
    api.getSession(activeSessionId).then((s) => {
      // Stale session id (deleted since last run) — clear so we don't keep
      // trying to load a session that doesn't exist.
      if (!s) {
        setActiveSession(null);
        setChatHistory([]);
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
          autonomyMode: s.autonomyMode,
          thinkingLevel: s.thinkingLevel,
        });
      }
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

  // Scroll behavior:
  //   - Never force-scroll during streaming. Let the user scroll freely.
  //   - Auto-scroll ONLY when the user is already at the bottom (they're
  //     following along) OR when they just sent a message (they want to see
  //     the response). If they've scrolled up to read history, respect that.
  //   - Show a floating "scroll to bottom" button above the composer when
  //     not at the bottom. Add a "new" badge when there's streaming content
  //     they haven't seen.
  // isAtBottom tracks whether the user is currently "following" the stream
  // at the bottom of the chat. userPinnedToBottom is a stronger signal: once
  // the user actively scrolls UP during streaming, we never auto-scroll again
  // until they either click the scroll-to-bottom button or send a new message.
  // This gives the user full freedom to read history while a turn runs.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userPinnedRef = useRef(true); // true = follow; false = user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let rafPending = false;
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const distanceFromBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distanceFromBottom < 80;
        // Detect an active upward scroll by the user (not a programmatic
        // scroll-to-bottom). When detected, mark them as "not following"
        // so the streaming auto-scroll effect leaves them alone.
        if (el.scrollTop < lastScrollTop - 4 && !atBottom) {
          userPinnedRef.current = false;
        }
        // Scrolling back to the bottom re-enables following.
        if (atBottom) userPinnedRef.current = true;
        lastScrollTop = el.scrollTop;
        setIsAtBottom(atBottom);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll ONLY when the user is following (hasn't scrolled up).
  // Once they scroll up during a stream, this effect no-ops until they
  // click the scroll-to-bottom button or send a new message.
  useEffect(() => {
    if (!userPinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(rafId);
  }, [
    chatHistory.length,
    streamingText,
    streamingReasoning,
    streamingToolCalls.length,
    isStreaming,
  ]);

  // When the user sends a message (chatHistory grows with a user msg), snap
  // to the bottom immediately and re-enable following.
  const prevHistoryLenRef = useRef(0);
  useEffect(() => {
    const newLen = chatHistory.length;
    if (newLen > prevHistoryLenRef.current) {
      const lastMsg = chatHistory[newLen - 1];
      if (lastMsg?.role === "user") {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        userPinnedRef.current = true;
        setIsAtBottom(true);
      }
    }
    prevHistoryLenRef.current = newLen;
  }, [chatHistory]);

  // When switching sessions, snap to bottom and re-enable following.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    userPinnedRef.current = true;
    setIsAtBottom(true);
  }, [activeSessionId]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    userPinnedRef.current = true;
    setIsAtBottom(true);
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

      let sessionId = activeSessionId;

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
        setActiveSession(sessionId);
        currentSessionRef.current = sessionId;
        // Best-effort LLM title refinement (first message only — this block
        // runs only on new-session creation). Fire-and-forget: the placeholder
        // is already set; this renames server-side on resolve and invalidates
        // the sessions list so the sidebar picks up the new title. Never
        // awaits on the send path — a slow/stuck title call can't block the turn.
        void api.generateSessionTitle(newSession.id).then((generated) => {
          if (generated && activeWorkspaceId) {
            qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
          }
        });

        // Worktree isolation — if the user opted in from the new-session
        // screen, create a git worktree for this session now (before the
        // turn starts). The orchestrator picks up session.worktree.path
        // automatically. On failure (branch exists, base missing), warn
        // and continue without isolation — the user can still chat.
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
        await api.addMessage(sessionId, "user", text);
        // addMessage bumps the session's updatedAt — invalidate so the sidebar
        // re-sorts (latest activity on top) and the title updates if it was
        // auto-derived from the first user message.
        if (activeWorkspaceId) {
          qc.invalidateQueries({ queryKey: ["sessions", activeWorkspaceId] });
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

      if (!sessionId) return;
      setSessionRunning(sessionId, true);
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
      start,
    ],
  );

  // When any session's stream finishes (finalMessage lands), freeze + persist
  // that session's assistant message. Iterates over ALL streams rather than
  // reading a single finalMessage slot — critical for parallel turns where two
  // sessions may finish close together and would otherwise overwrite each
  // other's slot before the effect processes them.
  //
  // Subscribes to `hasAnyFinalMessage` so the effect fires whenever any
  // session's finalMessage becomes set, regardless of which is active.
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
      };
      // Only push to the visible chatHistory if the user is currently viewing
      // the session that just finished. Other sessions' histories will refresh
      // from storage on next switch.
      if (sid === activeSessionId) {
        setChatHistory((h) => [...h, assistantMsg]);
      }
      api.addAssistantMessage(sid, assistantMsg);
      if (fm.usage) api.addSessionUsage(sid, fm.usage);
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

  // Notify the main process when the active workspace changes so the MCP
  // pool can connect project-scoped servers (.mcp.json at the workspace root)
  // and the MCP IPC handlers know which config file to mutate for
  // project-scoped add/update/remove. The main side keeps `activeWorkspace`
  // fresh (see the `tide:mcp:workspaceActivated` handler in main.ts).
  //
  // Fires once `workspaces` has loaded and the active entry resolves to a
  // path; re-fires only when either changes. Fire-and-forget — the IPC is
  // best-effort and a missed signal just means project servers stay down
  // until the next change (user-scoped servers are unaffected).
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

  // Submit handler for the popup. Two paths:
  //   - Live pause flow (toolCallId present): the turn is currently paused
  //     waiting for this answer. Call submitFollowup IPC — the orchestrator
  //     resolves the awaiting tool, the turn continues. No new user message.
  //   - Legacy persisted path (no toolCallId): fall back to handleSend,
  //     which adds a new user message and starts a fresh turn.
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
        className="flex-1 flex flex-col min-w-0 min-h-0
         overflow-hidden border border-input rounded-2xl drop-shadow-lg bg-background relative
        "
      >
        {/* Top bar — spans sessions → right panel, inside the card.
            Panel toggle icons (left), drag region (center), terminal +
            right-panel toggles (right). */}
        <WindowTopBar />
        <Group
          orientation="horizontal"
          className="flex-1 min-h-0 overflow-hidden"
        >
          {sessionsPanelOpen && (
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
          {sessionsPanelOpen && <ResizeHandle />}

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
              <ChatSubBar />

              {/* Body column — holds chat scroll + optional terminal + composer.
                  This is the column flex container; everything below ChatSubBar
                  must sum to (100% - 32px) so the composer never overflows. */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {!activeWorkspaceId ? (
                  <NoWorkspaceState />
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
                        className="flex-1 min-h-0 overflow-y-auto scroll px-6 py-5"
                      >
                        <div className="max-w-3xl mx-auto flex flex-col gap-3">
                          {chatHistory.map((msg) => (
                            <ChatMessage key={msg.id} message={msg} />
                          ))}

                          {streamingMessage && (
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
                          )}

                          {error && (
                            <div className="text-xs text-destructive border border-destructive/20 bg-destructive/[0.06] px-3 py-2 rounded-md">
                              {error}
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
                          inProgress={isStreaming || !!pendingOptions}
                          onSubmit={handleSend}
                          onStop={() => {
                            // abort() requires an explicit sessionId — without
                            // binding here, the composer's onStop() call would
                            // pass no arg and ipc.abortTurn(undefined) would
                            // silently no-op (the orchestrator can't match a
                            // session). Always abort the active session: the
                            // stop button represents "stop what I'm looking at".
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

          {showRightPanel && <ResizeHandle />}
          {showRightPanel && (
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
