import { describe, expect, it } from 'vitest';
import { deriveProcessOpen } from '../process-state';

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
