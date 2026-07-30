import { runSystemEmbedding } from '../agent/system-model.js';
import type { Embedder } from './embedder.js';

/**
 * Cloud embedder: base `sentence-transformers/all-minilm-l6-v2` via the
 * system-model OpenRouter connection. 256-token window (the base model's
 * limit — the local fine-tune extends to 512, but the cloud base does not).
 *
 * Thin wrapper: all auth, base URL, model selection, and abort handling
 * live in system-model.ts so this stays a strategy-shape adapter.
 */
export class CloudEmbedder implements Embedder {
  readonly id = 'cloud-base' as const;
  readonly dim = 384;
  readonly maxTokens = 256;

  async embed(texts: string[]): Promise<number[][]> {
    return runSystemEmbedding(texts);
  }
}
