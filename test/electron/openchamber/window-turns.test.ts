import { describe, expect, test } from 'vitest';

import { buildTurnWindowModel, updateTurnWindowModelIncremental } from '../../../src/components/chat/timeline/lib/turns/window-turns';
import type { ChatMessageEntry } from '../../../src/components/chat/timeline/lib/turns/types';
import type { OcMessage, OcPart } from '../../../src/components/chat/timeline/types/opencode-parts';

/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/windowTurns.test.ts. No adaptations. */

function message({ id, role, parentID }: { id: string; role: 'user' | 'assistant' | 'system'; parentID?: string }): ChatMessageEntry {
  return {
    info: {
      id,
      role,
      ...(parentID ? { parentID } : {}),
      time: { created: 1 },
    } as OcMessage,
    parts: [] as OcPart[],
  };
}

describe('windowTurns', () => {
  test('does not map assistant messages without a parent to the current turn', () => {
    const user = message({ id: 'u1', role: 'user' });
    const assistant = message({ id: 'a1', role: 'assistant' });

    const model = buildTurnWindowModel([user, assistant]);

    expect(model.messageToTurnId.get('u1')).toBe('u1');
    expect(model.messageToTurnId.has('a1')).toBe(false);
  });

  test('incremental update does not map assistant messages without a parent to the current turn', () => {
    const user = message({ id: 'u1', role: 'user' });
    const assistant = message({ id: 'a1', role: 'assistant' });
    const base = buildTurnWindowModel([user]);

    const next = updateTurnWindowModelIncremental(base, [user], [user, assistant]);

    expect(next?.messageToTurnId.get('u1')).toBe('u1');
    expect(next?.messageToTurnId.has('a1')).toBe(false);
  });

  test('maps assistant messages to their parent user turn', () => {
    const user = message({ id: 'u1', role: 'user' });
    const assistant = message({ id: 'a1', role: 'assistant', parentID: 'u1' });

    const model = buildTurnWindowModel([user, assistant]);

    expect(model.messageToTurnId.get('a1')).toBe('u1');
  });
});
