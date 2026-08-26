import { useState, useEffect, useMemo } from 'react';
import { Download, Plug, Globe, FolderCode, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { SectionLabel } from '../providers/provider-fields';
import { ScopeCard } from './server-dialog';
import { mcpScan } from '@/lib/api/client';

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
    // Default to NONE selected — the user opts into each server explicitly
    // rather than silently importing everything the scanner found.
    setChecked(new Set());
    mcpScan().then((result) => {
      setServers(result.servers);
      setAlreadyImported(new Set(result.alreadyImported));
      setScanning(false);
    });
  }, [open]);

  // Group by source tool (Claude Code, Codex, OpenCode, Generic…)
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

  function toggleAllInGroup(groupServers: DetectedServer[]) {
    const importable = groupServers.filter((s) => !alreadyImported.has(s.name));
    const allChecked = importable.every((s) => checked.has(s.name));
    setChecked((prev) => {
      const next = new Set(prev);
      for (const s of importable) {
        if (allChecked) next.delete(s.name);
        else next.add(s.name);
      }
      return next;
    });
  }

  async function handleImport() {
    const selected = servers.filter((s) => checked.has(s.name));
    if (selected.length === 0) return;
    setImporting(true);
    try {
      await onImport(
        selected.map((s) => ({ name: s.name, config: s.config })),
        scope,
      );
    } finally {
      setImporting(false);
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !importing) onClose();
      }}
    >
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        {/* Header — matches the Add/Edit server dialog. */}
        <DialogHeader className="px-5 py-4 flex-row items-center gap-3.5 border-b border-border space-y-0">
          <div
            className="size-9 rounded-[10px] flex items-center justify-center shrink-0 border"
            style={{ background: 'rgba(217,119,87,0.1)', borderColor: 'rgba(217,119,87,0.2)' }}
          >
            <Download className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-[1.0714rem] font-semibold text-left tracking-tight">
              Import MCP
            </DialogTitle>
            <DialogDescription className="text-[0.7857rem] text-muted-foreground/60 mt-0.5 text-left">
              Detected from Claude Code, Codex, OpenCode, and other configs.
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="px-5 py-3 overflow-y-auto scroll max-h-[50vh]">
          {scanning ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
              <p className="text-xs text-muted-foreground/60">Scanning configs…</p>
            </div>
          ) : servers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="size-10 rounded-xl bg-muted/50 flex items-center justify-center">
                <Plug className="size-4 text-muted-foreground/50" />
              </div>
              <p className="text-xs text-muted-foreground/70 max-w-[260px]">
                No MCP found in Claude Code, Codex, OpenCode, or Generic configs.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground/70">
                Found {servers.length} server{servers.length === 1 ? '' : 's'} · {importableCount} new · {alreadyImported.size} already imported
              </p>

              {Object.entries(bySource).map(([source, sourceServers]) => {
                const importable = sourceServers.filter((s) => !alreadyImported.has(s.name));
                const allChecked = importable.length > 0 && importable.every((s) => checked.has(s.name));
                return (
                  <div key={source}>
                    {/* Source group header — shows the source tool name + config file path. */}
                    <div className="flex items-center justify-between mb-1.5 px-1">
                      <div
                        role="button"
                        tabIndex={importable.length === 0 ? -1 : 0}
                        onClick={() => importable.length > 0 && toggleAllInGroup(sourceServers)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAllInGroup(sourceServers); } }}
                        className={`flex items-center gap-1.5 ${importable.length === 0 ? '' : 'cursor-pointer'}`}
                      >
                        <Checkbox
                          checked={allChecked}
                          disabled={importable.length === 0}
                          onCheckedChange={() => toggleAllInGroup(sourceServers)}
                          className="size-3.5"
                        />
                        <h3 className="text-[0.7857rem] uppercase tracking-wide text-muted-foreground/60 font-medium">
                          {source}
                        </h3>
                      </div>
                      {sourceServers[0]?.sourceFile && (
                        <span className="text-[0.6429rem] text-muted-foreground/30 font-mono truncate max-w-[180px]" title={sourceServers[0].sourceFile}>
                          {sourceServers[0].sourceFile.replace(/^.*\//, '~/')}
                        </span>
                      )}
                      <span className="text-[0.7143rem] text-muted-foreground/40 font-mono tabular-nums">
                        {sourceServers.length}
                      </span>
                    </div>

                    {/* Server rows */}
                    <div className="space-y-1">
                      {sourceServers.map((s) => {
                        const isImported = alreadyImported.has(s.name);
                        const isChecked = checked.has(s.name);
                        const cmd = s.config.command || s.config.url || '';
                        const argSummary = s.config.args?.length ? ' ' + s.config.args.filter(a => !a.startsWith('-')).slice(0, 2).join(' ') : '';
                        return (
                          <label
                            key={s.name}
                            className={`flex items-start gap-2.5 px-2.5 py-2 rounded-lg border transition-colors ${
                              isImported
                                ? 'opacity-40 cursor-default border-transparent'
                                : isChecked
                                  ? 'cursor-pointer border-primary/30 bg-primary/[0.04]'
                                  : 'cursor-pointer border-border/50 hover:bg-secondary/50 hover:border-border'
                            }`}
                          >
                            <Checkbox
                              checked={isChecked}
                              disabled={isImported}
                              onCheckedChange={() => toggle(s.name)}
                              className="size-4 shrink-0 mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium">{s.name}</span>
                                {isImported && (
                                  <span className="text-[0.6429rem] text-muted-foreground/50">(already in Tide)</span>
                                )}
                                <span className="text-[0.5714rem] uppercase tracking-wide text-muted-foreground/40 font-mono shrink-0 px-1 py-0.5 rounded bg-muted/40">
                                  {s.config.type}
                                </span>
                              </div>
                              {cmd && (
                                <div className="text-[0.7143rem] text-muted-foreground/50 font-mono truncate mt-0.5" title={cmd + argSummary}>
                                  {cmd}<span className="text-muted-foreground/30">{argSummary}</span>
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Scope + footer — only once servers are scanned + there's something
            importable. Mirrors the Add/Edit dialog's scope cards + footer. */}
        {!scanning && importableCount > 0 && (
          <div className="px-5 py-3 border-t border-border space-y-3">
            <div>
              <SectionLabel icon={<Globe className="size-3" />}>Scope</SectionLabel>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard
                active={scope === 'user'}
                onClick={() => setScope('user')}
                icon={<Globe className="size-3.5" />}
                label="Global"
                hint="~/.tide/mcp.json"
              />
              <ScopeCard
                active={scope === 'project'}
                onClick={() => setScope('project')}
                icon={<FolderCode className="size-3.5" />}
                label="Workspace"
                hint={workspaceRoot ? `${workspaceRoot}/.mcp.json` : '.mcp.json'}
              />
            </div>
          </div>
        )}

        <DialogFooter className="px-5 py-3.5 flex-row items-center justify-between border-t border-border bg-secondary/30">
          <div className="text-[0.7857rem] text-muted-foreground/60">
            {checked.size > 0 ? (
              <Badge variant="secondary" className="font-mono">{checked.size} selected</Badge>
            ) : (
              <span></span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleImport}
              disabled={checked.size === 0 || importing}
              className="gap-1.5"
            >
              {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {importing ? `Importing ${checked.size}…` : `Import${checked.size > 0 ? ` ${checked.size}` : ''}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
