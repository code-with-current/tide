/**
 * MCP IPC — bridges the MCP management UI to the connection pool + config
 * + secrets modules.
 *
 * Mirrors the extensions.ts pattern: a single `registerMcpHandlers()`
 * entry point that wires ipcMain.handle handlers, plus a status-change
 * broadcast that pushes `tide:mcp:statusChanged` to every BrowserWindow
 * whenever the pool's connection state mutates (so the UI refreshes live
 * as servers connect, fail, or get approved).
 *
 * Config paths resolve per call from `getActiveWorkspace()` — the user
 * config lives in `app.getPath('userData')` (always available) and the
 * project config lives in the active workspace's root (`<root>/.mcp.json`).
 * Handlers that operate on project scope no-op (return without writing)
 * when no workspace is active.
 */
import { ipcMain, app, BrowserWindow } from 'electron';
import * as path from 'path';
import {
  getStatusList,
  retryServer,
  authenticateServer,
  activateWorkspace,
  onStatusChange,
  loadServer,
  unloadServer,
  reinitializeAll,
} from '../agent/mcp/pool.js';
import {
  addServer,
  removeServer,
  validateServerConfig,
} from '../agent/mcp/config.js';
import { approveServer } from '../agent/mcp/approvals.js';
import { setSecret, hasSecret, clearSecret } from '../agent/mcp/secrets.js';
import { clearOAuthTokens } from '../agent/mcp/oauth.js';
import { scanExternalMcpServers } from '../agent/mcp/scanner.js';
import { readMcpConfig, writeMcpConfig } from '../agent/mcp/config.js';
import { createExtensionsStore } from '../extensionsStore.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp');

type ActiveWorkspace = { id: string; root: string } | undefined;

function userConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp.json');
}

function projectConfigPath(root: string): string {
  return path.join(root, '.mcp.json');
}

/**
 * Register MCP IPC handlers. `getActiveWorkspace` is a thunk so the handler
 * always reads the freshest value (main.ts updates an `activeWorkspace`
 * variable on `tide:mcp:workspaceActivated`).
 */
export function registerMcpHandlers(
  getActiveWorkspace: () => ActiveWorkspace,
): void {
  // ── Status list (powers the management panel) ──
  ipcMain.handle('tide:mcp:list', (_e, workspaceId?: string) => {
    return getStatusList(workspaceId);
  });

  // ── Add / update (replace by name). Scope decides which file we write. ──
  ipcMain.handle(
    'tide:mcp:add',
    async (_e, name: string, config: any, scope: 'user' | 'project') => {
      const errors = validateServerConfig(config);
      if (errors.length > 0) {
        return { ok: false, error: errors.join('; ') };
      }
      const filePath =
        scope === 'user'
          ? userConfigPath()
          : (() => {
              const ws = getActiveWorkspace();
              if (!ws) {
                return { ok: false, error: 'No active workspace for project-scoped server' };
              }
              return projectConfigPath(ws.root);
            })();
      if (typeof filePath !== 'string') return filePath;
      addServer(filePath, name, config);
      // Auto-approve servers added via the UI — the user explicitly added it,
      // no need for the first-connect security prompt.
      approveServer(name);
      // Load the server into the pool so it appears in the UI + connects
      const ws = getActiveWorkspace();
      await loadServer(name, config, scope, ws?.id);
      log.info('server added', { name, scope });
      return { ok: true };
    },
  );

  // Update is identical to add (addServer replaces by name).
  ipcMain.handle(
    'tide:mcp:update',
    async (_e, name: string, config: any, scope: 'user' | 'project') => {
      const errors = validateServerConfig(config);
      if (errors.length > 0) {
        return { ok: false, error: errors.join('; ') };
      }
      const filePath =
        scope === 'user'
          ? userConfigPath()
          : (() => {
              const ws = getActiveWorkspace();
              if (!ws) {
                return { ok: false, error: 'No active workspace for project-scoped server' };
              }
              return projectConfigPath(ws.root);
            })();
      if (typeof filePath !== 'string') return filePath;
      addServer(filePath, name, config);
      // Auto-approve on update too (user is explicitly editing it)
      approveServer(name);
      // Reload the server into the pool with the new config
      const ws = getActiveWorkspace();
      await loadServer(name, config, scope, ws?.id);
      log.info('server updated', { name, scope });
      return { ok: true };
    },
  );

  ipcMain.handle(
    'tide:mcp:remove',
    async (_e, name: string, scope: 'user' | 'project') => {
      const filePath =
        scope === 'user'
          ? userConfigPath()
          : (() => {
              const ws = getActiveWorkspace();
              if (!ws) return null;
              return projectConfigPath(ws.root);
            })();
      if (!filePath) return { ok: false, error: 'No active workspace' };
      removeServer(filePath, name);
      // Remove from the pool so it disappears from the UI
      const ws = getActiveWorkspace();
      await unloadServer(name, scope, ws?.id);
      log.info('server removed', { name, scope });
      return { ok: true };
    },
  );

  // ── Approve (first-connect consent) ──
  ipcMain.handle('tide:mcp:approve', (_e, name: string) => {
    approveServer(name);
    log.info('server approved', { name });
    return { ok: true };
  });

  // ── Retry a failed/error server ──
  ipcMain.handle(
    'tide:mcp:retry',
    (_e, name: string, scope: 'user' | 'project', workspaceId?: string) => {
      // Fire-and-forget — retry is async but the UI re-renders off the
      // statusChanged broadcast when connectServer resolves.
      retryServer(name, scope, workspaceId).catch((e) =>
        log.warn('retry failed', { name, error: String(e) }),
      );
      return { ok: true };
    },
  );

  // ── Authenticate (OAuth): user-initiated browser sign-in ──
  // Opens the browser at the stashed authorization URL, then re-runs connect.
  // MUST be triggered by the "Authenticate" button — not during init/reload.
  ipcMain.handle(
    'tide:mcp:authenticate',
    (_e, name: string, scope: 'user' | 'project', workspaceId?: string) => {
      authenticateServer(name, scope, workspaceId).catch((e) =>
        log.warn('authenticate failed', { name, error: String(e) }),
      );
      return { ok: true };
    },
  );

  // ── Re-initialize ALL servers (disconnect + reconnect from config) ──
  // The MCP "reload" action: tears down every connection and re-runs the
  // full init (user servers + active workspace's project servers), so newly
  // added/removed/edited servers and previously-failing ones all get a fresh
  // connect attempt. Fire-and-forget; the UI updates off statusChanged.
  ipcMain.handle('tide:mcp:reinitialize', () => {
    const ws = getActiveWorkspace();
    reinitializeAll(ws ?? undefined).catch((e) =>
      log.warn('reinitialize failed', { error: String(e) }),
    );
    return { ok: true };
  });

  // ── Secret management (safeStorage-backed) ──
  ipcMain.handle('tide:mcp:setSecret', (_e, name: string, value: string) => {
    setSecret(name, value);
    return { ok: true };
  });
  ipcMain.handle('tide:mcp:hasSecret', (_e, name: string) => {
    return hasSecret(name);
  });
  ipcMain.handle('tide:mcp:clearSecret', (_e, name: string) => {
    clearSecret(name);
    return { ok: true };
  });

  // ── Re-authorize OAuth server (clear tokens + retry) ──
  ipcMain.handle(
    'tide:mcp:reauthorize',
    async (_e, name: string, scope: 'user' | 'project', workspaceId?: string) => {
      clearOAuthTokens(name);
      log.info('oauth tokens cleared for re-auth', { name });
      retryServer(name, scope, workspaceId).catch((e) =>
        log.warn('re-auth retry failed', { name, error: String(e) }),
      );
      return { ok: true };
    },
  );

  // ── Import scanner — detect MCP servers from other tools ──
  ipcMain.handle('tide:mcp:scan', () => {
    return scanExternalMcpServers(userConfigPath());
  });

  // ── Import selected servers ──
  ipcMain.handle(
    'tide:mcp:import',
    async (_e, servers: Array<{ name: string; config: any }>, scope: 'user' | 'project') => {
      const ws = getActiveWorkspace();
      const filePath =
        scope === 'user'
          ? userConfigPath()
          : ws
            ? projectConfigPath(ws.root)
            : null;
      if (!filePath) return { ok: false, error: 'No active workspace for project scope' };

      for (const { name, config } of servers) {
        addServer(filePath, name, config);
        approveServer(name);
        await loadServer(name, config, scope, ws?.id);
        log.info('server imported', { name, scope, source: 'import' });
      }
      return { ok: true, imported: servers.length };
    },
  );

  // ── Enable/disable a server (toggle on/off without removing config) ──
  ipcMain.handle(
    'tide:mcp:setEnabled',
    async (_e, name: string, enabled: boolean, _scope: 'user' | 'project') => {
      const extStore = createExtensionsStore(app.getPath('userData'));
      extStore.setEnabled('mcp', name, enabled);
      log.info('server toggled', { name, enabled });

      if (!enabled) {
        // Disconnect immediately — tools disappear from orchestrator next turn
        const ws = getActiveWorkspace();
        await unloadServer(name, 'user', undefined);
        await unloadServer(name, 'project', ws?.id);
      } else {
        // Reconnect — read config + load into pool
        const userConfig = readMcpConfig(userConfigPath());
        const ws = getActiveWorkspace();
        if (userConfig[name]) {
          await loadServer(name, userConfig[name], 'user');
        } else if (ws) {
          const projConfig = readMcpConfig(projectConfigPath(ws.root));
          if (projConfig[name]) {
            await loadServer(name, projConfig[name], 'project', ws.id);
          }
        }
      }
      return { ok: true };
    },
  );

  // ── Raw config read/write (advanced editor in the UI) ──
  ipcMain.handle('tide:mcp:readRaw', (_e, scope: 'user' | 'project') => {
    const filePath =
      scope === 'user'
        ? userConfigPath()
        : (() => {
            const ws = getActiveWorkspace();
            return ws ? projectConfigPath(ws.root) : null;
          })();
    if (!filePath) return { ok: false, error: 'No active workspace' };
    return { ok: true, config: readMcpConfig(filePath) };
  });
  ipcMain.handle(
    'tide:mcp:writeRaw',
    (_e, config: Record<string, unknown>, scope: 'user' | 'project') => {
      const filePath =
        scope === 'user'
          ? userConfigPath()
          : (() => {
              const ws = getActiveWorkspace();
              return ws ? projectConfigPath(ws.root) : null;
            })();
      if (!filePath) return { ok: false, error: 'No active workspace' };
      writeMcpConfig(filePath, config as any);
      return { ok: true };
    },
  );

  // ── Workspace activation (project-scoped servers) ──
  ipcMain.handle(
    'tide:mcp:workspaceActivated',
    (_e, workspaceId: string, workspaceRoot: string) => {
      activateWorkspace(workspaceId, workspaceRoot).catch((e) =>
        log.warn('activateWorkspace failed', { workspaceId, error: String(e) }),
      );
      return { ok: true };
    },
  );

  // ── Status change broadcast ──
  // The pool emits on every connection state mutation. Fan-out to every
  // BrowserWindow so any open MCP panel re-fetches its list. The renderer
  // listens via `onMcpStatusChanged` and calls `mcpList` again.
  onStatusChange(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('tide:mcp:statusChanged');
      } catch {
        /* window may be mid-close */
      }
    }
  });
}
