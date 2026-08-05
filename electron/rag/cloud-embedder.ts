import { runSystemEmbedding } from '../agent/system-model.js';
import type { Embedder } from './embedder.js';

/** Cloud embedder: base sentence-transformers/all-minilm-l6-v2 via the system-model OpenRouter connection (256-token window — the local fine-tune extends to 512 but the cloud base does not). Thin wrapper; auth/baseURL/model/abort live in system-model.ts. */
export class CloudEmbedder implements Embedder {
  readonly id = 'cloud-base' as const;
  readonly dim = 384;
  readonly maxTokens = 256;

  async embed(texts: string[]): Promise<number[][]> {
    return runSystemEmbedding(texts);
  }
}
