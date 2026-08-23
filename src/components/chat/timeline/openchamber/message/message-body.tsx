/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/MessageBody.tsx.
 *  Largest adaptation in the port. Kept faithfully: contain-layout constants,
 *  changed-file chips, subtask/shell-action user parts, tool-reveal cache +
 *  animated-tool bookkeeping, sorted-render activity grouping, the renderedParts
 *  loop (text/reasoning/tool ordering, static-vs-expandable tool rows), and the
 *  turn footer (model/variant/agent/duration/timestamp).
 *
 *  Adaptations (each per brief ruling or the judgment rubric):
 *  - Placeholder seams (rulings 2/3) all resolved: `ToolPart` arrived in Task 4
 *    (`./parts/tool-part`, memoized export), `TurnChangedFilesDropdown` in Task 5
 *    (`../turn-changed-files-dropdown`), and `TurnActivity` in Task 6
 *    (`../components/turn-activity`, memoized export).
 *  - Permanently dropped branches (ruling 2): MessageFilesDisplay/FileAttachment,
 *    SaveProjectPlanDialog, ForkSessionDialog, useMessageTTS, useProviderLogo
 *    (footer always renders the Icon fallback), useChatSurfaceMode (surface is
 *    always 'full'), contextPanelEmbeddedChat, TTS/mobile-app/VSCode/Capacitor.
 *  - Also dropped (rubric a — OpenCode-server/app-shell features with no Tide
 *    equivalent or dep): reviewFlow transfer button + `reviewTransferDirection`
 *    prop, multirun fork launcher + ArrowsMerge, loopback message-preview button
 *    (`messagePreviewUrl` + openContextPreview), share-as-image (html-to-image is
 *    not a Tide dep), interactive changed-file pills (navigateToDiff/
 *    openContextDiff) — pills render statically until Task 8 wires navigation,
 *    and `assistantPlanText`/`suggestPlanTitleFromText` (only fed dropped
 *    features).
 *  - Store seams (ruling 6): `useEffectiveDirectory`/`useUIStore` reads become
 *    props — `directory?`, `chatRenderMode?` (default 'sorted'),
 *    `collapsibleThinkingBlocks?` (true), `showSplitAssistantMessageActions?`
 *    (true), `timeFormatPreference?` ('system').
 *  - Callback seams: `onOpenSession?` (subtask session navigation) and
 *    `onAddSelectionToChat?` (threaded to TextSelectionMenu) — later tasks wire.
 *  - `copyTextToClipboard` → `navigator.clipboard`; i18n (`useI18n`) → literal
 *    English; `Part`/`ToolPart` SDK types → Tide's `OcPart`/`OcToolPart`.
 *  - `FileTypeIcon` + `Icon` come from the lucide shim (../icon).
 */

import React from 'react';

import { UserTextPart } from './parts/user-text-part';
import { AssistantTextPart } from './parts/assistant-text-part';
import { ReasoningPart } from './parts/reasoning-part';
import type { OcPart, OcToolPart } from '../types/opencode-parts';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo, ContentChangeReason } from './types';
import type { TurnActivityGroup, TurnActivityRecord, TurnChangedFile, TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { WorkerHighlightedCode } from '../code/worker-highlighted-code';
import { isEmptyTextPart, extractTextContent } from './part-utils';
import { FadeInOnReveal } from './fade-in-on-reveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { MarkdownImageGallery, SimpleMarkdownRenderer } from '../markdown/markdown-renderer';
import { TextSelectionMenu } from './text-selection-menu';
import { Icon, FileTypeIcon } from '../icon';
import { TurnChangedFilesDropdown } from '../turn-changed-files-dropdown';
import { formatTimestampForDisplay } from './time-format';
import type { TimeFormatPreference } from '../lib/time-format';
import { ToolRevealOnMount } from './parts/tool-reveal-on-mount';
import { StaticToolRow } from './parts/progressive-group';
import { ToolPartMemoized as ToolPart } from './parts/tool-part';
import { TurnActivityMemoized as TurnActivity } from '../components/turn-activity';
import { isActiveToolStatus, isExpandableTool, isFinalizedToolStatus, isStandaloneTool } from './tool-render-utils';
import { hasParentToolCall } from '../lib/tide-adapter';
import { getAgentColor } from '../lib/agent-colors';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

/** Upstream reads this from its UI store; Tide threads it as a prop (ruling 6).
 *  Upstream's AssistantTextPart prop defaults to 'live'. */
type ChatRenderMode = 'sorted' | 'live';

const getDisplayFileName = (file: string): string => {
  const normalized = file.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? file;
};

const TurnChangedFileChipContent = React.memo(({ file, interactive = false }: { file: TurnChangedFile; interactive?: boolean }) => (
  <span
    className={cn(
      'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/30 bg-muted/30 px-2 py-1 text-xs text-muted-foreground',
      interactive && 'transition-colors hover:border-border/60 hover:bg-interactive-hover',
    )}
    style={{ lineHeight: 'round(1.35em, 1px)' }}
  >
    <FileTypeIcon filePath={file.file} className="h-3.5 w-3.5 flex-shrink-0" />
    <span className="max-w-52 truncate text-foreground/80" title={file.file}>{getDisplayFileName(file.file)}</span>
    <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
      <span style={{ color: 'var(--status-success)' }}>+{file.additions}</span>
      <span className="text-muted-foreground/70">/</span>
      <span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span>
    </span>
  </span>
));

const StaticTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => (
  <>
    {files.map((file) => (
      <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
        <TurnChangedFileChipContent file={file} />
      </span>
    ))}
  </>
));

/** Seam: upstream renders clickable pills that navigate to the diff viewer (UI-store actions); Tide renders static chips until Task 8 wires navigation. */
const TurnChangedFilePills = React.memo(({ files }: { files?: TurnChangedFile[]; isInteractive: boolean }) => {
  void files;
  if (!files || files.length === 0) return null;

  return <StaticTurnChangedFilePills files={files} />;
});

type SubtaskPartLike = {
  type: 'subtask';
  description?: unknown;
  command?: unknown;
  agent?: unknown;
  prompt?: unknown;
  taskSessionID?: unknown;
  model?: {
    providerID?: unknown;
    modelID?: unknown;
  };
};

type ShellActionPartLike = OcPart & {
  type: 'text';
  shellAction?: {
    command?: unknown;
    output?: unknown;
    status?: unknown;
  };
};

/** Loose cast: Tide's OcPart union has no 'subtask' member, but the adapter's extras may carry one. */
const isSubtaskPart = (part: OcPart): part is OcPart & SubtaskPartLike => {
  return (part as { type?: unknown }).type === 'subtask';
};
const isShellActionPart = (part: OcPart): part is ShellActionPartLike => {
  const textPart = part as unknown as { type?: unknown; shellAction?: unknown };
  return textPart.type === 'text' && typeof textPart.shellAction === 'object' && textPart.shellAction !== null;
};

const normalizeSubtaskModel = (model: SubtaskPartLike['model']): string | null => {
  if (!model || typeof model !== 'object') return null;
  const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
  const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
  if (!providerID || !modelID) return null;
  return `${providerID}/${modelID}`;
};

const UserSubtaskPart: React.FC<{ part: SubtaskPartLike; onOpenSession?: (taskSessionID: string) => void }> = ({ part, onOpenSession }) => {
  const [expanded, setExpanded] = React.useState(false);

  const description = typeof part.description === 'string' ? part.description.trim() : '';
  const command = typeof part.command === 'string' ? part.command.trim() : '';
  const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
  const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
  const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
  const model = normalizeSubtaskModel(part.model);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="typography-meta font-semibold text-foreground">Subtask</span>
        {command ? (
          <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
            /{command}
          </span>
        ) : null}
        {agent ? (
          <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
            @{agent}
          </span>
        ) : null}
        {model ? (
          <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
            {model}
          </span>
        ) : null}
      </div>

      {description ? (
        <div className="typography-ui-label text-foreground/90 mt-1.5">
          {description}
        </div>
      ) : null}

      {prompt ? (
        <div className="mt-2 border-t border-border/60 pt-1.5">
          <button
            type="button"
            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide prompt' : 'Show prompt'}
          </button>
          {expanded ? (
            <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/85">
              {prompt}
            </pre>
          ) : null}
        </div>
      ) : null}

      {taskSessionID && onOpenSession ? (
        <div className="mt-1.5">
          <button
            type="button"
            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            onClick={() => onOpenSession(taskSessionID)}
          >
            Open session
          </button>
        </div>
      ) : null}
    </div>
  );
};

const SHELL_CODE_TAG_STYLE: React.CSSProperties = { background: 'transparent', backgroundColor: 'transparent' };

const UserShellActionPart: React.FC<{ part: ShellActionPartLike }> = ({ part }) => {
  const output = typeof part.shellAction?.output === 'string' ? part.shellAction.output : '';
  const [expanded, setExpanded] = React.useState(true);
  const [copiedOutput, setCopiedOutput] = React.useState(false);
  const copiedResetTimeoutRef = React.useRef<number | null>(null);

  const command = typeof part.shellAction?.command === 'string' ? part.shellAction.command.trim() : '';
  const status = typeof part.shellAction?.status === 'string' ? part.shellAction.status.trim().toLowerCase() : '';
  const hasOutput = output.trim().length > 0;
  const clearCopiedResetTimeout = React.useCallback(() => {
    if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(copiedResetTimeoutRef.current);
      copiedResetTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      clearCopiedResetTimeout();
    };
  }, [clearCopiedResetTimeout]);

  const copyOutputToClipboard = React.useCallback(async () => {
    if (!hasOutput) return;

    try {
      await navigator.clipboard.writeText(output);
    } catch {
      return;
    }

    clearCopiedResetTimeout();
    setCopiedOutput(true);
    if (typeof window !== 'undefined') {
      copiedResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedOutput(false);
        copiedResetTimeoutRef.current = null;
      }, 2000);
    }
  }, [clearCopiedResetTimeout, hasOutput, output]);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="typography-meta font-semibold text-foreground">Shell command</span>
        {status ? (
          <span className={cn(
            'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
            status === 'error'
              ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
              : 'bg-foreground/5 text-muted-foreground',
          )}>
            {status}
          </span>
        ) : null}
      </div>

      {command ? (
        <div className="typography-meta mt-1.5 overflow-x-auto font-mono">
          <WorkerHighlightedCode
            language="bash"
            code={command}
            codeStyle={SHELL_CODE_TAG_STYLE}
            wrap
          />
        </div>
      ) : null}

      {hasOutput ? (
        <div className="mt-2 border-t border-border/60 pt-1.5">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Hide output' : 'Show output'}
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                void copyOutputToClipboard();
              }}
              aria-label={copiedOutput ? 'Copied' : 'Copy output'}
              title={copiedOutput ? 'Copied' : 'Copy output'}
            >
              {copiedOutput ? <Icon name="check" className="h-3.5 w-3.5" /> : <Icon name="file-copy" className="h-3.5 w-3.5" />}
            </button>
          </div>
          {expanded ? (
            <div className="typography-meta mt-1.5 max-h-56 overflow-auto font-mono text-foreground/85">
              <WorkerHighlightedCode
                language="bash"
                code={output}
                codeStyle={SHELL_CODE_TAG_STYLE}
                wrap
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const formatTurnDuration = (durationMs: number): string => {
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
};

interface MessageBodyProps {
  sessionId?: string;
  messageId: string;
  parts: OcPart[];
  isUser: boolean;
  isMessageCompleted: boolean;
  messageFinish?: string;
  messageCompletedAt?: number;
  messageCreatedAt?: number;

  isMobile: boolean;
  alwaysShowActions?: boolean;
  hasTouchInput?: boolean;
  copiedCode: string | null;
  onCopyCode: (code: string) => void;
  expandedTools: Set<string>;
  onToggleTool: (toolId: string) => void;
  onShowPopup: (content: ToolPopupContent) => void;
  streamPhase: StreamPhase;
  allowAnimation: boolean;
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

  shouldShowHeader?: boolean;
  hasTextContent?: boolean;
  onCopyMessage?: () => void | boolean | Promise<void | boolean>;
  copiedMessage?: boolean;
  onAuxiliaryContentComplete?: () => void;
  showReasoningTraces?: boolean;
  agentMention?: AgentMentionInfo;
  turnGroupingContext?: TurnGroupingContext;
  onRevert?: () => void;
  onFork?: () => void;
  errorMessage?: string;
  errorVariant?: 'error' | 'info';
  userActionsMode?: 'inline' | 'external-content' | 'external-actions';
  stickyUserHeaderEnabled?: boolean;
  contextPinned?: boolean;
  contextPinPending?: boolean;
  onToggleContextPin?: () => void;
  footerProviderID?: string | null;
  footerModelName?: string;
  footerAgentName?: string;
  footerVariant?: string;
  isDarkTheme?: boolean;

  /** Store seams (ruling 6) — upstream reads these from its app stores. */
  directory?: string;
  chatRenderMode?: ChatRenderMode;
  collapsibleThinkingBlocks?: boolean;
  showSplitAssistantMessageActions?: boolean;
  timeFormatPreference?: TimeFormatPreference;
  /** Callback seams — later tasks wire. */
  onOpenSession?: (taskSessionID: string) => void;
  onAddSelectionToChat?: (markdownBlock: string) => void;
}

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
  const cached = revealedToolIdsByMessage.get(messageId);
  return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
  if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
    const oldest = revealedToolIdsByMessage.keys().next().value;
    if (oldest) {
      revealedToolIdsByMessage.delete(oldest);
    }
  }
  revealedToolIdsByMessage.set(messageId, new Set(value));
};

const UserMessageBody = React.memo(({ messageId, parts, messageCreatedAt, isMobile, alwaysShowActions = isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, agentMention, onRevert, onFork, contextPinned, contextPinPending, onToggleContextPin, userActionsMode = 'inline', stickyUserHeaderEnabled = true, timeFormatPreference = 'system', onOpenSession, onAddSelectionToChat }: {
  messageId: string;
  parts: OcPart[];
  messageCreatedAt?: number | null;
  isMobile: boolean;
  alwaysShowActions?: boolean;
  hasTouchInput?: boolean;
  hasTextContent?: boolean;
  onCopyMessage?: () => void;
  copiedMessage?: boolean;
  agentMention?: AgentMentionInfo;
  onRevert?: () => void;
  onFork?: () => void;
  contextPinned?: boolean;
  contextPinPending?: boolean;
  onToggleContextPin?: () => void;
  userActionsMode?: 'inline' | 'external-content' | 'external-actions';
  stickyUserHeaderEnabled?: boolean;
  timeFormatPreference?: TimeFormatPreference;
  onOpenSession?: (taskSessionID: string) => void;
  onAddSelectionToChat?: (markdownBlock: string) => void;
}) => {
  const [copyHintVisible, setCopyHintVisible] = React.useState(false);
  const copyHintTimeoutRef = React.useRef<number | null>(null);
  const messageContentRef = React.useRef<HTMLDivElement>(null);

  const userContentParts = React.useMemo(() => {
    return parts.filter((part) => {
      if (part.type === 'text') {
        return !isEmptyTextPart(part);
      }
      if (isSubtaskPart(part)) {
        return true;
      }
      if (isShellActionPart(part)) {
        return true;
      }
      return false;
    });
  }, [parts]);

  const mentionToken = agentMention?.token;
  let mentionInjected = false;

  const canCopyMessage = Boolean(onCopyMessage);
  const isMessageCopied = Boolean(copiedMessage);
  const isTouchContext = Boolean(hasTouchInput ?? isMobile);
  const hasCopyableText = Boolean(hasTextContent);
  const showUserContent = userActionsMode !== 'external-actions';
  const showUserActions = userActionsMode !== 'external-content';
  const useStickyScrollableUserContent = stickyUserHeaderEnabled && userActionsMode === 'inline';

  const clearCopyHintTimeout = React.useCallback(() => {
    if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(copyHintTimeoutRef.current);
      copyHintTimeoutRef.current = null;
    }
  }, []);

  const revealCopyHint = React.useCallback(() => {
    if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
      return;
    }

    clearCopyHintTimeout();
    setCopyHintVisible(true);
    copyHintTimeoutRef.current = window.setTimeout(() => {
      setCopyHintVisible(false);
      copyHintTimeoutRef.current = null;
    }, 1800);
  }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

  React.useEffect(() => {
    if (!hasCopyableText) {
      setCopyHintVisible(false);
      clearCopyHintTimeout();
    }
  }, [clearCopyHintTimeout, hasCopyableText]);

  const handleCopyButtonClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onCopyMessage || !hasCopyableText) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      onCopyMessage();

      if (isTouchContext) {
        revealCopyHint();
      }
    },
    [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint],
  );

  // Seam: upstream's `useChatSurfaceMode` is dropped (ruling 2) — surface is 'full'.
  const effectiveOnFork = onFork;
  const timestamp = React.useMemo(() => {
    if (typeof messageCreatedAt !== 'number' || messageCreatedAt <= 0) return null;
    const formatted = formatTimestampForDisplay(messageCreatedAt, timeFormatPreference);
    return formatted.length > 0 ? formatted : null;
  }, [messageCreatedAt, timeFormatPreference]);
  const actionsBlock = ((canCopyMessage && hasCopyableText) || onRevert || effectiveOnFork || onToggleContextPin) && showUserActions ? (
    <div className={cn(
      'group/user-actions',
      isMobile
        ? userActionsMode === 'inline'
          ? 'flex items-center justify-end pt-2 pb-3'
          : stickyUserHeaderEnabled
            ? 'flex h-9 items-start justify-end pt-0'
            : 'flex h-11 items-start justify-end pt-0'
        : userActionsMode === 'inline'
          ? 'absolute top-full left-0 right-0 z-10 pt-5'
          : 'flex h-8 items-start justify-end pt-2',
    )}>
      <div
        className={cn(
          'flex items-center justify-end gap-1',
          alwaysShowActions
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100',
        )}
      >
        {timestamp ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="mr-1 flex items-center gap-1 text-sm tabular-nums text-muted-foreground/60"
                aria-label={`Message time: ${timestamp}`}
              >
                <Icon name="time" className="h-3.5 w-3.5" />
                <span className="message-footer__label">{timestamp}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{timestamp}</TooltipContent>
          </Tooltip>
        ) : null}
        {onRevert && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label="Revert message"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onRevert();
                }}
              >
                <Icon name="arrow-go-back" className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>Revert message</TooltipContent>
          </Tooltip>
        )}
        {effectiveOnFork && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label="Fork conversation from here"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  effectiveOnFork();
                }}
              >
                <Icon name="git-branch" className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>Fork from here</TooltipContent>
          </Tooltip>
        )}
        {onToggleContextPin && hasCopyableText && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6 bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                  contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                )}
                disabled={contextPinPending}
                aria-pressed={contextPinned}
                aria-label={contextPinned ? 'Unpin message from context' : 'Pin message to context'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onToggleContextPin(); }}
              >
                <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{contextPinned ? 'Unpin from context' : 'Pin to context'}</TooltipContent>
          </Tooltip>
        )}
        {canCopyMessage && hasCopyableText && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label="Copy message"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleCopyButtonClick}
                onFocus={() => setCopyHintVisible(true)}
                onBlur={() => {
                  if (!isMessageCopied) {
                    setCopyHintVisible(false);
                  }
                }}
              >
                {isMessageCopied ? (
                  <Icon name="check" className="h-3 w-3 text-[color:var(--status-success)]" />
                ) : (
                  <Icon name="file-copy" className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>Copy message</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  ) : null;

  if (!showUserContent) {
    return <>{actionsBlock}</>;
  }

  return (
    <div
      className="relative w-full group/message"
      style={CONTAIN_LAYOUT_STYLE}
      onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
    >
      <TextSelectionMenu containerRef={messageContentRef} onAddToChat={onAddSelectionToChat} />
      <div
        className={cn(
          'leading-relaxed text-foreground/90 text-base overflow-x-hidden',
          useStickyScrollableUserContent
            ? 'overflow-y-auto overscroll-contain scrollbar-none'
            : 'overflow-y-hidden',
        )}
        style={useStickyScrollableUserContent ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' } : undefined}
      >
        {/* Positional keys, not part ids: the server echo of a just-sent
            message swaps the optimistic part id, and id-based keys would
            remount the text subtree (blank frame + height jump). */}
        {userContentParts.map((part, index) => {
          if (isSubtaskPart(part)) {
            return (
              <React.Fragment key={`user-subtask-${index}`}>
                <UserSubtaskPart part={part} onOpenSession={onOpenSession} />
              </React.Fragment>
            );
          }

          if (isShellActionPart(part)) {
            return (
              <React.Fragment key={`user-shell-${index}`}>
                <UserShellActionPart part={part} />
              </React.Fragment>
            );
          }

          let mentionForPart: AgentMentionInfo | undefined;
          if (agentMention && mentionToken && !mentionInjected) {
            const candidateText = extractTextContent(part);
            if (candidateText.includes(mentionToken)) {
              mentionForPart = agentMention;
              mentionInjected = true;
            }
          }
          return (
            <React.Fragment key={`user-text-${index}`}>
              <UserTextPart
                part={part}
                messageId={messageId}
                isMobile={isMobile}
                agentMention={mentionForPart}
              />
            </React.Fragment>
          );
        })}
      </div>
      {actionsBlock}
    </div>
  );
});

interface AssistantMessageActionButtonsProps {
  hasCopyableText: boolean;
  isTouchContext: boolean;
  onCopyMessage?: () => void | boolean | Promise<void | boolean>;
}

/** Seam: upstream also offered TTS / review-transfer / save-as-image buttons; all three are dropped (see header). */
const AssistantMessageActionButtons = React.memo(({
  hasCopyableText,
  isTouchContext,
  onCopyMessage,
}: AssistantMessageActionButtonsProps) => {
  const [copyHintVisible, setCopyHintVisible] = React.useState(false);
  const [isMessageCopied, setIsMessageCopied] = React.useState(false);
  const copyHintTimeoutRef = React.useRef<number | null>(null);
  const copiedResetTimeoutRef = React.useRef<number | null>(null);
  const canCopyMessage = Boolean(onCopyMessage);

  const clearCopyHintTimeout = React.useCallback(() => {
    if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(copyHintTimeoutRef.current);
      copyHintTimeoutRef.current = null;
    }
  }, []);

  const clearCopiedResetTimeout = React.useCallback(() => {
    if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(copiedResetTimeoutRef.current);
      copiedResetTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      clearCopyHintTimeout();
      clearCopiedResetTimeout();
    };
  }, [clearCopiedResetTimeout, clearCopyHintTimeout]);

  React.useEffect(() => {
    if (!hasCopyableText || !canCopyMessage) {
      setCopyHintVisible(false);
      setIsMessageCopied(false);
      clearCopyHintTimeout();
      clearCopiedResetTimeout();
    }
  }, [canCopyMessage, clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

  const revealCopyHint = React.useCallback(() => {
    if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
      return;
    }

    clearCopyHintTimeout();
    setCopyHintVisible(true);
    copyHintTimeoutRef.current = window.setTimeout(() => {
      setCopyHintVisible(false);
      copyHintTimeoutRef.current = null;
    }, 1800);
  }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

  const handleCopyButtonClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onCopyMessage || !hasCopyableText) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();

      const copied = await onCopyMessage();
      if (copied === false) {
        return;
      }

      clearCopiedResetTimeout();
      setIsMessageCopied(true);
      if (typeof window !== 'undefined') {
        copiedResetTimeoutRef.current = window.setTimeout(() => {
          setIsMessageCopied(false);
          copiedResetTimeoutRef.current = null;
        }, 2000);
      }

      if (isTouchContext) {
        revealCopyHint();
      }
    },
    [clearCopiedResetTimeout, hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint],
  );

  return (
    <>
      {onCopyMessage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
              className={cn(
                'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                !hasCopyableText && 'opacity-50',
              )}
              disabled={!hasCopyableText}
              aria-label="Copy message"
              aria-hidden={!hasCopyableText}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                void handleCopyButtonClick(event);
              }}
              onFocus={() => {
                if (hasCopyableText) {
                  setCopyHintVisible(true);
                }
              }}
              onBlur={() => {
                if (!isMessageCopied) {
                  setCopyHintVisible(false);
                }
              }}
            >
              {isMessageCopied ? (
                <Icon name="check" className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="file-copy" className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>Copy answer</TooltipContent>
        </Tooltip>
      )}
    </>
  );
});

const AssistantMessageBody = React.memo(({
  sessionId,
  messageId,
  parts,
  isMessageCompleted,
  messageFinish,
  messageCompletedAt,
  messageCreatedAt,

  isMobile,
  alwaysShowActions,
  hasTouchInput,
  expandedTools,
  onToggleTool,
  onShowPopup,
  streamPhase: _streamPhase,
  allowAnimation: _allowAnimation,
  onContentChange,
  hasTextContent = false,
  onCopyMessage,
  onAuxiliaryContentComplete,
  showReasoningTraces = false,
  turnGroupingContext,
  errorMessage,
  errorVariant = 'error',
  contextPinned,
  contextPinPending,
  onToggleContextPin,
  footerModelName,
  footerAgentName,
  footerVariant,
  chatRenderMode: chatRenderModeProp = 'live',
  collapsibleThinkingBlocks = true,
  showSplitAssistantMessageActions = true,
  timeFormatPreference = 'system',
  onAddSelectionToChat,
}: Omit<MessageBodyProps, 'isUser'>) => {
  const streamPhase = _streamPhase;
  void _allowAnimation;
  const messageContentRef = React.useRef<HTMLDivElement>(null);
  const messageTextContentRef = React.useRef<HTMLDivElement>(null);
  const toolRevealReadyRef = React.useRef(false);

  React.useEffect(() => {
    toolRevealReadyRef.current = true;
  }, []);

  const isTouchContext = Boolean(hasTouchInput ?? isMobile);
  const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
  const awaitingMessageCompletion = !isMessageCompleted;
  const animateActivityRows = awaitingMessageCompletion || Boolean(turnGroupingContext?.isWorking);
  const chatRenderMode = chatRenderModeProp;

  const visibleParts = React.useMemo(() => {
    return parts
      .filter((part) => !isEmptyTextPart(part))
      .filter((part) => {
        const rawPart = part as Record<string, unknown>;
        return rawPart.type !== 'compaction';
      })
      // Sub-agent child parts (metadata.parentToolCallId) render nested inside
      // their dispatch_agent ToolPart via AgentNestingContext — keeping them
      // here leaks the sub-agent's activity outside the agent block.
      .filter((part) => !hasParentToolCall(part));
  }, [parts]);

  const toolParts = React.useMemo(() => {
    return visibleParts.filter((part): part is OcToolPart => part.type === 'tool');
  }, [visibleParts]);

  const toolRevealStateRef = React.useRef<{
    messageId: string;
    hasCommitted: boolean;
    persistedToolIds: Set<string>;
    animatedToolIds: Set<string>;
  }>({
    messageId,
    hasCommitted: false,
    persistedToolIds: readRevealedToolIds(messageId),
    animatedToolIds: new Set<string>(),
  });

  if (toolRevealStateRef.current.messageId !== messageId) {
    toolRevealStateRef.current = {
      messageId,
      hasCommitted: false,
      persistedToolIds: readRevealedToolIds(messageId),
      animatedToolIds: new Set<string>(),
    };
  }

  const currentToolIds = React.useMemo(() => {
    const ids = new Set<string>();

    for (const toolPart of toolParts) {
      ids.add(toolPart.id ?? '');
    }

    const activitySegments = turnGroupingContext?.activityGroupSegments;
    if (Array.isArray(activitySegments)) {
      for (const segment of activitySegments) {
        if (segment.anchorMessageId !== messageId) {
          continue;
        }
        for (const activity of segment.parts) {
          if (activity.kind !== 'tool') {
            continue;
          }
          const toolId = (activity.part as { id?: unknown }).id;
          if (typeof toolId === 'string' && toolId.length > 0) {
            ids.add(toolId);
          }
        }
      }
    }

    return Array.from(ids);
  }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);
  const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
  const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
  const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

  if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
    for (const toolId of currentToolIds) {
      if (!persistedToolIds.has(toolId)) {
        animatedToolIds.add(toolId);
      }
    }
  }

  const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
  const animatedToolIdsLookup = React.useMemo(
    () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
    [animatedToolIdsKey],
  );

  React.useEffect(() => {
    const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
    for (const toolId of currentToolIds) {
      nextPersistedToolIds.add(toolId);
    }
    toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
    toolRevealStateRef.current.hasCommitted = true;
    writeRevealedToolIds(messageId, nextPersistedToolIds);
  }, [currentToolIds, messageId]);

  const assistantTextParts = React.useMemo(() => {
    return visibleParts.filter((part) => part.type === 'text');
  }, [visibleParts]);
  const finalizedAssistantMarkdownContents = React.useMemo(() => (
    isMessageCompleted
      ? assistantTextParts.map(extractTextContent).filter((text) => text.trim().length > 0)
      : []
  ), [assistantTextParts, isMessageCompleted]);

  // Seam: upstream's `useChatSurfaceMode` is dropped (ruling 2) — surface is 'full'.
  const isMiniChatSurface = false;
  const canUseProjectPlanActions = !isMiniChatSurface && !isMobile;
  void canUseProjectPlanActions; // Retained for layout parity; plan actions themselves are dropped (see header).

  const isSortedRenderMode = chatRenderMode === 'sorted';
  const collapsedPreviewCount = 7;
  const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
  const hasStopFinish = messageFinish === 'stop';
  const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;

  const hasTools = toolParts.length > 0;

  const hasPendingTools = React.useMemo(() => {
    return toolParts.some((toolPart) => isActiveToolStatus(toolPart.state?.status));
  }, [toolParts]);

  const isActiveTool = React.useCallback((toolPart: OcToolPart): boolean => {
    return isActiveToolStatus(toolPart.state?.status);
  }, []);

  // Seam: upstream required state.time.end for finality; Tide parts carry no
  // per-part timestamps — finality is the Tide status vocabulary.
  const isToolFinalized = React.useCallback((toolPart: OcToolPart) => {
    return isFinalizedToolStatus(toolPart.state?.status);
  }, []);

  const shouldShowTool = React.useCallback((toolPart: OcToolPart): boolean => {
    return isActiveTool(toolPart) || isToolFinalized(toolPart);
  }, [isActiveTool, isToolFinalized]);

  const allToolsFinalized = React.useMemo(() => {
    if (toolParts.length === 0) {
      return true;
    }
    if (hasPendingTools) {
      return false;
    }
    return toolParts.every((toolPart) => isToolFinalized(toolPart));
  }, [toolParts, hasPendingTools, isToolFinalized]);

  const reasoningParts = React.useMemo(() => {
    return visibleParts.filter((part) => part.type === 'reasoning');
  }, [visibleParts]);

  const reasoningComplete = React.useMemo(() => {
    if (reasoningParts.length === 0) {
      return true;
    }
    return reasoningParts.every((part) => {
      const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
      return typeof time?.end === 'number';
    });
  }, [reasoningParts]);

  // Message is considered to have an "open step" if info.finish is not yet present
  const hasOpenStep = typeof messageFinish !== 'string';

  const shouldHoldForReasoning =
    reasoningParts.length > 0
    && hasTools
    && (hasPendingTools || hasOpenStep || !allToolsFinalized);

  const shouldHoldTools = awaitingMessageCompletion
    || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
  const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

  const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
  const isTextlessAssistantMessage = assistantTextParts.length === 0;
  const auxiliaryContentComplete = hasAuxiliaryContent && isTextlessAssistantMessage && !shouldHoldTools && !shouldHoldReasoning && allToolsFinalized && reasoningComplete;
  const auxiliaryCompletionAnnouncedRef = React.useRef(false);
  const soloReasoningScrollTriggeredRef = React.useRef(false);

  React.useEffect(() => {
    soloReasoningScrollTriggeredRef.current = false;
  }, [messageId]);

  React.useEffect(() => {
    if (!auxiliaryContentComplete) {
      auxiliaryCompletionAnnouncedRef.current = false;
      return;
    }
    if (auxiliaryCompletionAnnouncedRef.current) {
      return;
    }
    auxiliaryCompletionAnnouncedRef.current = true;
    onAuxiliaryContentComplete?.();
  }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

  React.useEffect(() => {
    if (awaitingMessageCompletion) {
      soloReasoningScrollTriggeredRef.current = false;
      return;
    }
    if (hasTools) {
      soloReasoningScrollTriggeredRef.current = false;
      return;
    }
    if (reasoningParts.length === 0) {
      return;
    }
    if (shouldHoldReasoning || !reasoningComplete) {
      return;
    }
    if (soloReasoningScrollTriggeredRef.current) {
      return;
    }
    soloReasoningScrollTriggeredRef.current = true;
    onContentChange?.('structural');
  }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

  const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

  const activityPartsForTurn = React.useMemo(() => {
    const all = turnGroupingContext?.activityParts;
    if (!isSortedRenderMode || !all) {
      return [];
    }
    return all;
  }, [isSortedRenderMode, turnGroupingContext?.activityParts]);

  const activityGroupSegmentsForMessage = React.useMemo(() => {
    const all = turnGroupingContext?.activityGroupSegments;
    if (!isSortedRenderMode || !all) {
      return [];
    }
    return all.filter((segment) => segment.anchorMessageId === messageId);
  }, [isSortedRenderMode, messageId, turnGroupingContext?.activityGroupSegments]);

  const hasAnchoredActivitySegments = activityGroupSegmentsForMessage.length > 0;

  const activityByPart = React.useMemo(() => {
    const byRef = new Map<OcPart, TurnActivityRecord>();
    const byId = new Map<string, TurnActivityRecord>();
    activityPartsForTurn.forEach((activity) => {
      byRef.set(activity.part, activity);
      const partId = (activity.part as { id?: unknown }).id;
      if (typeof partId === 'string' && partId.length > 0) {
        byId.set(partId, activity);
      }
    });

    return {
      get: (part: OcPart) => {
        const direct = byRef.get(part);
        if (direct) {
          return direct;
        }
        const partId = (part as { id?: unknown }).id;
        if (typeof partId === 'string' && partId.length > 0) {
          return byId.get(partId);
        }
        return undefined;
      },
    };
  }, [activityPartsForTurn]);

  const toggleActivityGroup = turnGroupingContext?.toggleGroup;
  const isActivityOwnerMessage = !isSortedRenderMode
    || !turnGroupingContext?.activityOwnerMessageId
    || turnGroupingContext.activityOwnerMessageId === messageId
    || hasAnchoredActivitySegments;

  const shouldRenderActivityGroup = isSortedRenderMode
    && isActivityOwnerMessage
    && hasAnchoredActivitySegments
    && Boolean(toggleActivityGroup);

  const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;
  const showErrorMessage = Boolean(errorMessage);
  const errorIconName = errorVariant === 'info' ? 'information' : 'error-warning';
  const isPeekSurface = false;
  const shouldShowMessageActions = hasCopyableText && !isPeekSurface;
  const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage)) && !isPeekSurface;
  const shouldRenderActionsInActivity = isSortedRenderMode;
  const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter && !shouldRenderActionsInActivity;

  const messageActionButtons = React.useMemo(() => (
    <AssistantMessageActionButtons
      hasCopyableText={hasCopyableText}
      isTouchContext={isTouchContext}
      onCopyMessage={onCopyMessage}
    />
  ), [hasCopyableText, isTouchContext, onCopyMessage]);

  const lastRenderableTextPartIndex = React.useMemo(() => {
    if (!shouldShowStandaloneMessageActions) {
      return -1;
    }

    let lastIndex = -1;
    for (let index = 0; index < visibleParts.length; index += 1) {
      const part = visibleParts[index];
      if (!part || part.type !== 'text') {
        continue;
      }
      if (shouldDeferSortedInlineText) {
        continue;
      }
      const activity = activityByPart.get(part);
      if (activity?.kind === 'justification') {
        continue;
      }
      lastIndex = index;
    }

    return lastIndex;
  }, [activityByPart, shouldDeferSortedInlineText, shouldShowStandaloneMessageActions, visibleParts]);

  const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;

  const renderedParts = React.useMemo(() => {
    const rendered: React.ReactNode[] = [];

    const renderSegmentBlock = (segment: TurnActivityGroup): React.ReactNode | null => {
      if (!shouldRenderActivityGroup || !toggleActivityGroup) {
        return null;
      }
      const visibleSegmentParts = showReasoningTraces
        ? segment.parts
        : segment.parts.filter((activity) => activity.kind !== 'reasoning');
      if (visibleSegmentParts.length === 0) {
        return null;
      }
      return (
        <div key={`progressive-group-${segment.id}`} className="mb-3">
          <TurnActivity
            parts={visibleSegmentParts}
            isExpanded={turnGroupingContext?.isGroupExpanded === true}
            collapsedPreviewCount={collapsedPreviewCount}
            onToggle={toggleActivityGroup}
            isMobile={isMobile}
            expandedTools={expandedTools}
            onToggleTool={onToggleTool}
            onShowPopup={onShowPopup}
            onContentChange={onContentChange}
            streamPhase={effectiveStreamPhase}
            showHeader={true}
            animateRows={animateActivityRows}
            animatedToolIds={animatedToolIdsLookup}
            diffStats={turnGroupingContext?.diffStats}
          />
        </div>
      );
    };

    // Segments that follow a standalone tool of THIS message render right
    // after that tool's row so e.g. an Agent Task sits chronologically
    // between the activity before it and the activity after it.
    const localToolPartIds = new Set<string>();
    visibleParts.forEach((part, partIndex) => {
      if (part.type === 'tool') {
        localToolPartIds.add(part.id ?? `${messageId}-part-${partIndex}-${part.type}`);
      }
    });
    const segmentsAfterLocalTool = new Map<string, TurnActivityGroup[]>();
    if (shouldRenderActivityGroup && toggleActivityGroup) {
      activityGroupSegmentsForMessage.forEach((segment) => {
        if (segment.afterToolPartId && localToolPartIds.has(segment.afterToolPartId)) {
          const list = segmentsAfterLocalTool.get(segment.afterToolPartId) ?? [];
          list.push(segment);
          segmentsAfterLocalTool.set(segment.afterToolPartId, list);
          return;
        }
        const block = renderSegmentBlock(segment);
        if (block) {
          rendered.push(block);
        }
      });
    }

    const flushSegmentsAfterTool = (toolPartId: string) => {
      const segments = segmentsAfterLocalTool.get(toolPartId);
      if (!segments) {
        return;
      }
      segmentsAfterLocalTool.delete(toolPartId);
      segments.forEach((segment) => {
        const block = renderSegmentBlock(segment);
        if (block) {
          rendered.push(block);
        }
      });
    };

    // Flat rendering: iterate parts in natural order.
    // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
    // Expandable tools (bash, edit, task) get individual rows.
    // Text renders inline at its natural position.
    let i = 0;
    while (i < visibleParts.length) {
      const part = visibleParts[i];

      if (part.type === 'text') {
        const activity = activityByPart.get(part);
        if (shouldDeferSortedInlineText) {
          i += 1;
          continue;
        }
        if (activity?.kind === 'justification') {
          i += 1;
          continue;
        }
        rendered.push(
          <div key={`assistant-text-${messageId}-${i}`} ref={messageTextContentRef} data-message-text-export-source="true">
            <AssistantTextPart
              part={part}
              sessionId={sessionId}
              messageId={messageId}
              streamPhase={effectiveStreamPhase}
              chatRenderMode={chatRenderMode}
              onContentChange={onContentChange}
              onShowPopup={onShowPopup}
            />
          </div>,
        );
        if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
          rendered.push(
            <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
              <div className="flex items-center gap-1.5" data-message-action-group="true">
                {messageActionButtons}
              </div>
            </div>,
          );
        }
        i++;
        continue;
      }

      if (part.type === 'reasoning') {
        const activity = activityByPart.get(part);
        if (activity?.kind === 'reasoning') {
          i += 1;
          continue;
        }
        if (showReasoningTraces) {
          if (!collapsibleThinkingBlocks) {
            // Non-collapsible mode: render thinking blocks as plain text inline.
            rendered.push(
              <AssistantTextPart
                key={`reasoning-${messageId}-${i}`}
                part={part}
                sessionId={sessionId}
                messageId={messageId}
                streamPhase={effectiveStreamPhase}
                chatRenderMode={chatRenderMode}
                onContentChange={onContentChange}
                onShowPopup={onShowPopup}
              />,
            );
          } else {
            // Per-part mode: each reasoning block at its natural position.
            rendered.push(
              <ReasoningPart
                key={`reasoning-${messageId}-${i}`}
                part={part}
                messageId={messageId}
                streamPhase={effectiveStreamPhase}
                onContentChange={onContentChange}
              />,
            );
          }
        }
        i++;
        continue;
      }

      if (part.type === 'tool') {
        const toolPart = part as OcToolPart;
        const toolName = toolPart.tool?.toLowerCase() ?? '';
        const toolPartId = toolPart.id ?? `${messageId}-part-${i}-${part.type}`;

        if (isSortedRenderMode && !isActivityOwnerMessage) {
          flushSegmentsAfterTool(toolPartId);
          i += 1;
          continue;
        }

        const activity = activityByPart.get(part);
        if (activity?.kind === 'tool' && !isStandaloneTool(toolName)) {
          flushSegmentsAfterTool(toolPartId);
          i += 1;
          continue;
        }

        if (!shouldShowTool(toolPart)) {
          flushSegmentsAfterTool(toolPartId);
          i++;
          continue;
        }

        // Expandable tools: bash, edit, write, task, question — individual rows
        if (isExpandableTool(toolName)) {
          rendered.push(
            <FadeInOnReveal key={`tool-${toolPart.id ?? toolPartId}`}>
              <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id ?? toolPartId)} wipe>
                <ToolPart
                  part={toolPart}
                  isExpanded={expandedTools.has(toolPart.id ?? toolPartId)}
                  onToggle={onToggleTool}
                  isMobile={isMobile}
                  alwaysShowActions={alwaysShowMessageActions}
                  onContentChange={onContentChange}
                  onShowPopup={onShowPopup}
                  animateTailText={animatedToolIdsLookup.has(toolPart.id ?? toolPartId)}
                />
              </ToolRevealOnMount>
            </FadeInOnReveal>,
          );
          flushSegmentsAfterTool(toolPartId);
          i++;
          continue;
        }

        // Static tools: one row per tool call (no grouping)
        rendered.push(
          <FadeInOnReveal key={`static-tools-${toolPart.id ?? toolPartId}`}>
            <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id ?? toolPartId)} wipe>
              <StaticToolRow
                toolName={toolName}
                activities={[
                  {
                    id: toolPart.id ?? toolPartId,
                    turnId: '',
                    messageId,
                    partIndex: 0,
                    part: toolPart,
                    kind: 'tool' as const,
                  },
                ]}
                animateTailText={animatedToolIdsLookup.has(toolPart.id ?? toolPartId)}
              />
            </ToolRevealOnMount>
          </FadeInOnReveal>,
        );
        flushSegmentsAfterTool(toolPartId);
        i++;
        continue;
      }

      // Unknown part type — skip
      i++;
    }

    // Any segments whose anchor tool never got flushed (filtered parts,
    // unexpected ordering) must still render rather than disappear.
    segmentsAfterLocalTool.forEach((segments) => {
      segments.forEach((segment) => {
        const block = renderSegmentBlock(segment);
        if (block) {
          rendered.push(block);
        }
      });
    });

    return rendered;
  }, [
    activityByPart,
    activityGroupSegmentsForMessage,
    alwaysShowMessageActions,
    animatedToolIdsLookup,
    animateActivityRows,
    chatRenderMode,
    collapsibleThinkingBlocks,
    collapsedPreviewCount,
    expandedTools,
    isMobile,
    isActivityOwnerMessage,
    isSortedRenderMode,
    lastRenderableTextPartIndex,
    messageId,
    messageActionButtons,
    sessionId,
    onContentChange,
    onShowPopup,
    onToggleTool,
    shouldRenderActivityGroup,
    shouldShowStandaloneMessageActions,
    shouldShowTool,
    effectiveStreamPhase,
    showReasoningTraces,
    shouldDeferSortedInlineText,
    toggleActivityGroup,
    turnGroupingContext,
    visibleParts,
  ]);

  const turnDurationText = React.useMemo(() => {
    if (!isLastAssistantInTurn || !hasStopFinish) return undefined;
    const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
    if (typeof userCreatedAt !== 'number' || typeof messageCompletedAt !== 'number') return undefined;
    if (messageCompletedAt <= userCreatedAt) return undefined;
    return formatTurnDuration(messageCompletedAt - userCreatedAt);
  }, [isLastAssistantInTurn, hasStopFinish, turnGroupingContext?.userMessageCreatedAt, messageCompletedAt]);

  const footerTimestamp = React.useMemo(() => {
    const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
      ? messageCompletedAt
      : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
    if (timestamp === null) return null;

    const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
    return formatted.length > 0 ? formatted : null;
  }, [messageCompletedAt, messageCreatedAt, timeFormatPreference]);

  const footerTimestampClassName = 'text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1';

  return (
    <div
      ref={messageContentRef}
      data-message-text-export-root="true"
      className={cn(
        'relative w-full group/message',
      )}
      style={CONTAIN_LAYOUT_STYLE}
    >
      <TextSelectionMenu containerRef={messageContentRef} onAddToChat={onAddSelectionToChat} />
      <div>
        <div
          className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
        >
          {renderedParts}
          {showErrorMessage && (
            <FadeInOnReveal key="assistant-error">
              <div className={cn(
                'group/assistant-text relative mt-3 p-3 rounded-lg border break-words max-w-full',
                errorVariant === 'info'
                  ? 'bg-[var(--status-info-background)] border-[var(--status-info-border)]'
                  : 'bg-[var(--status-error-background)] border-[var(--status-error-border)]',
              )}>
                <div className="flex items-center gap-2">
                  <Icon name={errorIconName} className={cn(
                    'h-4 w-4 shrink-0',
                    errorVariant === 'info' ? 'text-[var(--status-info)]' : 'text-[var(--status-error)]',
                  )} />
                  <div className="min-w-0 flex-1 break-words">
                    <SimpleMarkdownRenderer
                      content={errorMessage ?? ''}
                      onShowPopup={onShowPopup}
                      className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                      enableFileReferences={false}
                    />
                  </div>
                </div>
              </div>
            </FadeInOnReveal>
          )}
        </div>
        <MarkdownImageGallery
          sessionId={sessionId}
          messageId={messageId}
          contents={finalizedAssistantMarkdownContents}
          onShowPopup={onShowPopup}
        />
        {shouldRenderStandaloneActionsAfterContent && (
          <div className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
            <div className="flex items-center gap-1.5" data-message-action-group="true">
              {messageActionButtons}
            </div>
          </div>
        )}
        {shouldShowTurnFooter && (
          <div
            className="mt-2 mb-1 flex flex-wrap items-center justify-start gap-x-3 gap-y-1.5"
            style={MESSAGE_FOOTER_CONTAINER_STYLE}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground/60">
              {footerModelName ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* Seam: upstream's useProviderLogo is dropped — always the agent-color icon fallback. */}
                  <Icon
                    name="brain-ai-3"
                    className="h-3.5 w-3.5 flex-shrink-0"
                    style={{ color: `var(${getAgentColor(footerAgentName).var})` }}
                  />
                  <span className="truncate">{footerModelName}</span>
                </span>
              ) : null}
              {footerVariant && !['default', 'none'].includes(footerVariant.toLowerCase()) ? (
                <span className="flex items-center gap-1">
                  <Icon name="brain-ai-3" className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="message-footer__label">
                    {footerVariant[0].toLowerCase() + footerVariant.slice(1)}
                  </span>
                </span>
              ) : null}
              {footerAgentName ? (
                <span className="flex items-center gap-1">
                  <Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="message-footer__label">{footerAgentName}</span>
                </span>
              ) : null}
              {turnDurationText ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                      <Icon name="hourglass" className="h-3.5 w-3.5" />
                      <span className="message-footer__label">{turnDurationText}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{turnDurationText}</TooltipContent>
                </Tooltip>
              ) : null}
              {footerTimestamp ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={footerTimestampClassName}
                      aria-label={`Message time: ${footerTimestamp}`}
                    >
                      <Icon name="time" className="h-3.5 w-3.5" />
                      <span className="message-footer__label">{footerTimestamp}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{footerTimestamp}</TooltipContent>
                </Tooltip>
              ) : null}
              {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
              ) : null}
              {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                <TurnChangedFilePills
                  files={turnGroupingContext?.changedFiles}
                  isInteractive={turnGroupingContext?.isLatestTurn === true}
                />
              ) : null}
            </div>
            <div
              className={cn(
                'flex items-center gap-1.5',
                alwaysShowMessageActions || isTouchContext
                  ? undefined
                  : 'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100',
              )}
              data-message-action-group="true"
            >
              {messageActionButtons}
              {onToggleContextPin && hasCopyableText ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-8 w-8 bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                        contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                      )}
                      disabled={contextPinPending}
                      aria-pressed={contextPinned}
                      aria-label={contextPinned ? 'Unpin message from context' : 'Pin message to context'}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); onToggleContextPin(); }}
                    >
                      <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{contextPinned ? 'Unpin from context' : 'Pin to context'}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        )}

      </div>
    </div>
  );
});

export const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {
  if (isUser) {
    return (
      <UserMessageBody
        messageId={props.messageId}
        parts={props.parts}
        messageCreatedAt={props.messageCreatedAt}
        isMobile={props.isMobile}
        alwaysShowActions={props.alwaysShowActions}
        hasTouchInput={props.hasTouchInput}
        hasTextContent={props.hasTextContent}
        onCopyMessage={props.onCopyMessage}
        copiedMessage={props.copiedMessage}
        agentMention={props.agentMention}
        onRevert={props.onRevert}
        onFork={props.onFork}
        contextPinned={props.contextPinned}
        contextPinPending={props.contextPinPending}
        onToggleContextPin={props.onToggleContextPin}
        userActionsMode={props.userActionsMode}
        stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
        timeFormatPreference={props.timeFormatPreference}
        onOpenSession={props.onOpenSession}
        onAddSelectionToChat={props.onAddSelectionToChat}
      />
    );
  }

  return <AssistantMessageBody {...props} />;
});

export default MessageBody;
