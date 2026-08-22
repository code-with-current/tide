import { describe, it, expect, vi } from 'vitest';

// vi.mock factories are hoisted; declare the mock via vi.hoisted so it
// exists at factory-run time.
const { runSystemEmbeddingMock } = vi.hoisted(() => ({
  runSystemEmbeddingMock: vi.fn(),
}));

vi.mock('../../../electron/agent/system-model.js', () => ({
  runSystemEmbedding: runSystemEmbeddingMock,
}));

import { CloudEmbedder } from '../../../electron/rag/cloud-embedder.js';

describe('CloudEmbedder', () => {
  it('reports the right static shape', () => {
    const e = new CloudEmbedder();
    expect(e.id).toBe('cloud-base');
    expect(e.dim).toBe(384);
    expect(e.maxTokens).toBe(256); // base all-minilm-l6-v2 window
  });

  it('delegates embed() to runSystemEmbedding and passes texts through', async () => {
    runSystemEmbeddingMock.mockResolvedValue([[0.5, 0.5]]);
    const e = new CloudEmbedder();
    const out = await e.embed(['a', 'b']);
    expect(runSystemEmbeddingMock).toHaveBeenCalledWith(['a', 'b']);
    expect(out).toEqual([[0.5, 0.5]]);
  });

  it('propagates errors from runSystemEmbedding', async () => {
    runSystemEmbeddingMock.mockRejectedValue(new Error('upstream 5xx'));
    const e = new CloudEmbedder();
    await expect(e.embed(['x'])).rejects.toThrow(/upstream 5xx/);
  });
});
