import { describe, expect, test } from 'vitest';

import type { Block, Message, ToolBlock } from '../../../src/types';
import {
  blockToPart,
  buildChatMessageEntries,
  projectTideTurns,
  toChatMessageEntry,
} from '../../../src/components/chat/timeline/openchamber/lib/tide-adapter';
import { projectTurnRecords } from '../../../src/components/chat/timeline/openchamber/lib/turns/project-turn-records';
import type { OcPart, OcReasoningPart, OcTextPart, OcToolPart } from '../../../src/components/chat/timeline/openchamber/types/opencode-parts';

const seq = { createdAtSeq: 1, modifiedAtSeq: 2 };

const textBlock = (id: string, text: string, isAnswer = false): Block => ({
  ...seq,
  id,
  kind: 'text',
  text,
  isAnswer,
});

const reasoningBlock = (id: string, text: string, tokens?: number, ms?: number): Block => ({
  ...seq,
  id,
  kind: 'reasoning',
  text,
  ...(tokens !== undefined ? { tokens } : {}),
  ...(ms !== undefined ? { ms } : {}),
});

const toolBlock = (id: string, over: Partial<ToolBlock> = {}): ToolBlock => ({
  ...seq,
  id,
  kind: 'tool',
  toolCallId: id,
  toolName: 'bash',
  category: 'commands',
  status: 'executed',
  arguments: { command: 'ls' },
  argPreview: 'ls',
  riskTier: 'read_only',
  ...over,
});

const message = (id: string, role: 'user' | 'assistant', over: Partial<Message> = {}): Message => ({
  id,
  role,
  content: '',
  createdAt: '2026-08-23T00:00:00.000Z',
  ...over,
});

const asText = (part: OcPart): OcTextPart => part as OcTextPart;
const asTool = (part: OcPart): OcToolPart => part as OcToolPart;
const asReasoning = (part: OcPart): OcReasoningPart => part as OcReasoningPart;

describe('blockToPart', () => {
  test('maps a TextBlock to a text part stashing isAnswer and parentToolCallId', () => {
    const part = blockToPart(textBlock('t1', 'hello', true));
    expect(asText(part).type).toBe('text');
    expect(asText(part).text).toBe('hello');
    expect(asText(part).metadata?.isAnswer).toBe(true);
    expect(asText(part).id).toBe('t1');
  });

  test('maps a ReasoningBlock with durationMs and tokens metadata', () => {
    const part = blockToPart(reasoningBlock('r1', 'thinking', 120, 900));
    expect(asReasoning(part).type).toBe('reasoning');
    expect(asReasoning(part).text).toBe('thinking');
    expect(asReasoning(part).metadata?.durationMs).toBe(900);
    expect(asReasoning(part).metadata?.tokens).toBe(120);
  });

  test('maps a ToolBlock with Tide status passed through as state.status', () => {
    const part = blockToPart(toolBlock('tc1', { status: 'executed', output: 'ok', durationMs: 42 }));
    expect(asTool(part).type).toBe('tool');
    expect(asTool(part).tool).toBe('bash');
    expect(asTool(part).toolCallId).toBe('tc1');
    expect(asTool(part).state.status).toBe('executed');
    expect(asTool(part).state.output).toBe('ok');
    expect(asTool(part).state.input).toEqual({ command: 'ls' });
    expect(asTool(part).metadata?.durationMs).toBe(42);
    expect(asTool(part).metadata?.riskTier).toBe('read_only');
    expect(asTool(part).metadata?.category).toBe('commands');
    expect(asTool(part).error).toBeUndefined();
  });

  test('maps a failed ToolBlock to error carrying the output text', () => {
    const part = blockToPart(toolBlock('tc2', { status: 'failed', output: 'Spawn error: boom' }));
    expect(asTool(part).state.status).toBe('failed');
    expect(asTool(part).state.error).toBe('Spawn error: boom');
    expect(asTool(part).error).toBe('Spawn error: boom');
  });

  test('preserves parentToolCallId in tool metadata (part-level and state-level)', () => {
    const part = blockToPart(toolBlock('tc3', { parentToolCallId: 'parent-1' }));
    expect(asTool(part).metadata?.parentToolCallId).toBe('parent-1');
    expect(asTool(part).state.metadata?.parentToolCallId).toBe('parent-1');
  });

  test('maps a FollowupBlock to a followup part', () => {
    const part = blockToPart({
      ...seq,
      id: 'tc4#followup',
      kind: 'followup',
      mode: { kind: 'question', question: 'Which one?' },
      toolCallId: 'tc4',
    });
    expect(part.type).toBe('followup');
    expect((part as { toolCallId: string }).toolCallId).toBe('tc4');
    expect((part as { mode: unknown }).mode).toEqual({ kind: 'question', question: 'Which one?' });
  });
});

describe('toChatMessageEntry', () => {
  test('legacy message without blocks becomes a single text part from content', () => {
    const entry = toChatMessageEntry(message('m1', 'assistant', { content: 'legacy answer' }));
    expect(entry.info.id).toBe('m1');
    expect(entry.info.role).toBe('assistant');
    expect(entry.parts).toHaveLength(1);
    expect(asText(entry.parts[0]!).type).toBe('text');
    expect(asText(entry.parts[0]!).text).toBe('legacy answer');
  });

  test('message with blocks maps each block in emission order and ignores flat content', () => {
    const entry = toChatMessageEntry(message('m2', 'assistant', {
      content: 'flat',
      blocks: [reasoningBlock('r1', 'hmm'), textBlock('t1', 'narration')],
    }));
    expect(entry.parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
  });

  test('assistant messages get finish from stopReason (defaulting to stop) and a completed stamp', () => {
    const ok = toChatMessageEntry(message('m3', 'assistant', { totalMs: 1500 }));
    expect(ok.info.finish).toBe('stop');
    expect(ok.info.time.completed).toBe(ok.info.time.created + 1500);
    const aborted = toChatMessageEntry(message('m4', 'assistant', { stopReason: 'aborted' }));
    expect(aborted.info.finish).toBe('aborted');
  });

  test('createdAt ISO string converts to epoch ms for time.created', () => {
    const entry = toChatMessageEntry(message('m5', 'user', { createdAt: '2026-01-02T03:04:05.000Z' }));
    expect(entry.info.time.created).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  });

  test('stashes mentions and attachments for downstream renderers', () => {
    const mentions = [{ name: 'review', kind: 'skill' as const }];
    const entry = toChatMessageEntry(message('m6', 'user', { mentions, attachments: [{ path: 'a.ts', kind: 'code' as const }] }));
    expect(entry.info.mentions).toEqual(mentions);
    expect(entry.info.attachments).toEqual([{ path: 'a.ts', kind: 'code' }]);
  });
});

describe('buildChatMessageEntries (timeline production path)', () => {
  test('static assistant entries carry parentID so completed turns keep their content', () => {
    const user = message('u1', 'user', { content: 'check knowledge base' });
    const assistant = message('a1', 'assistant', {
      totalMs: 100,
      stopReason: 'stop',
      blocks: [
        toolBlock('tc1', { status: 'executed', output: 'ok' }),
        textBlock('t1', 'found it', true),
      ],
    });

    const entries = buildChatMessageEntries([user, assistant]);
    expect(entries[1]!.info.parentID).toBe('u1');

    const projection = projectTurnRecords(entries);
    expect(projection.turns).toHaveLength(1);
    const turn = projection.turns[0]!;
    expect(turn.assistantMessageIds).toEqual(['a1']);
    expect(turn.hasTools).toBe(true);
    expect(turn.summaryText).toBe('found it');
  });

  test('regression guard: parentless assistant entries are dropped by the projection', () => {
    // Documents why the timeline must build entries through
    // buildChatMessageEntries: projectTurnRecords drops assistant messages
    // without parentID, which erased finished turns' tool blocks entirely.
    const user = message('u1', 'user', { content: 'go' });
    const assistant = message('a1', 'assistant', {
      totalMs: 10,
      blocks: [toolBlock('tc1'), textBlock('t1', 'ans', true)],
    });

    const bare = [user, assistant].map((msg) => toChatMessageEntry(msg));
    const projection = projectTurnRecords(bare);

    expect(projection.turns[0]!.assistantMessageIds).toEqual([]);
  });

  test('streaming entry mirrors projectTideTurns: parentID, stripped completion, stopReason override', () => {
    const user = message('u1', 'user', { content: 'go' });
    const streaming = message('a1', 'assistant', { content: 'partial', totalMs: 50 });

    const live = buildChatMessageEntries([user], streaming, true, null);
    expect(live[1]!.info.parentID).toBe('u1');
    expect(live[1]!.info.time.completed).toBeUndefined();
    expect(live[1]!.info.finish).toBeUndefined();

    const stopped = buildChatMessageEntries([user], streaming, false, 'aborted');
    expect(stopped[1]!.info.finish).toBe('aborted');
  });
});

describe('projectTideTurns', () => {
  test('isAnswer text block becomes the turn summary via projection', () => {
    const user = message('u1', 'user', { content: 'list files' });
    const assistant = message('a1', 'assistant', {
      totalMs: 1200,
      blocks: [textBlock('t1', 'Let me look.'), textBlock('t2', 'Here is the answer.', true)],
    });

    const projection = projectTideTurns([user, assistant], null);

    expect(projection.turns).toHaveLength(1);
    const turn = projection.turns[0]!;
    expect(turn.turnId).toBe('u1');
    expect(turn.summaryText).toBe('Here is the answer.');
    expect(turn.summary.sourceMessageId).toBe('a1');
    expect(turn.summary.sourcePartId).toBe('t2');
  });

  test('summary prefers the isAnswer block over trailing narration', () => {
    const user = message('u1', 'user', { content: 'go' });
    const assistant = message('a1', 'assistant', {
      totalMs: 100,
      blocks: [
        toolBlock('tc1'),
        textBlock('t-ans', 'The answer.', true),
        textBlock('t-nar', 'Follow-up narration after the answer.', false),
      ],
    });

    const projection = projectTideTurns([user, assistant], null);

    const turn = projection.turns[0]!;
    expect(turn.summaryText).toBe('The answer.');
    expect(turn.summary.sourcePartId).toBe('t-ans');
    expect(turn.summaryText).not.toBe('Follow-up narration after the answer.');
  });

  test('reasoning block becomes a reasoning activity record', () => {
    const user = message('u1', 'user', { content: 'go' });
    const assistant = message('a1', 'assistant', {
      totalMs: 100,
      blocks: [reasoningBlock('r1', 'deep thought', 12, 900), textBlock('t1', 'done', true)],
    });

    const projection = projectTideTurns([user, assistant], null);
    const turn = projection.turns[0]!;

    expect(turn.hasReasoning).toBe(true);
    const record = turn.activityParts.find((activity) => activity.kind === 'reasoning');
    expect(record?.part.id).toBe('r1');
    expect(asReasoning(record!.part).metadata?.durationMs).toBe(900);
  });

  test('tool block becomes a tool activity record with Tide status passthrough', () => {
    const user = message('u1', 'user', { content: 'go' });
    const assistant = message('a1', 'assistant', {
      totalMs: 100,
      blocks: [toolBlock('tc1', { status: 'awaiting_input' }), textBlock('t1', 'answer', true)],
    });

    const projection = projectTideTurns([user, assistant], null);
    const turn = projection.turns[0]!;

    expect(turn.hasTools).toBe(true);
    const record = turn.activityParts.find((activity) => activity.kind === 'tool');
    expect(asTool(record!.part).state.status).toBe('awaiting_input');
    expect(asTool(record!.part).tool).toBe('bash');
  });

  test('streaming assistant joins the turn of the preceding user message', () => {
    const user1 = message('u1', 'user', { content: 'one' });
    const a1 = message('a1', 'assistant', { totalMs: 10, blocks: [textBlock('t1', 'done one', true)] });
    const streaming = message('a2', 'assistant', { content: 'partial' });

    const projection = projectTideTurns([user1, a1], streaming, true, null);

    expect(projection.turns).toHaveLength(1);
    const turn = projection.turns[0]!;
    expect(turn.assistantMessageIds).toEqual(['a1', 'a2']);
    expect(turn.stream.isStreaming).toBe(true);
  });

  test('streaming assistant starts a new turn when the last message is a user message', () => {
    const user1 = message('u1', 'user', { content: 'one' });
    const a1 = message('a1', 'assistant', { totalMs: 10, blocks: [textBlock('t1', 'done one', true)] });
    const user2 = message('u2', 'user', { content: 'two' });
    const streaming = message('a3', 'assistant', { content: 'partial' });

    const projection = projectTideTurns([user1, a1, user2], streaming, true, null);

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0]!.stream.isStreaming).toBe(false);
    const last = projection.turns[1]!;
    expect(last.turnId).toBe('u2');
    expect(last.assistantMessageIds).toEqual(['a3']);
    expect(last.stream.isStreaming).toBe(true);
  });

  test('completed turns are never marked streaming, even without totalMs', () => {
    const user = message('u1', 'user', { content: 'go' });
    const legacyAssistant = message('a1', 'assistant', { content: 'old answer, no blocks, no totalMs' });

    const projection = projectTideTurns([user, legacyAssistant], null);

    expect(projection.turns[0]!.stream.isStreaming).toBe(false);
  });

  test('stopped streaming message is not streaming when isStreaming is false', () => {
    const user = message('u1', 'user', { content: 'go' });
    const stopped = message('a1', 'assistant', { content: 'partial' });

    const projection = projectTideTurns([user], stopped, false, 'aborted');

    const turn = projection.turns[0]!;
    expect(turn.assistantMessageIds).toEqual(['a1']);
    expect(turn.stream.isStreaming).toBe(false);
    expect(turn.assistantMessages[0]!.info.finish).toBe('aborted');
  });

  test('multi-turn history projects each user message as its own turn', () => {
    const u1 = message('u1', 'user', { content: 'one' });
    const a1 = message('a1', 'assistant', { totalMs: 5, blocks: [textBlock('t1', 'one', true)] });
    const u2 = message('u2', 'user', { content: 'two' });
    const a2 = message('a2', 'assistant', { totalMs: 5, blocks: [textBlock('t2', 'two', true)] });

    const projection = projectTideTurns([u1, a1, u2, a2], null);

    expect(projection.turns.map((turn) => turn.turnId)).toEqual(['u1', 'u2']);
    expect(projection.turns[0]!.assistantMessageIds).toEqual(['a1']);
    expect(projection.turns[1]!.assistantMessageIds).toEqual(['a2']);
    expect(projection.turns.map((turn) => turn.summaryText)).toEqual(['one', 'two']);
  });
});

describe('finish vocabulary normalization (turn footer gate)', () => {
  test("Tide's 'end_turn' maps to upstream 'stop' so the turn footer renders", () => {
    const entry = toChatMessageEntry(message('a1', 'assistant', { stopReason: 'end_turn' }));
    expect(entry.info.finish).toBe('stop');
  });

  test('missing stopReason on a committed assistant message defaults to stop', () => {
    const entry = toChatMessageEntry(message('a1', 'assistant', {}));
    expect(entry.info.finish).toBe('stop');
  });

  test.each([
    ['max_tokens', 'length'],
    ['iteration_limit', 'length'],
    ['aborted', 'aborted'],
    ['refusal', 'error'],
    ['content_filter', 'error'],
  ] as const)('%s maps to %s', (stopReason, expected) => {
    const entry = toChatMessageEntry(message('a1', 'assistant', { stopReason }));
    expect(entry.info.finish).toBe(expected);
  });

  test('streaming entry normalizes the same way once the turn ends', () => {
    const streaming = message('a1', 'assistant', { stopReason: 'end_turn' });
    const entries = buildChatMessageEntries([], streaming, false, 'end_turn');
    expect(entries[0]!.info.finish).toBe('stop');
  });
});
