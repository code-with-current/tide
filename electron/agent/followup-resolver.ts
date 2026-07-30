/**
 * Per-session followup resolver for the ask_followup_question HITL tool.
 *
 * Mirrors permission-resolver.ts: a tool's execute emits a `followup` event,
 * awaits `waitForFollowupPick`, and the user's pick arrives via the existing
 * `submitFollowup` IPC handler (which calls `resolveFollowup`). The SDK's
 * `streamText` naturally pauses the step while the execute awaits.
 *
 * Keyed by toolCallId (not sessionId) so that if the SDK ever dispatches two
 * ask_followup calls in parallel within one step, each gets its own slot
 * instead of the second clobbering the first's resolver. The session index
 * on each entry makes `abortFollowup(sessionId)` resolve only that session's
 * pending asks — important when multiple sessions stream concurrently.
 */

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

/**
 * Wait for the user's pick. Resolves when `resolveFollowup` is called with
 * the same toolCallId, or when the turn aborts (via `abortFollowup`, with
 * answer null).
 */
export function waitForFollowupPick(sessionId: string, toolCallId: string): Promise<FollowupPick> {
  return new Promise<FollowupPick>((resolve) => {
    pending.set(toolCallId, { sessionId, resolve });
  });
}

/** Resolve the pending ask (if any) for a toolCallId. Returns true if a
 *  pending resolver was found and consumed. Called by the submitFollowup
 *  IPC handler. (`_sessionId` is unused — resolution is keyed by toolCallId —
 *  but kept in the signature for parity with resolvePermission + the IPC
 *  handler's (sessionId, toolCallId, answer) shape.) */
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
