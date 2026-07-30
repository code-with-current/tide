/**
 * FloatingPermissionCard — a fixed-position overlay that surfaces pending
 * permission prompts above the composer, replacing the Inspector's Review
 * section. Renders one card per pending tool call, stacked vertically.
 *
 * Reads directly from the UI store (like the old ReviewSection did), so it
 * works independently of TurnBlock/OneCodeToolRow's inline card. The inline
 * card in the chat stream can be kept or removed — this floating variant
 * ensures the prompt is always visible even when the tool row is scrolled
 * out of view.
 */
import { ShieldAlert } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { PermissionCard } from './PermissionCard';
import type { AutonomyMode } from '@/types';

/** IPC approve — mirrors InspectorTab's ipcApprove. */
function ipcApprove(
  sessionId: string,
  ids: string[],
  newMode?: AutonomyMode,
  remember?: 'session' | 'project',
) {
  if (!sessionId || !window.tideIpc) return;
  window.tideIpc.approveToolCalls(sessionId, ids, newMode, remember);
  useUi.getState().removePermissionCards(sessionId, ids);
  if (newMode) useUi.getState().setAutonomyMode(newMode);
}

function ipcReject(sessionId: string, ids: string[], reason?: string) {
  if (!sessionId || !window.tideIpc) return;
  window.tideIpc.rejectToolCalls(sessionId, ids, reason);
  useUi.getState().removePermissionCards(sessionId, ids);
}

export function FloatingPermissionCard({ sessionId }: { sessionId: string | null }) {
  const permissionRequest = useUi((s) =>
    sessionId ? s.streams[sessionId]?.permissionRequest : null,
  );

  const pending = permissionRequest?.toolCalls ?? [];
  if (pending.length === 0) return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-50 pointer-events-none">
      <div className="pointer-events-auto">
        {/* Header badge */}
        <div className="flex items-center justify-center gap-1.5 text-[11px] text-warning font-medium bg-background p-4">
          <ShieldAlert className="size-3.5" />
          {pending.length} action{pending.length > 1 ? 's' : ''} awaiting your review
        </div>
        <div className="p-2 space-y-2">
        {/* Cards */}
        {pending.map((tc) => (
          <PermissionCard
            key={tc.id}
            call={tc}
            variant="split"
            timeoutAt={permissionRequest?.timeoutAt}
            onApprove={
              sessionId
                ? (newMode, remember) => ipcApprove(sessionId, [tc.id], newMode, remember)
                : undefined
            }
            onReject={
              sessionId
                ? (reason) => ipcReject(sessionId, [tc.id], reason)
                : undefined
            }
          />
        ))}
          </div>
      </div>
      </div>
  );
}
