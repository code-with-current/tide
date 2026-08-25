/**
 * Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/parts/ToolPart.tsx.
 * Adaptations (task-4 brief R3–R5):
 * - Tool names: `resolveRendererToolName` (../tool-renderers, R1) maps Tide's
 *   `ToolName` onto the upstream renderer keys this component and the T3
 *   helpers (`lib/tool-helpers`, `message/tool-presentation`,
 *   `message/tool-render-utils`) are written against. Helper signatures that
 *   took `part: ToolPartType` now take the resolved `tool: string` — mechanical,
 *   same logic. Dropped branches for tools Tide never emits: `apply_patch`,
 *   `lsp`, `create`/`file_write`/`view`/`cat` aliases.
 * - Statuses (R3): Tide `ToolCallStatus` arrives as `state.status`. Display
 *   groups: pending-ish = pending|awaiting_input, active = running, completed =
 *   executed, failed-ish = failed|timeout|aborted|partial, rejected = rejected
 *   (kept a distinct predicate; it shares the error icon colour with the
 *   failed-ish group). Upstream's OpenCode strings ('completed'/'error'/
 *   'cancelled') never appear.
 * - Agent nesting (R4): upstream's child-session machinery (`taskToolModel`,
 *   `useSessionMessageRecords`, session-open button) is replaced by
 *   `../agent-nesting-context` — nested rows are real `TimelinePart`s rendered
 *   through ToolPart itself, so depth beyond one level works for free. The
 *   agent report comes from `metadata.report` (Tide adapter) instead of the
 *   task-metadata block stripper.
 * - Dropped (R5, delete-on-sight list): `useMobileAppActions`,
 *   `RuntimeAPIContext` (all editor open-file/open-diff navigation — clicking a
 *   row now always toggles), `MessageFilesDisplay` attachments,
 *   `sessionEvents.requestGitRefresh`, `useSessionUIStore`, `useUIStore`
 *   (`showToolFileIcons` is a local `true` constant until T8 threads a prop),
 *   sync stores, `ContentChangeReason` notify (Tide's `use-chat-auto-follow.ts`
 *   is ResizeObserver-driven; the prop is kept for the parent contract but
 *   unused), `ApplyPatchFileButtons` + `applyPatchEditorAction`,
 *   `isEmbeddedSessionChat`, `useI18n` (literal English), LSP diagnostics.
 * - Mapped (R5): `lazyWithChunkRecovery` → `React.lazy`; `useEffectiveDirectory`
 *   → `directory?: string` prop (T6/T8 thread it); `ScrollShadow` → plain div
   *   with the same className contract; `Text` app component → plain `<span>`
 *   (upstream's generate-effect variant has no Tide equivalent — T3 precedent
 *   in progressive-group.tsx); `JsonTreeViewer` ui-kit → local minimal
 *   disclosure tree below; `useDurationTickerNow` → local ticker hook below;
 *   `copyTextToClipboard` → inline `navigator.clipboard`; `toast` → `@/lib/toast`.
 * - ADDED (Tide-native, user request): PixelLoader in the row header while a
 *   tool runs — upstream's only running cue is the subtle title shimmer plus a
 *   bash-only duration, which reads as "no progress indicator".
 * - Types: SDK `ToolPart`/`ToolState`/`FilePart` → vendored `TimelineToolPart`/
 *   `TimelineToolState` from ../../types/message-parts (TimelineToolState already carries
 *   metadata/input/output/error/title/time, so the upstream intersection type
 *   is redundant).
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { toolTextColor } from '@/lib/tool-colors';
import { agentSessionDisplayName } from '@/components/blocks/agent-status';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { PixelLoader } from '@/components/ui/pixel-loader';

import { SimpleMarkdownRenderer } from '../../markdown/markdown-renderer';
import { getToolMetadata } from '../../lib/tool-helpers';
import { toolDisplayStyles } from '../../lib/typography';
import { WorkerHighlightedCode } from '../../code/worker-highlighted-code';
import { Icon, FileTypeIcon } from '../../icon';
import type { TimelinePart, TimelineToolPart, TimelineToolState } from '../../types/message-parts';
import type { ContentChangeReason, ToolPopupContent } from '../types';
import { PlainDiffFallback } from './plain-diff-fallback';
import {
  formatEditOutput,
  detectLanguageFromOutput,
  formatInputForDisplay,
  renderTodoOutput,
  resolveRendererToolName,
  tryParseJsonOutput,
  coerceToText,
} from '../tool-renderers';
import { JsonSummaryView } from './json-summary-view';
import { DiffViewToggle, type DiffViewMode } from '../diff-view-toggle';
import { MinDurationShineText } from './min-duration-shine-text';
import { ToolRevealOnMount } from './tool-reveal-on-mount';
import { getToolIcon } from '../tool-presentation';
import { usePanelActions } from '../../panel-actions-context';
import { parseUnifiedDiff } from '@/lib/stream/parse-diff';
import { Bot, FileDiff, FileText } from 'lucide-react';
import { areRenderRelevantPartsEqual } from '../render-compare';
import {
  getDiffPatchEntries,
  getPatchText,
  type DiffPatchEntry,
} from '../tool-diff-utils';
import { useStreamingTextThrottle } from '../../hooks/use-streaming-text-throttle';
import { getStreamingOutputAppend, getToolOutput } from '../tool-output';
import { getToolDescriptionFallback, isFinalizedToolStatus } from '../tool-render-utils';
import { useChildToolParts } from '../agent-nesting-context';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type ToolStateWithMetadata = TimelineToolState;

export interface ToolPartProps {
  part: TimelineToolPart;
  isExpanded: boolean;
  onToggle: (toolId: string) => void;
  isMobile: boolean;
  alwaysShowActions?: boolean;
  /** Kept for the parent contract; Tide's auto-follow is ResizeObserver-driven, so no manual notify happens. */
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
  onShowPopup?: (content: ToolPopupContent) => void;
  animateTailText?: boolean;
  /** Working directory used to shorten absolute paths; threaded by T6/T8 (upstream: useEffectiveDirectory). */
  directory?: string;
}

const normalizeToolName = (toolName: string | undefined | null): string => {
  if (typeof toolName !== 'string') {
    return '';
  }

  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  if (trimmed.includes('.')) {
    const dotParts = trimmed.split('.').filter(Boolean);
    const last = dotParts[dotParts.length - 1];
    if (last) return last;
  }

  return trimmed;
};

const resolveToolKey = (toolName: string | undefined | null): string => {
  return normalizeToolName(resolveRendererToolName(toolName));
};

const EDIT_FAMILY_TOOLS = new Set(['edit', 'multiedit', 'write']);

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
  const duration = Math.max(0, (end ?? now) - start);
  const seconds = duration / 1000;

  const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
  return `${displaySeconds.toFixed(1)}s`;
};

const useDurationTickerNow = (active: boolean, intervalMs: number): number => {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);

  return now;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
  const now = useDurationTickerNow(active, 250);

  return <>{formatDuration(start, end, now)}</>;
};

const deferredToolBodyMounts: Array<{ active: boolean; fn: () => void }> = [];
let deferredToolBodyFrame: number | undefined;

const flushDeferredToolBodyMounts = () => {
  while (deferredToolBodyMounts.length > 0) {
    const item = deferredToolBodyMounts.pop();
    if (!item) {
      break;
    }
    if (item.active) {
      item.fn();
      deferredToolBodyFrame = deferredToolBodyMounts.length > 0
        ? window.requestAnimationFrame(flushDeferredToolBodyMounts)
        : undefined;
      return;
    }
  }

  deferredToolBodyFrame = undefined;
};

const scheduleDeferredToolBodyMount = (fn: () => void) => {
  if (typeof window === 'undefined') {
    fn();
    return () => undefined;
  }

  const item = { active: true, fn };
  deferredToolBodyMounts.push(item);

  if (deferredToolBodyFrame === undefined) {
    deferredToolBodyFrame = window.requestAnimationFrame(() => {
      deferredToolBodyFrame = window.requestAnimationFrame(flushDeferredToolBodyMounts);
    });
  }

  return () => {
    item.active = false;
  };
};

const useDeferredExpandedContent = (isExpanded: boolean) => {
  // Render the body synchronously when the row first mounts expanded so the
  // virtualizer measures the real height immediately; only later user-initiated
  // expansions defer to an animation frame.
  const [shouldRender, setShouldRender] = React.useState(isExpanded);
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    if (!isExpanded) {
      mountedRef.current = true;
      setShouldRender(false);
      return;
    }

    if (!mountedRef.current) {
      mountedRef.current = true;
      setShouldRender(true);
      return;
    }

    return scheduleDeferredToolBodyMount(() => {
      setShouldRender(true);
    });
  }, [isExpanded]);

  return shouldRender;
};

const parseDiffStats = (metadata?: Record<string, unknown>): { added: number; removed: number } | null => {
  const diffText = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
    ?? getPatchText(metadata?.diff);
  if (!diffText) return null;

  let added = 0;
  let removed = 0;
  let lineStart = 0;

  for (let index = 0; index <= diffText.length; index += 1) {
    if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
      continue;
    }

    const line = diffText.slice(lineStart, index);
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
    lineStart = index + 1;
  }

  if (added === 0 && removed === 0) return null;
  return { added, removed };
};

const parseWriteLineCount = (input?: Record<string, unknown>): number | null => {
  if (!input?.content || typeof input.content !== 'string') return null;
  let lines = 1;
  for (let index = 0; index < input.content.length; index += 1) {
    if (input.content.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
};

const buildWritePreviewPatch = (filePath: string | undefined, content: string): string | undefined => {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  if (!normalizedContent.trim()) {
    return undefined;
  }

  const normalizedPath = (() => {
    const candidate = (filePath ?? '').trim();
    if (!candidate) {
      return 'new-file';
    }
    return candidate.startsWith('/') ? candidate.slice(1) : candidate;
  })();

  const lines = normalizedContent.split('\n');
  const hunkSize = lines.length;
  const body = lines.map((line) => `+${line}`).join('\n');

  return [
    '--- /dev/null',
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${hunkSize} @@`,
    body,
  ].join('\n');
};

const normalizeDisplayPath = (value: string): string => {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!trimmed || trimmed === '/') {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, '');
};

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
  const normalizedAbsolutePath = normalizeDisplayPath(absolutePath);
  const normalizedCurrentDirectory = normalizeDisplayPath(currentDirectory);

  if (!normalizedAbsolutePath) {
    return '';
  }

  if (!normalizedCurrentDirectory) {
    return normalizedAbsolutePath;
  }

  if (normalizedAbsolutePath === normalizedCurrentDirectory) {
    return '.';
  }

  const prefix = `${normalizedCurrentDirectory}/`;
  if (normalizedAbsolutePath.startsWith(prefix)) {
    return normalizedAbsolutePath.slice(prefix.length);
  }

  return normalizedAbsolutePath;
};

// Parse question tool output: "User has answered your questions: "Q1"="A1", "Q2"="A2". You can now..."
const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
  const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
  if (!match) return null;

  const pairs: Array<{ question: string; answer: string }> = [];
  const content = match[1];

  const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
  let pairMatch;
  while ((pairMatch = pairRegex.exec(content)) !== null) {
    pairs.push({
      question: pairMatch[1],
      answer: pairMatch[2],
    });
  }

  return pairs.length > 0 ? pairs : null;
};

const getToolDescriptionPath = (
  tool: string,
  state: ToolStateWithMetadata,
  currentDirectory: string,
): string | null => {
  const metadata = state.metadata;
  const input = state.input;

  if ((tool === 'edit' || tool === 'multiedit') && input) {
    const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
    if (typeof filePath === 'string') {
      return getRelativePath(filePath, currentDirectory);
    }
  }

  if (tool === 'read' && input) {
    const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
    if (typeof filePath === 'string') {
      return getRelativePath(filePath, currentDirectory);
    }
  }

  if (tool === 'write' && input) {
    const filePath = input?.filePath || input?.file_path || input?.path;
    if (typeof filePath === 'string') {
      return getRelativePath(filePath, currentDirectory);
    }
  }

  return null;
};

const getToolDescription = (tool: string, state: ToolStateWithMetadata, currentDirectory: string): string => {
  const metadata = state.metadata;
  const input = state.input;

  const filePathLabel = getToolDescriptionPath(tool, state, currentDirectory);
  if (filePathLabel) {
    return filePathLabel;
  }

  if (tool === 'question' && input?.questions && Array.isArray(input.questions)) {
    const count = input.questions.length;
    return `Asked ${count} question${count !== 1 ? 's' : ''}`;
  }

  if (tool === 'bash' && input?.command && typeof input.command === 'string') {
    const firstLine = input.command.split('\n')[0];
    return firstLine.substring(0, 100);
  }

  if (tool === 'task' && input?.description && typeof input.description === 'string') {
    return input.description.substring(0, 80);
  }

  const desc = input?.description || metadata?.description || state.title || '';
  return getToolDescriptionFallback(tool, desc, input);
};

interface ToolScrollableSectionProps {
  children: React.ReactNode;
  maxHeightClass?: string;
  className?: string;
  outerClassName?: string;
  disableHorizontal?: boolean;
  followKey?: string;
}

const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
  children,
  maxHeightClass = 'max-h-[60vh]',
  className,
  outerClassName,
  disableHorizontal = false,
  followKey,
}) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const isFollowingRef = React.useRef(true);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (followKey === undefined) {
      isFollowingRef.current = true;
      return;
    }
    if (!element || !isFollowingRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [followKey]);

  return (
    <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
      <div
        ref={scrollRef}
        data-scrollable="true"
        onWheelCapture={(event) => {
          if (followKey !== undefined && event.deltaY < 0) {
            isFollowingRef.current = false;
          }
        }}
        onScroll={(event) => {
          if (followKey === undefined) {
            return;
          }
          const element = event.currentTarget;
          isFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        }}
        className={cn(
          'tool-output-surface p-2 rounded-xl w-full min-w-0',
          maxHeightClass,
          disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
          className,
        )}
      >
        <div className="w-full min-w-0">
          {children}
        </div>
      </div>
    </div>
  );
};

const getToolOutputLanguage = (
  output: string,
  tool: string,
  metadata: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): string => {
  if (tool === 'bash') {
    return 'bash';
  }

  return detectLanguageFromOutput(formatEditOutput(output, tool, metadata), tool, input);
};

const getToolOutputText = (
  output: string,
  tool: string,
  metadata: Record<string, unknown> | undefined,
): string => {
  if (tool === 'bash') {
    return output;
  }

  return formatEditOutput(output, tool, metadata);
};

const StreamingPlainTextOutput: React.FC<{ output: string }> = ({ output }) => {
  const preRef = React.useRef<HTMLPreElement>(null);
  const previousOutputRef = React.useRef('');

  React.useLayoutEffect(() => {
    const element = preRef.current;
    if (!element) {
      return;
    }

    const firstChild = element.firstChild;
    const textNode = firstChild instanceof globalThis.Text
      ? firstChild
      : document.createTextNode('');
    if (textNode !== firstChild) {
      element.replaceChildren(textNode);
    }

    const append = getStreamingOutputAppend(previousOutputRef.current, output);
    if (append === undefined) {
      textNode.data = output;
    } else if (append.length > 0) {
      textNode.appendData(append);
    }
    previousOutputRef.current = output;
  }, [output]);

  return (
    <pre
      ref={preRef}
      className="m-0 whitespace-pre-wrap break-words"
      style={{
        ...TOOL_COLLAPSED_CUSTOM_STYLE,
        lineHeight: 'round(var(--code-block-line-height), 1px)',
        overflowWrap: 'break-word',
      }}
    />
  );
};

const JsonTreeNode: React.FC<{
  value: unknown;
  keyName?: string;
  depth: number;
  initiallyExpandedDepth: number;
}> = ({ value, keyName, depth, initiallyExpandedDepth }) => {
  const [open, setOpen] = React.useState(depth < initiallyExpandedDepth);
  const isObject = value !== null && typeof value === 'object';

  if (!isObject) {
    return (
      <div className="typography-code whitespace-pre-wrap break-words">
        {keyName !== undefined && <span className="text-muted-foreground">{keyName}: </span>}
        <span className={typeof value === 'string' ? 'text-foreground' : 'text-primary'}>{coerceToText(value)}</span>
      </div>
    );
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex w-full items-start gap-1 typography-code text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="mt-0.5 h-3 w-3 flex-shrink-0" />
        <span className="text-muted-foreground truncate">
          {keyName !== undefined ? `${keyName}: ` : ''}{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open ? (
        <div className="space-y-0.5 pl-3">
          {entries.map(([key, child]) => (
            <JsonTreeNode
              key={key}
              keyName={key}
              value={child}
              depth={depth + 1}
              initiallyExpandedDepth={initiallyExpandedDepth}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** Local stand-in for the upstream's ui-kit `JsonTreeViewer` (T3-brief R5 mapping). */
const JsonTreeViewer: React.FC<{ data: unknown; initiallyExpandedDepth?: number; maxHeight?: string }> = ({
  data,
  initiallyExpandedDepth = 1,
  maxHeight = '400px',
}) => (
  <div className="typography-code w-full min-w-0 overflow-auto" style={{ maxHeight }}>
    <JsonTreeNode value={data} depth={0} initiallyExpandedDepth={initiallyExpandedDepth} />
  </div>
);

const ToolScrollableTextOutput: React.FC<{
  output: string;
  tool: string;
  metadata: Record<string, unknown> | undefined;
  input: Record<string, unknown> | undefined;
  isStreaming?: boolean;
}> = ({ output, tool, metadata, input, isStreaming = false }) => {
  const renderedOutput = getToolOutputText(output, tool, metadata);
  const outputLanguage = getToolOutputLanguage(output, tool, metadata, input);
  const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
  const [jsonViewMode, setJsonViewMode] = React.useState<'summary' | 'formatted' | 'raw'>('summary');
  const [copiedJson, setCopiedJson] = React.useState(false);

  React.useEffect(() => {
    setJsonViewMode('summary');
    setCopiedJson(false);
  }, [renderedOutput]);

  const handleJsonViewChange = React.useCallback((view: 'summary' | 'formatted' | 'raw', event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setJsonViewMode(view);
  }, []);

  const handleCopyOutput = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(renderedOutput);
    } catch {
      toast.error('Failed to copy output');
      return;
    }
    setCopiedJson(true);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setCopiedJson(false), 1200);
    }
  }, [renderedOutput]);

  if (tool === 'bash' && isStreaming) {
    return (
      <div className="typography-code text-muted-foreground/90">
        <StreamingPlainTextOutput output={renderedOutput} />
      </div>
    );
  }

  if (jsonResult.isJson) {
    return (
      <div className="tool-output-surface relative p-2 rounded-xl w-full min-w-0">
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
            onClick={(event) => handleJsonViewChange('summary', event)}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Show summary JSON view"
            title="Show summary JSON view"
          >
            <Icon name="list-unordered" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
            onClick={(event) => handleJsonViewChange('formatted', event)}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Show formatted JSON tree"
            title="Show formatted JSON tree"
          >
            <Icon name="node-tree" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
            onClick={(event) => handleJsonViewChange('raw', event)}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Show raw JSON"
            title="Show raw JSON"
          >
            <Icon name="code-box" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
            onClick={handleCopyOutput}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={copiedJson ? 'Copied' : 'Copy'}
            title={copiedJson ? 'Copied' : 'Copy'}
          >
            <Icon name={copiedJson ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
          </Button>
        </div>
        {jsonViewMode === 'summary' ? (
          <JsonSummaryView data={jsonResult.data} />
        ) : jsonViewMode === 'formatted' ? (
          <JsonTreeViewer
            data={jsonResult.data}
            initiallyExpandedDepth={1}
            maxHeight="400px"
          />
        ) : (
          <div className="typography-code pr-12 text-muted-foreground/90">
            <WorkerHighlightedCode
              language="json"
              code={renderedOutput}
              style={TOOL_COLLAPSED_CUSTOM_STYLE}
              codeStyle={CODE_TAG_PROPS.style}
              wrap
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={tool === 'bash' ? 'typography-code text-muted-foreground/90' : undefined}>
      <WorkerHighlightedCode
        language={outputLanguage}
        code={renderedOutput}
        style={TOOL_COLLAPSED_CUSTOM_STYLE}
        codeStyle={CODE_TAG_PROPS.style}
        wrap
      />
    </div>
  );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';

const isToolPart = (part: TimelinePart): part is TimelineToolPart => part.type === 'tool';

const AGENT_NESTING_COLLAPSED_ROWS = 6;

/**
 * Tide replacement for upstream's TaskToolSummary (R4): nested rows come from
 * the agent-nesting context instead of a child session, and each row is a real
 * ToolPart — so nested agents (depth > 1) recurse through the same component.
 */
const AgentToolNesting: React.FC<{
  toolCallId: string | undefined;
  report: string | undefined;
  isExpanded: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  animateTailText: boolean;
  isActive: boolean;
}> = ({ toolCallId, report, isExpanded, onShowPopup, animateTailText = true, isActive = false }) => {
  const childParts = useChildToolParts(toolCallId);
  const childToolParts = React.useMemo(() => childParts.filter(isToolPart), [childParts]);
  const [expandedChildren, setExpandedChildren] = React.useState<Set<string>>(new Set());
  const [isReportExpanded, setIsReportExpanded] = React.useState(false);

  const handleChildToggle = React.useCallback((toolId: string) => {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  }, []);

  const visibleChildren = isExpanded ? childToolParts : childToolParts.slice(-AGENT_NESTING_COLLAPSED_ROWS);
  const hiddenCount = Math.max(0, childToolParts.length - visibleChildren.length);
  const visibleStartIndex = childToolParts.length - visibleChildren.length;
  const hasReport = typeof report === 'string' && report.trim().length > 0;

  if (childToolParts.length === 0 && !hasReport) {
    return (
      <div className="relative pr-2 pb-1.5 pt-0.5 space-y-1 pl-[1.4375rem]">
        <div className="typography-meta text-muted-foreground/70">
          {isActive ? 'Waiting for subagent activity...' : 'No subagent activity recorded.'}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative pr-2 pb-1.5 pt-0.5 space-y-1 pl-[1.4375rem]',
        'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
        'before:top-[-0.25rem] before:bottom-0'
      )}
    >
      {childToolParts.length > 0 ? (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
          <div className="w-full min-w-0 space-y-1">
            {hiddenCount > 0 ? (
              <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
            ) : null}

            {visibleChildren.map((child, index) => {
              const absoluteIndex = isExpanded ? index : visibleStartIndex + index;
              const childId = child.id ?? child.toolCallId ?? `${child.tool}:${absoluteIndex}`;
              return (
                <ToolRevealOnMount key={childId} animate={animateTailText} wipe>
                  <ToolPart
                    part={child}
                    isExpanded={expandedChildren.has(childId)}
                    onToggle={handleChildToggle}
                    isMobile={false}
                    onShowPopup={onShowPopup}
                    animateTailText={animateTailText}
                  />
                </ToolRevealOnMount>
              );
            })}
          </div>
        </ToolScrollableSection>
      ) : null}

      {hasReport ? (
        <div className={cn('space-y-1', childToolParts.length > 0 && 'pt-1')}>
          <button
            type="button"
            className="flex items-center gap-2 typography-meta text-foreground/80 hover:text-foreground w-full"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setIsReportExpanded((prev) => !prev);
            }}
          >
            {isReportExpanded ? (
              <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
            ) : (
              <Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-shrink-0" />
            )}
            <span className="typography-meta text-foreground/80 font-medium">Report</span>
          </button>
          {isReportExpanded ? (
            <ToolScrollableSection maxHeightClass="max-h-[50vh]">
              <div className="w-full min-w-0">
                <SimpleMarkdownRenderer content={report ?? ''} variant="tool" onShowPopup={onShowPopup} />
              </div>
            </ToolScrollableSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const TOOL_COLLAPSED_CUSTOM_STYLE: React.CSSProperties = {
  ...toolDisplayStyles.getCollapsedStyles(),
  padding: 0,
  overflow: 'visible',
};

const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

const TOOL_ERROR_ICON_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_ICON_STYLE: React.CSSProperties = { color: 'var(--tools-icon)' };
const TOOL_ERROR_TITLE_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_TITLE_STYLE: React.CSSProperties = { color: 'var(--tools-title)' };

const renderPathLikeGitChanges = (path: string, grow = true) => {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return (
      <span
        className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
        style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
        title={path}
      >
        {path}
      </span>
    );
  }

  const dir = path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  const hasAbsoluteRoot = dir.startsWith('/');
  const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

  return (
    <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
      {hasAbsoluteRoot ? <span className="flex-shrink-0 text-muted-foreground">/</span> : null}
      <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>
        {displayDir}
      </span>
      <span className="flex-shrink-0">
        <span className="text-muted-foreground">/</span>
        <span className="text-foreground">{name}</span>
      </span>
    </span>
  );
};

const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true, showFileIcons = true) => {
  void animate; // Seam: upstream's Text generate-effect variant is a plain span here.
  const lastSlash = path.lastIndexOf('/');

  if (lastSlash === -1) {
    return (
      <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
        {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
        <span
          className={cn('min-w-0 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}
          style={{ color: 'var(--tools-title)' }}
        >
          {path}
        </span>
      </span>
    );
  }

  const dir = path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  const hasAbsoluteRoot = dir.startsWith('/');
  const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

  return (
    <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
      {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
      <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}>
        {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
        <span
          className="min-w-0 shrink truncate whitespace-nowrap"
          style={{
            color: 'var(--tools-description)',
            direction: 'rtl',
            textAlign: 'left',
            unicodeBidi: 'plaintext',
          }}
        >
          {displayDir}
        </span>
        <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
        <span
          className="flex-shrink-0"
          style={{ color: 'var(--tools-title)' }}
        >
          {name}
        </span>
      </span>
    </span>
  );
};

// The rich diff preview is the only tool-card piece that needs the
// @pierre/diffs + Shiki stack; lazy-loading it keeps that stack out of the
// eager chat graph. While the chunk loads, the plain-text patch renders as the
// Suspense fallback, mirroring the preview's own error fallback.
const LazyToolPartDiffPreview = React.lazy(() => import('./tool-part-diff-preview'));

const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => (
  <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
    <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
  </React.Suspense>
);

interface ToolExpandedContentProps {
  part: TimelineToolPart;
  tool: string;
  state: ToolStateWithMetadata;
  currentDirectory: string;
  isExpanded: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
  part,
  tool,
  state,
  currentDirectory,
  isExpanded,
  onShowPopup,
}) => {
  const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
  const metadata = state.metadata;
  const input = state.input;
  const rawOutput = getToolOutput(tool, state.output, metadata?.output, state.status);
  const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
  const rawOutputString = typeof rawOutput === 'string' ? rawOutput : '';
  const isStreamingBash = tool === 'bash' && state.status === 'running';
  const throttledOutputString = useStreamingTextThrottle({
    text: rawOutputString,
    isStreaming: isStreamingBash,
    identityKey: part.id,
    allowTextReplacement: isStreamingBash,
  });
  const outputString = isStreamingBash ? throttledOutputString : rawOutputString;
  const diffContent = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
    ?? getPatchText(metadata?.diff)
    ?? null;
  const diffEntries = React.useMemo(
    () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
    [currentDirectory, diffContent, metadata]
  );
  const hasVisualDiffEntry = diffEntries.some((entry) => entry.renderMode === 'diff');
  const hideToolInputPreview = tool === 'edit' || tool === 'multiedit';
  const isWriteLikeTool = tool === 'write';
  const isTodoTool = tool === 'todowrite';

  const inputTextContent = React.useMemo(() => {
    if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
      return '';
    }

    if ('command' in input && typeof input.command === 'string' && tool === 'bash') {
      return formatInputForDisplay(input, tool);
    }

    if (typeof (input as { content?: unknown }).content === 'string') {
      return (input as { content?: string }).content ?? '';
    }

    return formatInputForDisplay(input, tool);
  }, [input, tool]);
  const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
  const todoContent = React.useMemo(() => {
    if (Array.isArray(input?.todos)) {
      return JSON.stringify(input.todos);
    }
    return outputString;
  }, [input?.todos, outputString]);
  const writeLikeInputPatch = React.useMemo(() => {
    if (!isWriteLikeTool || !hasInputText) {
      return undefined;
    }
    const filePath = typeof input?.filePath === 'string'
      ? input.filePath
      : typeof input?.file_path === 'string'
        ? input.file_path
        : typeof input?.path === 'string'
          ? input.path
          : undefined;
    return buildWritePreviewPatch(filePath, inputTextContent);
  }, [hasInputText, input?.filePath, input?.file_path, input?.path, inputTextContent, isWriteLikeTool]);

  React.useEffect(() => {
    setDiffViewMode('unified');
  }, [part.id]);

  const renderScrollableBlock = (
    content: React.ReactNode,
    options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string; followKey?: string }
  ) => (
    <ToolScrollableSection
      maxHeightClass={options?.maxHeightClass}
      className={options?.className}
      disableHorizontal={options?.disableHorizontal}
      outerClassName={options?.outerClassName}
      followKey={options?.followKey}
    >
      {content}
    </ToolScrollableSection>
  );

  const isFailedOrRejected = FAILED_OR_REJECTED_STATUSES.has(state.status);
  const errorText = typeof state.error === 'string' && state.error.length > 0 ? state.error : undefined;

  const renderResultContent = () => {
    const renderErrorBlock = () => {
      if (!isFailedOrRejected || errorText === undefined) {
        return null;
      }

      return (
        <div>
          <div className="typography-meta font-medium text-muted-foreground/80 mb-1">Error</div>
          <div className="typography-meta p-2 rounded-xl border" style={{
            backgroundColor: 'var(--status-error-background)',
            color: 'var(--status-error)',
            borderColor: 'var(--status-error-border)',
          }}>
            {coerceToText(errorText)}
          </div>
        </div>
      );
    };

    // Question tool: show parsed Q&A summary or question content from input
    if (tool === 'question') {
      if (state.status === 'executed' && hasStringOutput) {
        const parsedQA = parseQuestionOutput(outputString);
        if (parsedQA && parsedQA.length > 0) {
          return renderScrollableBlock(
            <div className="space-y-2">
              {parsedQA.map((qa, index) => (
                <div key={index} className="space-y-0.5">
                  <div className="typography-micro text-muted-foreground">{qa.question}</div>
                  <div className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
                </div>
              ))}
            </div>,
            { maxHeightClass: 'max-h-[40vh]' }
          );
        }
      }

      if (errorText !== undefined && isFailedOrRejected) {
        return renderErrorBlock();
      }

      // Show question content from input whenever available, whether the tool is
      // pending/running or completed without parseable output.
      const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
      if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
        return renderScrollableBlock(
          <div className="space-y-2">
            {questionInput.questions.map((q, index) => (
              <div key={index} className="space-y-0.5">
                {q.header ? (
                  <div className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                ) : null}
                <div className="typography-meta text-foreground">{coerceToText(q.question)}</div>
                {Array.isArray(q.options) && q.options.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {q.options.map((opt) => (
                      <span key={coerceToText(opt.label)} className="typography-micro px-1.5 py-0.5 rounded bg-muted/30 border border-border/30 text-muted-foreground">
                        {coerceToText(opt.label)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>,
          { maxHeightClass: 'max-h-[40vh]' }
        );
      }

      return <div className="typography-meta text-muted-foreground">Awaiting response…</div>;
    }

    if (tool === 'task') {
      return renderScrollableBlock(
        <div className="w-full min-w-0">
          <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
        </div>
      );
    }

    if (EDIT_FAMILY_TOOLS.has(tool) && diffEntries.length > 0) {
      return renderScrollableBlock(
        <div className="space-y-3">
          {diffEntries.map((entry: DiffPatchEntry) => (
            <div key={entry.id} className="w-full min-w-0">
              <div className="mb-1 flex min-w-0 items-center gap-1 px-2 py-1">
                <div className="min-w-0 flex-1 typography-meta font-medium text-muted-foreground">
                  {renderPathLikeGitChanges(entry.title)}
                </div>
              </div>
              {entry.renderMode === 'diff' ? (
                <DiffPreview
                  diff={entry.patch}
                  diffViewMode={diffViewMode}
                />
              ) : (
                <PlainDiffFallback diff={entry.patch} />
              )}
            </div>
          ))}
        </div>,
        { className: 'p-1' }
      );
    }

    if (isWriteLikeTool) {
      return null;
    }

    if (hasStringOutput && outputString.trim()) {
      const output = (
        <ToolScrollableTextOutput
          output={coerceToText(outputString)}
          tool={tool}
          metadata={metadata}
          input={input}
          isStreaming={isStreamingBash}
        />
      );

      return renderScrollableBlock(
        output,
        {
          className: tool === 'bash' ? 'p-1 rounded-none' : 'p-1',
          maxHeightClass: tool === 'bash' ? 'max-h-[46vh]' : undefined,
          followKey: isStreamingBash ? outputString : undefined,
        }
      );
    }

    return renderScrollableBlock(
      <div className="typography-meta text-muted-foreground/70">No output produced.</div>,
      { maxHeightClass: 'max-h-60' }
    );
  };

  const hasVisibleOutput = outputString.trim().length > 0;
  const shouldRenderResult = state.status === 'executed' || (tool === 'bash' && hasVisibleOutput);

  if (isTodoTool) {
    if (errorText !== undefined && isFailedOrRejected) {
      return (
        <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
          <div className="typography-meta font-medium text-muted-foreground/80 mb-1">Error</div>
          <div className="typography-meta p-2 rounded-xl border" style={{
            backgroundColor: 'var(--status-error-background)',
            color: 'var(--status-error)',
            borderColor: 'var(--status-error-border)',
          }}>
            {errorText}
          </div>
        </div>
      );
    }

    const todoOutput = renderTodoOutput(todoContent, {
      total: 'Total',
      inProgress: 'In progress',
      pending: 'Pending',
      completed: 'Completed',
      cancelled: 'Cancelled',
    }, { unstyled: true });

    return (
      <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
        {renderScrollableBlock(
          todoOutput ?? (
            <ToolScrollableTextOutput
              output={todoContent}
              tool={tool}
              metadata={metadata}
              input={input}
            />
          ),
          { className: 'p-2', maxHeightClass: 'max-h-[46vh]' },
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative pr-2 pb-2 pt-2 space-y-2 pl-4'
      )}
    >
      {tool === 'question' ? (
        renderResultContent()
      ) : (
        <>
          {hasInputText ? (
            <div className="my-1">
              {renderScrollableBlock(
                tool === 'bash' ? (
                  <pre className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0">
                    {inputTextContent}
                  </pre>
                ) : isWriteLikeTool && writeLikeInputPatch ? (
                  <DiffPreview
                    diff={writeLikeInputPatch}
                    diffViewMode={diffViewMode}
                  />
                ) : (
                  <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                    {inputTextContent}
                  </blockquote>
                ),
                {
                  maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                  className: tool === 'bash' ? 'tool-input-surface p-0 rounded-none' : 'tool-input-surface',
                }
              )}
            </div>
          ) : null}

          {shouldRenderResult && (
            <div>
              {EDIT_FAMILY_TOOLS.has(tool) && hasVisualDiffEntry ? (
                <div className="mb-1 flex items-center justify-end gap-2">
                  <DiffViewToggle
                    mode={diffViewMode}
                    onModeChange={setDiffViewMode}
                    className="h-5 w-5 p-0"
                  />
                </div>
              ) : null}
              {renderResultContent()}
            </div>
          )}

          {errorText !== undefined && isFailedOrRejected && tool !== 'question' ? renderErrorBlockForBody(errorText) : null}
        </>
      )}
    </div>
  );

  function renderErrorBlockForBody(text: string) {
    return (
      <div>
        <div className="typography-meta font-medium text-muted-foreground/80 mb-1">Error</div>
        <div className="typography-meta p-2 rounded-xl border" style={{
          backgroundColor: 'var(--status-error-background)',
          color: 'var(--status-error)',
          borderColor: 'var(--status-error-border)',
        }}>
          {coerceToText(text)}
        </div>
      </div>
    );
  }
});

ToolExpandedContent.displayName = 'ToolExpandedContent';

/** R3: failed-ish display group (failed|timeout|aborted|partial) plus rejected. */
const FAILED_OR_REJECTED_STATUSES = new Set(['failed', 'timeout', 'aborted', 'partial', 'rejected']);

const SHOW_TOOL_FILE_ICONS = true; // Seam: upstream read this from useUIStore; no Tide setting exists yet.

const ToolPartContent: React.FC<ToolPartProps> = ({
  part,
  isExpanded,
  onToggle,
  isMobile,
  onShowPopup,
  animateTailText = true,
  directory,
}) => {
  void isMobile; // Seam: no mobile surface in Tide; kept for the parent contract.
  const state = part.state as ToolStateWithMetadata;
  const metadata = state.metadata;
  const input = state.input;
  const currentDirectory = directory ?? '';
  const showToolFileIcons = SHOW_TOOL_FILE_ICONS;

  const partId = part.id ?? part.toolCallId ?? '';
  const tool = resolveToolKey(part.tool);
  const isAgentTool = tool === 'task';

  const status = state?.status as string | undefined;
  const isFinalized = isFinalizedToolStatus(status);
  const isError = typeof status === 'string' && FAILED_OR_REJECTED_STATUSES.has(status);

  const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
  const previousPartIdRef = React.useRef<string | undefined>(partId);

  React.useEffect(() => {
    if (previousPartIdRef.current === partId) {
      return;
    }
    previousPartIdRef.current = partId;
    // Reset latch only when tool identity changes.
    setActiveLatched(!isFinalized);
  }, [isFinalized, partId]);

  React.useEffect(() => {
    if (!isFinalized) {
      setActiveLatched(true);
    }
  }, [isFinalized]);

  const expandedContentRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (isAgentTool) {
      return;
    }

    const element = expandedContentRef.current;
    if (!element) {
      return;
    }

    element.style.height = isExpanded ? 'auto' : '0px';
    element.style.overflow = isExpanded ? 'visible' : 'hidden';
  }, [isExpanded, isAgentTool]);

  const time = state.time;

  const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>(() => ({
    start: typeof time?.start === 'number' ? time.start : undefined,
    end: typeof time?.end === 'number' ? time.end : undefined,
  }));
  const [localStartAt, setLocalStartAt] = React.useState<number | undefined>(undefined);
  const [localFinalizedAt, setLocalFinalizedAt] = React.useState<number | undefined>(undefined);

  React.useEffect(() => {
    setPinnedTime({});
    setLocalStartAt(undefined);
    setLocalFinalizedAt(undefined);
  }, [partId]);

  React.useEffect(() => {
    if (isFinalized) {
      return;
    }
    if (typeof time?.start === 'number') {
      return;
    }
    setLocalStartAt((prev) => prev ?? Date.now());
  }, [isFinalized, time?.start]);

  React.useEffect(() => {
    setPinnedTime((prev) => {
      const next = { ...prev };
      let changed = false;

      if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
        next.start = time.start;
        changed = true;
      }

      if (typeof time?.end === 'number' && (typeof prev.end !== 'number' || time.end > prev.end)) {
        next.end = time.end;
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [time?.end, time?.start]);

  const effectiveTimeStart = React.useMemo(() => {
    // Once we captured a local start (during pending, before the server sends
    // time.start), always prefer it so the timer never jumps later.
    if (typeof localStartAt === 'number') {
      return localStartAt;
    }
    const candidates = [pinnedTime.start, time?.start].filter(
      (value): value is number => typeof value === 'number'
    );
    if (candidates.length === 0) {
      return undefined;
    }
    return Math.min(...candidates);
  }, [localStartAt, pinnedTime.start, time?.start]);

  React.useEffect(() => {
    if (typeof time?.end === 'number' || typeof pinnedTime.end === 'number') {
      setLocalFinalizedAt(undefined);
      return;
    }

    if (typeof effectiveTimeStart !== 'number') {
      return;
    }

    if (!isFinalized) {
      return;
    }

    setLocalFinalizedAt((prev) => prev ?? Date.now());
  }, [
    effectiveTimeStart,
    isFinalized,
    pinnedTime.end,
    time?.end,
  ]);

  const effectiveTimeEnd = isFinalized ? (pinnedTime.end ?? time?.end ?? localFinalizedAt) : undefined;
  const isActive = !isFinalized && activeLatched;

  const agentReport = React.useMemo(() => {
    if (!isAgentTool) {
      return undefined;
    }
    const report = metadata?.report;
    return typeof report === 'string' && report.trim().length > 0 ? report : undefined;
  }, [isAgentTool, metadata?.report]);

  const diffStats = React.useMemo(() => {
    return (tool === 'edit' || tool === 'multiedit')
      ? parseDiffStats(metadata)
      : null;
  }, [metadata, tool]);

  // Tide-native panel navigation (user request): file / diff / agent affordances
  // ride on the header row. Upstream routed these through RuntimeAPIContext,
  // which the port dropped; see panel-actions-context.tsx.
  const panelActions = usePanelActions();
  const panelFilePath = React.useMemo(() => {
    const candidate = input?.filePath || input?.file_path || input?.path
      || metadata?.filePath || metadata?.file_path || metadata?.path;
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
  }, [input, metadata]);
  const panelPatch = React.useMemo(() => {
    if (tool !== 'edit' && tool !== 'multiedit' && tool !== 'write') return undefined;
    return getPatchText(metadata?.patch) ?? getPatchText(metadata?.diff);
  }, [metadata, tool]);
  const showPanelFileButton = Boolean(panelActions && tool === 'read' && panelFilePath);
  const showPanelDiffButton = Boolean(panelActions && panelPatch && panelFilePath);
  const showPanelAgentButton = Boolean(panelActions && isAgentTool && part.toolCallId);
  const handlePanelFile = () => panelFilePath && panelActions?.viewFile(panelFilePath);
  const handlePanelDiff = () => {
    if (!panelFilePath || !panelPatch) return;
    panelActions?.viewDiff({ path: panelFilePath, hunks: parseUnifiedDiff(panelPatch) });
  };
  const handlePanelAgent = () => part.toolCallId && panelActions?.openDispatch(part.toolCallId);
  const writeLineCount = React.useMemo(() => {
    return tool === 'write' ? parseWriteLineCount(input) : null;
  }, [input, tool]);
  const descriptionPath = getToolDescriptionPath(tool, state, currentDirectory);
  const description = getToolDescription(tool, state, currentDirectory);
  const displayName = getToolMetadata(tool || part.tool).displayName;

  // Tool title/description — shown inline as context
  const justificationText = React.useMemo(() => {
    if (tool === 'bash') {
      return null;
    }
    if (
      descriptionPath
      && (tool === 'edit' || tool === 'multiedit' || tool === 'write')
    ) {
      return null;
    }
    const title = state.title;
    if (typeof title === 'string' && title.trim().length > 0) {
      return title;
    }
    const inputDesc = input?.description;
    if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
      return inputDesc;
    }
    return null;
  }, [descriptionPath, tool, state, input]);

  const handleMainClick = (e: { stopPropagation: () => void }) => {
    // Seam: upstream opened the touched file/diff through the OpenCode bridge
    // here; Tide has no bridge, so the row always toggles.
    e.stopPropagation();
    onToggle(partId);
  };

  const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    handleMainClick(event);
  };

  const tintClass = !isError ? toolTextColor(tool) : undefined;
  const iconStyle = !isAgentTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
  const titleStyle = !isAgentTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
  const shouldRenderAgentNesting = useDeferredExpandedContent(isAgentTool && (isActive || isFinalized));
  const shouldRenderExpandedContent = useDeferredExpandedContent(!isAgentTool && isExpanded);

  if (!isFinalized && !isActive && !isAgentTool) {
    return null;
  }

  return (
    <div>
      <div
        className={cn(
          'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl',
          'items-center cursor-pointer',
          tool === 'bash' && 'font-mono',
        )}
        onClick={handleMainClick}
        onKeyDown={handleMainKeyDown}
        role="button"
        tabIndex={0}
      >
        <div className={cn('flex gap-1.5', 'items-center flex-shrink-0')}>
          <div
            // h-5 matches StaticToolRow's icon column, so expandable
            // and static rows come out the same height.
            className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer"
            onClick={(event) => { event.stopPropagation(); onToggle(partId); }}
          >
            <div
              className={cn(
                'absolute inset-0 flex items-center justify-center transition-opacity',
                isExpanded && 'opacity-0',
                !isExpanded && 'group-hover/tool:opacity-0',
                tintClass && 'tool-tint',
                tintClass
              )}
              style={tintClass ? undefined : iconStyle}
            >
              {getToolIcon(tool || part.tool)}
            </div>
            <div
              className={cn(
                'absolute inset-0 transition-opacity flex items-center justify-center',
                isExpanded && 'opacity-100',
                !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
              )}
            >
              {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isActive && !isError && <PixelLoader variant="orbit" size="xs" />}
            <MinDurationShineText
              active={Boolean(isActive && !isError)}
              minDurationMs={300}
              className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0', tintClass && 'tool-tint', tintClass)}
              style={tintClass ? undefined : titleStyle}
              title={displayName}
            >
              {displayName}
            </MinDurationShineText>
            {isAgentTool && typeof input?.name === 'string' && input.name.trim().length > 0 && (() => {
              const sessionName = agentSessionDisplayName(
                input.name,
                typeof input?.title === 'string' && input.title.trim().length > 0 ? input.title : undefined,
              );
              return (
                <span
                  className="flex-shrink-0 rounded-md border border-border/60 bg-muted/60 px-1.5 typography-micro leading-4 text-muted-foreground text-[0.75rem]"
                  title={`Sub-agent session: ${sessionName}`}
                >
                  {sessionName}
                </span>
              );
            })()}
          </div>
          {tool === 'bash' && typeof effectiveTimeStart === 'number' ? (
            <span className={cn('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)}>
              <LiveDuration
                start={effectiveTimeStart}
                end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
              />
            </span>
          ) : null}
        </div>

        <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {justificationText && (
              <span
                className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                title={justificationText}
              >
                {justificationText}
              </span>
            )}
            {!justificationText && description && (
              descriptionPath && description === descriptionPath ? (
                renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
              ) : (
                <span
                  className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                  style={{ color: 'var(--tools-description)' }}
                  title={description}
                >
                  {description}
                </span>
              )
            )}
            {diffStats && (
              <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                <span style={{ color: 'var(--tools-description)' }}>/</span>
                <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
              </span>
            )}
            {writeLineCount && (
              <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                <span style={{ color: 'var(--status-success)' }}>+{writeLineCount}</span>
              </span>
            )}
          </div>
        </div>

        {(showPanelFileButton || showPanelDiffButton || showPanelAgentButton) && (
          <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/tool:opacity-100 focus-within:opacity-100 transition-opacity">
            {showPanelFileButton && (
              <button
                type="button"
                title={`Open in file viewer: ${panelFilePath}`}
                onClick={(event) => { event.stopPropagation(); handlePanelFile(); }}
                className="flex items-center justify-center size-5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
              >
                <FileText className="size-3" />
              </button>
            )}
            {showPanelDiffButton && (
              <button
                type="button"
                title={`Review diff: ${panelFilePath}`}
                onClick={(event) => { event.stopPropagation(); handlePanelDiff(); }}
                className="flex items-center justify-center size-5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
              >
                <FileDiff className="size-3" />
              </button>
            )}
            {showPanelAgentButton && (
              <button
                type="button"
                title="Open in agents panel"
                onClick={(event) => { event.stopPropagation(); handlePanelAgent(); }}
                className="flex items-center justify-center size-5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
              >
                <Bot className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {shouldRenderAgentNesting ? (
        <AgentToolNesting
          toolCallId={part.toolCallId}
          report={agentReport}
          isExpanded={isExpanded}
          onShowPopup={onShowPopup}
          animateTailText={animateTailText}
          isActive={isActive}
        />
      ) : null}

      {!isAgentTool ? (
        <div
          ref={expandedContentRef}
          aria-hidden={!isExpanded}
          style={{
            height: isExpanded ? 'auto' : '0px',
            overflow: isExpanded ? 'visible' : 'hidden',
            overflowAnchor: 'none',
          }}
        >
          {shouldRenderExpandedContent ? (
            <div
              className="relative ml-2 pl-3"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                style={{ backgroundColor: 'var(--tools-border)' }}
              />
              <ToolExpandedContent
                part={part}
                tool={tool}
                state={state}
                currentDirectory={currentDirectory}
                isExpanded={isExpanded}
                onShowPopup={onShowPopup}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

class ToolPartErrorBoundary extends React.Component<{
  children: React.ReactNode;
  displayName: string;
  errorLabel: string;
  resetKey: unknown;
  toolName: string;
}, { hasError: boolean; error?: Error }> {
  state: { hasError: boolean; error?: Error } = { hasError: false };

  static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps: { resetKey: unknown }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      // oxlint-disable-next-line react/no-did-update-set-state -- upstream error-boundary reset: clears the fallback only when the resetKey (part) changed, so it cannot loop.
      this.setState({ hasError: false, error: undefined });
    }
  }

  componentDidCatch(error: Error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Tool part failed to render; showing safe fallback.', error);
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message;
    return (
      <div className="flex items-center gap-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0">
        <div className="h-3.5 w-3.5 flex-shrink-0" style={TOOL_ERROR_ICON_STYLE}>
          {getToolIcon(this.props.toolName)}
        </div>
        <span className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')} style={TOOL_ERROR_TITLE_STYLE}>
          {this.props.displayName}
        </span>
        {message ? (
          <span className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={message}>
            {this.props.errorLabel}: {message}
          </span>
        ) : null}
      </div>
    );
  }
}

const ToolPart: React.FC<ToolPartProps> = (props) => {
  const toolName = resolveToolKey(props.part.tool) || 'tool';
  const displayName = getToolMetadata(toolName).displayName;

  return (
    <ToolPartErrorBoundary
      displayName={displayName}
      errorLabel="Error"
      resetKey={props.part}
      toolName={toolName}
    >
      <ToolPartContent {...props} />
    </ToolPartErrorBoundary>
  );
};

export const ToolPartMemoized = React.memo(ToolPart, (prev, next) => {
  return areRenderRelevantPartsEqual([prev.part], [next.part])
    && prev.isExpanded === next.isExpanded
    && prev.isMobile === next.isMobile
    && prev.alwaysShowActions === next.alwaysShowActions
    && prev.onContentChange === next.onContentChange
    && prev.onShowPopup === next.onShowPopup
    && prev.animateTailText === next.animateTailText
    && prev.directory === next.directory;
});

ToolPartMemoized.displayName = 'ToolPart';

export { ToolPart };
export default ToolPartMemoized;
