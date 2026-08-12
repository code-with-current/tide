import { useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronRight, Filter, RefreshCw } from 'lucide-react';
import { FileIcon, FolderIcon } from 'react-material-icon-theme';
import { useFileTree } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import type { FileNode } from '@/types';
import { cn } from '@/lib/utils';

/** Derive a language hint from the file extension (for the viewer). */
function langFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', md: 'markdown', json: 'json',
    css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sh: 'bash',
    svg: 'xml',
  };
  return (ext && map[ext]) || 'text';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && IMAGE_EXTS.has(ext);
}

/** Persistent expanded-folder state per workspace (localStorage-keyed, default all collapsed, survives restarts). */
function useExpandedFolders(workspaceId: string | null) {
  const storageKey = workspaceId ? `tide:fe:expanded:${workspaceId}` : null;

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  // Reload from storage when workspace changes.
  useEffect(() => {
    if (!storageKey) { setExpanded(new Set()); return; }
    try {
      const raw = localStorage.getItem(storageKey);
      setExpanded(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch {
      setExpanded(new Set());
    }
  }, [storageKey]);

  const toggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* quota */ }
      }
      return next;
    });
  }, [storageKey]);

  return { expanded, toggle };
}

export function FileExplorerTab() {
  const workspaceId = useUi((s) => s.activeWorkspaceId);
  const { data, isLoading, refetch, isFetching } = useFileTree(workspaceId);
  const [query, setQuery] = useState('');
  const { expanded, toggle } = useExpandedFolders(workspaceId);

  // Filter the tree — matching files + their ancestor directories are kept.
  const filtered = useMemo(() => {
    if (!data || !query.trim()) return data;
    const q = query.toLowerCase();
    const filterNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes
        .map(node => {
          if (node.kind === 'dir' && node.children) {
            const children = filterNodes(node.children);
            const matchesSelf = node.name.toLowerCase().includes(q);
            if (children.length > 0 || matchesSelf) {
              return { ...node, children };
            }
            return null;
          }
          return node.name.toLowerCase().includes(q) ? node : null;
        })
        .filter((n): n is FileNode => n !== null);
    };
    return filterNodes(data);
  }, [data, query]);

  const fileCount = useMemo(() => {
    if (!data) return 0;
    const count = (nodes: FileNode[]): number =>
      nodes.reduce((sum, n) => sum + (n.kind === 'dir' ? count(n.children ?? []) : 1), 0);
    return count(data);
  }, [data]);

  const isFiltering = !!query.trim();

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Search / filter bar — matches the VSCode section header style */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border flex-shrink-0">
        <ChevronRight className="size-3 text-muted-foreground rotate-90" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Files</span>
        {fileCount > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono">{fileCount}</span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          title="Refresh file tree"
          className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
        </button>
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-secondary">
          <Filter className="size-3 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="bg-transparent border-0 outline-none text-[11px] w-24 placeholder:text-muted-foreground text-foreground"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto scroll py-1 min-w-0 min-h-0 bg-background">
        {isLoading && (
          <div className="px-3 py-2 space-y-1.5">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-2 animate-pulse">
                <div className="w-3.5 h-3.5 rounded bg-secondary flex-shrink-0" />
                <div className="h-2.5 rounded bg-secondary" style={{ width: `${40 + (i % 3) * 20}%` }} />
              </div>
            ))}
          </div>
        )}
        {!isLoading && (!filtered || filtered.length === 0) && (
          <div className="flex flex-col items-center justify-center py-8 px-4 gap-1.5">
            <span className="text-[0.8rem] text-muted-foreground">
              {isFiltering ? 'No files match your filter.' : 'No files in this workspace.'}
            </span>
          </div>
        )}
        {filtered && filtered.length > 0 && (
          <Tree
            nodes={filtered}
            depth={0}
            expandedPaths={expanded}
            onToggle={toggle}
            isFiltering={isFiltering}
          />
        )}
      </div>
    </div>
  );
}

// ── Recursive tree ──

function Tree({
  nodes,
  depth,
  expandedPaths,
  onToggle,
  isFiltering,
}: {
  nodes: FileNode[];
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  isFiltering: boolean;
}) {
  // Sort: directories first (alphabetical), then files (alphabetical).
  const sorted = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <div className="space-y-0">
      {sorted.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={depth}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          isFiltering={isFiltering}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  isFiltering,
}: {
  node: FileNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  isFiltering: boolean;
}) {
  const sessionId = useUi((s) => s.activeSessionId);
  const openFile = useUi((s) => s.openFile);
  // Folder is open if: filtering (auto-expand), or its path is in the expanded set.
  const isOpen = isFiltering || expandedPaths.has(node.path);
  const pad = { paddingLeft: `${depth * 14 + 4}px` };

  if (node.kind === 'dir') {
    return (
      <div className="min-w-0">
        <span
          role="button"
          style={pad}
          onClick={() => onToggle(node.path)}
          className={cn(
            'w-full flex items-center gap-1 py-0.5 text-[0.85rem] hover:bg-secondary rounded-sm cursor-pointer transition-colors min-w-0',
          )}
        >
          <ChevronRight
            className={cn('size-3.5 flex-shrink-0 transition-transform text-muted-foreground', isOpen && 'rotate-90')}
          />
          <FolderIcon folderName={node.name} isOpen={isOpen} size={16} className="flex-shrink-0" />
          <span className={cn(
            'truncate text-muted-foreground',
            node.gitStatus === 'M' && 'text-primary',
            node.gitStatus === 'A' && 'text-success',
          )}>
            {node.name}
          </span>
          {node.gitStatus && <GitStatusDot status={node.gitStatus} />}
        </span>
        {isOpen && node.children && node.children.length > 0 && (
          <Tree
            nodes={node.children}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            isFiltering={isFiltering}
          />
        )}
      </div>
    );
  }

  // File node
  return (
    <span
      role="button"
      style={pad}
      onClick={() => {
        if (sessionId) {
          openFile(sessionId, { id: node.path, path: node.path, language: langFromName(node.name), isImage: isImageFile(node.name) });
        }
      }}
      className={cn(
        'w-full flex items-center gap-1 py-0.5 text-[0.8rem] hover:bg-secondary rounded-sm cursor-pointer transition-colors min-w-0',
      )}
    >
      <span className="w-3 flex-shrink-0" />
      <FileIcon fileName={node.name} size={14} className="flex-shrink-0" />
      <span className={cn(
        'truncate text-muted-foreground',
        node.gitStatus === 'M' && 'text-primary',
        node.gitStatus === 'A' && 'text-success',
        node.gitStatus === 'D' && 'text-destructive line-through',
      )}>
        {node.name}
      </span>
      {node.gitStatus && <GitStatusDot status={node.gitStatus} />}
    </span>
  );
}

// ── Git status indicator ──

function GitStatusDot({ status }: { status: 'M' | 'A' | 'D' }) {
  const color = status === 'M' ? 'bg-amber-400' : status === 'A' ? 'bg-emerald-400' : 'bg-rose-400';
  return (
    <span className={cn('ml-auto flex-shrink-0 w-1.5 h-1.5 rounded-full', color)} title={`Git: ${status}`} />
  );
}
