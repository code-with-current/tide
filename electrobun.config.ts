import type { ElectrobunConfig } from "electrobun";

// Native assets the main process resolves at runtime (dlopen'd sqlite-vec,
// onnxruntime-node's N-API binding, tree-sitter wasm, the vendored ONNX
// model) cannot be merged into the JS bundle, so build.copy stages them next
// to it. The config is evaluated on the BUILD machine, which is also the
// target in the release matrix — gate on process.platform/process.arch so
// each platform ships only its own binaries. app/platform/native-assets.ts
// is the layout contract these dests must match.
const vecOs = process.platform === "win32" ? "windows" : process.platform;
const sqliteVecPkg = `node_modules/sqlite-vec-${vecOs}-${process.arch}`;

const copy: Record<string, string> = {
  // The renderer is built by Vite into dist/ (pnpm build); copy it wholesale
  // instead of declaring per-view devkit entrypoints.
  dist: "views/mainview",
  // tree-sitter grammar wasms (vendored by postinstall) + the
  // web-tree-sitter core wasm — RAG chunking loads both at init.
  "app/core/rag/chunker/grammars": "native/grammars",
  "node_modules/web-tree-sitter/tree-sitter.wasm": "native/grammars/tree-sitter.wasm",
  // Vendored ONNX embedding model (~23MB) for local embeddings.
  "app/core/rag/models": "native/models",
  // onnxruntime-node `require`s its binding relative to the bundle at
  // runtime ("../bin/napi-v3/<platform>/<arch>"), so the dest must be
  // exactly bin/… (the dylib next to the .node loads via @loader_path).
  [`node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}`]: `bin/napi-v3/${process.platform}/${process.arch}`,
  // sqlite-vec platform package, staged under node_modules/ so both the
  // native-assets seam and plain runtime package resolution find it.
  [sqliteVecPkg]: sqliteVecPkg,
};

if (process.platform === "darwin") {
  // Vanilla libsqlite3 (Homebrew build, vendored so CI never needs Homebrew)
  // for Database.setCustomSQLite — Bun links Apple's system SQLite, which has
  // extension loading disabled, so sqlite-vec can't load without this.
  copy["build/native/libsqlite3.dylib"] = "native/lib/libsqlite3.dylib";
}

if (process.platform === "win32") {
  // POSIX terminals ride Bun's native Terminal API; Windows still drives
  // node-pty, whose JS + prebuilds are require()d at runtime (bare
  // specifier → node_modules walk-up from the bundle).
  copy["node_modules/node-pty"] = "node_modules/node-pty";
}

export default {
  app: {
    name: "Tide",
    identifier: "com.tide.code",
    version: "0.3.0-beta.1",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "app/main.ts",
    },
    // Tide's tracked build/ dir holds its own scripts; keep Hutch output in a
    // dedicated subtree so both can coexist.
    buildFolder: "build/electrobun",
    copy,
    mac: {
      bundleCEF: false,
      icons: "build/icon.iconset",
    },
    linux: {
      bundleCEF: false,
      icon: "build/icon.png",
    },
    win: {
      bundleCEF: false,
      icon: "build/icon.ico",
    },
  },
} satisfies ElectrobunConfig;
