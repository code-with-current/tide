/** Embedder strategy shared by local ONNX and cloud implementations so the resolver can swap them transparently. INVARIANT: different EmbedderIds are NOT cross-compatible even with matching `dim` (fine-tuning moves the embedding space) — the resolver enforces same-id build/query. */
import type { EmbedderId } from '../../src/types';

export interface Embedder {
  readonly id: EmbedderId;
  readonly dim: 384;
  /** Max input tokens the underlying model accepts without truncation. */
  readonly maxTokens: number;
  /** Embed a batch. Callers must pre-split inputs longer than maxTokens. */
  embed(texts: string[]): Promise<number[][]>;
}
