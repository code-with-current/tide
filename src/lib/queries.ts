import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import * as api from './api/client';
import { useUi, COMPOSER_NEW_KEY, FORK_ATTACHMENT_PATH } from './stores/ui';
import { toast } from './toast';
import type { RagDownloadProgressEvent, RagInitProgressEvent, ReasoningOption, WorkspaceProgressEvent } from '@/types';

/** Module-level QueryClient singleton. Exported so non-React code (e.g. shortcutActions.ts) can read cached query data without a hook context. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});
import { useTabs } from './stores/tabs';

export const qk = {
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspaces', id] as const,
  sessions: (workspaceId: string) => ['sessions', workspaceId] as const,
  session: (id: string) => ['sessions', 'detail', id] as const,
  archivedSessions: (workspaceId: string) => ['archivedSessions', workspaceId] as const,
  providers: ['providers'] as const,
  fileTree: (workspaceId: string) => ['fileTree', workspaceId] as const,
  terminal: (sessionId: string) => ['terminal', sessionId] as const,
  gitStatus: (workspaceId: string) => ['gitStatus', workspaceId] as const,
  sessionMessagesV2: (sessionId: string) => ['session-messages-v2', sessionId] as const,
  ragStatus: (workspaceId: string) => ['ragStatus', workspaceId] as const,
  agentSettings: ['agentSettings'] as const,
};

// ============================================================
// Workspaces
// ============================================================

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: api.listWorkspaces });
}

// ============================================================
// Agent settings (Settings → Permissions & Caps)
// ============================================================

/** Cached agentSettings (maxSteps, defaultAutonomy, etc.). Used by UI that
 *  needs the configured iteration cap (SessionHero, InspectorTab) instead of
 *  a hardcoded number. Stays in sync with the settings panel via the shared
 *  query key — edits there invalidate via useUpdateAgentSettings. */
export function useAgentSettings() {
  return useQuery({
    queryKey: qk.agentSettings,
    queryFn: () => window.tideIpc?.getAgentSettings() ?? null,
  });
}

/** Patch one or more agentSettings fields; invalidates the cache so every
 *  useAgentSettings consumer re-fetches. Mirrors the other mutation hooks. */
export function useUpdateAgentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      window.tideIpc?.updateAgentSettings(patch) ??
        Promise.reject(new Error('IPC not available')),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agentSettings }),
  });
}

// ============================================================
// Sessions
// ============================================================

export function useSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? qk.sessions(workspaceId) : ['sessions', 'none'],
    queryFn: () => (workspaceId ? api.listSessions(workspaceId) : Promise.resolve([])),
    enabled: !!workspaceId,
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: id ? qk.session(id) : ['sessions', 'detail', 'none'],
    queryFn: () => (id ? api.getSession(id) : Promise.resolve(undefined)),
    enabled: !!id,
  });
}

/** Hard-evict a session's windowed v2 timeline. removeQueries, not
 *  invalidateQueries — on re-entry the window must refetch from the newest
 *  page instead of flashing a stale copy, and cached per-session windows
 *  would otherwise accumulate across every session the user visits. Called
 *  from useSessionMessagesV2's switch/unmount cleanup. */
export function evictSessionMessagesV2(sessionId: string | null): void {
  if (!sessionId) return;
  queryClient.removeQueries({ queryKey: qk.sessionMessagesV2(sessionId) });
}

/** Archived-session headers only (no message bodies) — drives the Archived section. */
export function useArchivedSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? qk.archivedSessions(workspaceId) : ['archivedSessions', 'none'],
    queryFn: () => (workspaceId ? api.listArchivedSessions(workspaceId) : Promise.resolve([])),
    enabled: !!workspaceId,
  });
}

/** Sub-agent dispatch child sessions for a parent session. */
export function useDispatches(sessionId: string | null) {
  return useQuery({
    queryKey: sessionId ? ['dispatches', sessionId] : ['dispatches', 'none'],
    queryFn: () => (sessionId ? api.listDispatches(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
    staleTime: 30_000,
  });
}

// ============================================================
// Providers & Models
// ============================================================

export function useProviders() {
  return useQuery({ queryKey: qk.providers, queryFn: api.listProviders });
}

/** A flattened model derived from the providers query. */
export interface ModelOption {
  modelId: string;
  alias: string;
  providerId: string;
  providerName: string;
  apiStyle: 'openai' | 'anthropic';
  contextWindow: number;
  /** models.dev catalog canonical id, when the model was matched at fetch time. */
  catalogId?: string;
  /** "$in / $out per Mtok" price rate, when the catalog has pricing. */
  priceLabel?: string;
  /** Whether the model supports reasoning (live provider data). Drives the brain icon. */
  reasoning?: boolean;
  /** Whether the model accepts image input. Drives the eye icon. */
  vision?: boolean;
  /** True when the model always reasons and cannot be turned off (live provider data). */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels the model accepts, e.g. ['high','medium','low'] (live provider data). */
  supportedEfforts?: string[];
  /** Reasoning contracts (effort / budget_tokens / toggle) from models.dev
   *  catalog enrichment — drives the resolver's wire format and the
   *  toggle-only UI in the thinking-level selector. */
  reasoningContracts?: ReasoningOption[];
  /** Max output tokens per response — subtracted from contextWindow to show
   *  the real usable input budget in the context meter. */
  maxCompletionTokens?: number;
}

/** Reasoning support — re-exported from the shared model-capabilities module. */
export { supportsThinking } from './model-capabilities';
export { formatPriceRate } from './model-catalog';

/**
 * Flattened list of all models across all enabled providers.
 * Use this instead of the old static MODEL_OPTIONS.
 */
export function useModels(): { models: ModelOption[]; isLoading: boolean } {
  const { data: providers, isLoading } = useProviders();
  const models: ModelOption[] = [];
  for (const p of providers ?? []) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      models.push({
        modelId: m.modelId,
        alias: m.alias,
        providerId: p.id,
        providerName: p.name,
        apiStyle: p.apiStyle,
        contextWindow: m.contextWindow,
        catalogId: m.catalogId,
        reasoning: m.reasoning,
        vision: m.vision,
        reasoningMandatory: m.reasoningMandatory,
        supportedEfforts: m.supportedEfforts,
        reasoningContracts: m.reasoningContracts,
        priceLabel: m.priceLabel,
        maxCompletionTokens: m.max_completion_tokens,
      });
    }
  }
  return { models, isLoading };
}

/** Find a model+provider by ids; pass providerId=null to first-match (used when restoring legacy sessions that didn't persist the provider half). */
export function useModelOption(providerId: string | null, modelId: string | null): ModelOption | undefined {
  const { models } = useModels();
  if (!modelId) return undefined;
  return (
    models.find((m) => m.modelId === modelId && (providerId === null || m.providerId === providerId)) ??
    // Stale (providerId, modelId) pair — provider disabled, removed, or a
    // pre-migration session. Fall back to first-match so the UI still resolves.
    models.find((m) => m.modelId === modelId)
  );
}

// ============================================================
// Mutations
// ============================================================

export function useAddProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.addProvider,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.providers }),
  });
}

// ===== Session lifecycle: rename/archive/unarchive/delete (invalidates both active + archived lists so rows can move between sections).

export function useRenameSession(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
    },
  });
}

export function useArchiveSession(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveSession(id),
    onSuccess: (_data, sessionId) => {
      qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
      // If the archived session was active, switch to the next available one
      // (most recently updated), or fall back to the new-session view.
      const ui = useUi.getState();
      if (ui.activeSessionId === sessionId) {
        const sessions = (qc.getQueryData(qk.sessions(workspaceId)) as any[] | undefined) ?? [];
        const remaining = sessions
          .filter((s) => s.id !== sessionId)
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        if (remaining[0]) {
          ui.setActiveSession(remaining[0].id);
        } else {
          useUi.setState({ activeSessionId: null, mainView: 'new' });
        }
      }
    },
  });
}

export function useUnarchiveSession(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.unarchiveSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
    },
  });
}

export function useDeleteSession(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_data, sessionId) => {
      // Clean up all session-specific state: kill PTYs, purge terminals,
      // tabs, open files, streams. Without this, zombie PTYs accumulate.
      useUi.getState().clearSessionData(sessionId);
      useTabs.getState().clearSessionTabs(sessionId);
      qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
    },
  });
}

/** Attachment path that carries the forked session's last answer into the
 *  new-session composer. Re-exported from the ui store, which pairs it with
 *  `pendingFork` — clearing the intent also drops this attachment. */
export { FORK_ATTACHMENT_PATH };

/** Initiate a fork: grab the source session's last answer text, add it as a
 *  composer attachment, mark the fork intent, and redirect to the
 *  new-session screen — which renders its fork variant (hero + banner) from
 *  `pendingFork`. No session is created until the user sends — the
 *  attachment rides along on the first message. `resultText` is used directly
 *  when the caller already has it (AnswerBlock); otherwise fetched from the
 *  session. `origin` records how the fork started so the screen can explain
 *  itself (model switch vs. explicit fork). Text only — no blocks. */
export async function initiateFork(
  sourceSessionId: string,
  resultText?: string,
  origin: 'menu' | 'result' | 'model' = 'menu',
): Promise<void> {
  const session = await api.getSession(sourceSessionId);
  let text = resultText?.trim();
  if (!text) {
    const lastAnswer = session?.messages
      ?.slice().reverse()
      .find((m: { role: string; content?: string }) => m.role === 'assistant' && m.content?.trim());
    text = lastAnswer?.content?.trim();
  }
  if (!text || !session) {
    toast.error('Nothing to fork', {
      description: 'That session has no answer to carry over yet.',
    });
    return;
  }

  const ui = useUi.getState();
  // A fork always starts from a clean draft — whatever the user was typing
  // stays in its own draft entry in the sidebar. startNewDraft clears any
  // prior fork intent; setPendingFork re-arms it for THIS fork afterwards.
  ui.startNewDraft();
  ui.clearComposerAttachments(COMPOSER_NEW_KEY);
  ui.addComposerAttachment(COMPOSER_NEW_KEY, {
    path: FORK_ATTACHMENT_PATH,
    kind: 'paste',
    content: text,
  });
  ui.setPendingFork({
    sourceSessionId,
    sourceTitle: session.title,
    sourceModelId: session.modelId,
    origin,
  });
  useUi.setState({ sessionsPanelOpen: false });
}

// ===== Workspace lifecycle: archive/unarchive/delete + rename (uses api.updateWorkspace; invalidates session queries too because cascades move/remove sessions).

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.updateWorkspace(id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workspaces }),
    onError: (e) => toast.error('Rename failed', { description: e instanceof Error ? e.message : undefined }),
  });
}

function invalidateWorkspaceAndSessions(qc: ReturnType<typeof useQueryClient>, workspaceId: string) {
  qc.invalidateQueries({ queryKey: qk.workspaces });
  qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
  qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
}

export function useArchiveWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveWorkspace(id),
    onSuccess: () => { invalidateWorkspaceAndSessions(qc, workspaceId); toast.success('Workspace archived'); },
    onError: (e) => toast.error('Archive failed', { description: e instanceof Error ? e.message : undefined }),
  });
}

export function useUnarchiveWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.unarchiveWorkspace(id),
    onSuccess: () => { invalidateWorkspaceAndSessions(qc, workspaceId); toast.success('Workspace restored'); },
    onError: (e) => toast.error('Restore failed', { description: e instanceof Error ? e.message : undefined }),
  });
}

export function useDeleteWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => { invalidateWorkspaceAndSessions(qc, workspaceId); toast.success('Workspace deleted'); },
    onError: (e) => toast.error('Delete failed', { description: e instanceof Error ? e.message : undefined }),
  });
}

// ============================================================
// File tree + terminal
// ============================================================

export function useFileTree(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? qk.fileTree(workspaceId) : ['fileTree', 'none'],
    queryFn: () => (workspaceId ? api.getFileTree(workspaceId) : Promise.resolve([])),
    enabled: !!workspaceId,
  });
}

export function useTerminalLines(sessionId: string | null) {
  return useQuery({
    queryKey: sessionId ? qk.terminal(sessionId) : ['terminal', 'none'],
    queryFn: () => (sessionId ? api.getTerminalLines(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
  });
}

// ============================================================
// Git
// ============================================================

export function useGitStatus(workspaceId: string | null, sessionId?: string | null) {
  // Include sessionId in the key so a workspace + worktree session don't
  // share cached results — they have different dirty files.
  const key = sessionId ? ['gitStatus', workspaceId, sessionId] : workspaceId ? qk.gitStatus(workspaceId) : ['gitStatus', 'none'];
  const qc = useQueryClient();
  // Main-process watcher pushes `tide:gitChanged` when the working tree
  // changes on disk (editor, terminal, other apps) — refetch immediately.
  useEffect(() => {
    if (!workspaceId) return;
    const onGitChanged = ({ workspaceId: wsId }: { workspaceId: string }) => {
      if (wsId === workspaceId) qc.invalidateQueries({ queryKey: ['gitStatus', workspaceId] });
    };
    const off = window.tideIpc?.onGitChanged?.(onGitChanged);
    return () => { off?.(); };
  }, [workspaceId, qc]);
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitStatus(workspaceId, sessionId ?? undefined) : Promise.resolve([])),
    enabled: !!workspaceId,
  });
}

/** Live branch + HEAD for the session's working directory (worktree-aware).
 *  Refetch after a git tool runs via MainScreen's git-tool invalidation. */
export function useGitBranchInfo(workspaceId: string | null, sessionId?: string | null) {
  const key = ['gitBranch', workspaceId, sessionId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitBranchInfo(workspaceId, sessionId ?? undefined) : Promise.resolve({ branch: null, headCommit: null })),
    enabled: !!workspaceId,
  });
}

/** Recently checked-out branches (max 5, worktree-aware) for the branch switcher. */
export function useGitRecentBranches(workspaceId: string | null, sessionId?: string | null, enabled = true) {
  const key = ['gitRecentBranches', workspaceId, sessionId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitRecentBranches(workspaceId, sessionId ?? undefined) : Promise.resolve([])),
    enabled: !!workspaceId && enabled,
    staleTime: 5_000,
  });
}

export function useGitLog(workspaceId: string | null, sessionId?: string | null, limit = 100) {
  const key = ['gitLog', workspaceId, sessionId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitLog(workspaceId, sessionId ?? undefined, limit) : Promise.resolve([] as import('@/lib/api/client').GitCommit[])),
    enabled: !!workspaceId,
    staleTime: 15_000,
  });
}

/** Bulk working-tree op (stage-all / unstage-all / restore-all / stash / stash-pop).
 *  Invalidates status + history + stash list on success. */
export function useGitBulk(workspaceId: string | null, sessionId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: import('@/lib/api/client').GitBulkOp) => api.gitBulk(workspaceId!, op, sessionId ?? undefined),
    onSuccess: (_d, _op) => {
      if (workspaceId) {
        qc.invalidateQueries({ queryKey: qk.gitStatus(workspaceId) });
        qc.invalidateQueries({ queryKey: ['gitLog', workspaceId] });
        qc.invalidateQueries({ queryKey: ['gitStashList', workspaceId] });
      }
    },
  });
}

export function useGitStashList(workspaceId: string | null, sessionId?: string | null) {
  const key = ['gitStashList', workspaceId, sessionId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitStashList(workspaceId, sessionId ?? undefined) : Promise.resolve([] as import('@/lib/api/client').GitStash[])),
    enabled: !!workspaceId,
    staleTime: 10_000,
  });
}

/** Files changed in a commit — drives the commit-details side panel. */
export function useCommitFiles(workspaceId: string | null, sha: string | null, sessionId?: string | null) {
  return useQuery({
    queryKey: ['gitCommitFiles', workspaceId, sha, sessionId] as const,
    queryFn: () => (workspaceId && sha ? api.gitCommitFiles(workspaceId, sha, sessionId ?? undefined) : Promise.resolve([] as import('@/lib/api/client').GitFileChange[])),
    enabled: !!workspaceId && !!sha,
    staleTime: 30_000,
  });
}

export function useGitStage(workspaceId: string, sessionId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, stage }: { path: string; stage: boolean }) =>
      api.gitStage(workspaceId, path, stage, sessionId ?? undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.gitStatus(workspaceId) }),
  });
}

export function useGitCommit(workspaceId: string, sessionId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => api.gitCommit(workspaceId, message, sessionId ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.gitStatus(workspaceId) });
      // A new commit lands at the top of history — refresh the Git Panel History tab.
      qc.invalidateQueries({ queryKey: ['gitLog', workspaceId] });
    },
  });
}

// ============================================================
// RAG status (Memory & RAG panel)
// ============================================================

/** Read-only RAG status snapshot for the active workspace. Refetch on
 *  invalidation (after a ragConfig patch) — staleTime:0 so the panel always
 *  reflects the current local-availability probe. */
export function useRagStatus(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? qk.ragStatus(workspaceId) : ['ragStatus', 'none'],
    queryFn: () => (workspaceId ? api.ragStatus(workspaceId) : Promise.resolve(null)),
    enabled: !!workspaceId,
    staleTime: 0,
  });
}

/** Patch the workspace's ragConfig. Re-reads the current hydrated config
 *  from the main process (via ragStatus) so the patch is a merge, not a
 *  clobber — preserving fields the panel doesn't touch (embedderId is set
 *  by the resolver at build time, not by this UI). */
export function useUpdateRagConfig(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { cloudAllowed?: boolean; chunkTokens?: number }) => {
      if (!workspaceId) throw new Error('no active workspace');
      const status = await api.ragStatus(workspaceId);
      if ('error' in status || !status.embedderId) {
        // No index yet — still allow persisting the user's preference; the
        // resolver will honor it at build time. Use defaults for the merge.
        const base = {
          embedderId: 'local-code-512' as const,
          dim: 384,
          cloudAllowed: false,
          chunkTokens: 384,
        };
        return api.updateWorkspace(workspaceId, { ragConfig: { ...base, ...patch } });
      }
      const current = {
        embedderId: status.embedderId,
        dim: status.dim,
        cloudAllowed: status.cloudAllowed,
        chunkTokens: status.chunkTokens,
      };
      return api.updateWorkspace(workspaceId, { ragConfig: { ...current, ...patch } });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
}

/** Trigger a full workspace re-index (Inspector's "Re-Index" button) via initRagWorkspace and invalidate rag-status; progress streams separately via `tide:rag:initProgress`. */
export function useReindexWorkspace(workspaceId: string | null) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => (workspaceId ? api.initRagWorkspace(workspaceId) : Promise.reject(new Error('no workspace'))),
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
  return {
    reindex: mutation.mutate,
    isReindexing: mutation.isPending,
  };
}

export function useDownloadRagModel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.downloadRagModel(),
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
}

export function useEnableRagWorkspace(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: string) => api.enableRagWorkspace(target),
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
}

export function useDisableRagWorkspace(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: string) => api.disableRagWorkspace(target),
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
}

export function useInitRagWorkspace(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: string) => api.initRagWorkspace(target),
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: qk.ragStatus(workspaceId) });
    },
  });
}

export function useRagInitProgress(workspaceId: string | null): RagInitProgressEvent | null {
  const [event, setEvent] = useState<RagInitProgressEvent | null>(null);
  useEffect(() => {
    if (!workspaceId) { setEvent(null); return; }
    setEvent(null);
    const unsubscribe = api.subscribeRagInitProgress((e) => {
      if (e.workspaceId === workspaceId) setEvent(e);
    });
    return unsubscribe;
  }, [workspaceId]);
  return event;
}

/** Live workspace-creation milestones for a given requestId. Returns a map
 *  keyed by step id → latest event, so the dialog can render each checklist
 *  row from its real status (active/done/failed) instead of fake timers. */
export function useWorkspaceSteps(requestId: string | null): Record<string, WorkspaceProgressEvent> {
  const [steps, setSteps] = useState<Record<string, WorkspaceProgressEvent>>({});
  useEffect(() => {
    if (!requestId) { setSteps({}); return; }
    setSteps({});
    const unsubscribe = api.subscribeWorkspaceProgress((e) => {
      if (e.requestId !== requestId) return;
      setSteps((prev) => ({ ...prev, [e.step]: e }));
    });
    return unsubscribe;
  }, [requestId]);
  return steps;
}

/** Live model-download progress (global — one model, not per-workspace).
 *  Returns null when no download is in flight. Resets to null on the
 *  'done'/'failed' terminal events after the consumer reads them. */
export function useRagDownloadProgress(): RagDownloadProgressEvent | null {
  const [event, setEvent] = useState<RagDownloadProgressEvent | null>(null);
  useEffect(() => {
    const unsubscribe = api.subscribeRagDownloadProgress((e) => {
      setEvent(e);
      // Auto-clear terminal events after a brief delay so the UI doesn't
      // show a stale "done" forever.
      if (e.phase === 'done' || e.phase === 'failed') {
        setTimeout(() => setEvent(null), 2000);
      }
    });
    return unsubscribe;
  }, []);
  return event;
}
