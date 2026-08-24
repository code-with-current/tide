/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/PermissionCard.tsx — HEAVILY ADAPTED (Ruling 1).
 *  Upstream renders an OpenCode `PermissionRequest` (patterns/always/sessionID, answered
 *  via sessionActions.respondToPermission). Tide has no permission-request objects — the
 *  card renders the PENDING TOOL PART (`arguments`, `metadata.argPreview`, `metadata.riskTier`,
 *  `toolCallId`) and buttons call the timeline's exact callback names:
 *  `onApproveToolCalls(ids, newMode?, remember?)` / `onRejectToolCalls(ids, reason?)`
 *  (threaded from ChatTimeline/main-screen; T6/T8 wire them into the timeline).
 *  Other adaptations:
 *  - Renders only for Tide `ToolCallStatus` 'pending' | 'awaiting_input'.
 *  - Tool branches re-keyed to Tide tool names (bash, edit_file, multi_edit, write_file,
 *    web_fetch) and read the part's `arguments` (pending calls carry no display payload):
 *    bash → input.command (or argPreview fallback); edit/multi_edit → DiffPreview over a
 *    synthesized unified diff from input old_string/new_string; write → WritePreview over
 *    input.content; web_fetch → url/method/headers/body.
 *  - Dropped (no Tide equivalent): permission.patterns section, `isFromSubagent` badge
 *    (sync-store coupling), session-store responders, i18n (literal English).
 *  - `ScrollableOverlay` → local overflow-auto div (task-3-brief R5 mapping).
 *  - Remember-decision mapping via ./permission-auto-accept (Ruling 2). */

import React from 'react';
import { cn } from '@/lib/utils';
import type { AutonomyMode } from '@/types';
import { WorkerHighlightedCode } from './code/worker-highlighted-code';
import { Icon } from './icon';
import { DiffPreview, WritePreview } from './diff-preview';
import { getPermissionDecision, type PermissionCardAction } from './permission-auto-accept';

const PERMISSION_BASH_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'visible',
};

const PERMISSION_BASH_CODE_TAG_PROPS = {
  style: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
};

const PERMISSION_JSON_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
};

interface PermissionCardProps {
  toolCallId: string;
  toolName: string;
  status: string;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  onApproveToolCalls?: (ids: string[], newMode?: AutonomyMode, remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
}

const getToolIcon = (toolName: string) => {
  const iconClass = 'h-3 w-3';
  const tool = toolName.toLowerCase();

  if (tool === 'edit_file' || tool === 'multi_edit') {
    return <Icon name="pencil-ai" className={iconClass} />;
  }
  if (tool === 'write_file') {
    return <Icon name="file-edit" className={iconClass} />;
  }
  if (tool === 'bash') {
    return <Icon name="terminal-box" className={iconClass} />;
  }
  if (tool === 'web_fetch' || tool === 'web_search') {
    return <Icon name="global" className={iconClass} />;
  }

  return <Icon name="tools" className={iconClass} />;
};

/** Pending edit calls carry no diff payload — synthesize a minimal unified diff from the
 *  replacement strings so DiffPreview can render the proposed change. */
const buildEditPreviewDiff = (filePath: string, oldText: string, newText: string): string => {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const line of oldLines) lines.push(`-${line}`);
  for (const line of newLines) lines.push(`+${line}`);
  return lines.join('\n');
};

const ScrollableOverlay: React.FC<{
  outerClassName?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ outerClassName, className, children }) => (
  <div className={cn('overflow-auto', outerClassName)}>
    <div className={className}>{children}</div>
  </div>
);

export const PermissionCard: React.FC<PermissionCardProps> = ({
  toolCallId,
  toolName,
  status,
  arguments: args,
  metadata,
  onApproveToolCalls,
  onRejectToolCalls,
}) => {
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);

  const handleResponse = (action: PermissionCardAction) => {
    const decision = getPermissionDecision(action);
    setIsResponding(true);
    if (decision.kind === 'approve') {
      onApproveToolCalls?.([toolCallId], decision.newMode, decision.remember);
    } else {
      onRejectToolCalls?.([toolCallId], decision.reason);
    }
    setHasResponded(true);
    setIsResponding(false);
  };

  if (hasResponded) {
    return null;
  }

  if (status !== 'pending' && status !== 'awaiting_input') {
    return null;
  }

  const tool = toolName.toLowerCase();
  const getArg = (key: string): string | undefined => {
    const val = args?.[key];
    return typeof val === 'string' ? val : undefined;
  };
  const riskTier = typeof metadata?.riskTier === 'string' ? (metadata.riskTier as string) : undefined;
  const argPreview = typeof metadata?.argPreview === 'string' ? (metadata.argPreview as string) : undefined;

  const renderToolContent = () => {
    if (tool === 'bash') {
      const bashCommand = getArg('command') ?? argPreview ?? '';
      if (!bashCommand) return null;
      return (
        <div>
          <WorkerHighlightedCode
            language="bash"
            code={bashCommand}
            style={PERMISSION_BASH_CUSTOM_STYLE}
            codeStyle={PERMISSION_BASH_CODE_TAG_PROPS.style}
            wrap
          />
        </div>
      );
    }

    if (tool === 'edit_file' || tool === 'multi_edit') {
      const filePath = getArg('path') ?? '';
      const oldText = tool === 'multi_edit'
        ? (Array.isArray(args?.edits)
          ? (args.edits as Array<Record<string, unknown>>)
            .map((edit) => String(edit.old_string ?? ''))
            .join('\n')
          : '')
        : (getArg('old_string') ?? '');
      const newText = tool === 'multi_edit'
        ? (Array.isArray(args?.edits)
          ? (args.edits as Array<Record<string, unknown>>)
            .map((edit) => String(edit.new_string ?? ''))
            .join('\n')
          : '')
        : (getArg('new_string') ?? '');
      if (!oldText && !newText) {
        if (argPreview) {
          return (
            <ScrollableOverlay outerClassName="max-h-32" className="p-0">
              <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all">
                {argPreview}
              </pre>
            </ScrollableOverlay>
          );
        }
        return null;
      }
      return (
        <ScrollableOverlay
          outerClassName="max-h-[60vh]"
          className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent"
        >
          <DiffPreview diff={buildEditPreviewDiff(filePath, oldText, newText)} filePath={filePath} />
        </ScrollableOverlay>
      );
    }

    if (tool === 'write_file') {
      const filePath = getArg('path') ?? '';
      const content = getArg('content') ?? '';
      if (!content) return null;
      return (
        <ScrollableOverlay
          outerClassName="max-h-[60vh]"
          className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent"
        >
          <WritePreview content={content} filePath={filePath} />
        </ScrollableOverlay>
      );
    }

    if (tool === 'web_fetch') {
      const url = getArg('url') ?? '';
      const method = getArg('method') || 'GET';
      const body = args?.body;
      const headers = args?.headers && typeof args.headers === 'object'
        ? (args.headers as Record<string, unknown>)
        : undefined;
      return (
        <>
          {url && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">Request</div>
              <div className="flex items-center gap-2">
                <span className="typography-meta font-semibold px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                  {method}
                </span>
                <code className="typography-meta px-2 py-1 bg-muted/30 rounded flex-1 break-all">
                  {url}
                </code>
              </div>
            </div>
          )}
          {headers && Object.keys(headers).length > 0 && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">Headers</div>
              <ScrollableOverlay outerClassName="max-h-24" className="p-0">
                <WorkerHighlightedCode
                  language="json"
                  code={JSON.stringify(headers, null, 2)}
                  style={PERMISSION_JSON_CUSTOM_STYLE}
                  wrap
                />
              </ScrollableOverlay>
            </div>
          )}
          {body && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">Body</div>
              <ScrollableOverlay outerClassName="max-h-32" className="p-0">
                <WorkerHighlightedCode
                  language={typeof body === 'object' ? 'json' : 'text'}
                  code={typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body)}
                  style={PERMISSION_JSON_CUSTOM_STYLE}
                  wrap
                />
              </ScrollableOverlay>
            </div>
          )}
        </>
      );
    }

    const genericContent = argPreview ?? (args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '');
    if (!genericContent) return null;
    return (
      <div>
        <div className="typography-meta text-muted-foreground mb-1">Details</div>
        <ScrollableOverlay outerClassName="max-h-32" className="p-0">
          <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all">
            {genericContent}
          </pre>
        </ScrollableOverlay>
      </div>
    );
  };

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5 border-b border-border/20 bg-muted/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="question" className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="typography-meta font-medium text-muted-foreground">
                  Permission Required
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {getToolIcon(toolName)}
                <span className="typography-meta text-muted-foreground font-medium">{toolName}</span>
                {riskTier ? (
                  <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                    {riskTier}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="px-2 py-2">
            {renderToolContent()}
          </div>

          <div className="px-2 pb-2 sm:pb-1.5 pt-1.5 sm:pt-1 flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-1.5 border-t border-border/20">
            <button
              onClick={() => handleResponse('once')}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
              style={{
                backgroundColor: 'rgb(var(--status-success) / 0.1)',
                color: 'var(--status-success)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.1)';
              }}
            >
              <Icon name="check" className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
              Allow Once
            </button>

            <button
              onClick={() => handleResponse('always')}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
              style={{
                backgroundColor: 'rgb(var(--muted) / 0.5)',
                color: 'var(--muted-foreground)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.7)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.5)';
              }}
            >
              <Icon name="time" className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
              Always Allow
            </button>

            <button
              onClick={() => handleResponse('reject')}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
              style={{
                backgroundColor: 'rgb(var(--status-error) / 0.1)',
                color: 'var(--status-error)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.1)';
              }}
            >
              <Icon name="close" className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
              Deny
            </button>

            {isResponding && (
              <div className="flex justify-center w-full sm:w-auto sm:ml-auto py-1 sm:py-0 typography-meta text-muted-foreground">
                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
