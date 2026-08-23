/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/MarkdownRendererImpl.tsx.
 *  Adaptations (each documented in task-2-report.md):
 *  - Theme seam: OpenChamber's runtime theme registry (`useOptionalThemeSystem`,
 *    `getDefaultTheme`, `Theme`) is replaced by a next-themes-based hook that
 *    resolves dark/light from `useTheme()` and reads live token values via
 *    `getComputedStyle(document.documentElement)` — mermaid colors and syntax
 *    vars therefore track Tide's static CSS tokens in both themes.
 *  - i18n (`useI18n`) replaced with literal English strings.
 *  - The UI-store settings seams (`codeBlockLineWrap`, `mermaidRenderingMode`)
 *    become per-renderer React state (default off / 'svg') — Tide has no
 *    equivalent store; wrap toggling works within a renderer instance.
 *  - Deleted subsystems with no Tide equivalent: file-reference annotation
 *    (`fileReferenceParser`/`fileReferenceStat`/fs stat probes/editor APIs),
 *    app-link confirmation interactions, loopback preview, FadeInOnReveal
 *    wrapper (arrives with Task 3's message components — `isAnimated` is
 *    accepted and currently renders without the fade), and stream perf probes.
 *  - `part?: Part` from `@opencode-ai/sdk/v2` becomes `part?: OcPart` from
 *    Tide's ported structural types (../types/opencode-parts).
 *  - `ToolPopupContent` from ./message/types (out of port scope) becomes a
 *    minimal structural local type covering the popup payloads this module
 *    emits (mermaid + image previews).
 */
import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import type { OcPart } from '../types/opencode-parts';
import { renderMarkdownBlocks, renderMarkdownSync, type MarkdownImageMode } from './markdown-core';
import { ensureMarkdownShikiTheme } from './markdown-theme';
import {
  getMarkdownSyntaxVars,
  MARKDOWN_SYNTAX_PALETTE_DARK,
  MARKDOWN_SYNTAX_PALETTE_LIGHT,
  type MarkdownSyntaxPalette,
} from './markdown-syntax-vars';
import {
  attachMarkdownInteractions,
  applyMarkdownCodeBlockWrapState,
  decorateMarkdown,
  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './decorate';
import { createMermaidViewerRegistry, MERMAID_BLOCK_SELECTOR, shouldRefreshMermaidViewers } from './mermaid-viewer';

// ---------------------------------------------------------------------------
// Seams: theme + popup content
// ---------------------------------------------------------------------------

/** Minimal popup payload this renderer emits (upstream: ./message/types). */
export type MarkdownToolPopupContent = {
  open: boolean;
  title: string;
  content: string;
  metadata?: { tool?: string; filename?: string };
  mermaid?: { url: string; source: string; filename: string };
  image?: { url: string; filename: string };
};

type MarkdownChatTheme = {
  dark: boolean;
  palette: MarkdownSyntaxPalette;
  colors: {
    bg: string;
    fg: string;
    line: string;
    accent: string;
    muted: string;
    surface: string;
    border: string;
  };
};

const CSS_VAR_FALLBACKS: Record<string, string> = {
  '--card': '#1c1b1a',
  '--foreground': '#cdccc3',
  '--border': '#393836',
  '--primary': '#edb449',
  '--muted': '#403e3c',
  '--muted-foreground': '#b6b4ab',
};

const resolveCssVar = (name: string): string => {
  if (typeof window === 'undefined') return CSS_VAR_FALLBACKS[name] ?? '';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || CSS_VAR_FALLBACKS[name] || '';
};

const resolveDark = (resolvedTheme: string | undefined): boolean => {
  if (resolvedTheme === 'dark') return true;
  if (resolvedTheme === 'light') return false;
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
};

/** Tide theme seam — see the port header. */
const useMarkdownChatTheme = (): MarkdownChatTheme => {
  const { resolvedTheme } = useTheme();
  return React.useMemo(() => {
    const dark = resolveDark(resolvedTheme);
    return {
      dark,
      palette: dark ? MARKDOWN_SYNTAX_PALETTE_DARK : MARKDOWN_SYNTAX_PALETTE_LIGHT,
      colors: {
        bg: resolveCssVar('--card'),
        fg: resolveCssVar('--foreground'),
        line: resolveCssVar('--border'),
        accent: resolveCssVar('--primary'),
        muted: resolveCssVar('--muted-foreground'),
        surface: resolveCssVar('--muted'),
        border: resolveCssVar('--border'),
      },
    };
  }, [resolvedTheme]);
};

const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

interface MarkdownRendererProps {
  content: string;
  part?: OcPart;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: MarkdownToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const useMermaidInlineInteractions = ({
  containerRef,
  onShowPopup,
  enableFullscreen,
  enablePanZoom,
  allowMermaidWheelEvents,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShowPopup?: (content: MarkdownToolPopupContent) => void;
  enableFullscreen?: boolean;
  enablePanZoom?: boolean;
  allowMermaidWheelEvents?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!enableFullscreen || !onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      if (block instanceof HTMLElement && block.hasAttribute('data-mermaid-suppress-click')) {
        block.removeAttribute('data-mermaid-suppress-click');
        return;
      }

      const renderedBlocks = Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR));
      const blockIndex = renderedBlocks.indexOf(block as HTMLElement);
      if (blockIndex < 0) {
        return;
      }

      const source = block instanceof HTMLElement ? block.getAttribute('data-md-source') : null;
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (allowMermaidWheelEvents || ((event.ctrlKey || event.metaKey) && enablePanZoom)) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [allowMermaidWheelEvents, containerRef, enableFullscreen, enablePanZoom, onShowPopup]);
};

// ---------------------------------------------------------------------------
// Rendering core: marked -> math -> shiki -> sanitize -> decorate -> morphdom
// ---------------------------------------------------------------------------

// Mermaid layout is expensive; `decorate` would otherwise re-render every
// diagram on every paced-stream step (~40/sec). Memoize by theme+mode+source
// so a stable diagram is laid out once and served from cache thereafter.
const MERMAID_RENDER_CACHE = new Map<string, MermaidRender>();
const MERMAID_RENDER_CACHE_MAX = 100;

const cachedMermaidRender = (key: string, compute: () => MermaidRender): MermaidRender => {
  const existing = MERMAID_RENDER_CACHE.get(key);
  if (existing) {
    MERMAID_RENDER_CACHE.delete(key);
    MERMAID_RENDER_CACHE.set(key, existing);
    return existing;
  }
  const value = compute();
  MERMAID_RENDER_CACHE.set(key, value);
  if (MERMAID_RENDER_CACHE.size > MERMAID_RENDER_CACHE_MAX) {
    const oldest = MERMAID_RENDER_CACHE.keys().next().value;
    if (oldest) MERMAID_RENDER_CACHE.delete(oldest);
  }
  return value;
};

const DEFAULT_DECORATE_LABELS: DecorateLabels = {
  copy: 'Copy code',
  copied: 'Copied',
  enableCodeWrap: 'Enable line wrap',
  disableCodeWrap: 'Disable line wrap',
  copyTable: 'Copy table',
  downloadTable: 'Download table',
  copyDiagram: 'Copy diagram source',
  downloadDiagram: 'Download diagram as SVG',
  zoomInDiagram: 'Zoom in',
  zoomOutDiagram: 'Zoom out',
  resetDiagramView: 'Reset view',
  previewLabel: 'Preview',
  previewTitle: 'Open preview',
};

const useDecorateContext = (
  currentTheme: MarkdownChatTheme,
  deferCodeLineNumberSync: boolean,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
): DecorateContext => {
  const [codeBlockLineWrap, setCodeBlockLineWrap] = React.useState(false);
  const toggleCodeBlockLineWrap = React.useCallback(() => {
    setCodeBlockLineWrap((current) => !current);
  }, []);

  return React.useMemo<DecorateContext>(() => {
    const colors = {
      ...currentTheme.colors,
      transparent: true,
      font: 'system-ui, sans-serif',
    };
    const themeId = currentTheme.dark ? 'dark' : 'light';
    const renderMermaid = (source: string): MermaidRender =>
      cachedMermaidRender(`${themeId}:svg:${source}`, () => {
        try {
          return { svg: renderMermaidSVG(source, colors) };
        } catch {
          try {
            return { ascii: renderMermaidASCII(source) };
          } catch {
            return {};
          }
        }
      });
    return {
      labels: DEFAULT_DECORATE_LABELS,
      mermaidControls,
      codeBlockLineWrap,
      deferCodeLineNumberSync,
      onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap,
      renderMermaid,
    };
  }, [currentTheme, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, toggleCodeBlockLineWrap]);
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.
const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  imageMode = 'inline',
  syntaxVars,
  ctx,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  imageMode?: MarkdownImageMode;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const refreshMermaidViewers = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!mermaidViewerRef.current) {
      if (!shouldRefreshMermaidViewers(container)) {
        return;
      }
      mermaidViewerRef.current = createMermaidViewerRegistry(container);
      return;
    }
    mermaidViewerRef.current.refresh();
  }, [containerRef]);

  // Synchronous first paint: while the async parse is in-flight, show escaped
  // plain text immediately so there is no blank frame on initial mount. Only
  // runs when the target is empty — subsequent updates keep the prior rich DOM
  // until the next async render morphs in (no flash). Mirrors OpenCode's
  // `initialValue: fallback(text)` resource pattern.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (text && target.childNodes.length === 0) {
      const block = document.createElement('div');
      block.setAttribute('data-md-block', '');
      // `display:contents` keeps margin-collapsing/spacing identical to a flat
      // HTML body — the wrapper exists only for per-block reconciliation.
      block.style.display = 'contents';
      block.innerHTML = renderMarkdownSync(text, imageMode);
      // Decorate synchronously too: wrap code blocks in their framed card,
      // mark inline code, build table controls, etc. The async pass re-decorates
      // its own DOM before morphing, so without this the first paint shows bare
      // <pre>/tables that "snap" into their decorated form a tick later. Matching
      // the structure here keeps the async morph to syntax colors only.
      decorateMarkdown(block, ctx);
      target.appendChild(block);
      if (shouldRefreshMermaidViewers(block)) {
        refreshMermaidViewers();
      }
    }
  }, [containerRef, text, imageMode, ctx, refreshMermaidViewers]);

  React.useEffect(() => () => {
    mermaidViewerRef.current?.cleanup();
    mermaidViewerRef.current = null;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    let active = true;

    void renderMarkdownBlocks(text, streaming, imageMode).then((blocks) => {
      if (!active) return;
      const existing = Array.from(target.children) as HTMLElement[];

      // Reconcile per block: only re-morph blocks whose content changed, leaving
      // stable leading blocks untouched. Keeps per-stream-step DOM work bounded
      // to the trailing (growing) block instead of the whole message.
      blocks.forEach((block, index) => {
        let el = existing[index];
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-md-block', '');
          el.style.display = 'contents';
          target.appendChild(el);
        }
        if (el.getAttribute('data-md-id') === block.id) return;

        const temp = document.createElement('div');
        temp.innerHTML = block.html;
        decorateMarkdown(temp, ctx);
        const hadMermaidBlock = shouldRefreshMermaidViewers(el);
        const tempHasMermaidBlock = shouldRefreshMermaidViewers(temp);
        morphdom(el, temp, {
          childrenOnly: true,
          onBeforeElUpdated: (fromEl, toEl) => !fromEl.isEqualNode(toEl),
        });
        el.setAttribute('data-md-id', block.id);
        if (hadMermaidBlock || tempHasMermaidBlock || shouldRefreshMermaidViewers(el)) {
          refreshMermaidViewers();
        }
      });

      // Remove any trailing block elements no longer present.
      const hadMermaidBeforeTrailingCleanup = shouldRefreshMermaidViewers(target);
      let removedMermaidBlock = false;
      for (let i = existing.length - 1; i >= blocks.length; i -= 1) {
        const removed = existing[i];
        if (removed && shouldRefreshMermaidViewers(removed)) {
          removedMermaidBlock = true;
        }
        removed?.remove();
      }
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }
    });

    return () => {
      active = false;
    };
  }, [containerRef, text, streaming, imageMode, ctx, refreshMermaidViewers]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);

  // Apply syntax CSS variables imperatively so they survive morphdom updates.
  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (ctx.deferCodeLineNumberSync) return;
    applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
  }, [containerRef, ctx.codeBlockLineWrap, ctx.deferCodeLineNumberSync, ctx.labels]);
};

const markdownContentClassName = (variant: MarkdownVariant): string =>
  variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  void enableFileReferences; // Retained for API compat; Tide has no file-reference pipeline (see header).
  void isAnimated;
  void skipFadeIn;
  const currentTheme = useMarkdownChatTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const live = isStreaming && !disableStreamAnimation;

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: DEFAULT_MERMAID_CONTROLS.showPanZoomControls,
  });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme.palette), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, live, DEFAULT_MERMAID_CONTROLS);

  useMorphdomMarkdown({
    containerRef,
    text: content,
    streaming: live,
    imageMode: variant === 'assistant' ? 'label' : 'inline',
    syntaxVars,
    ctx,
  });

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant)} data-markdown-content />
    </div>
  );
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  // App links remain confirmed even where ordinary HTTP link handling is off.
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: MarkdownToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
}) => {
  void disableLinkSafety; // Retained for API compat; Tide has no app-link runtime (see header).
  void enableFileReferences;
  const currentTheme = useMarkdownChatTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: mermaidControls.showPanZoomControls,
    allowMermaidWheelEvents,
  });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme.palette), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, false, mermaidControls);

  useMorphdomMarkdown({
    containerRef,
    text: renderedContent,
    streaming: false,
    syntaxVars,
    ctx,
  });

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant)} data-markdown-content />
    </div>
  );
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences;
});
