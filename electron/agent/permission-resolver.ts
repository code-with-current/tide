/** Per-session, per-toolCallId permission resolver + pending-ask store: parallel tool calls each await their own verdict (keyed by toolCallId via AsyncLocalStorage), so the UI renders one card per call with no serialization. approve/reject → resolvePermission; stop → abortPermission. */

import type { AutonomyMode } from '../../src/types';

export interface PermissionVerdict {
  approved: boolean;
  /** Set when the user picked a mode escalation (plan→edit). Sticks for
   *  the rest of the turn — withPermission mutates ctx.autonomyMode. */
  newMode?: AutonomyMode;
  reason?: string;
}

// Per-session → per-toolCallId resolver. Inner map = one entry per pending ask.
const pending = new Map<string, Map<string, (v: PermissionVerdict) => void>>();

// Per-session → per-toolCallId ask record, so the approve handler can derive
// an "always allow" rule for the specific call the user approved.
const pendingAsk = new Map<
  string,
  Map<string, { toolName: string; args: Record<string, unknown>; workspaceRoot: string }>
>();

function askMap(sessionId: string): Map<string, (v: PermissionVerdict) => void> {
  let m = pending.get(sessionId);
  if (!m) {
    m = new Map();
    pending.set(sessionId, m);
  }
  return m;
}

function askRecordMap(
  sessionId: string,
): Map<string, { toolName: string; args: Record<string, unknown>; workspaceRoot: string }> {
  let m = pendingAsk.get(sessionId);
  if (!m) {
    m = new Map();
    pendingAsk.set(sessionId, m);
  }
  return m;
}

/** Wait for the user's verdict on a specific toolCallId. */
export function waitForPermissionResolve(
  sessionId: string,
  toolCallId: string,
): Promise<PermissionVerdict> {
  return new Promise<PermissionVerdict>((resolve) => {
    askMap(sessionId).set(toolCallId, resolve);
  });
}

/** Resolve the pending asks for the given ids. Returns true if any was consumed. */
export function resolvePermission(
  sessionId: string,
  toolCallIds: string[],
  verdict: PermissionVerdict,
): boolean {
  const m = pending.get(sessionId);
  if (!m) return false;
  let any = false;
  for (const id of toolCallIds) {
    const r = m.get(id);
    if (r) {
      m.delete(id);
      r(verdict);
      any = true;
    }
  }
  return any;
}

/** Abort all pending asks for a session (e.g. user hit stop). Rejects each. */
export function abortPermission(sessionId: string, reason = 'aborted'): void {
  const m = pending.get(sessionId);
  if (!m) return;
  for (const r of m.values()) r({ approved: false, reason });
  m.clear();
}

/** Record a pending ask so the approve handler can derive an "always allow" rule. */
export function storePendingAsk(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): void {
  askRecordMap(sessionId).set(toolCallId, { toolName, args, workspaceRoot });
}

/** The pending ask for a specific id — used to derive an "always allow" rule. */
export function getPendingAsk(
  sessionId: string,
  toolCallId: string,
): { toolName: string; args: Record<string, unknown>; workspaceRoot: string } | undefined {
  return pendingAsk.get(sessionId)?.get(toolCallId);
}

/** Ids of every still-awaits-a-verdict ask in the session. */
export function pendingAskIds(sessionId: string): string[] {
  return [...pending.get(sessionId)?.keys() ?? []];
}

/** Drop all state for a session — call when the turn ends. */
export function clearSession(sessionId: string): void {
  pending.delete(sessionId);
  pendingAsk.delete(sessionId);
}
