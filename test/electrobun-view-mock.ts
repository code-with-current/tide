/** Vitest mock for the Electrobun view SDK. The real devkit module (aliased from
 *  `electrobun/view` in vite.config.ts) reads `window` at module scope, which
 *  throws in the node test environment. Renderer code under test always takes
 *  the hasRpc === false path, so these stubs are never actually invoked — they
 *  only need to import cleanly. */

export class Electroview {
  static defineRPC(_config: unknown): unknown {
    throw new Error('Electroview.defineRPC called outside an Electrobun webview');
  }
  constructor(_config: unknown) {
    throw new Error('Electroview constructed outside an Electrobun webview');
  }
}

export default { Electroview };
