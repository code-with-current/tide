/** One row in the Git Panel → History tab, rendered against a git-graph spine:
 *  a vertical rail with a per-commit node. Clicking opens the commit-details
 *  side panel. */
import type { GitCommit } from '@/lib/api/client';
import { cn, formatRelative } from '@/lib/utils';

export function CommitRow({
  commit, isLast = false, active = false, onSelect,
}: {
  commit: GitCommit;
  isLast?: boolean;
  active?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full flex items-stretch text-left transition-colors',
        active ? 'bg-primary/10' : 'hover:bg-secondary/40',
      )}
    >
      {/* Graph gutter: rail + node. The rail is the row's full height so rows
          stack into one continuous spine; the last row clips below its node. */}
      <div className="relative w-6 flex-shrink-0 self-stretch">
        <span className={cn('absolute left-1/2 top-0 w-px -translate-x-1/2 bg-border', isLast ? 'h-1/2' : 'bottom-0')} />
        <span
          className={cn(
            'absolute left-1/2 top-3 -translate-x-1/2 rounded-full ring-2 ring-card transition-colors',
            active ? 'size-2.5 bg-primary' : 'size-2 bg-muted-foreground/50 group-hover:bg-primary/80',
          )}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 py-1.5 pr-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[0.8rem] truncate text-foreground group-hover:text-primary transition-colors">
            {commit.subject || '(no subject)'}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[0.68rem] text-muted-foreground/55 min-w-0">
          <span className="font-mono text-primary/70 flex-shrink-0">{commit.sha}</span>
          <span className="text-muted-foreground/30 flex-shrink-0">·</span>
          <span className="truncate">{commit.author}</span>
          <span className="text-muted-foreground/30 flex-shrink-0">·</span>
          <span className="flex-shrink-0 tabular-nums">{formatRelative(commit.date)}</span>
        </div>
      </div>
    </button>
  );
}
