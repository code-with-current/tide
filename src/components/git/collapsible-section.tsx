/** Collapsible "Staged" / "Changes" section header used in the Git Panel Changes tab. */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CollapsibleSection({
  label, count, open, onToggle, children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-3 py-1 text-[0.8rem] font-semibold tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {label}
        <span className="font-normal normal-case tracking-normal text-[0.65rem] text-primary rounded bg-primary/10 px-0.5 min-w-4 text-center">{count}</span>
      </button>
      {open && <div className="px-3 py-1 bg-background">{children}</div>}
    </div>
  );
}
