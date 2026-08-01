/**
 * MCP connection pool — module-scoped singleton owning all server connections.
 *
 * Hybrid lifecycle:
 *   - User servers (~/.tide/mcp.json): app-lifetime
 *   - Project servers (.mcp.json): workspace-lifetime
 */
import { app } from 'electron';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../../logger';
import { readMcpConfig } from './config';
import { resolveSecrets, resolveArgsSecrets } from './secrets';
import { getApprovedServers, approveServer } from './approvals';
import { createAuthProvider, consumePendingAuthUrl, hasPendingAuthUrl, registerOAuthCompleter } from './oauth';
import { createExtensionsStore } from '../../extensionsStore';
import type {
  McpConnection,
  McpTool,
  McpServerConfig,
  McpServerStatus,
} from './types';

const log = createLogger('mcp');

const userConnections = new Map<string, McpConnection>();
const workspaceConnections = new Map<string, Map<string, McpConnection>>();

/** Check if a server name is disabled in the extensions store. */
function isServerDisabled(name: string): boolean {
  try {
    const extStore = createExtensionsStore(app.getPath('userData'));
    return extStore.getDisabled().mcp.includes(name);
  } catch {
    return false;
  }
}

type StatusListener = () => void;
const listeners = new Set<StatusListener>();

export function onStatusChange(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyStatusChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* keep pool alive */
    }
  }
}

function userConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp.json');
}

function projectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mcp.json');
}

export async function initUserServers(): Promise<void> {
  const config = readMcpConfig(userConfigPath());
  const approved = getApprovedServers();
  log.info('init user servers', { total: Object.keys(config).length, approved: approved.length });
  for (const [name, serverConfig] of Object.entries(config)) {
    if (!approved.includes(name)) {
      userConnections.set(name, {
        name,
        config: serverConfig,
        scope: 'user',
        status: 'needs_approval',
        tools: [],
        restartCount: 0,
      });
      continue;
    }
    await connectServer(name, serverConfig, 'user');
  }
  notifyStatusChange();
}

export async function activateWorkspace(
  workspaceId: string,
  workspaceRoot: string,
): Promise<void> {
  // Disconnect previous workspace's project servers
  for (const [wsId, conns] of workspaceConnections) {
    if (wsId !== workspaceId && conns.size > 0) {
      log.info('switching workspace — disconnecting project servers', { fromWs: wsId, count: conns.size });
      for (const conn of conns.values()) await disconnectConnection(conn);
      conns.clear();
    }
  }

  const config = readMcpConfig(projectConfigPath(workspaceRoot));
  log.info('activate workspace', { workspaceId, projectServers: Object.keys(config).length });
  const approved = getApprovedServers();
  let wsPool = workspaceConnections.get(workspaceId);
  if (!wsPool) {
    wsPool = new Map();
    workspaceConnections.set(workspaceId, wsPool);
  }

  for (const [name, serverConfig] of Object.entries(config)) {
    if (!approved.includes(name)) {
      wsPool.set(name, {
        name,
        config: serverConfig,
        scope: 'project',
        workspaceId,
        status: 'needs_approval',
        tools: [],
        restartCount: 0,
      });
      continue;
    }
    await connectServer(name, serverConfig, 'project', workspaceId);
  }
  notifyStatusChange();
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  log.info('connecting', { name, scope, transport: config.type });
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  if (scope === 'project' && !workspaceConnections.has(workspaceId!)) {
    workspaceConnections.set(workspaceId!, pool);
  }

  pool.set(name, {
    name,
    config,
    scope,
    workspaceId,
    status: 'connecting',
    tools: [],
    restartCount: 0,
  });
  notifyStatusChange();

  try {
    let resolvedEnv: Record<string, string> | undefined;
    let resolvedArgs: string[] | undefined;
    let missingSecrets: string[] = [];

    if (config.env) {
      const result = resolveSecrets(config.env);
      resolvedEnv = result.resolved;
      missingSecrets = result.missing;
    }
    if (config.args) {
      const result = resolveArgsSecrets(config.args);
      resolvedArgs = result.resolved;
      missingSecrets = [...missingSecrets, ...result.missing];
    }

    if (missingSecrets.length > 0) {
      const conn = pool.get(name)!;
      conn.status = 'needs_credentials';
      conn.error = `Missing secrets: ${missingSecrets.join(', ')}`;
      notifyStatusChange();
      return;
    }

    let transport;
    if (config.type === 'stdio') {
      transport = new StdioClientTransport({
        command: config.command!,
        args: resolvedArgs ?? config.args ?? [],
        env: { ...process.env, ...resolvedEnv } as Record<string, string>,
      });
    } else if (config.type === 'sse') {
      // Remote servers may require OAuth — pass an authProvider so the SDK can
      // run the 401 → metadata → browser → callback → token-exchange flow.
      // No-op for servers that don't require auth.
      transport = new SSEClientTransport(new URL(config.url!), {
        authProvider: createAuthProvider(name) as any,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url!), {
        authProvider: createAuthProvider(name) as any,
      });
    }

    const client = new Client(
      { name: 'tide', version: app.getVersion() },
      // Tools are a core capability the Client always supports; no need to
      // declare them explicitly. (The SDK's ClientCapabilities type has no
      // top-level `tools` field — tool listing is built-in.)
      { capabilities: {} },
    );

    // Keep the transport on the connection so the OAuth callback can call
    // finishAuth(code) on THIS transport (a fresh one can't complete the
    // exchange — it lacks the in-flight PKCE verifier + discovery state).
    const conn0 = pool.get(name);
    if (conn0) conn0.transport = transport;

    await client.connect(transport);

    const { tools } = await client.listTools();
    const mcpTools: McpTool[] = (tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));

    const conn = pool.get(name)!;
    conn.client = client;
    conn.status = 'connected';
    conn.tools = mcpTools;
    conn.error = undefined;
    conn.restartCount = 0;

    log.info('connected', { name, scope, tools: mcpTools.length });
  } catch (e: any) {
    const conn = pool.get(name);
    const msg: string = e?.message ?? String(e);
    if (conn) {
      // The SDK's auth() returns 'REDIRECT' (after our deferred
      // redirectToAuthorization stashes the URL) and the transport then throws
      // Unauthorized. That's the "needs user sign-in" signal — surface a
      // needs_oauth state with an Authenticate button instead of an error.
      if (/^Unauthorized$/i.test(msg) || hasPendingAuthUrl(name)) {
        conn.status = 'needs_oauth';
        conn.error = undefined;
        log.info('awaiting user authentication', { name });
      } else {
        conn.status = 'error';
        // Translate cryptic SDK errors into actionable guidance.
        conn.error = explainConnectError(e, name);
        log.warn('connect failed', { name, error: msg });
      }
    } else {
      log.warn('connect failed (no conn)', { name, error: msg });
    }
  }
  notifyStatusChange();
}

async function disconnectConnection(conn: McpConnection): Promise<void> {
  try {
    if (conn.client) {
      await (conn.client as Client).close();
    }
  } catch {
    /* best-effort */
  }
  conn.status = 'disconnected';
  conn.tools = [];
}

/**
 * Turn a connect/auth failure into a clear, actionable error message.
 *
 * The MCP SDK's auth() surfaces low-level HTTP failures as opaque strings
 * (e.g. "HTTP 403: Invalid OAuth error response: ... Raw body: Forbidden").
 * Detect the common, meaningful cases and reword them so the user
 * understands the cause instead of seeing SDK internals.
 */
function explainConnectError(e: any, name: string): string {
  const raw: string = e?.message ?? String(e);

  // 403 / "Forbidden" during the OAuth flow → the server rejected our client
  // registration or authorization request. Most often this means the server
  // does NOT support dynamic client registration and requires a
  // pre-registered / allowlisted client (e.g. Figma's remote MCP server).
  if (/HTTP 403|Forbidden/i.test(raw) && /oauth|register|client|auth/i.test(raw)) {
    return (
      `"${name}" rejected the connection (HTTP 403). This server likely does not ` +
      'support dynamic client registration and requires a pre-registered OAuth ' +
      'client. Use a server that supports DCR, or provide a client_id/client_secret ' +
      'for this server.'
    );
  }

  // Server explicitly advertises no DCR support.
  if (/does not support dynamic client registration/i.test(raw)) {
    return (
      `"${name}" does not support dynamic client registration (DCR). It must be ` +
      'pre-registered with the server before it can connect.'
    );
  }

  // Missing PKCE verifier (auth flow interrupted / cleared mid-flow).
  if (/No stored PKCE code verifier/i.test(raw)) {
    return (
      `Authorization for "${name}" was interrupted. Re-initialize to restart the ` +
      'sign-in flow.'
    );
  }

  // Fall through with the raw message for anything unrecognized — better to
  // show the underlying detail than hide it.
  return raw;
}

export async function disconnectAll(): Promise<void> {
  const userCount = userConnections.size;
  const wsCount = [...workspaceConnections.values()].reduce((n, m) => n + m.size, 0);
  log.info('disconnect all', { userServers: userCount, workspaceServers: wsCount });
  for (const conn of userConnections.values()) await disconnectConnection(conn);
  userConnections.clear();
  for (const wsPool of workspaceConnections.values()) {
    for (const conn of wsPool.values()) await disconnectConnection(conn);
    wsPool.clear();
  }
}

/**
 * Re-initialize ALL MCP servers — disconnect everything and reconnect from
 * the config files (user ~/.tide/mcp.json + the active workspace's
 * .mcp.json). This is the "reload" action for the MCP settings panel: it
 * picks up newly-added/removed/edited servers and re-runs every connection,
 * so a server that was failing (stale, misconfigured, or just added outside
 * the app) gets a fresh connect attempt.
 *
 * Reuses initUserServers() / activateWorkspace() so the reconnect path is
 * identical to app startup / workspace switch — no divergent logic.
 */
export async function reinitializeAll(
  activeWorkspace?: { id: string; root: string },
): Promise<void> {
  const userCount = userConnections.size;
  const wsCount = [...workspaceConnections.values()].reduce((n, m) => n + m.size, 0);
  log.info('reinitialize all', { userServers: userCount, workspaceServers: wsCount });
  await disconnectAll();
  await initUserServers();
  if (activeWorkspace) {
    await activateWorkspace(activeWorkspace.id, activeWorkspace.root);
  } else {
    notifyStatusChange();
  }
}

export function getToolsForWorkspace(
  workspaceId: string | undefined,
): Array<{
  namespacedName: string;
  serverName: string;
  tool: McpTool;
  client: unknown;
}> {
  const result: Array<{
    namespacedName: string;
    serverName: string;
    tool: McpTool;
    client: unknown;
  }> = [];
  for (const conn of userConnections.values()) {
    if (conn.status !== 'connected') continue;
    if (isServerDisabled(conn.name)) continue;
    for (const tool of conn.tools) {
      result.push({
        namespacedName: `mcp__${conn.name}__${tool.name}`,
        serverName: conn.name,
        tool,
        client: conn.client,
      });
    }
  }
  if (workspaceId) {
    const wsPool = workspaceConnections.get(workspaceId);
    if (wsPool) {
      for (const conn of wsPool.values()) {
        if (conn.status !== 'connected') continue;
        if (isServerDisabled(conn.name)) continue;
        for (const tool of conn.tools) {
          result.push({
            namespacedName: `mcp__${conn.name}__${tool.name}`,
            serverName: conn.name,
            tool,
            client: conn.client,
          });
        }
      }
    }
  }
  if (result.length > 0) {
    log.debug('tools for workspace', { workspaceId, count: result.length, servers: [...new Set(result.map((r) => r.serverName))] });
  }
  return result;
}

export function getStatusList(workspaceId?: string): McpServerStatus[] {
  const statuses: McpServerStatus[] = [];
  for (const conn of userConnections.values()) {
    statuses.push({
      name: conn.name,
      scope: 'user',
      config: conn.config,
      status: conn.status,
      toolCount: conn.tools.length,
      toolNames: conn.tools.map((t) => t.name),
      error: conn.error,
      transport: conn.config.type,
      enabled: !isServerDisabled(conn.name),
    });
  }
  if (workspaceId) {
    const wsPool = workspaceConnections.get(workspaceId);
    if (wsPool) {
      for (const conn of wsPool.values()) {
        statuses.push({
          name: conn.name,
          scope: 'project',
          config: conn.config,
          status: conn.status,
          toolCount: conn.tools.length,
          toolNames: conn.tools.map((t) => t.name),
          error: conn.error,
          transport: conn.config.type,
          enabled: !isServerDisabled(conn.name),
        });
      }
    }
  }
  return statuses;
}

export async function retryServer(
  name: string,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (!conn) return;
  await connectServer(name, conn.config, scope, workspaceId);
}

/**
 * User-initiated OAuth sign-in: opens the browser at the authorization URL the
 * deferred flow stashed, then the `tide://oauth/callback` round-trip completes
 * the token exchange inside the SDK. After the browser opens, we re-run
 * connectServer — which now has stored tokens (once the user authorizes) and
 * will connect, or will return to needs_oauth if the user cancels.
 *
 * MUST be triggered by an explicit user action (the "Authenticate" button) —
 * never during init/reload, per the product requirement.
 */
export async function authenticateServer(
  name: string,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (!conn) {
    log.warn('authenticate: unknown server', { name });
    return;
  }
  const url = consumePendingAuthUrl(name);
  if (url) {
    const { shell } = await import('electron');
    log.info('opening browser for oauth (user-initiated)', { server: name, url: url.origin });
    await shell.openExternal(url.toString());
    // Mark connecting while the user completes sign-in in the browser.
    // Do NOT re-run connectServer here — the ORIGINAL transport from init is
    // still alive and waiting; the OAuth callback will call finishAuth(code)
    // on it via completeOAuthCallback(). Creating a fresh transport would
    // orphan the in-flight PKCE verifier.
    conn.status = 'connecting';
    conn.error = undefined;
    notifyStatusChange();
  } else {
    // No stashed URL (e.g. tokens expired after a prior success) — re-run the
    // full connect, which will re-trigger discovery + a new auth flow.
    log.info('authenticate: no pending URL, re-running connect', { server: name });
    await connectServer(name, conn.config, scope, workspaceId);
  }
}

/**
 * Complete the OAuth flow from the `tide://oauth/callback` redirect.
 *
 * The SDK transport that started the flow is still alive (kept on the
 * connection); call its `finishAuth(code)` to exchange the authorization
 * code for tokens, then reconnect. This MUST run on the ORIGINAL transport —
 * a fresh one can't complete the exchange (no PKCE verifier / discovery state).
 *
 * `state` is currently unused for routing (the SDK doesn't always set it),
 * but accepted for forward-compat. We match the flow to the single server
 * that's `needs_oauth` / connecting with a pending auth.
 */
export async function completeOAuthCallback(code: string, _state?: string): Promise<void> {
  if (!code) {
    log.warn('oauth callback: no code');
    return;
  }
  // Find the connection awaiting auth: status needs_oauth, or connecting with
  // a stored transport. Search user servers first, then all workspace pools.
  const findPending = (): { conn: McpConnection; scope: 'user' | 'project'; workspaceId?: string } | undefined => {
    for (const conn of userConnections.values()) {
      if (conn.status === 'needs_oauth' || (conn.status === 'connecting' && conn.transport)) {
        return { conn, scope: 'user' };
      }
    }
    for (const [wsId, wsPool] of workspaceConnections) {
      for (const conn of wsPool.values()) {
        if (conn.status === 'needs_oauth' || (conn.status === 'connecting' && conn.transport)) {
          return { conn, scope: 'project', workspaceId: wsId };
        }
      }
    }
    return undefined;
  };

  const pending = findPending();
  if (!pending) {
    log.warn('oauth callback: no pending auth flow to complete', { state: _state });
    return;
  }
  const { conn, scope, workspaceId } = pending;
  const transport = conn.transport as { finishAuth?: (code: string) => Promise<void> } | undefined;
  if (!transport?.finishAuth) {
    log.warn('oauth callback: pending connection has no transport.finishAuth', { name: conn.name });
    return;
  }
  log.info('oauth callback: completing auth', { server: conn.name });
  try {
    await transport.finishAuth(code);
    // finishAuth exchanged the code for tokens (now persisted). Reconnect with
    // a fresh transport — it will read the stored tokens and connect cleanly.
    await connectServer(conn.name, conn.config, scope, workspaceId);
  } catch (e: any) {
    log.warn('oauth callback: finishAuth failed', { server: conn.name, error: e?.message ?? String(e) });
    conn.status = 'error';
    conn.error = explainConnectError(e, conn.name);
    notifyStatusChange();
  }
}

export async function approveAndConnect(
  name: string,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  approveServer(name);
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (conn) await connectServer(name, conn.config, scope, workspaceId);
}

/**
 * Load a newly-added (or updated) server into the pool.
 * Called by the IPC add/update handlers after writing the config file.
 * If the server is approved, connects immediately; otherwise marks
 * needs_approval so it shows up in the UI.
 */
export async function loadServer(
  name: string,
  config: McpServerConfig,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  // Remove existing connection if updating (disconnect first)
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  if (scope === 'project' && !workspaceConnections.has(workspaceId!)) {
    workspaceConnections.set(workspaceId!, pool);
  }
  const existing = pool.get(name);
  if (existing && existing.client) {
    try { await (existing.client as Client).close(); } catch { /* best-effort */ }
  }

  const approved = getApprovedServers();
  if (approved.includes(name)) {
    await connectServer(name, config, scope, workspaceId);
  } else {
    pool.set(name, {
      name, config, scope, workspaceId,
      status: 'needs_approval', tools: [], restartCount: 0,
    });
    log.info('server loaded (needs approval)', { name, scope });
    notifyStatusChange();
  }
}

/**
 * Remove a server from the pool (disconnect + delete).
 * Called by the IPC remove handler after deleting from config file.
 */
export async function unloadServer(
  name: string,
  scope: 'user' | 'project',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (conn) {
    await disconnectConnection(conn);
    pool.delete(name);
    log.info('server unloaded', { name, scope });
    notifyStatusChange();
  }
}

// Wire the OAuth callback bridge: when the OS hands us a `tide://oauth/callback`
// URL (via open-url / second-instance), oauth.handleOAuthCallback parses out
// the code and calls this completer → completeOAuthCallback finishes the flow
// on the transport that started it. Registered once at module load.
registerOAuthCompleter((code, state) => {
  completeOAuthCallback(code, state).catch((e) =>
    log.warn('oauth completer failed', { error: String(e) }),
  );
});
