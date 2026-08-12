import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  listWorkspacesMock, listRagEnabledWorkspacesMock, addRagEnabledWorkspaceMock,
  removeRagEnabledWorkspaceMock, isRagCloudConfiguredMock, localProbeMock,
  LocalMock, localModelExistsMock, downloadModelMock,
} = vi.hoisted(() => {
  const listWorkspacesMock = vi.fn(() => [] as Array<{ id: string; ragConfig?: unknown }>);
  const listRagEnabledWorkspacesMock = vi.fn((): string[] => []);
  const addRagEnabledWorkspaceMock = vi.fn();
  const removeRagEnabledWorkspaceMock = vi.fn();
  const isRagCloudConfiguredMock = vi.fn(() => true);
  const localProbeMock = { embed: vi.fn() };
  const LocalMock = vi.fn(function () { return localProbeMock; });
  const localModelExistsMock = vi.fn((): boolean => false);
  const downloadModelMock = vi.fn(async () => {});
  return { listWorkspacesMock, listRagEnabledWorkspacesMock, addRagEnabledWorkspaceMock, removeRagEnabledWorkspaceMock, isRagCloudConfiguredMock, localProbeMock, LocalMock, localModelExistsMock, downloadModelMock };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => '/fake/userData') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../store.js', () => ({
  listWorkspaces: listWorkspacesMock,
  listRagEnabledWorkspaces: listRagEnabledWorkspacesMock,
  addRagEnabledWorkspace: addRagEnabledWorkspaceMock,
  removeRagEnabledWorkspace: removeRagEnabledWorkspaceMock,
}));
vi.mock('../../agent/system-model.js', () => ({ isRagCloudConfigured: isRagCloudConfiguredMock }));
vi.mock('../../rag/local-onnx-embedder.js', () => ({ LocalOnnxEmbedder: LocalMock, localModelExists: localModelExistsMock }));
vi.mock('../../rag/model-downloader.js', () => ({ downloadModel: downloadModelMock }));

import { getRagStatus, enableRagWorkspace, disableRagWorkspace, downloadRagModel } from '../../ipc/rag.js';
import type { RagConfig } from '../../../src/types';

const localIdx: RagConfig = { embedderId: 'local-code-512', dim: 384, cloudAllowed: false, chunkTokens: 384 };

function setWorkspace(id: string, ragConfig: RagConfig | unknown): void {
  listWorkspacesMock.mockReturnValue([{ id, ragConfig }]);
}

describe('getRagStatus', () => {
  beforeEach(() => {
    listWorkspacesMock.mockReset();
    listRagEnabledWorkspacesMock.mockReset();
    isRagCloudConfiguredMock.mockReset();
    localModelExistsMock.mockReset();
    isRagCloudConfiguredMock.mockReturnValue(true);
    listRagEnabledWorkspacesMock.mockReturnValue([]);
    localModelExistsMock.mockReturnValue(false);
  });

  it('returns state=no-index when workspace unknown', () => {
    listWorkspacesMock.mockReturnValue([]);
    expect(getRagStatus('missing')).toMatchObject({ embedderId: null, state: 'no-index' });
  });

  it('returns state=unavailable when model not on disk', () => {
    setWorkspace('ws-a', localIdx);
    const s = getRagStatus('ws-a');
    expect(s.localAvailable).toBe(false);
    expect(s.state).toBe('unavailable');
  });

  it('returns state=ok when model present', () => {
    localModelExistsMock.mockReturnValue(true);
    setWorkspace('ws-a', localIdx);
    expect(getRagStatus('ws-a').state).toBe('ok');
  });

  it('mirrors enabledWorkspaces from config', () => {
    listRagEnabledWorkspacesMock.mockReturnValue(['ws-a', 'ws-c']);
    setWorkspace('ws-a', localIdx);
    expect(getRagStatus('ws-a').enabledWorkspaces).toEqual(['ws-a', 'ws-c']);
  });

  it('hydrates workspace with no ragConfig to defaults', () => {
    setWorkspace('ws-a', undefined);
    const s = getRagStatus('ws-a');
    expect(s.embedderId).toBe('local-code-512');
    expect(s.chunkTokens).toBe(384);
  });
});

describe('enableRagWorkspace', () => {
  beforeEach(() => {
    downloadModelMock.mockReset();
    localModelExistsMock.mockReset();
    addRagEnabledWorkspaceMock.mockReset();
  });

  it('downloads then adds when model not on disk', async () => {
    localModelExistsMock.mockReturnValue(false);
    downloadModelMock.mockResolvedValueOnce(undefined);
    const r = await enableRagWorkspace('ws-a');
    expect(r).toEqual({ ok: true });
    expect(addRagEnabledWorkspaceMock).toHaveBeenCalledWith('ws-a');
  });

  it('skips download when model present', async () => {
    localModelExistsMock.mockReturnValue(true);
    const r = await enableRagWorkspace('ws-b');
    expect(r).toEqual({ ok: true });
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it('returns error on failed download, does NOT add workspace', async () => {
    localModelExistsMock.mockReturnValue(false);
    downloadModelMock.mockRejectedValueOnce(new Error('network'));
    const r = await enableRagWorkspace('ws-c');
    expect(r).toEqual({ ok: false, error: 'network' });
    expect(addRagEnabledWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe('disableRagWorkspace', () => {
  it('removes from enabled list', () => {
    removeRagEnabledWorkspaceMock.mockReset();
    expect(disableRagWorkspace('ws-a')).toEqual({ ok: true });
    expect(removeRagEnabledWorkspaceMock).toHaveBeenCalledWith('ws-a');
  });
});

describe('downloadRagModel', () => {
  beforeEach(() => {
    downloadModelMock.mockReset();
    localModelExistsMock.mockReset();
  });

  it('is no-op when model present', async () => {
    localModelExistsMock.mockReturnValue(true);
    expect(await downloadRagModel()).toEqual({ ok: true });
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it('downloads when model absent', async () => {
    localModelExistsMock.mockReturnValue(false);
    downloadModelMock.mockResolvedValueOnce(undefined);
    expect(await downloadRagModel()).toEqual({ ok: true });
  });

  it('does NOT add workspace', async () => {
    localModelExistsMock.mockReturnValue(false);
    downloadModelMock.mockResolvedValueOnce(undefined);
    await downloadRagModel();
    expect(addRagEnabledWorkspaceMock).not.toHaveBeenCalled();
  });
});
