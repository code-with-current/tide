/**
 * Mermaid diagram renderer. Lazy-loads the mermaid library on first
 * render, then renders the diagram as SVG. Falls back to a code block
 * if mermaid fails to load or the diagram syntax is invalid.
 *
 * Used as a custom code-block override in Streamdown's `components`
 * prop — when a code block has `className="language-mermaid"`, this
 * component renders instead of the default Shiki highlighter.
 */
import { memo, useState, useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
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

export const MermaidDiagram = memo(function MermaidDiagram({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${++diagramId}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        const { svg: rendered } = await mermaid.render(idRef.current, code.trim());
        if (!cancelled) {
          // Mermaid v11 sometimes injects error overlays into the DOM
          // even on successful renders. Sweep them up.
          document.querySelectorAll('[id^="dmermaid"], .mermaid-error, #mermaid-error').forEach((el) => {
            if (el.id !== idRef.current) el.remove();
          });
          setSvg(rendered);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

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
    <div
      className={cn('mermaid-render flex justify-center overflow-x-auto py-2', className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
