/** IPC handler implementations: Phase 1 covers real workspace/git/file-tree; provider/session/terminal handlers gain real persistence and chat streaming in later phases. */

import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { workspaces as mockWorkspaces, sessionsByWorkspace, allSessions, fileTree, terminalLines } from '../../src/lib/mock/data';
import * as store from '../store.js';
import * as sessions from './sessions.js';
import { BUILTIN_AGENTS } from '../agent/agents/registry';
import { resolveModelMeta, matchModelToCatalog } from '../agent/model-catalog.js';
import { getActiveCatalog, refreshModelCatalog } from '../agent/model-capabilities.js';
import { getSessionTodos, todoEvents } from '../agent/tools/todo-write';
import { scanProjectEntries } from '../agent/project-context';
import { getGitStatus, getGitLog, getCommitFiles, getCommitFileDiff, gitStage, gitCommit, gitDiff, branchInfo, gitHeadSha, gitRestoreFile, gitStageAll, gitUnstageAll, gitRestoreAll, gitStash, gitStashPop, gitStashList, gitCheckout, gitCreateBranch, recentBranches, gitAmend, gitRevertCommit, gitFetch, gitPush, gitPull, gitAheadBehind, gitListBranchesDetailed, gitDeleteBranch, gitMergeBranch, gitConflictFiles, gitResolveFile } from './git.js';
import { startGitWatcher } from './git-watcher.js';
import { startTerminal, sendInput, killTerminal, stopTerminal, resizeTerminal, getTerminalPid, isProcessAlive } from './terminal.js';
import { generateSessionTitle } from '../agent/title.js';
import { getPermissionStatus, requestPermission, shouldShowConsent } from '../permissions.js';
import { registerRagHandlers } from './rag.js';

import { forwardLog, createLogger } from '../logger.js';
import type { Workspace, FileNode, ProviderModelMeta } from '../../src/types';
import type { AgentSettings, GeneralSettings } from '../configStore.js';
import { appDataDir } from '../appPaths.js';
import { syncCoAuthorHook, syncAllWorkspaceHooks } from '../git-coauthor.js';
import type { EventSink } from '../agent/event-sink.js';
import type { SessionStoreV2 } from './session-store-v2.js';
import { newV2MessageId, newV2PartId, orchestratorEventToSink } from '../agent/orchestrator-events.js';

const log = createLogger('ipc');

// ── OpenRouter model catalog ──────────────────────────────────────
// OpenRouter /models is the universal metadata source: fetched at boot, cached to userData, refreshed every 7 days. Bare-id providers (z.ai, OpenAI direct, LM Studio) are enriched by matching against this catalog so they get real pricing/context/reasoning.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OR_CACHE_FILE = 'openrouter-models.json';
const OR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let orCatalog: ProviderModelMeta[] | null = null;
let orBooted: Promise<void> | null = null;

function orCachePath(): string {
  return path.join(appDataDir(), OR_CACHE_FILE);
}

/** Fetch + normalize the OpenRouter catalog. Cached to disk; refreshed when
 *  stale. Never throws — returns [] on any failure. */
export function bootstrapCatalog(): Promise<void> {
  if (orBooted) return orBooted;
  orBooted = (async () => {
    // Try cache first.
    try {
      const cached = await fs.promises.readFile(orCachePath(), 'utf8');
      const parsed = JSON.parse(cached) as { data: unknown[]; fetchedAt?: string };
      if (parsed?.data && Array.isArray(parsed.data)) {
        orCatalog = normalizeProbeList(parsed.data);
        const age = parsed.fetchedAt ? Date.now() - Date.parse(parsed.fetchedAt) : Infinity;
        if (age < OR_REFRESH_MS) {
          log.info('or-catalog loaded from cache', { count: orCatalog.length });
          return;
        }
      }
    } catch { /* no cache — fetch fresh */ }

    // Cache missing or stale → fetch from OpenRouter.
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log.warn('or-catalog fetch failed', { status: res.status });
      return;
    }
    const json = (await res.json()) as { data?: unknown[] };
    if (!json.data || !Array.isArray(json.data)) {
      log.warn('or-catalog unexpected response shape');
      return;
    }
    orCatalog = normalizeProbeList(json.data);
    // Persist to cache (with timestamp) for next boot.
    try {
      await fs.promises.writeFile(
        orCachePath(),
        JSON.stringify({ data: json.data, fetchedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch { /* cache write failed — non-fatal */ }
    log.info('or-catalog fetched from OpenRouter', { count: orCatalog.length });
  })().catch((e) => { log.warn('or-catalog bootstrap failed', { err: e?.message ?? e }); });
  return orBooted;
}

/** Enrich a bare model id from the OpenRouter catalog (pricing/context/reasoning); matches by exact id, then by the tail after the last '/'. */
function enrichFromOrCatalog(modelId: string): ProviderModelMeta | null {
  if (!orCatalog) return null;
  const lower = modelId.trim().toLowerCase();
  // Exact match.
  let hit = orCatalog.find((m) => m.id.toLowerCase() === lower);
  if (!hit) {
    hit = orCatalog.find((m) => {
      const tail = m.id.toLowerCase().slice(m.id.lastIndexOf('/') + 1);
      return tail === lower;
    });
  }
  return hit ?? null;
}

/** True when a provider model entry carries rich metadata beyond a bare id. */
function isRichProviderModel(m: ProviderModelMeta): boolean {
  return !!(m.context_length || m.pricing || m.reasoning || m.max_completion_tokens || m.input_modalities);
}

/** Enrich bare-id models from the OpenRouter catalog, CRITICAL: preserving the provider's original id (only metadata fields are copied). */
function enrichBareModels(models: ProviderModelMeta[]): ProviderModelMeta[] {
  if (!orCatalog || orCatalog.length === 0) return models;
  return models.map((m) => {
    if (isRichProviderModel(m)) return m;
    const enriched = enrichFromOrCatalog(m.id);
    if (!enriched) return m;
    // Keep the provider's original id; copy everything else from the catalog.
    return { ...enriched, id: m.id };
  });
}

/** Normalize a raw /models response array into ProviderModelMeta objects, handling both rich and bare-id shapes defensively; drops id-less entries and sorts by id. */
function normalizeProbeList(raw: unknown[]): ProviderModelMeta[] {
  const out: ProviderModelMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id : undefined;
    if (!id) continue;
    const tp = m.top_provider as Record<string, unknown> | undefined;
    const arch = m.architecture as Record<string, unknown> | undefined;
    const reasoning = m.reasoning as Record<string, unknown> | undefined;
    const pricing = m.pricing as Record<string, unknown> | undefined;
    const supportedEfforts = Array.isArray(reasoning?.supported_efforts)
      ? (reasoning!.supported_efforts as string[]).filter((e) => typeof e === 'string')
      : undefined;
    out.push({
      id,
      name: typeof m.name === 'string' ? m.name : undefined,
      context_length: typeof m.context_length === 'number' ? m.context_length : undefined,
      max_completion_tokens:
        typeof m.max_completion_tokens === 'number'
          ? m.max_completion_tokens
          : typeof tp?.max_completion_tokens === 'number'
            ? tp.max_completion_tokens
            : undefined,
      pricing:
        pricing && (typeof pricing.prompt === 'string' || typeof pricing.completion === 'string')
          ? {
              prompt: typeof pricing.prompt === 'string' ? pricing.prompt : undefined,
              completion: typeof pricing.completion === 'string' ? pricing.completion : undefined,
              input_cache_read: typeof pricing.input_cache_read === 'string' ? pricing.input_cache_read : undefined,
              input_cache_write: typeof pricing.input_cache_write === 'string' ? pricing.input_cache_write : undefined,
            }
          : undefined,
      reasoning:
        reasoning && (typeof reasoning.mandatory === 'boolean' || typeof reasoning.default_enabled === 'boolean' || supportedEfforts)
          ? {
              mandatory: typeof reasoning.mandatory === 'boolean' ? reasoning.mandatory : undefined,
              default_enabled: typeof reasoning.default_enabled === 'boolean' ? reasoning.default_enabled : undefined,
              supported_efforts: supportedEfforts?.length ? supportedEfforts : undefined,
            }
          : undefined,
      supported_parameters: Array.isArray(m.supported_parameters)
        ? (m.supported_parameters as string[]).filter((p) => typeof p === 'string')
        : undefined,
      input_modalities: Array.isArray(arch?.input_modalities)
        ? (arch!.input_modalities as string[]).filter((x) => typeof x === 'string')
        : Array.isArray(m.input_modalities)
          ? (m.input_modalities as string[]).filter((x) => typeof x === 'string')
          : undefined,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Wrapped ipcMain.handle that logs mutation/critical channels at debug (success, with duration) or error (failure). Use for create/delete/update/git/provider ops; read-only handlers can use ipcMain.handle directly. */
function handle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any,
): void {
  ipcMain.handle(channel, async (e, ...args) => {
    const t0 = Date.now();
    try {
      const result = await fn(e, ...args);
      log.debug(channel, { ms: Date.now() - t0 });
      return result;
    } catch (err) {
      log.error(`${channel} failed`, { error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
      throw err;
    }
  });
}

export function registerIpcHandlers(opts?: { sink?: EventSink; storeV2?: SessionStoreV2 }) {
  const sink = opts?.sink;
  const storeV2 = opts?.storeV2;

  const twinV2Session = (id: string, workspaceId: string, title: string, modelId: string, providerId?: string | null, parentId?: string | null) => {
    if (!storeV2) return;
    try {
      const workspacePath = store.listWorkspaces().find((w) => w.id === workspaceId)?.path ?? '';
      storeV2.createSession({ id, workspacePath, title, modelId, providerId: providerId ?? null, parentId: parentId ?? null });
    } catch (e) {
      log.warn('v2 twin createSession failed', { id, err: e instanceof Error ? e.message : String(e) });
    }
  };

  const twinV2TextMessage = (sessionId: string, role: 'user' | 'assistant', text: string, model?: string) => {
    if (!sink || !storeV2 || !text.trim()) return;
    try {
      const messageId = newV2MessageId();
      storeV2.insertMessage({ id: messageId, sessionId, role, model: model ?? null });
      const part = orchestratorEventToSink(sessionId, messageId, newV2PartId(), { type: 'text-end', text }, 0);
      if (part) sink.emit(part);
    } catch (e) {
      log.warn('v2 twin message failed', { sessionId, err: e instanceof Error ? e.message : String(e) });
    }
  };

  // ── Workspaces (real persistence via store) ─────────────────

  ipcMain.handle('tide:listWorkspaces', async () => {
    // Read from the persistent store. Merges with any mock data for dev fallback.
    const stored = store.listWorkspaces();
    if (stored.length > 0) return stored;
    return structuredClone(mockWorkspaces) as Workspace[];
  });

  ipcMain.handle('tide:getWorkspace', async (_e, id: string) => {
    const stored = store.listWorkspaces();
    return structuredClone(stored.find((w) => w.id === id)) as Workspace | undefined;
  });

  // ── Last session persistence ────────────────────────────────
  // Survives app restarts. Independent of renderer localStorage.

  ipcMain.handle('tide:getLastSession', async () => {
    return store.getLastSession();
  });

  handle('tide:setLastSession', async (_e, sessionId: string | null, workspaceId: string | null) => {
    store.setLastSession(sessionId, workspaceId);
  });

  // ── File dialog (real) ──────────────────────────────────────

  ipcMain.handle('tide:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Select a folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Host environment for the system prompt — lets the model pick the right
  // shell dialect (bash vs zsh vs cmd.exe) without probing first.
  ipcMain.handle('tide:getEnvInfo', () => ({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    shell: process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/sh'),
  }));

  // Diagnostics — live version/platform info for the About screen. Avoids
  // hardcoding versions that drift on every dep bump.
  ipcMain.handle('tide:getDiagnostics', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    userDataPath: appDataDir(),
  }));

  // Resolve a model against the loaded models.dev catalog — the Fetch Models
  // dialog uses this to enrich rows with price / context / capabilities. With
  // no catalog loaded, returns a conservative-fallback meta + no match.
  ipcMain.handle(
    'tide:modelCatalog:resolve',
    async (_e, input: { catalogId?: string; modelId: string; contextWindow: number }) => {
      const catalog = getActiveCatalog();
      if (!catalog) {
        return {
          meta: {
            contextWindow: input.contextWindow || 200000,
            maxInputTokens: input.contextWindow || 200000,
            maxOutputTokens: 8192,
            supportsReasoning: false,
            supportsFunctionCalling: true,
            supportsPromptCaching: false,
            supportsVision: false,
            mode: 'chat',
            isValidForMainRole: true,
            pricing: null,
            resolvedCatalogId: null,
          },
          match: { state: 'none' as const, matches: [] },
        };
      }
      const ref = { catalogId: input.catalogId, modelId: input.modelId, contextWindow: input.contextWindow };
      return { meta: resolveModelMeta(ref, catalog), match: matchModelToCatalog(input.modelId, catalog) };
    },
  );

  // Splash screen fires this at every app open — pull a fresh models.dev
  // catalog in the background (fetch + re-enrich continue after the reply) so
  // model metadata is current without delaying splash routing.
  ipcMain.handle('tide:modelCatalog:refresh', () => {
    void refreshModelCatalog();
    return { ok: true };
  });

  // External file picker — for the Attach button. Returns multiple file paths.
  ipcMain.handle('tide:pickFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      title: 'Select files to attach',
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths;
  });

  // Persist clipboard-blob bytes (e.g. pasted screenshots, which have no file
  // on disk) under <appData>/attachments so they get a real absolute path the
  // agent can read with read_media_file. Returns the absolute path.
  ipcMain.handle('tide:saveClipboardFile', async (_e, name: string, bytes: ArrayBuffer) => {
    try {
      const dir = path.join(appDataDir(), 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const safe = path.basename(name || 'pasted-file').replace(/[^a-zA-Z0-9._-]/g, '_') || 'pasted-file';
      const target = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(target, Buffer.from(bytes));
      return target;
    } catch {
      return '';
    }
  });

  // Read an external file (absolute path, outside workspace) for attachment.
  ipcMain.handle('tide:readExternalFile', async (_e, filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      const MAX_BYTES = 256 * 1024;
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        content: content.slice(0, MAX_BYTES),
        bytes: stat.size,
        truncated: stat.size > MAX_BYTES,
      };
    } catch {
      return null;
    }
  });

  // Read an image as a base64 data URL (renderer can't load file:// under contextIsolation). Accepts an abs path or {workspaceId, relPath}; caps at 10 MB.
  const IMG_MAX_BYTES = 10 * 1024 * 1024;
  const IMG_EXT_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  };
  function mimeFromPath(p: string): string | null {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    return IMG_EXT_MIME[ext] ?? null;
  }
  ipcMain.handle(
    'tide:readImageFile',
    async (_e, input: { absPath?: string; workspaceId?: string; relPath?: string }): Promise<{ dataUrl: string; bytes: number } | null> => {
      try {
        let target: string | null = null;
        if (input.absPath) {
          target = input.absPath;
        } else if (input.workspaceId && input.relPath) {
          const ws = store.listWorkspaces().find((w) => w.id === input.workspaceId);
          if (!ws) return null;
          const root = expandPath(ws.path);
          const full = path.resolve(root, input.relPath);
          // Sandbox: keep it inside the workspace.
          const rel = path.relative(root, full);
          if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
          target = full;
        }
        if (!target) return null;
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > IMG_MAX_BYTES) return null;
        const mime = mimeFromPath(target);
        if (!mime) return null;
        const buf = fs.readFileSync(target);
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: stat.size };
      } catch {
        return null;
      }
    },
  );

  // ── Git detection (real) ────────────────────────────────────

  ipcMain.handle('tide:detectGitRepo', async (_e, dirPath: string) => {
    const info = await detectGit(dirPath);
    return info ? { ...info, isRepo: true } : null;
  });

  // ── Add Workspace (real path + git detection) ───────────────

  ipcMain.handle(
    'tide:addWorkspace',
    async (
      e,
      input: { path: string; name?: string; repository?: string; template?: import('../../src/lib/templates').TemplateId; scripts?: import('../../src/types').WorkspaceScript[]; initGit?: boolean; requestId?: string },
    ) => {
      const { TEMPLATES_BY_ID } = await import('../../src/lib/templates');
      const template = input.template ? TEMPLATES_BY_ID[input.template] : undefined;
      let dirPath = input.path;

      // Stream per-step milestones to the renderer so the AddWorkspace dialog
      // can show real progress (which step is running / done) instead of a
      // single spinner for the whole blocking call. requestId correlates the
      // events to the originating request (workspace id doesn't exist yet).
      const rid = input.requestId;
      const send = (step: 'clone' | 'folder' | 'scaffold' | 'install' | 'git' | 'detect', status: 'active' | 'done' | 'failed', label: string, detail?: string) => {
        if (!rid) return;
        e.sender.send('tide:workspace:progress', { requestId: rid, step, status, label, detail });
      };

    // If a repository URL is provided and the path doesn't exist yet,
    // clone it first. This is the "Clone from URL" flow.
    if (input.repository && !fs.existsSync(dirPath)) {
      const parentDir = path.dirname(dirPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      send('clone', 'active', 'Cloning repository…', input.repository);
      try {
        execSync(`git clone --depth 1 "${input.repository}" "${dirPath}"`, {
          stdio: 'pipe',
          timeout: 120_000,
        });
      } catch (e) {
        send('clone', 'failed', 'Clone failed');
        throw new Error(
          `Git clone failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      send('clone', 'done', 'Repository cloned');
    }

    // New Project / Template flow: create the directory. We intentionally do NOT `git init` here when a template will scaffold — most scaffolders abort if .git exists, so git init is deferred to after the scaffold step.
    if (!input.repository && !fs.existsSync(dirPath)) {
      send('folder', 'active', 'Creating project folder…');
      try {
        fs.mkdirSync(dirPath, { recursive: true });
        send('folder', 'done', 'Project folder created');
        // Empty/new-project case (no template): init git now since there's no
        // scaffold step coming. Templated projects init after scaffolding.
        if (!template || template.scaffold.length === 0) {
          send('git', 'active', 'Initializing git…');
          execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
          send('git', 'done', 'Git initialized');
        }
      } catch (e) {
        send('folder', 'failed', 'Folder creation failed');
        throw new Error(
          `Failed to create project directory: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Template scaffold: run the template's create + optional install commands (skipped for Empty template and Clone-from-URL); stdio captured so failures surface useful stderr.
    if (template && template.scaffold.length > 0 && !input.repository) {
      // Ensure the dir exists — covers the case where the user picked a
      // template without going through the New Project mkdir branch above
      // (defensive; the dialog always mkdirs first).
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

      const runStep = (label: string, argv: string[]) => {
        const r = spawnSync(argv[0], argv.slice(1), {
          cwd: dirPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
          // Deps install (npm install) can take minutes; scaffold itself is
          // usually <30s. 10 min ceiling covers worst-case cold installs.
          timeout: 600_000,
        });
        if (r.status !== 0) {
          const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
          throw new Error(`${label} failed (exit ${r.status}):\n${tail}`);
        }
      };

      try {
        send('scaffold', 'active', `Scaffolding ${template.label}…`, template.label);
        runStep('Scaffold', template.scaffold);
        send('scaffold', 'done', `${template.label} scaffolded`, template.label);
        if (template.install) {
          send('install', 'active', 'Installing dependencies…');
          runStep('Install', template.install);
          send('install', 'done', 'Dependencies installed');
        }
      } catch (e) {
        // Best-effort cleanup: a half-scaffolded dir is worse than none.
        // Leave it (don't rm a user-chosen path they may want to inspect).
        throw new Error(
          `Template '${template.id}' failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Ensure git is initialized after scaffolding. Some scaffolders init
      // their own repo (create-next-app does); others (create-vite, nuxi
      // --no-gitInit) don't. Init only if .git is absent so we don't disturb
      // an existing repo's config/branches.
      if (!fs.existsSync(path.join(dirPath, '.git'))) {
        send('git', 'active', 'Initializing git…');
        try {
          execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
          send('git', 'done', 'Git initialized');
        } catch {
          send('git', 'failed', 'Git init skipped');
          /* non-fatal — the workspace is usable without git */
        }
      }
    }

    // Existing local folder flow: if the user opted into git init and the folder isn't already a repo, run `git init` before detection. (Clone/scaffold flows handle their own git.)
    if (input.initGit && !input.repository && fs.existsSync(dirPath) && !fs.existsSync(path.join(dirPath, '.git'))) {
      send('git', 'active', 'Initializing git…');
      try {
        execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
        send('git', 'done', 'Git initialized');
      } catch {
        send('git', 'failed', 'Git init skipped');
        /* non-fatal — the workspace is usable without git */
      }
    }

    send('detect', 'active', 'Detecting repository…');
    const gitInfo = await detectGit(dirPath);
    send('detect', 'done', 'Repository ready');
    const name = input.name || path.basename(dirPath);

    const workspace: Workspace = {
      id: `ws_${Math.random().toString(36).slice(2, 10)}`,
      name,
      path: dirPath,
      repository: input.repository,
      branch: gitInfo?.branch ?? 'main',
      headCommit: gitInfo?.headCommit ?? 'unknown',
      isDefault: false,
      fileCount: gitInfo?.fileCount ?? 0,
      worktreeLocation: '.agent/worktrees/',
      scripts: input.scripts ?? [],
    };

    store.addWorkspace(workspace);
    syncCoAuthorHook(dirPath);
    return workspace;
  });

  handle('tide:updateWorkspace', async (_e, id: string, patch: Partial<Workspace>) => {
    store.updateWorkspace(id, patch);
    return store.listWorkspaces().find((w) => w.id === id);
  });

  handle('tide:archiveWorkspace', async (_e, id: string) => {
    store.archiveWorkspace(id);
  });

  handle('tide:unarchiveWorkspace', async (_e, id: string) => {
    store.unarchiveWorkspace(id);
  });

  handle('tide:deleteWorkspace', async (_e, id: string) => {
    try {
      store.deleteWorkspace(id);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  // Batch liveness probe: which workspace folders still exist on disk?
  // Drives the sidebar's "missing workspace" indicator. One IPC call for the
  // whole list rather than N round-trips.
  handle('tide:workspacesExist', async (_e, paths: string[]) => {
    const result: Record<string, boolean> = {};
    for (const p of paths ?? []) {
      try {
        result[p] = fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch {
        result[p] = false;
      }
    }
    return result;
  });

  // ── File tree (real filesystem) ─────────────────────────────

  ipcMain.handle('tide:getFileTree', async (_e, workspaceId: string) => {
    // Resolve from the real store. Mock fallback was removed: a missing
    // workspace record or a deleted workspace dir now returns an empty tree
    // instead of confusing the user with fake mock files.
    const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return [];

    const dirPath = expandPath(ws.path);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return []; // workspace folder moved/deleted — empty, not mock
    }
    try {
      return readDirTree(dirPath, '', 3); // max depth 3
    } catch {
      return []; // unreadable — empty, not mock
    }
  });

  // ── Workspace context for the system prompt ────────────────
  // Returns a compact text blob summarizing the workspace so the model can
  // answer "what is this project?" without tool calls. Reads package.json,
  // the top-level README, and a flat top-level file/dir listing.

  ipcMain.handle('tide:getWorkspaceContext', async (_e, workspaceId: string): Promise<string> => {
    const stored = store.listWorkspaces();
    const ws = stored.find((w) => w.id === workspaceId);
    if (!ws) return '';

    const dirPath = expandPath(ws.path);
    const lines: string[] = [];

    // package.json — name, description, key deps, scripts.
    try {
      const pkgRaw = fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw);
      lines.push(`Project: ${pkg.name ?? path.basename(dirPath)}`);
      if (pkg.description) lines.push(`Description: ${pkg.description}`);
      if (pkg.version) lines.push(`Version: ${pkg.version}`);
      if (pkg.private != null) lines.push(`Private: ${pkg.private}`);
      const depKeys = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      if (depKeys.length) {
        // Highlight the most signal-y deps; cap the list to keep tokens bounded.
        const interesting = depKeys.filter((k) =>
          /^(react|next|vue|nuxt|svelte|@angular|electron|vite|typescript|tailwind|express|fastify|nest|prisma|drizzle|@modelcontextprotocol|ai|openai|anthropic|zustand|redux|@tanstack)/i.test(k),
        );
        const shown = interesting.length ? interesting : depKeys.slice(0, 12);
        lines.push(`Stack: ${shown.join(', ')}${depKeys.length > shown.length ? ` (+${depKeys.length - shown.length} more)` : ''}`);
      }
      const scripts = Object.entries(pkg.scripts ?? {});
      if (scripts.length) {
        const shown = scripts.slice(0, 6).map(([k]) => k).join(', ');
        lines.push(`Scripts: ${shown}${scripts.length > 6 ? ` (+${scripts.length - 6} more)` : ''}`);
      }
    } catch {
      // No package.json — not a JS project. Note that and move on.
      lines.push(`Project: ${path.basename(dirPath)} (no package.json)`);
    }

    // Top-level file/dir snapshot — gives the model a sense of layout.
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const visible = entries
        .filter((e) => !(e.name.startsWith('.') && e.name !== '.agent') && !['node_modules', 'dist', 'build', 'release', 'target'].includes(e.name))
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (visible.length) lines.push(`Top-level: ${visible.join(', ')}`);
    } catch {
      // unreadable — skip
    }

    // README excerpt — first ~40 lines or until a clear section break.
    for (const name of ['README.md', 'README.MD', 'README.txt', 'README']) {
      try {
        const readme = fs.readFileSync(path.join(dirPath, name), 'utf-8');
        const excerpt = readme.split('\n').slice(0, 40).join('\n').trim();
        if (excerpt) {
          lines.push(`---\nREADME (${name}):\n${excerpt}`);
        }
        break;
      } catch {
        // try next
      }
    }

    // Project-level agent guidance (CLAUDE.md / AGENT.md at root) is always-on context so the model follows repo conventions without @-mention; capped at 8KB.
    const entries = scanProjectEntries(dirPath);
    for (const ctx of entries.contextFiles) {
      lines.push(`---\n${ctx.path} (project agent guidance — always apply; where these rules conflict with your defaults, these rules win):\n${ctx.content}`);
      break; // one context file is enough; CLAUDE.md wins over AGENT.md
    }

    return lines.join('\n');
  });

  // ── Read a single file from a workspace (for context injection) ──
  // Fetches a referenced file into the system prompt so the model can discuss it without tool calls. Sandboxed to workspace root; size/binary capped.

  ipcMain.handle(
    'tide:readFileInWorkspace',
    async (_e, workspaceId: string, relPath: string): Promise<{ ok: true; content: string; truncated: boolean; bytes: number } | { ok: false; reason: string }> => {
      const stored = store.listWorkspaces();
      const ws = stored.find((w) => w.id === workspaceId);
      if (!ws) return { ok: false, reason: 'workspace not found' };

      const root = expandPath(ws.path);
      const full = path.resolve(root, relPath);

      // Sandbox: resolved path must be inside the workspace root.
      const rel = path.relative(root, full);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: 'path escapes workspace root' };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        return { ok: false, reason: 'file not found' };
      }
      if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };

      // Skip obvious binaries by extension — they wouldn't render as text.
      const binExt = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|class|jar|war|wasm|mp[34]|wav|ogg|mov|mp4|avi|mkv|ttf|otf|woff2?|eot|sumo|db|sqlite|db3)$/i;
      if (binExt.test(relPath)) return { ok: false, reason: 'binary file' };

      // Hard size cap — 256 KB. Anything bigger should be addressed by the
      // model telling the user to paste a relevant excerpt.
      const MAX_BYTES = 256 * 1024;
      const truncated = stat.size > MAX_BYTES;

      try {
        // Read up to MAX_BYTES + 1 so we know we're truncating, then slice.
        const fd = fs.openSync(full, 'r');
        try {
          const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
          // Strip a UTF-8 BOM if present, decode with replacement chars.
          let content = buf.toString('utf-8');
          if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
          return { ok: true, content, truncated, bytes: stat.size };
        } finally {
          fs.closeSync(fd);
        }
      } catch (e: any) {
        return { ok: false, reason: e?.message ?? 'read failed' };
      }
    },
  );

  // ── Sessions (real persistence) ─────────────────────────────

  ipcMain.handle('tide:listSessions', async (_e, workspaceId: string) => {
    return sessions.listSessions(workspaceId);
  });

  ipcMain.handle('tide:listDispatches', async (_e, parentId: string) => {
    return sessions.listDispatches(parentId);
  });

  // ── Built-in sub-agents (single source of truth for the @mention picker
  //    and any future settings UI). Returns name/description/whenToUse.
  //    hidden agents stay dispatchable but disappear from the catalog.
  ipcMain.handle('tide:listAgents', async () => {
    return BUILTIN_AGENTS
      .filter((a) => !a.hidden)
      .map((a) => ({ name: a.name, description: a.description, whenToUse: a.whenToUse }));
  });

  // ── Project-level entries (CLAUDE.md / AGENT.md + .claude|.agent/) ────
  // Scans the workspace root for project-wide agent guidance and any
  // user-defined skills/agents. Surfaces them in the @mention picker so the
  // user can invoke them from the composer alongside the built-ins.
  ipcMain.handle('tide:listProjectEntries', async (_e, workspaceId: string) => {
    const stored = store.listWorkspaces();
    const ws = stored.find((w) => w.id === workspaceId);
    if (!ws || !ws.path) return { contextFiles: [], skills: [], agents: [] };
    try {
      return scanProjectEntries(ws.path);
    } catch {
      return { contextFiles: [], skills: [], agents: [] };
    }
  });

  // ── Todos (model-maintained via todo_write tool) ───────────────
  // A single flat list per session lives in main-process memory. Push it
  // to the renderer whenever a tool call updates it so the floating panel
  // (the single source of truth) reflects progress live.
  ipcMain.handle('tide:listTodos', async (_e, sessionId: string) => {
    return getSessionTodos(sessionId);
  });

  ipcMain.handle('tide:subscribeTodos', (event) => {
    const wc = event.sender;
    const onUpdate = ({ sessionId, todos }: { sessionId: string; todos: any[] }) => {
      if (!wc.isDestroyed()) wc.send('todos:updated', { sessionId, todos });
    };
    todoEvents.on(onUpdate);
    // Only register the 'closed' cleanup listener ONCE per WebContents —
    // the renderer calls subscribeTodos on every session switch, and each
    // call would add another listener, eventually hitting MaxListeners.
    if (!(wc as any).__todosCleanedUp) {
      (wc as any).__todosCleanedUp = true;
      wc.once('closed', () => {
        todoEvents.off(onUpdate);
      });
    }
  });

  ipcMain.handle('tide:getSession', async (_e, id: string) => {
    return sessions.getSession(id);
  });

  handle('tide:createSession', async (_e, workspaceId: string, title: string, modelId: string, opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string }) => {
    const s = sessions.createSession(workspaceId, title, modelId, opts);
    twinV2Session(s.id, workspaceId, s.title, modelId, opts?.providerId);
    return s;
  });

  handle('tide:updateSessionSettings', async (
    _e,
    sessionId: string,
    patch: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max' },
  ) => {
    return sessions.updateSessionSettings(sessionId, patch);
  });

  handle('tide:addMessage', async (_e, sessionId: string, role: 'user' | 'assistant' | 'system', content: string, extra?: { attachments?: any[]; mentions?: any[] }) => {
    sessions.addMessage(sessionId, role, content, extra);
    if (role === 'user') twinV2TextMessage(sessionId, 'user', content);
  });

  handle('tide:addAssistantMessage', async (
    _e,
    sessionId: string,
    message: {
      content: string;
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ) => {
    sessions.addAssistantMessage(sessionId, message);
  });

  // Upsert the final assistant message by messageId (updates the streaming
  // partial in place rather than appending a duplicate). See sessionStore.
  handle('tide:finalizeAssistantMessage', async (
    _e,
    sessionId: string,
    messageId: string,
    message: {
      content: string;
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ) => {
    sessions.finalizeAssistantMessage(sessionId, messageId, message);
  });

  // Accumulate a turn's usage into the session's cumulative totals.
  // Drives the context-window meter in the right panel.
  handle('tide:addSessionUsage', async (
    _e,
    sessionId: string,
    delta: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
    lastStepUsage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
  ) => {
    sessions.addUsage(sessionId, delta, lastStepUsage);
  });

  handle('tide:deleteSession', async (_e, id: string) => {
    sessions.deleteSession(id);
  });

  handle('tide:clearAllSessions', async () => {
    sessions.clearAllSessions();
    return { ok: true };
  });

  handle('tide:renameSession', async (_e, sessionId: string, title: string) => {
    sessions.renameSession(sessionId, title);
  });

  // Best-effort LLM title generation: looks up the first user message, asks for a 3-5 word title, renames. Fire-and-forget on new-session creation; returns null if no API key configured.
  handle('tide:generateSessionTitle', async (_e, sessionId: string) => {
    try {
      const session = sessions.getSession(sessionId);
      if (!session) return null;
      const firstUser = session.messages.find((m: any) => m.role === 'user');
      if (!firstUser || !firstUser.content) return null;
      // Resolve the session's chat provider — same path as the orchestrator.
      const providers = store.listProviders();
      let provider = providers.find((p) => p.id === session.providerId);
      if (!provider && session.modelId) {
        provider = providers.find(
          (p) => p.enabled && p.models.some((m) => m.modelId === session.modelId),
        );
      }
      if (!provider) return null;
      const title = await generateSessionTitle(String(firstUser.content), {
        provider,
        modelId: session.modelId,
      });
      if (title) sessions.renameSession(sessionId, title);
      return title;
    } catch (e: any) {
      log.warn('generateSessionTitle failed', { err: e?.message });
      return null;
    }
  });

  // ── macOS permissions (consent screen) ───────────────────────────
  // Synchronous, cheap native calls — safe on the routing path (the splash
  // screen calls shouldShowConsent before advancing to main). No-op on
  // non-mac: status.platform === 'other' and shouldShowConsent returns false.
  ipcMain.handle('tide:permissions:status', () => getPermissionStatus());
  ipcMain.handle('tide:permissions:request', (_e, type: 'accessibility' | 'fullDiskAccess' | 'folders') =>
    requestPermission(type),
  );
  ipcMain.handle('tide:permissions:shouldShowConsent', () => shouldShowConsent());

  // ── Agent settings (Settings → Permissions & Caps) ────────────
  ipcMain.handle('tide:getAgentSettings', async () => {
    return store.getAgentSettings();
  });
  ipcMain.handle('tide:updateAgentSettings', async (_e, patch: Partial<AgentSettings>) => {
    log.info('agent settings updated', { keys: Object.keys(patch) });
    store.updateAgentSettings(patch);
    return store.getAgentSettings();
  });

  // ── General settings (Settings → General) ─────────────────────
  ipcMain.handle('tide:getGeneralSettings', async () => {
    return store.getGeneralSettings();
  });
  ipcMain.handle('tide:updateGeneralSettings', async (_e, patch: Partial<GeneralSettings>) => {
    log.info('general settings updated', { keys: Object.keys(patch) });
    store.updateGeneralSettings(patch);
    if ('gitCoAuthored' in patch || 'gitCoAuthorName' in patch || 'gitCoAuthorEmail' in patch) {
      syncAllWorkspaceHooks();
    }
    // Side-effect: apply login item immediately.
    if ('startAtLogin' in patch) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!patch.startAtLogin });
      } catch (e) {
        log.warn('failed to set login item', { err: e });
      }
    }
    return store.getGeneralSettings();
  });

  handle('tide:archiveSession', async (_e, sessionId: string) => {
    sessions.archiveSession(sessionId);
  });

  handle('tide:unarchiveSession', async (_e, sessionId: string) => {
    sessions.unarchiveSession(sessionId);
  });

  ipcMain.handle('tide:listArchivedSessions', async (_e, workspaceId: string) => {
    return sessions.listArchivedSessions(workspaceId);
  });

  // ── Worktree lifecycle (per-session git isolation) ──────────────
  // createWorktree runs `git worktree add` and persists metadata (orchestrator picks up session.worktree.path next turn); removeWorktree is for manual cleanup (deleteSession cascades automatically).

  handle('tide:session:createWorktree', async (_e, sessionId: string, opts: { branchName: string; baseBranch: string; configFiles?: string[] }) => {
    return sessions.createWorktree(sessionId, opts);
  });

  handle('tide:session:removeWorktree', async (_e, sessionId: string) => {
    await sessions.removeWorktree(sessionId);
  });

  handle('tide:session:fork', async (
    _e,
    sourceId: string,
    newModelId: string,
    opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
  ) => {
    const forked = await sessions.forkWithSummary(sourceId, newModelId, opts);
    twinV2Session(forked.id, forked.workspaceId, forked.title, newModelId, opts?.providerId, sourceId);
    const seed = forked.messages[forked.messages.length - 1];
    if (seed?.role === 'assistant') twinV2TextMessage(forked.id, 'assistant', seed.content ?? '', newModelId);
    return forked;
  });

  ipcMain.handle('tide:workspace:listBranches', async (_e, workspaceId: string) => {
    return await sessions.listBranches(workspaceId);
  });

  // Auto-detected config files (.env etc.) at the workspace root — used
  // by the new-session UI to pre-check the files most users want copied
  // into the worktree.
  ipcMain.handle('tide:workspace:listConfigFiles', async (_e, workspaceId: string) => {
    return sessions.listConfigFiles(workspaceId);
  });

  // ── Providers (real persistence via safeStorage + JSON config) ──

  ipcMain.handle('tide:listProviders', async () => {
    // Read from store. If store is empty (first run), seed with defaults.
    const stored = store.listProviders();
    if (stored.length > 0) return stored;
    // First-run: seed default providers so the user sees something.
    // In production these would start empty and the onboarding would guide.
    return stored;
  });

  handle('tide:addProvider', async (_e, input: {
    name: string;
    apiStyle: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    models?: { alias: string; modelId: string; contextWindow: number }[];
  }) => {
    return store.addProvider(input);
  });

  handle('tide:updateProvider', async (_e, id: string, patch: any) => {
    return store.updateProvider(id, patch);
  });

  handle('tide:deleteProvider', async (_e, id: string) => {
    return store.deleteProvider(id);
  });

  // ── Probe provider's /models endpoint ──────────────────────────────
  // Fetches the provider's models using the form's CURRENT values (works in the add form). Returns {ok, models} or {ok:false, error} — never throws.
  handle('tide:provider:probeModels', async (
    _e,
    input: { apiStyle: 'openai' | 'anthropic'; baseUrl: string; apiKey: string },
  ): Promise<{ ok: true; models: ProviderModelMeta[] } | { ok: false; error: string }> => {
    try {
      const { apiStyle, baseUrl, apiKey } = input;
      if (!baseUrl.trim()) return { ok: false, error: 'Base URL is empty.' };
      // Ensure the OpenRouter catalog is loaded so bare-id models can be
      // enriched. Awaits the boot promise (fast if already loaded). If it
      // fails, enrichment is skipped — models still return as bare.
      await bootstrapCatalog();
      if (!apiKey.trim()) return { ok: false, error: 'API key is empty — type one or save a stored key first.' };
      // Build the models endpoint URL. For OpenAI: {baseUrl}/models. For
      // Anthropic: {baseUrl}/v1/models — BUT if the user already included
      // /v1 in the baseUrl, don't double it up. Match the normalization in
      // provider-factory.ts (normalizeAnthropicBaseURL).
      const cleanBase = baseUrl.replace(/\/+$/, '');
      let url: string;
      if (apiStyle === 'openai') {
        url = `${cleanBase}/models`;
      } else {
        // Anthropic: append /v1/models unless the URL already ends with /v1.
        const hasVersion = /\/v\d+$/.test(cleanBase);
        url = hasVersion ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiStyle === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${apiKey}`;
      }
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
      }
      // Guard against non-JSON responses (HTML error pages, proxy login
      // screens, etc.). Some servers return 200 + text/html for missing
      // endpoints — .json() would throw "Unexpected token '<'" on those.
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const body = await res.text().catch(() => '');
        try {
          const parsed = JSON.parse(body);
          if (parsed && (parsed.data || parsed.models)) {
            return { ok: true, models: enrichBareModels(normalizeProbeList(parsed.data ?? parsed.models ?? [])) };
          }
        } catch {
          /* not JSON — fall through to error */
        }
        return {
          ok: false,
          error: `Expected JSON but got ${contentType || 'unknown content type'}. Check the base URL — it may need a different path or the provider may not expose a models endpoint.`,
        };
      }
      const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
      const models = enrichBareModels(normalizeProbeList(json.data ?? json.models ?? []));
      return { ok: true, models };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  // ── Auto-detect API protocol from baseUrl + apiKey ────────────────
  // Probes both OpenAI and Anthropic /models endpoints in parallel; returns
  // whichever protocol gets a valid JSON response. Used by the Add Provider
  // form to auto-select the protocol when the user enters baseUrl + apiKey.
  handle('tide:provider:detectProtocol', async (
    _e,
    input: { baseUrl: string; apiKey: string },
  ): Promise<{ apiStyle: 'openai' | 'anthropic'; models: ProviderModelMeta[] } | { error: string }> => {
    const { baseUrl, apiKey } = input;
    if (!baseUrl.trim() || !apiKey.trim()) return { error: 'Base URL and API key are required.' };
    const cleanBase = baseUrl.replace(/\/+$/, '');

    // Build candidate URLs for both protocols.
    const candidates: Array<{ style: 'openai' | 'anthropic'; url: string; headers: Record<string, string> }> = [];
    // OpenAI: {baseUrl}/models
    candidates.push({
      style: 'openai',
      url: `${cleanBase}/models`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    });
    // Anthropic: {baseUrl}/v1/models (or {baseUrl}/models if /v1 already present)
    const hasVersion = /\/v\d+$/.test(cleanBase);
    candidates.push({
      style: 'anthropic',
      url: hasVersion ? `${cleanBase}/models` : `${cleanBase}/v1/models`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    // Race both probes — first valid JSON response with a models array wins.
    const probe = async (c: typeof candidates[0]): Promise<{ style: 'openai' | 'anthropic'; models: ProviderModelMeta[] } | null> => {
      try {
        const res = await fetch(c.url, { method: 'GET', headers: c.headers, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') ?? '';
        let parsed: any;
        if (ct.includes('application/json')) {
          parsed = await res.json();
        } else {
          const text = await res.text().catch(() => '');
          parsed = JSON.parse(text); // throws if not JSON → null
        }
        const list = parsed?.data ?? parsed?.models;
        if (Array.isArray(list) && list.length > 0) {
          await bootstrapCatalog();
          return { style: c.style, models: enrichBareModels(normalizeProbeList(list)) };
        }
        return null;
      } catch {
        return null;
      }
    };

    const results = await Promise.allSettled(candidates.map(probe));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return { error: 'Could not detect API protocol — neither OpenAI nor Anthropic endpoint responded with a valid models list. Check the base URL and API key.' };
  });

  // ── Renderer log forwarding ───────────────────────────────────────
  // Renderer log calls are forwarded here to land in the central log file.
  // The renderer's src/lib/logger.ts calls window.tideIpc.log.send(...).
  ipcMain.handle('tide:log', (_e, input: { level: string; tag: string; msg: string; args?: unknown[] }) => {
    forwardLog(input.level, input.tag, input.msg, input.args);
  });

  // ── Test provider connection ─────────────────────────────────────
  // Sends a minimal chat completion to verify baseUrl+apiKey+modelId end-to-end (used by onboarding). Returns {ok:true} or {ok:false, error} — never throws.
  handle('tide:provider:testConnection', async (
    _e,
    input: { apiStyle: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; modelId: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { apiStyle, baseUrl, apiKey, modelId } = input;
      if (!baseUrl.trim()) return { ok: false, error: 'Base URL is empty.' };
      if (!apiKey.trim()) return { ok: false, error: 'API key is empty.' };
      if (!modelId.trim()) return { ok: false, error: 'Model ID is empty.' };

      const cleanBase = baseUrl.replace(/\/+$/, '');
      // Match the normalization in provider-factory.ts — don't double /v1.
      const url = apiStyle === 'openai'
        ? `${cleanBase}/chat/completions`
        : /\/v\d+$/.test(cleanBase) ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiStyle === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${apiKey}`;
      }

      const body = apiStyle === 'anthropic'
        ? JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'Say hello in one word.' }] })
        : JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'Say hello in one word.' }] });

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
      }
      return { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  // ── Terminal seed (mock) ────────────────────────────────────

  ipcMain.handle('tide:getTerminalLines', async (_e, _sessionId: string) => {
    return [];
  });

  // ── Real terminal (bottom panel) ────────────────────────────
  handle('terminal:start', (e, terminalId: string, sessionId: string) => {
    startTerminal(terminalId, sessionId, e.sender);
  });

  ipcMain.handle('terminal:input', async (_e, terminalId: string, input: string) => {
    sendInput(terminalId, input);
  });

  handle('terminal:kill', async (_e, terminalId: string) => {
    killTerminal(terminalId);
  });

  // Stop the foreground process in a terminal (Ctrl+C / SIGINT). Used by
  // the Run-script Stop button — graceful: dev servers clean up before
  // exiting. The PTY itself stays alive so the user can read the tail of
  // the output and start another command in the same shell.
  handle('terminal:stop', async (_e, terminalId: string) => {
    stopTerminal(terminalId);
  });

  ipcMain.handle('terminal:resize', async (_e, terminalId: string, cols: number, rows: number) => {
    resizeTerminal(terminalId, cols, rows);
  });

  // PID-based liveness — lets the renderer check whether a terminal's process
  // is still alive (e.g. to show/clear port badges + Run/Stop state) without
  // relying on name matching. Returns the shell pid or null if no terminal.
  ipcMain.handle('terminal:getPid', async (_e, terminalId: string) => {
    return getTerminalPid(terminalId) ?? null;
  });

  // Check if a process (by pid) is still alive. Used for port-liveness checks
  // when switching sessions (a stale pid means the dev server died).
  ipcMain.handle('process:isAlive', async (_e, pid: number) => {
    return isProcessAlive(pid);
  });

  // ── Git ─────────────────────────────────────────
  // Resolve the git cwd for an operation: prefer the active session's
  // worktree path (so the Git Panel shows worktree changes when one is
  // isolated), fall back to the workspace's main checkout.
  const resolveGitCwd = async (workspaceId: string, sessionId?: string): Promise<string | undefined> => {
    if (sessionId) {
      try {
        const session = sessions.getSession(sessionId);
        if (session?.worktree?.path) return session.worktree.path;
      } catch { /* sessions module not ready — fall through */ }
    }
    return store.listWorkspaces().find((w) => w.id === workspaceId)?.path;
  };

  ipcMain.handle('tide:gitStatus', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    startGitWatcher(workspaceId, root);
    try { return await getGitStatus(root); } catch { return []; }
  });

  // Commit history (newest first) for the Git Panel → History tab.
  ipcMain.handle('tide:gitLog', async (_e, workspaceId: string, sessionId?: string, limit?: number) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await getGitLog(root, limit); } catch { return []; }
  });

  // Files changed in a commit (Git Panel → commit details side panel).
  ipcMain.handle('tide:gitCommitFiles', async (_e, workspaceId: string, sha: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await getCommitFiles(root, sha); } catch { return []; }
  });
  // Diff of one file at a commit (clicking a file in the commit details panel).
  ipcMain.handle('tide:gitCommitFileDiff', async (_e, workspaceId: string, sha: string, filePath: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await getCommitFileDiff(root, sha, filePath); } catch { return []; }
  });

  // Bulk working-tree ops for the Git Panel "Stage All" group. One channel,
  // op-dispatched, so we don't add six near-identical IPC handlers.
  handle('tide:gitBulk', async (_e, workspaceId: string, op: string, sessionId?: string, opts?: { message?: string }) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    try {
      switch (op) {
        case 'stage-all': await gitStageAll(root); break;
        case 'unstage-all': await gitUnstageAll(root); break;
        case 'restore-all': await gitRestoreAll(root); break;
        case 'stash': await gitStash(root, opts?.message); break;
        case 'stash-pop': await gitStashPop(root); break;
        default: return { ok: false, error: `unknown op: ${op}` };
      }
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  // Stash list — drives the "Stash Pop" enabled state and the "View Stash" dialog.
  ipcMain.handle('tide:gitStashList', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await gitStashList(root); } catch { return []; }
  });

  // Live branch + HEAD for the session's working directory (worktree-aware).
  // Drives the Inspector Git section so it updates when a tool changes branches.
  ipcMain.handle('tide:gitBranchInfo', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { branch: null, headCommit: null };
    try { return await branchInfo(root); } catch { return { branch: null, headCommit: null }; }
  });

  // Recently checked-out branches (max 5) for the top-bar branch switcher.
  ipcMain.handle('tide:gitRecentBranches', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await recentBranches(root); } catch { return []; }
  });

  // Checkout a branch (worktree-aware). Returns { ok, error? }.
  handle('tide:gitCheckout', async (_e, workspaceId: string, branch: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    try { await gitCheckout(root, branch); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  handle('tide:gitCreateBranch', async (_e, workspaceId: string, branchName: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    try { await gitCreateBranch(root, branchName); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  handle('tide:gitStage', async (_e, workspaceId: string, filePath: string, stage: boolean, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false };
    try { await gitStage(root, filePath, stage); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message }; }
  });

  handle('tide:gitCommit', async (_e, workspaceId: string, message: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    try {
      const sha = await gitCommit(root, message);
      return { ok: true, sha };
    } catch (e: any) { return { ok: false, error: e?.message }; }
  });

  ipcMain.handle('tide:gitDiff', async (_e, workspaceId: string, filePath: string, staged: boolean, sessionId?: string, contextLines?: number) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await gitDiff(root, filePath, staged, contextLines); } catch { return []; }
  });

  // Pre-turn HEAD sha — captured at turn start so individual files can be
  // reverted to exactly where they were before the turn's edits.
  ipcMain.handle('tide:gitHeadSha', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return null;
    try { return await gitHeadSha(root); } catch { return null; }
  });

  // Restore a single file to its state at the given sha (per-file undo).
  handle('tide:gitRestoreFile', async (_e, workspaceId: string, filePath: string, sha: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitRestoreFile(root, filePath, sha);
  });

  // ── Git: remote + history + branch + conflict service ops ──────

  handle('tide:gitAmend', async (_e, workspaceId: string, message: string | null, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    try {
      const sha = await gitAmend(root, message ?? undefined);
      return { ok: true, sha };
    } catch (e: any) { return { ok: false, error: e?.message }; }
  });

  // Revert a commit; conflicts come back as ok:false for the resolve flow.
  handle('tide:gitRevert', async (_e, workspaceId: string, sha: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitRevertCommit(root, sha);
  });

  handle('tide:gitFetch', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitFetch(root);
  });

  handle('tide:gitPush', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitPush(root);
  });

  handle('tide:gitPull', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitPull(root);
  });

  // null when no upstream is configured.
  ipcMain.handle('tide:gitAheadBehind', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return null;
    try { return await gitAheadBehind(root); } catch { return null; }
  });

  // Local + remote-tracking branches with ahead/behind for tracked locals.
  ipcMain.handle('tide:gitBranchesDetailed', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await gitListBranchesDetailed(root); } catch { return []; }
  });

  handle('tide:gitDeleteBranch', async (_e, workspaceId: string, name: string, force: boolean, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitDeleteBranch(root, name, force);
  });

  // Merge a branch into HEAD; conflicts returned for the resolve flow.
  handle('tide:gitMergeBranch', async (_e, workspaceId: string, name: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitMergeBranch(root, name);
  });

  ipcMain.handle('tide:gitConflictFiles', async (_e, workspaceId: string, sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return [];
    try { return await gitConflictFiles(root); } catch { return []; }
  });

  handle('tide:gitResolveFile', async (_e, workspaceId: string, filePath: string, side: 'ours' | 'theirs', sessionId?: string) => {
    const root = await resolveGitCwd(workspaceId, sessionId);
    if (!root) return { ok: false, error: 'no workspace' };
    return await gitResolveFile(root, filePath, side);
  });

  // ── RAG (Memory & RAG panel) ────────────────────────────────────
  // One read-only handler. The panel refetches on query invalidation;
  // no streaming or push channel needed for status.
  registerRagHandlers();
}

// ── Helper functions ──────────────────────────────────────────

/** Detect git info at a path. Returns null if not a git repo.
 *  Async — git operations no longer block the main process event loop. */
async function detectGit(dirPath: string): Promise<{ branch: string; headCommit: string; fileCount: number } | null> {
  try {
    if (!fs.existsSync(path.join(dirPath, '.git'))) return null;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    const { stdout: headCommit } = await execAsync('git rev-parse --short HEAD', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    const { stdout: fileCountStr } = await execAsync('git ls-files | wc -l', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    return { branch: branch.trim(), headCommit: headCommit.trim(), fileCount: parseInt(fileCountStr.trim(), 10) || 0 };
  } catch {
    return null;
  }
}

/** Expand ~ to home directory. */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '~', p.slice(2));
  }
  return p;
}

/** Read a directory tree recursively up to maxDepth. */
function readDirTree(basePath: string, relativePath: string, maxDepth: number): FileNode[] {
  if (maxDepth < 0) return [];
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries) {
    // Skip hidden dirs, node_modules, .git, etc.
    if (entry.name.startsWith('.') && entry.name !== '.agent') continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue;

    const entryRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: entryRelative,
        kind: 'dir',
        expanded: maxDepth > 1,
        children: readDirTree(basePath, entryRelative, maxDepth - 1),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: entryRelative,
        kind: 'file',
      });
    }
  }
  return nodes;
}
