/** MCP RPC — port of electron/ipc/mcp.ts (frozen Electron shell). Bridges the
 *  management UI to the connection pool, config files, secrets, and the import
 *  scanner. The pool is the same module-scoped singleton app/main.ts boots
 *  (initUserServers/initBuiltinServers), so handler mutations and boot init
 *  land in one place. Status pushes ride the mcpEvents message: the pool's
 *  onStatusChange fires a single module-scope listener that forwards through
 *  a mutable emit slot, so registering the RPC tier repeatedly (tests) never
 *  stacks listeners, and boot-time notifications before registration are
 *  dropped exactly like the Electron shell's zero-window broadcast was.
 *  Project-scoped handlers resolve the active workspace via the tracker set
 *  by mcpWorkspaceActivated, falling back to the config store so they work
 *  before activation ever fires. OAuth callback wiring (tide:// deep links)
 *  is Task 4.3 — mcpAuthenticate/mcpReauthorize only start/clear flows. */

import * as path from 'node:path';
import {
  getStatusList,
  retryServer,
  authenticateServer,
  activateWorkspace,
  onStatusChange,
  loadServer,
  unloadServer,
  disableServer,
  reinitializeAll,
} from '../core/agent/mcp/pool.js';
import {
  addServer,
  removeServer,
  validateServerConfig,
  readMcpConfig,
  writeMcpConfig,
} from '../core/agent/mcp/config.js';
import type { McpConfigFile } from '../core/agent/mcp/types.js';
import * as store from '../core/store.js';
import { setSecret, hasSecret, clearSecret } from '../core/agent/mcp/secrets.js';
import { clearOAuthTokens } from '../core/agent/mcp/oauth.js';
import { scanExternalMcpServers } from '../core/agent/mcp/scanner.js';
import { BUILTIN_MCP_SERVERS } from '../core/agent/mcp/builtin.js';
import { createExtensionsStore } from '../core/extensionsStore.js';
import { createLogger } from '../core/logger.js';
import { appDataDir } from '../platform/paths';
import type { McpEvent, McpOpResult, McpScope, McpServerConfig } from '../../shared/rpc';

const log = createLogger('mcp-rpc');

type ActiveWorkspace = { id: string; root: string } | undefined;

export interface McpRpcSend {
  event(msg: McpEvent): void;
}

let activeWorkspace: ActiveWorkspace;
let emitStatus: ((msg: McpEvent) => void) | null = null;

onStatusChange(() => emitStatus?.({ kind: 'statusChanged' }));

/** Resolve the active workspace via the live tracker, falling back to the
 *  config store so project-scoped configs resolve even before
 *  mcpWorkspaceActivated fires. */
function resolveWorkspace(): ActiveWorkspace {
  if (activeWorkspace?.root) return activeWorkspace;
  try {
    const workspaces = store.listWorkspaces();
    const lastSession = store.getLastSession();
    const active = (lastSession?.workspaceId
      ? workspaces.find((w) => w.id === lastSession.workspaceId)
      : undefined) ?? workspaces.find((w) => w.path);
    if (active?.path) return { id: active.id, root: active.path };
  } catch { /* best-effort */ }
  return undefined;
}

function userConfigPath(): string {
  return path.join(appDataDir(), 'mcp.json');
}

function projectConfigPath(root: string): string {
  return path.join(root, '.mcp.json');
}

export function registerMcpRpc(send: McpRpcSend) {
  emitStatus = send.event;

  /** Config file a scope mutates — null when project scope has no workspace. */
  function configPathForScope(scope: McpScope): string | null {
    if (scope === 'user') return userConfigPath();
    const ws = resolveWorkspace();
    return ws ? projectConfigPath(ws.root) : null;
  }

  function fireAndForget(label: string, op: Promise<unknown>, detail: Record<string, unknown>): void {
    op.then(
      () => log.info(label, detail),
      (err) => log.warn(`${label} failed`, { ...detail, err: err?.message ?? String(err) }),
    );
  }

  return {
    // ── Status list (powers the management panel) ──
    mcpList: ({ workspaceId }: { workspaceId?: string }) => getStatusList(workspaceId),

    // ── Add / update (replace by name). Scope decides which file we write.
    //    The connection fires in the background so the request returns
    //    instantly; the UI updates off mcpEvents. ──
    mcpAdd: ({ name, config, scope }: { name: string; config: McpServerConfig; scope: McpScope }): McpOpResult => {
      const errors = validateServerConfig(config);
      if (errors.length > 0) return { ok: false, error: errors.join('; ') };
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace for project-scoped server' };
      addServer(filePath, name, config);
      const ws = resolveWorkspace();
      fireAndForget('server added', loadServer(name, config, scope, ws?.id), { name, scope });
      return { ok: true };
    },

    // Update is identical to add (addServer replaces by name).
    mcpUpdate: ({ name, config, scope }: { name: string; config: McpServerConfig; scope: McpScope }): McpOpResult => {
      if (scope === 'builtin') return { ok: false, error: 'Built-in servers cannot be edited.' };
      const errors = validateServerConfig(config);
      if (errors.length > 0) return { ok: false, error: errors.join('; ') };
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace for project-scoped server' };
      addServer(filePath, name, config);
      const ws = resolveWorkspace();
      fireAndForget('server updated', loadServer(name, config, scope, ws?.id), { name, scope });
      return { ok: true };
    },

    mcpRemove: async ({ name, scope }: { name: string; scope: McpScope }): Promise<McpOpResult> => {
      if (scope === 'builtin') return { ok: false, error: 'Built-in servers cannot be removed.' };
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace' };
      removeServer(filePath, name);
      // Remove from the pool so it disappears from the UI
      const ws = resolveWorkspace();
      await unloadServer(name, scope, ws?.id);
      log.info('server removed', { name, scope });
      return { ok: true };
    },

    // ── Approve (first-connect consent) — approval gate removed; kept as a
    //    benign no-op so the UI channel keeps answering. ──
    mcpApprove: ({ name }: { name: string }) => {
      log.info('server approved (gate removed — no-op)', { name });
      return { ok: true };
    },

    // ── Retry a failed/error server — reconnects with fresh config from
    //    disk so external edits are picked up, not the stale cached config. ──
    mcpRetry: ({ name, scope, workspaceId }: { name: string; scope: McpScope; workspaceId?: string }) => {
      const ws = resolveWorkspace();
      retryServer(name, scope, ws?.root, workspaceId).catch((e) =>
        log.warn('retry failed', { name, error: String(e) }),
      );
      return { ok: true };
    },

    // ── Authenticate (OAuth): user-initiated browser sign-in. Opens the
    //    browser at the stashed authorization URL, then re-runs connect.
    //    Builtin servers are stdio — never OAuth-gated — so a builtin scope
    //    (unreachable from the UI) no-ops rather than misdirecting the flow.
    //    The tide:// callback arrival is Task 4.3 (deep links). ──
    mcpAuthenticate: ({ name, scope, workspaceId }: { name: string; scope: McpScope; workspaceId?: string }) => {
      if (scope === 'builtin') {
        log.warn('authenticate: builtin servers cannot authenticate', { name });
        return { ok: true };
      }
      authenticateServer(name, scope, workspaceId).catch((e) =>
        log.warn('authenticate failed', { name, error: String(e) }),
      );
      return { ok: true };
    },

    // ── Re-initialize ALL servers (disconnect + reconnect from config):
    //    picks up added/removed/edited and previously-failing servers.
    //    Fire-and-forget; the UI updates off mcpEvents. ──
    mcpReinitialize: (_: Record<string, never>) => {
      const ws = resolveWorkspace();
      reinitializeAll(ws ?? undefined).catch((e) =>
        log.warn('reinitialize failed', { error: String(e) }),
      );
      return { ok: true };
    },

    // ── Secret management (safeStorage shim-backed) ──
    mcpSetSecret: ({ name, value }: { name: string; value: string }) => {
      setSecret(name, value);
      return { ok: true };
    },
    mcpHasSecret: ({ name }: { name: string }) => ({ has: hasSecret(name) }),
    mcpClearSecret: ({ name }: { name: string }) => {
      clearSecret(name);
      return { ok: true };
    },

    // ── Re-authorize OAuth server (clear tokens + retry). Project servers
    //    store OAuth in the workspace's config, user servers globally. ──
    mcpReauthorize: ({ name, scope, workspaceId }: { name: string; scope: McpScope; workspaceId?: string }) => {
      const ws = resolveWorkspace();
      clearOAuthTokens(name, { scope, workspaceId: workspaceId ?? ws?.id });
      log.info('oauth tokens cleared for re-auth', { name, scope });
      retryServer(name, scope, ws?.root, workspaceId).catch((e) =>
        log.warn('re-auth retry failed', { name, error: String(e) }),
      );
      return { ok: true };
    },

    // ── Import scanner — detect MCP servers from other tools ──
    mcpScan: (_: Record<string, never>) => scanExternalMcpServers(userConfigPath()),

    // ── Import selected servers: write config synchronously for all, then
    //    fire connections in the background so the dialog can close; status
    //    transitions (connecting → connected/error) push via mcpEvents. ──
    mcpImport: ({ servers, scope }: { servers: Array<{ name: string; config: McpServerConfig }>; scope: McpScope }) => {
      const ws = resolveWorkspace();
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace for project scope' };
      for (const { name, config } of servers) {
        addServer(filePath, name, config);
      }
      for (const { name, config } of servers) {
        fireAndForget('server imported', loadServer(name, config, scope, ws?.id), { name, scope, source: 'import' });
      }
      return { ok: true, imported: servers.length };
    },

    // ── Enable/disable a server (toggle without removing config). Disabling
    //    keeps a 'disconnected' row so the server stays visible (greyed out);
    //    re-enabling reconnects from builtin → user → project config. ──
    mcpSetEnabled: async ({ name, enabled, scope: _scope }: { name: string; enabled: boolean; scope: McpScope }) => {
      const extStore = createExtensionsStore(appDataDir());
      extStore.setEnabled('mcp', name, enabled);
      log.info('server toggled', { name, enabled });

      if (!enabled) {
        const ws = resolveWorkspace();
        await disableServer(name, 'user', undefined);
        await disableServer(name, 'project', ws?.id);
        await disableServer(name, 'builtin', undefined);
      } else {
        const builtin = BUILTIN_MCP_SERVERS[name];
        if (builtin) {
          await loadServer(name, builtin.config, 'builtin');
        } else {
          const userConfig = readMcpConfig(userConfigPath());
          const ws = resolveWorkspace();
          if (userConfig[name]) {
            await loadServer(name, userConfig[name], 'user');
          } else if (ws) {
            const projConfig = readMcpConfig(projectConfigPath(ws.root));
            if (projConfig[name]) {
              await loadServer(name, projConfig[name], 'project', ws.id);
            }
          }
        }
      }
      return { ok: true };
    },

    // ── Raw config read/write (advanced editor in the UI) ──
    mcpReadRaw: ({ scope }: { scope: McpScope }) => {
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace' };
      return { ok: true, config: readMcpConfig(filePath) };
    },
    mcpWriteRaw: ({ config, scope }: { config: Record<string, unknown>; scope: McpScope }): McpOpResult => {
      const filePath = configPathForScope(scope);
      if (!filePath) return { ok: false, error: 'No active workspace' };
      writeMcpConfig(filePath, config as McpConfigFile);
      return { ok: true };
    },

    // ── Workspace activation (project-scoped servers) ──
    mcpWorkspaceActivated: ({ workspaceId, workspaceRoot }: { workspaceId: string; workspaceRoot: string }) => {
      activeWorkspace = { id: workspaceId, root: workspaceRoot };
      activateWorkspace(workspaceId, workspaceRoot).catch((e) =>
        log.warn('activateWorkspace failed', { workspaceId, error: String(e) }),
      );
      return { ok: true };
    },
  };
}

export type McpRpcHandlers = ReturnType<typeof registerMcpRpc>;
