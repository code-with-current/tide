/** Pure row-metrics helpers for the virtualized ChatTimeline, extracted so
 *  they are testable without mounting the component. */

import type { Message } from '@/types';

/** Pre-measure height hints. measureElement corrects both on first mount and
 *  caches by row key, so these only shape initial geometry and far-jump
 *  scroll math. */
export const USER_ROW_ESTIMATE = 88;

const CHARS_PER_LINE = 80;
const LINE_HEIGHT = 20;
const TURN_BASE = 40;
const TURN_MIN = 200;
const TURN_MAX = 2000;
/** Collapsed tool chip row — ToolChips rows render one line per call. */
const TOOL_ROW_ESTIMATE = 36;

/** Row key for the virtualizer's measurement cache. Message ids are unique
 *  per session; the streaming row's key must ALSO be session-scoped — the
 *  cache outlives session switches (ChatTimeline stays mounted), so a shared
 *  '__streaming__' key would reuse the previous session's streamed-turn
 *  height and flash a phantom bottom on the next session's first send. */
export function timelineRowKey(
  messages: readonly Message[],
  index: number,
  sessionId?: string | null,
): string {
  return index < messages.length ? messages[index].id : `${sessionId ?? 's'}:__streaming__`;
}

/** Content-derived pre-measure estimate. Prefers the canonical block list
 *  (the renderer ignores `content` when blocks exist); falls back to
 *  content/reasoning/toolCalls for legacy messages. Clamped so a huge turn
 *  can't blow up far-jump math and an empty turn still clears the viewport
 *  hint floor. */
export function estimateRowSize(msg: Message | undefined): number {
  if (!msg || msg.role === 'user') return USER_ROW_ESTIMATE;
  let lines = 0;
  let tools = 0;
  if (msg.blocks) {
    for (const b of msg.blocks) {
      if (b.kind === 'tool') tools++;
      else if (b.kind === 'text' || b.kind === 'reasoning') {
        lines += Math.ceil(b.text.length / CHARS_PER_LINE);
      }
    }
  } else {
    lines =
      Math.ceil(msg.content.length / CHARS_PER_LINE) +
      Math.ceil((msg.reasoning ?? '').length / CHARS_PER_LINE);
    tools = msg.toolCalls?.length ?? 0;
  }
  const size = TURN_BASE + lines * LINE_HEIGHT + tools * TOOL_ROW_ESTIMATE;
  return Math.min(Math.max(size, TURN_MIN), TURN_MAX);
}
