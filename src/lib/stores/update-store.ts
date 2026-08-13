/** Singleton update-status store.
 *  Registers ONE IPC listener on init and shares status across all consumers
 *  (sidebar pill, settings page). Avoids the preload's removeAllListeners
 *  clash that occurs when multiple components each call onUpdaterStatus. */

import { create } from 'zustand';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
  lastCheckedAt?: number | null;
}

interface UpdateStore {
  status: UpdateStatus | null;
  setStatus: (s: UpdateStatus) => void;
  init: () => void;
}

let listenerAttached = false;

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: null,
  setStatus: (s) => set({ status: s }),
  init: () => {
    if (listenerAttached) return;
    listenerAttached = true;
    const ipc = window.tideIpc;
    if (!ipc) return;
    ipc.onUpdaterStatus((s) => set({ status: s as UpdateStatus }));
    ipc.updater.getStatus().then((s) => set({ status: s as UpdateStatus })).catch(() => {});
  },
}));

/** Convenience selector: true when an update is available, downloading, or downloaded. */
export function hasUpdate(s: UpdateStatus | null): boolean {
  return !!s && (s.state === 'available' || s.state === 'downloading' || s.state === 'downloaded');
}
