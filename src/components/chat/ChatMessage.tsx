import { memo, useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Message } from '@/types';
import { formatTime } from '@/lib/utils';
import { TurnBlock } from './TurnBlock';

// ============================================================
// Chat message — entry point.
//
// User messages render the right-aligned bubble. Assistant messages
// delegate to <TurnBlock>, the block-stream structured turn renderer.
// ============================================================

/**
 * Parse the user message content and render `/{name}` tokens as inline
 * chips — matching the composer's chip styling so the chat bubble looks
 * consistent with what the user typed.
 *
 * Splits on `/{word}` patterns, skipping URL-embedded slashes (preceded
 * by `:` like `https://`). Each chip gets a subtle background + rounded
 * border so it stands out from plain text.
 */
/** Render user message content with enriched mention chips.
 *  Matches both `/name` (skill/agent) and `@path` (file reference) tokens,
 *  but ONLY renders them as chips when they match a known mention from the
 *  message's mention metadata. Unknown `/words` (like path segments in
 *  `server/api/index.ts`) render as plain text. */
function renderUserContent(content: string, mentions?: Message['mentions']): ReactNode[] {
  // Build lookup maps for quick chip enrichment.
  const skillMap = new Map<string, { filePath?: string; description?: string }>();
  const fileMap = new Map<string, { filePath?: string; description?: string }>();
  for (const m of mentions ?? []) {
    const target = m.kind === 'context' ? fileMap : skillMap;
    target.set(m.name, { filePath: m.filePath, description: m.description });
  }

  // If no mentions at all, just render plain text — no chip matching needed.
  if (skillMap.size === 0 && fileMap.size === 0) {
    return [<span key={0}>{content}</span>];
  }

  // Split keeping both /name and @path tokens as separate elements.
  const parts = content.split(/(\/[a-zA-Z][\w-]*|@[\w./-]+)/g);

  return parts.map((part, i) => {
    // Match `/name` — only render as chip if it's a known mention.
    if (/^\/[a-zA-Z][\w-]*$/.test(part)) {
      // Skip if preceded by `:` — it's a URL (https://, file://).
      const prev = i > 0 ? parts[i - 1] : '';
      if (prev.endsWith(':')) return <span key={i}>{part}</span>;
      const name = part.slice(1);
      const meta = skillMap.get(name);
      if (!meta) return <span key={i}>{part}</span>; // unknown → plain text
      return (
        <span
          key={i}
          title={`${meta.description ?? name}${meta.filePath ? `\n${meta.filePath}` : ''}`}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 mx-0.5 bg-primary/30 border border-accent/15 text-[11px] font-mono align-middle cursor-help"
        >
          /{name}
        </span>
      );
    }
    // Match `@path` — only render as chip if it's a known file mention.
    if (/^@[\w./-]+$/.test(part)) {
      const name = part.slice(1);
      const meta = fileMap.get(name);
      if (!meta) return <span key={i}>{part}</span>; // unknown → plain text
      return (
        <span
          key={i}
          title={meta.filePath ?? meta.description ?? name}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 mx-0.5 bg-info/20 border border-info/15 text-[11px] font-mono align-middle cursor-help"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function ChatMessageImpl({
  message,
  streaming = false,
  pendingToolCallIds = [],
  stopReason,
  onApproveToolCalls,
  onRejectToolCalls,
}: {
  message: Message;
  streaming?: boolean;
  pendingToolCallIds?: string[];
  /** Forwarded from SessionStream.stopReason — drives the stopped marker. */
  stopReason?: string | null;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: 'session' | 'project') => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  // ===== USER — right-aligned bubble =====
  if (message.role === 'user') {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    const handleCopy = () => {
      navigator.clipboard.writeText(message.content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    };
    return (
      <div className="group flex justify-end mt-5 border-t pt-5">
        <div className="max-w-[85%] flex flex-col items-end gap-1">
          <div className="rounded-2xl rounded-br-md bg-primary/20 text-white px-3.5 py-2.5">
            {hasAttachments && (
              <div className="flex flex-col gap-1 mb-1.5">
                {message.attachments!.map((a) => (
                  <div
                    key={a.path}
                    className="flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1 text-[11px] font-mono"
                  >
                    <span className="truncate max-w-[18rem] opacity-80">{a.path}</span>
                    {a.bytes != null && (
                      <span className="opacity-50 shrink-0">
                        {a.bytes > 1024 ? `${Math.ceil(a.bytes / 1024)}KB` : `${a.bytes}B`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="text-sm leading-relaxed [&_code]:bg-white/20 [&_code]:text-white whitespace-pre-wrap break-words overflow-hidden">
              {renderUserContent(message.content, message.mentions)}
            </div>
          </div>
          {/* Bottom row: hover-revealed copy + timestamp. Kept outside the
              bubble so the time stays muted and doesn't compete with the
              message text. The whole row fades in on hover. */}
          <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground/60 font-mono opacity-0 group-hover:opacity-100 transition-opacity">
            <span>{formatTime(message.createdAt)}</span>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy message'}
              title={copied ? 'Copied' : 'Copy message'}
              className="inline-flex items-center justify-center size-4 rounded hover:bg-muted hover:text-foreground transition-colors"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== ASSISTANT — structured turn block =====
  return (
    <TurnBlock
      message={message}
      streaming={streaming}
      pendingToolCallIds={pendingToolCallIds}
      stopReason={stopReason}
      onApproveToolCalls={onApproveToolCalls}
      onRejectToolCalls={onRejectToolCalls}
    />
  );
}

export const ChatMessage = memo(ChatMessageImpl, (prev, next) => {
  if (prev.streaming !== next.streaming) return false;
  if (prev.message !== next.message) return false;
  if (prev.stopReason !== next.stopReason) return false;
  const a = prev.pendingToolCallIds ?? [];
  const b = next.pendingToolCallIds ?? [];
  if (a.length !== b.length) return false;
  if (a.length > 0 && a.join(',') !== b.join(',')) return false;
  return true;
});
