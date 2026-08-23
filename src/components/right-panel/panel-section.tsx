import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** VSCode-style collapsible section (chevron + label + optional badge + optional header action). HTML-safe div+button structure when action is set. */
export function PanelSection({
  title,
  badge,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: ReactNode;
  /** Optional inline header action (button, split-button, etc.). Rendered
   *  right-aligned, outside the collapse toggle. */
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // The header markup is shared between the two forms; only the wrapper
  // differs (button vs div+button) to keep the a11y/labeling identical.
  const inner = (
    <>
      <span className={cn('size-3 transition-transform', open && 'rotate-90')}>
        <ChevronRight className="size-3" />
      </span>
      {title}
      {badge}
    </>
  );

  return (
    <div className="border-b border-border">
      {action ? (
        // with-action: div container, toggle is a nested button, action is a sibling.
        <div className="flex items-center gap-1 px-3 py-1.5">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex flex-1 items-center gap-1 min-w-0 text-[0.7857rem] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            {inner}
          </button>
          {action}
        </div>
      ) : (
        // plain: the whole header is the toggle button (original behavior).
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-1 px-3 py-1.5 text-[0.7857rem] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {inner}
        </button>
      )}
      {open && <div className="px-3 py-3 bg-background">{children}</div>}
    </div>
  );
}
