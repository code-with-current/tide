/** Browser opener seam — keeps app/core free of shell imports. The Electrobun
 *  shell wires setBrowserOpener(Utils.openExternal) at boot; the frozen
 *  Electron shell has no wiring and falls back to electron.shell via
 *  createRequire (never statically imported — same pattern as secrets.ts). */

import { createRequire } from 'node:module';

export type BrowserOpener = (url: string) => void | Promise<void>;

let opener: BrowserOpener | undefined;

export function setBrowserOpener(fn: BrowserOpener | undefined): void {
  opener = fn;
}

export async function openInBrowser(url: string): Promise<void> {
  if (opener) {
    await opener(url);
    return;
  }
  const versions = process.versions as Record<string, string | undefined>;
  if (!versions['electron']) {
    throw new Error(`no browser opener configured (url: ${url})`);
  }
  const req = createRequire(import.meta.url);
  const electron = req('electron') as { shell?: { openExternal: (u: string) => Promise<void> } };
  await electron.shell!.openExternal(url);
}
