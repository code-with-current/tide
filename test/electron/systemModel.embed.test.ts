import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above `const` declarations, so the mocks
// they reference must be created with vi.hoisted() too — otherwise the
// factory runs before the const is initialized (ReferenceError).
const mocks = vi.hoisted(() => {
  const embedManyMock = vi.fn();
  const textEmbeddingModelMock = vi.fn(() => ({
    modelId: 'sentinel',
    provider: 'tide-system',
  }));
  const createCompatMock = vi.fn(() => ({
    embeddingModel: textEmbeddingModelMock,
  }));
  return { embedManyMock, textEmbeddingModelMock, createCompatMock };
});

// Reference mocks.X inside vi.mock factories — the factories are hoisted
// above this destructure, so the bare locals aren't initialized at factory
// run time. The hoisted `mocks` object is.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, embedMany: mocks.embedManyMock };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createCompatMock,
}));

// Now the bare locals are safe to use in test bodies.
const { embedManyMock, textEmbeddingModelMock, createCompatMock } = mocks;

// Controllable env + key availability. Stubbed before the SUT is imported
// so the module-load-time reads (none today, but defensive) see them.
vi.stubEnv('TIDE_SYSTEM_BASE_URL', 'https://openrouter.ai/api/v1');
vi.stubEnv('TIDE_SYSTEM_API_KEY', 'sk-test');

import {
  getSystemEmbedder,
  runSystemEmbedding,
  isRagCloudConfigured,
  _resetSystemEmbedderForTests,
} from '../../app/core/agent/system-model.js';

describe('isRagCloudConfigured', () => {
  it('true iff TIDE_SYSTEM_API_KEY is set', () => {
    vi.stubEnv('TIDE_SYSTEM_API_KEY', 'sk-test');
    expect(isRagCloudConfigured()).toBe(true);
    vi.stubEnv('TIDE_SYSTEM_API_KEY', '');
    expect(isRagCloudConfigured()).toBe(false);
    // restore for downstream tests
    vi.stubEnv('TIDE_SYSTEM_API_KEY', 'sk-test');
  });
});

describe('getSystemEmbedder', () => {
  beforeEach(() => {
    createCompatMock.mockClear();
    textEmbeddingModelMock.mockClear();
    // The impl memoizes; bust it between tests so env overrides are observed.
    _resetSystemEmbedderForTests();
  });

  it('constructs from OpenRouter base + default embedding model', () => {
    vi.stubEnv('TIDE_RAG_EMBEDDING_MODEL', '');
    getSystemEmbedder();
    expect(createCompatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://openrouter.ai/api/v1',
        name: 'tide-system',
      }),
    );
    expect(textEmbeddingModelMock).toHaveBeenCalledWith(
      'sentence-transformers/all-minilm-l6-v2',
    );
  });

  it('honors TIDE_RAG_EMBEDDING_MODEL override', () => {
    vi.stubEnv('TIDE_RAG_EMBEDDING_MODEL', 'custom/embed-model');
    getSystemEmbedder();
    expect(textEmbeddingModelMock).toHaveBeenCalledWith('custom/embed-model');
  });

  it('throws when the API key is unset', () => {
    vi.stubEnv('TIDE_SYSTEM_API_KEY', '');
    expect(() => getSystemEmbedder()).toThrow(/not configured/i);
    vi.stubEnv('TIDE_SYSTEM_API_KEY', 'sk-test');
  });

  it('memoizes: second call returns the same instance without re-construction', () => {
    getSystemEmbedder();
    const first = textEmbeddingModelMock.mock.calls.length;
    getSystemEmbedder();
    expect(textEmbeddingModelMock.mock.calls.length).toBe(first);
  });
});

describe('runSystemEmbedding', () => {
  beforeEach(() => {
    embedManyMock.mockReset();
    embedManyMock.mockResolvedValue({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
  });

  it('delegates to embedMany with the system embedder + 30s abort', async () => {
    const out = await runSystemEmbedding(['hello', 'world']);
    expect(embedManyMock).toHaveBeenCalledTimes(1);
    const call = embedManyMock.mock.calls[0][0];
    expect(call.values).toEqual(['hello', 'world']);
    expect(call.model).toEqual({ modelId: 'sentinel', provider: 'tide-system' });
    // AbortSignal.timeout returns an AbortSignal; just assert presence.
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });
});
