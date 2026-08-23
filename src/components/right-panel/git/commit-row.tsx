/** One 24px row in the Git Panel → History tab — table-aligned via a CSS
 *  grid shared with the header row: 64px graph gutter | flexible subject
 *  (with branch/tag chips) | fixed date column | fixed author column. The
 *  graph SVG sits BEHIND the row list, so the gutter cell is transparent;
 *  hover/active backgrounds start after it so they never cover the graph.
 *  The ⋯ popover carries per-commit actions (revert, copy sha, branch). */
import { useState } from 'react';
import { GitBranch, GitCommitHorizontal, Copy, RotateCcw, MoreHorizontal, CornerUpRight, Tag } from 'lucide-react';
import type { GitCommit } from '@/lib/api/client';
import { cn, formatRelative } from '@/lib/utils';
import { toastError, toastSuccess } from '@/lib/toast';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Shared column template — the header row and every CommitRow use this so
 *  cells align across rows. Keep in sync with the graph gutter width. */
export const HISTORY_GRID = 'grid grid-cols-[64px_minmax(0,1fr)_auto_auto] items-center gap-x-1.5';

export function CommitRow({
  commit, active = false, pendingAction = false, laneColor, onSelect, onRevert, onBranch, onCheckout, onCopySha,
}: {
  commit: GitCommit;
  active?: boolean;
  pendingAction?: boolean;
  /** Lane color from the graph — branch chips pick it up so the label
   *  visually binds to its lane in the gutter. */
  laneColor?: string;
  onSelect?: () => void;
  onRevert?: (sha: string) => void;
  onBranch?: (name: string, sha: string) => void;
  onCheckout?: (sha: string) => void;
  onCopySha?: (sha: string) => void;
}) {
  const initials = commit.author
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const hue = [...commit.sha].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const hasChips = (commit.branchHeads?.length ?? 0) + (commit.tags?.length ?? 0) > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn(HISTORY_GRID, 'group relative h-6 cursor-default pr-2')}>
          <button
            type="button"
            onClick={onSelect}
        className={cn(
          'absolute inset-y-0 left-0 right-2 grid grid-cols-[64px_minmax(0,1fr)_auto_auto] items-center gap-x-1.5 px-0 text-left transition-colors',
          active ? 'bg-primary/10' : 'hover:bg-secondary/40',
        )}
      >
        <span className="col-start-2 flex min-w-0 items-center gap-1">
          {hasChips && (
            <>
              {(commit.branchHeads ?? []).map((name) => (
                <span
                  key={name}
                  className={cn(
                    'flex max-w-28 flex-shrink-0 items-center gap-1 truncate rounded-sm h-4 pr-1 text-[0.70rem] leading-none border border-[0.5px]',
                    commit.isHead && name === commit.branchHeads![0]
                      ? 'bg-primary/15 text-primary'
                      : 'bg-secondary text-muted-foreground',
                  )}
                  title={name}
                  style={laneColor ? { borderColor: laneColor } : undefined}
                >
                  <span
                    className="flex flex-shrink-0 h-4 min-h-0 items-center rounded-l-sm justify-center"
                    style={laneColor ? { background: laneColor } : undefined}
                  >
                    <GitBranch className="size-2.5 text-black m-0.5" />
                  </span>
                  <span className="truncate font-mono">{name}</span>
                </span>
              ))}
              {(commit.tags ?? []).map((name) => (
                <span
                  key={name}
                  className="flex max-w-24 flex-shrink-0 items-center gap-0.5 truncate rounded-sm bg-warning/15 py-px pr-1 text-[0.70rem] leading-none text-warning"
                  title={`tag ${name}`}
                >
                  <Tag className="size-2 flex-shrink-0" />
                  <span className="truncate font-mono">{name}</span>
                </span>
              ))}
            </>
          )}
          <span className="min-w-0 flex-1 truncate text-[0.80rem] text-foreground/90">
            {commit.subject || '(no subject)'}
          </span>
        </span>
        <span className="flex-shrink-0 text-[0.62rem] tabular-nums text-muted-foreground/50">
          {formatRelative(commit.date)}
        </span>
        <span className="flex w-28 flex-shrink-0 items-center justify-end gap-1 overflow-hidden">
          <span
            className="flex size-3.5 flex-shrink-0 items-center justify-center rounded-full text-[0.5rem] font-semibold text-white"
            style={{ background: `hsl(${hue} 40% 42%)` }}
            title={commit.author}
          >
            {initials}
          </span>
          <span className="min-w-0 truncate text-[0.62rem] text-muted-foreground/70" title={commit.author}>
            {commit.author}
          </span>
        </span>
      </button>
          {(onRevert || onBranch) && (
            <RowActions commit={commit} pendingAction={pendingAction} onRevert={onRevert} onBranch={onBranch} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onSelect}>
          <GitCommitHorizontal className="size-3.5" /> View details
        </ContextMenuItem>
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(commit.sha).then(() => toastSuccess('Copied sha'), () => toastError('Copy failed'))}>
          <Copy className="size-3.5" /> Copy sha
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopySha?.(`${commit.sha} — ${commit.subject}`)}>
          <Copy className="size-3.5" /> Copy reference
        </ContextMenuItem>
        {onBranch && (
          <ContextMenuItem onClick={() => onBranch(commit.branchHeads?.[0] ?? `from-${commit.sha}`, commit.sha)}>
            <CornerUpRight className="size-3.5" /> Branch from here…
          </ContextMenuItem>
        )}
        {onCheckout && (
          <ContextMenuItem onClick={() => onCheckout(commit.sha)}>
            <GitBranch className="size-3.5" /> Checkout (detached)
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onRevert && (
          <ContextMenuItem variant="destructive" onClick={() => onRevert(commit.sha)}>
            <RotateCcw className="size-3.5" /> Revert commit…
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RowActions({
  commit, pendingAction, onRevert, onBranch,
}: {
  commit: GitCommit;
  pendingAction: boolean;
  onRevert?: (sha: string) => void;
  onBranch?: (name: string, sha: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'menu' | 'revert' | 'branch'>('menu');
  const [branchName, setBranchName] = useState('');

  const close = () => {
    setOpen(false);
    setStage('menu');
    setBranchName('');
  };

  const submitBranch = () => {
    const name = branchName.trim();
    if (!name || !onBranch) return;
    onBranch(name, commit.sha);
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) { setStage('menu'); setBranchName(''); }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Commit actions"
          className="col-start-4 z-10 my-auto flex size-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2" onOpenAutoFocus={(e) => { if (stage === 'branch') e.preventDefault(); }}>
        {stage === 'menu' ? (
          <div className="flex flex-col gap-0.5">
            <span className="truncate px-2 pb-1 pt-0.5 font-mono text-[0.7143rem] text-muted-foreground/60">
              {commit.sha} · {commit.subject || '(no subject)'}
            </span>
            {onBranch && (
              <MenuItem icon={<GitBranch className="size-3.5" />} label="Branch from here…" onClick={() => setStage('branch')} />
            )}
            <MenuItem
              icon={<Copy className="size-3.5" />}
              label="Copy sha"
              onClick={() => {
                navigator.clipboard.writeText(commit.sha).then(
                  () => toastSuccess('Copied sha'),
                  () => toastError('Copy failed'),
                );
                close();
              }}
            />
            {onRevert && (
              <MenuItem
                icon={<RotateCcw className="size-3.5" />}
                label="Revert commit…"
                destructive
                onClick={() => setStage('revert')}
              />
            )}
          </div>
        ) : stage === 'revert' ? (
          <div className="space-y-2.5 p-1">
            <div>
              <p className="text-[0.9286rem] font-semibold">Revert this commit?</p>
              <p className="mt-0.5 text-[0.7857rem] leading-relaxed text-muted-foreground/60">
                Creates a new commit undoing <span className="font-mono">{commit.sha}</span>. If it conflicts, resolve from the Changes tab.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-[0.7857rem]" disabled={pendingAction} onClick={close}>Cancel</Button>
              <Button
                variant="destructive" size="sm" className="h-7 text-[0.7857rem]" disabled={pendingAction}
                onClick={() => { onRevert?.(commit.sha); close(); }}
              >
                <RotateCcw className="size-3" /> Revert
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 p-1">
            <p className="text-[0.9286rem] font-semibold">Branch from <span className="font-mono text-xs">{commit.sha}</span></p>
            <Input
              autoFocus
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitBranch(); }}
              placeholder="branch-name"
              className="h-7 text-xs"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-[0.7857rem]" disabled={pendingAction} onClick={close}>Cancel</Button>
              <Button size="sm" className="h-7 text-[0.7857rem]" disabled={pendingAction || !branchName.trim()} onClick={submitBranch}>
                <CornerUpRight className="size-3" /> Create & switch
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuItem({ icon, label, destructive = false, onClick }: { icon: React.ReactNode; label: string; destructive?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/70',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground/90',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
