/** Vitest mock for the Electrobun main SDK. The real devkit module (aliased
 *  from `electrobun/main` in tsconfig paths) talks to native ffi at module
 *  scope, which is unimportable in the node test environment. App-side RPC
 *  handlers under test inject their side effects, so these stubs only need to
 *  import cleanly; extend as tests start touching more of the surface. */

export const Utils = {
  openExternal: (_url: string): boolean => false,
  openPath: (_path: string): boolean => false,
  showItemInFolder: (_path: string): void => {},
  moveToTrash: (_path: string): void => {},
  showNotification: (_opts: { title: string; body?: string }): void => {},
  openFileDialog: async (_opts: Record<string, unknown>): Promise<string[]> => [],
  quit(): void {},
};

/** Captured before-quit handlers — tests drive them via `emitBeforeQuit`,
 * mirroring how the devkit's quit-approval flow emits synchronously. */
const beforeQuitHandlers: Array<(payload: unknown) => void> = [];

export const app = {
  on(name: string, handler: (payload: unknown) => void): () => void {
    if (name === 'before-quit') beforeQuitHandlers.push(handler);
    return () => {};
  },
  quit(): void {},
};

export function emitBeforeQuit(): void {
  for (const handler of [...beforeQuitHandlers]) handler({});
}

/** Inert devkit Updater stand-in; app/updater.ts injects richer fakes. */
export const Updater = {
  onStatusChange(_cb: unknown): void {},
  async checkForUpdate() {
    return { version: '', hash: '', updateAvailable: false, updateReady: false, error: '' };
  },
  async downloadUpdate(): Promise<void> {},
  async applyUpdate(): Promise<void> {},
  updateInfo() {
    return { version: '', hash: '', updateAvailable: false, updateReady: false, error: '' };
  },
  async getLocalInfo() {
    return { version: '', hash: '', baseUrl: '', channel: 'dev', name: '', identifier: '' };
  },
};

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  isFullScreen(): boolean {
    return false;
  }
  isDestroyed(): boolean {
    return true;
  }
}

export class BrowserView {
  static defineRPC(_config: unknown): unknown {
    throw new Error('BrowserView.defineRPC called outside Electrobun');
  }
}

export default { Utils, app, Updater, BrowserWindow, BrowserView };
