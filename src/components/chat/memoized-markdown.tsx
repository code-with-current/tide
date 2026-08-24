import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { remarkFilePaths } from '@/lib/remark/file-paths';
import { useUi } from '@/lib/stores/ui';
import { getLanguageFromExtension } from '@/components/chat/timeline/openchamber/lib/tool-helpers';
import { MermaidDiagram } from './mermaid-diagram';

const WRAP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h13a4 4 0 0 1 0 8h-3"/><polyline points="16 9 13 12 16 15"/></svg>';

function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return `${hash.toString(36)}:${s.length}`;
}

/**
 * Split markdown content into blocks with stable content-hash keys.
 * Mirrors Streamdown's own block-splitting but adds our layer.
 */
function buildBlockEntries(content: string) {
  const blocks = parseMarkdownIntoBlocks(content);
  const seen: Record<string, number> = {};
  return blocks.map((text: string) => {
    const key = hashString(text);
    const n = seen[key] ?? 0;
    seen[key] = n + 1;
    return { key: n > 0 ? `${key}__${n}` : key, text };
  });
}

/** Detect fenced mermaid blocks (closed or open/streaming); returns {code, closed} or null. Trailing-whitespace tolerant. */
function extractMermaid(text: string): { code: string; closed: boolean } | null {
  const trimmedStart = text.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('```mermaid')) return null;

  // Closed fence — closing ``` followed by optional whitespace.
  const closed = trimmedStart.match(/^```mermaid\n([\s\S]*?)```\s*$/);
  if (closed) return { code: closed[1].trim(), closed: true };

  // Open fence (streaming) — everything after the opening line is code.
  const open = trimmedStart.match(/^```mermaid\n?([\s\S]*?)$/);
  if (open) return { code: open[1].trim(), closed: false };

  return null;
}

const MarkdownBlock = memo(
  function MarkdownBlock({
    text,
    isStreamingBlock,
    className,
  }: {
    text: string;
    isStreamingBlock: boolean;
    className?: string;
  }) {
    return (
      <Streamdown
        mode={isStreamingBlock ? 'streaming' : 'static'}
        parseIncompleteMarkdown={isStreamingBlock}
        normalizeHtmlIndentation
        remarkPlugins={[remarkGfm, remarkFilePaths]}
        // Copy button only — no download. Header bar + language live in CSS
        // (Streamdown ships the header; we un-hide and style it). Line
        // numbers + per-block wrap toggle on.
        controls={{ code: { copy: true, download: false } }}
        lineNumbers
        animated={
          isStreamingBlock
            ? { animation: 'blurIn', duration: 420, easing: 'cubic-bezier(0.22,0.61,0.25,1)', sep: 'word' }
            : { animation: 'fadeIn', duration: 300 }
        }
        className={className}
      >
        {text}
      </Streamdown>
    );
  },
  (prev, next) =>
    prev.text === next.text &&
    prev.isStreamingBlock === next.isStreamingBlock &&
    prev.className === next.className,
);

export const MemoizedMarkdown = memo(function MemoizedMarkdown({
  content,
  streaming = false,
  className,
}: {
  content: string;
  streaming?: boolean;
  className?: string;
}) {
  const blockEntries = useMemo(() => buildBlockEntries(content), [content]);
  const lastIndex = blockEntries.length - 1;
  const openFile = useUi((s) => s.openFile);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const rootRef = useRef<HTMLDivElement>(null);

  // Inject the soft-wrap toggle into each code block's actions row. Streamdown
  // owns this DOM (no custom-control API), so this is post-render enhancement:
  // guarded by a dataset flag, re-scanned whenever blocks appear (streaming).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const block of root.querySelectorAll('[data-streamdown="code-block"]')) {
      const el = block as HTMLElement;
      if (el.querySelector('.code-wrap-toggle')) continue;
      const actions = el.querySelector('[data-streamdown="code-block-actions"]');
      if (!actions) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-wrap-toggle';
      btn.title = 'Toggle soft wrap';
      btn.setAttribute('aria-label', 'Toggle soft wrap');
      btn.innerHTML = WRAP_ICON;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = el.getAttribute('data-wrap') === 'on';
        el.setAttribute('data-wrap', on ? 'off' : 'on');
        btn.classList.toggle('is-on', !on);
      });
      actions.appendChild(btn);
    }
  }, [blockEntries]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('[data-file-path]') as HTMLElement | null;
      if (!link) return;
      const filePath = link.dataset.filePath;
      if (!filePath || !activeSessionId) return;
      e.preventDefault();
      openFile(activeSessionId, { id: filePath, path: filePath, language: getLanguageFromExtension(filePath) ?? 'text' });
    },
    [openFile, activeSessionId],
  );

  return (
    <div ref={rootRef} className={cn('prose-chat', className)} onClick={handleClick}>
      {blockEntries.map((entry: { key: string; text: string }, i: number) => {
        const mermaid = extractMermaid(entry.text);

        // If this block is a mermaid code block, render the diagram
        // directly instead of passing it to Streamdown (which would
        // render it as a syntax-highlighted code block).
        if (mermaid) {
          // Live-preview while the fence is open. Once closed the source is
          // final, so render immediately even if the message is still streaming.
          const isStreaming = streaming && !mermaid.closed;
          return (
            <MermaidDiagram
              // Stable key while the fence is open: the content hash changes
              // with every delta, and a remount would reset the live-render
              // throttle. Switch to the content hash once closed.
              key={mermaid.closed ? entry.key : `mermaid-open-${i}`}
              code={mermaid.code}
              streaming={isStreaming}
            />
          );
        }

        return (
          <MarkdownBlock
            key={entry.key}
            text={entry.text}
            isStreamingBlock={streaming && i === lastIndex}
          />
        );
      })}
    </div>
  );
});
