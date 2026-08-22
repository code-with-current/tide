/** Branch popover + ahead/behind badges, shared by the window top bar and
 *  the Git panel toolbar. Self-sources workspace/session (worktree-aware,
 *  same pattern as GitPanel) so both mount points stay one-liners. */
import { useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowDownUp, Check, ChevronRight, Cloud,
  GitBranch, GitFork, GitMerge, Loader2, LogIn, Plus, Search, Settings2, Trash2, X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SkeletonBar } from '@/components/ui/loading-rows';
import {
  useSession, useGitBranchInfo, useGitAheadBehind, useBranchesDetailed,
  useGitCheckout, useGitCreateBranch, useGitDeleteBranch, useGitMergeBranch,
  useGitFetch, useGitPull, useGitPush,
} from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { cn, formatRelative } from '@/lib/utils';
import { toastError, toastSuccess } from '@/lib/toast';
import type { GitBranchDetailed } from '@/lib/api/client';

/** `↓{behind} ↑{ahead}` pill for HEAD vs upstream. Display-only; hidden
 *  when there's no upstream (null) or nothing to show. */
export function BranchBadges() {
  const workspaceId = useUi(s => s.activeWorkspaceId);
  const sessionId = useUi(s => s.activeSessionId);
  const { data: activeSession } = useSession(sessionId);
  const gitSessionId = activeSession?.worktree ? sessionId : undefined;
  const { data } = useGitAheadBehind(workspaceId, gitSessionId);
  if (!data || (data.ahead <= 0 && data.behind <= 0)) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[0.7143rem] tabular-nums leading-none select-none">
      {data.behind > 0 && <span className="text-muted-foreground">↓{data.behind}</span>}
      {data.ahead > 0 && <span className="text-success">↑{data.ahead}</span>}
    </span>
  );
}

/** Worktree options surfaced inside the popover — passed only by the
 *  new-session screen, which pre-configures per-session isolation before the
 *  first message creates the session. Absent = section hidden (top bar, Git
 *  panel). */
export interface BranchMenuWorktree {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  branchName: string;
  onBranchName: (v: string) => void;
  baseBranch: string;
  onBaseBranch: (v: string) => void;
  configFiles: string[];
  onConfigFiles: (v: string[]) => void;
  worktreeLocation?: string;
  defaultBranch?: string;
}

export function BranchMenu({ trigger, align = 'start', worktree }: { trigger: React.ReactElement; align?: 'start' | 'center' | 'end'; worktree?: BranchMenuWorktree }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [wtOpen, setWtOpen] = useState(false);

  const workspaceId = useUi(s => s.activeWorkspaceId);
  const sessionId = useUi(s => s.activeSessionId);
  const { data: activeSession } = useSession(sessionId);
  const gitSessionId = activeSession?.worktree ? sessionId : undefined;
  const { data: branchInfo } = useGitBranchInfo(workspaceId, gitSessionId);
  const currentBranch = branchInfo?.branch ?? null;
  const { data: branches, isLoading } = useBranchesDetailed(workspaceId, gitSessionId, open);

  const checkoutM = useGitCheckout(workspaceId ?? '', gitSessionId);
  const createM = useGitCreateBranch(workspaceId ?? '', gitSessionId);
  const deleteM = useGitDeleteBranch(workspaceId ?? '', gitSessionId);
  const mergeM = useGitMergeBranch(workspaceId ?? '', gitSessionId);
  const fetchM = useGitFetch(workspaceId ?? '', gitSessionId);
  const pullM = useGitPull(workspaceId ?? '', gitSessionId);
  const pushM = useGitPush(workspaceId ?? '', gitSessionId);

  const lower = query.trim().toLowerCase();
  const { locals, remotes } = useMemo(() => {
    const match = (b: GitBranchDetailed) => !lower || b.name.toLowerCase().includes(lower) || b.subject.toLowerCase().includes(lower);
    const sorted = (list: GitBranchDetailed[]) =>
      [...list].sort((a, b) => (a.name === currentBranch ? -1 : b.name === currentBranch ? 1 : b.lastCommitUnix - a.lastCommitUnix));
    const all = branches ?? [];
    return {
      locals: sorted(all.filter(b => !b.isRemote && match(b))),
      remotes: sorted(all.filter(b => b.isRemote && match(b))),
    };
  }, [branches, lower, currentBranch]);

  // Remote rows check out the short name — git's DWIM creates the tracking
  // branch when no local of that name exists (or switches to the local one).
  const checkoutTarget = (b: GitBranchDetailed) => (b.isRemote ? b.name.split('/').slice(1).join('/') : b.name);

  const doCheckout = async (b: GitBranchDetailed) => {
    const target = checkoutTarget(b);
    const r = await checkoutM.mutateAsync(target);
    if (!r.ok) { toastError('Checkout failed', { description: r.error }); return; }
    toastSuccess(`Switched to ${target}`);
    setOpen(false);
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await createM.mutateAsync({ name });
    if (!r.ok) { toastError('Branch not created', { description: r.error }); return; }
    toastSuccess(`Switched to ${name}`);
    setNewName('');
    setOpen(false);
  };

  const doMerge = async (b: GitBranchDetailed) => {
    const r = await mergeM.mutateAsync(b.name);
    if (r.ok) { toastSuccess(`Merged ${b.name}`); setOpen(false); return; }
    if (r.conflicts?.length) {
      toastError(`${r.conflicts.length} merge conflict${r.conflicts.length === 1 ? '' : 's'}`, {
        description: r.conflicts.slice(0, 5).map(c => c.path).join('\n'),
      });
      setOpen(false);
      return;
    }
    toastError('Merge failed', { description: r.error });
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const r = await deleteM.mutateAsync({ name: confirmDelete });
    setConfirmDelete(null);
    if (!r.ok) { toastError('Delete failed', { description: r.error }); return; }
    toastSuccess('Branch deleted');
  };

  const doSync = async (op: 'fetch' | 'pull' | 'push') => {
    const m = op === 'fetch' ? fetchM : op === 'pull' ? pullM : pushM;
    const r = await m.mutateAsync();
    if (!r.ok) { toastError(`${op[0].toUpperCase()}${op.slice(1)} failed`, { description: r.error }); return; }
    toastSuccess(op === 'fetch' ? 'Fetched' : op === 'pull' ? 'Pulled' : 'Pushed');
  };

  const renderRow = (b: GitBranchDetailed) => {
    const isCurrent = !b.isRemote && b.name === currentBranch;
    const target = checkoutTarget(b);
    const checkingOut = checkoutM.isPending && checkoutM.variables === target;
    return (
      <div
        key={b.name}
        role="button"
        tabIndex={0}
        onClick={() => { if (!isCurrent && !checkingOut) doCheckout(b); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !isCurrent && !checkingOut) doCheckout(b); }}
        className={cn(
          'group w-full h-7 flex items-center gap-1.5 px-2 cursor-pointer text-left transition-colors',
          isCurrent ? 'bg-primary/10' : 'hover:bg-secondary/40',
        )}
      >
        {isCurrent ? (
          <Check className="size-3 flex-shrink-0 text-primary" />
        ) : b.isRemote ? (
          <Cloud className="size-3 flex-shrink-0 text-muted-foreground/50" />
        ) : (
          <GitBranch className="size-3 flex-shrink-0 text-muted-foreground/50" />
        )}
        <span className={cn('font-mono text-xs truncate', isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground group-hover:text-foreground')}>
          {b.name}
        </span>
        {(b.behind ?? 0) > 0 && <span className="font-mono text-[0.7143rem] tabular-nums text-muted-foreground/70 flex-shrink-0">↓{b.behind}</span>}
        {(b.ahead ?? 0) > 0 && <span className="font-mono text-[0.7143rem] tabular-nums text-success flex-shrink-0">↑{b.ahead}</span>}
        {checkingOut && <Loader2 className="size-3 animate-spin text-primary flex-shrink-0" />}
        {/* Meta on idle, actions on hover — the two swap without layout shift. */}
        <span className="ml-auto flex items-center gap-1.5 min-w-0 text-[0.7143rem] text-muted-foreground/60 group-hover:hidden">
          <span className="font-mono flex-shrink-0">{b.shortSha}</span>
          <span className="flex-shrink-0">{formatRelative(new Date(b.lastCommitUnix * 1000).toISOString())}</span>
          <span className="truncate">{b.subject}</span>
        </span>
        <span className="ml-auto hidden items-center gap-0.5 flex-shrink-0 group-hover:flex">
          {!isCurrent && (
            <RowAction label={`Checkout ${target}`} pending={checkingOut} onClick={(e) => { e.stopPropagation(); doCheckout(b); }} icon={LogIn} />
          )}
          {!isCurrent && (
            <RowAction
              label={`Merge ${b.name} into ${currentBranch ?? 'HEAD'}`}
              pending={mergeM.isPending && mergeM.variables === b.name}
              onClick={(e) => { e.stopPropagation(); doMerge(b); }}
              icon={GitMerge}
            />
          )}
          {!isCurrent && !b.isRemote && (
            <RowAction label={`Delete ${b.name}`} onClick={(e) => { e.stopPropagation(); setConfirmDelete(b.name); }} icon={Trash2} danger />
          )}
        </span>
      </div>
    );
  };

  const inputCls = 'h-7 w-full text-xs font-mono bg-input border border-input rounded-md px-2 outline-none focus:border-primary/60 transition-colors';

  return (
    <>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setQuery(''); setNewName(''); } }}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align={align} className="w-[380px] p-0 overflow-hidden">
          {/* Header: search + create */}
          <div className="flex flex-col gap-1.5 p-2 border-b border-border bg-secondary/30">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50 pointer-events-none" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search branches…"
                className={cn(inputCls, 'pl-6 font-sans')}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') doCreate(); }}
                placeholder="Create branch…"
                className={inputCls}
              />
              <button
                type="button"
                disabled={createM.isPending || !newName.trim()}
                onClick={doCreate}
                aria-label="Create branch"
                className="flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none transition-colors flex-shrink-0"
              >
                {createM.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3.5" />}
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-[320px] overflow-y-auto scroll">
            {isLoading ? (
              <div className="p-2 space-y-2" aria-hidden>
                {[...Array(5)].map((_, i) => <SkeletonBar key={i} className="h-4" style={{ width: `${50 + i * 9}%` }} />)}
              </div>
            ) : locals.length === 0 && remotes.length === 0 ? (
              <div className="py-6 text-center text-[0.7857rem] text-muted-foreground/50">
                {lower ? 'No matching branches' : 'No branches'}
              </div>
            ) : (
              <>
                {locals.length > 0 && <SectionLabel count={locals.length} remote={false} />}
                {locals.map(renderRow)}
                {remotes.length > 0 && <SectionLabel count={remotes.length} remote />}
                {remotes.map(renderRow)}
              </>
            )}
          </div>

          {/* Worktree section — only on the new-session screen */}
          {worktree && <WorktreeSection wt={worktree} wtOpen={wtOpen} onToggleOpen={() => setWtOpen((v) => !v)} branches={(branches ?? []).filter((b) => !b.isRemote).map((b) => b.name)} />}

          {/* Footer: sync actions */}
          <div className="border-t border-border flex">
            <SyncButton label="Fetch" icon={<ArrowDownToLine className="size-3" />} pending={fetchM.isPending} onClick={() => doSync('fetch')} />
            <SyncButton label="Pull" icon={<ArrowDownUp className="size-3" />} pending={pullM.isPending} onClick={() => doSync('pull')} />
            <SyncButton label="Push" icon={<ArrowUpFromLine className="size-3" />} pending={pushM.isPending} onClick={() => doSync('push')} />
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch “{confirmDelete}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The branch and its reflog are removed. Merged branches delete cleanly; unmerged changes need a force delete from the terminal.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={doDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SectionLabel({ count, remote }: { count: number; remote: boolean }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[0.6429rem] uppercase tracking-wider text-muted-foreground/40 font-semibold sticky top-0 bg-popover">
      {remote ? 'Remote' : 'Local'} · {count}
    </div>
  );
}

function RowAction({
  label, icon: Icon, onClick, pending = false, danger = false,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: (e: React.MouseEvent) => void;
  pending?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={pending}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center size-5 rounded transition-colors',
        danger
          ? 'text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground/60 hover:text-foreground hover:bg-secondary/80',
        pending && 'opacity-50 pointer-events-none',
      )}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
    </button>
  );
}

function SyncButton({ label, icon, pending, onClick }: { label: string; icon: React.ReactNode; pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 disabled:opacity-60 disabled:pointer-events-none transition-colors"
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : icon}
      {label}
    </button>
  );
}

/** Collapsible worktree config — header row (toggle + status) expands to the
 *  branch/base/copy/location rows, mirroring the old standalone panel. */
function WorktreeSection({
  wt, wtOpen, onToggleOpen, branches,
}: {
  wt: BranchMenuWorktree;
  wtOpen: boolean;
  onToggleOpen: () => void;
  branches: string[];
}) {
  const baseOptions = useMemo(() => {
    const set = new Set<string>();
    if (wt.defaultBranch) set.add(wt.defaultBranch);
    if (wt.baseBranch) set.add(wt.baseBranch);
    for (const b of branches) set.add(b);
    return [...set].sort();
  }, [branches, wt.defaultBranch, wt.baseBranch]);

  return (
    <div className="border-t border-border">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleOpen(); } }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-secondary/40 transition-colors"
      >
        <ChevronRight className={cn('size-3 text-muted-foreground/60 transition-transform', wtOpen && 'rotate-90')} />
        <GitFork className="size-3 text-muted-foreground/60" />
        <span className="text-xs font-medium flex-1">Worktree</span>
        <WtToggle enabled={wt.enabled} onClick={wt.onToggle} />
        <span className={cn('text-[0.7143rem] font-mono w-12 text-right', wt.enabled ? 'text-success' : 'text-muted-foreground/60')}>
          {wt.enabled ? 'isolated' : 'off'}
        </span>
      </div>

      {wtOpen && (
        <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-border/60">
          <label className="flex items-center gap-2 text-[0.7857rem]">
            <span className="w-14 text-muted-foreground/60 uppercase tracking-wider text-[0.7143rem] font-semibold">branch</span>
            <input
              type="text"
              value={wt.branchName}
              onChange={(e) => wt.onBranchName(e.target.value)}
              placeholder="session"
              disabled={!wt.enabled}
              className="flex-1 h-7 px-2 text-xs font-mono bg-input border border-input rounded-md outline-none focus:border-primary/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </label>

          <label className="flex items-center gap-2 text-[0.7857rem]">
            <span className="w-14 text-muted-foreground/60 uppercase tracking-wider text-[0.7143rem] font-semibold">base</span>
            <select
              value={wt.baseBranch}
              onChange={(e) => wt.onBaseBranch(e.target.value)}
              disabled={!wt.enabled}
              className="flex-1 h-7 px-2 text-xs font-mono bg-input border border-input rounded-md outline-none focus:border-primary/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {baseOptions.length === 0 && <option value="">{wt.defaultBranch ?? 'main'}</option>}
              {baseOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>

          <div className="flex flex-col gap-1.5 text-[0.7857rem]">
            <div className="flex items-center gap-2">
              <span className="w-14 text-muted-foreground/60 uppercase tracking-wider text-[0.7143rem] font-semibold">copy</span>
              <div className="flex-1 flex flex-wrap items-center gap-1">
                {wt.configFiles.map((f) => (
                  <span key={f} className="inline-flex items-center gap-1 rounded bg-secondary border border-border pl-1.5 pr-0.5 py-0.5 text-[0.7143rem] font-mono">
                    {f}
                    <button
                      type="button"
                      onClick={() => wt.onConfigFiles(wt.configFiles.filter((x) => x !== f))}
                      disabled={!wt.enabled}
                      className="text-muted-foreground/60 hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Stop copying ${f}`}
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
                {wt.configFiles.length === 0 && (
                  <span className="text-[0.7143rem] text-muted-foreground/60 italic">none — add .env or other config paths</span>
                )}
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (e.currentTarget.elements.namedItem('path') as HTMLInputElement);
                const v = input.value.trim();
                if (v && !wt.configFiles.includes(v)) wt.onConfigFiles([...wt.configFiles, v]);
                input.value = '';
              }}
              className="flex items-center gap-2 pl-[3.9rem]"
            >
              <input
                type="text"
                name="path"
                placeholder=".env.local, config/secrets.json…"
                disabled={!wt.enabled}
                className="flex-1 h-6 px-2 text-[0.7143rem] font-mono bg-input border border-input rounded-md outline-none focus:border-primary/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={!wt.enabled}
                className="text-[0.7143rem] text-muted-foreground/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + add
              </button>
            </form>
          </div>

          <div className="flex items-center gap-2 text-[0.7857rem]">
            <span className="w-14 text-muted-foreground/60 uppercase tracking-wider text-[0.7143rem] font-semibold">location</span>
            <code className="flex-1 text-[0.7143rem] font-mono text-muted-foreground/60 truncate">
              {`${(wt.worktreeLocation || '.agent/worktrees/').replace(/\/+$/, '')}/${wt.branchName || 'session'}`}
            </code>
            <Settings2
              className="size-3 text-muted-foreground/40 cursor-pointer hover:text-muted-foreground/80 flex-shrink-0"
              onClick={() => useUi.getState().setScreen('settings')}
            />
          </div>

          <div className="text-[0.7143rem] text-muted-foreground/60 pt-1 border-t border-border/60">
            Tool calls run inside the worktree — your main checkout stays clean.
            Branch + worktree are removed when the session is deleted.
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny pill toggle for the worktree on/off state. */
function WtToggle({ enabled, onClick }: { enabled: boolean; onClick: (v: boolean) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onClick(!enabled); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(!enabled);
        }
      }}
      className={cn(
        'inline-flex items-center h-4 w-7 rounded-full p-0.5 transition-colors cursor-pointer',
        enabled ? 'bg-primary' : 'bg-muted',
      )}
      aria-pressed={enabled}
      aria-label={enabled ? 'Disable worktree' : 'Enable worktree'}
    >
      <span className={cn('block size-3 rounded-full bg-background transition-transform', enabled ? 'translate-x-3' : 'translate-x-0')} />
    </span>
  );
}
