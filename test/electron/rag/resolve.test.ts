import { describe, it, expect, vi } from 'vitest';

// resolve.ts constructs LocalOnnxEmbedder + CloudEmbedder at module load.
// Mock both so (a) the test doesn't pull electron into vitest via the
// parent client's `import { utilityProcess } from 'electron'`, and
// (b) the returned embedder objects have stable identities we can assert on.
const { localStub, cloudStub, LocalMock, CloudMock } = vi.hoisted(() => {
  const localStub = { id: 'local-code-512', dim: 384, maxTokens: 512, embed: vi.fn() };
  const cloudStub = { id: 'cloud-base', dim: 384, maxTokens: 256, embed: vi.fn() };
  // Regular functions, not arrows — resolve.ts does `new LocalOnnxEmbedder()`,
  // and arrow functions can't be invoked as constructors.
  const LocalMock = vi.fn(function () { return localStub; });
  const CloudMock = vi.fn(function () { return cloudStub; });
  return { localStub, cloudStub, LocalMock, CloudMock };
});

vi.mock('../../../electron/rag/local-onnx-embedder.js', () => ({ LocalOnnxEmbedder: LocalMock }));
vi.mock('../../../electron/rag/cloud-embedder.js', () => ({ CloudEmbedder: CloudMock }));

import { resolveForBuild, resolveForQuery, ResolveError } from '../../../electron/rag/resolve.js';
import type { RagConfig } from '../../../electron/src/types';

const localOn: RagConfig = { embedderId: 'local-code-512', dim: 384, cloudAllowed: false, chunkTokens: 384 };

describe('resolveForBuild', () => {
  it('prefers local when available', () => {
    const r = resolveForBuild({ config: localOn, localAvailable: true, cloudConfigured: true });
    expect(r.embedder.id).toBe('local-code-512');
    expect(r.embedderId).toBe('local-code-512');
  });

  it('falls back to cloud when local unavailable AND cloudAllowed AND cloud configured', () => {
    const r = resolveForBuild({
      config: { ...localOn, cloudAllowed: true },
      localAvailable: false,
      cloudConfigured: true,
    });
    expect(r.embedder.id).toBe('cloud-base');
    expect(r.embedderId).toBe('cloud-base');
  });

  it('throws ResolveError when local down, cloudAllowed off', () => {
    expect(() =>
      resolveForBuild({ config: localOn, localAvailable: false, cloudConfigured: true }),
    ).toThrow(/local embedder unavailable/i);
  });

  it('throws ResolveError when local down, cloudAllowed on, but cloud unconfigured', () => {
    expect(() =>
      resolveForBuild({
        config: { ...localOn, cloudAllowed: true },
        localAvailable: false,
        cloudConfigured: false,
      }),
    ).toThrow(/cloud is not configured/i);
  });

  it('thrown errors are ResolveError instances (callable from caller)', () => {
    try {
      resolveForBuild({ config: localOn, localAvailable: false, cloudConfigured: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
    }
  });
});

describe('resolveForQuery', () => {
  it('returns the cloud embedder for a cloud-built index even when local is also available', () => {
    const cloudIdx: RagConfig = {
      embedderId: 'cloud-base',
      dim: 384,
      cloudAllowed: true,
      chunkTokens: 256,
    };
    const q = resolveForQuery({
      config: cloudIdx,
      localAvailable: true, // would be tempting to cross — must not
      cloudConfigured: true,
    });
    expect(q.embedder.id).toBe('cloud-base');
  });

  it('throws "rebuild required" when a local-built index can no longer load local', () => {
    const localBuilt: RagConfig = {
      embedderId: 'local-code-512',
      dim: 384,
      cloudAllowed: true, // even with cloud allowed, must not swap
      chunkTokens: 384,
    };
    expect(() =>
      resolveForQuery({ config: localBuilt, localAvailable: false, cloudConfigured: true }),
    ).toThrow(/rebuild required/i);
  });

  it('throws when a cloud-built index has lost its cloud config', () => {
    const cloudIdx: RagConfig = {
      embedderId: 'cloud-base',
      dim: 384,
      cloudAllowed: true,
      chunkTokens: 256,
    };
    expect(() =>
      resolveForQuery({ config: cloudIdx, localAvailable: true, cloudConfigured: false }),
    ).toThrow(/TIDE_SYSTEM_API_KEY/i);
  });
});

// Reference the stubs so TS doesn't flag them as unused (and so future
// tests can assert on embed calls once resolveForBuild returns them).
void localStub;
void cloudStub;
