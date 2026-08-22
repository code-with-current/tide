/** FloatingPermissionCard: centered overlay above the chat surfacing pending
 *  permission prompts (one card per pending tool call). Reads from the UI
 *  store. Distinct by design — elevated stack, warning pill, top gradient —
 *  so a blocked turn is impossible to miss regardless of panel state. */

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
    <div className="absolute inset-x-0 top-0 z-50 pointer-events-none">
      {/* Soft gradient from the top edge — anchors the stack visually to the
          top of the chat column without a hard backdrop. */}
      <div
        className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-warning/[0.07] to-transparent"
        aria-hidden="true"
      />

      {/* Fixed-width stack, centered */}
      <div className="pointer-events-auto mx-auto w-[26rem] max-w-[calc(100%-1.5rem)] pt-3">
        {/* Count pill — floats above the cards */}
        <div className="mx-auto mb-2 flex w-fit items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-3 py-1 text-[0.7857rem] font-medium text-warning shadow-sm backdrop-blur-sm">
          <ShieldAlert className="size-3.5" aria-hidden="true" />
          {pending.length} action{pending.length > 1 ? 's' : ''} awaiting your review
        </div>

        <div className="space-y-2 pb-2">
          {pending.map((tc) => (
            <PermissionCard
              key={tc.id}
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
          ))}
        </div>
      </div>
    </div>
  );
}
