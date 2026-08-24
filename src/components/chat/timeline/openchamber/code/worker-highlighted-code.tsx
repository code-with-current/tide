/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/code/WorkerHighlightedCode.tsx.
 *  Adaptations:
 *  - Theme seam: `useThemeSystem()` (OpenChamber runtime theme registry) is
 *    replaced by the same next-themes pattern Task 2's markdown-renderer-impl
 *    uses — `useTheme().resolvedTheme` → `resolveDark` → dark/light syntax
 *    palette. Colors still resolve through the `--md-syntax-*` CSS variables.
 *  - Worker import points at Task 2's ported `../markdown/markdown-worker`.
 *  Logic otherwise unchanged. */

import React from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { getMarkdownSyntaxVars, MARKDOWN_SYNTAX_PALETTE_DARK, MARKDOWN_SYNTAX_PALETTE_LIGHT } from '../markdown/markdown-syntax-vars';
import { highlightCodeInWorker } from '../markdown/markdown-worker';

// Shared static code highlighter backed by the markdown Shiki Web Worker.
//
// Replaces `react-syntax-highlighter` for non-streaming code surfaces (tool
// output, permission previews, diffs, sidebar file contents). The escaped code
// paints synchronously; the worker tokenizes off the main thread and swaps in
// the highlighted markup. Colors resolve through the `--md-syntax-*` CSS
// variables on the host, so theme changes never require re-highlighting.

/** Tide theme seam — mirrors markdown-renderer-impl.tsx's `resolveDark`. */
const resolveDark = (resolvedTheme: string | undefined): boolean => {
  if (resolvedTheme === 'dark') return true;
  if (resolvedTheme === 'light') return false;
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const styleString = (style?: React.CSSProperties): string => {
  if (!style) return '';
  return Object.entries(style)
    .map(([key, value]) => {
      if (value == null) return '';
      const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${prop}:${typeof value === 'number' ? `${value}px` : value};`;
    })
    .join('');
};

// Normalize a worker/plain `<pre><code>` so it sits flush inside the host: drop
// Shiki's own background/margin and apply wrap + caller code styles.
const applyPreStyles = (host: HTMLElement, wrap: boolean, codeStyle?: React.CSSProperties): void => {
  const pre = host.querySelector('pre');
  if (pre) {
    pre.style.margin = '0';
    pre.style.background = 'transparent';
    pre.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
    if (wrap) {
      pre.style.wordBreak = 'break-word';
      pre.style.overflowWrap = 'break-word';
    }
  }
  const code = host.querySelector('code');
  if (code) {
    const extra = styleString(codeStyle);
    if (extra) code.setAttribute('style', `${code.getAttribute('style') ?? ''}${extra}`);
  }
};

const plainHtml = (code: string): string => `<pre><code>${escapeHtml(code)}</code></pre>`;

export interface WorkerHighlightedCodeProps {
  code: string;
  language: string;
  className?: string;
  /** Inline styles for the host container (mirrors react-syntax-highlighter `customStyle`). */
  style?: React.CSSProperties;
  /** Inline styles applied to the `<code>` element (mirrors `codeTagProps.style`). */
  codeStyle?: React.CSSProperties;
  /** Wrap long lines instead of horizontal scroll. */
  wrap?: boolean;
}

export const WorkerHighlightedCode: React.FC<WorkerHighlightedCodeProps> = ({
  code,
  language,
  className,
  style,
  codeStyle,
  wrap = false,
}) => {
  const { resolvedTheme } = useTheme();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const syntaxVars = React.useMemo(
    () => getMarkdownSyntaxVars(resolveDark(resolvedTheme) ? MARKDOWN_SYNTAX_PALETTE_DARK : MARKDOWN_SYNTAX_PALETTE_LIGHT),
    [resolvedTheme],
  );

  // Synchronous escaped first paint — no blank frame before highlighting lands.
  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = plainHtml(code);
    applyPreStyles(host, wrap, codeStyle);
  }, [code, wrap, codeStyle]);

  // Highlight off the main thread, then swap in. Guarded against stale results.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    void highlightCodeInWorker(code, (language || 'text').toLowerCase()).then((html) => {
      if (!active || !host || !html) return;
      host.innerHTML = html;
      applyPreStyles(host, wrap, codeStyle);
    });
    return () => {
      active = false;
    };
  }, [code, language, wrap, codeStyle]);

  return (
    <div
      ref={hostRef}
      className={cn('typography-code', className)}
      style={{ ...(syntaxVars as React.CSSProperties), ...style }}
    />
  );
};
