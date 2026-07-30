import { useState, useMemo, useCallback } from 'react';
import { RefreshCw, ChevronRight, CheckCircle2, List, ListTree } from 'lucide-react';
import { FolderIcon } from 'react-material-icon-theme';
import { useGitStatus, useGitStage, useGitCommit, useSession } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { cn } from '@/lib/utils';
import { ChangedFileRow } from './ChangedFileRow';
import { CommitBar } from './CommitBar';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import type { DiffHunk } from '@/types';
import { Button } from '@/components/ui/button';

type ViewMode = 'list' | 'tree';

// ── Recursive tree node ──

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
  file?: GitFileChange;
}

/** Build a recursive directory tree from flat file paths.
 *  `src/components/chat/Composer.tsx` → src → components → chat → Composer.tsx */
function buildFileTree(files: GitFileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const childPath = node.path ? `${node.path}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: childPath,
          isDir: !isLeaf,
          children: new Map(),
          file: isLeaf ? file : undefined,
        });
      }
      node = node.children.get(part)!;
    }
  }
  return root;
}

/** Count total files under a node (recursively). */
function countFiles(node: TreeNode): number {
  if (!node.isDir) return 1;
  let count = 0;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

// ── Component ──

export function SourceControlPanel() {
  const workspaceId = useUi(s => s.activeWorkspaceId);
  const sessionId = useUi(s => s.activeSessionId);
  const openFile = useUi(s => s.openFile);
  // Only pass sessionId to git queries when the session has a worktree —
  // two non-worktree sessions in the same workspace share the same git
  // state and should share the same cache entry (no redundant refetch).
  const { data: activeSession } = useSession(sessionId);
  const gitSessionId = activeSession?.worktree ? sessionId : undefined;
  const { data: changes, isLoading, isFetching, refetch } = useGitStatus(workspaceId, gitSessionId);
  const stageMutation = useGitStage(workspaceId ?? '', gitSessionId);
  const commitMutation = useGitCommit(workspaceId ?? '', gitSessionId);

  const viewMode = useTabs(s => s.scViewMode[sessionId ?? 'default'] ?? 'list') as ViewMode;
  const setViewMode = useCallback((mode: ViewMode) => useTabs.getState().setScViewMode(sessionId ?? 'default', mode), [sessionId]);
  const [selectedFile] = useState<GitFileChange | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  // Track CLOSED dirs (inverted — default empty = all open). Using a Set
  // of closed paths avoids initializing with every possible dir open.
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());

  const staged = changes?.filter(c => c.staged) ?? [];
  const unstaged = changes?.filter(c => !c.staged) ?? [];

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
              className="w-full flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground/60 transition-colors cursor-pointer min-w-0 rounded-md hover:bg-secondary/40"
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
            >
              <ChevronRight className={cn('size-3 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
              <FolderIcon folderName={child.name} isOpen={isOpen} size={14} className="flex-shrink-0" />
              <span className="truncate">{child.name}</span>
              <span className="text-muted-foreground/60/40 flex-shrink-0 text-[10px]">{fileCount}</span>
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

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <PanelHeader fetching={isFetching} onRefresh={() => refetch()} viewMode={viewMode} onViewModeChange={setViewMode} />
        <div className="flex-1 px-3 py-2 space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-2 py-1 animate-pulse">
              <div className="w-3.5 h-3.5 rounded bg-secondary" />
              <div className="flex-1 h-3 rounded bg-secondary" style={{ width: `${60 + i * 10}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── No workspace ──
  if (!workspaceId) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <PanelHeader fetching={false} onRefresh={() => {}} viewMode={viewMode} onViewModeChange={setViewMode} />
        <div className="flex-1 flex items-center justify-center px-4">
          <span className="text-xs text-muted-foreground">No workspace selected.</span>
        </div>
      </div>
    );
  }

  // ── Clean tree ──
  if (changes?.length === 0) {
    return (
      <div className="flex flex-col h-full min-w-0">
        <PanelHeader fetching={isFetching} onRefresh={() => refetch()} viewMode={viewMode} onViewModeChange={setViewMode} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
          <CheckCircle2 className="size-6 text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground text-center">
            Working tree is clean.<br />No changes to review.
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => refetch()} className="text-[11px] text-muted-foreground flex items-center gap-1">
            <RefreshCw className="size-3" /> Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <PanelHeader fetching={isFetching} onRefresh={() => refetch()} viewMode={viewMode} onViewModeChange={setViewMode} />

      <div className="px-3 py-2 border-b border-border flex-shrink-0">
        <CommitBar stagedCount={staged.length} onCommit={handleCommit} disabled={commitMutation.isPending} />
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto scroll">
        {staged.length > 0 && (
          <CollapsibleSection label="Staged" count={staged.length} open={stagedOpen} onToggle={() => setStagedOpen(o => !o)}>
            {viewMode === 'tree' && stagedTree
              ? renderTreeNodes(stagedTree, 0, 'staged')
              : renderFiles(staged)}
          </CollapsibleSection>
        )}
        {unstaged.length > 0 && (
          <CollapsibleSection label="Changes" count={unstaged.length} open={changesOpen} onToggle={() => setChangesOpen(o => !o)}>
            {viewMode === 'tree' && unstagedTree
              ? renderTreeNodes(unstagedTree, 0, 'unstaged')
              : renderFiles(unstaged)}
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function PanelHeader({
  fetching, onRefresh, viewMode, onViewModeChange,
}: {
  fetching: boolean;
  onRefresh: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border flex-shrink-0">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source Control</span>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost" size="icon-xs"
          onClick={() => onViewModeChange(viewMode === 'list' ? 'tree' : 'list')}
          aria-label={viewMode === 'list' ? 'Switch to tree view' : 'Switch to list view'}
          title={viewMode === 'list' ? 'Tree view' : 'List view'}
        >
          {viewMode === 'list' ? <ListTree className="size-3" /> : <List className="size-3" />}
        </Button>
        <Button
          variant="ghost" size="icon-xs"
          onClick={onRefresh}
          aria-label="Refresh git status"
        >
          <RefreshCw className={cn('size-3 transition-transform', fetching && 'animate-spin')} />
        </Button>
      </div>
    </div>
  );
}

function CollapsibleSection({
  label, count, open, onToggle, children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {label}
        <span className="font-normal normal-case tracking-normal">{count}</span>
      </button>
      {open && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );
}
