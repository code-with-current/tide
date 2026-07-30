/**
 * Vite config for building the Electron main + preload scripts.
 *
 * Compiles electron/main.ts and electron/preload.ts to dist-electron/ as ESM
 * .mjs files. Runs alongside the renderer build (`vite build` using the main
 * vite.config.ts).
 *
 * Usage: `vite build --config vite.electron.config.ts`
 */
import { defineConfig } from 'vite';
import path from 'node:path';
import { builtinModules } from 'node:module';

// Full list of Node builtin module names (without the `node:` prefix).
// Used to externalize BOTH bare (`import 'fs'`) and prefixed (`import 'node:fs'`)
// forms — Vite shims any non-externalized Node builtin as a browser no-op,
// which breaks the main process at startup (e.g. `util.debuglog` missing,
// `url.fileURLToPath` missing).
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

export default defineConfig({
  publicDir: false,
  // Electron runs in Node, not browser. Set the target to node so Vite
  // doesn't shim Node builtins (node:path, node:url) as browser no-ops.
  build: {
    outDir: 'dist-electron',
    target: 'node22',
    lib: {
      entry: {
        main: path.resolve(__dirname, 'electron/main.ts'),
        preload: path.resolve(__dirname, 'electron/preload.ts'),
        // utilityProcess entry for the local ONNX embedder. Spawns run this
        // file directly (utilityProcess.fork), so it MUST be a standalone
        // build output — not inlined into main.mjs. See local-onnx-embedder.ts.
        'embedder-process': path.resolve(__dirname, 'electron/rag/embedder-process.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      // Externalize:
      //   - electron itself (provided by the runtime)
      //   - all Node builtin modules in BOTH bare (`fs`, `path`, `url`,
      //     `util`, ...) and prefixed (`node:fs`, `node:url`, ...) forms.
      //     Critical: undici imports `node:util` and calls `util.debuglog`;
      //     the codebase imports `fileURLToPath` from `url`. Without
      //     externalization, Vite's browser shim makes both crash at startup.
      //   - undici explicitly. Bundling breaks (see node:util note above), so
      //     it's left external — which means it MUST be declared as a runtime
      //     dependency in package.json. Node powers its global fetch with
      //     undici internally, but does not expose `'undici'` as a resolvable
      //     bare module, so the npm package is still required.
      external: (id) =>
        id === 'electron' ||
        id === 'undici' ||
        id === 'node-pty' ||
        id === 'better-sqlite3' ||
        id === 'sqlite-vec' ||
        id === 'web-tree-sitter' ||
        id === 'onnxruntime-node' ||
        id === 'onnxruntime-web' ||
        id === 'onnxruntime-common' ||
        id === '@xenova/transformers' ||
        id === 'sharp' ||
        // MCP SDK uses child_process (cross-spawn) internally — must be
        // externalized, not bundled. Bundling breaks because the SDK's CJS
        // require('child_process') can't resolve in the ESM output.
        id === '@modelcontextprotocol/sdk' ||
        id.startsWith('@modelcontextprotocol/sdk/') ||
        NODE_BUILTINS.has(id),
    },
    // false: do NOT wipe dist-electron on every build. The dir holds staged
    // assets (grammars/*.wasm, models/*.onnx) that copy-tree-sitter-grammars.mjs
    // puts there; emptyOutDir:true deleted them every launch, forcing a re-stage
    // AND making smart-dev.mjs see "grammars missing" → redundant rebuild loop.
    // Vite overwrites its own outputs (main.mjs, preload.mjs, chunks) in place,
    // so stale-output risk is limited to deleted source modules (rare; clear
    // dist-electron/ manually if a removed entry's chunk lingers).
    emptyOutDir: false,
    minify: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
