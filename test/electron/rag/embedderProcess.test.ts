import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Transformers.js — the handler loads the pipeline lazily via
// dynamic import, which vi.mock intercepts.
const { fakeExtractor, pipelineMock } = vi.hoisted(() => ({
  fakeExtractor: vi.fn(async (_input: string, _opts: object) => ({
    data: new Float32Array([0.1, 0.2, 0.3]),
  })),
  pipelineMock: vi.fn(async () => fakeExtractor),
}));

const { envMock } = vi.hoisted(() => ({ envMock: { cacheDir: '' } }));
vi.mock('@xenova/transformers', () => ({ pipeline: pipelineMock, env: envMock }));

import { handleMessage, _resetPipelineForTests } from '../../../electron/rag/embedder-process.js';

describe('embedder-process handleMessage', () => {
  beforeEach(() => {
    pipelineMock.mockClear();
    fakeExtractor.mockClear();
    _resetPipelineForTests();
  });

  it('loads the pipeline once and reuses it across requests', async () => {
    await handleMessage({ type: 'embed', id: '1', texts: ['a'] });
    await handleMessage({ type: 'embed', id: '2', texts: ['b', 'c'] });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    // one extractor call per text, mean-pooled + normalized in the impl
    expect(fakeExtractor).toHaveBeenCalledTimes(3);
  });

  it('returns {type:result, id, vectors} with number[] vectors', async () => {
    const resp = await handleMessage({ type: 'embed', id: 'r1', texts: ['x'] });
    expect(resp.type).toBe('result');
    if (resp.type !== 'result') return; // narrow for TS
    expect(resp.id).toBe('r1');
    expect(resp.vectors).toHaveLength(1);
    // Float32 storage rounds 0.1/0.2/0.3 — compare approximately, not exactly.
    expect(resp.vectors[0].map((v) => Number(v.toFixed(2)))).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns {type:error, id, message} on pipeline failure', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('model missing'));
    const resp = await handleMessage({ type: 'embed', id: 'r2', texts: ['x'] });
    expect(resp.type).toBe('error');
    expect(resp).toHaveProperty('id', 'r2');
    if (resp.type === 'error') {
      expect(resp.message).toMatch(/model missing/);
    }
  });
});
