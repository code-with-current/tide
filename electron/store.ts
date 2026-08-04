/**
 * Config persistence — thin wrapper around configStore.
 *
 * The actual storage logic lives in ./configStore.js, parameterized by
 * directory + CryptoOps. This file wires Electron's safeStorage and
 * preserves the exact public API every existing caller relies on.
 *
 * IMPORTANT: the store is lazily initialized on first access, NOT at module
 * import time. This is because app.setPath('userData', '~/.tide') runs inside
 * app.whenReady() in main.ts — if we called appDataDir() at import
 * time (before whenReady), we'd get the stock Electron path
 * (~/Library/Application Support/tide) instead of the relocated ~/.tide,
 * causing the store to read/write the wrong location. The lazy proxy defers
 * the createConfigStore call until the first method access, which always
 * happens inside whenReady (via IPC handler registration).
 */

import { app, safeStorage } from 'electron';
import * as sessionsModule from './ipc/sessions.js';
import { createConfigStore, type CryptoOps, type WorkspaceCascadeOps } from './configStore.js';
import { appDataDir } from './appPaths.js';

const crypto: CryptoOps = {
  encrypt: (s: string): string => {
    if (!s) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      // Plaintext fallback (development without keychain).
      return s;
    }
    return safeStorage.encryptString(s).toString('base64');
  },
  decrypt: (s: string): string => {
    if (!s) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      return s; // plaintext fallback
    }
    try {
      return safeStorage.decryptString(Buffer.from(s, 'base64'));
    } catch {
      return '';
    }
  },
};

function cascadeOps(): WorkspaceCascadeOps {
  return {
    archiveSessionsByWorkspace: (wid) => {
      for (const s of sessionsModule.listSessions(wid)) {
        sessionsModule.archiveSession(s.id);
      }
    },
    unarchiveSessionsByWorkspace: (wid) => {
      for (const h of sessionsModule.listArchivedSessions(wid)) {
        sessionsModule.unarchiveSession(h.id);
      }
    },
    deleteSessionsByWorkspace: (wid) => {
      for (const s of sessionsModule.listSessions(wid)) sessionsModule.deleteSession(s.id);
      for (const h of sessionsModule.listArchivedSessions(wid)) sessionsModule.deleteSession(h.id);
    },
  };
}

// Lazy store — created on first access. appDataDir() is correct
// at that point because setUserDataPath ran earlier in whenReady.
let _store: ReturnType<typeof createConfigStore> | null = null;
function getStore() {
  if (!_store) {
    _store = createConfigStore(appDataDir(), crypto);
  }
  return _store;
}

// Re-export every public function with lazy access. Each function calls
// getStore() at invocation time (not import time), so the config path is
// always the relocated ~/.tide, never the stock Electron path.
export const listProviders = (...a: Parameters<ReturnType<typeof createConfigStore>['listProviders']>) => getStore().listProviders(...a);
export const addProvider = (...a: Parameters<ReturnType<typeof createConfigStore>['addProvider']>) => getStore().addProvider(...a);
export const updateProvider = (...a: Parameters<ReturnType<typeof createConfigStore>['updateProvider']>) => getStore().updateProvider(...a);
export const deleteProvider = (...a: Parameters<ReturnType<typeof createConfigStore>['deleteProvider']>) => getStore().deleteProvider(...a);
export const listWorkspaces = (...a: Parameters<ReturnType<typeof createConfigStore>['listWorkspaces']>) => getStore().listWorkspaces(...a);
export const addWorkspace = (...a: Parameters<ReturnType<typeof createConfigStore>['addWorkspace']>) => getStore().addWorkspace(...a);
export const updateWorkspace = (...a: Parameters<ReturnType<typeof createConfigStore>['updateWorkspace']>) => getStore().updateWorkspace(...a);
export function archiveWorkspace(id: string): void {
  getStore().archiveWorkspace(id, cascadeOps());
}
export function unarchiveWorkspace(id: string): void {
  getStore().unarchiveWorkspace(id, cascadeOps());
}
export function deleteWorkspace(id: string): void {
  getStore().deleteWorkspace(id, cascadeOps());
}
export const getLastSession = (...a: Parameters<ReturnType<typeof createConfigStore>['getLastSession']>) => getStore().getLastSession(...a);
export const setLastSession = (...a: Parameters<ReturnType<typeof createConfigStore>['setLastSession']>) => getStore().setLastSession(...a);
export const getSecret = (...a: Parameters<ReturnType<typeof createConfigStore>['getSecret']>) => getStore().getSecret(...a);
export const setSecret = (...a: Parameters<ReturnType<typeof createConfigStore>['setSecret']>) => getStore().setSecret(...a);
export const getAgentSettings = (...a: Parameters<ReturnType<typeof createConfigStore>['getAgentSettings']>) => getStore().getAgentSettings(...a);
export const updateAgentSettings = (...a: Parameters<ReturnType<typeof createConfigStore>['updateAgentSettings']>) => getStore().updateAgentSettings(...a);
export const getGeneralSettings = (...a: Parameters<ReturnType<typeof createConfigStore>['getGeneralSettings']>) => getStore().getGeneralSettings(...a);
export const updateGeneralSettings = (...a: Parameters<ReturnType<typeof createConfigStore>['updateGeneralSettings']>) => getStore().updateGeneralSettings(...a);
export const listRagEnabledWorkspaces = (...a: Parameters<ReturnType<typeof createConfigStore>['listRagEnabledWorkspaces']>) => getStore().listRagEnabledWorkspaces(...a);
export const addRagEnabledWorkspace = (...a: Parameters<ReturnType<typeof createConfigStore>['addRagEnabledWorkspace']>) => getStore().addRagEnabledWorkspace(...a);
export const removeRagEnabledWorkspace = (...a: Parameters<ReturnType<typeof createConfigStore>['removeRagEnabledWorkspace']>) => getStore().removeRagEnabledWorkspace(...a);
