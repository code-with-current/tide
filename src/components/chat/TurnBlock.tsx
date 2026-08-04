import { memo, useMemo } from 'react';
import type { Message } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { TurnHeader } from './TurnHeader';
import { BlockList } from '@/components/chat/blockstream/BlockList';
import { PermissionSurfaceContext, type PermissionSurface } from './permission-context';

export function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (
    { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', go: 'go', rs: 'rust', md: 'markdown', json: 'json' }[ext ?? ''] ?? 'text'
  );
}

/**
 * TurnBlock — the orchestrator for the canonical block-stream renderer.
 *
 * Walks `message.blocks` (the new canonical shape). The BlockList component
 * handles all block routing; TurnBlock just sits above it and renders the
 * header + any pending permission prompts.
 *
 * Same data drives both streaming-expanded and completed-collapsed views.
 * Each section manages its own collapse state (component-local) so user
 * overrides stick per turn.
 */
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
  const openFile = useUi(s => s.openFile);
  // The live pending-permission set (session-scoped). Provided to descendants
  // (OneCodeToolRow) via PermissionSurfaceContext so each pending tool row can
  // render its own inline <PermissionCard> without prop-drilling. The zustand
  // subscription bypasses memo, so permission changes re-render this subtree.
  const permissionRequest = useUi((s) =>
    activeSessionId ? s.streams[activeSessionId]?.permissionRequest : null,
  );
  const handleViewFile = (path: string) => {
    if (!path || !activeSessionId) return;
    openFile(activeSessionId, { id: path, path, language: langFromPath(path) });
  };

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
      <div className="flex flex-col gap-0">
        <TurnHeader
          blocks={message.blocks}
          streaming={streaming}
          stopReason={stopReason}
        />
        <BlockList
          blocks={message.blocks}
          streaming={streaming}
          stopped={stopped}
          stopReason={stopReason}
          sessionId={activeSessionId}
          messageId={message.id}
          onViewFile={handleViewFile}
        />
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
