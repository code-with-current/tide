import { memo } from 'react';
import { Plus, Minus } from 'lucide-react';
import { FileIcon } from 'react-material-icon-theme';
import type { GitFileChange } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const DOT_COLOR = {
  modified: 'bg-amber-400',
  added: 'bg-emerald-400',
  deleted: 'bg-rose-400',
  untracked: 'bg-slate-400',
  renamed: 'bg-sky-400',
} as const;

export const ChangedFileRow = memo(function ChangedFileRow({
  change,
  active,
  showPath = true,
  onClick,
  onToggleStage,
}: {
  change: GitFileChange;
  active?: boolean;
  showPath?: boolean;
  onClick: () => void;
  onToggleStage: () => void;
}) {
  const fileName = change.path.split('/').pop() ?? change.path;
  const dirPath = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={cn(
        'group flex items-center gap-1.5 @sm:gap-2 py-1 px-1.5 @sm:px-2 mx-1 rounded-md text-[0.85rem] cursor-pointer transition-colors duration-150 min-w-0',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
        active ? 'bg-primary/10 ring-1 ring-ring/20' : 'hover:bg-secondary/60',
      )}
    >
      {/* Material file icon — auto-detected by extension */}
      {/* Git status dot — colored circle next to the file icon */}
      <span className={cn('flex-shrink-0 w-1.5 h-1.5 rounded-full', DOT_COLOR[change.status])} />
      <FileIcon fileName={fileName} size={14} className="flex-shrink-0" />



      {/* File name + optional dir path */}
      <div className="flex-1 min-w-0 flex items-baseline gap-1 @sm:gap-1.5">
        <span className="text-foreground/90 font-medium truncate">{fileName}</span>
        {showPath && dirPath && (
          <span className="hidden @sm:inline text-muted-foreground/60 text-[10px] truncate flex-shrink min-w-0">{dirPath}</span>
        )}
      </div>

      {/* +/− counts */}
      {(change.additions > 0 || change.deletions > 0) && (
        <span className="hidden @sm:flex flex-shrink-0 items-center gap-0.5 text-[10px] tabular-nums font-mono">
          {change.additions > 0 && <span className="text-success">+{change.additions}</span>}
          {change.deletions > 0 && <span className="text-destructive">−{change.deletions}</span>}
        </span>
      )}

      {/* Stage/unstage toggle */}
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
