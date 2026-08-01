import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import * as api from './api/client';
import { useUi } from './stores/ui';
import { toast } from './toast';
import type { RagInitProgressEvent } from '@/types';

/**
 * Module-level QueryClient singleton. Exported so non-React code (e.g. the
 * keyboard-shortcut dispatcher in shortcutActions.ts) can read cached query
 * data — `getQueryData(['sessions', wsId])` for session cycling — without a
 * hook context. App.tsx consumes this same instance via QueryClientProvider.
 */
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
// Agent settings (Settings → Permissions & caps)
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

/** Archived-session headers only (no message bodies) — drives the Archived section. */
export function useArchivedSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? qk.archivedSessions(workspaceId) : ['archivedSessions', 'none'],
    queryFn: () => (workspaceId ? api.listArchivedSessions(workspaceId) : Promise.resolve([])),
    enabled: !!workspaceId,
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
  /** LiteLLM catalog canonical id, when the model was matched at fetch time. */
  catalogId?: string;
  /** "$in / $out per Mtok" price rate, when the catalog has pricing. */
  priceLabel?: string;
  /** Whether the model supports reasoning (live provider data). Drives the brain icon. */
  reasoning?: boolean;
  /** True when the model always reasons and cannot be turned off (live provider data). */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels the model accepts, e.g. ['high','medium','low'] (live provider data). */
  supportedEfforts?: string[];
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
        reasoningMandatory: m.reasoningMandatory,
        supportedEfforts: m.supportedEfforts,
        priceLabel: m.priceLabel,
      });
    }
  }
  return { models, isLoading };
}

/**
 * Find a single model + its provider. Pass both ids when the same model id
 * may exist under multiple providers (e.g. an Anthropic-style and an
 * OpenAI-style gateway exposing the same name); pass providerId=null to
 * fall back to first-match, used when restoring from old sessions that
 * didn't persist the provider half of the selection.
 */
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

// ============================================================
// Session lifecycle — rename / archive / unarchive / delete
// Each invalidates both the active sessions list and the archived
// manifest for the same workspace, so the UI can move a row from
// one section to the other without a manual refetch.
// ============================================================

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.archivedSessions(workspaceId) });
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

// ============================================================
// Workspace lifecycle — archive / unarchive / delete + rename.
// Workspace mutations also invalidate the workspace's session
// queries because the cascade (archive/delete) moves or removes
// sessions belonging to this workspace.
//
// Rename uses api.updateWorkspace (the existing patch-shape IPC),
// so no new IPC channel is required for workspace rename.
// ============================================================

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
// Git source control
// ============================================================

export function useGitStatus(workspaceId: string | null, sessionId?: string | null) {
  // Include sessionId in the key so a workspace + worktree session don't
  // share cached results — they have different dirty files.
  const key = sessionId ? ['gitStatus', workspaceId, sessionId] : workspaceId ? qk.gitStatus(workspaceId) : ['gitStatus', 'none'];
  return useQuery({
    queryKey: key,
    queryFn: () => (workspaceId ? api.gitStatus(workspaceId, sessionId ?? undefined) : Promise.resolve([])),
    enabled: !!workspaceId,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.gitStatus(workspaceId) }),
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

/**
 * Trigger a full re-index of a workspace (the "Re-Index" button in the
 * Inspector's Memory section). Wraps `initRagWorkspace` — the same IPC the
 * initial ingest uses — and invalidates the rag-status query on completion so
 * the chunk count + last-indexed time refresh automatically. Exposes
 * `isReindexing` for the button's spinner state.
 *
 * Progress events stream over `tide:rag:initProgress` (handled separately by
 * the RAG panel); this hook only tracks request lifecycle.
 */
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
