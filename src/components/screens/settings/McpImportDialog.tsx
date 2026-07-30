import { useState, useEffect, useMemo } from 'react';
import { X, Check, Download } from 'lucide-react';

interface DetectedServer {
  name: string;
  config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string };
  source: string;
  sourceFile: string;
}

interface McpImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (servers: Array<{ name: string; config: unknown }>, scope: 'user' | 'project') => Promise<void>;
  workspaceRoot?: string;
}

export function McpImportDialog({
  open,
  onClose,
  onImport,
  workspaceRoot,
}: McpImportDialogProps) {
  const [scanning, setScanning] = useState(true);
  const [servers, setServers] = useState<DetectedServer[]>([]);
  const [alreadyImported, setAlreadyImported] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<'user' | 'project'>(workspaceRoot ? 'project' : 'user');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScanning(true);
    setChecked(new Set());
    window.tideIpc?.mcpScan().then((result) => {
      setServers(result.servers);
      setAlreadyImported(new Set(result.alreadyImported));
      // Pre-check all non-already-imported servers
      setChecked(new Set(result.servers.filter((s) => !result.alreadyImported.includes(s.name)).map((s) => s.name)));
      setScanning(false);
    });
  }, [open]);

  // Group by source
  const bySource = useMemo(() => {
    const groups: Record<string, DetectedServer[]> = {};
    for (const s of servers) {
      if (!groups[s.source]) groups[s.source] = [];
      groups[s.source].push(s);
    }
    return groups;
  }, [servers]);

  const importableCount = servers.filter((s) => !alreadyImported.has(s.name)).length;

  function toggle(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleImport() {
    const selected = servers.filter((s) => checked.has(s.name));
    if (selected.length === 0) return;
    setImporting(true);
    await onImport(
      selected.map((s) => ({ name: s.name, config: s.config })),
      scope,
    );
    setImporting(false);
    onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import MCP servers"
        className="w-full max-w-md rounded-xl bg-card border border-border shadow-xl flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Import MCP Servers</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {scanning ? (
            <p className="text-sm text-muted-foreground text-center py-8">Scanning…</p>
          ) : servers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No MCP servers found from Claude Code, Codex, OpenCode, or Generic configs.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground/70 mb-3">
                Found {servers.length} server{servers.length === 1 ? '' : 's'} ({importableCount} new, {alreadyImported.size} already imported)
              </p>

              {Object.entries(bySource).map(([source, sourceServers]) => (
                <div key={source} className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground/60 font-medium">
                      {source}
                    </h3>
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{sourceServers.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {sourceServers.map((s) => {
                      const isImported = alreadyImported.has(s.name);
                      const isChecked = checked.has(s.name);
                      return (
                        <label
                          key={s.name}
                          className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                            isImported ? 'opacity-40' : 'hover:bg-muted/50'
                          }`}
                        >
                          <button
                            type="button"
                            disabled={isImported}
                            onClick={() => toggle(s.name)}
                            className={`shrink-0 size-4 rounded border flex items-center justify-center transition-colors ${
                              isChecked
                                ? 'bg-accent border-accent text-white'
                                : 'border-border'
                            }`}
                          >
                            {isChecked && <Check className="size-2.5" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <span className="text-xs font-medium">{s.name}</span>
                            {isImported && (
                              <span className="text-[9px] text-muted-foreground/50 ml-1.5">(already in Tide)</span>
                            )}
                          </div>
                          <span className="text-[9px] uppercase tracking-wide text-muted-foreground/40 font-mono shrink-0">
                            {s.config.type}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Scope selector + footer */}
        {!scanning && importableCount > 0 && (
          <div className="px-5 py-3 border-t border-border space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard
                active={scope === 'user'}
                onClick={() => setScope('user')}
                label="Global"
                hint="~/.tide/mcp.json"
              />
              <ScopeCard
                active={scope === 'project'}
                onClick={() => setScope('project')}
                label={workspaceRoot ? 'Workspace' : 'Workspace'}
                hint={workspaceRoot ? `${workspaceRoot}/.mcp.json` : '.mcp.json'}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleImport}
                disabled={checked.size === 0 || importing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="size-3" />
                {importing ? 'Importing…' : `Import ${checked.size} server${checked.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeCard({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
          : 'border-border hover:border-accent/40 hover:bg-muted/50'
      }`}
    >
      <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-foreground'}`}>{label}</span>
      <span className="text-[10px] text-muted-foreground/60 font-mono truncate max-w-full">{hint}</span>
    </button>
  );
}
