/**
 * Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/ChatMessage.tsx — REWRITE-PORT (ruling R3).
 * Upstream's component is store-coupled (15 store imports); structure is kept,
 * wiring is replaced with props/constants. Kept faithfully: role derivation,
 * `filterVisibleParts` visibility, the expanded/collapsed tool caches (module
 * Maps, LRU 4000), tool popup state → ToolOutputDialog, copy actions (markdown
 * + text), `FadeInOnReveal` on user parts, `renderCompare` memo comparators,
 * and `MessageBody` delegation.
 *
 * OpenChamber port seams (each per task-6 brief R3 / handoff corrections):
 *  - DROPPED stores/branches: theme system (CSS vars themed via T2 tokens),
 *    config providers, selection/session-UI/context stores, sonner toasts,
 *    i18n (upstream English strings hardcoded), `MessageFreshnessDetector`
 *    (animation gating → `allowAnimation` false), context-into-context pinning
 *    (`isPinnedIntoContext` + pin handler), `reviewFlow` transfer UI,
 *    `contextObligatoryMessages`, image-preview store flag, `isVSCodeRuntime`
 *    branches (always false), `lazyWithChunkRecovery` (direct import),
 *    `streamPerfCount` counters, revert/fork handlers (no session-ui store).
 *  - DROPPED `@opencode-ai/sdk` types → ported `OcPart`/`ChatMessageEntry`.
 *  - `providerAuthError` special-casing dropped (upstream
 *    `isLikelyProviderAuthFailure`/`PROVIDER_AUTH_FAILURE_MESSAGE` module is
 *    not ported); Tide surfaces provider failures via stopReason/error rows.
 *    The reduced inline error mapping keeps the aborted-info branch.
 *  - `planModeEnabled` derived from a `permissionMode`-carrying part's
 *    metadata/input (else false) — upstream reads a feature-flag store.
 *  - `flattenAssistantTextParts` (upstream lib/messages/messageText) is not
 *    ported; a local reducer replaces it.
 *  - Device info (isMobile/isTablet/hasTouchInput) is store-fed upstream; Tide
 *    is desktop → constants.
 *  - NEW Tide wiring (no upstream equivalent): `AgentNestingProvider` mount
 *    (T4 context; map built from parts' `metadata.parentToolCallId`), and
 *    PermissionCard/QuestionCard mounting for pending tool calls / followup
 *    questions (handoff corrections 2 & 5).
 *  - Signature is plan-mandated: upstream's previousMessage/nextMessage/
 *    animation/review props are not threaded (no neighbors at the call site);
 *    hidden-neighbor padding flags default false.
 */

import React from 'react';

import MessageBody from './message/message-body';
import type { AgentMentionInfo } from './message/types';
import type { StreamPhase, ToolPopupContent } from './message/types';
import { deriveMessageRole } from './message/message-role';
import { filterVisibleParts, normalizeParts } from './message/part-utils';
import { normalizeUserDisplayParts } from './message/normalize-user-display-parts';
import type { TurnGroupingContext, Turn, TurnRecord } from './lib/turns/types';
import type { ChatMessageEntry } from './lib/turns/types';
import type { OcPart, OcToolPart } from './types/opencode-parts';
import { FadeInOnReveal } from './message/fade-in-on-reveal';
import {
  areRenderRelevantMessagesEqual,
  areRelevantTurnGroupingContextsEqual,
} from './message/render-compare';
import ToolOutputDialog from './message/tool-output-dialog';
import { renderMarkdownSync } from './markdown/markdown-core';
import { AgentNestingProvider } from './message/agent-nesting-context';
import { PermissionCard } from './permission-card';
import { QuestionCard } from './question-card';
import type { FollowupQuestionPayload } from './question-serializers';
import { cn } from '@/lib/utils';
import type { AutonomyMode } from '@/types';

/** Upstream UI-store reads → module constants with upstream defaults (brief "Settings surface"). */
const CHAT_DISPLAY_DEFAULTS = {
  showReasoningTraces: true,
  stickyUserHeader: true,
  chatRenderMode: 'live' as 'sorted' | 'live',
  showExpandedBashTools: false,
  showExpandedEditTools: false,
};

/** Desktop app constants replacing upstream's `useDeviceInfo` store reads. */
const IS_MOBILE = false;
const HAS_TOUCH_INPUT = false;

const EXPANDED_TOOLS_CACHE_MAX = 4000;
const expandedToolsStateCache = new Map<string, Set<string>>();
const collapsedToolsStateCache = new Map<string, Set<string>>();

const BASH_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'terminal']);
const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'edit',
  'write',
  'multiedit',
  'str_replace',
  'str_replace_based_edit_tool',
  'create',
  'file_write',
]);

const normalizeToolName = (toolName: unknown): string => {
  if (typeof toolName !== 'string') return '';
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) return '';
  const withoutIndex = trimmed.replace(/:\d+$/, '');
  if (!withoutIndex.includes('.')) {
    return withoutIndex;
  }
  const parts = withoutIndex.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutIndex;
};

const readExpandedToolsCache = (messageId: string): Set<string> => {
  const cached = expandedToolsStateCache.get(messageId);
  return cached ? new Set(cached) : new Set();
};

const writeExpandedToolsCache = (messageId: string, value: Set<string>): void => {
  if (expandedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX && !expandedToolsStateCache.has(messageId)) {
    const oldest = expandedToolsStateCache.keys().next().value;
    if (typeof oldest === 'string') {
      expandedToolsStateCache.delete(oldest);
    }
  }
  expandedToolsStateCache.set(messageId, new Set(value));
};

const readCollapsedToolsCache = (messageId: string): Set<string> => {
  const cached = collapsedToolsStateCache.get(messageId);
  return cached ? new Set(cached) : new Set();
};

const writeCollapsedToolsCache = (messageId: string, value: Set<string>): void => {
  if (collapsedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX && !collapsedToolsStateCache.has(messageId)) {
    const oldest = collapsedToolsStateCache.keys().next().value;
    if (typeof oldest === 'string') {
      collapsedToolsStateCache.delete(oldest);
    }
  }
  collapsedToolsStateCache.set(messageId, new Set(value));
};

function useStickyDisplayValue<T>(value: T | null | undefined): T | null | undefined {
  const [stickyValue, setStickyValue] = React.useState<T | null | undefined>(value);

  React.useEffect(() => {
    if (value !== undefined && value !== null) {
      setStickyValue(value);
    }
  }, [value]);

  return value ?? stickyValue;
}

const getMessageInfoProp = (info: unknown, key: string): unknown => {
  if (typeof info === 'object' && info !== null) {
    return (info as Record<string, unknown>)[key];
  }
  return undefined;
};

/** Local replacement for upstream's `flattenAssistantTextParts` (lib/messages/messageText, not ported). */
const flattenAssistantTextParts = (parts: OcPart[]): string =>
  parts
    .filter((part): part is OcPart & { type: 'text'; text?: string } => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');

/** Clipboard seam: upstream lib/clipboard is not ported; navigator.clipboard replaces it. */
const copyTextToClipboard = async (text: string): Promise<{ ok: boolean }> => {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false };
  }
};

/** Clipboard seam: markdown + rendered HTML payload, mirroring upstream's copyMarkdownToClipboard. */
const copyMarkdownToClipboard = async (markdown: string, html: string): Promise<{ ok: boolean }> => {
  try {
    if (typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return { ok: true };
    }
    await navigator.clipboard.writeText(markdown);
    return { ok: true };
  } catch {
    return { ok: false };
  }
};

const isPendingToolStatus = (status: string): boolean => status === 'pending' || status === 'awaiting_input';

interface OpenChamberChatMessageProps {
  entry: ChatMessageEntry;
  turn?: Turn;
  isStreamingRow?: boolean;
  pendingToolCallIds?: string[];
  /** Tide wiring (task 8): typed to Tide's AutonomyMode (PermissionCard's
   *  seam) so the timeline can pass its onApproveToolCalls straight through. */
  onApprove?: (ids: string[], newMode?: AutonomyMode, remember?: boolean) => void;
  onReject?: (ids: string[], reason?: string) => void;
  onAnswerFollowup?: (toolCallId: string, answer: string, mode?: unknown) => void;
  /** Tide wiring (task 8): controller-owned turn-group expand/collapse state
   *  threaded into TurnGroupingContext (upstream reads it from a store). */
  isGroupExpanded?: boolean;
  /** Tide wiring (task 8): toggles the turn's activity group via the timeline
   *  controller's toggleTurnGroup (upstream dispatches to a store). */
  onToggleGroup?: () => void;
  /** Tide wiring (task 8): active workspace root threaded to MessageBody's
   *  `directory` store seam (path-relative rendering). */
  directory?: string;
  /** Tide wiring: session id for message actions (fork). The tide-adapter does
   *  not stamp info.sessionID, so the timeline threads its own prop down. */
  sessionId?: string | null;
}

const OpenChamberChatMessageImpl: React.FC<OpenChamberChatMessageProps> = ({
  entry,
  turn,
  isStreamingRow = false,
  pendingToolCallIds,
  onApprove,
  onReject,
  onAnswerFollowup,
  isGroupExpanded,
  onToggleGroup,
  directory,
  sessionId,
}) => {
  const { showReasoningTraces, stickyUserHeader, chatRenderMode } = CHAT_DISPLAY_DEFAULTS;
  const messageContainerRef = React.useRef<HTMLDivElement | null>(null);

  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);
  const [copiedMessage, setCopiedMessage] = React.useState(false);
  const [expandedTools, setExpandedTools] = React.useState<Set<string>>(() => readExpandedToolsCache(entry.info.id));
  const [collapsedTools, setCollapsedTools] = React.useState<Set<string>>(() => readCollapsedToolsCache(entry.info.id));
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  React.useEffect(() => {
    setExpandedTools(readExpandedToolsCache(entry.info.id));
    setCollapsedTools(readCollapsedToolsCache(entry.info.id));
  }, [entry.info.id]);

  const messageRole = React.useMemo(() => deriveMessageRole(entry.info), [entry.info]);
  const isUser = messageRole.isUser;
  const useExternalUserActionsRow = isUser && (IS_MOBILE || !stickyUserHeader);
  const showStickyInlineHoverRow = isUser && !IS_MOBILE && stickyUserHeader && !useExternalUserActionsRow;

  // Feature-flag seam: upstream reads a store; Tide derives from a permissionMode-carrying part.
  const planModeEnabled = React.useMemo(() => {
    return entry.parts.some((part) => {
      const carrier = part as { metadata?: Record<string, unknown>; state?: { metadata?: Record<string, unknown> }; input?: Record<string, unknown> };
      const candidates = [carrier.metadata, carrier.state?.metadata, carrier.input];
      return candidates.some((source) => typeof source?.permissionMode === 'string');
    });
  }, [entry.parts]);

  const normalizedParts = React.useMemo(() => {
    const safeParts = normalizeParts(entry.parts);
    if (!isUser) {
      return safeParts;
    }

    return normalizeUserDisplayParts(safeParts, { planModeEnabled });
  }, [isUser, entry.parts, planModeEnabled]);

  // Reduced agent badge derivation: message info mode/agent only (upstream also
  // consults context/selection stores and the previous user message).
  const agentName = React.useMemo(() => {
    if (isUser) return undefined;
    const messageMode = getMessageInfoProp(entry.info, 'mode');
    if (typeof messageMode === 'string' && messageMode.trim().length > 0) {
      return messageMode;
    }
    const messageAgent = getMessageInfoProp(entry.info, 'agent');
    if (typeof messageAgent === 'string' && messageAgent.trim().length > 0) {
      return messageAgent;
    }
    return undefined;
  }, [isUser, entry.info]);

  // Reduced footer model: raw provider/model IDs (upstream resolves display
  // names + variants through its config store).
  const messageProviderID = !isUser ? getMessageInfoProp(entry.info, 'providerID') : null;
  const messageModelID = !isUser ? getMessageInfoProp(entry.info, 'modelID') : null;

  const displayAgentName = useStickyDisplayValue<string>(agentName);
  const displayProviderIDValue = useStickyDisplayValue<string>(typeof messageProviderID === 'string' ? messageProviderID : undefined);
  const displayModelName = useStickyDisplayValue<string>(typeof messageModelID === 'string' ? messageModelID : undefined);

  const headerAgentName = displayAgentName ?? undefined;
  const headerProviderID = displayProviderIDValue ?? null;
  const headerModelName = displayModelName ?? undefined;

  const messageCompletedAt = React.useMemo(() => {
    const timeInfo = entry.info.time as { completed?: number } | undefined;
    return typeof timeInfo?.completed === 'number' ? timeInfo.completed : null;
  }, [entry.info.time]);

  const messageCreatedAt = React.useMemo(() => {
    const timeInfo = entry.info.time as { created?: number } | undefined;
    return typeof timeInfo?.created === 'number' ? timeInfo.created : null;
  }, [entry.info.time]);

  const isMessageCompleted = React.useMemo(() => {
    if (isUser) return true;
    return Boolean(messageCompletedAt && messageCompletedAt > 0);
  }, [isUser, messageCompletedAt]);

  const messageFinish = React.useMemo(() => {
    const finish = (entry.info as { finish?: string }).finish;
    return typeof finish === 'string' ? finish : undefined;
  }, [entry.info]);

  const visibleParts = React.useMemo(
    () =>
      filterVisibleParts(normalizedParts, {
        includeReasoning: showReasoningTraces,
      }),
    [normalizedParts, showReasoningTraces]
  );

  const displayParts = React.useMemo(() => {
    if (isUser) {
      return visibleParts;
    }

    if (!isMessageCompleted && chatRenderMode === 'sorted') {
      return [];
    }

    return visibleParts;
  }, [chatRenderMode, isMessageCompleted, isUser, visibleParts]);

  const toolParts = React.useMemo(() => {
    if (isUser) {
      return [];
    }
    return visibleParts.filter((part): part is OcToolPart => part.type === 'tool');
  }, [isUser, visibleParts]);

  // Turn grouping seam: the plan-mandated signature carries `turn` (a Turn —
  // structurally also a full TurnRecord once T8 threads the projection); rich
  // projection fields are read when present, minimal flags otherwise.
  const turnGroupingContext = React.useMemo<TurnGroupingContext | undefined>(() => {
    if (!turn) return undefined;
    const record = turn as TurnRecord;
    const assistantIds = turn.assistantMessages.map((message) => message.info.id);
    return {
      turnId: turn.turnId,
      isFirstAssistantInTurn: assistantIds[0] === entry.info.id,
      isLastAssistantInTurn: assistantIds[assistantIds.length - 1] === entry.info.id,
      isLatestTurn: isStreamingRow,
      summaryBody: record.summaryText,
      activityParts: record.activityParts ?? [],
      activityGroupSegments: record.activitySegments ?? [],
      headerMessageId: assistantIds[0],
      hasTools: record.hasTools ?? toolParts.length > 0,
      hasReasoning: record.hasReasoning ?? false,
      diffStats: record.diffStats,
      changedFiles: record.changedFiles,
      userMessageCreatedAt: record.userMessage?.info?.time?.created,
      isWorking: isStreamingRow,
      // Tide wiring (task 8): controller-owned group state (see props note) —
      // upstream leaves these store-fed on the context; Tide threads props.
      isGroupExpanded,
      toggleGroup: onToggleGroup,
    };
  }, [entry.info.id, isGroupExpanded, isStreamingRow, onToggleGroup, toolParts.length, turn]);

  const turnActivityToolParts = React.useMemo<OcToolPart[]>(() => {
    if (isUser) {
      return [];
    }
    const records = turnGroupingContext?.activityParts ?? [];
    return records
      .filter((record) => record.kind === 'tool')
      .map((record) => record.part)
      .filter((part): part is OcToolPart => part.type === 'tool');
  }, [isUser, turnGroupingContext?.activityParts]);

  const defaultOpenToolIds = React.useMemo(() => {
    const { showExpandedBashTools, showExpandedEditTools } = CHAT_DISPLAY_DEFAULTS;
    if (!showExpandedBashTools && !showExpandedEditTools) {
      return new Set<string>();
    }

    const next = new Set<string>();
    for (const part of [...toolParts, ...turnActivityToolParts]) {
      const toolId = typeof part?.id === 'string' ? part.id : part?.toolCallId ?? '';
      if (!toolId) continue;
      const toolName = normalizeToolName(part.tool);
      if (!toolName) continue;

      if (showExpandedBashTools && BASH_TOOL_NAMES.has(toolName)) {
        next.add(toolId);
        continue;
      }
      if (showExpandedEditTools && EDIT_TOOL_NAMES.has(toolName)) {
        next.add(toolId);
      }
    }

    return next;
  }, [toolParts, turnActivityToolParts]);

  const effectiveExpandedTools = React.useMemo(() => {
    if (defaultOpenToolIds.size === 0 && collapsedTools.size === 0) {
      return expandedTools;
    }

    const next = new Set(expandedTools);
    defaultOpenToolIds.forEach((toolId) => {
      if (!collapsedTools.has(toolId)) {
        next.add(toolId);
      }
    });
    collapsedTools.forEach((toolId) => {
      next.delete(toolId);
    });
    return next;
  }, [collapsedTools, defaultOpenToolIds, expandedTools]);

  const agentMention = React.useMemo(() => {
    if (!isUser) {
      return undefined;
    }
    const mentionPart = normalizedParts.find((part) => (part as { type?: unknown }).type === 'agent') as
      | { type: 'agent'; name?: string; source?: { value?: string } }
      | undefined;
    if (!mentionPart) {
      return undefined;
    }
    const name = typeof mentionPart.name === 'string' ? mentionPart.name : undefined;
    if (!name) {
      return undefined;
    }
    const rawValue = mentionPart.source && typeof mentionPart.source.value === 'string' && mentionPart.source.value.trim().length > 0
      ? mentionPart.source.value
      : `@${name}`;
    return { name, token: rawValue } satisfies AgentMentionInfo;
  }, [isUser, normalizedParts]);

  const shouldHideUserMessage = isUser && displayParts.length === 0;

  const hasTurnGrouping = Boolean(turnGroupingContext);
  const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;

  const isFollowedByAssistant = React.useMemo(() => {
    if (isUser) return false;
    if (hasTurnGrouping) {
      return !isLastAssistantInTurn;
    }
    return false;
  }, [hasTurnGrouping, isLastAssistantInTurn, isUser]);

  const streamPhase = React.useMemo<StreamPhase>(() => {
    if (isMessageCompleted) {
      return 'completed';
    }
    if (isStreamingRow) {
      return 'streaming';
    }
    return 'completed';
  }, [isStreamingRow, isMessageCompleted]);

  const [hasStartedStreamingHeader, setHasStartedStreamingHeader] = React.useState(false);

  React.useEffect(() => {
    setHasStartedStreamingHeader(false);
  }, [entry.info.id]);

  React.useEffect(() => {
    const headerMessageId = turnGroupingContext?.headerMessageId;
    if (isUser || !headerMessageId || headerMessageId !== entry.info.id) {
      return;
    }

    const isCurrentlyStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
    if (isCurrentlyStreaming) {
      setHasStartedStreamingHeader(true);
    }
  }, [entry.info.id, isUser, streamPhase, turnGroupingContext?.headerMessageId]);

  const shouldShowHeader = React.useMemo(() => {
    if (isUser) return true;

    // Use turn grouping context if available for more precise control
    const headerMessageId = turnGroupingContext?.headerMessageId;
    if (headerMessageId) {
      // For turn grouping: only show header for the first assistant message in the turn
      const isFirstAssistantInTurn = entry.info.id === headerMessageId;

      if (isFirstAssistantInTurn) {
        // For completed messages, always show header (historical messages)
        if (streamPhase === 'completed') {
          return true;
        }

        // For streaming messages: show header when streaming starts and keep it visible
        const isCurrentlyStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
        return hasStartedStreamingHeader || isCurrentlyStreaming;
      }

      // For non-first assistant messages, don't show header
      return false;
    }

    // Ungrouped fallback path: always show assistant header.
    return true;
  }, [hasStartedStreamingHeader, isUser, turnGroupingContext, streamPhase, entry.info.id]);

  const handleCopyCode = React.useCallback((code: string) => {
    void copyTextToClipboard(code).then((result) => {
      if (!result.ok) {
        return;
      }
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    });
  }, []);

  // Reduced error mapping: SessionRetry and provider-auth special cases dropped (header).
  const assistantError = React.useMemo(() => {
    if (isUser) {
      return undefined;
    }
    const errorInfo = (entry.info as { error?: unknown } | undefined)?.error as
      | { data?: { message?: unknown }; message?: unknown; name?: unknown }
      | undefined;
    if (!errorInfo) {
      return undefined;
    }
    const dataMessage = typeof errorInfo.data?.message === 'string' ? errorInfo.data.message : undefined;
    const errorMessage = typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
    const errorName = typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
    const detail = dataMessage || errorMessage || errorName;
    if (!detail) {
      return undefined;
    }
    if (detail.trim().toLowerCase() === 'aborted') {
      return {
        text: 'The running turn was stopped before the next message could be sent.',
        variant: 'info' as const,
      };
    }
    return {
      text: `The turn failed with error:\n\`${detail}\``,
      variant: 'error' as const,
    };
  }, [isUser, entry.info]);

  const assistantErrorText = assistantError?.text;
  const assistantErrorVariant = assistantError?.variant;

  const messageTextContent = React.useMemo(() => {
    if (isUser) {
      const textParts = displayParts
        .filter((part): part is OcPart & { type: 'text'; text?: string; content?: string } => part.type === 'text')
        .map((part) => {
          const text = part.text || part.content || '';
          return text.trim();
        })
        .filter((text) => text.length > 0);

      const combined = textParts.join('\n');
      return combined.replace(/\n\s*\n+/g, '\n');
    }

    if (assistantErrorText && assistantErrorText.trim().length > 0) {
      return assistantErrorText;
    }

    return flattenAssistantTextParts(displayParts);
  }, [assistantErrorText, displayParts, isUser]);

  const hasTextContent = messageTextContent.length > 0;

  const handleCopyMessage = React.useCallback(async () => {
    let result;
    if (isUser) {
      result = await copyTextToClipboard(messageTextContent);
    } else {
      result = await copyMarkdownToClipboard(messageTextContent, renderMarkdownSync(messageTextContent));
    }
    if (!result.ok) {
      return false;
    }
    if (isUser) {
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    }
    return true;
  }, [isUser, messageTextContent]);

  const handleToggleTool = React.useCallback((toolId: string) => {
    const isDefaultOpen = defaultOpenToolIds.has(toolId);
    const isCurrentlyExpanded = effectiveExpandedTools.has(toolId);

    if (isDefaultOpen) {
      setCollapsedTools((prev) => {
        const next = new Set(prev);
        if (isCurrentlyExpanded) {
          next.add(toolId);
        } else {
          next.delete(toolId);
        }
        writeCollapsedToolsCache(entry.info.id, next);
        return next;
      });

      if (!isCurrentlyExpanded) {
        setExpandedTools((prev) => {
          const next = new Set(prev);
          next.delete(toolId);
          writeExpandedToolsCache(entry.info.id, next);
          return next;
        });
      }
      return;
    }

    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      writeExpandedToolsCache(entry.info.id, next);
      return next;
    });

    setCollapsedTools((prev) => {
      if (!prev.has(toolId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(toolId);
      writeCollapsedToolsCache(entry.info.id, next);
      return next;
    });
  }, [defaultOpenToolIds, effectiveExpandedTools, entry.info.id]);

  // Popup seam (handoff correction 6): opens for image/mermaid content only,
  // no image-preview store flag.
  const handleShowPopup = React.useCallback((content: ToolPopupContent) => {
    if (content.image || content.mermaid) {
      setPopupContent(content);
    }
  }, []);

  const handlePopupChange = React.useCallback((open: boolean) => {
    setPopupContent((prev) => ({ ...prev, open }));
  }, []);

  // NEW Tide wiring (handoff correction 5): pending permission parts → PermissionCard.
  const pendingPermissionParts = React.useMemo(() => {
    if (isUser) {
      return [];
    }
    return toolParts.filter((part): part is OcToolPart => {
      const toolCallId = part.toolCallId ?? part.id ?? '';
      if (!toolCallId || !isPendingToolStatus(part.state.status)) {
        return false;
      }
      return !pendingToolCallIds || pendingToolCallIds.includes(toolCallId);
    });
  }, [isUser, pendingToolCallIds, toolParts]);

  // NEW Tide wiring: pending ask_followup_question parts → QuestionCard.
  const pendingFollowupParts = React.useMemo(() => {
    if (isUser) {
      return [];
    }
    return entry.parts.filter((part): part is OcToolPart => {
      if (part.type !== 'tool' || normalizeToolName(part.tool) !== 'ask_followup_question') {
        return false;
      }
      const toolCallId = part.toolCallId ?? part.id ?? '';
      if (!toolCallId || !isPendingToolStatus(part.state.status)) {
        return false;
      }
      return !pendingToolCallIds || pendingToolCallIds.includes(toolCallId);
    });
  }, [entry.parts, isUser, pendingToolCallIds]);

  const followupModeByToolCallId = React.useMemo(() => {
    const map = new Map<string, unknown>();
    entry.parts.forEach((part) => {
      if (part.type === 'followup' && typeof part.toolCallId === 'string') {
        map.set(part.toolCallId, part.mode);
      }
    });
    return map;
  }, [entry.parts]);

  // NEW Tide wiring (handoff correction 2): agent-nesting map from parentToolCallId metadata.
  const childPartsByToolCallId = React.useMemo(() => {
    const map = new Map<string, OcPart[]>();
    entry.parts.forEach((part) => {
      const parentToolCallId = part.metadata?.parentToolCallId;
      if (typeof parentToolCallId !== 'string' || !parentToolCallId) {
        return;
      }
      const bucket = map.get(parentToolCallId);
      if (bucket) {
        bucket.push(part);
      } else {
        map.set(parentToolCallId, [part]);
      }
    });
    return map;
  }, [entry.parts]);

  if (shouldHideUserMessage) {
    return null;
  }

  // Freshness-detector seam: upstream computes this from
  // MessageFreshnessDetector; Tide has no freshness model → animations off.
  const allowAnimation = false;

  const assistantTopPaddingClass = !isUser && shouldShowHeader
    ? (stickyUserHeader ? 'pt-6' : 'pt-0')
    : 'pt-0';
  const userMessageRadius = 'var(--radius-xl)';

  return (
    <>
      <div
        className={cn(
          'group w-full',
          isUser ? 'pt-4' : assistantTopPaddingClass,
          isUser ? 'pb-0' : isFollowedByAssistant ? 'pb-0' : 'pb-2'
        )}
        id={`message-${entry.info.id}`}
        data-message-id={entry.info.id}
        ref={messageContainerRef}
      >
        <AgentNestingProvider value={{ childPartsByToolCallId }}>
          <div className="chat-message-column relative">
            {isUser ? (
              displayParts.length === 0 ? null : (
                <FadeInOnReveal
                  forceAnimation
                  skipAnimation
                  ignoreContextDisabled
                  respectReducedMotion
                >
                  <div className={cn('relative flex justify-end', 'group/user-shell')}>
                    <div className={cn('max-w-[85%]', showStickyInlineHoverRow ? 'pb-5' : undefined)}>
                      <div
                        style={{
                          backgroundColor: 'var(--chat-user-message-bg)',
                          borderRadius: userMessageRadius,
                          borderBottomRightRadius: 'var(--radius-sm)',
                        }}
                        className="px-5 py-3 shadow-none border border-primary/5"
                      >
                        <MessageBody
                          messageId={entry.info.id}
                          parts={displayParts}
                          isUser={isUser}
                          isMessageCompleted={isMessageCompleted}
                          messageFinish={messageFinish}
                          messageCreatedAt={messageCreatedAt ?? undefined}
                          isMobile={IS_MOBILE}
                          hasTouchInput={HAS_TOUCH_INPUT}
                          copiedCode={copiedCode}
                          onCopyCode={handleCopyCode}
                          expandedTools={expandedTools}
                          onToggleTool={handleToggleTool}
                          onShowPopup={handleShowPopup}
                          streamPhase={streamPhase}
                          allowAnimation={allowAnimation}
                          shouldShowHeader={false}
                          hasTextContent={hasTextContent}
                          onCopyMessage={handleCopyMessage}
                          copiedMessage={copiedMessage}
                          showReasoningTraces={showReasoningTraces}
                          agentMention={agentMention}
                          errorMessage={assistantErrorText}
                          errorVariant={assistantErrorVariant}
                          userActionsMode={useExternalUserActionsRow ? 'external-content' : 'inline'}
                          stickyUserHeaderEnabled={stickyUserHeader}
                          directory={directory}
                        />
                      </div>
                    </div>
                  </div>
                </FadeInOnReveal>
              )
            ) : (
              <div className="relative">
                <MessageBody
                  sessionId={sessionId ?? entry.info.sessionID}
                  messageId={entry.info.id}
                  parts={visibleParts}
                  isUser={isUser}
                  isMessageCompleted={isMessageCompleted}
                  messageFinish={messageFinish}
                  messageCompletedAt={messageCompletedAt ?? undefined}
                  messageCreatedAt={messageCreatedAt ?? undefined}
                  isMobile={IS_MOBILE}
                  hasTouchInput={HAS_TOUCH_INPUT}
                  copiedCode={copiedCode}
                  onCopyCode={handleCopyCode}
                  expandedTools={effectiveExpandedTools}
                  onToggleTool={handleToggleTool}
                  onShowPopup={handleShowPopup}
                  streamPhase={streamPhase}
                  allowAnimation={allowAnimation}
                  shouldShowHeader={shouldShowHeader}
                  hasTextContent={hasTextContent}
                  onCopyMessage={handleCopyMessage}
                  copiedMessage={copiedMessage}
                  showReasoningTraces={showReasoningTraces}
                  agentMention={agentMention}
                  turnGroupingContext={turnGroupingContext}
                  errorMessage={assistantErrorText}
                  errorVariant={assistantErrorVariant}
                  footerProviderID={headerProviderID}
                  footerModelName={headerModelName}
                  footerAgentName={headerAgentName}
                  directory={directory}
                />
                {pendingPermissionParts.map((part) => (
                  <PermissionCard
                    key={part.toolCallId ?? part.id ?? ''}
                    toolCallId={part.toolCallId ?? part.id ?? ''}
                    toolName={part.tool}
                    status={part.state.status}
                    arguments={part.state.input ?? part.input}
                    metadata={part.state.metadata ?? part.metadata}
                    onApproveToolCalls={onApprove}
                    onRejectToolCalls={onReject}
                  />
                ))}
                {pendingFollowupParts.map((part) => {
                  const toolCallId = part.toolCallId ?? part.id ?? '';
                  const input = (part.state.input ?? part.input ?? {}) as {
                    question?: unknown;
                    options?: unknown;
                    multiple?: unknown;
                  };
                  const rawOptions = Array.isArray(input.options) ? input.options : [];
                  const payload: FollowupQuestionPayload = {
                    question: typeof input.question === 'string' ? input.question : '',
                    options: rawOptions.map((option) => {
                      if (typeof option === 'string') {
                        return { label: option };
                      }
                      const record = option as { label?: unknown; description?: unknown };
                      return {
                        label: typeof record.label === 'string' ? record.label : '',
                        description: typeof record.description === 'string' ? record.description : undefined,
                      };
                    }),
                    multiple: input.multiple === true,
                  };
                  return (
                    <QuestionCard
                      key={toolCallId}
                      {...payload}
                      toolCallId={toolCallId}
                      mode={followupModeByToolCallId.get(toolCallId)}
                      onAnswerFollowup={onAnswerFollowup}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </AgentNestingProvider>
      </div>
      <ToolOutputDialog
        popup={popupContent}
        onOpenChange={handlePopupChange}
        isMobile={IS_MOBILE}
      />
    </>
  );
};

export const OpenChamberChatMessage = React.memo(OpenChamberChatMessageImpl, (prev, next) => {
  return areRenderRelevantMessagesEqual(
    { info: prev.entry.info, parts: prev.entry.parts },
    { info: next.entry.info, parts: next.entry.parts }
  )
    && prev.isStreamingRow === next.isStreamingRow
    && prev.pendingToolCallIds === next.pendingToolCallIds
    && prev.onApprove === next.onApprove
    && prev.onReject === next.onReject
    && prev.onAnswerFollowup === next.onAnswerFollowup
    // Tide wiring (task 8): group-state + directory props must participate or
    // toggles/workspace switches would not re-render (deriveTurnGroupingContext
    // above does not see them).
    && prev.isGroupExpanded === next.isGroupExpanded
    && prev.onToggleGroup === next.onToggleGroup
    && prev.directory === next.directory
    && prev.sessionId === next.sessionId
    && areRelevantTurnGroupingContextsEqual(
      deriveTurnGroupingContext(prev),
      deriveTurnGroupingContext(next),
      next.entry.info.id,
      deriveMessageRole(next.entry.info).isUser
    );
});

function deriveTurnGroupingContext(props: OpenChamberChatMessageProps): TurnGroupingContext | undefined {
  const { entry, turn, isStreamingRow = false } = props;
  if (!turn) return undefined;
  const record = turn as TurnRecord;
  const assistantIds = turn.assistantMessages.map((message) => message.info.id);
  return {
    turnId: turn.turnId,
    isFirstAssistantInTurn: assistantIds[0] === entry.info.id,
    isLastAssistantInTurn: assistantIds[assistantIds.length - 1] === entry.info.id,
    isLatestTurn: isStreamingRow,
    summaryBody: record.summaryText,
    activityParts: record.activityParts ?? [],
    activityGroupSegments: record.activitySegments ?? [],
    headerMessageId: assistantIds[0],
    hasTools: record.hasTools ?? false,
    hasReasoning: record.hasReasoning ?? false,
    diffStats: record.diffStats,
    changedFiles: record.changedFiles,
    userMessageCreatedAt: record.userMessage?.info?.time?.created,
    isWorking: isStreamingRow,
  };
}

export default OpenChamberChatMessage;
