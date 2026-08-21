import { useState, useMemo, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw, ChevronRight, CheckCircle2, List, ListTree, RotateCcw, Archive, ArchiveRestore, Eye, MinusCircle, PlusCircle, Diff, GitBranch, AlertTriangle } from 'lucide-react';
import { FolderIcon } from 'react-material-icon-theme';
import { SkeletonBar, CircleSkeleton } from '@/components/ui/loading-rows';
import { useGitStatus, useGitLog, useGitStage, useGitCommit, useGitBulk, useGitStashList, useSession, useGitBranchInfo, useGitAmend, useConflictFiles, useGitResolveFile, useGitDiscardFile, useGitRevert, useGitCreateBranch } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { cn } from '@/lib/utils';
import { toastError, toastSuccess } from '@/lib/toast';
import { ChangedFileRow } from './changed-file-row';
import { CommitBar } from './commit-bar';
import { TabButton } from './tab-button';
import { CommitRow } from './commit-row';
import { GraphColumn, ROW_H } from './commit-graph';
import { assignLanes } from '@/lib/git/lanes';
import { CollapsibleSection } from './collapsible-section';
import { buildFileTree, countFiles, type TreeNode } from './file-tree';
import { BranchMenu, BranchBadges } from '@/components/git/branch-menu';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import type { DiffHunk } from '@/types';
import { Button } from '@/components/ui/button';
import { SplitButton } from '@/components/ui/split-button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type ViewMode = 'list' | 'tree';

const NO_CONFLICTS: api.GitConflictEntry[] = [];

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
  const amendMutation = useGitAmend(workspaceId ?? '', gitSessionId);
  const discardMutation = useGitDiscardFile(workspaceId ?? '', gitSessionId);
  const resolveMutation = useGitResolveFile(workspaceId ?? '', gitSessionId);
  const conflictQ = useConflictFiles(workspaceId, gitSessionId);
  const conflicts = conflictQ.data ?? NO_CONFLICTS;
  const hasConflicts = conflicts.length > 0;
  const { data: history, isLoading: historyLoading, isFetching: historyFetching, refetch: refetchHistory } = useGitLog(workspaceId, gitSessionId, 500);
  const bulk = useGitBulk(workspaceId, gitSessionId);
  const stashQ = useGitStashList(workspaceId, gitSessionId);

  // History: lane layout + virtualization (fixed 24px rows) so 500-commit
  // logs scroll smoothly. The graph is one tall svg behind the rows, so
  // virtualization never slices an edge mid-curve.
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const revertMutation = useGitRevert(workspaceId ?? '', gitSessionId);
  const createBranchMutation = useGitCreateBranch(workspaceId ?? '', gitSessionId);
  const laidHistory = useMemo(
    () => assignLanes((history ?? []).map((c) => ({ sha: c.sha, parents: c.parents ?? [], isHead: c.isHead, branchHeads: c.branchHeads }))),
    [history],
  );
  const historyVirtualizer = useVirtualizer({
    count: laidHistory.length,
    getScrollElement: () => historyScrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => laidHistory[i].commit.sha,
  });
  const handleRevertCommit = useCallback((sha: string) => {
    revertMutation.mutate(sha, {
      onSuccess: (res) => {
        if (res?.ok) toastSuccess('Reverted commit');
        else toastError('Revert failed', { description: res?.error });
      },
      onError: () => toastError('Revert failed'),
    });
  }, [revertMutation]);
  const handleBranchFrom = useCallback((name: string, sha: string) => {
    createBranchMutation.mutate({ name, sha }, {
      onSuccess: (res) => {
        if (res?.ok) toastSuccess(`Switched to ${name}`);
        else toastError('Branch failed', { description: res?.error });
      },
      onError: () => toastError('Branch failed'),
    });
  }, [createBranchMutation]);

  const viewMode = useTabs(s => s.gpViewMode[sessionId ?? 'default'] ?? 'tree') as ViewMode;
  const setViewMode = useCallback((mode: ViewMode) => useTabs.getState().setGpViewMode(sessionId ?? 'default', mode), [sessionId]);
  const [selectedFile] = useState<GitFileChange | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<GitFileChange | null>(null);
  const [viewStash, setViewStash] = useState(false);
  // Track CLOSED dirs (inverted — default empty = all open). Using a Set
  // of closed paths avoids initializing with every possible dir open.
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());

  // Conflict paths are owned by the resolve band — keep them out of the
  // staged/unstaged lists so they don't render twice.
  const conflictPaths = useMemo(() => new Set(conflicts.map(c => c.path)), [conflicts]);
  const staged = useMemo(
    () => (changes ?? []).filter(c => c.staged && !conflictPaths.has(c.path)),
    [changes, conflictPaths],
  );
  const unstaged = useMemo(
    () => (changes ?? []).filter(c => !c.staged && !conflictPaths.has(c.path)),
    [changes, conflictPaths],
  );

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
      // Recorded so the viewer can refetch at wider context on expand.
      diffSource: hunks.length > 0
        ? { staged: change.staged, sessionId: gitSessionId ?? undefined, contextLines: 3 }
        : undefined,
    });
  };

  const toggleStage = (change: GitFileChange) => {
    stageMutation.mutate({ path: change.path, stage: !change.staged });
  };

  const handleDiscard = (change: GitFileChange) => {
    discardMutation.mutate(change.path, {
      onSuccess: (res) => {
        if (res.ok) toastSuccess('Discarded');
        else toastError('Discard failed', { description: res.error });
      },
      onError: () => toastError('Discard failed'),
    });
    setConfirmDiscard(null);
  };

  const handleResolve = (path: string, side: 'ours' | 'theirs') => {
    resolveMutation.mutate({ filePath: path, side }, {
      onSuccess: (res) => {
        if (res.ok) toastSuccess(`Resolved with ${side === 'ours' ? 'our side' : 'their side'}`);
        else toastError('Resolve failed', { description: res.error });
      },
      onError: () => toastError('Resolve failed'),
    });
  };

  const handleCommit = (message: string) => commitMutation.mutateAsync(message)
    .then(res => res ?? { ok: false, error: 'no workspace' });
  const handleAmend = (message: string) => amendMutation.mutateAsync(message)
    .then(res => res ?? { ok: false, error: 'no workspace' });
  const handleStageAll = async () => {
    await bulk.mutateAsync('stage-all');
  };

  const renderFiles = (files: GitFileChange[], section: 'staged' | 'unstaged') =>
    files.map(c => (
      <ChangedFileRow
        key={c.path}
        change={c}
        active={selectedFile?.path === c.path}
        onClick={() => handleFileClick(c)}
        onToggleStage={() => toggleStage(c)}
        onDiscard={section === 'unstaged' ? () => setConfirmDiscard(c) : undefined}
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
            onDiscard={sectionKey === 'unstaged' ? () => setConfirmDiscard(child.file!) : undefined}
          />
        </div>,
      ];
    });
  }, [closedDirs, toggleDir, selectedFile]);

  const changesCount = changes?.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-background">
      {/* Branch toolbar — BranchMenu popover + ahead/behind badges + stash.
          Replaces the old plain branch strip at the top of the Changes
          sub-section. */}
      {branch && (
        <div className="flex items-center gap-1.5 px-2 py-1 flex-shrink-0 border-b border-border text-muted-foreground min-w-0">
          <BranchMenu
            trigger={
              <button
                type="button"
                className="flex items-center gap-1.5 h-6 px-1.5 rounded-md text-[11px] hover:bg-secondary/60 transition-colors min-w-0"
                title="Switch branch"
              >
                <GitBranch className="size-3 flex-shrink-0" />
                <span className="font-mono truncate">{branch}</span>
                <ChevronRight className="size-3 flex-shrink-0 rotate-90 opacity-50" />
              </button>
            }
          />
          <BranchBadges />
          {activeSession?.worktree && (
            <span className="text-[9px] uppercase tracking-wide opacity-70">worktree</span>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost" size="icon-xs"
            disabled={bulk.isPending || changesCount === 0}
            onClick={() => bulk.mutate('stash')}
            aria-label="Stash all changes" title="Stash All"
          >
            <Archive className="size-3" />
          </Button>
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
          {workspaceId && (changesCount > 0 || hasConflicts) && (
            <div className="flex-shrink-0 px-3 bg-card">
              <CommitBar
                workspaceId={workspaceId}
                gitSessionId={gitSessionId}
                sessionId={sessionId}
                staged={staged}
                hasConflicts={hasConflicts}
                hasChanges={changesCount > 0}
                onCommit={handleCommit}
                onAmend={handleAmend}
                onStageAll={handleStageAll}
                disabled={commitMutation.isPending || amendMutation.isPending}
              />
            </div>
          )}
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto scroll">
            {isLoading ? (
              <div className="px-3 py-2 space-y-2" aria-hidden>
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <SkeletonBar className="size-3.5 shrink-0 rounded-[3px]" />
                    <SkeletonBar className="h-3.5 w-3.5 shrink-0 rounded-[3px]" />
                    <SkeletonBar className="h-3" style={{ width: `${60 + i * 10}%` }} />
                    <span className="flex-1" />
                    <SkeletonBar className="h-2 w-6 shrink-0" />
                  </div>
                ))}
              </div>
            ) : !workspaceId ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No workspace selected.</span>
              </div>
            ) : changesCount === 0 && !hasConflicts ? (
              <div className="flex flex-col items-center justify-center gap-3 h-full px-4">
                <CheckCircle2 className="size-6 text-muted-foreground/40" />
                <span className="text-xs text-muted-foreground text-center">
                  Working tree is clean.<br />No changes to review.
                </span>
              </div>
            ) : (
              <>
                {/* Conflict band — pinned above Staged/Unstaged; presence
                    disables the commit bar (explained inline there). */}
                {hasConflicts && (
                  <div className="sticky top-0 z-10 bg-destructive/5 border-b border-destructive/30">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[0.8rem] font-semibold text-destructive">
                      <AlertTriangle className="size-3.5 flex-shrink-0" />
                      Resolve conflicts — {conflicts.length} file{conflicts.length === 1 ? '' : 's'}
                    </div>
                    {conflicts.map((c) => (
                      <div
                        key={c.path}
                        className="flex items-center gap-1.5 px-3 py-1 text-[0.78rem] min-w-0 hover:bg-destructive/10 transition-colors"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={c.path}>{c.path}</span>
                        <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {c.state.replaceAll('-', ' ')}
                        </span>
                        <Button
                          variant="outline" size="xs"
                          className="h-5 px-1.5 text-[10px]"
                          disabled={resolveMutation.isPending}
                          onClick={() => handleResolve(c.path, 'ours')}
                        >
                          Use ours
                        </Button>
                        <Button
                          variant="outline" size="xs"
                          className="h-5 px-1.5 text-[10px]"
                          disabled={resolveMutation.isPending}
                          onClick={() => handleResolve(c.path, 'theirs')}
                        >
                          Use theirs
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {staged.length > 0 && (
                  <CollapsibleSection
                    label="Staged"
                    count={staged.length}
                    open={stagedOpen}
                    onToggle={() => setStagedOpen(o => !o)}
                    actions={
                      <Button
                        variant="ghost" size="icon-xs"
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate('unstage-all')}
                        aria-label="Unstage all" title="Unstage All"
                      >
                        <MinusCircle className="size-3" />
                      </Button>
                    }
                  >
                    {viewMode === 'tree' && stagedTree ? renderTreeNodes(stagedTree, 0, 'staged') : renderFiles(staged, 'staged')}
                  </CollapsibleSection>
                )}
                {unstaged.length > 0 && (
                  <CollapsibleSection
                    label="Changes"
                    count={unstaged.length}
                    open={changesOpen}
                    onToggle={() => setChangesOpen(o => !o)}
                    actions={
                      <>
                        <Button
                          variant="ghost" size="icon-xs"
                          disabled={bulk.isPending}
                          onClick={() => setConfirmRestore(true)}
                          aria-label="Discard all changes" title="Discard All"
                        >
                          <RotateCcw className="size-3" />
                        </Button>
                        <Button
                          variant="ghost" size="icon-xs"
                          disabled={bulk.isPending}
                          onClick={() => bulk.mutate('stage-all')}
                          aria-label="Stage all" title="Stage All"
                        >
                          <PlusCircle className="size-3" />
                        </Button>
                      </>
                    }
                  >
                    {viewMode === 'tree' && unstagedTree ? renderTreeNodes(unstagedTree, 0, 'unstaged') : renderFiles(unstaged, 'unstaged')}
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
          <div ref={historyScrollRef} className="relative flex-1 min-h-0 min-w-0 overflow-y-auto scroll">
            {historyLoading ? (
              <div className="px-3 py-2 space-y-3" aria-hidden>
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="flex items-center gap-2 space-y-1">
                    <CircleSkeleton className="size-2.5 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <SkeletonBar className="h-2.5" style={{ width: `${50 + i * 8}%` }} />
                      <SkeletonBar className="h-2 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !workspaceId ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No workspace selected.</span>
              </div>
            ) : laidHistory.length === 0 ? (
              <div className="flex items-center justify-center h-full px-4">
                <span className="text-xs text-muted-foreground">No commits yet.</span>
              </div>
            ) : (
              <div className="relative" style={{ height: historyVirtualizer.getTotalSize() }}>
                <GraphColumn commits={laidHistory} height={historyVirtualizer.getTotalSize()} />
                {historyVirtualizer.getVirtualItems().map((row) => {
                  const commit = history![row.index];
                  return (
                    <div
                      key={commit.sha}
                      className="absolute left-0 top-0 w-full"
                      style={{ height: ROW_H, transform: `translateY(${row.start}px)` }}
                    >
                      <CommitRow
                        commit={commit}
                        active={commit.sha === commitDetail?.sha}
                        pendingAction={revertMutation.isPending || createBranchMutation.isPending}
                        onSelect={() => setCommitDetail(commit)}
                        onRevert={handleRevertCommit}
                        onBranch={handleBranchFrom}
                      />
                    </div>
                  );
                })}
              </div>
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

      {/* Discard-one-file confirmation */}
      <AlertDialog open={!!confirmDiscard} onOpenChange={(open) => { if (!open) setConfirmDiscard(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes in this file?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <span className="block font-mono text-xs mb-1 break-all">{confirmDiscard?.path}</span>
                Working-tree changes (including untracked content) are reverted and cannot be undone. Staged content is kept.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (confirmDiscard) handleDiscard(confirmDiscard); }}
            >
              Discard
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
