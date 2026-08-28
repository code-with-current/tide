/** Singleton update-status store.
 *  Registers ONE updateStatus subscription on init and shares the latest
 *  reduced snapshot across all consumers (sidebar pill, release dialogs,
 *  settings page); the seed fetch (updaterStatus request) covers the
 *  pre-subscription window. Outside a real webview both paths no-op and the
 *  store stays null — the pill stays hidden, settings shows its idle hero.
 *
 *  Consent flow owns two dialogs: 'release' (release details + changelog +
 *  Download) and 'progress' (download progress → Later / Restart Now).
 *  Download/apply actions live here so the pill, dialogs, and Settings →
 *  Updates all drive the exact same transitions — download() swaps to the
 *  progress dialog, applyUpdate() relaunches, and "Later" is nothing more
 *  than closeDialog() (the prepared update stays ready on disk and the
 *  store re-detects it on the next boot). */

import { create } from 'zustand';
import type { UpdatePhase, UpdateStatusWire } from '@shared/rpc';
import { onUpdateStatus } from '@/lib/api/rpc';
import { getUpdaterStatus, downloadUpdate, applyUpdate } from '@/lib/api/client';

export type { UpdatePhase, UpdateStatusWire };

export type UpdateDialog = 'release' | 'progress' | null;

interface UpdateStore {
  status: UpdateStatusWire | null;
  /** Which update dialog is open (null = none). */
  dialog: UpdateDialog;
  setStatus: (s: UpdateStatusWire) => void;
  openReleaseDialog: () => void;
  openProgressDialog: () => void;
  closeDialog: () => void;
  /** Consent action 1 — download only; swaps to the progress dialog. */
  download: () => void;
  /** Consent action 2 — apply a prepared update (swap + relaunch). */
  applyNow: () => void;
  init: () => void;
}

let listenerAttached = false;

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: null,
  dialog: null,
  setStatus: (s) => set({ status: s }),
  openReleaseDialog: () => set({ dialog: 'release' }),
  openProgressDialog: () => set({ dialog: 'progress' }),
  closeDialog: () => set({ dialog: null }),
  download: () => {
    set({ dialog: 'progress' });
    void downloadUpdate();
  },
  applyNow: () => {
    void applyUpdate();
  },
  init: () => {
    if (listenerAttached) return;
    listenerAttached = true;
    onUpdateStatus((s) => set({ status: s }));
    // Seed only when nothing arrived yet — a push landing between request
    // and response is always at least as fresh as the snapshot.
    void getUpdaterStatus()
      .then((s) => { if (s) set((prev) => (prev.status ? prev : { status: s })); })
      .catch(() => {});
  },
}));

/** Convenience selector: true while an update is in flight or staged. */
export function hasUpdate(s: UpdateStatusWire | null): boolean {
  return (
    !!s &&
    (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'downloaded' || s.phase === 'applying')
  );
}

/** True when the Download consent action can run: an update is waiting for
 *  approval, or a consent-driven attempt failed (the failure keeps the
 *  target version so the button can offer a retry). */
export function canDownloadUpdate(s: UpdateStatusWire | null): boolean {
  return (
    !!s &&
    (s.phase === 'available' || (s.phase === 'error' && !!s.version))
  );
}

/** True when Restart Now can run: a prepared update is on disk. */
export function canRestartUpdate(s: UpdateStatusWire | null): boolean {
  return !!s && s.phase === 'downloaded';
}
