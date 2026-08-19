import { describe, it, expect } from 'vitest';
import { sessionSignal, abortSession, releaseSession } from '../agent/session-abort.js';

describe('session-abort registry', () => {
  it('returns the same signal per session until released', () => {
    const a = sessionSignal('s1');
    expect(sessionSignal('s1')).toBe(a);
    releaseSession('s1');
    expect(sessionSignal('s1')).not.toBe(a);
  });

  it('aborting a session fires its signal', () => {
    const s = sessionSignal('s1');
    let fired = false;
    s.addEventListener('abort', () => { fired = true; });
    abortSession('s1');
    expect(fired).toBe(true);
  });

  it('a released session can get a fresh signal', () => {
    const a = sessionSignal('s1');
    abortSession('s1');
    releaseSession('s1');
    const b = sessionSignal('s1');
    expect(b.aborted).toBe(false);
  });
});
