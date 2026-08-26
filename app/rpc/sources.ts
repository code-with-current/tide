/** Knowledge-sources RPC — port of electron/ipc/sources.ts (frozen Electron
 *  shell): registry CRUD, per-workspace enablement, and reindex enqueueing
 *  through the ingestion manager. The tide:sources:progress broadcast rides
 *  the sourcesProgress message with the SourceProgressEvent payload verbatim.
 *  Dependencies stay injectable so tests run against a temp db with fake
 *  fetchers/embedder; defaults wire production. The manager/knowledge-store
 *  closure is created per registration (matching the Electron file's
 *  registerSourcesHandlers shape), so re-registering in tests gets a fresh
 *  queue with no listener stacking. */

import * as store from '../core/store.js';
import { hydrateRagConfig } from '../core/configStore.js';
import { appDataDir } from '../platform/paths.js';
import { isRagCloudConfigured } from '../core/agent/system-model.js';
import { localModelExists } from '../core/rag/local-onnx-embedder.js';
import { resolveForBuild } from '../core/rag/resolve.js';
import type { Embedder } from '../core/rag/embedder.js';
import { createLogger } from '../core/logger.js';
import { openKnowledgeStore, type KnowledgeStore } from '../core/knowledge/store.js';
import {
  createKnowledgeManager,
  type KnowledgeManager,
  type SourceFetcher,
} from '../core/knowledge/manager.js';
import { fetchUrl } from '../core/knowledge/fetchers/url.js';
import { fetchDocs } from '../core/knowledge/fetchers/docs.js';
import { fetchCrawl } from '../core/knowledge/fetchers/crawl.js';
import { fetchRepo } from '../core/knowledge/fetchers/repo.js';
import type { SourceKind, SourceProgressEvent } from '../core/knowledge/types.js';

const log = createLogger('sources');

export interface SourcesRpcOptions {
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

export interface SourcesRpcSend {
  progress(e: SourceProgressEvent): void;
}

function defaultListWorkspaceIds(): string[] {
  try {
    return store.listWorkspaces().map((w) => w.id);
  } catch {
    return [];
  }
}

export function registerSourcesRpc(send: SourcesRpcSend, opts: SourcesRpcOptions = {}) {
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
    crawl: (location, fopts) => fetchCrawl(location, fopts?.onPage ? { onPage: fopts.onPage } : undefined),
    repo: (location) => fetchRepo(location),
    ...opts.fetchers,
  };

  const broadcast = (e: SourceProgressEvent): void => {
    try {
      send.progress(e);
    } catch {
      /* listener death must not fail the job (mirrors the Electron broadcast's try/catch) */
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

  return {
    sourcesList: ({ workspaceId }: { workspaceId?: string }) => {
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
    },

    sourcesAdd: async ({
      name,
      kind,
      location,
      enabledWorkspaceIds,
    }: {
      name: string;
      kind: SourceKind;
      location: string;
      enabledWorkspaceIds?: string[];
    }): Promise<{ ok: boolean; id?: string; error?: string }> => {
      if (!name?.trim()) return { ok: false, error: 'name is required' };
      if (!['url', 'docs', 'crawl', 'repo'].includes(kind)) {
        return { ok: false, error: `unsupported source kind '${kind}'` };
      }
      if (!location?.trim()) return { ok: false, error: 'location is required' };
      if (enabledWorkspaceIds !== undefined &&
          (!Array.isArray(enabledWorkspaceIds) || enabledWorkspaceIds.some((w) => typeof w !== 'string' || !w.trim()))) {
        return { ok: false, error: 'enabledWorkspaceIds must be an array of workspace ids' };
      }
      const duplicate = knowledge()
        .listSources()
        .find((s) => s.kind === kind && s.location === location.trim());
      if (duplicate) {
        return { ok: false, error: 'a source with this location already exists', id: duplicate.id };
      }
      let id: string;
      try {
        id = knowledge()
          .addSource({
            name: name.trim(),
            kind,
            location: location.trim(),
            ...(enabledWorkspaceIds?.length ? { enabledWorkspaceIds } : {}),
          })
          .id;
      } catch (err) {
        log.error('add failed', { err });
        return fail(err);
      }
      // The row is persisted — resolve immediately so the dialog can close and
      // the list can show live progress. Ingestion failures surface as
      // status=error on the row, not as an add failure.
      manager.enqueue(id).catch((err) => {
        log.warn('first index pass failed', { id, err });
        try {
          knowledge().markStatus(id, 'error', err instanceof Error ? err.message : String(err));
        } catch {
          /* store already failing — nothing more to do */
        }
      });
      return { ok: true, id };
    },

    sourcesUpdate: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; location?: string; enabledWorkspaceIds?: string[] };
    }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { enabledWorkspaceIds, ...fields } = patch ?? {};
        if (enabledWorkspaceIds !== undefined &&
            (!Array.isArray(enabledWorkspaceIds) || enabledWorkspaceIds.some((w) => typeof w !== 'string' || !w.trim()))) {
          return { ok: false, error: 'enabledWorkspaceIds must be an array of workspace ids' };
        }
        if (!knowledge().updateSource(id, fields)) {
          return { ok: false, error: `unknown knowledge source ${id}` };
        }
        if (enabledWorkspaceIds !== undefined) {
          knowledge().setEnabled(id, enabledWorkspaceIds);
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

    sourcesRemove: async ({ id }: { id: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        await manager.remove(id);
        return { ok: true };
      } catch (err) {
        log.error('remove failed', { err });
        return fail(err);
      }
    },

    sourcesSetEnabled: (
      { id, workspaceId, enabled }: { id: string; workspaceId: string; enabled: boolean },
    ): { ok: boolean; error?: string } => {
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

    sourcesReindex: async ({ id }: { id: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        await manager.enqueue(id);
        return { ok: true };
      } catch (err) {
        log.warn('reindex failed', { err });
        return fail(err);
      }
    },
  };
}

export type SourcesRpcHandlers = ReturnType<typeof registerSourcesRpc>;
