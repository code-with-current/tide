/** FloatingPermissionCard: fixed overlay above the composer surfacing pending permission prompts (one card per pending tool call). Reads from UI store; complements the inline card. */
import { ShieldAlert } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { PermissionCard } from './permission-card';
import type { AutonomyMode } from '@/types';

/** IPC approve — mirrors useChatStream's approveToolCalls. */
function ipcApprove(
  sessionId: string,
  ids: string[],
  newMode?: AutonomyMode,
  remember?: boolean,
) {
  if (!sessionId || !window.tideIpc) return;
  window.tideIpc.approveToolCalls(sessionId, ids, newMode, remember);
  // Mode escalation auto-approves every other pending ask main-side —
  // dismiss their cards too.
  const dismissIds = newMode
    ? (useUi.getState().streams[sessionId]?.permissionRequest?.toolCalls ?? []).map((tc) => tc.id)
    : ids;
  useUi.getState().removePermissionCards(sessionId, dismissIds);
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
      {/* Fixed-width column centered over the chat — cards don't stretch with
          the window, so the command preview and action rows stay readable. */}
      <div className="pointer-events-auto mx-auto w-[26rem] max-w-[calc(100%-1.5rem)]">
        {/* Header badge */}
        <div className="flex items-center justify-center gap-1.5 text-[0.7857rem] text-warning font-medium bg-background p-4">
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
