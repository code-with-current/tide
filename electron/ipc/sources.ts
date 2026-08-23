/** Knowledge-sources IPC (`tide:sources:*`): registry CRUD, per-workspace
 *  enablement, and reindex enqueueing through the ingestion manager. Progress
 *  events push on `tide:sources:progress` to every BrowserWindow (mirrors the
 *  tide:rag:*Progress pattern). Dependencies are injectable so tests can run
 *  against a temp db with fake fetchers/embedder; defaults wire production. */
import { ipcMain, BrowserWindow } from 'electron';
import * as store from '../store.js';
import { hydrateRagConfig } from '../configStore.js';
import { appDataDir } from '../appPaths.js';
import { isRagCloudConfigured } from '../agent/system-model.js';
import { localModelExists } from '../rag/local-onnx-embedder.js';
import { resolveForBuild } from '../rag/resolve.js';
import type { Embedder } from '../rag/embedder.js';
import { createLogger } from '../logger.js';
import { openKnowledgeStore, type KnowledgeStore } from '../knowledge/store.js';
import {
  createKnowledgeManager,
  type KnowledgeManager,
  type SourceFetcher,
} from '../knowledge/manager.js';
import { fetchUrl } from '../knowledge/fetchers/url.js';
import { fetchDocs } from '../knowledge/fetchers/docs.js';
import { fetchCrawl } from '../knowledge/fetchers/crawl.js';
import { fetchRepo } from '../knowledge/fetchers/repo.js';
import type { SourceKind, SourceProgressEvent } from '../knowledge/types.js';

const log = createLogger('sources');

export interface SourcesHandlerOptions {
  /** Overrides the global knowledge db location (tests). */
  dbPath?: string;
  /** Lazy embedder resolver — production default resolves at job time via
   *  hydrateRagConfig(undefined) + resolveForBuild, same as workspace ingest
   *  with no global rag config. */
  embedder?: () => Embedder | Promise<Embedder>;
  fetchers?: Partial<Record<SourceKind, SourceFetcher>>;
  /** Workspace ids used to expand '*' enablement when a source is disabled
   *  for one workspace (tests inject a fixed list). */
  listWorkspaces?: () => string[];
}

export function registerSourcesHandlers(opts: SourcesHandlerOptions = {}): void {
  // The db may not exist until the first source is touched — open lazily and
  // memoize so the manager's repeated knowledge() reads share one connection.
  let ks: KnowledgeStore | undefined;
  const knowledge = (): KnowledgeStore => {
    if (!ks) ks = openKnowledgeStore(opts.dbPath);
    return ks;
  };

  const resolveEmbedder = opts.embedder ?? ((): Embedder => {
    // No global rag config exists yet — use defaults, same as workspace ingest
    // does for workspaces without their own config.
    const ragConfig = hydrateRagConfig(undefined);
    return resolveForBuild({
      config: ragConfig,
      localAvailable: localModelExists(),
      cloudConfigured: isRagCloudConfigured(),
    }).embedder;
  });

  const fetchers: Partial<Record<SourceKind, SourceFetcher>> = {
    url: fetchUrl,
    docs: (location) => fetchDocs(location, { allowedRoots: [appDataDir()] }),
    crawl: (location) => fetchCrawl(location),
    repo: (location) => fetchRepo(location),
    ...opts.fetchers,
  };

  const broadcast = (e: SourceProgressEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('tide:sources:progress', e);
      } catch {
        /* window may be mid-close */
      }
    }
  };

  const manager: KnowledgeManager = createKnowledgeManager({
    knowledge,
    embedder: resolveEmbedder,
    fetchers,
    broadcast,
  });

  // Crash leftovers stuck in queued/indexing resolve to idle before any UI reads them.
  try {
    manager.recoverStale();
  } catch (e) {
    log.warn('knowledge stale-status recovery failed', { error: String(e) });
  }

  const fail = (e: unknown): { ok: false; error: string } => ({
    ok: false,
    error: e instanceof Error ? e.message : String(e),
  });

  ipcMain.handle('tide:sources:list', (_e, workspaceId?: string) => {
    try {
      const k = knowledge();
      return {
        sources: k.listSources(),
        enabledSourceIds: workspaceId ? k.enabledSourceIdsFor(workspaceId) : [],
      };
    } catch (err) {
      log.error('list failed', { err });
      return { sources: [], enabledSourceIds: [], error: String(err) };
    }
  });

  ipcMain.handle(
    'tide:sources:add',
    async (_e, name: string, kind: SourceKind, location: string): Promise<{ ok: boolean; id?: string; error?: string }> => {
      if (!name?.trim()) return { ok: false, error: 'name is required' };
      if (!['url', 'docs', 'crawl', 'repo'].includes(kind)) {
        return { ok: false, error: `unsupported source kind '${kind}'` };
      }
      if (!location?.trim()) return { ok: false, error: 'location is required' };
      const duplicate = knowledge()
        .listSources()
        .find((s) => s.kind === kind && s.location === location.trim());
      if (duplicate) {
        return { ok: false, error: 'a source with this location already exists', id: duplicate.id };
      }
      let id: string;
      try {
        id = knowledge().addSource({ name: name.trim(), kind, location: location.trim() }).id;
      } catch (err) {
        log.error('add failed', { err });
        return fail(err);
      }
      try {
        await manager.enqueue(id);
        return { ok: true, id };
      } catch (err) {
        return { ok: true, id, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'tide:sources:update',
    async (_e, id: string, patch: { name?: string; location?: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (!knowledge().updateSource(id, patch ?? {})) {
          return { ok: false, error: `unknown knowledge source ${id}` };
        }
        // A location edit invalidates the stored chunks — reindex automatically.
        if (patch?.location?.trim()) {
          knowledge().markStatus(id, 'queued');
          try {
            await manager.enqueue(id);
          } catch (err) {
            // Row edits are persisted; the failed reindex shows as status=error.
            log.warn('post-update reindex failed', { err });
          }
        }
        return { ok: true };
      } catch (err) {
        log.error('update failed', { err });
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    'tide:sources:remove',
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await manager.remove(id);
        return { ok: true };
      } catch (err) {
        log.error('remove failed', { err });
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    'tide:sources:setEnabled',
    (_e, id: string, workspaceId: string, enabled: boolean): { ok: boolean; error?: string } => {
      if (typeof id !== 'string' || !id.trim()) {
        return { ok: false, error: 'invalid source id' };
      }
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
        return { ok: false, error: 'invalid workspace id' };
      }
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      try {
        const src = knowledge().getSource(id);
        if (!src) return { ok: false, error: `unknown knowledge source ${id}` };
        const cur = src.enabledWorkspaceIds;
        let next: string[];
        if (enabled) {
          next = cur.includes('*') || cur.includes(workspaceId) ? cur : [...cur, workspaceId];
        } else if (cur.includes('*')) {
          // '*' covers every workspace including this one — expand to the
          // concrete id list minus it so the exclusion actually sticks. An
          // empty result would disable the source everywhere INCLUDING future
          // workspaces — refuse rather than persist that.
          const all = (opts.listWorkspaces ?? defaultListWorkspaceIds)();
          next = all.filter((wid) => wid !== workspaceId);
          if (next.length === 0) {
            return { ok: false, error: 'no workspaces registered' };
          }
        } else {
          next = cur.filter((wid) => wid !== workspaceId);
        }
        knowledge().setEnabled(id, next);
        return { ok: true };
      } catch (err) {
        log.error('setEnabled failed', { err });
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    'tide:sources:reindex',
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await manager.enqueue(id);
        return { ok: true };
      } catch (err) {
        log.warn('reindex failed', { err });
        return fail(err);
      }
    },
  );
}

function defaultListWorkspaceIds(): string[] {
  try {
    return store.listWorkspaces().map((w) => w.id);
  } catch {
    return [];
  }
}
