/**
 * Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/hooks/useChatTimelineController.test.ts — PURE-FN TESTS ONLY.
 * OpenChamber port seams: `bun:test` → `vitest`; upstream's DOM-based hook
 * test (`react-dom/client` createRoot + identity-lifecycle harness) is DROPPED
 * — the project vitest env is node with no DOM (task-6 brief R2.4). Lives under
 * the openchamber test dir because vitest only collects tests inside the test
 * tree (same placement as the T1 ported-turn tests).
 */

import { describe, expect, test } from 'vitest';

import {
  isOlderHistoryPrependCommit,
  shouldAutoLoadEarlierForUnderfilledPinnedViewport,
} from '@/components/chat/timeline/hooks/use-chat-timeline-controller';

const baseInput = {
  sessionId: 'ses_1',
  isPinned: true,
  canLoadEarlier: true,
  isLoadingOlder: false,
  pendingRevealWork: false,
  scrollHeight: 799,
  clientHeight: 800,
};

describe('shouldAutoLoadEarlierForUnderfilledPinnedViewport', () => {
  test('loads when pinned content does not fill the viewport', () => {
    expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport(baseInput)).toBe(true);
  });

  test('does not load when content already overflows', () => {
    expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
      ...baseInput,
      scrollHeight: 802,
    })).toBe(false);
  });

  test('does not load while user is away from bottom or history work is active', () => {
    expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
      ...baseInput,
      isPinned: false,
    })).toBe(false);
    expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
      ...baseInput,
      isLoadingOlder: true,
    })).toBe(false);
    expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
      ...baseInput,
      pendingRevealWork: true,
    })).toBe(false);
  });
});

describe('isOlderHistoryPrependCommit', () => {
  test('detects older messages inserted above the existing timeline', () => {
    expect(isOlderHistoryPrependCommit({
      previousOldestId: 'msg_2',
      previousNewestId: 'msg_4',
      currentOldestId: 'msg_1',
      currentNewestId: 'msg_4',
    })).toBe(true);
  });

  test('does not treat appends or replacements as prepends', () => {
    expect(isOlderHistoryPrependCommit({
      previousOldestId: 'msg_2',
      previousNewestId: 'msg_4',
      currentOldestId: 'msg_2',
      currentNewestId: 'msg_5',
    })).toBe(false);
    expect(isOlderHistoryPrependCommit({
      previousOldestId: 'msg_2',
      previousNewestId: 'msg_4',
      currentOldestId: 'msg_1',
      currentNewestId: 'msg_5',
    })).toBe(false);
  });
});
