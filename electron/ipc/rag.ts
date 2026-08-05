/** RAG IPC for the Memory & RAG panel: status / downloadModel / enableWorkspace / disableWorkspace / initWorkspace handlers, plus the tide:rag:initProgress and tide:rag:downloadProgress event channels. */
import { ipcMain, BrowserWindow, app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as store from '../store.js';
import { hydrateRagConfig } from '../configStore.js';
import { isRagCloudConfigured } from '../agent/system-model.js';
import { localModelExists } from '../rag/local-onnx-embedder.js';
import { downloadModel } from '../rag/model-downloader.js';
import { ingestWorkspace } from '../rag/ingest.js';
import { createLogger } from '../logger.js';
import { appDataDir } from '../appPaths.js';
import type {
  RagStatus,
  RagWorkspaceOpResult,
  RagInitResult,
  RagInitProgressEvent,
} from '../../src/types';

const log = createLogger('rag');
const runningInits = new Map<string, Promise<unknown>>();

const EMPTY_STATUS: RagStatus = {
  embedderId: null,
  dim: 384,
  enabledWorkspaces: [],
  cloudAllowed: false,
  chunkTokens: 384,
  localAvailable: null,
  cloudConfigured: false,
  chunkCount: 0,
  initState: 'never',
  lastIngestedAt: null,
  state: 'no-index',
};

export function getRagStatus(workspaceId: string): RagStatus {
  const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
  if (!ws) return { ...EMPTY_STATUS, enabledWorkspaces: store.listRagEnabledWorkspaces() };

  const ragConfig = hydrateRagConfig(ws.ragConfig);
  const localAvailable = localModelExists();
  const cloudConfigured = isRagCloudConfigured();

  let state: RagStatus['state'];
  if (ragConfig.embedderId === 'cloud-base') {
    state = 'cloud-fallback';
  } else if (localAvailable) {
    state = 'ok';
  } else if (ragConfig.cloudAllowed && cloudConfigured) {
    state = 'cloud-fallback';
  } else {
    state = 'unavailable';
  }

  const { chunkCount, lastIngestedAt } = readIngestState(workspaceId);
  const initState: RagStatus['initState'] = runningInits.has(workspaceId)
    ? 'running'
    : lastIngestedAt !== null
      ? 'done'
      : 'never';

  return {
    embedderId: ragConfig.embedderId,
    dim: ragConfig.dim,
    enabledWorkspaces: store.listRagEnabledWorkspaces(),
    cloudAllowed: ragConfig.cloudAllowed,
    chunkTokens: ragConfig.chunkTokens,
    localAvailable,
    cloudConfigured,
    chunkCount,
    initState,
    lastIngestedAt,
    state,
  };
}

function readIngestState(workspaceId: string): { chunkCount: number; lastIngestedAt: number | null } {
  const dbPath = path.join(appDataDir(), 'rag', workspaceId, 'index.db');
  if (!fs.existsSync(dbPath)) return { chunkCount: 0, lastIngestedAt: null };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const countRow = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'lastIngestedAt'").get() as { value?: string } | undefined;
      return { chunkCount: countRow.n, lastIngestedAt: metaRow?.value ? Number(metaRow.value) : null };
    } finally {
      db.close();
    }
  } catch {
    return { chunkCount: 0, lastIngestedAt: null };
  }
}

export async function downloadRagModel(): Promise<RagWorkspaceOpResult> {
  if (localModelExists()) return { ok: true };
  try {
    await downloadModel((progress) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('tide:rag:downloadProgress', {
          received: progress.received,
          total: progress.total,
          phase: 'downloading' as const,
        });
      }
    });
    // Final event — signals completion.
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('tide:rag:downloadProgress', {
        received: 0,
        total: 0,
        phase: 'done' as const,
      });
    }
    return { ok: true };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    log.error('model download failed', { err: e });
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('tide:rag:downloadProgress', {
        received: 0,
        total: 0,
        phase: 'failed' as const,
        error,
      });
    }
    return { ok: false, error };
  }
}

export async function enableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  const dl = await downloadRagModel();
  if (!dl.ok) return dl;
  store.addRagEnabledWorkspace(workspaceId);
  return { ok: true };
}

export function disableRagWorkspace(workspaceId: string): RagWorkspaceOpResult {
  store.removeRagEnabledWorkspace(workspaceId);
  return { ok: true };
}

export function initRagWorkspace(workspaceId: string): RagInitResult {
  if (runningInits.has(workspaceId)) {
    return { ok: false, error: 'init already running for this workspace' };
  }
  const startedAt = Date.now();
  const progress = (partial: Omit<RagInitProgressEvent, 'workspaceId'>) => {
    const event: RagInitProgressEvent = { workspaceId, ...partial };
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('tide:rag:initProgress', event);
    }
  };
  const p = (async () => {
    try {
      await ingestWorkspace(workspaceId, { onProgress: (e) => progress(e) });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      log.error('init failed', { workspaceId, err: e });
      progress({ phase: 'failed', filesSeen: 0, chunksTotal: 0, chunksEmbedded: 0, error });
    } finally {
      runningInits.delete(workspaceId);
    }
  })();
  runningInits.set(workspaceId, p);
  return { ok: true, startedAt };
}

export function registerRagHandlers(): void {
  ipcMain.handle('tide:rag:status', (_e: unknown, workspaceId: string) => {
    try {
      return getRagStatus(workspaceId);
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'failed' };
    }
  });
  ipcMain.handle('tide:rag:downloadModel', async () => downloadRagModel());
  ipcMain.handle('tide:rag:modelExists', () => localModelExists());
  ipcMain.handle('tide:rag:enableWorkspace', async (_e: unknown, workspaceId: string) => enableRagWorkspace(workspaceId));
  ipcMain.handle('tide:rag:disableWorkspace', (_e: unknown, workspaceId: string) => disableRagWorkspace(workspaceId));
  ipcMain.handle('tide:rag:initWorkspace', (_e: unknown, workspaceId: string) => initRagWorkspace(workspaceId));
}
