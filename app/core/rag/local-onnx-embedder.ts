import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Embedder } from './embedder.js';
import { LOCAL_META, MODEL_ID, type EmbedResponse } from './embedder-process.js';
import { appDataDir } from '../../platform/paths.js';

// ESM has no global __dirname — derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Child-process surface LocalOnnxEmbedder needs (Electron's UtilityProcess satisfies this structurally). */
export interface EmbedderChild {
  on(event: 'message', listener: (message: unknown) => void): void;
  postMessage(message: unknown): void;
}

/** Spawn hook injected by the shell (Electron main wires `utilityProcess.fork`; Electrobun gets a Bun-native adapter later). null → local embedder unavailable, callers fall back to cloud. */
export type EmbedderProcessFactory = (
  entry: string,
  args: string[],
  options: { stdio: 'pipe'; env: Record<string, string | undefined> },
) => EmbedderChild;

let embedderProcessFactory: EmbedderProcessFactory | null = null;

/** Register the shell's embedder-child spawn hook. Must be set before the first embed for local embeddings to work. */
export function setEmbedderProcessFactory(factory: EmbedderProcessFactory | null): void {
  embedderProcessFactory = factory;
}

/** Parent-side client for the local ONNX embedder: lazily spawns a child process running embedder-process.js via the injected factory, talks over the parent↔child port, and correlates requests by id. Errors reject the pending embed() promise so callers can fall back to cloud. */
export class LocalOnnxEmbedder implements Embedder {
  readonly id = LOCAL_META.id;
  readonly dim = LOCAL_META.dim;
  readonly maxTokens = LOCAL_META.maxTokens;

  private child: EmbedderChild | null = null;
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve: (v: number[][]) => void; reject: (e: Error) => void }
  >();
  private available: boolean | null = null;

  private ensureChild(): void {
    if (this.child) return;
    // No shell-provided spawn hook (tests, or a shell without an embedder
    // process adapter yet) — leave the child unset; embed() rejects and the
    // caller falls back to the cloud embedder.
    if (!embedderProcessFactory) return;
    // embedder-process.mjs — a standalone build of embedder-process.ts so the
    // process fork can load it directly (it is NOT inlined into the main
    // bundle). The .mjs extension matches the build output; package.json's
    // "type": "module" makes it load as ESM.
    const entry = path.join(__dirname, 'embedder-process.mjs');
    const env = {
      ...process.env,
      TIDE_MODELS_DIR: path.join(appDataDir(), 'models'),
    };
    this.child = embedderProcessFactory(entry, [], { stdio: 'pipe', env });

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
      if (!this.child) {
        reject(new Error('local embedder process unavailable (no factory registered)'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ type: 'embed', id, texts });
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
