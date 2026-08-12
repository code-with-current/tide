import { memo, useMemo, useCallback } from 'react';
import type { Message, DiffHunk } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { useSessions } from '@/lib/queries';
import * as api from '@/lib/api/client';
import { TurnWorkingFooter } from './turn-header';
import { BlockList } from '@/components/chat/turn/block-list';
import { PermissionSurfaceContext, type PermissionSurface } from '../permissions/permission-context';

export function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (
    { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', go: 'go', rs: 'rust', md: 'markdown', json: 'json' }[ext ?? ''] ?? 'text'
  );
}

/** TurnBlock: orchestrator for the canonical block-stream renderer. Renders header + BlockList + provides the permission surface via context. */
export const TurnBlock = memo(function TurnBlock({
  message, streaming, stopReason,
  onApproveToolCalls, onRejectToolCalls,
}: {
  message: Message;
  streaming: boolean;
  pendingToolCallIds?: string[];
  stopReason?: string | null;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
}) {
  const activeSessionId = useUi(s => s.activeSessionId);
  const activeWorkspaceId = useUi(s => s.activeWorkspaceId);
  const openFile = useUi(s => s.openFile);
  const { data: sessions } = useSessions(activeWorkspaceId ?? null);
  const activeSession = activeSessionId
    ? sessions?.find((s) => s.id === activeSessionId)
    : undefined;
  // The live pending-permission set (session-scoped). Provided to descendants
  // (ToolRow) via PermissionSurfaceContext so each pending tool row can
  // render its own inline <PermissionCard> without prop-drilling. The zustand
  // subscription bypasses memo, so permission changes re-render this subtree.
  const permissionRequest = useUi((s) =>
    activeSessionId ? s.streams[activeSessionId]?.permissionRequest : null,
  );
  // Whether autocompact is running for this turn — drives the in-stream
  // "Compacting context" indicator inside BlockList. Read from the same store
  // so it updates live without going through the memo comparator.
  const compacting = useUi((s) =>
    activeSessionId ? Boolean(s.streams[activeSessionId]?.compacting) : false,
  );
  // Pre-turn git HEAD sha — captured when the user sent the message that
  // started this turn. Used for per-file undo in FileChangesSummary.
  const preTurnSha = useUi((s) =>
    activeSessionId ? s.preTurnShas[activeSessionId] : undefined,
  );
  const handleViewFile = (path: string) => {
    if (!path || !activeSessionId) return;
    openFile(activeSessionId, { id: path, path, language: langFromPath(path) });
  };

  const handleViewFileDiff = useCallback(async (entry: { path: string; hunks?: DiffHunk[] }) => {
    if (!entry.path || !activeSessionId) return;
    // Fetch the full git diff (pre-turn sha vs working tree) so the viewer
    // shows the complete file with context lines + changes — not just the
    // isolated hunk fragments from the tool blocks.
    let hunks = entry.hunks;
    if (activeWorkspaceId && preTurnSha) {
      try {
        // Large context (100000) so the diff shows the full file, not just
        // the changed regions — matches what users expect from a diff viewer.
        const fullDiff = await api.gitDiff(activeWorkspaceId, entry.path, false, activeSessionId, 100000);
        if (fullDiff && fullDiff.length > 0) hunks = fullDiff;
      } catch { /* fall back to tool-block hunks */ }
    }
    openFile(activeSessionId, {
      id: entry.path, path: entry.path, language: langFromPath(entry.path),
      diffHunks: hunks,
    });
  }, [activeSessionId, activeWorkspaceId, preTurnSha, openFile]);

  const handleUndoFile = useCallback(async (filePath: string) => {
    if (!activeWorkspaceId || !preTurnSha) return;
    await api.gitRestoreFile(activeWorkspaceId, filePath, preTurnSha, activeSessionId ?? undefined);
  }, [activeWorkspaceId, activeSessionId, preTurnSha]);

  const stopped = stopReason === 'aborted';

  const permissionSurface: PermissionSurface = useMemo(
    () => ({
      byId: new Map((permissionRequest?.toolCalls ?? []).map((t) => [t.id, t] as const)),
      timeoutAt: permissionRequest?.timeoutAt,
      onApprove: onApproveToolCalls
        ? (id, newMode, remember) => onApproveToolCalls([id], newMode, remember)
        : undefined,
      onReject: onRejectToolCalls
        ? (id, reason) => onRejectToolCalls([id], reason)
        : undefined,
    }),
    [permissionRequest, onApproveToolCalls, onRejectToolCalls],
  );

  return (
    <PermissionSurfaceContext.Provider value={permissionSurface}>
      <div className="flex flex-col gap-0 mb-15">
        <BlockList
          blocks={message.blocks}
          streaming={streaming}
          stopped={stopped}
          stopReason={stopReason}
          sessionId={activeSessionId}
          messageId={message.id}
          totalMs={message.totalMs}
          onViewFile={handleViewFile}
          onViewFileDiff={handleViewFileDiff}
          onUndoFile={preTurnSha ? handleUndoFile : undefined}
          sessionTitle={activeSession?.title}
          sessionModelId={activeSession?.modelId}
          sessionProviderId={activeSession?.providerId}
          compacting={compacting}
        />
        {streaming && (
          <TurnWorkingFooter startedAt={message.createdAt} />
        )}
      </div>
    </PermissionSurfaceContext.Provider>
  );
}, (prev, next) => {
  if (prev.streaming !== next.streaming) return false;
  if (prev.message !== next.message) return false;
  if (prev.stopReason !== next.stopReason) return false;
  const a = prev.pendingToolCallIds ?? [];
  const b = next.pendingToolCallIds ?? [];
  if (a.length !== b.length) return false;
  if (a.length > 0 && a.join(',') !== b.join(',')) return false;
  return true;
});
