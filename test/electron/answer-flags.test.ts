import { describe, expect, it } from 'vitest';
import React from 'react';
import { answerBlockIds } from '@/lib/stream/block-state';
import { migrateMessageToBlocks } from '@/lib/stream/block-migration';
import { reduceStream } from '@/lib/stream/stream-reducer';
import { freshStream } from '@/lib/stores/ui';
import type { Block, Message } from '@/types';

/** Minimal block factory — only the fields answerBlockIds reads. */
const text = (id: string, parent?: string): Block =>
  ({ id, kind: 'text', text: `t-${id}`, createdAtSeq: 0, modifiedAtSeq: 0, ...(parent ? { parentToolCallId: parent } : {}) }) as Block;
const tool = (id: string, name = 'read_file', parent?: string): Block =>
  ({ id, kind: 'tool', toolCallId: id, toolName: name, category: 'exploration', status: 'executed', arguments: {}, argPreview: '', riskTier: 'read_only', createdAtSeq: 0, modifiedAtSeq: 0, ...(parent ? { parentToolCallId: parent } : {}) }) as Block;

describe('answerBlockIds (scope-local answer flagging)', () => {
  it('root answer = text after the last work tool at the root', () => {
    const blocks = [text('a'), tool('t1'), text('b'), text('c')];
    expect([...answerBlockIds(blocks)].sort()).toEqual(['b', 'c']);
  });

  it('sub-agent answer is flagged even when the parent continues tooling after the dispatch', () => {
    // Exact shape of the broken dev session: dispatch → its tools → its
    // answer text → parent keeps calling tools → parent answer last.
    const blocks = [
      text('intro'),
      tool('dispatch', 'dispatch_agent'),
      tool('child-1', 'read_file', 'dispatch'),
      tool('child-2', 'grep', 'dispatch'),
      text('child-answer', 'dispatch'),
      tool('parent-followup', 'bash'),
      text('parent-answer'),
    ];
    const answers = answerBlockIds(blocks);
    expect(answers.has('child-answer')).toBe(true);
    expect(answers.has('parent-answer')).toBe(true);
    expect(answers.has('intro')).toBe(false);
  });

  it('bookkeeping tools do not start an answer phase', () => {
    const blocks = [tool('t1'), text('plan-done-note'), tool('todo', 'todo_write'), text('answer')];
    const answers = answerBlockIds(blocks);
    expect(answers.has('plan-done-note')).toBe(true); // after last WORK tool
    expect(answers.has('answer')).toBe(true);
  });

  it('scopes are independent — narration before a child tool stays narration', () => {
    const blocks = [
      tool('dispatch', 'dispatch_agent'),
      text('child-narration', 'dispatch'),
      tool('child-1', 'bash', 'dispatch'),
      text('child-answer', 'dispatch'),
    ];
    const answers = answerBlockIds(blocks);
    expect(answers.has('child-narration')).toBe(false);
    expect(answers.has('child-answer')).toBe(true);
  });
});

describe('redetermineAnswerFlag via migrateMessageToBlocks (reload path)', () => {
  it('flags the parented answer on persisted messages', () => {
    const blocks: Block[] = [
      tool('dispatch', 'dispatch_agent'),
      tool('child-1', 'read_file', 'dispatch'),
      text('child-answer', 'dispatch'),
      tool('parent-tool', 'bash'),
      text('parent-answer'),
    ];
    const msg = { id: 'm1', role: 'assistant', content: '', createdAt: '', blocks } as unknown as Message;
    const out = migrateMessageToBlocks(msg);
    const byId = new Map(out.blocks!.map((b) => [b.id, b]));
    expect((byId.get('child-answer') as any).isAnswer).toBe(true);
    expect((byId.get('parent-answer') as any).isAnswer).toBe(true);
  });
});

describe('applyTurnEnd (live path)', () => {
  it('flags the sub-agent answer at turn end', () => {
    let s = freshStream();
    const ev = (e: object) => { s = reduceStream(s, e as any); };
    ev({ type: 'delta', text: 'intro', blockId: 'b-intro', seq: 1 });
    ev({ type: 'tool_call_start', toolCallId: 'dispatch', toolName: 'dispatch_agent', blockId: 'dispatch', seq: 2 });
    ev({ type: 'tool_call_start', toolCallId: 'child-1', toolName: 'read_file', blockId: 'child-1', parentToolCallId: 'dispatch', seq: 3 });
    ev({ type: 'tool_result', toolCallId: 'child-1', status: 'executed', output: '', seq: 4 });
    ev({ type: 'delta', text: 'child answer', blockId: 'b-child', parentToolCallId: 'dispatch', seq: 5 });
    ev({ type: 'tool_call_start', toolCallId: 'parent-tool', toolName: 'bash', blockId: 'parent-tool', seq: 6 });
    ev({ type: 'tool_result', toolCallId: 'parent-tool', status: 'executed', output: '', seq: 7 });
    ev({ type: 'delta', text: 'parent answer', blockId: 'b-parent', seq: 8 });
    ev({ type: 'turn_end', stopReason: 'end_turn', seq: 9 });

    const byId = new Map(s.blocks.map((b) => [b.id, b]));
    expect((byId.get('b-child') as any).isAnswer).toBe(true);
    expect((byId.get('b-parent') as any).isAnswer).toBe(true);
    expect((byId.get('b-intro') as any).isAnswer).toBe(false);
  });
});

describe('finalizeAssistantMessage stopReason persistence (store)', () => {
  it('persists stopReason and dedupes finalize (append + update paths)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-finalize-'));
    const { createSessionStore } = await import('../../electron/ipc/sessionStore');
    const store = createSessionStore(dir);
    store.createSession('ws1', 'test', 'm_test');
    const sid = store.listSessions('ws1')[0].id;
    store.addMessage(sid, 'user', 'hi');
    // Main-side authoritative finalize at turn end (append path — no partial
    // was flushed for a short turn).
    store.finalizeAssistantMessage(sid, 'm1', {
      content: 'done', blocks: [], totalMs: 1000, stopReason: 'end_turn',
    });
    const msg = store.getSession(sid)!.messages.find((m) => m.id === 'm1')!;
    expect(msg.stopReason).toBe('end_turn');
    expect(msg.totalMs).toBe(1000);
    // Renderer's duplicate finalize is an idempotent update-in-place.
    store.finalizeAssistantMessage(sid, 'm1', {
      content: 'done', blocks: [], totalMs: 1000, stopReason: 'end_turn',
    });
    const again = store.getSession(sid)!;
    expect(again.messages.filter((m) => m.id === 'm1')).toHaveLength(1);
    expect(again.messages.find((m) => m.id === 'm1')!.stopReason).toBe('end_turn');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('TurnHeader interrupted detection', () => {
  it('flags a killed partial (running tools) as Interrupted, not Done', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { TurnHeader } = await import('@/components/chat/turn/turn-header');
    const blocks = [
      { id: 'r1', kind: 'reasoning', text: 'thinking', createdAtSeq: 0, modifiedAtSeq: 0 },
      { id: 't1', kind: 'tool', toolCallId: 't1', toolName: 'bash', category: 'commands', status: 'running', arguments: {}, argPreview: '', riskTier: 'read_only', createdAtSeq: 0, modifiedAtSeq: 0 },
    ] as any;
    const html = renderToStaticMarkup(
      React.createElement(TurnHeader, { blocks, streaming: false, stopReason: null, totalMs: undefined }),
    );
    expect(html).toContain('Interrupted');
    expect(html).not.toContain('>Done<');
  });

  it('terminal-tool turns still render Done', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { TurnHeader } = await import('@/components/chat/turn/turn-header');
    const blocks = [
      { id: 'a1', kind: 'text', text: 'answer', isAnswer: true, createdAtSeq: 0, modifiedAtSeq: 0 },
      { id: 't1', kind: 'tool', toolCallId: 't1', toolName: 'bash', category: 'commands', status: 'executed', arguments: {}, argPreview: '', riskTier: 'read_only', createdAtSeq: 0, modifiedAtSeq: 0 },
    ] as any;
    const html = renderToStaticMarkup(
      React.createElement(TurnHeader, { blocks, streaming: false, stopReason: 'end_turn', totalMs: 5000 }),
    );
    expect(html).toContain('>Done<');
    expect(html).not.toContain('Interrupted');
  });
});
