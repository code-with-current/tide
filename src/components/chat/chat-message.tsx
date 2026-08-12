import { memo, useState, useMemo, useCallback, type ReactNode } from 'react';
import { Copy, Check, FileCode2, FileText, Image as ImageIcon, ClipboardPaste } from 'lucide-react';
import type { Message } from '@/types';
import { formatTime } from '@/lib/utils';
import { useUi, type OpenFile } from '@/lib/stores/ui';
import { TurnBlock, langFromPath } from './turn/turn-block';
import { Button } from '../ui/button';

// ============================================================
// Chat message — entry point. User messages render the right-aligned bubble; assistant messages delegate to <TurnBlock>.
// Display format matches the composer: attachments & @file mentions → `[/label/](path)` links in content (rendered as chips above text); skill/agent `/name` → inline text chips. Links live in persisted content, so chips survive reload.
// ============================================================

/** Markdown link shape: `[/label/](target)`. Both attachment and @file
 *  references use this form. The leading+trailing slashes on the label
 *  make the pattern unambiguous vs. ordinary markdown links. */
interface RefLink {
  label: string;
  target: string;
}

/** Image extensions — used to infer isImage when no attachment metadata
 *  is available (e.g. old sessions whose attachments[] wasn't persisted).
 *  Kept in sync with the viewer's IMG_EXT_MIME in handlers.ts. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

/** Split content into (chips, body): chips = leading `[/label/](target)` links (attachments cluster at start); body = remaining text with link syntax stripped. Inline mid-message links are also stripped and surfaced as chips (order preserved). */
function parseRefLinks(content: string): { chips: RefLink[]; body: string } {
  const chips: RefLink[] = [];
  // Match [/label/](target). Label permits any non-']' chars; target any
  // non-')' chars. The label's wrapping slashes are part of the syntax.
  const re = /\[\/([^\]]*)\/\]\(([^)]*)\)/g;
  const body = content.replace(re, (_m, label, target) => {
    chips.push({ label, target });
    return '';
  }).replace(/[ \t]*\n[ \t]*(?=\S)/g, '\n').trimStart();
  return { chips, body };
}

/** Map a file path/extension to a chip icon, mirroring the composer's
 *  attachment chips so the bubble reads as the same object the user
 *  attached. Image/code/text/paste each get a distinct glyph. */
function refIcon(target: string, label: string) {
  const ext = target.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return <ImageIcon className="size-3 shrink-0" />;
  }
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'kt', 'vue', 'svelte'].includes(ext)) {
    return <FileCode2 className="size-3 shrink-0" />;
  }
  if (/paste/i.test(label)) {
    return <ClipboardPaste className="size-3 shrink-0" />;
  }
  return <FileText className="size-3 shrink-0" />;
}

/** Render the user message body with `/name` skill/agent chips inline. File-reference links have already been lifted to chips by parseRefLinks; this only handles the bare `/name` tokens (kept inline so the skill's position in the sentence is preserved). Splits on `/{word}` patterns, skipping URL-embedded slashes (preceded by `:` like `https://`). Only known mentions (from message.mentions metadata) render as chips; unknown `/words` (like path segments in `server/api/index.ts`) render as plain text. */
function renderUserBody(content: string, mentions?: Message['mentions']): ReactNode[] {
  // Build lookup map for skill/agent chips. Context (file) mentions are
  // now handled as links above the text, so they're excluded here.
  const skillMap = new Map<string, { filePath?: string; description?: string }>();
  for (const m of mentions ?? []) {
    if (m.kind === 'context') continue;
    skillMap.set(m.name, { filePath: m.filePath, description: m.description });
  }

  if (skillMap.size === 0) {
    return [<span key={0}>{content}</span>];
  }

  const parts = content.split(/(\/[a-zA-Z][\w-]*)/g);

  return parts.map((part, i) => {
    if (/^\/[a-zA-Z][\w-]*$/.test(part)) {
      const prev = i > 0 ? parts[i - 1] : '';
      if (prev.endsWith(':')) return <span key={i}>{part}</span>;
      const name = part.slice(1);
      const meta = skillMap.get(name);
      if (!meta) return <span key={i}>{part}</span>;
      return (
        <span
          key={i}
          title={`${meta.description ?? name}${meta.filePath ? `\n${meta.filePath}` : ''}`}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 mx-0.5 bg-foreground/15 text-foreground/70 rounded-md text-[11px] font-mono align-middle cursor-help"
        >
          /{name}
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
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  // File-viewer hooks — used by the chip click handler to open the
  // referenced file in the side panel.
  const openFile = useUi((s) => s.openFile);
  const activeSessionId = useUi((s) => s.activeSessionId);

  // ===== USER — right-aligned bubble =====
  if (message.role === 'user') {
    const handleCopy = () => {
      navigator.clipboard.writeText(message.content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    };
    // Lift attachment + @file links out of content into chips above the
    // text. The remaining body keeps /skill mentions inline.
    const { chips, body } = useMemo(() => parseRefLinks(message.content), [message.content]);

    /** Open a chip's file in the side viewer. Discriminator: absolute path target (starts with /, ~, or a drive letter) → external attachment (viewer reads via readExternalFile/readImageFile, no workspace sandbox); relative path target → workspace @file mention (readFileInWorkspace, or readImageFile for images). Image-ness is inferred from the EXTENSION when no attachment matches, so images open correctly even for old sessions whose attachments[] wasn't persisted. */
    const handleChipOpen = useCallback(
      (chip: RefLink) => {
        if (!activeSessionId) return;
        const attachment = message.attachments?.find(
          (a) => a.path === chip.target || a.absPath === chip.target || a.path === chip.label,
        );
        const isAbsolute = /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(chip.target);
        // Infer image-ness from the extension as a fallback, so images route
        // to ImageBody (readImageFile) even when attachments[] is absent.
        const isImageByExt = IMAGE_EXTS.has(chip.target.split('.').pop()?.toLowerCase() ?? '');
        // Prefer the attachment's absPath; fall back to the link target for
        // reloaded sessions where attachments[] isn't present.
        const absPath = attachment?.absPath ?? (isAbsolute ? chip.target : undefined);
        const file: OpenFile = attachment
          ? {
              id: chip.target,
              path: attachment.path,
              language: attachment.kind === 'image' ? 'image' : langFromPath(attachment.path),
              inlineContent: attachment.content,
              bytes: attachment.bytes,
              isImage: attachment.kind === 'image' || isImageByExt,
              external: true,
              absPath,
            }
          : isAbsolute
            ? {
                // Reloaded external attachment (no attachments[] in memory).
                // Use the link target as the absPath so the viewer can
                // readExternalFile / readImageFile it.
                id: chip.target,
                path: chip.label.replace(/^\/|\/$/g, ''),
                language: langFromPath(chip.target),
                isImage: isImageByExt,
                external: true,
                absPath: chip.target,
              }
            : {
                // Workspace @file mention — relative path, read from disk.
                // Images go through readImageFile via ImageBody.
                id: chip.target,
                path: chip.target,
                language: isImageByExt ? 'image' : langFromPath(chip.target),
                isImage: isImageByExt,
              };
        openFile(activeSessionId, file);
      },
      [activeSessionId, message.attachments, openFile],
    );
    return (
      <div className="group flex justify-end">
        <div className="max-w-[85%] flex flex-col items-end gap-1">
          <div className="rounded-xl rounded-br bg-primary/80 text-primary-foreground px-3.5 py-2.5">
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {chips.map((c, i) => (
                  <Button
                    variant="outline"
                    size="xs"
                    key={`${c.target}-${i}`}
                    title={`Open ${c.target} in viewer`}
                    onClick={() => handleChipOpen(c)}
                  >
                    {refIcon(c.target, c.label)}
                    <span className="truncate">{c.label}</span>
                  </Button>
                ))}
              </div>
            )}
            {body && (
              <div className="text-sm font-semibold leading-relaxed whitespace-pre-wrap break-words overflow-hidden">
                {renderUserBody(body, message.mentions)}
              </div>
            )}
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
