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
} from 'lucide-react';
import type { Session } from '@/types';
import { Avatar } from '@/components/primitives';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatRelative } from '@/lib/utils';
import {
  useModelOption,
  useWorkspaces,
  useGitStatus,
  useRagStatus,
  useReindexWorkspace,
  useAgentSettings,
} from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { PanelSection } from '../PanelSection';
import { SessionHero } from '../SessionHero';

export function InspectorTab({ session }: { session: Session }) {
  const usage = session.usage;
  const model = useModelOption(null, session.modelId);
  const { data: agentSettings } = useAgentSettings();
  const maxSteps = agentSettings?.maxSteps ?? 100;

  const { data: workspaces } = useWorkspaces();
  const workspace = useMemo(
    () => workspaces?.find((w) => w.id === session.workspaceId),
    [workspaces, session.workspaceId],
  );
  const { data: gitChanges } = useGitStatus(session.workspaceId, session.worktree ? session.id : undefined);

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
              <Badge variant="secondary" className="text-[10px]">{autonomyLabel(effectiveMode)}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Repeat className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground flex-1 text-[12px]">Iteration</span>
              <span className="font-mono text-[11px]">{usage?.calls ?? 0} / {maxSteps}</span>
            </div>
          </div>
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
      plan: 'Plan only',
      ask: 'Ask before changes',
      edit: 'Edit automatically',
      full: 'Full access',
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

function ContextWindowDetailSection({ session }: { session: Session }) {
  const u = session.usage;
  const model = useModelOption(null, session.modelId);
  const contextWindow = model?.contextWindow ?? 200_000;

  const segments = [
    { label: 'Cache read', tokens: u.cacheRead },
    { label: 'Cache write', tokens: u.cacheWrite },
    { label: 'Input', tokens: u.inputTokens },
    { label: 'Reasoning', tokens: u.reasoningTokens },
    { label: 'Output', tokens: u.outputTokens },
  ];

  return (
    <PanelSection
      title="Context window"
      defaultOpen={false}
      badge={<span className="ml-1.5 font-mono font-normal normal-case tracking-normal">{formatNumber(contextWindow)}</span>}
    >
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center justify-between">
            <span className="text-muted-foreground">{s.label}</span>
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
      badge={
        <span className="ml-1.5 flex items-center gap-1 font-normal normal-case tracking-normal">
          {toolAvailable ? (
            <>
              <CheckCircle2 className="size-2.5 text-emerald-400" />
              <span className="text-[10px]">active</span>
            </>
          ) : (
            <>
              <XCircle className="size-2.5 text-muted-foreground/50" />
              <span className="text-[10px]">inactive</span>
            </>
          )}
        </span>
      }
      action={
        <button
          type="button"
          disabled={!session.workspaceId || isReindexing}
          onClick={() => reindex()}
          title="Re-index this workspace's files into the RAG store"
          // Mirrors the mockup's .head-action: compact bordered pill. Spinner
          // replaces the icon while ingesting; disabled greys it out.
          className="inline-flex items-center gap-1 h-5 px-2 rounded border border-border bg-transparent text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:border-accent hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`size-3 ${isReindexing ? 'animate-spin' : ''}`} />
          Re-Index
        </button>
      }
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground flex-1  text-[12px]">Memory</span>
          <span className={`text-[11px] ${toolAvailable ? 'text-foreground' : 'text-muted-foreground/60'}`}>
            {toolAvailable ? 'available' : modelReady ? 'workspace off' : 'no model'}
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
            <span className="text-muted-foreground text-[12px]">Last indexed</span>
            <span className="text-[11px] text-muted-foreground/70">{lastIndexed}</span>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground text-[12px]">Embedder</span>
          <span className="font-mono text-[10px] text-muted-foreground/70 truncate max-w-[60%] text-right">
            {status?.embedderId ?? '—'}
          </span>
        </div>
      </div>
    </PanelSection>
  );
}
