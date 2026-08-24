/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/hiddenUserMessage.ts.
 *  Ported faithfully (re-indented 4-space → 2-space); SDK types become
 *  Tide's `OcMessage`/`OcPart`. */

import type { OcMessage, OcPart } from '../types/opencode-parts';

import { deriveMessageRole } from './message-role';
import { filterVisibleParts, normalizeParts } from './part-utils';
import { normalizeUserDisplayParts } from './normalize-user-display-parts';

/**
 * A user message is hidden when none of its parts survive display
 * normalization (e.g. synthetic subagent-completion nudges). Turns separated
 * only by such messages should render as one continuous flow.
 */
// Streaming recomputes turn projections often; cache by parts reference so
// unchanged messages resolve without re-running display normalization.
const hiddenByPartsPlanMode = new WeakMap<OcPart[], boolean>();
const hiddenByPartsNoPlanMode = new WeakMap<OcPart[], boolean>();

export const isHiddenUserMessage = (
  entry: { info: OcMessage; parts: OcPart[] } | null | undefined,
  options: { planModeEnabled: boolean },
): boolean => {
  if (!entry) return false;
  if (!deriveMessageRole(entry.info).isUser) return false;

  const cache = options.planModeEnabled ? hiddenByPartsPlanMode : hiddenByPartsNoPlanMode;
  const cached = cache.get(entry.parts);
  if (cached !== undefined) {
    return cached;
  }

  const parts = normalizeUserDisplayParts(normalizeParts(entry.parts), { planModeEnabled: options.planModeEnabled });
  const hidden = filterVisibleParts(parts, { includeReasoning: true }).length === 0;
  cache.set(entry.parts, hidden);
  return hidden;
};
