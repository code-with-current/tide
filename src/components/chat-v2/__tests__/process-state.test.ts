import { describe, expect, it } from 'vitest';
import type { Block } from '@/types';
import { answerIsGrowing, deriveProcessOpen } from '../process-state';

const text = (over: Partial<Extract<Block, { kind: 'text' }>>): Block =>
  ({ kind: 'text', id: 'b', text: '', isAnswer: false, ...over } as Block);

describe('deriveProcessOpen', () => {
  it('open while streaming with process content and no answer yet', () => {
    expect(deriveProcessOpen({ streaming: true, hasProcess: true, answerActive: false, userPinned: null })).toBe(true);
  });
  it('closed when answer actively streaming', () => {
    expect(deriveProcessOpen({ streaming: true, hasProcess: true, answerActive: true, userPinned: null })).toBe(false);
  });
  it('re-opens when tools resume after answer paused', () => {
    expect(deriveProcessOpen({ streaming: true, hasProcess: true, answerActive: false, lastPhase: 'answer', userPinned: null })).toBe(true);
  });
  it('closed when turn finished', () => {
    expect(deriveProcessOpen({ streaming: false, hasProcess: true, answerActive: false, userPinned: null })).toBe(false);
  });
  it('closed for history turns', () => {
    expect(deriveProcessOpen({ streaming: false, hasProcess: true, answerActive: false, userPinned: null })).toBe(false);
  });
  it('user pin wins over automation', () => {
    expect(deriveProcessOpen({ streaming: true, hasProcess: true, answerActive: true, userPinned: true })).toBe(true);
    expect(deriveProcessOpen({ streaming: true, hasProcess: true, answerActive: false, userPinned: false })).toBe(false);
  });
  it('no process content → never open', () => {
    expect(deriveProcessOpen({ streaming: true, hasProcess: false, answerActive: false, userPinned: null })).toBe(false);
  });
});

describe('answerIsGrowing', () => {
  // isAnswer stays false on the live tail — the reducer only flags it on
  // turn_end (streamReducer.applyTurnEnd). Mid-stream, trailing text after
  // all tools is the presumptive answer.
  it('true when the last block is text in a streaming turn', () => {
    const blocks = [text({ id: 'a1', text: 'hi' })];
    expect(answerIsGrowing(blocks, true)).toBe(true);
  });
  it('false when the last block is a tool (process resumed after answer)', () => {
    const blocks = [
      text({ id: 'a1', text: 'hi' }),
      { kind: 'tool', id: 't1', toolCallId: 't', toolName: 'bash', status: 'executed' } as Block,
    ];
    expect(answerIsGrowing(blocks, true)).toBe(false);
  });
  it('false when not streaming (finished answer)', () => {
    expect(answerIsGrowing([text({ id: 'a1', isAnswer: true, text: 'hi' })], false)).toBe(false);
  });
  it('false when the last block is reasoning, not text', () => {
    const blocks = [text({ id: 'a1', text: 'hi' }), { kind: 'reasoning', id: 'r1', text: 'hmm' } as Block];
    expect(answerIsGrowing(blocks, true)).toBe(false);
  });
  it('false for missing or empty block lists', () => {
    expect(answerIsGrowing(undefined, true)).toBe(false);
    expect(answerIsGrowing([], true)).toBe(false);
  });
});
