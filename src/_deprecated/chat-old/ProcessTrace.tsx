import { useState, type ReactNode } from 'react';
import { Activity, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** Collapsible wrapper for an assistant message's "process" (reasoning + tool calls). Default collapsed; renders null when empty. */
export function ProcessTrace({
  summary,
  children,
}: {
  /** One-line summary shown in the collapsed header, e.g. "3 steps · 412 tok". */
  summary?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!children) return null;
  return (
    <div className="border border-input rounded-lg bg-secondary/40 overflow-hidden mb-2">
      <Button

        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-muted-foreground/60 hover:text-muted font-medium text-[11px] uppercase tracking-wider transition-colors"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', open && 'rotate-90')}
        />
        <Activity className="size-3" />
        Process
        {summary && <span className="normal-case font-normal text-muted-foreground/60/70 ml-1 tracking-normal">· {summary}</span>}
      </Button>
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-input animate-slide-up">
          {children}
          {/* Bottom collapse button — saves scrolling back up to the header
              after reading a long process trace (reasoning + tool calls). */}
          <Button

            onClick={() => setOpen(false)}
            className="mt-1 w-full flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60/70 hover:text-muted py-1 rounded hover:bg-secondary transition-colors"
          >
            <ChevronRight className="size-3 rotate-90" />
            Collapse
          </Button>
        </div>
      )}
    </div>
  );
}
