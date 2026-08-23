/** Mermaid renderer: lazy-loads the library, renders SVG, falls back to a code block on error; click opens a full-screen pan/zoom overlay (rendered via portal to escape overflow-hidden containers). */
import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, ZoomIn, X, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';

let mermaidBase: Promise<typeof import('mermaid')['default']> | null = null;
let configuredFor: string | null = null;

/** Palette from theme CSS vars (--mermaid-*, defined per data-theme in
 *  index.css) — falls back to the current dark values when unset. */
function mermaidThemeVariables(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--mermaid-bg', '#0d0f13'),
    primaryColor: v('--mermaid-node', '#1a1e25'),
    primaryTextColor: v('--mermaid-text', '#eef1f6'),
    primaryBorderColor: v('--mermaid-border', '#3a4150'),
    lineColor: v('--mermaid-line', '#8b94a3'),
    secondaryColor: v('--mermaid-node-alt', '#181b21'),
    tertiaryColor: v('--mermaid-node-soft', '#111317'),
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };
}

/** (Re)initialize when the app theme changes — rendered SVGs bake colors in,
 *  so diagrams re-render on theme switch (keyed in the render effect). */
async function loadMermaid() {
  if (!mermaidBase) {
    mermaidBase = import('mermaid').then((m) => m.default);
  }
  const mermaid = await mermaidBase;
  const themeKey = document.documentElement.getAttribute('data-theme') ?? '';
  if (configuredFor !== themeKey) {
    const cs = getComputedStyle(document.documentElement);
    mermaid.initialize({
      startOnLoad: false,
      theme: (cs.getPropertyValue('--mermaid-theme').trim() || 'dark') as 'dark' | 'default',
      securityLevel: 'loose',
      suppressErrorRendering: true,
      themeVariables: mermaidThemeVariables(),
    });
    configuredFor = themeKey;
  }
  return mermaid;
}

let diagramId = 0;

/** Live-preview cadence: at most one mermaid render per interval, trailing edge. */
const LIVE_THROTTLE_MS = 350;

/** Cheap candidates for live renders — just the raw source and its line-trimmed variant (no full sanitize chain per tick). */
function streamingCandidates(raw: string): string[] {
  const trimmed = raw
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
  return trimmed === raw ? [raw] : [raw, trimmed];
}

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
  // zoom=1 means the diagram's "natural" zoomed view (2.5x actual scale).
  // Display: 100% = 2.5x actual, 200% = 5x actual, etc.
  const BASE = 2.5;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => Math.max(0.1, z * delta));
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
        setZoom((z) => z * 1.25);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => Math.max(0.1, z * 0.8));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, reset]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-[2px]"
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
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom * BASE})`,
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
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
          title="Zoom out (−)"
        >
          <ZoomOut className="size-4" />
        </button>
        <span
          data-zoom-control
          className="text-[0.7857rem] font-mono text-white/50 tabular-nums min-w-[3rem] text-center select-none"
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          data-zoom-control
          className="p-2 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          onClick={() => setZoom((z) => z * 1.25)}
          title="Zoom in (+)"
        >
          <ZoomIn className="size-4" />
        </button>
        <div data-zoom-control className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          data-zoom-control
          className="p-2 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          onClick={reset}
          title="Reset to 100% (press 0)"
        >
          <span className="text-[0.7143rem] font-medium">Fit</span>
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
    </div>,
    document.body,
  );
}

/** Sanitize mermaid source for common LLM-emitted parser-breaking patterns.
 *  Returns candidate sources CUMULATIVELY — raw first, then each successive
 *  fix applied on top of the previous variant — because real-world broken
 *  diagrams usually stack several mistakes at once; independent variants
 *  rarely combined the right fixes. The renderer tries them in order and
 *  uses the first that parses. */
export function sanitizeMermaid(raw: string): string[] {
  const candidates: string[] = [];
  let cur = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const push = () => { if (!candidates.includes(cur)) candidates.push(cur); };
  push();

  // 1. Decode HTML entities that confuse the lexer inside labels.
  //    Models often emit &amp; / &lt; / &gt; / &quot; inside node text.
  if (/&(amp|lt|gt|quot|#\d+);/.test(cur)) {
    cur = cur
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    push();
  }

  // 2. Strip trailing whitespace on each line — mermaid is whitespace-
  //    sensitive in some diagram types and trailing spaces cause "Parse error".
  if (/[ \t]+\n/.test(cur) || /[ \t]+$/.test(cur)) {
    cur = cur.split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n');
    push();
  }

  // 3. Strip inline %% comments. Full-line %% comments are legal mermaid;
  //    a trailing `%% note` after code on the same line is not — the lexer
  //    eats the rest of the line and usually derails the parse.
  if (cur.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('%%') && l.includes('%%'))) {
    cur = cur.split('\n')
      .map((l) => (l.trim().startsWith('%%') || !l.includes('%%')) ? l : l.replace(/%%.*$/, ''))
      .join('\n');
    push();
  }

  // 4. Remove `init` directives that some models emit — they can conflict
  //    with our own initialize() config.
  if (/^\s*%%{.*init.*}%%/m.test(cur) || /^init:/m.test(cur)) {
    cur = cur
      .replace(/^\s*%%{[^}]*init[^}]*}%%\s*\n?/gm, '')
      .replace(/^init:.*\n?/gm, '');
    push();
  }

  // 5. Fix unbalanced quotes in node labels — a common LLM mistake like
  //    A["some unclosed label. Remove the stray quote.
  const hasOddQuotes = cur.split('\n').some(
    (l) => l.trim().match(/[[{(]/) && (l.match(/"/g)?.length ?? 0) % 2 !== 0,
  );
  if (hasOddQuotes) {
    cur = cur
      .split('\n')
      .map((l) => {
        const q = (l.match(/"/g) ?? []).length;
        if (q % 2 !== 0 && l.match(/[[{(]/)) {
          return l.replace(/([\]})])/, '"$1');
        }
        return l;
      })
      .join('\n');
    push();
  }

  // 6. Flowchart-family: quote labels containing bracket/paren/brace/colon
  //    characters. `A[foo (bar)]` and `B{"x": 1}` break the lexer because
  //    the inner brackets terminate the shape; quoting makes them literal.
  //    Already-quoted labels are left alone.
  if (/^(flowchart|graph|stateDiagram-v2?|erDiagram)\b/m.test(cur)) {
    const quoted = cur.split('\n')
      .map((l) => l.replace(
        /(\[[^\]\n]*\]|\{[^}\n]*\}|\([^)\n]*\))/g,
        (shape) => {
          const open = shape[0];
          const inner = shape.slice(1, -1);
          if (!inner || (inner.startsWith('"') && inner.endsWith('"'))) return shape;
          if (/["(){}[:#]/.test(inner)) {
            return `${open}"${inner.replace(/"/g, "'")}"${shape[shape.length - 1]}`;
          }
          return shape;
        },
      ))
      .join('\n');
    if (quoted !== cur) { cur = quoted; push(); }

    // 6b. Reserved word `end` used as a node id — `end[Finish]`, `A --> end`,
    //     `end --> B` — collides with the subgraph/block terminator and fails
    //     the whole parse. Rename those ids to `endNode` (bare `end` lines
    //     that close subgraphs are untouched).
    if (/\bend\b\s*(\[|\{|\(|-->|->|-\.|==)/.test(cur) || /-->\s*end\b/.test(cur)) {
      const renamed = cur
        .replace(/\bend\b(?=\s*(\[|\{|\(|-->|->|-\.|==))/g, 'endNode')
        .replace(/(-->\s*)end\b/g, '$1endNode');
      if (renamed !== cur) { cur = renamed; push(); }
    }

    // 6c. Subgraph titles with spaces need quoting: `subgraph main flow`
    //     breaks; `subgraph "main flow"` and `subgraph id[title]` are legal.
    const subgraphFix = cur.split('\n')
      .map((l) => {
        const m = l.match(/^(\s*subgraph\s+)(.+)$/);
        if (!m) return l;
        const rest = m[2].trim();
        if (rest.startsWith('"') || rest.includes('[') || rest.includes('(')) return l;
        if (!rest.includes(' ')) return l;
        return `${m[1]}"${rest}"`;
      })
      .join('\n');
    if (subgraphFix !== cur) { cur = subgraphFix; push(); }
  }

  // 7. Sequence diagrams: braces in message text break the parser (Mermaid
  //    treats `{` as a block opener). Fix by stripping braces from
  //    arrow/message lines (contain ->> or -->), keeping inner text.
  if (/^(sequenceDiagram|sd)\b/m.test(cur) && /^[ \t]*\S.*--?>>.*:.*\{/m.test(cur)) {
    cur = cur
      .split('\n')
      .map((l) => {
        if (/^\s*(alt|opt|loop|rect|box|end|else|par|and|note|participant|actor)\b/i.test(l)) return l;
        if (/--?>>/.test(l) && l.includes('{') && l.includes('}')) {
          return l.replace(/[{}]/g, '');
        }
        return l;
      })
      .join('\n');
    push();
  }

  // 8. Drop styling directives last — `style X ...` / `linkStyle` / `click`
  //    referencing nodes that don't exist (renamed, dropped, or hallucinated)
  //    hard-fail the render. Diagram content survives without them.
  if (/^\s*(style|classDef|class|linkStyle|click)\b/m.test(cur)) {
    const stripped = cur
      .split('\n')
      .filter((l) => !/^\s*(style|classDef|class|linkStyle|click)\b/.test(l))
      .join('\n');
    if (stripped.trim() !== '') { cur = stripped; push(); }
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
  const [repairing, setRepairing] = useState(false);
  const lastRenderAtRef = useRef(0);
  const lastRenderedRef = useRef<string | null>(null);
  // One model-repair attempt per mounted diagram — a failed repair must not
  // loop; the error card is the terminal state.
  const repairedOnceRef = useRef(false);
  // Theme changes re-render (SVGs bake colors in) via the effect's cache key.
  const appTheme = useUi((s) => s.appTheme);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const cacheKey = `${appTheme}\u0000${trimmed}`;
    // Already rendered this exact source under this theme — nothing to do
    // (covers the streaming → done transition after a successful live render).
    if (lastRenderedRef.current === cacheKey) return;

    // Final render (fence closed or stream ended): authoritative, with the
    // full sanitize fallback chain — then, if every candidate failed, one
    // model-driven repair attempt (system model rewrites the diagram with
    // the parse error in hand) before giving up.
    if (!streaming) {
      let cancelled = false;
      (async () => {
        const mermaid = await loadMermaid();
        if (cancelled) return;

        const tryCandidates = async (source: string): Promise<{ svg: string } | { error: string }> => {
          let lastParseError = '';
          for (const candidate of sanitizeMermaid(source)) {
            try {
              const { svg: rendered } = await mermaid.render(`mermaid-${++diagramId}`, candidate);
              return { svg: rendered };
            } catch (e) {
              lastParseError = e instanceof Error ? e.message : String(e);
            }
          }
          return { error: lastParseError || 'all candidates failed' };
        };

        const first = await tryCandidates(trimmed);
        if ('svg' in first) {
          if (!cancelled) { setSvg(first.svg); setError(null); }
          lastRenderedRef.current = cacheKey;
          return;
        }

        // Local chain exhausted — ask the model to rewrite the diagram.
        let finalError = first.error;
        if (!cancelled && !repairedOnceRef.current) {
          repairedOnceRef.current = true;
          setRepairing(true);
          try {
            const res = await window.tideIpc?.mermaidRepair({
              source: trimmed,
              error: first.error.split('\n')[0]?.slice(0, 300) ?? '',
            });
            if (res && 'ok' in res && res.ok) {
              const second = await tryCandidates(res.code);
              if ('svg' in second) {
                if (!cancelled) { setSvg(second.svg); setError(null); }
                return;
              }
              finalError = second.error;
            }
          } catch { /* repair unavailable — fall through to the error card */ }
          finally { if (!cancelled) setRepairing(false); }
        }

        // Repair failed too — surface the ORIGINAL chain's parse error.
        if (!cancelled) {
          const detail = finalError.split('\n')[0]?.slice(0, 200);
          setError(
            detail
              ? `Diagram syntax error — ${detail}`
              : 'Could not render diagram',
          );
        }
      })();
      return () => { cancelled = true; };
    }

    // Live preview while the fence is still open: throttled, parse-gated
    // renders that only ever swap forward — a failed parse just skips the
    // tick and keeps the last good SVG on screen.
    let cancelled = false;
    const timer = setTimeout(
      () => {
        (async () => {
          const mermaid = await loadMermaid();
          if (cancelled) return;
          for (const candidate of streamingCandidates(trimmed)) {
            let valid = false;
            try {
              valid = (await mermaid.parse(candidate, { suppressErrors: true })) !== false;
            } catch {
              valid = false;
            }
            if (!valid) continue;
            try {
              const { svg: rendered } = await mermaid.render(`mermaid-${++diagramId}`, candidate);
              if (cancelled) return;
              lastRenderAtRef.current = Date.now();
              if (candidate === trimmed) lastRenderedRef.current = cacheKey;
              setSvg(rendered);
              setError(null);
            } catch {
              // keep the last good preview
            }
            return;
          }
        })();
      },
      Math.max(0, LIVE_THROTTLE_MS - (Date.now() - lastRenderAtRef.current)),
    );
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, streaming, appTheme]);

  if (error) {
    return (
      <div className="rounded-lg border border-warning/20 bg-warning/[0.04] overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-warning/15 text-[0.7857rem] text-warning/80">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span title={error}>{error}</span>
        </div>
        <pre className="text-[0.7857rem] text-muted-foreground/60 font-mono whitespace-pre-wrap break-words p-3 max-h-[300px] overflow-y-auto scroll">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={cn('mermaid-card mermaid-live flex items-center justify-center gap-2 py-6 text-[0.7857rem] text-muted-foreground/50', className)}>
        {repairing ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            local fixes failed — asking the model to redraw the diagram…
          </>
        ) : (
          'rendering diagram…'
        )}
      </div>
    );
  }
  return (
    <>
      <div
        className={cn(
          'mermaid-card mermaid-render group relative flex justify-center overflow-x-auto p-3',
          'cursor-zoom-in hover:bg-secondary/25 transition-colors',
          streaming && 'mermaid-live',
          className,
        )}
        onClick={() => setZoomOpen(true)}
        title="Click to zoom"
      >
        <div className="mermaid-svg-host" dangerouslySetInnerHTML={{ __html: svg }} />
        <span className="pointer-events-none absolute bottom-1.5 right-2 flex items-center gap-1 rounded-full bg-background/70 px-1.5 py-0.5 font-mono text-[0.7143rem] text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">
          <ZoomIn className="size-3" /> zoom
        </span>
      </div>
      {zoomOpen && (
        <DiagramZoomOverlay svg={svg} onClose={() => setZoomOpen(false)} />
      )}
    </>
  );
});
