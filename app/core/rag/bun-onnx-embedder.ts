/** In-process local ONNX embedder for the Bun (Electrobun) shell. Spike 1.2
 *  proved onnxruntime-node's native N-API binding loads and runs under Bun
 *  1.4.0 — but @xenova/transformers' `pipeline()` cannot be used: its backend
 *  selector gates on `process.release.name === 'node'`, which is 'bun' here,
 *  so it would fall back to the onnxruntime-web WASM bundle. This module
 *  mirrors the spike instead: AutoTokenizer from @xenova/transformers (pure
 *  JS, runtime-agnostic — always imported by package name, never by dist/
 *  path, which loads the fs-less web bundle) plus a direct onnxruntime-node
 *  InferenceSession. Inference runs on ORT's native thread pool (async NAPI
 *  work), so the event loop — and therefore RPC — stays responsive while
 *  chunks embed; only tokenization + pooling run on this thread. Numerics
 *  match the Electron embedder child: per-text inference, mean pooling,
 *  L2 normalize. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tensor } from 'onnxruntime-node';
import type { Embedder } from './embedder.js';
import { LOCAL_META, MODEL_ID } from './embedder-process.js';
import { appDataDir } from '../../platform/paths.js';
import { stagedModelsDir } from '../../platform/native-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Candidate model roots, first match wins: explicit override (tests),
 *  the app's download dir (production — same location localModelExists()
 *  checks and model-downloader.ts writes), the copy staged into the
 *  Electrobun bundle (packaged), then the repo-vendored copy for dev
 *  checkouts that never ran a download (spike 1.2 used this exact dir). */
function resolveModelsDir(): string {
  const candidates = [
    process.env.TIDE_MODELS_DIR,
    path.join(appDataDir(), 'models'),
    stagedModelsDir(),
    path.join(__dirname, 'models'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, MODEL_ID, 'onnx', 'model_quantized.onnx'))) {
      return dir;
    }
  }
  return path.join(appDataDir(), 'models');
}

type TokenizedInput = { input_ids: { data: BigInt64Array } };

interface OrtModule {
  InferenceSession: {
    create(path: string): Promise<OrtSession>;
  };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => Tensor;
}

interface OrtSession {
  inputNames: string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}

/** Mean-pool masked positions + L2 normalize — identical to the pipeline's
 *  { pooling: 'mean', normalize: true } the Electron child uses. */
function poolNormalize(hidden: Float32Array, mask: BigInt64Array, dim: number): number[] {
  const seq = mask.length;
  const pooled = new Float64Array(dim);
  let maskSum = 0;
  for (let i = 0; i < seq; i++) {
    if (mask[i] !== 0n) {
      maskSum++;
      for (let j = 0; j < dim; j++) pooled[j] += hidden[i * dim + j];
    }
  }
  const denom = Math.max(maskSum, 1e-9);
  let norm = 0;
  for (let j = 0; j < dim; j++) {
    pooled[j] /= denom;
    norm += pooled[j] * pooled[j];
  }
  norm = Math.sqrt(norm) || 1;
  return Array.from(pooled, (v) => v / norm);
}

export class BunOnnxEmbedder implements Embedder {
  readonly id = LOCAL_META.id;
  readonly dim = LOCAL_META.dim;
  readonly maxTokens = LOCAL_META.maxTokens;

  private init: Promise<{ tokenizer: (text: string) => Promise<TokenizedInput>; session: OrtSession }> | null = null;
  private available: boolean | null = null;

  private ensure(): Promise<{ tokenizer: (text: string) => Promise<TokenizedInput>; session: OrtSession }> {
    if (!this.init) {
      this.init = (async () => {
        const modelsDir = resolveModelsDir();
        const { AutoTokenizer, env } = await import('@xenova/transformers');
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = modelsDir;
        const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

        // Node ESM interop: index.js re-exports via __exportStar that Node's
        // lexer can't see — prefer the CJS module object. Bun exposes both.
        const ortMod = await import('onnxruntime-node');
        const ort = ((ortMod as unknown as { default?: typeof ortMod }).default ?? ortMod) as unknown as OrtModule;
        const session = await ort.InferenceSession.create(
          path.join(modelsDir, MODEL_ID, 'onnx', 'model_quantized.onnx'),
        );
        return {
          tokenizer: (text: string) =>
            tokenizer(text, { add_special_tokens: true, truncation: true, max_length: LOCAL_META.maxTokens }) as Promise<TokenizedInput>,
          session,
        };
      })();
      this.init.catch(() => {
        this.init = null;
      });
    }
    return this.init;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const { tokenizer, session } = await this.ensure();
    const ort = await (async () => {
      const ortMod = await import('onnxruntime-node');
      return ((ortMod as unknown as { default?: typeof ortMod }).default ?? ortMod) as unknown as OrtModule;
    })();
    const vectors: number[][] = [];
    for (const text of texts) {
      const { input_ids } = await tokenizer(text);
      // Hard cap regardless of tokenizer options — the model's positional
      // embeddings are 512 rows; an over-long sequence crashes ORT with a
      // broadcast error inside the /embeddings Add node (512 by N).
      const max = LOCAL_META.maxTokens;
      const ids = input_ids.data.length > max ? input_ids.data.slice(0, max) : input_ids.data;
      const seq = ids.length;
      if (seq === 0) throw new Error('tokenizer returned empty input_ids');
      const feeds: Record<string, Tensor> = {};
      for (const name of session.inputNames) {
        let data: BigInt64Array;
        if (name === 'input_ids') data = ids;
        else if (name === 'attention_mask') data = new BigInt64Array(seq).fill(1n);
        else data = new BigInt64Array(seq);
        feeds[name] = new ort.Tensor('int64', data, [1, seq]);
      }
      const outputs = await session.run(feeds);
      const first = outputs[Object.keys(outputs)[0]!];
      const hidden = first.data as unknown as Float32Array;
      const dims = first.dims;
      const dim = dims[dims.length - 1] ?? 0;
      vectors.push(poolNormalize(hidden, feeds['attention_mask']!.data as unknown as BigInt64Array, dim));
    }
    this.available = true;
    return vectors;
  }

  isAvailable(): boolean | null {
    return this.available;
  }
}

let shared: BunOnnxEmbedder | null = null;

/** Seam target for setLocalEmbedderFactory — one lazy embedder per process,
 *  mirroring resolve.ts's module-level LocalOnnxEmbedder singleton. */
export function createBunLocalEmbedder(): BunOnnxEmbedder {
  if (!shared) shared = new BunOnnxEmbedder();
  return shared;
}
