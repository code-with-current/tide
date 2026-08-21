import { memo } from 'react';
import { Plus, Minus, Undo2 } from 'lucide-react';
import type { GitFileChange } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const LETTER = {
  modified: { letter: 'M', cls: 'text-muted-foreground' },
  added: { letter: 'A', cls: 'text-emerald-500' },
  deleted: { letter: 'D', cls: 'text-destructive' },
  untracked: { letter: 'U', cls: 'text-amber-500' },
  renamed: { letter: 'R', cls: 'text-sky-500' },
} as const;

/** Middle-truncate a directory path: keep the head + tail, drop the middle. */
function middleTruncate(dir: string, max = 32): string {
  if (dir.length <= max) return dir;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${dir.slice(0, head)}…${dir.slice(-tail)}`;
}

export const ChangedFileRow = memo(function ChangedFileRow({
  change,
  active,
  showPath = true,
  onClick,
  onToggleStage,
  onDiscard,
}: {
  change: GitFileChange;
  active?: boolean;
  showPath?: boolean;
  onClick: () => void;
  onToggleStage: () => void;
  /** Discard this file's working-tree changes — caller must confirm. */
  onDiscard?: () => void;
}) {
  const fileName = change.path.split('/').pop() ?? change.path;
  const dirPath = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  const badge = LETTER[change.status];
  const hasStats = change.additions > 0 || change.deletions > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={cn(
        'group flex items-center gap-1.5 py-0.5 px-1.5 mx-1 rounded-md text-[0.8rem] cursor-pointer transition-colors duration-150 min-w-0',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
        active ? 'bg-primary/10 ring-1 ring-ring/20' : 'hover:bg-secondary/60',
      )}
    >
      {/* Status letter badge */}
      <span
        className={cn('flex-shrink-0 w-3.5 text-center font-mono text-[10px] font-bold select-none', badge.cls)}
        title={change.status}
      >
        {badge.letter}
      </span>

      {/* Path — basename bold, dir muted with middle truncation */}
      <div className="flex-1 min-w-0 flex items-baseline gap-1">
        <span className="text-foreground/90 font-medium truncate">{fileName}</span>
        {showPath && dirPath && (
          <span
            className="hidden @sm:inline text-muted-foreground/60 text-[10px] flex-shrink min-w-0"
            title={dirPath}
          >
            {middleTruncate(dirPath)}
          </span>
        )}
      </div>

      {/* +/− numstat chips */}
      {hasStats && (
        <span className="hidden @sm:flex flex-shrink-0 items-center gap-0.5 text-[10px] tabular-nums font-mono">
          {change.additions > 0 && (
            <span className="text-success bg-success/10 rounded px-0.5">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="text-destructive bg-destructive/10 rounded px-0.5">−{change.deletions}</span>
          )}
        </span>
      )}

      {/* Hover actions: discard (unstaged only), stage/unstage toggle */}
      {!change.staged && onDiscard && (
        <Button
          variant="ghost" size="icon-xs"
          onClick={(e) => { e.stopPropagation(); onDiscard(); }}
          className={cn(
            'flex-shrink-0 w-5 h-5 opacity-0 group-hover:opacity-100 focus:opacity-100',
            'text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10',
          )}
          aria-label={`Discard changes in ${change.path}`}
          title="Discard changes"
        >
          <Undo2 className="size-3" />
        </Button>
      )}
      <Button
        variant="ghost" size={"icon-xs"}
        onClick={(e) => { e.stopPropagation(); onToggleStage(); }}
        className={cn(
          'flex-shrink-0 w-5 h-5 flex items-center justify-center rounded transition-all duration-150',
          'opacity-0 group-hover:opacity-100 focus:opacity-100',
          change.staged
            ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground/60 hover:text-success hover:bg-success/10',
        )}
        aria-label={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
        title={change.staged ? 'Unstage' : 'Stage'}
      >
        {change.staged ? <Minus className="size-3" /> : <Plus className="size-3" />}
      </Button>
    </div>
  );
});
