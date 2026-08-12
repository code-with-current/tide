import { Loader2, Plus, Minus, FilePen, FilePlus, FileX, FileQuestion } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/chat/blocks/diff-view';
import { cn } from '@/lib/utils';
import type { DiffHunk } from '@/types';

const STATUS_ICON = {
  modified: FilePen,
  added: FilePlus,
  deleted: FileX,
  untracked: FileQuestion,
  renamed: FilePen,
} as const;

export function DiffDialog({
  open,
  filePath,
  status,
  staged,
  additions,
  deletions,
  hunks,
  loading,
  onOpenChange,
  onToggleStage,
}: {
  open: boolean;
  filePath: string;
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleStage: () => void;
}) {
  const fileName = filePath.split('/').pop() ?? filePath;
  const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const StatusIcon = STATUS_ICON[status as keyof typeof STATUS_ICON] ?? FilePen;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-6xl max-w-8xl max-h-[80vh] p-0 overflow-hidden flex flex-col gap-0 [&>button:last-child]:hidden">
        {/* Header — file path with status icon + diff stats */}
        <DialogHeader className="px-4 py-3 flex-row items-center gap-2.5 border-b border-border space-y-0 bg-secondary">
          <StatusIcon className="size-4 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <DialogTitle className="text-sm font-medium text-foreground truncate">
              {fileName}
            </DialogTitle>
            {dirPath && <p className="text-[11px] text-muted-foreground/60 truncate">{dirPath}</p>}
          </div>
          {/* Status + diff stats badges */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className={cn(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium',
                staged ? 'bg-success/10 text-success' : 'bg-muted/10 text-muted-foreground',
              )}
            >
              {staged ? 'Staged' : 'Unstaged'}
            </span>
            {(additions > 0 || deletions > 0) && (
              <span className="flex items-center gap-1 text-[11px] font-mono tabular-nums">
                {additions > 0 && <span className="text-success">+{additions}</span>}
                {deletions > 0 && <span className="text-destructive">−{deletions}</span>}
              </span>
            )}
          </div>
        </DialogHeader>

        {/* Body — diff content with loading + empty states */}
        <div className="flex-1 overflow-auto scroll bg-background">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <Loader2 className="size-5 text-muted-foreground/60 animate-spin" />
              <span className="text-xs text-muted-foreground/60">Loading diff…</span>
            </div>
          ) : hunks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-1.5">
              <FileQuestion className="size-5 text-muted-foreground/60/50" />
              <span className="text-xs text-muted-foreground/60">No diff available for this file.</span>
            </div>
          ) : (
            <DiffView hunks={hunks} />
          )}
        </div>

        {/* Footer — stage/unstage action */}
        <DialogFooter className="px-4 py-2.5 border-t border-border bg-secondary">
          <Button
            variant={staged ? 'ghost' : 'secondary'}
            size="sm"
            onClick={() => { onToggleStage(); onOpenChange(false); }}
          >
            {staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
            {staged ? 'Unstage File' : 'Stage File'}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
