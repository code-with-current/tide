/** Renderer-side notification sounds for turn completion and permission prompts. Gated by the `notificationSound` general setting, checked per event (rare — at most a couple per turn). */

import { getGeneralSettings } from '@/lib/api/client';
import doneUrl from '@/assets/sounds/done.mp3';
import attentionUrl from '@/assets/sounds/attention.mp3';
import errorUrl from '@/assets/sounds/error.mp3';
import type { TurnEndEvent } from '@/lib/agent/events';

export type SoundKind = 'done' | 'attention' | 'error';

/** Map a turn_end stopReason to a sound. null = silent (user-initiated abort). */
export function stopReasonToSound(reason: TurnEndEvent['stopReason']): SoundKind | null {
  if (reason === 'aborted') return null;
  if (
    reason === 'refusal' ||
    reason === 'max_tokens' ||
    reason === 'iteration_limit' ||
    reason === 'content_filter' ||
    reason === 'spend_cap' ||
    reason === 'permission_timeout'
  ) {
    return 'error';
  }
  return 'done';
}

const assets: Record<SoundKind, string> = {
  done: doneUrl,
  attention: attentionUrl,
  error: errorUrl,
};

/** Permission tool-call ids already pinged, per session. permission_required
 *  re-fires as parallel tool calls accumulate into one prompt; only ids not
 *  seen before should ping. Cleared at turn end. */
const seenPermissionIds = new Map<string, Set<string>>();

async function playIfEnabled(kind: SoundKind): Promise<void> {
  try {
    const settings = await getGeneralSettings();
    if (settings?.notificationSound === false) return;
    // Fresh element per play so overlapping events don't cut each other off.
    await new Audio(assets[kind]).play();
  } catch {
    // Blocked autoplay or decode failure — never break the stream flow.
  }
}

export function notifyTurnEnd(sessionId: string, reason: TurnEndEvent['stopReason']): void {
  seenPermissionIds.delete(sessionId);
  const kind = stopReasonToSound(reason);
  if (kind) void playIfEnabled(kind);
}

export function notifyPermissionRequired(sessionId: string, toolCallIds: string[]): void {
  const seen = seenPermissionIds.get(sessionId) ?? new Set<string>();
  seenPermissionIds.set(sessionId, seen);
  const fresh = toolCallIds.filter((id) => !seen.has(id));
  if (fresh.length === 0) return;
  for (const id of fresh) seen.add(id);
  void playIfEnabled('attention');
}
