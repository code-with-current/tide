/** Local ONNX embedder — child side, runs in a utilityProcess spawned by local-onnx-embedder.ts. Pure handleMessage is unit-testable; the bottom of the file is the thin process shell. Model: all-MiniLM-L6-v2-code-search-512 (22MB quantized ONNX). */
import * as fs from 'node:fs';
import type { Embedder } from './embedder.js';

// Polyfill `self` BEFORE any dynamic import of @xenova/transformers.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  (globalThis as { self: unknown }).self = globalThis;
}

export const MODEL_ID = 'isuruwijesiri/all-MiniLM-L6-v2-code-search-512';

type Extractor = (
  input: string,
  opts: { pooling: 'mean'; normalize: true },
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!pipelinePromise) {
    const { pipeline, env } = await import('@xenova/transformers');

    // ── Model location: lazy-downloaded to userData/models/ (TIDE_MODELS_DIR).
    const downloadDir = process.env.TIDE_MODELS_DIR;
    if (downloadDir) {
      const hasDownloaded = fs.existsSync(
        path.join(downloadDir, MODEL_ID, 'onnx', 'model_quantized.onnx'),
      );
      env.cacheDir = downloadDir;
      env.allowRemoteModels = false;
      env.allowLocalModels = hasDownloaded;
    }

    pipelinePromise = pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
    }) as Promise<Extractor>;
  }
  return pipelinePromise;
}

export type EmbedRequest = { type: 'embed'; id: string; texts: string[] };
export type EmbedResult = { type: 'result'; id: string; vectors: number[][] };
export type EmbedError = { type: 'error'; id: string; message: string };
export type EmbedResponse = EmbedResult | EmbedError;

/** Pure handler (test surface). Loads the pipeline lazily, embeds each text with mean pooling + L2 normalize (matching the model card's JS quick-start), converts Float32Array → number[]. */
export async function handleMessage(req: EmbedRequest): Promise<EmbedResponse> {
  try {
    const extractor = await getExtractor();
    const vectors: number[][] = [];
    for (const text of req.texts) {
      const { data } = await extractor(text, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(data));
    }
    return { type: 'result', id: req.id, vectors };
  } catch (e: unknown) {
    // This runs in the utility (child) process — console output goes to the
    // parent's stdio pipe. The parent's logger captures it via the [rag] tag.
    console.error(`[rag] embedder error: ${e instanceof Error ? e.message : String(e)}`);
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'error', id: req.id, message };
  }
}

/** Test-only: bust the pipeline memo. */
export function _resetPipelineForTests(): void {
  pipelinePromise = null;
}

// ── Process shell ────────────────────────────────────────────────────
// When run as a utilityProcess entry, wire handleMessage to the parent
// port. This block is inert under vitest (no process.parentPort).
if (typeof process !== 'undefined' && (process as { parentPort?: unknown }).parentPort) {
  const port = (process as { parentPort: Electron.ParentPort }).parentPort;
  port.on('message', (event: { data: EmbedRequest }) => {
    handleMessage(event.data).then((resp) => port.postMessage(resp));
  });
}

// Parent-side client mirrors these constants without a cross-process
// import. Kept here so the model identity has one source of truth.
export const LOCAL_META = {
  id: 'local-code-512' as const,
  dim: 384,
  maxTokens: 512,
} satisfies Pick<Embedder, 'id' | 'dim' | 'maxTokens'>;
