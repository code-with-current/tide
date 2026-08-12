/** Config persistence — thin wrapper around configStore that wires Electron's safeStorage and preserves the existing public API. Lazily initialized on first access (NOT at import) so appDataDir() resolves correctly after app.whenReady's userData relocation. */

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
export const getMcpServers = (...a: Parameters<ReturnType<typeof createConfigStore>['getMcpServers']>) => getStore().getMcpServers(...a);
export const setMcpServers = (...a: Parameters<ReturnType<typeof createConfigStore>['setMcpServers']>) => getStore().setMcpServers(...a);
export const getMcpOAuth = (...a: Parameters<ReturnType<typeof createConfigStore>['getMcpOAuth']>) => getStore().getMcpOAuth(...a);
export const setMcpOAuth = (...a: Parameters<ReturnType<typeof createConfigStore>['setMcpOAuth']>) => getStore().setMcpOAuth(...a);
export const getWorkspaceMcpOAuth = (...a: Parameters<ReturnType<typeof createConfigStore>['getWorkspaceMcpOAuth']>) => getStore().getWorkspaceMcpOAuth(...a);
export const setWorkspaceMcpOAuth = (...a: Parameters<ReturnType<typeof createConfigStore>['setWorkspaceMcpOAuth']>) => getStore().setWorkspaceMcpOAuth(...a);
export const getExtensions = (...a: Parameters<ReturnType<typeof createConfigStore>['getExtensions']>) => getStore().getExtensions(...a);
export const setExtensions = (...a: Parameters<ReturnType<typeof createConfigStore>['setExtensions']>) => getStore().setExtensions(...a);
