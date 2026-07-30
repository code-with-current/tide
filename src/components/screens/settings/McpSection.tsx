import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plug, Plus, Download, ExternalLink, Globe, FolderGit2, ChevronLeft, ChevronRight } from 'lucide-react';
import { SettingsHeader, Card } from './shared';
import { McpServerRow, type McpStatusValue } from './McpServerRow';
import {
  McpServerDialog,
  type McpConfig,
  type McpScope,
} from './McpServerDialog';
import { McpImportDialog } from './McpImportDialog';
import { useWorkspaces } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';

/**
 * Settings → Extensions → MCP.
 *
 * Lists every configured MCP server across the two scopes (global ~/.tide/mcp.json
 * and the active workspace's .mcp.json), with live status pulled from the agent
 * pool. Status updates arrive via the `onMcpStatusChanged` IPC event, which we
 * turn into a `refresh()` call.
 *
 * Note on the IPC surface: the preload bridge exposes `onMcpStatusChanged(cb)`
 * returning void and a separate `removeAllMcpListeners()` — there is no
 * per-subscription unsubscribe handle, so cleanup calls the bulk remover.
 */

/** Shape of one row returned by window.tideIpc.mcpList(). */
interface McpStatus {
  name: string;
  scope: McpScope;
  config: McpConfig;
  status: McpStatusValue;
  toolCount: number;
  error?: string;
  transport: 'stdio' | 'sse' | 'http';
  enabled: boolean;
}

/** The server currently being edited (null when adding). */
interface EditingServer {
  name: string;
  scope: McpScope;
  config: McpConfig;
}

export function McpSection() {
  const workspacesQuery = useWorkspaces();
  const workspaces = workspacesQuery.data ?? [];
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const workspaceRoot = ws?.path ?? '';

  const [servers, setServers] = useState<McpStatus[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<EditingServer | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importBadge, setImportBadge] = useState(0);

  // Scan for importable servers on mount + workspace change
  useEffect(() => {
    window.tideIpc?.mcpScan().then((result) => {
      setImportBadge(result.servers.filter((s) => !result.alreadyImported.includes(s.name)).length);
    }).catch(() => setImportBadge(0));
  }, []);

  const refresh = useCallback(async () => {
    const result = await window.tideIpc?.mcpList(activeWorkspaceId ?? undefined);
    if (result) setServers(result);
  }, [activeWorkspaceId]);

  useEffect(() => {
    refresh();
    const cb = () => {
      void refresh();
    };
    window.tideIpc?.onMcpStatusChanged(cb);
    return () => {
      window.tideIpc?.removeAllMcpListeners();
    };
  }, [refresh]);

  // Re-fetch when the active workspace changes (the project-scoped list shifts).
  useEffect(() => {
    void refresh();
  }, [activeWorkspaceId, refresh]);

  const globalServers = useMemo(() => servers.filter((s) => s.scope === 'user'), [servers]);
  const workspaceServers = useMemo(() => servers.filter((s) => s.scope === 'project'), [servers]);

  // ── handlers ────────────────────────────────────────────────────────────

  const handleAdd = () => {
    setEditingServer(null);
    setDialogOpen(true);
  };

  const handleEdit = (s: McpStatus) => {
    setEditingServer({ name: s.name, scope: s.scope, config: s.config });
    setDialogOpen(true);
  };

  const handleSave = async (scope: McpScope, name: string, config: McpConfig) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    if (editingServer) {
      // Editing an existing server. If the user renamed it, remove the old
      // entry first (the bridge keys servers by name).
      const isRename = editingServer.name !== name;
      if (isRename) {
        await ipc.mcpRemove(editingServer.name, editingServer.scope);
      }
      await ipc.mcpUpdate(name, config, scope);
    } else {
      await ipc.mcpAdd(name, config, scope);
    }
    setDialogOpen(false);
    setEditingServer(null);
    await refresh();
  };

  const handleRemove = async (s: McpStatus) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpRemove(s.name, s.scope);
    await refresh();
  };

  const handleApprove = async (s: McpStatus) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpApprove(s.name);
    await refresh();
  };

  const handleRetry = async (s: McpStatus) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpRetry(s.name, s.scope, activeWorkspaceId ?? undefined);
    await refresh();
  };

  const handleReauthorize = async (s: McpStatus) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpReauthorize(s.name, s.scope, activeWorkspaceId ?? undefined);
    await refresh();
  };

  const handleToggleEnabled = async (s: McpStatus, enabled: boolean) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpSetEnabled(s.name, enabled, s.scope);
    await refresh();
  };

  const handleImport = async (toImport: Array<{ name: string; config: unknown }>, importScope: McpScope) => {
    const ipc = window.tideIpc;
    if (!ipc) return;
    await ipc.mcpImport(toImport, importScope);
    setImportBadge(0);
    await refresh();
  };

  const addButton = (
    <div className="flex items-center gap-2">
      {importBadge > 0 && (
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          title={`Import ${importBadge} MCP server${importBadge === 1 ? '' : 's'} from other tools`}
          className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-accent/30 text-accent hover:bg-accent/10 transition-colors"
        >
          <Download className="size-3.5" />
          Import
          <span className="ml-0.5 inline-flex items-center justify-center size-4 rounded-full bg-accent text-white text-[9px] font-bold">
            {importBadge}
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={handleAdd}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 transition-colors"
      >
        <Plus className="size-3.5" />
        Add Server
      </button>
    </div>
  );

  const isEmpty = servers.length === 0;

  return (
    <>
      <SettingsHeader
        title="Extensions → MCP"
        description="Model Context Protocol servers. Add stdio commands or remote endpoints; approve new servers before they can run tools."
        action={addButton}
      />

      {!isEmpty && (
        <div className="space-y-5">
          {globalServers.length > 0 && (
            <ServerCard
              label="Global"
              icon={<Globe className="size-3.5" />}
              hint="~/.tide/mcp.json · available in all workspaces"
              badgeClass="bg-info/5"
              servers={globalServers}
              onEdit={handleEdit}
              onRemove={handleRemove}
              onApprove={handleApprove}
              onRetry={handleRetry}
              onReauthorize={handleReauthorize}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
          {workspaceServers.length > 0 && (
            <ServerCard
              label="This Workspace"
              icon={<FolderGit2 className="size-3.5" />}
              hint={workspaceRoot ? `${workspaceRoot}/.mcp.json · only active in this project` : '.mcp.json'}
              badgeClass="bg-accent/5"
              servers={workspaceServers}
              onEdit={handleEdit}
              onRemove={handleRemove}
              onApprove={handleApprove}
              onRetry={handleRetry}
              onReauthorize={handleReauthorize}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
        </div>
      )}

      {isEmpty && <EmptyState />}

      <McpServerDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingServer(null);
        }}
        onSave={handleSave}
        initialName={editingServer?.name}
        initialConfig={editingServer?.config}
        initialScope={editingServer?.scope ?? (workspaceRoot ? 'project' : 'user')}
        workspaceRoot={workspaceRoot}
      />

      <McpImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={handleImport}
        workspaceRoot={workspaceRoot}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Card + empty state
// ──────────────────────────────────────────────────────────────────────────

function ServerCard({
  label,
  icon,
  hint,
  badgeClass,
  servers,
  onEdit,
  onRemove,
  onApprove,
  onRetry,
  onReauthorize,
  onToggleEnabled,
}: {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  badgeClass?: string;
  servers: McpStatus[];
  onEdit: (s: McpStatus) => void;
  onRemove: (s: McpStatus) => void;
  onApprove: (s: McpStatus) => void;
  onRetry: (s: McpStatus) => void;
  onReauthorize: (s: McpStatus) => void;
  onToggleEnabled: (s: McpStatus, enabled: boolean) => void;
}) {
  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(servers.length / PAGE_SIZE);
  const [page, setPage] = useState(1);
  // Clamp page when servers list changes
  const clampedPage = Math.min(page, Math.max(1, totalPages));
  const start = (clampedPage - 1) * PAGE_SIZE;
  const paged = servers.slice(start, start + PAGE_SIZE);
  const showPagination = totalPages > 1;
  const rangeStart = start + 1;
  const rangeEnd = Math.min(start + PAGE_SIZE, servers.length);

  return (
    <Card>
      {/* Header with icon + label + count */}
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b border-border/60 ${badgeClass ?? ''}`}>
        <span className="shrink-0 opacity-70">{icon}</span>
        <h3 className="text-[11px] uppercase tracking-wide font-semibold flex-1">
          {label}
        </h3>
        <span className="text-[10px] text-muted-foreground/50 font-mono">
          {servers.length} server{servers.length === 1 ? '' : 's'}
        </span>
      </div>
      {hint && (
        <div className="px-4 py-1 border-b border-border/30 bg-muted/20">
          <code className="text-[10px] text-muted-foreground/50">{hint}</code>
        </div>
      )}
      <div className="divide-y divide-border/30">
        {paged.map((s) => (
          <McpServerRow
            key={`${s.scope}/${s.name}`}
            name={s.name}
            status={s.status}
            toolCount={s.toolCount}
            transport={s.transport}
            error={s.error}
            scope={s.scope}
            enabled={s.enabled}
            onToggleEnabled={(en) => onToggleEnabled(s, en)}
            onEdit={() => onEdit(s)}
            onRemove={() => onRemove(s)}
            onApprove={() => onApprove(s)}
            onRetry={() => onRetry(s)}
            onReauthorize={() => onReauthorize(s)}
          />
        ))}
      </div>
      {/* Pagination footer */}
      {showPagination && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/60 bg-muted/20">
          <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums">
            Showing {rangeStart}–{rangeEnd} of {servers.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, clampedPage - 1))}
              disabled={clampedPage <= 1}
              aria-label="Previous page"
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums min-w-[3rem] text-center">
              {clampedPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, clampedPage + 1))}
              disabled={clampedPage >= totalPages}
              aria-label="Next page"
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="size-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4">
        <Plug className="size-6 text-muted-foreground/50" />
      </div>
      <h3 className="text-base font-medium mb-1">No MCP servers yet</h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm">
        Add a stdio command (like the filesystem or fetch server) or connect to a
        remote SSE/HTTP endpoint. New servers need approval before they can run tools.
      </p>
      <div className="flex gap-2 mt-6">
        <button
          type="button"
          onClick={() => window.open('https://modelcontextprotocol.io', '_blank')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted transition-colors"
        >
          <ExternalLink className="size-3" />
          View MCP spec
        </button>
      </div>
    </div>
  );
}
