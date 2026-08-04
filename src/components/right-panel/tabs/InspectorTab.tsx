import { useMemo } from 'react';
import {
  Cpu,
  Shield,
  Repeat,
  GitBranch,
  CheckCircle2,
  XCircle,
  RefreshCw,
  GitPullRequestArrow,
  Brain,
  Loader2,
  Wrench,
  DollarSign,
} from 'lucide-react';
import type { Session } from '@/types';
import { Avatar } from '@/components/primitives';
import { RagIndexProgress } from '@/components/rag/RagIndexProgress';
import { Badge } from '@/components/ui/badge';
import { LoadingRows } from '@/components/ui/loading-rows';
import { formatNumber, formatRelative, cn } from '@/lib/utils';
import {
  useModelOption,
  useModels,
  useWorkspaces,
  useGitStatus,
  useRagStatus,
  useReindexWorkspace,
  useRagInitProgress,
  useAgentSettings,
} from '@/lib/queries';
import { useShallow } from 'zustand/react/shallow';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { PanelSection } from '../PanelSection';
import { SessionHero } from '../SessionHero';
import { Button } from '@/components/ui/button';

export function InspectorTab({ session }: { session: Session }) {
  const usage = session.usage;
  const { isLoading: modelsLoading } = useModels();
  const model = useModelOption(null, session.modelId);
  const { data: agentSettings } = useAgentSettings();
  const maxSteps = agentSettings?.maxSteps ?? 100;

  const { data: workspaces } = useWorkspaces();
  const workspace = useMemo(
    () => workspaces?.find((w) => w.id === session.workspaceId),
    [workspaces, session.workspaceId],
  );
  const { data: gitChanges } = useGitStatus(session.workspaceId, session.worktree ? session.id : undefined);

  // Any of the core async deps still loading → show a skeleton for the
  // Configuration section instead of fabricated values (e.g. a hardcoded
  // 100 maxSteps or a raw modelId before the model record resolves). Uses
  // the queries' isLoading flags (not a value === undefined check) so a
  // legitimately-missing model doesn't keep the skeleton up forever.
  const loading =
    modelsLoading || agentSettings === undefined || workspaces === undefined || gitChanges === undefined;

  const gitStats = useMemo(() => {
    const changes = gitChanges ?? [];
    const staged = changes.filter((c) => c.staged).length;
    const additions = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
    const deletions = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);
    return { changed: changes.length, staged, additions, deletions };
  }, [gitChanges]);

  // Pending review drives section ordering: when there's a pending permission
  // ask, Review jumps to the top and the informational sections auto-collapse
  // to focus attention on the actionable card.
  const pending = usePendingToolCalls(session.id);

  // Live autonomy mode — read from the UI store (updated instantly when the
  // user changes the dropdown) instead of the session record (which lags
  // behind the persist roundtrip). Falls back to session.autonomyMode.
  const liveMode = useUi((s) =>
    s.activeSessionId === session.id ? s.autonomyMode : undefined,
  );
  const effectiveMode = liveMode ?? session.autonomyMode;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto scroll">
        {/* Hero — status, stats, pinned context meter (replaces the old
            non-collapsible header + the bottom ContextWindowSection). */}
        <SessionHero session={session} />

        {/* Review section removed — permission prompts now render as a
            floating card above the composer (FloatingPermissionCard). */}

        {/* Configuration */}
        <PanelSection title="Configuration" defaultOpen>
          {loading ? (
            // Deps still resolving — skeleton instead of fabricated values
            // (avoids leaking a hardcoded 100 maxSteps or a raw modelId).
            <LoadingRows count={3} />
          ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Cpu className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground flex-1 text-[12px]">Model</span>
              <div className="flex items-center gap-1.5 text-[11px]">
                <Avatar className="size-3.5 text-[8px] bg-gradient-to-br from-accent to-[#b8553f] text-white">
                  {(model?.alias ?? session.modelId).charAt(0).toUpperCase()}
                </Avatar>
                <span title={session.modelId}>
                  {model ? `${model.alias} · ${model.providerName}` : session.modelId}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground flex-1 text-[12px]">Permissions</span>
              <Badge variant="secondary" className="text-[10px] rounded-md">{autonomyLabel(effectiveMode)}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Repeat className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground flex-1 text-[12px]">Iteration</span>
              <span className="font-mono text-[11px]">{usage?.calls ?? 0} / {maxSteps}</span>
            </div>
          </div>
          )}
        </PanelSection>

        {/* Memory & RAG — with Re-Index action in the header */}
        <MemoryRagSection session={session} />

        {/* Git — with Changes (open Source Control) action in the header */}
        <PanelSection
          title="Git"
          defaultOpen={pending.length === 0}
          badge={session.worktree ? <Badge variant="secondary" className="ml-1.5 text-[9px]">worktree</Badge> : undefined}
          action={<OpenChangesButton sessionId={session.id} changed={gitStats.changed} />}
        >
          {(session.worktree || workspace) ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3" />
                <span className="font-mono text-xs flex-1 truncate">
                  {session.worktree?.branch ?? workspace?.branch}
                </span>
              </div>
              {session.worktree && (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">base</span>
                    <span className="font-mono text-[10px] truncate max-w-[60%] text-right">
                      {session.worktree.baseBranch} @ {session.worktree.baseCommit}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ahead / behind</span>
                    <span className="font-mono">+{session.worktree.ahead} −{session.worktree.behind}</span>
                  </div>
                </>
              )}
              {!session.worktree && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground text-[12px]">Head</span>
                  <span className="font-mono text-[10px] truncate max-w-[60%] text-right">{workspace?.headCommit}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground text-[12px]">Changed</span>
                <span className="font-mono text-[10px]">
                  {gitStats.changed}
                  {gitStats.staged > 0 && <span className="text-muted-foreground"> · {gitStats.staged} staged</span>}
                </span>
              </div>
              {(gitStats.additions > 0 || gitStats.deletions > 0) && (
                <DiffStat additions={gitStats.additions} deletions={gitStats.deletions} />
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground flex-shrink-0 text-[12px]">{session.worktree ? 'Worktree' : 'Repo'}</span>
                <span className="font-mono text-[10px] truncate text-right max-w-[60%]">
                  {session.worktree?.path ?? workspace?.path}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground">Loading workspace…</div>
          )}
        </PanelSection>

        {/* Exposed ports */}
        {session.exposedPorts.length > 0 && (
          <PanelSection title="Exposed ports" defaultOpen={false}>
            <div className="space-y-0.5">
              {session.exposedPorts.map((p) => (
                <a
                  key={p.port}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 hover:underline"
                >
                  <span className="flex-1 text-muted-foreground">{p.label}</span>
                  <code className="font-mono">:{p.port}</code>
                </a>
              ))}
            </div>
          </PanelSection>
        )}

        {/* Context window detail (collapsed by default — the hero carries the
            essential meter; this section is the opt-in per-class breakdown). */}
        <ContextWindowDetailSection session={session} />
      </div>
    </div>
  );
}

// Module-level stable empty array. Returning a fresh `[]` from the selector
// on every call would create a new reference each time, which Zustand's
// useSyncExternalStore sees as a snapshot change → infinite re-render loop
// ("getSnapshot should be cached"). A shared constant keeps the empty case
// referentially stable, matching the codebase's existing pattern
// (DEFAULT_INSPECTOR_TABS in RightPanel.tsx).
const EMPTY_TOOL_CALLS: readonly never[] = Object.freeze([]);

/** Read the pending permission tool calls for a session from the UI store.
 *  Returns a stable empty array when nothing's pending. Centralized here so
 *  InspectorTab and ReviewSection share one selector. */
function usePendingToolCalls(sessionId: string | undefined) {
  return useUi((s) =>
    sessionId && s.streams[sessionId]?.permissionRequest?.toolCalls.length
      ? s.streams[sessionId]!.permissionRequest!.toolCalls
      : EMPTY_TOOL_CALLS,
  );
}

function autonomyLabel(mode: Session['autonomyMode']) {
  return (
    {
      plan: 'Plan Only',
      ask: 'Ask Before Changes',
      edit: 'Edit Automatically',
      full: 'Full Access',
    }[mode] ?? mode
  );
}

// =============================================================
// Review section — pending approvals. Uses PermissionCard with the
// variant="split" Inspector layout (split-button dropdowns).
// Review section removed — permission prompts now render as a floating card
// above the composer (FloatingPermissionCard in MainScreen).
// =============================================================

// =============================================================
// "Open Changes" header button — switches to the Source Control tab.
// addTab is idempotent: creates the tab if absent, then activates it.
// =============================================================

/** Additions/deletions bar — a proportional green/red strip mirroring the
 *  mockup's .diffstat. Replaces the old plain `+128 −54` text row so the
 *  change composition is visible at a glance. */
function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions || 1; // guard divide-by-zero
  return (
    <div className="flex items-center gap-2 py-1 font-mono text-[10.5px]">
      <span className="flex-1 font-sans text-[11.5px] text-muted-foreground">Changes</span>
      <span className="text-emerald-400">+{additions}</span>
      <div className="flex h-1 w-20 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-emerald-400" style={{ width: `${(additions / total) * 100}%` }} />
        <div className="h-full bg-destructive" style={{ width: `${(deletions / total) * 100}%` }} />
      </div>
      <span className="text-destructive">−{deletions}</span>
    </div>
  );
}

function OpenChangesButton({ sessionId, changed }: { sessionId: string; changed: number }) {
  const addTab = useTabs((s) => s.addTab);
  return (
    <button
      type="button"
      onClick={() => addTab(sessionId, 'changes')}
      title="Open Source Control tab"
      // Mirrors the mockup's .head-action: a compact bordered pill that reads
      // as a distinct action, not part of the header. Ghost Button blended in.
      className="inline-flex items-center gap-1 h-5 px-2 rounded border border-border bg-transparent text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:border-accent hover:bg-secondary transition-colors cursor-pointer"
    >
      <GitPullRequestArrow className="size-3" />
      Changes{changed > 0 && <span className="text-muted-foreground/70"> · {changed}</span>}
    </button>
  );
}

// =============================================================
// Context window detail section — the per-class breakdown. Collapsed by
// default; the hero carries the summary meter.
// =============================================================

const CONTEXT_WARN_PCT = 80;

function ContextWindowDetailSection({ session }: { session: Session }) {
  // Subscribe to live stream fields for real-time stats during streaming.
  const streamFields = useUi(
    useShallow((s) => {
      if (!session.id) return null;
      const st = s.streams[session.id];
      if (!st) return null;
      return {
        isStreaming: st.isStreaming,
        usage: st.usage,
        iteration: st.iteration,
      };
    }),
  );

  const { data: agentSettings } = useAgentSettings();
  const maxSteps = agentSettings?.maxSteps ?? 100;
  const model = useModelOption(null, session.modelId);
  const contextWindow = model?.contextWindow ?? 200_000;

  // While streaming, use the live step usage; after completion, use the
  // persisted last-turn usage (the last step's actual input).
  const u = streamFields?.isStreaming
    ? (streamFields.usage ?? session.lastTurnUsage ?? session.usage)
    : (session.lastTurnUsage ?? session.usage);

  // Context window fill = input tokens only.
  const liveContext = u.inputTokens;
  const pctUsed = Math.min(100, (liveContext / contextWindow) * 100);
  const seg = (n: number) => Math.min(100, (n / contextWindow) * 100);
  const meterSegments = [
    { label: 'Cache read', tokens: u.cacheRead, pct: seg(u.cacheRead), cls: 'bg-slate-500' },
    { label: 'Input', tokens: Math.max(0, u.inputTokens - u.cacheRead), pct: seg(Math.max(0, u.inputTokens - u.cacheRead)), cls: 'bg-sky-400' },
    { label: 'Output', tokens: u.outputTokens, pct: seg(u.outputTokens), cls: 'bg-primary' },
    { label: 'Reasoning', tokens: u.reasoningTokens, pct: seg(u.reasoningTokens), cls: 'bg-purple-400' },
  ];

  // Detail breakdown rows (cumulative session usage for cost accounting).
  // Each row carries a color dot matching its segment in the meter bar.
  const cu = session.usage;
  const detailSegments = [
    { label: 'Cache read', tokens: cu.cacheRead, dot: 'bg-slate-500' },
    { label: 'Cache write', tokens: cu.cacheWrite, dot: 'bg-slate-600' },
    { label: 'Input (total)', tokens: cu.inputTokens, dot: 'bg-sky-400' },
    { label: 'Reasoning (total)', tokens: cu.reasoningTokens, dot: 'bg-purple-400' },
    { label: 'Output (total)', tokens: cu.outputTokens, dot: 'bg-primary' },
  ];

  return (
    <PanelSection
      title="Context Window"
      defaultOpen={true}
    >
      {/* Stat strip — Iteration / Tools / Cost */}
      <div className="grid grid-cols-3 gap-px bg-border border border-border rounded-md overflow-hidden mb-3">
        <div className="bg-background px-2.5 py-2">
          <div className="flex items-center gap-1 text-[0.70rem] font-semibold uppercase tracking-wider text-muted-foreground">
            <Cpu className="size-3" />Iteration
          </div>
          <div className="font-mono text-[13px] font-semibold mt-0.5 tabular-nums tracking-tight">
            {streamFields?.iteration ?? u.calls}<span className="text-[0.75rem] text-muted-foreground font-normal"> / {maxSteps}</span>
          </div>
        </div>
        <div className="bg-background px-2.5 py-2">
          <div className="flex items-center gap-1 text-[0.70rem] font-semibold uppercase tracking-wider text-muted-foreground">
            <Wrench className="size-3" />Tools
          </div>
          <div className="font-mono text-[13px] font-semibold mt-0.5 tabular-nums tracking-tight">
            {formatNumber(cu.calls)}<span className="text-[0.75rem] text-muted-foreground font-normal"> calls</span>
          </div>
        </div>
        <div className="bg-background px-2.5 py-2">
          <div className="flex items-center gap-1 text-[0.70rem] font-semibold uppercase tracking-wider text-muted-foreground">
            <DollarSign className="size-2.5" />Cost
          </div>
          <div className="font-mono text-[13px] font-semibold mt-0.5 tabular-nums tracking-tight">
            {session.costUsd.toFixed(3)}<span className="text-[0.75rem] text-muted-foreground font-normal"> USD</span>
          </div>
        </div>
      </div>

      {/* Context meter */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between text-[0.65rem] mb-1.5">
          <span className="font-semibold uppercase tracking-wider text-muted-foreground">Context fill</span>
          <span className="font-mono text-muted-foreground">
            <span className="text-foreground text-[0.75rem] font-semibold">{formatNumber(liveContext)}</span> / {formatNumber(contextWindow)} ·{' '}
            <span className={pctUsed >= CONTEXT_WARN_PCT ? 'text-amber-300 text-[0.75rem]' : 'text-[0.75rem]'}>{pctUsed.toFixed(1)}%</span>
          </span>
        </div>
        <div
          className={cn(
            'relative h-1.5 rounded-full overflow-hidden bg-muted',
            pctUsed >= CONTEXT_WARN_PCT && 'ring-1 ring-amber-500/40',
          )}
          role="progressbar"
          aria-label="Context window usage"
          aria-valuenow={Math.round(pctUsed)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="absolute inset-0 flex">
            {meterSegments.map((s, i) => (
              <div
                key={i}
                className={cn('h-full', s.cls)}
                style={{ width: `${s.pct}%` }}
                title={`${s.label}: ${formatNumber(s.tokens)} tok`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Per-class cumulative breakdown */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        {detailSegments.map((s) => (
          <div key={s.label} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className={cn('size-1.5 rounded-full shrink-0', s.dot)} />
              {s.label}
            </span>
            <span className="font-mono text-muted-foreground">{formatNumber(s.tokens)}</span>
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

// =============================================================
// Memory & RAG section — with Re-Index header action.
// =============================================================

function MemoryRagSection({ session }: { session: Session }) {
  const { data } = useRagStatus(session.workspaceId ?? null);
  const status = data && !('error' in data) ? (data as import('@/types').RagStatus) : undefined;
  const { reindex, isReindexing } = useReindexWorkspace(session.workspaceId);
  // Streamed indexing progress — the Inspector previously ignored this and
  // showed only a spinning icon. Now it drives the prominent progress card.
  const initProgress = useRagInitProgress(session.workspaceId ?? null);
  const indexing =
    isReindexing ||
    (!!initProgress && initProgress.phase !== 'done' && initProgress.phase !== 'failed');

  const modelReady = status?.localAvailable === true;
  const isEnabled = status?.enabledWorkspaces?.includes(session.workspaceId ?? '') ?? false;
  const chunkCount = status?.chunkCount ?? 0;
  const lastIndexed = status?.lastIngestedAt
    ? formatRelative(new Date(status.lastIngestedAt).toISOString())
    : null;
  const toolAvailable = modelReady && isEnabled && chunkCount > 0;

  return (
    <PanelSection
      title="Memory & RAG"
      defaultOpen={true}
      action={
        <Badge variant="secondary" className={cn('ml-1.5 flex items-center gap-1 font-mono normal-case tracking-normal rounded-md', indexing && 'animate-pulse')}>
          {indexing ? (
            <>
              <Loader2 className="size-2.5 animate-spin text-emerald-400" />
              <span className="text-[10px] text-emerald-400">Indexing</span>
            </>
          ) : toolAvailable ? (
            <>
              <CheckCircle2 className="size-2.5 text-emerald-400" />
              <span className="text-[10px]">Active</span>
            </>
          ) : (
            <>
              <XCircle className="size-2.5 text-warning/70" />
              <span className="text-[10px] text-warning/70">Inactive</span>
            </>
          )}
        </Badge>
      }

    >
      {!isEnabled ? (
        // RAG not enabled for this workspace — overlay the section with a
        // disabled state and a button to open Settings → Memory & RAG.
        <div className="relative">
          {/* faint disabled preview of the stats underneath the overlay */}
          <div className="space-y-1 select-none pointer-events-none opacity-40" aria-hidden>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground flex-1  text-[12px]">Memory</span>
              <span className="text-[11px] text-muted-foreground/60">workspace off</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground flex-1 text-[12px]">Indexed</span>
              <span className="font-mono text-[11px]">—</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground text-[12px]">Embedder</span>
              <span className="font-mono text-[10px] text-muted-foreground/70 truncate max-w-[60%] text-right">
                {status?.embedderId ?? '—'}
              </span>
            </div>

          </div>

          {/* overlay */}
          <div className="absolute inset-0 -m-3 flex flex-col items-center justify-center gap-2 bg-background/80 backdrop-blur-[2px] text-center py-10">
            <Brain className="size-4 text-muted-foreground/70" />
            <p className="text-[11px] leading-snug text-muted-foreground">
              RAG is disabled for this workspace.
              <br />
              Enable it in Settings to index your files.
            </p>
            <Button
              variant="warning"
              size="xs"
              className="h-6 mb-5"
              onClick={() => useUi.getState().setScreen('settings')}
            >
              Enable RAG
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground flex-1  text-[12px]">Memory</span>
            <span className={`text-[11px] ${toolAvailable ? 'text-foreground' : 'text-muted-foreground/60'}`}>
              {toolAvailable ? 'Available' : modelReady ? 'Workspace Off' : 'No Model'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground flex-1 text-[12px]">Indexed</span>
            <span className="font-mono text-[11px]">
              {chunkCount > 0 ? `${formatNumber(chunkCount)}` : '—'}
            </span>
          </div>
          {lastIndexed && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground text-[12px]">Last Indexed</span>
              <span className="text-[11px] text-muted-foreground/70">{lastIndexed}</span>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground text-[12px]">Embedder</span>
            <span className="font-mono text-[10px] text-muted-foreground/70 truncate max-w-[60%] text-right">
              {status?.embedderId ?? '—'}
            </span>
            </div>
            { isEnabled ? (
              <Button
                size="sm"
                disabled={!session.workspaceId || isReindexing}
                onClick={() => reindex()}
                title="Re-index this workspace's files into the RAG store"
                // Mirrors the mockup's .head-action: compact bordered pill. Spinner
                // replaces the icon while ingesting; disabled greys it out.
                className="w-full h-7"
              >
                <RefreshCw className={`size-3 ${isReindexing ? 'animate-spin' : ''}`} />
                Re-Index
              </Button>
                ) : undefined
            }
            {/* Prominent indexing progress — renders only while active/failed. */}
            <RagIndexProgress event={initProgress} />
          </div>
      )}
    </PanelSection>
  );
}
