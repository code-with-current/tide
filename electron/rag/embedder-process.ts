/**
 * Local ONNX embedder — child side. Runs inside a utilityProcess spawned
 * by local-onnx-embedder.ts (the parent). The pure handleMessage function
 * is unit-testable without a real process; the port wiring at the bottom
 * of the file is the thin shell that the process actually runs.
 *
 * Model: isuruwijesiri/all-MiniLM-L6-v2-code-search-512 (code-tuned fine-
 * tune of all-MiniLM-L6-v2, 512-token context, 22MB quantized ONNX).
 * Bundled inside the app at electron/rag/models/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Embedder } from './embedder.js';

// ESM has no global __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    // ── Model location ─────────────────────────────────────────────
    // The model is no longer bundled in production builds — it's lazy-
    // downloaded from HuggingFace on first RAG enable (see model-downloader.ts)
    // into userData/models/, which the parent passes via TIDE_MODELS_DIR.
    // In dev, the source copy at electron/rag/models/ is used directly
    // (staged to dist-electron/models/ by copy-tree-sitter-grammars.mjs).
    const BUNDLED_DIR = path.join(__dirname, 'models');
    const hasBundled = fs.existsSync(
      path.join(BUNDLED_DIR, MODEL_ID, 'onnx', 'model_quantized.onnx'),
    );
    const downloadDir = process.env.TIDE_MODELS_DIR;
    const hasDownloaded = downloadDir &&
      fs.existsSync(path.join(downloadDir, MODEL_ID, 'onnx', 'model_quantized.onnx'));

    if (hasDownloaded && downloadDir) {
      // Downloaded copy in userData (production) — the primary path.
      env.cacheDir = downloadDir;
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
    } else if (hasBundled) {
      // Bundled copy (dev builds where the source model is staged).
      env.cacheDir = BUNDLED_DIR;
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
    } else if (downloadDir) {
      // Download dir exists but model isn't there yet — point cacheDir
      // at it so a post-download load finds the files without restart.
      env.cacheDir = downloadDir;
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

/**
 * Pure handler — the test surface. Loads the pipeline lazily, embeds each
 * text with mean pooling + L2 normalize (matching the model card's JS
 * quick-start), converts Float32Array → number[].
 */
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
