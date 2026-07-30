import { describe, it, expect } from 'vitest';
import { hydrateRagConfig, DEFAULT_RAG_CONFIG } from '../configStore.js';

describe('hydrateRagConfig', () => {
  it('returns defaults when input is undefined', () => {
    expect(hydrateRagConfig(undefined)).toEqual(DEFAULT_RAG_CONFIG);
  });

  it('returns defaults when input is an empty object', () => {
    expect(hydrateRagConfig({})).toEqual(DEFAULT_RAG_CONFIG);
  });

  it('fills missing fields on a partial persisted config (cloud-base locks chunkTokens to 256)', () => {
    const out = hydrateRagConfig({ embedderId: 'cloud-base' });
    expect(out).toEqual({
      embedderId: 'cloud-base',
      dim: 384,
      cloudAllowed: false,
      chunkTokens: 256, // default 384 clamped to cloud-base's 256 max
    });
  });

  it('clamps chunkTokens to the local embedder max (768 → 512)', () => {
    const out = hydrateRagConfig({
      embedderId: 'local-code-512',
      chunkTokens: 768,
    });
    expect(out.chunkTokens).toBe(512);
  });

  it('preserves an in-range chunkTokens', () => {
    const out = hydrateRagConfig({
      embedderId: 'local-code-512',
      chunkTokens: 384,
      cloudAllowed: true,
    });
    expect(out.chunkTokens).toBe(384);
    expect(out.cloudAllowed).toBe(true);
  });

  it('clamps chunkTokens down when switching embedder to cloud-base', () => {
    // An old workspace persisted (local-code-512, chunkTokens 512) then the
    // user (or a future migration) flipped embedderId to cloud-base: the
    // 512-token chunk size is invalid for cloud's 256 window.
    const out = hydrateRagConfig({
      embedderId: 'cloud-base',
      chunkTokens: 512,
    });
    expect(out.chunkTokens).toBe(256);
  });

  it('dim is always 384 regardless of input', () => {
    const out = hydrateRagConfig({ dim: 999 as unknown as 384 });
    expect(out.dim).toBe(384);
  });
});
