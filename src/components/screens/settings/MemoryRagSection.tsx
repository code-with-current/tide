import {
  RefreshCw,
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  Cpu,
  Brain,
  Database,
  Archive,
} from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Chip } from '@/components/primitives';
import { RagIndexProgress } from '@/components/rag/RagIndexProgress';
import { Card, SettingsGroup, SettingsRow } from './shared';
import {
  useRagStatus,
  useUpdateRagConfig,
  useEnableRagWorkspace,
  useDisableRagWorkspace,
  useDownloadRagModel,
  useInitRagWorkspace,
  useRagInitProgress,
  useRagDownloadProgress,
  useWorkspaces,
} from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import type { RagStatus } from '@/types';

export function MemoryRagSection() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const { data: workspaces } = useWorkspaces();
  const [selectedWsId, setSelectedWsId] = useState<string | null>(activeWorkspaceId);
  const effectiveWsId = selectedWsId ?? activeWorkspaceId;

  const { data } = useRagStatus(effectiveWsId);
  const updateRag = useUpdateRagConfig(effectiveWsId);
  const enableWorkspace = useEnableRagWorkspace(effectiveWsId);
  const disableWorkspace = useDisableRagWorkspace(effectiveWsId);
  const downloadModel = useDownloadRagModel(effectiveWsId);
  const initWorkspace = useInitRagWorkspace(effectiveWsId);
  const initProgress = useRagInitProgress(effectiveWsId);
  const downloadProgress = useRagDownloadProgress();

  const status: RagStatus | undefined =
    data && 'embedderId' in data ? data : undefined;

  const modelReady = status?.localAvailable === true;
  const enabledIds = status?.enabledWorkspaces ?? [];
  const wsEnabled = !!effectiveWsId && enabledIds.includes(effectiveWsId);
  const downloading = downloadModel.isPending;
  const initRunning = status?.initState === 'running';

  const isLocal = status?.embedderId === 'local-code-512';
  const chunkOptions = isLocal ? [256, 384, 512] : [256];
  const currentChunk = status?.chunkTokens ?? 384;
  const wsName = workspaces?.find((w) => w.id === effectiveWsId)?.name ?? effectiveWsId ?? '—';

  const handleEnable = (id: string) => {
    enableWorkspace.mutate(id, { onSuccess: () => initWorkspace.mutate(id) });
  };

  return (
    <div className="flex gap-3 min-h-[30rem] -mt-1">
      {/* ─── Sidebar: workspace list ─── */}
      <aside className="w-[200px] shrink-0 flex flex-col">
        <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
          Workspaces
        </div>
        <div className="flex-1 space-y-0.5">
          {!workspaces || workspaces.length === 0 ? (
            <p className="px-1 py-2 text-[12px] leading-relaxed text-muted-foreground/50">
              No workspaces yet.
            </p>
          ) : (
            workspaces.map((ws) => {
              const isEnabled = enabledIds.includes(ws.id);
              const isActive = ws.id === effectiveWsId;
              return (
                <button
                  key={ws.id}
                  onClick={() => setSelectedWsId(ws.id)}
                  className={cn(
                    'group w-full flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12px] transition-all duration-100',
                    isActive
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground/90',
                  )}
                >
                  <span
                    className={cn(
                      'size-[5px] rounded-full shrink-0 transition-colors',
                      isEnabled
                        ? 'bg-emerald-400'
                        : modelReady
                          ? 'bg-muted-foreground/30'
                          : 'bg-muted-foreground/15',
                    )}
                  />
                  <span className="truncate flex-1 leading-tight">{ws.name}</span>
                </button>
              );
            })
          )}
        </div>

        {/* Global model status — pinned to bottom */}
        <div className="pt-3 mt-auto border-t border-border/60">
          <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
            Model
          </div>
          <div className="flex items-center gap-2 px-1 py-1">
            {modelReady ? (
              <CheckCircle2 className="size-3 text-emerald-400/80" />
            ) : downloading ? (
              <Loader2 className="size-3 animate-spin text-blue-400" />
            ) : (
              <XCircle className="size-3 text-red-400/70" />
            )}
            <span className="text-[11px] text-muted-foreground/70">
              {modelReady ? 'Downloaded' : downloading ? 'Downloading…' : 'Not downloaded'}
            </span>
          </div>
          {!modelReady && !downloading && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-1.5 w-full h-[26px] text-[11px] gap-1.5"
              disabled={downloading}
              onClick={() => downloadModel.mutate()}
            >
              <Download className="size-3" />
              Download 22 MB
            </Button>
          )}
          {downloading && (
            <div className="mt-1.5 px-1 space-y-1">
              {downloadProgress && downloadProgress.phase === 'downloading' && downloadProgress.total > 0 && (
                <>
                  <div className="h-1 rounded-full bg-secondary overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300 bg-blue-400"
                      style={{
                        width: `${Math.min(100, (downloadProgress.received / downloadProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground/40 font-mono">
                    {(downloadProgress.received / 1048576).toFixed(1)} / {(downloadProgress.total / 1048576).toFixed(1)} MB
                  </p>
                </>
              )}
              {(!downloadProgress || downloadProgress.total === 0) && (
                <p className="text-[10px] leading-snug text-muted-foreground/40">
                  Fetching from huggingface.co…
                </p>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ─── Right panel: config for selected workspace ─── */}
      <div className="flex-1 min-w-0 overflow-y-auto pr-1">
        {!effectiveWsId ? (
          <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground/40">
            Select a workspace
          </div>
        ) : (
          <div className="space-y-5">
            {/* Workspace title */}
            <div className="flex items-baseline gap-3">
              <h1 className="text-[15px] font-semibold tracking-tight">{wsName}</h1>
              <span className="text-[11px] text-muted-foreground/50">
                {wsEnabled ? `${status?.chunkCount ?? 0} chunks` : 'not indexed'}
              </span>
            </div>

            {/* RAG status + enable */}
            <SettingsGroup title="RAG">
              <Card>
                <SettingsRow
                  title="Status"
                  description={
                    !modelReady
                      ? 'Download the model first (sidebar).'
                      : wsEnabled
                        ? `${status?.chunkCount ?? 0} chunks indexed`
                        : initRunning
                          ? 'Indexing…'
                          : 'Not enabled for this workspace'
                  }
                >
                  <Chip tone={wsEnabled ? 'ok' : modelReady ? 'info' : 'bad'} className={initRunning ? 'animate-pulse' : undefined}>
                    {wsEnabled ? 'enabled' : initRunning ? 'indexing' : modelReady ? 'off' : 'no model'}
                  </Chip>
                </SettingsRow>
                <SettingsRow
                  title="Enable RAG"
                  description={wsEnabled ? 'Toggle off to disable retrieval for this workspace.' : 'Downloads model if needed, then indexes.'}
                  last
                >
                  <Switch
                    checked={wsEnabled}
                    disabled={!modelReady || enableWorkspace.isPending || disableWorkspace.isPending || initRunning}
                    onCheckedChange={(v) =>
                      v ? handleEnable(effectiveWsId!) : disableWorkspace.mutate(effectiveWsId!)
                    }
                  />
                </SettingsRow>
              </Card>
            </SettingsGroup>

            {/* Indexing progress — prominent card (self-gates when idle/done). */}
            <RagIndexProgress event={initProgress} />

            {/* Embedder */}
            <SettingsGroup title="Embedder">
              <Card>
                <SettingsRow title="Model" description="all-MiniLM-L6-v2 code-tuned · 384-dim">
                  <Cpu className="size-3.5 text-muted-foreground/50" />
                </SettingsRow>
                <SettingsRow title="Variant" description={status ? status.embedderId ?? '—' : 'loading…'}>
                  <span className="text-[11px] text-muted-foreground/70 font-mono">
                    {status?.embedderId ?? '—'}
                  </span>
                </SettingsRow>
                <SettingsRow title="Cloud fallback" description="Only when local ONNX is unavailable." last>
                  <Switch
                    checked={status?.cloudAllowed ?? false}
                    disabled={!effectiveWsId || updateRag.isPending}
                    onCheckedChange={(v) => updateRag.mutate({ cloudAllowed: v })}
                  />
                </SettingsRow>
              </Card>
            </SettingsGroup>

            {/* Chunking + Memory + Retrieval — all gated on modelReady */}
            {modelReady && (
              <>
              <SettingsGroup title="Chunking">
                <Card>
                  <SettingsRow title="Strategy" description="AST-aware via tree-sitter.">
                    <Chip tone="info">tree-sitter</Chip>
                  </SettingsRow>
                  <SettingsRow title="Chunk size" description={isLocal ? 'Up to 512 tokens.' : 'Locked to 256.'}>
                    <Select
                      value={String(currentChunk)}
                      disabled={!effectiveWsId || updateRag.isPending}
                      onValueChange={(v) => updateRag.mutate({ chunkTokens: Number(v) })}
                    >
                      <SelectTrigger className="w-[8rem] h-7 text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {chunkOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>{n} tokens</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow title="Languages" description="28 grammars bundled." last>
                    <span className="text-[10px] text-muted-foreground/50 font-mono">
                      TS JS PY GO RS JAVA C++ C# RB PHP SWIFT…
                    </span>
                  </SettingsRow>
                </Card>
              </SettingsGroup>

              {/* Memory stores */}
              <SettingsGroup title="Memory Stores">
                <Card>
                  <SettingsRow title="Working memory" description="Current session state — always-on, in-context.">
                    <div className="flex items-center gap-2">
                      <Brain className="size-3 text-muted-foreground/40" />
                      <span className="text-[10px] text-muted-foreground/50">session</span>
                    </div>
                  </SettingsRow>
                  <SettingsRow title="Semantic memory" description="Codebase knowledge indexed via RAG." >
                    <div className="flex items-center gap-2">
                      <Database className="size-3 text-muted-foreground/40" />
                      <span className="text-[10px] text-muted-foreground/50">
                        {wsEnabled ? `${status?.chunkCount ?? 0} chunks` : 'empty'}
                      </span>
                    </div>
                  </SettingsRow>
                  <SettingsRow title="Episodic memory" description="Past sessions — FTS + vector over JSONL." last>
                    <div className="flex items-center gap-2">
                      <Archive className="size-3 text-muted-foreground/40" />
                      <span className="text-[10px] text-muted-foreground/50">planned</span>
                    </div>
                  </SettingsRow>
                </Card>
              </SettingsGroup>

              {/* Retrieval */}
              <SettingsGroup title="Retrieval">
                <Card>
                  <SettingsRow title="Hybrid search" description="BM25 (FTS5) + vector (sqlite-vec), fused via reciprocal rank.">
                    <Switch defaultChecked />
                  </SettingsRow>
                  <SettingsRow title="Query rewriting" description="Rewrite vague queries before retrieval." last>
                    <Switch defaultChecked />
                  </SettingsRow>
                </Card>
              </SettingsGroup>
              </>
            )}

            {/* Index management */}
            {modelReady && wsEnabled && (
              <SettingsGroup title="Index">
                <Card>
                  <SettingsRow
                    title="Re-index"
                    description="Re-walk + re-chunk + re-embed. Skips unchanged chunks."
                    last
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-[11px] gap-1.5"
                      disabled={initWorkspace.isPending || initRunning}
                      onClick={() => effectiveWsId && initWorkspace.mutate(effectiveWsId)}
                    >
                      <RefreshCw className={cn('size-3', initWorkspace.isPending && 'animate-spin')} />
                      Re-index
                    </Button>
                  </SettingsRow>
                </Card>
              </SettingsGroup>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
