import { describe, it, expect, vi, beforeEach } from 'vitest';

// The parent imports LOCAL_META from embedder-process.js — mock that module
// so the test doesn't transitively pull @xenova/transformers / sharp.
vi.mock('../../rag/embedder-process.js', () => ({
  LOCAL_META: { id: 'local-code-512', dim: 384, maxTokens: 512 },
}));

// Mock electron's utilityProcess. fork() returns an EventEmitter-ish object
// whose `on('message', handler)` captures the parent's response dispatcher
// and whose `postMessage` spy records the request. The test drives the
// "child → parent" leg by invoking the captured handler directly.
const { forkMock, postMessageSpy, onSpy } = vi.hoisted(() => {
  const postMessageSpy = vi.fn();
  const handlers: Record<string, ((msg: unknown) => void) | undefined> = {};
  const onSpy = vi.fn((event: string, handler: (msg: unknown) => void) => {
    handlers[event] = handler;
  });
  // Expose the captured handler getter to the test body via the mock object.
  const forkMock = vi.fn(() => ({
    on: onSpy,
    postMessage: postMessageSpy,
    _handler: (event: string) => handlers[event],
  }));
  return { forkMock, postMessageSpy, onSpy };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/fake/userData') },
  utilityProcess: { fork: forkMock },
}));

import { LocalOnnxEmbedder } from '../../rag/local-onnx-embedder.js';

describe('LocalOnnxEmbedder', () => {
  beforeEach(() => {
    forkMock.mockClear();
    postMessageSpy.mockClear();
    onSpy.mockClear();
  });

  it('reports the local-code-512 shape (512-token window)', () => {
    const e = new LocalOnnxEmbedder();
    expect(e.id).toBe('local-code-512');
    expect(e.dim).toBe(384);
    expect(e.maxTokens).toBe(512);
  });

  it('isAvailable() is null before any embed completes', () => {
    const e = new LocalOnnxEmbedder();
    expect(e.isAvailable()).toBeNull();
  });

  it('spawns lazily on first embed + posts {type:embed,id,texts}', async () => {
    const e = new LocalOnnxEmbedder();
    // Hold the promise — don't await yet; the child hasn't replied.
    const p = e.embed(['a', 'b']);
    expect(forkMock).toHaveBeenCalledTimes(1);
    // stdio:'pipe' + TIDE_MODELS_DIR env set to userData/models
    const [, , opts] = forkMock.mock.calls[0];
    expect(opts).toMatchObject({ stdio: 'pipe' });
    expect(opts.env.TIDE_MODELS_DIR).toMatch(/\/models$/);
    // Request posted with a unique id.
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'embed',
      id: '1',
      texts: ['a', 'b'],
    });
    // Simulate the child replying with a matching id.
    const child = forkMock.mock.results[0].value as { _handler: (e: string) => (m: unknown) => void };
    child._handler('message')!({ type: 'result', id: '1', vectors: [[0.5, 0.6]] });
    await expect(p).resolves.toEqual([[0.5, 0.6]]);
    // A successful result flips availability to true.
    expect(e.isAvailable()).toBe(true);
  });

  it('rejects when the child returns {type:error}', async () => {
    const e = new LocalOnnxEmbedder();
    const p = e.embed(['x']);
    const child = forkMock.mock.results[0].value as { _handler: (e: string) => (m: unknown) => void };
    child._handler('message')!({ type: 'error', id: '1', message: 'model missing' });
    await expect(p).rejects.toThrow(/model missing/);
    expect(e.isAvailable()).toBeNull(); // still never succeeded
  });

  it('uses monotonically increasing ids across requests', async () => {
    const e = new LocalOnnxEmbedder();
    void e.embed(['a']);
    void e.embed(['b']);
    expect(postMessageSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: '1' }));
    expect(postMessageSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: '2' }));
    // Resolve both so the test doesn't leak pending promises.
    const child = forkMock.mock.results[0].value as { _handler: (e: string) => (m: unknown) => void };
    child._handler('message')!({ type: 'result', id: '1', vectors: [[0]] });
    child._handler('message')!({ type: 'result', id: '2', vectors: [[0]] });
  });
});
