import type { Embedder } from './embedder.js';
import type { EmbedderId, RagConfig } from '../../src/types';
import { CloudEmbedder } from './cloud-embedder.js';
import { LocalOnnxEmbedder } from './local-onnx-embedder.js';

export class ResolveError extends Error {}

export interface ResolveInput {
  config: RagConfig;
  localAvailable: boolean;
  cloudConfigured: boolean;
}

export interface ResolveResult {
  embedder: Embedder;
  /** What to persist back into ws.ragConfig.embedderId. May differ from
   *  the input at build time when falling back to cloud. */
  embedderId: EmbedderId;
}

// Module-level singletons. Both embedders are cheap to construct (the
// local one spawns lazily on first embed; the cloud one is a thin wrapper),
// so sharing one instance per process is the right granularity.
const localInstance = new LocalOnnxEmbedder();
const cloudInstance = new CloudEmbedder();

/** Build-time resolution: prefer local; fall back to cloud only when (local unavailable + cloudAllowed + cloud configured); otherwise throw so "RAG unavailable" surfaces honestly. */
export function resolveForBuild(input: ResolveInput): ResolveResult {
  const { config, localAvailable, cloudConfigured } = input;
  if (localAvailable) {
    return { embedder: localInstance, embedderId: 'local-code-512' };
  }
  if (config.cloudAllowed && cloudConfigured) {
    return { embedder: cloudInstance, embedderId: 'cloud-base' };
  }
  if (!config.cloudAllowed) {
    throw new ResolveError(
      'Local embedder unavailable and cloud fallback is disabled. ' +
        'Enable "Allow cloud as build-time fallback" or restore local ONNX.',
    );
  }
  throw new ResolveError(
    'Local embedder unavailable and cloud is not configured (TIDE_SYSTEM_API_KEY missing).',
  );
}

/** Query-time resolution: return the embedder matching the index's recorded embedderId — never cross (a local-built index whose local runtime died throws "rebuild required"; crossing vector spaces would yield garbage scores). */
export function resolveForQuery(input: ResolveInput): ResolveResult {
  const { config, localAvailable, cloudConfigured } = input;
  if (config.embedderId === 'local-code-512') {
    if (!localAvailable) {
      throw new ResolveError(
        'Index was built with the local embedder, which is no longer available. ' +
          'Rebuild required (cloud fallback cannot query a local-built index).',
      );
    }
    return { embedder: localInstance, embedderId: 'local-code-512' };
  }
  // cloud-base index
  if (!cloudConfigured) {
    throw new ResolveError(
      'Index was built with the cloud embedder, but TIDE_SYSTEM_API_KEY is no longer set.',
    );
  }
  return { embedder: cloudInstance, embedderId: 'cloud-base' };
}
