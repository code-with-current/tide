import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plug, Plus, Download, ExternalLink, Globe, FolderCode, Package, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { toast } from '@/lib/toast';
import { SettingsHeader, Card } from '../shared';
import { ReloadButton } from '../reload-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { McpServerRow, type McpStatusValue } from './server-row';
import {
  McpServerDialog,
  type McpConfig,
  type McpScope,
} from './server-dialog';
import { McpImportDialog } from './import-dialog';
import { useWorkspaces } from '@/lib/queries';
import {
  mcpAdd,
  mcpApprove,
  mcpAuthenticate,
  mcpImport,
  mcpList,
  mcpReauthorize,
  mcpReinitialize,
  mcpRemove,
  mcpRetry,
  mcpScan,
  mcpSetEnabled,
  mcpUpdate,
  subscribeMcpStatus,
} from '@/lib/api/client';
import { useUi } from '@/lib/stores/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/** Settings → Extensions → MCP: lists servers across global/workspace scopes with live status from the agent pool (refreshed via the MCP status push). */

/** Shape of one row returned by mcpList(). */
interface McpStatus {
  name: string;
  scope: McpScope;
  config: McpConfig;
  status: McpStatusValue;
  toolCount: number;
  toolNames: string[];
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
    mcpScan().then((result) => {
      setImportBadge(result.servers.filter((s) => !result.alreadyImported.includes(s.name)).length);
    }).catch(() => setImportBadge(0));
  }, []);

  const [reinitializing, setReinitializing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await mcpList(activeWorkspaceId ?? undefined);
      // Don't replace the list with empty during a reinitialize — keep
      // showing the existing servers so the UI doesn't flash/disappear.
      if (result.length > 0 || servers.length === 0 || !reinitializing) {
        setServers(result);
      }
    } catch { /* best-effort */ }
  }, [activeWorkspaceId, servers.length, reinitializing]);

  // Full re-initialize: disconnect + reconnect user + project servers from
  // their config files. Built-in servers are NOT affected. The pool broadcasts
  // statusChanged as each connect resolves, so refresh() re-pulls the list.
  const reinitialize = useCallback(async () => {
    setReinitializing(true);
    try {
      await mcpReinitialize();
      // Force a fresh pull after reinitialize completes.
      const result = await mcpList(activeWorkspaceId ?? undefined);
      setServers(result);
      toast.success('MCP servers reloaded');
    } catch (e) {
      toast.error('Reload failed', { description: e instanceof Error ? e.message : undefined });
    } finally {
      setReinitializing(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    refresh();
    return subscribeMcpStatus(() => {
      void refresh();
    });
  }, [refresh]);

  // Re-fetch when the active workspace changes (the project-scoped list shifts).
  useEffect(() => {
    void refresh();
  }, [activeWorkspaceId, refresh]);

  const globalServers = useMemo(() => servers.filter((s) => s.scope === 'user'), [servers]);
  const workspaceServers = useMemo(() => servers.filter((s) => s.scope === 'project'), [servers]);
  const builtinServers = useMemo(() => servers.filter((s) => s.scope === 'builtin'), [servers]);

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
    try {
      if (editingServer) {
        // Editing an existing server. If the user renamed it, remove the old
        // entry first (the bridge keys servers by name).
        const isRename = editingServer.name !== name;
        if (isRename) {
          await mcpRemove(editingServer.name, editingServer.scope);
        }
        await mcpUpdate(name, config, scope);
        toast.success('Server updated');
      } else {
        await mcpAdd(name, config, scope);
        toast.success('Server added');
      }
      setDialogOpen(false);
      setEditingServer(null);
      await refresh();
      // The add/update handlers fire loadServer in the background — the new
      // server isn't in the pool yet when refresh() runs. Poll once more after
      // a short delay to catch the server as it enters the pool (connecting).
      setTimeout(() => void refresh(), 500);
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const handleRemove = async (s: McpStatus) => {
    await mcpRemove(s.name, s.scope);
    await refresh();
  };

  const handleApprove = async (s: McpStatus) => {
    await mcpApprove(s.name);
    await refresh();
  };

  const handleRetry = async (s: McpStatus) => {
    await mcpRetry(s.name, s.scope, activeWorkspaceId ?? undefined);
    await refresh();
  };

  const handleReauthorize = async (s: McpStatus) => {
    await mcpReauthorize(s.name, s.scope, activeWorkspaceId ?? undefined);
    await refresh();
  };

  // User-initiated OAuth sign-in: opens the browser, then re-runs connect.
  const handleAuthenticate = async (s: McpStatus) => {
    await mcpAuthenticate(s.name, s.scope, activeWorkspaceId ?? undefined);
    await refresh();
  };

  const handleToggleEnabled = async (s: McpStatus, enabled: boolean) => {
    await mcpSetEnabled(s.name, enabled, s.scope);
    await refresh();
  };

  const handleImport = async (toImport: Array<{ name: string; config: unknown }>, importScope: McpScope) => {
    try {
      await mcpImport(toImport as Array<{ name: string; config: McpConfig }>, importScope);
      setImportBadge(0);
      await refresh();
      toast.success(`Imported ${toImport.length} server${toImport.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error('Import failed', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const addButton = (
    <div className="flex items-center gap-2">
      <ReloadButton
        loading={reinitializing}
        onClick={() => void reinitialize()}
        title="Reload MCP servers"
      />
      {/* Split button group: Add (primary) + dropdown caret for Import.
          Import is only offered when the scanner detected importable servers
          (importBadge > 0); it lives in the menu so the header stays compact. */}
      <div className="inline-flex rounded-md shadow-xs" role="group">
        <Button
          size="sm"
          onClick={handleAdd}
          className="rounded-r-none gap-1.5"
        >
          <Plus className="size-3.5" />
          Add
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="default"
              className="rounded-l-none border-l border-primary/30 px-2"
              aria-label="More actions"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onClick={() => setImportOpen(true)}
              disabled={importBadge === 0}
            >
              <Download className="size-3.5" />
              <span className="flex-1">Import</span>
              {importBadge > 0 && (
                <Badge className="p-1 py-0.5 text-[0.7143rem] border-none">
                  {importBadge}
                </Badge>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void reinitialize()}
            >
              <Plug className="size-3.5" />
              Re-initialize all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const isEmpty = servers.length === 0 && builtinServers.length === 0;

  return (
    <>
      <SettingsHeader
        title="MCP"
        description="Connect external tools and data sources via Model Context Protocol servers."
        action={addButton}
      />

      {!isEmpty && (
        <div className="space-y-5">
          {globalServers.length > 0 && (
            <ServerCard
              label="Global"
              icon={<Globe className="size-3.5" />}
              hint="~/.tide/mcp.json · available in all workspaces"
              servers={globalServers}
              onEdit={handleEdit}
              onRemove={handleRemove}
              onApprove={handleApprove}
              onRetry={handleRetry}
              onReauthorize={handleReauthorize}
              onAuthenticate={handleAuthenticate}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
          {builtinServers.length > 0 && (
            <ServerCard
              label="Built-in"
              icon={<Package className="size-3.5" />}
              hint="Ships with Tide · toggle to enable"
              servers={builtinServers}
              onEdit={handleEdit}
              onRemove={handleRemove}
              onApprove={handleApprove}
              onRetry={handleRetry}
              onReauthorize={handleReauthorize}
              onAuthenticate={handleAuthenticate}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
          {workspaceServers.length > 0 && (
            <ServerCard
              label="This Workspace"
              icon={<FolderCode className="size-3.5" />}
              hint={workspaceRoot ? `${workspaceRoot}/.mcp.json · only active in this project` : '.mcp.json'}
              servers={workspaceServers}
              onEdit={handleEdit}
              onRemove={handleRemove}
              onApprove={handleApprove}
              onRetry={handleRetry}
              onReauthorize={handleReauthorize}
              onAuthenticate={handleAuthenticate}
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
  servers,
  onEdit,
  onRemove,
  onApprove,
  onRetry,
  onReauthorize,
  onAuthenticate,
  onToggleEnabled,
}: {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  servers: McpStatus[];
  onEdit: (s: McpStatus) => void;
  onRemove: (s: McpStatus) => void;
  onApprove: (s: McpStatus) => void;
  onRetry: (s: McpStatus) => void;
  onReauthorize: (s: McpStatus) => void;
  onAuthenticate: (s: McpStatus) => void;
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
      {/* Header — matches ExtensionCard: uppercase label + count, with the
          scope icon + hint folded in as subtle accents so the MCP cards read
          as siblings of the Skills/Agents cards. */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
        <span className="shrink-0 text-muted-foreground/50">{icon}</span>
        <h3 className="text-[0.7857rem] uppercase tracking-wide text-muted-foreground/60 font-medium flex-1">
          {label}
        </h3>
        {hint && (
          <code className="hidden sm:block text-[0.7143rem] text-muted-foreground/40 font-mono truncate max-w-[40%]">
            {hint}
          </code>
        )}
        <span className="text-[0.7143rem] text-muted-foreground/50 font-mono tabular-nums">
          {servers.length}
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {paged.map((s) => (
          <McpServerRow
            key={`${s.scope}/${s.name}`}
            name={s.name}
            status={s.status}
            toolCount={s.toolCount}
            toolNames={s.toolNames}
            transport={s.transport}
            error={s.error}
            scope={s.scope}
            enabled={s.enabled}
            auth={s.config?.auth}
            onToggleEnabled={(en) => onToggleEnabled(s, en)}
            onEdit={() => onEdit(s)}
            onRemove={() => onRemove(s)}
            onApprove={() => onApprove(s)}
            onRetry={() => onRetry(s)}
            onReauthorize={() => onReauthorize(s)}
            onAuthenticate={() => onAuthenticate(s)}
          />
        ))}
      </div>
      {/* Pagination footer */}
      {showPagination && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/60 bg-muted/20">
          <span className="text-[0.7143rem] text-muted-foreground/60 font-mono tabular-nums">
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
            <span className="text-[0.7143rem] text-muted-foreground/60 font-mono tabular-nums min-w-[3rem] text-center">
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
      <h3 className="text-base font-medium mb-1">No MCP yet</h3>
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
