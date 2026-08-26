import { describe, expect, it } from 'vitest';
import { registerQuitLifecycle } from '../../app/quit-lifecycle';
import { emitBeforeQuit } from '../electrobun-main-mock';

/** Records call order across the injected fakes. */
function fakeSteps(log: string[]) {
  return {
    abortAllTurns: () => { log.push('abort'); },
    disposeTerminals: () => { log.push('terminals'); },
    disposeSink: () => { log.push('sink'); },
  };
}

describe('registerQuitLifecycle — before-quit sequencing', () => {
  it('runs abort → terminals → sink, in order', () => {
    const order: string[] = [];
    registerQuitLifecycle(fakeSteps(order));
    emitBeforeQuit();
    expect(order).toEqual(['abort', 'terminals', 'sink']);
  });

  it('is idempotent across repeated before-quit emissions', () => {
    const order: string[] = [];
    registerQuitLifecycle(fakeSteps(order));
    emitBeforeQuit();
    emitBeforeQuit();
    expect(order).toEqual(['abort', 'terminals', 'sink', 'abort', 'terminals', 'sink']);
  });

  it('still disposes the sink when an earlier step throws', () => {
    const order: string[] = [];
    registerQuitLifecycle({
      abortAllTurns: () => { order.push('abort'); throw new Error('persist failed'); },
      disposeTerminals: () => { order.push('terminals'); },
      disposeSink: () => { order.push('sink'); },
    });
    expect(() => emitBeforeQuit()).not.toThrow();
    expect(order).toEqual(['abort', 'terminals', 'sink']);
  });

  it('never vetoes — the handler returns undefined', () => {
    const handler = registerQuitLifecycle(fakeSteps([]));
    expect(handler()).toBeUndefined();
  });
});
