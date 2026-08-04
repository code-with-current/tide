/**
 * Mermaid diagram renderer. Lazy-loads the mermaid library on first
 * render, then renders the diagram as SVG. Falls back to a code block
 * if mermaid fails to load or the diagram syntax is invalid.
 *
 * Click the diagram to open a full-screen zoomable overlay with pan/zoom
 * controls (scroll to zoom, drag to pan). Minimal chrome — just the
 * diagram + floating zoom buttons on a dim background.
 */
import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, ZoomIn, X, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';

let mermaidLoadPromise: Promise<typeof import('mermaid')['default']> | null = null;

async function loadMermaid() {
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        suppressErrorRendering: true,
        themeVariables: {
          background: '#0d0f13',
          primaryColor: '#1a1e25',
          primaryTextColor: '#eef1f6',
          primaryBorderColor: '#3a4150',
          lineColor: '#8b94a3',
          secondaryColor: '#181b21',
          tertiaryColor: '#111317',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
      });
      return mermaid;
    });
  }
  return mermaidLoadPromise;
}

let diagramId = 0;

/**
 * Minimal zoomable overlay — transparent dim background, floating controls.
 * No dialog chrome, no title bar. Just the diagram and two floating buttons.
 */
function DiagramZoomOverlay({
  svg,
  onClose,
}: {
  svg: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(2.5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const reset = useCallback(() => {
    setZoom(2.5);
    setPan({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => Math.min(5, Math.max(0.3, z * delta)));
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start panning when clicking the canvas (not the buttons).
    if ((e.target as HTMLElement).closest('[data-zoom-control]')) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Keyboard shortcuts: Esc=close, +/-/=zoom, 0=reset.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === '0') { reset(); return; }
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom((z) => Math.min(5, z * 1.25));
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => Math.max(0.3, z * 0.8));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, reset]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
    >
      {/* Diagram — centered, zoomable, pannable */}
      <div
        className="select-none"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
          transition: dragging.current ? 'none' : 'transform 0.1s ease-out',
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      {/* Floating controls — bottom center */}
      <div
        data-zoom-control
        className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 backdrop-blur-md px-2 py-1.5 shadow-lg"
      >
        <button
          data-zoom-control
          className="p-2 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          onClick={() => setZoom((z) => Math.max(0.3, z * 0.8))}
          title="Zoom out (−)"
        >
          <ZoomOut className="size-4" />
        </button>
        <span
          data-zoom-control
          className="text-[11px] font-mono text-white/50 tabular-nums min-w-[3rem] text-center select-none"
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          data-zoom-control
          className="p-2 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          onClick={() => setZoom((z) => Math.min(5, z * 1.25))}
          title="Zoom in (+)"
        >
          <ZoomIn className="size-4" />
        </button>
        <div data-zoom-control className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          data-zoom-control
          className="p-2 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          onClick={reset}
          title="Reset to 250% (press 0)"
        >
          <span className="text-[10px] font-medium">Fit</span>
        </button>
      </div>

      {/* Close — top right */}
      <button
        data-zoom-control
        className="fixed top-5 right-5 p-2 rounded-full border border-white/10 bg-black/60 backdrop-blur-md hover:bg-white/10 text-white/70 hover:text-white transition-colors shadow-lg"
        onClick={onClose}
        title="Close (Esc)"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * Sanitize mermaid source for common LLM-emitted patterns that break the
 * parser. Each transform is conservative — it only fires when the input
 * actually contains the problem pattern.
 *
 * Returns an array of candidate sources to try in order (original first,
 * progressively cleaned). The renderer tries each until one succeeds.
 */
function sanitizeMermaid(raw: string): string[] {
  const candidates: string[] = [raw];

  // 1. Decode HTML entities that confuse the lexer inside labels.
  //    Models often emit &amp; / &lt; / &gt; / &quot; inside node text.
  if (/&(amp|lt|gt|quot|#\d+);/.test(raw)) {
    const decoded = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    if (decoded !== raw) candidates.push(decoded);
  }

  // 2. Strip trailing whitespace on each line — mermaid is whitespace-
  //    sensitive in some diagram types and trailing spaces cause "Parse error".
  if (/[ \t]+\n/.test(raw) || /[ \t]+$/.test(raw)) {
    const trimmed = raw
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, ''))
      .join('\n');
    if (!candidates.includes(trimmed)) candidates.push(trimmed);
  }

  // 3. Fix unbalanced quotes in node labels — a common LLM mistake like
  //    A["some unclosed label. Remove the stray quote.
  //    Only attempt if there's an odd number of double-quotes on a line
  //    that looks like a node definition (contains [ or { or (.
  const hasOddQuotes = raw.split('\n').some(
    (l) => l.trim().match(/[\[\{\(]/) && (l.match(/"/g)?.length ?? 0) % 2 !== 0,
  );
  if (hasOddQuotes) {
    const balanced = raw
      .split('\n')
      .map((l) => {
        const q = (l.match(/"/g) ?? []).length;
        if (q % 2 !== 0 && l.match(/[\[\{\(]/)) {
          // Add closing quote before the bracket close
          return l.replace(/([\]\}\)])/, '"$1');
        }
        return l;
      })
      .join('\n');
    if (!candidates.includes(balanced)) candidates.push(balanced);
  }

  // 4. Remove `init` directives that some models emit — they can conflict
  //    with our own initialize() config.
  if (/^\s*%%{.*init.*}%%/m.test(raw) || /^init:/m.test(raw)) {
    const noInit = raw
      .replace(/^\s*%%{[^}]*init[^}]*}%%\s*\n?/gm, '')
      .replace(/^init:.*\n?/gm, '');
    if (!candidates.includes(noInit)) candidates.push(noInit);
  }

  // 5. Sequence diagrams: braces in message text break the parser.
  //    Mermaid treats `{` as a block opener. Lines like
  //      API-->>A: { data: currentUser }
  //    cause "Parse error". Fix by stripping the braces (keep the inner text).
  //    Only applies to lines that look like sequence arrows (contain ->> or -->).
  if (/^(sequenceDiagram|sd)\b/m.test(raw) && /^[ \t]*\S.*--?>>.*:.*\{/m.test(raw)) {
    const noBraces = raw
      .split('\n')
      .map((l) => {
        // Only touch arrow/message lines, not structural keywords.
        if (/^\s*(alt|opt|loop|rect|box|end|else|par|and|note|participant|actor)\b/i.test(l)) return l;
        // Arrow line with braces in message — strip { and }
        if (/--?>>/.test(l) && l.includes('{') && l.includes('}')) {
          return l.replace(/[{}]/g, '');
        }
        return l;
      })
      .join('\n');
    if (!candidates.includes(noBraces)) candidates.push(noBraces);
  }

  return candidates;
}

export const MermaidDiagram = memo(function MermaidDiagram({
  code,
  className,
  streaming,
}: {
  code: string;
  className?: string;
  streaming?: boolean;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    if (streaming) return;

    let cancelled = false;
    (async () => {
      const mermaid = await loadMermaid();
      if (cancelled) return;

      // Try the original source, then progressively sanitized variants.
      const candidates = sanitizeMermaid(code.trim());
      for (const candidate of candidates) {
        try {
          const renderId = `mermaid-${++diagramId}`;
          const { svg: rendered } = await mermaid.render(renderId, candidate);
          if (!cancelled) {
            // Clean up DOM artifacts mermaid leaves after a failed render.
            document.querySelectorAll(
              '[id^="dmermaid"], .mermaid-error, #mermaid-error',
            ).forEach((el) => {
              if (el.id !== renderId) el.remove();
            });
            setSvg(rendered);
            setError(null);
          }
          return; // success — stop trying
        } catch {
          // Try next candidate; if this was the last, fall through to error.
        }
      }

      // All candidates failed.
      if (!cancelled) {
        const firstErr = candidates[0];
        setError(
          firstErr
            ? `Could not render diagram after ${candidates.length} attempt${candidates.length > 1 ? 's' : ''}`
            : 'Empty diagram source',
        );
      }
    })();
    return () => { cancelled = true; };
  }, [code, streaming]);

  if (streaming) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-[11px] text-muted-foreground/50', className)}>
        rendering diagram…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-warning/20 bg-warning/[0.04] overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-warning/15 text-[11px] text-warning/80">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>Diagram syntax error — showing source</span>
        </div>
        <pre className="text-[11px] text-muted-foreground/60 font-mono whitespace-pre-wrap break-words p-3 max-h-[300px] overflow-y-auto scroll">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-[11px] text-muted-foreground/50', className)}>
        rendering diagram…
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          'mermaid-render group relative flex justify-center overflow-x-auto py-2 rounded-lg',
          'cursor-zoom-in hover:bg-secondary/30 transition-colors',
          className,
        )}
        dangerouslySetInnerHTML={{ __html: svg }}
        onClick={() => setZoomOpen(true)}
        title="Click to zoom"
      />
      {zoomOpen && (
        <DiagramZoomOverlay svg={svg} onClose={() => setZoomOpen(false)} />
      )}
    </>
  );
});
