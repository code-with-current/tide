// Ambient Tauri webview detection. Tauri v2 injects this global before any
// page script runs — its presence is the "inside the app shell" signal the
// RPC seam (src/lib/api/rpc.ts) gates on. The renderer never reads anything
// off it directly; bridge calls go through the typed seam. Declared on both
// Window and the global scope so `globalThis.__TAURI_INTERNALS__` (how the
// seam probes it, node-test compatible) typechecks too.
interface Window {
  __TAURI_INTERNALS__?: unknown;
}

declare var __TAURI_INTERNALS__: unknown | undefined;
