import { describe, expect, it } from 'vitest';
import type { SessionStream } from '@/types';
import type { AgentEvent } from '@/lib/agent/events';
import { reduceStream } from '@/lib/stream/stream-reducer';

const initial = (): SessionStream => ({
  text: '',
  reasoning: '',
  toolCalls: [],
  timeline: [],
  usage: null,
  sessionCostUsd: 0,
  iteration: 0,
  permissionRequest: null,
  isStreaming: true,
  error: null,
  retry: null,
  compacting: false,
  compactedTokens: null,
  stopReason: null,
  finalMessage: null,
});

let seq = 0;
const delta = (blockId: string, text: string, parentToolCallId?: string): AgentEvent =>
  ({ type: 'delta', sessionId: 's', seq: ++seq, messageId: 'm', text, blockId, ...(parentToolCallId ? { parentToolCallId } : {}) }) as AgentEvent;
const reasoning = (blockId: string, text: string, parentToolCallId?: string): AgentEvent =>
  ({ type: 'reasoning', sessionId: 's', seq: ++seq, messageId: 'm', delta: text, blockId, ...(parentToolCallId ? { parentToolCallId } : {}) }) as AgentEvent;

describe('applyDelta — parentToolCallId', () => {
  it('parented delta creates a text block carrying parentToolCallId', () => {
    const s = reduceStream(initial(), delta('c1', 'child narration', 'dispatch_1'));
    const b = s.blocks?.[0];
    expect(b?.kind).toBe('text');
    expect(b && b.kind === 'text' ? b.parentToolCallId : undefined).toBe('dispatch_1');
    expect(b && b.kind === 'text' ? b.text : '').toBe('child narration');
  });

  it('unparented delta creates a block without parentToolCallId (unchanged)', () => {
    const s = reduceStream(initial(), delta('p1', 'parent narration'));
    const b = s.blocks?.[0];
    expect(b?.kind).toBe('text');
    expect(b && b.kind === 'text' ? b.parentToolCallId : undefined).toBeUndefined();
  });

  it('consecutive parented deltas with the same blockId append to one block', () => {
    let s = initial();
    s = reduceStream(s, delta('c1', 'Hello ', 'd'));
    s = reduceStream(s, delta('c1', 'world', 'd'));
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks?.[0] && s.blocks[0].kind === 'text' ? s.blocks[0].text : '').toBe('Hello world');
  });

  it('parented text between two unparented segments accumulates independently', () => {
    let s = initial();
    s = reduceStream(s, delta('p1', 'before '));        // parent segment 1
    s = reduceStream(s, delta('c1', 'child ', 'd'));    // parented child segment
    s = reduceStream(s, delta('c1', 'text', 'd'));      // child continues
    s = reduceStream(s, delta('p1', 'after'));          // parent continues — must NOT merge into child
    expect(s.blocks).toHaveLength(3);
    const texts = s.blocks!.map((b) => (b.kind === 'text' ? b.text : `!${b.kind}`));
    expect(texts).toEqual(['before ', 'child text', 'after']);
    expect(s.blocks![0].kind === 'text' ? s.blocks![0].parentToolCallId : undefined).toBeUndefined();
    expect(s.blocks![1].kind === 'text' ? s.blocks![1].parentToolCallId : undefined).toBe('d');
    expect(s.blocks![2].kind === 'text' ? s.blocks![2].parentToolCallId : undefined).toBeUndefined();
  });

  it('same blockId with different parentage never merges (id-collision guard)', () => {
    let s = initial();
    s = reduceStream(s, delta('x', 'parent '));
    s = reduceStream(s, delta('x', 'child', 'd'));
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks!.map((b) => (b.kind === 'text' ? b.text : ''))).toEqual(['parent ', 'child']);
  });
});

describe('applyReasoning — parentToolCallId', () => {
  it('parented reasoning creates a reasoning block carrying parentToolCallId', () => {
    const s = reduceStream(initial(), reasoning('rc1', 'child thinking', 'd'));
    const b = s.blocks?.[0];
    expect(b?.kind).toBe('reasoning');
    expect(b && b.kind === 'reasoning' ? b.parentToolCallId : undefined).toBe('d');
  });

  it('unparented reasoning unchanged — no parentToolCallId', () => {
    const s = reduceStream(initial(), reasoning('rp1', 'parent thinking'));
    const b = s.blocks?.[0];
    expect(b && b.kind === 'reasoning' ? b.parentToolCallId : undefined).toBeUndefined();
  });

  it('parent and child reasoning blocks with different ids accumulate separately', () => {
    let s = initial();
    s = reduceStream(s, reasoning('rp1', 'parent '));
    s = reduceStream(s, reasoning('rc1', 'child ', 'd'));
    s = reduceStream(s, reasoning('rp1', 'more'));
    s = reduceStream(s, reasoning('rc1', 'thoughts', 'd'));
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks!.map((b) => (b.kind === 'reasoning' ? b.text : ''))).toEqual(['parent more', 'child thoughts']);
  });
});

describe('applyTurnEnd — answer flagging is scope-local', () => {
  it('parented text flags as its dispatch answer, never as the parent answer', () => {
    let s = initial();
    s = reduceStream(s, { type: 'tool_call_start', sessionId: 's', seq: ++seq, messageId: 'm', toolCallId: 'd', toolName: 'dispatch_agent', blockId: 'd' } as AgentEvent);
    s = reduceStream(s, delta('c1', 'child narration', 'd'));
    s = reduceStream(s, delta('a1', 'the answer'));
    s = reduceStream(s, { type: 'turn_end', sessionId: 's', seq: ++seq, messageId: 'm', stopReason: 'end_turn', content: '' } as AgentEvent);
    const answer = s.blocks!.find((b) => b.kind === 'text' && b.id === 'a1');
    const child = s.blocks!.find((b) => b.kind === 'text' && b.id === 'c1');
    // Root answer flags at the root…
    expect(answer && answer.kind === 'text' ? answer.isAnswer : undefined).toBe(true);
    // …and the parented text flags as the DISPATCH scope's answer (its only
    // text — it renders as the Agents-panel result block), consolidating
    // separately from the root answer.
    expect(child && child.kind === 'text' ? child.isAnswer : undefined).toBe(true);
  });

  it('parented narration before a child tool stays narration', () => {
    let s = initial();
    s = reduceStream(s, { type: 'tool_call_start', sessionId: 's', seq: ++seq, messageId: 'm', toolCallId: 'd', toolName: 'dispatch_agent', blockId: 'd' } as AgentEvent);
    s = reduceStream(s, delta('c0', 'planning…', 'd'));
    s = reduceStream(s, { type: 'tool_call_start', sessionId: 's', seq: ++seq, messageId: 'm', toolCallId: 'c-t', toolName: 'read_file', blockId: 'c-t', parentToolCallId: 'd' } as AgentEvent);
    s = reduceStream(s, { type: 'tool_result', sessionId: 's', seq: ++seq, toolCallId: 'c-t', status: 'executed', output: '' } as AgentEvent);
    s = reduceStream(s, delta('c1', 'child answer', 'd'));
    s = reduceStream(s, { type: 'turn_end', sessionId: 's', seq: ++seq, messageId: 'm', stopReason: 'end_turn', content: '' } as AgentEvent);
    const narration = s.blocks!.find((b) => b.kind === 'text' && b.id === 'c0');
    const childAnswer = s.blocks!.find((b) => b.kind === 'text' && b.id === 'c1');
    expect(narration && narration.kind === 'text' ? narration.isAnswer : undefined).toBe(false);
    expect(childAnswer && childAnswer.kind === 'text' ? childAnswer.isAnswer : undefined).toBe(true);
  });
});
