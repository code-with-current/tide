/** FloatingPermissionCard: permission prompts anchored directly above the
 *  chat composer (same placement as the OptionsPopup question popover) —
 *  where the user's eyes already are when a turn pauses. One card per pending
 *  tool call, stacked bottom-up so the first ask sits nearest the composer. */

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
    // Anchored above the composer like the OptionsPopup: absolute bottom-full
    // inside the composer's relative wrapper, matching its width. Overflow
    // scrolls so a burst of parallel asks can't push cards off-screen.
    <div className="absolute bottom-full left-0 right-0 mb-2 z-40 max-h-[60vh] overflow-y-auto scroll pointer-events-auto">
      <div className="flex flex-col-reverse gap-2 pb-1">
        {pending.map((tc) => (
          <div key={tc.id} className="mx-auto w-full max-w-[36rem]">
            <PermissionCard
              call={tc}
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
          </div>
        ))}
      </div>
      {/* Count pill — pinned above the newest card */}
      <div className="mx-auto mb-1.5 mt-1 flex w-fit items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-3 py-1 text-[0.7857rem] font-medium text-warning shadow-sm backdrop-blur-sm">
        <ShieldAlert className="size-3.5" aria-hidden="true" />
        {pending.length} action{pending.length > 1 ? 's' : ''} awaiting your review
      </div>
    </div>
  );
}
