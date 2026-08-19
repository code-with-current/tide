import { memo, useMemo, useCallback } from 'react';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { remarkFilePaths } from '@/lib/remark/file-paths';
import { useUi } from '@/lib/stores/ui';
import { langFromPath } from './turn/turn-block';
import { MermaidDiagram } from './mermaid-diagram';

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
        // Copy button only — no download, no header bar (CSS hides the header
        // and re-surfaces the language as a floating badge). Line numbers on.
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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('[data-file-path]') as HTMLElement | null;
      if (!link) return;
      const filePath = link.dataset.filePath;
      if (!filePath || !activeSessionId) return;
      e.preventDefault();
      openFile(activeSessionId, { id: filePath, path: filePath, language: langFromPath(filePath) });
    },
    [openFile, activeSessionId],
  );

  return (
    <div className={cn('prose-chat', className)} onClick={handleClick}>
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
