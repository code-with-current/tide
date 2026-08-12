/** Square, full-width tab button used by the Git Panel tab bar (Changes | History). */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn(
        'flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors',
        active
          ? 'text-foreground bg-card border-b-accent border-b-2 -mb-px'
          : 'text-muted-foreground/50 hover:text-muted-foreground bg-card hover:bg-secondary/40 ',
      )}>
      {children}
    </button>
  );
}
