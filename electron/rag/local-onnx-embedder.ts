import { utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Embedder } from './embedder.js';
import { LOCAL_META, MODEL_ID, type EmbedResponse } from './embedder-process.js';
import { appDataDir } from '../appPaths.js';

// ESM has no global __dirname — derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Parent-side client for the local ONNX embedder: lazily spawns a utilityProcess running embedder-process.js, talks over the parent↔child port, and correlates requests by id. Errors reject the pending embed() promise so callers can fall back to cloud. */
export class LocalOnnxEmbedder implements Embedder {
  readonly id = LOCAL_META.id;
  readonly dim = LOCAL_META.dim;
  readonly maxTokens = LOCAL_META.maxTokens;

  private child: UtilityProcess | null = null;
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve: (v: number[][]) => void; reject: (e: Error) => void }
  >();
  private available: boolean | null = null;

  private ensureChild(): void {
    if (this.child) return;
    // dist-electron/embedder-process.mjs — built as a standalone entry by
    // vite.electron.config.ts so utilityProcess.fork can load it directly
    // (it is NOT inlined into main.mjs). The .mjs extension matches the
    // build output; package.json's "type": "module" makes it load as ESM.
    const entry = path.join(__dirname, 'embedder-process.mjs');
    const env = {
      ...process.env,
      TIDE_MODELS_DIR: path.join(appDataDir(), 'models'),
    };
    this.child = utilityProcess.fork(entry, [], { stdio: 'pipe', env });

    // Child → parent: replies arrive as 'message' events whose payload is
    // the EmbedResponse we shaped in embedder-process.ts.
    this.child.on('message', (msg: unknown) => {
      const resp = msg as EmbedResponse;
      const p = this.pending.get(resp.id);
      if (!p) return; // stale or already-aborted; drop silently
      this.pending.delete(resp.id);
      if (resp.type === 'result') {
        this.available = true;
        p.resolve(resp.vectors);
      } else {
        p.reject(new Error(resp.message));
      }
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.ensureChild();
    const id = String(++this.nextId);
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.postMessage({ type: 'embed', id, texts });
    });
  }

  /** Cheap probe: true after at least one successful embed, null before.
   *  A full pre-spawn availability check (load the model without embedding)
   *  is out of scope for v1 — the first embed IS the check. */
  isAvailable(): boolean | null {
    return this.available;
  }
}

export function localModelExists(): boolean {
  const modelsDir = process.env.TIDE_MODELS_DIR ?? path.join(appDataDir(), 'models');
  const modelPath = path.join(modelsDir, MODEL_ID, 'onnx', 'model_quantized.onnx');
  return fs.existsSync(modelPath);
}
