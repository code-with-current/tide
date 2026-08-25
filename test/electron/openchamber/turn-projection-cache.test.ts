import { describe, expect, test } from 'vitest';

import { buildProjectionCacheKey } from '../../../src/components/chat/timeline/lib/turns/turn-projection-cache';
import type { ChatMessageEntry } from '../../../src/components/chat/timeline/lib/turns/types';
import type { OcMessage, OcPart } from '../../../src/components/chat/timeline/types/opencode-parts';

/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/turnProjectionCache.test.ts. No adaptations. */

const createEntry = (text: string): ChatMessageEntry => ({
  info: { id: 'msg_1', role: 'assistant' } as OcMessage,
  parts: [{ id: 'prt_1', type: 'text', text } as OcPart],
});

describe('turnProjectionCache', () => {
  test('keeps the cache key stable for unchanged message and part references', () => {
    const messages = [createEntry('hello')];

    const first = buildProjectionCacheKey('session_1', messages, false, false, 'merge');
    const second = buildProjectionCacheKey('session_1', messages, false, false, 'merge');

    expect(second).toBe(first);
  });

  test('changes the cache key when streaming replaces a part with the same id and count', () => {
    const before = [createEntry('hel')];
    const after = [
      {
        info: before[0].info,
        parts: [{ id: 'prt_1', type: 'text', text: 'hello' } as OcPart],
      },
    ];

    const beforeKey = buildProjectionCacheKey('session_1', before, false, false, 'merge');
    const afterKey = buildProjectionCacheKey('session_1', after, false, false, 'merge');

    expect(afterKey).not.toBe(beforeKey);
  });
});
