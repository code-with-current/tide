/** Per-session followup resolver for ask_followup_question: a tool's execute awaits `waitForFollowupPick`, the user's pick arrives via the submitFollowup IPC handler → resolveFollowup. Keyed by toolCallId so parallel asks don't clobber each other; sessionId on each entry scopes aborts. */

export interface FollowupPick {
  /** The user's chosen option label / free-form answer, or null when
   *  dismissed / aborted / timed out. Null → the tool returns a fallback. */
  answer: string | null;
}

interface PendingFollowup {
  sessionId: string;
  resolve: (pick: FollowupPick) => void;
}

// toolCallId → pending resolver. Single in-flight per tool call.
const pending = new Map<string, PendingFollowup>();

/** Wait for the user's pick — resolves on `resolveFollowup` (same toolCallId) or on turn abort (answer null). */
export function waitForFollowupPick(sessionId: string, toolCallId: string): Promise<FollowupPick> {
  return new Promise<FollowupPick>((resolve) => {
    pending.set(toolCallId, { sessionId, resolve });
  });
}

/** Resolve the pending ask for a toolCallId (called by submitFollowup IPC). `_sessionId` is unused (keyed by toolCallId) but kept for parity with resolvePermission + the IPC handler's (sessionId, toolCallId, answer) shape. */
export function resolveFollowup(_sessionId: string, toolCallId: string, answer: string): boolean {
  const entry = pending.get(toolCallId);
  if (!entry) return false;
  pending.delete(toolCallId);
  entry.resolve({ answer });
  return true;
}

/** Abort any pending ask for a session (e.g. user hit Stop). Resolves each
 *  with a null answer so the awaiting execute unblocks and the turn tears
 *  down cleanly instead of hanging. */
export function abortFollowup(sessionId: string): void {
  for (const [id, entry] of pending) {
    if (entry.sessionId === sessionId) {
      pending.delete(id);
      entry.resolve({ answer: null });
    }
  }
}

/** Drop all state for a session — call when the turn ends. Resolves any
 *  straggler asks with null (defensive; abortFollowup usually ran first). */
export function clearFollowupSession(sessionId: string): void {
  abortFollowup(sessionId);
}
