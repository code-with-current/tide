import { describe, expect, test } from 'vitest';

import { projectTurnRecords } from '../../../src/components/chat/timeline/openchamber/lib/turns/project-turn-records';
import type { ChatMessageEntry } from '../../../src/components/chat/timeline/openchamber/lib/turns/types';
import type { OcMessage, OcPart } from '../../../src/components/chat/timeline/openchamber/types/opencode-parts';

/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/projectTurnRecords.test.ts. Dropped: the three mergeHiddenUserTurns merging cases — Tide's isHiddenUserMessage is a constant-false stub (adapter never emits hidden user messages), so hidden-turn merging is untestable here. */

function createMessageEntry({
  id,
  role,
  parentID,
  createdAt,
}: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parentID?: string;
  createdAt: number;
}): ChatMessageEntry {
  return {
    info: {
      id,
      role,
      ...(parentID ? { parentID } : {}),
      time: { created: createdAt },
    } as OcMessage,
    parts: [] as OcPart[],
  };
}

describe('projectTurnRecords', () => {
  test('groups assistant replies under their parent user turn', () => {
    const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

    const projection = projectTurnRecords([user, assistant]);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.turnId).toBe('u1');
    expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    expect(projection.ungroupedMessageIds.size).toBe(0);
  });

  test('keeps out-of-order assistant replies attached to their parent user turn', () => {
    const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
    const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });

    const projection = projectTurnRecords([user1, assistant1, assistant2, user2]);

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0]?.turnId).toBe('u1');
    expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    expect(projection.turns[1]?.turnId).toBe('u2');
    expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
    expect(projection.ungroupedMessageIds.size).toBe(0);
  });

  test('does not render assistant replies while their parent user turn is missing', () => {
    const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

    const projection = projectTurnRecords([user1, assistant1, assistant2]);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.turnId).toBe('u1');
    expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    expect(projection.ungroupedMessageIds.has('a2')).toBe(false);
    expect(projection.indexes.messageToTurnId.has('a2')).toBe(false);
  });

  test('does not render orphan assistant messages as standalone ungrouped entries', () => {
    const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'missing-user', createdAt: 1 });

    const projection = projectTurnRecords([assistant]);

    expect(projection.turns).toHaveLength(0);
    expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
    expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
  });

  test('keeps non-assistant orphan messages available as ungrouped entries', () => {
    const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

    const projection = projectTurnRecords([system]);

    expect(projection.turns).toHaveLength(0);
    expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
  });

  test('reuses unchanged turn records from the previous projection', () => {
    const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
    const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
    const initial = projectTurnRecords([user1, assistant1, user2, assistant2]);
    const updatedAssistant2 = {
      ...assistant2,
      parts: [{ type: 'text', text: 'stream update' } as OcPart],
    };

    const next = projectTurnRecords([user1, assistant1, user2, updatedAssistant2], {
      previousProjection: initial,
    });

    expect(next.turns[0]).toBe(initial.turns[0]);
    expect(next.turns[1]).not.toBe(initial.turns[1]);
  });

  test('hydrates updated turns when a previous projection exists but no turn is reusable', () => {
    const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const initial = projectTurnRecords([user, assistant]);
    const updatedAssistant = {
      ...assistant,
      parts: [{ id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as OcPart],
    };

    const next = projectTurnRecords([user, updatedAssistant], {
      previousProjection: initial,
    });

    expect(next.turns).toHaveLength(1);
    expect(next.turns[0]).not.toBe(initial.turns[0]);
    expect(next.turns[0]?.hasTools).toBe(true);
    expect(next.turns[0]?.activityParts).toHaveLength(1);
    expect(next.turns[0]?.stream.isStreaming).toBe(true);
    expect(next.turns[0]?.stream.isRetrying).toBe(false);
  });

  test('reuses the whole turns array when every turn is unchanged', () => {
    const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const initial = projectTurnRecords([user, assistant]);

    const next = projectTurnRecords([user, assistant], {
      previousProjection: initial,
    });

    expect(next.turns).toBe(initial.turns);
    expect(next.turns[0]).toBe(initial.turns[0]);
  });

  test('keeps every user message as its own turn even when mergeHiddenUserTurns is set', () => {
    const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
    const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

    const projection = projectTurnRecords([user1, assistant1, user2, assistant2], {
      mergeHiddenUserTurns: { planModeEnabled: false },
    });

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[1]?.turnId).toBe('u2');
  });

  test('treats compaction summary text as justification activity in sorted mode', () => {
    const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
    user.parts = [{ id: 'p1', type: 'text', text: 'prompt' } as OcPart];
    const compaction = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
    (compaction.info as { summary?: boolean; finish?: string }).summary = true;
    (compaction.info as { summary?: boolean; finish?: string }).finish = 'stop';
    compaction.parts = [{ id: 'cp1', type: 'text', text: 'compacted context summary' } as OcPart];
    const assistant = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 3 });
    (assistant.info as { finish?: string }).finish = 'stop';
    assistant.parts = [{ id: 'ap1', type: 'text', text: 'final answer' } as OcPart];

    const projection = projectTurnRecords([user, compaction, assistant], {
      showTextJustificationActivity: true,
    });

    const turn = projection.turns[0];
    expect(turn?.summaryText).toBe('final answer');
    const compactionActivity = turn?.activityParts.find((activity) => activity.messageId === 'a1');
    expect(compactionActivity?.kind).toBe('justification');
    const finalActivity = turn?.activityParts.find((activity) => activity.messageId === 'a2');
    expect(finalActivity).toBe(undefined);
  });
});
