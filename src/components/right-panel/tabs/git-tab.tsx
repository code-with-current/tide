import { useState } from 'react';
import { GitPanel } from '@/components/git/git-panel';
import { cn } from '@/lib/utils';

/** Git tab: working-tree Changes (default) + Review sub-sections. Local
 *  state only — section choice is transient. */
export function GitTab() {
  const [section, setSection] = useState<'changes' | 'review'>('changes');
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 border-b border-border px-2 py-1.5">
        {(['changes', 'review'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={cn(
              'rounded-md px-2 py-1 text-[12px] capitalize transition-colors',
              section === s ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll">
        {section === 'changes' ? <GitPanel /> : <ReviewSection />}
      </div>
    </div>
  );
}

function ReviewSection() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-center text-[12px] text-muted-foreground">
        Review results appear here after a review run
      </p>
    </div>
  );
}
