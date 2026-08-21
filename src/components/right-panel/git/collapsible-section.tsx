/** Collapsible "Staged" / "Changes" section header used in the Git Panel Changes tab. */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CollapsibleSection({
  label, count, open, onToggle, actions, children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Compact bulk-action icon buttons for the section's rows (stage-all etc.). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="w-full flex items-center gap-1 pr-2">
        <button
          onClick={onToggle}
          className={cn(
            'flex items-center gap-1 pl-3 py-1 text-[0.8rem] font-semibold tracking-wider text-muted-foreground hover:text-foreground transition-colors min-w-0',
          )}
        >
          <ChevronRight className={cn('size-3 transition-transform flex-shrink-0', open && 'rotate-90')} />
          <span className="truncate">{label}</span>
          <span className="font-normal normal-case tracking-normal text-[0.65rem] text-primary rounded bg-primary/10 px-0.5 min-w-4 text-center">{count}</span>
        </button>
        <div className="flex-1" />
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {open && <div className="px-3 py-1 bg-background">{children}</div>}
    </div>
  );
}
