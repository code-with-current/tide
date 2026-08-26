/** Native-asset resolution for the Electrobun shell. The main-process bundle
 *  merges every module into one JS file, so assets that are resolved at
 *  runtime — dlopen'd libraries, wasm binaries, the vendored ONNX model —
 *  cannot ride along in the bundle. `electrobun.config.ts` `build.copy`
 *  stages them into the app (Resources/app/ on macOS); this module is the
 *  single place that knows the layout contract, so packaged and dev/test
 *  layouts stay in sync with the copy map:
 *
 *    node_modules/sqlite-vec-<os>-<arch>/vec0.<ext>  sqlite-vec platform pkg
 *    bin/napi-v3/<platform>/<arch>/…                 onnxruntime-node binding
 *    native/grammars/*.wasm                          tree-sitter grammars + core wasm
 *    native/models/…                                 vendored ONNX embedding model
 *    native/lib/libsqlite3.dylib                      vanilla libsqlite3 (darwin only)
 *    node_modules/node-pty/                           Windows terminal backend
 *
 *  Dest paths are relative to Resources/app in the bundle. onnxruntime-node
 *  locates its binding via a runtime `require("../bin/napi-v3/…")` relative
 *  to the bundle file (Resources/app/bun/index.js), which is why its staged
 *  dest must be exactly `bin/…`; everything else is resolved through this
 *  module. The sqlite-vec package and node-pty are staged under
 *  `node_modules/` so plain runtime package resolution (createRequire /
 *  import.meta.resolve walk-up) also finds them without help. */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const selfDir = path.dirname(fileURLToPath(import.meta.url));

/** Roots that may hold staged assets. The Electrobun bundle merges every
 *  module into <app>/bun/index.js (selfDir/.. = Resources/app), while dev
 *  and vitest runs execute this file from app/platform/ (selfDir/../.. =
 *  repo root). Lookups probe both; existence checks disambiguate. */
function assetRoots(): string[] {
  return [path.resolve(selfDir, '..'), path.resolve(selfDir, '..', '..')];
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Absolute path to the loadable sqlite-vec extension for this platform.
 *  Staged package first (packaged builds — and dev checkouts, which have the
 *  identical node_modules layout), then the sqlite-vec npm package's own
 *  resolver as a last resort (covers bun's global-cache layout). Throws when
 *  neither resolves — the caller surfaces it as a store-open failure. */
export function sqliteVecLibraryPath(): string {
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  const pkg = `sqlite-vec-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const staged = firstExisting(
    assetRoots().map((root) => path.join(root, 'node_modules', pkg, `vec0.${ext}`)),
  );
  if (staged) return staged;
  const { getLoadablePath } = require('sqlite-vec') as typeof import('sqlite-vec');
  return getLoadablePath();
}

/** Staged tree-sitter dir (grammar wasms + web-tree-sitter core wasm), or
 *  undefined outside a packaged build. Consumers validate their expected
 *  files inside before using it. */
export function stagedTreeSitterDir(): string | undefined {
  return firstExisting(assetRoots().map((root) => path.join(root, 'native', 'grammars')));
}

/** Staged vendored ONNX model root (contains <model-id>/onnx/*.onnx), or
 *  undefined outside a packaged build. */
export function stagedModelsDir(): string | undefined {
  return firstExisting(assetRoots().map((root) => path.join(root, 'native', 'models')));
}

/** Staged vanilla libsqlite3.dylib (vendored from Homebrew at
 *  build/native/, darwin builds only), or undefined when not staged. Bun's
 *  bundled SQLite on macOS has extension loading disabled — sqlite.ts points
 *  bun:sqlite at this dylib so loadExtension (sqlite-vec) works. */
export function stagedLibSqlitePath(): string | undefined {
  return firstExisting(assetRoots().map((root) => path.join(root, 'native', 'lib', 'libsqlite3.dylib')));
}
