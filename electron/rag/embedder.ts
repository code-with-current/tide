/**
 * Embedder strategy. Two implementations (local ONNX, cloud OpenRouter)
 * share this surface so the resolver can swap them without callers
 * caring which is active.
 *
 * INVARIANT: two different EmbedderIds are NOT cross-compatible, even
 * with matching `dim`. Fine-tuning moves the embedding space, so a chunk
 * embedded with one id MUST be queried with the same id. The resolver
 * (resolve.ts) enforces this by reading ws.ragConfig.embedderId at both
 * build and query time and never mixing.
 */
import type { EmbedderId } from '../../src/types';

export interface Embedder {
  readonly id: EmbedderId;
  readonly dim: 384;
  /** Max input tokens the underlying model accepts without truncation. */
  readonly maxTokens: number;
  /** Embed a batch. Callers must pre-split inputs longer than maxTokens. */
  embed(texts: string[]): Promise<number[][]>;
}
