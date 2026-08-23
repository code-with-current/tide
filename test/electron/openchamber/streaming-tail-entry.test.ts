import { describe, expect, test } from 'vitest';

import { buildLiveStreamingEntry, type StreamingTailEntry } from '../../../src/components/chat/timeline/openchamber/lib/turns/streaming-tail-entry';
import type { ChatMessageEntry, TurnRecord } from '../../../src/components/chat/timeline/openchamber/lib/turns/types';
import type { OcMessage, OcPart } from '../../../src/components/chat/timeline/openchamber/types/opencode-parts';

/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/streamingTailEntry.test.ts. Dropped: the synthetic-part display-filtering case — it depends on getNormalizedMessageForDisplay's real (unported) synthetic filtering; the ported seam is an identity stub. */

const message = (id: string, role: 'user' | 'assistant', parentID?: string, parts: OcPart[] = []): ChatMessageEntry => ({
  info: {
    id,
    role,
    sessionID: 'ses_1',
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
  } as OcMessage,
  parts,
});

const textPart = (id: string, text: string): OcPart => ({
  id,
  type: 'text',
  text,
} as OcPart);

const reasoningPart = (id: string, text: string): OcPart => ({
  id,
  type: 'reasoning',
  text,
} as OcPart);

const turnEntry = (assistant: ChatMessageEntry): StreamingTailEntry => {
  const user = message('user_1', 'user');
  return {
    kind: 'turn',
    key: 'turn:user_1',
    isLastTurn: true,
    turn: {
      turnId: 'user_1',
      userMessageId: 'user_1',
      userMessage: user,
      headerMessageId: assistant.info.id,
      messages: [],
      assistantMessageIds: [assistant.info.id],
      assistantMessages: [assistant],
      activityParts: [],
      activitySegments: [],
      summary: {},
      hasTools: false,
      hasReasoning: false,
      stream: { isStreaming: true, isRetrying: false },
    } satisfies TurnRecord,
  };
};

describe('buildLiveStreamingEntry', () => {
  test('returns the same entry when the active message is not in the tail', () => {
    const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
    const entry = turnEntry(assistant);

    const next = buildLiveStreamingEntry(entry, {
      activeStreamingMessageId: 'assistant_other',
      liveParts: [textPart('part_live', 'live')],
      showTextJustificationActivity: true,
      showTurnChangedFiles: false,
    });

    expect(next).toBe(entry);
  });

  test('rebuilds only the streaming turn with live parts', () => {
    const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'hel')]);
    const entry = turnEntry(assistant);
    const liveParts = [reasoningPart('part_1_live', 'thinking')];

    const next = buildLiveStreamingEntry(entry, {
      activeStreamingMessageId: 'assistant_1',
      liveParts,
      showTextJustificationActivity: true,
      showTurnChangedFiles: false,
    });

    expect(next).not.toBe(entry);
    expect(next.kind).toBe('turn');
    if (next.kind !== 'turn') return;
    expect(next.turn.assistantMessages[0]?.parts).toBe(liveParts);
    expect(next.turn.activityParts.length).toBeGreaterThan(0);
  });

  test('updates an ungrouped streaming message with live parts', () => {
    const stale = message('assistant_1', 'assistant', undefined, [textPart('part_1', 'old')]);
    const entry: StreamingTailEntry = {
      kind: 'ungrouped',
      key: 'msg:assistant_1',
      message: stale,
    };
    const liveParts = [textPart('part_1_live', 'live')];

    const next = buildLiveStreamingEntry(entry, {
      activeStreamingMessageId: 'assistant_1',
      liveParts,
      showTextJustificationActivity: false,
      showTurnChangedFiles: false,
    });

    expect(next).not.toBe(entry);
    expect(next.kind).toBe('ungrouped');
    if (next.kind !== 'ungrouped') return;
    expect(next.message.parts).toBe(liveParts);
  });
});
