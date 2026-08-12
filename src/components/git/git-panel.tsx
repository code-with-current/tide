import { useState, useMemo, useCallback } from 'react';
import { RefreshCw, ChevronRight, CheckCircle2, List, ListTree, RotateCcw, Archive, ArchiveRestore, Eye, MinusCircle, PlusCircle, Diff, GitBranch } from 'lucide-react';
import { FolderIcon } from 'react-material-icon-theme';
import { useGitStatus, useGitLog, useGitStage, useGitCommit, useGitBulk, useGitStashList, useSession, useGitBranchInfo } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { cn } from '@/lib/utils';
import { ChangedFileRow } from './changed-file-row';
import { CommitBar } from './commit-bar';
import { TabButton } from './tab-button';
import { CommitRow } from './commit-row';
import { CollapsibleSection } from './collapsible-section';
import { buildFileTree, countFiles, type TreeNode } from './file-tree';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import type { DiffHunk } from '@/types';
import { Button } from '@/components/ui/button';
import { SplitButton } from '@/components/ui/split-button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type ViewMode = 'list' | 'tree';

// ── Component ──

export function GitPanel() {
  const workspaceId = useUi(s => s.activeWorkspaceId);
  const sessionId = useUi(s => s.activeSessionId);
  const openFile = useUi(s => s.openFile);
  const commitDetail = useUi(s => s.commitDetail);
  const setCommitDetail = useUi(s => s.setCommitDetail);
  // Only pass sessionId to git queries when the session has a worktree —
  // two non-worktree sessions in the same workspace share the same git
  // state and should share the same cache entry (no redundant refetch).
  const { data: activeSession } = useSession(sessionId);
  const gitSessionId = activeSession?.worktree ? sessionId : undefined;
  const { data: changes, isLoading, isFetching, refetch } = useGitStatus(workspaceId, gitSessionId);
  // Live branch (reflects mid-session checkouts). Falls back to the persisted
  // worktree branch until the first fetch resolves.
  const { data: gitBranchInfo } = useGitBranchInfo(workspaceId, gitSessionId);
  const branch = gitBranchInfo?.branch ?? activeSession?.worktree?.branch;
  const stageMutation = useGitStage(workspaceId ?? '', gitSessionId);
  const commitMutation = useGitCommit(workspaceId ?? '', gitSessionId);
  const { data: history, isLoading: historyLoading, isFetching: historyFetching, refetch: refetchHistory } = useGitLog(workspaceId, gitSessionId);
  const bulk = useGitBulk(workspaceId, gitSessionId);
  const stashQ = useGitStashList(workspaceId, gitSessionId);

  const viewMode = useTabs(s => s.gpViewMode[sessionId ?? 'default'] ?? 'tree') as ViewMode;
  const setViewMode = useCallback((mode: ViewMode) => useTabs.getState().setGpViewMode(sessionId ?? 'default', mode), [sessionId]);
  const [selectedFile] = useState<GitFileChange | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [viewStash, setViewStash] = useState(false);
  // Track CLOSED dirs (inverted — default empty = all open). Using a Set
  // of closed paths avoids initializing with every possible dir open.
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());

  const staged = changes?.filter(c => c.staged) ?? [];
  const unstaged = changes?.filter(c => !c.staged) ?? [];

  // Total +/- across all changes (staged + unstaged) for the summary line.
  const { totalAdd, totalDel } = useMemo(() => {
    let a = 0, d = 0;
    for (const c of changes ?? []) { a += c.additions ?? 0; d += c.deletions ?? 0; }
    return { totalAdd: a, totalDel: d };
  }, [changes]);

  const stagedTree = useMemo(() => viewMode === 'tree' ? buildFileTree(staged) : null, [staged, viewMode]);
  const unstagedTree = useMemo(() => viewMode === 'tree' ? buildFileTree(unstaged) : null, [unstaged, viewMode]);

  const toggleDir = useCallback((path: string) => {
    setClosedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  // Click a changed file → fetch diff hunks and open in the file viewer
  // (z-index: 2 overlay). The diff renders inside the viewer via DiffView,
  // replacing the separate DiffDialog.
  const handleFileClick = async (change: GitFileChange) => {
    if (!sessionId) return;
    let hunks: DiffHunk[] = [];
    if (workspaceId) {
      try {
        hunks = await api.gitDiff(workspaceId, change.path, change.staged, gitSessionId ?? undefined);
      } catch { /* show file content without diff */ }
    }
    openFile(sessionId, {
      id: change.path,
      path: change.path,
      language: change.path.split('.').pop() ?? 'text',
      diffHunks: hunks.length > 0 ? hunks : undefined,
    });
  };

  const toggleStage = (change: GitFileChange) => {
    stageMutation.mutate({ path: change.path, stage: !change.staged });
  };

  const handleCommit = (message: string) => {
    commitMutation.mutate(message);
  };

  const renderFiles = (files: GitFileChange[]) =>
    files.map(c => (
      <ChangedFileRow
        key={c.path}
        change={c}
        active={selectedFile?.path === c.path}
        onClick={() => handleFileClick(c)}
        onToggleStage={() => toggleStage(c)}
      />
    ));

  // Recursive tree renderer — handles real directory depth.
  const renderTreeNodes = useCallback((node: TreeNode, depth: number, sectionKey: string): React.ReactNode[] => {
    const sorted = [...node.children.values()].sort((a, b) => {
      // Directories first, then files alphabetically
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.flatMap(child => {
      if (child.isDir) {
        const dirKey = `${sectionKey}:${child.path}`;
        const isOpen = !closedDirs.has(dirKey);
        const fileCount = countFiles(child);
        return [
          <div key={dirKey}>
            <span
              role="button"
              onClick={() => toggleDir(dirKey)}
              className="w-full flex items-center gap-1 py-0.5 text-[0.85rem] text-muted-foreground/60 transition-colors cursor-pointer min-w-0 rounded-md hover:bg-secondary/40"
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
            >
              <ChevronRight className={cn('size-3.5 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
              <FolderIcon folderName={child.name} isOpen={isOpen} size={16} className="flex-shrink-0" />
              <span className="truncate">{child.name}</span>
              <span className="text-muted-foreground/60/40 flex-shrink-0 text-[0.75rem]">{fileCount}</span>
            </span>
            {isOpen && renderTreeNodes(child, depth + 1, sectionKey)}
          </div>,
        ];
      }
      // Leaf file node — indent by depth
      return [
        <div key={child.path} style={{ paddingLeft: `${depth * 14}px` }}>
          <ChangedFileRow
            change={child.file!}
            showPath={false}
            active={selectedFile?.path === child.path}
            onClick={() => handleFileClick(child.file!)}
            onToggleStage={() => toggleStage(child.file!)}
          />
        </div>,
      ];
    });
  }, [closedDirs, toggleDir, selectedFile]);

  const changesCount = changes?.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-background">
      {/* Branch strip — the live checked-out branch for this session's
          working directory. Updates instantly when the agent checks out a
          branch (via the git-tool/bash invalidation in MainScreen). */}
      {branch && (
        <div className="flex items-center gap-1.5 px-2 py-1 flex-shrink-0 border-b border-border text-muted-foreground">
          <GitBranch className="size-3 flex-shrink-0" />
          <span className="font-mono text-[11px] truncate">{branch}</span>
          {activeSession?.worktree && (
            <span className="ml-auto text-[9px] uppercase tracking-wide opacity-70">worktree</span>
          )}
        </div>
      )}
      {/* Square, full-width tab bar */}
      <div className="flex flex-shrink-0 border-border">
        <TabButton active={tab === 'changes'} onClick={() => setTab('changes')}>
          Changes{changesCount > 0 ? ` (${changesCount})` : ''}
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History</TabButton>
      </div>

      {tab === 'changes' ? (
        <>
          { changesCount === 0 ? null : <div className="flex items-center gap-1.5 px-2 py-1.5 flex-shrink-0 bg-card">
            {/* Changes summary */}
            {<span className="text-[11px] flex gap-1 items-center font-mono tabular-nums whitespace-nowrap">
              <Diff className="size-3" />
              <span>Diff</span>
              <span className="text-emerald-400">+{totalAdd}</span>
              <span className="text-red-400">−{totalDel}</span>
            </span>}
            <div className="flex-1" />
            {/* Stage All + bulk working-tree actions */}

            <Button variant="ghost" size="icon-xs"
              onClick={() => setViewMode(viewMode === 'list' ? 'tree' : 'list')}
              aria-label={viewMode === 'list' ? 'Tree view' : 'List view'}
              title={viewMode === 'list' ? 'Tree view' : 'List view'}
            >
              {viewMode === 'list' ? <ListTree className="size-3" /> : <List className="size-3" />}
            </Button>
            <Button variant="ghost" size="icon-xs" onClick={() => refetch()} aria-label="Refresh git status" title="Refresh">
              <RefreshCw className={cn('size-3 transition-transform', isFetching && 'animate-spin')} />
            </Button>
            <SplitButton
              label="Stage All"
              size="xs"
              disabled={bulk.isPending}
              onPrimary={() => bulk.mutate('stage-all')}
              toggleAriaLabel="More git actions"
              items={[
                { label: 'Stage All', icon: <PlusCircle className='size-3.5' />, onSelect: () => bulk.mutate('stage-all') },
                { label: 'Unstage All', icon: <MinusCircle className='size-3.5' />, onSelect: () => bulk.mutate('unstage-all') },
                { label: 'Discard Changes', hint: 'Discard every uncommitted change', icon: <RotateCcw className='size-3.5' />, onSelect: () => setConfirmRestore(true) },
                { label: 'Separator' },
                { label: 'Stash All', icon: <Archive className='size-3.5' />, onSelect: () => bulk.mutate('stash') },
                { label: 'Stash Pop', icon: <ArchiveRestore className='size-3.5' />, disabled: (stashQ.data?.length ?? 0) === 0, onSelect: () => bulk.mutate('stash-pop') },
                { label: 'View Stash', icon: <Eye className='size-3.5' />, onSelect: () => setViewStash(true) },
              ]}
            />
          </div>}
          {/* CommitBar pinned to the bottom of the Changes tab */}
          {workspaceId && changesCount > 0 && (
            <div className="flex-shrink-0 px-3 bg-card">
              <CommitBar stagedCount={staged.length} onCommit={handleCommit} disabled={commitMutation.isPending} />
            </div>
          )}
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto scroll">
            {isLoading ? (
              <div className="px-3 py-2 space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 animate-pulse">
                    <div className="w-3.5 h-3.5 rounded bg-secondary" />
                    <div className="h-3 rounded bg-secondary" style={{ width: `${60 + i * 10}%` }} />
                  </div>
                ))}
              </div>
            ) : !workspaceId ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No workspace selected.</span>
              </div>
            ) : changesCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 h-full px-4">
                <CheckCircle2 className="size-6 text-muted-foreground/40" />
                <span className="text-xs text-muted-foreground text-center">
                  Working tree is clean.<br />No changes to review.
                </span>
              </div>
            ) : (
              <>
                {staged.length > 0 && (
                  <CollapsibleSection label="Staged" count={staged.length} open={stagedOpen} onToggle={() => setStagedOpen(o => !o)}>
                    {viewMode === 'tree' && stagedTree ? renderTreeNodes(stagedTree, 0, 'staged') : renderFiles(staged)}
                  </CollapsibleSection>
                )}
                {unstaged.length > 0 && (
                  <CollapsibleSection label="Changes" count={unstaged.length} open={changesOpen} onToggle={() => setChangesOpen(o => !o)}>
                    {viewMode === 'tree' && unstagedTree ? renderTreeNodes(unstagedTree, 0, 'unstaged') : renderFiles(unstaged)}
                  </CollapsibleSection>
                )}
              </>
            )}
          </div>


        </>
      ) : (
        <>
          <div className="flex items-center gap-0.5 px-2 py-1 flex-shrink-0">
            <span className="text-[11px] text-muted-foreground/50 px-1">{history?.length ?? 0} commits</span>
            <div className="flex-1" />
            <Button variant="ghost" size="icon-xs" onClick={() => refetchHistory()} aria-label="Refresh history" title="Refresh">
              <RefreshCw className={cn('size-3 transition-transform', historyFetching && 'animate-spin')} />
            </Button>
          </div>
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto scroll">
            {historyLoading ? (
              <div className="px-3 py-2 space-y-3">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="space-y-1 animate-pulse">
                    <div className="h-2.5 rounded bg-secondary" style={{ width: `${50 + i * 8}%` }} />
                    <div className="h-2 w-20 rounded bg-secondary" />
                  </div>
                ))}
              </div>
            ) : !workspaceId ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No workspace selected.</span>
              </div>
            ) : (history?.length ?? 0) === 0 ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No commits yet.</span>
              </div>
            ) : (
              history?.map((c, i) => (
                <CommitRow
                  key={c.sha}
                  commit={c}
                  isLast={i === (history?.length ?? 0) - 1}
                  active={c.sha === commitDetail?.sha}
                  onSelect={() => setCommitDetail(c)}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Restore-all confirmation */}
      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore all changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This discards ALL uncommitted changes — staged and unstaged — and removes untracked files. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { bulk.mutate('restore-all'); setConfirmRestore(false); }}
            >
              Restore All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View stash */}
      <Dialog open={viewStash} onOpenChange={setViewStash}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stashes</DialogTitle>
            <DialogDescription>{stashQ.data?.length ?? 0} stash{(stashQ.data?.length ?? 0) === 1 ? '' : 'es'} — newest first. “Pop” applies + drops the top stash.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto scroll -mx-1">
            {(stashQ.data?.length ?? 0) === 0 ? (
              <div className="text-xs text-muted-foreground px-1 py-8 text-center">No stashes.</div>
            ) : stashQ.data!.map((s) => (
              <div key={s.ref} className="flex items-center gap-2 px-1 py-1.5 border-b border-border/50 last:border-0">
                <span className="font-mono text-[0.7rem] text-primary/80 flex-shrink-0">{s.ref}</span>
                <span className="text-[0.78rem] truncate flex-1">{s.message || '(no message)'}</span>
                <Button
                  variant="ghost" size="xs"
                  onClick={() => { bulk.mutate('stash-pop'); setViewStash(false); }}
                >
                  Pop
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
