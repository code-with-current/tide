/** Misc RPC — the catch-all port of the remaining single-purpose channels
 *  from electron/ipc/handlers.ts: native dialogs (devkit Utils.openFileDialog
 *  replaces Electron dialog.showOpenDialog), external/image file reads for
 *  attachments, clipboard-blob persistence, env/diagnostics, macOS permission
 *  consent, mermaid repair, renderer log forwarding, shell ops (devkit
 *  Utils.openExternal/showItemInFolder/openPath replace Electron's shell),
 *  fullscreen query, the agent/general settings pair (login-item side effect
 *  dropped — no devkit API), the built-in agents catalog, project entries,
 *  and per-session todos (updates pushed via todosUpdated). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Utils } from 'electrobun/main';
import { forwardLog, createLogger } from '../core/logger.js';
import { getPermissionStatus, requestPermission, shouldShowConsent } from '../core/permissions.js';
import { repairMermaidDiagram } from '../core/agent/mermaid-repair.js';
import { getSessionTodos, todoEvents } from '../core/agent/tools/todo-write';
import { BUILTIN_AGENTS } from '../core/agent/agents/registry';
import { scanProjectEntries } from '../core/agent/project-context';
import { syncAllWorkspaceHooks } from '../core/git-coauthor.js';
import { getKeysNeedMigration } from '../platform/key-migration.js';
import { expandPath } from './workspaces';
import type {
  AgentSettingsWire,
  DiagnosticsInfo,
  EnvInfo,
  ExternalFileContent,
  GeneralSettingsWire,
  ImageFileContent,
  MacPermissionStatus,
  MacPermissionType,
  MermaidRepairResult,
  ShellOpResult,
  TodosUpdatedEvent,
} from '../../shared/rpc';
import type { AgentSettings, GeneralSettings } from '../core/configStore';

const log = createLogger('misc-rpc');

/** The core-store surface the settings handlers touch. */
export interface MiscSettingsDomain {
  getAgentSettings(): AgentSettings;
  updateAgentSettings(patch: Partial<AgentSettings>): void;
  getGeneralSettings(): GeneralSettings;
  updateGeneralSettings(patch: Partial<GeneralSettings>): void;
  listWorkspaces(): Array<{ id: string; path: string }>;
}

/** Structural slice of the BrowserWindow the misc handlers touch. */
export interface WindowHandle {
  isFullScreen(): boolean;
  minimize?(): unknown;
  maximize?(): unknown;
  unmaximize?(): unknown;
  isMaximized?(): boolean;
  close?(): unknown;
}

export interface MiscRpcOpts {
  /** App data dir for attachment persistence + diagnostics. */
  dataDir: string;
  /** Live window handle — set after the BrowserWindow exists (fullscreen,
   * Windows/Linux app-drawn window controls). */
  getWindow?: () => WindowHandle | null;
  /** Pushes todo updates from the todo_write tool. */
  todosUpdated?: (e: TodosUpdatedEvent) => void;
  /** Best-effort app version source (the bundle's baked version.json). */
  appVersion?: () => string | Promise<string>;
}

const IMG_MAX_BYTES = 10 * 1024 * 1024;
const IMG_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
};

export function mimeFromPath(p: string): string | null {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return IMG_EXT_MIME[ext] ?? null;
}

export function registerMiscRpc(domain: MiscSettingsDomain, opts: MiscRpcOpts) {
  const { dataDir, getWindow, todosUpdated } = opts;
  const appVersion = opts.appVersion ?? (() => '0.0.0-dev');

const resolveAppVersion = (): string | Promise<string> =>
  typeof appVersion === 'function' ? appVersion() : appVersion;

  if (todosUpdated) {
    todoEvents.on(({ sessionId, todos }) => todosUpdated({ sessionId, todos }));
  }

  return {
    dialogPickDirectory: async (_: Record<string, never>) => {
      try {
        const paths = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        return { path: paths.length > 0 ? paths[0] : null };
      } catch (e) {
        log.warn('pickDirectory failed', { err: e instanceof Error ? e.message : String(e) });
        return { path: null };
      }
    },

    dialogPickFiles: async (_: Record<string, never>) => {
      try {
        const paths = await Utils.openFileDialog({
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: true,
        });
        return { paths };
      } catch (e) {
        log.warn('pickFiles failed', { err: e instanceof Error ? e.message : String(e) });
        return { paths: [] };
      }
    },

    externalFileRead: ({ filePath }: { filePath: string }): ExternalFileContent | null => {
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
    },

    imageFileRead: ({ absPath, workspaceId, relPath }: { absPath?: string; workspaceId?: string; relPath?: string }): ImageFileContent | null => {
      try {
        let target: string | null = null;
        if (absPath) {
          target = absPath;
        } else if (workspaceId && relPath) {
          const ws = domain.listWorkspaces().find((w) => w.id === workspaceId);
          if (!ws) return null;
          const root = expandPath(ws.path);
          const full = path.resolve(root, relPath);
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

    clipboardFileSave: ({ name, dataBase64 }: { name: string; dataBase64: string }) => {
      try {
        const dir = path.join(dataDir, 'attachments');
        fs.mkdirSync(dir, { recursive: true });
        const safe = path.basename(name || 'pasted-file').replace(/[^a-zA-Z0-9._-]/g, '_') || 'pasted-file';
        const target = path.join(dir, `${Date.now()}-${safe}`);
        fs.writeFileSync(target, Buffer.from(dataBase64, 'base64'));
        return { path: target };
      } catch {
        return { path: '' };
      }
    },

    envInfoGet: (_: Record<string, never>): EnvInfo => ({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      shell: process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : (process.env.SHELL || '/bin/sh'),
      keysNeedMigration: getKeysNeedMigration(),
    }),

    diagnosticsGet: async (_: Record<string, never>): Promise<DiagnosticsInfo> => ({
      appVersion: await resolveAppVersion(),
      runtime: 'bun',
      runtimeVersion: process.versions.bun ?? 'unknown',
      chrome: 'unknown',
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      userDataPath: dataDir,
    }),

    permissionStatusGet: (_: Record<string, never>): MacPermissionStatus => getPermissionStatus(),

    permissionRequest: ({ type }: { type: MacPermissionType }) =>
      requestPermission(type).then((result) => ({ result })),

    consentShouldShow: async (_: Record<string, never>) => ({ shouldShow: shouldShowConsent() }),

    mermaidRepair: async ({ source, error }: { source: string; error: string }): Promise<MermaidRepairResult> =>
      repairMermaidDiagram(source, error),

    logSend: ({ level, tag, msg, args }: { level: string; tag: string; msg: string; args?: unknown[] }) => {
      forwardLog(level, tag, msg, args);
      return {};
    },

    shellOpenExternal: ({ url }: { url: string }) => ({ ok: Utils.openExternal(url) }),

    shellShowItemInFolder: ({ fullPath }: { fullPath: string }) => {
      Utils.showItemInFolder(fullPath);
      return {};
    },

    shellOpenPath: ({ path: p }: { path: string }): ShellOpResult => {
      const opened = Utils.openPath(p);
      return opened ? { ok: true } : { ok: false, error: 'Failed to open path' };
    },

    windowMinimize: (_: Record<string, never>): {} => {
      getWindow?.()?.minimize?.();
      return {};
    },
    windowToggleMaximize: (_: Record<string, never>): { maximized: boolean } => {
      const w = getWindow?.();
      if (!w) return { maximized: false };
      const maximized = w.isMaximized?.() ?? false;
      if (maximized) w.unmaximize?.();
      else w.maximize?.();
      return { maximized: !maximized };
    },
    windowClose: (_: Record<string, never>): {} => {
      getWindow?.()?.close?.();
      return {};
    },
    windowIsFullScreen: (_: Record<string, never>) => ({
      fullscreen: getWindow?.()?.isFullScreen() ?? false,
    }),

    settingsGetAgent: (_: Record<string, never>): AgentSettingsWire => domain.getAgentSettings(),

    settingsUpdateAgent: ({ patch }: { patch: Partial<AgentSettingsWire> }) => {
      log.info('agent settings updated', { keys: Object.keys(patch) });
      domain.updateAgentSettings(patch);
      return domain.getAgentSettings();
    },

    settingsGetGeneral: (_: Record<string, never>): GeneralSettingsWire => domain.getGeneralSettings(),

    settingsUpdateGeneral: ({ patch }: { patch: Partial<GeneralSettingsWire> }) => {
      log.info('general settings updated', { keys: Object.keys(patch) });
      domain.updateGeneralSettings(patch);
      if ('gitCoAuthored' in patch || 'gitCoAuthorName' in patch || 'gitCoAuthorEmail' in patch) {
        try {
          syncAllWorkspaceHooks();
        } catch (e) {
          log.warn('workspace hook sync failed', { err: e instanceof Error ? e.message : String(e) });
        }
      }
      // The Electron shell also applied the startAtLogin toggle as an OS
      // login item here — the devkit has no login-item API (4.x gap).
      return domain.getGeneralSettings();
    },

    agentList: (_: Record<string, never>) =>
      BUILTIN_AGENTS
        .filter((a) => !a.hidden)
        .map((a) => ({ name: a.name, description: a.description, whenToUse: a.whenToUse })),

    projectEntriesList: ({ workspaceId }: { workspaceId: string }) => {
      const ws = domain.listWorkspaces().find((w) => w.id === workspaceId);
      if (!ws || !ws.path) return { contextFiles: [], skills: [], agents: [] };
      try {
        return scanProjectEntries(ws.path);
      } catch {
        return { contextFiles: [], skills: [], agents: [] };
      }
    },

    todosList: ({ sessionId }: { sessionId: string }) => ({ todos: getSessionTodos(sessionId) }),
  };
}
