/** MCP connection pool — module-scoped singleton owning all server connections. User servers are app-lifetime; project servers are workspace-lifetime. */
import { app } from 'electron';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../../logger';
import { readMcpConfig } from './config';
import { resolveSecrets, resolveArgsSecrets } from './secrets';
// Approval system removed — all servers auto-connect when enabled.
// The approvals.ts module is kept for back-compat (existing data in
// extensions.json) but no longer gates connections.
import { createAuthProvider, consumePendingAuthUrl, hasPendingAuthUrl, registerOAuthCompleter } from './oauth';
import { createExtensionsStore } from '../../extensionsStore';
import type {
  McpConnection,
  McpTool,
  McpServerConfig,
  McpServerStatus,
} from './types';
import { BUILTIN_MCP_SERVERS } from './builtin';
import { appDataDir } from '../../appPaths.js';

const log = createLogger('mcp');

const userConnections = new Map<string, McpConnection>();
const workspaceConnections = new Map<string, Map<string, McpConnection>>();
const builtinConnections = new Map<string, McpConnection>();

/** Check if a server name is disabled in the extensions store. */
function isServerDisabled(name: string): boolean {
  try {
    const extStore = createExtensionsStore(appDataDir());
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
  return path.join(appDataDir(), 'mcp.json');
}

function projectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mcp.json');
}

export async function initUserServers(): Promise<void> {
  const config = readMcpConfig(userConfigPath());
  log.info('init user servers', { total: Object.keys(config).length });
  for (const [name, serverConfig] of Object.entries(config)) {
    await connectServer(name, serverConfig, 'user');
  }
  notifyStatusChange();
}

/** Initialize built-in MCP servers at app boot. Built-ins skip the approval gate: connected if enabled, stubbed disconnected if disabled (default). */
export async function initBuiltinServers(): Promise<void> {
  log.info('init builtin servers', { count: Object.keys(BUILTIN_MCP_SERVERS).length });
  for (const [name, entry] of Object.entries(BUILTIN_MCP_SERVERS)) {
    if (isServerDisabled(name)) {
      builtinConnections.set(name, {
        name,
        config: entry.config,
        scope: 'builtin',
        status: 'disconnected',
        tools: [],
        restartCount: 0,
      });
      continue;
    }
    await connectServer(name, entry.config, 'builtin');
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
  let wsPool = workspaceConnections.get(workspaceId);
  if (!wsPool) {
    wsPool = new Map();
    workspaceConnections.set(workspaceId, wsPool);
  }

  for (const [name, serverConfig] of Object.entries(config)) {
    await connectServer(name, serverConfig, 'project', workspaceId);
  }
  notifyStatusChange();
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  scope: 'user' | 'project' | 'builtin',
  workspaceId?: string,
): Promise<void> {
  log.info('connecting', { name, scope, transport: config.type });
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
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
    // Infer type if missing: command → stdio, url → http.
    const transportType = config.type
      ?? (config.command ? 'stdio'
      : config.url ? 'http'
      : 'stdio') as McpTransportType;

    if (transportType === 'stdio') {
      // ── Platform-aware shell resolution ──────────────────────────────
      // macOS/Linux GUI apps inherit a minimal PATH; spawning through the user's login shell resolves version-manager (nvm/fnm/asdf/mise) paths. Windows cmd.exe /c respects system+user PATH.
      const stdioEnv = { ...process.env, ...resolvedEnv } as Record<string, string>;
      const rawArgs = resolvedArgs ?? config.args ?? [];
      const fullCommand = `${config.command!} ${rawArgs.join(' ')}`;

      if (process.platform === 'win32') {
        transport = new StdioClientTransport({
          command: 'cmd.exe',
          args: ['/c', fullCommand],
          env: stdioEnv,
          stderr: 'pipe',
        });
      } else {
        // Login shell (-l) sources ~/.zprofile + ~/.zshrc (or bash equiv),
        // resolving nvm/fnm/asdf/mise paths. Falls back to /bin/sh.
        transport = new StdioClientTransport({
          command: process.env.SHELL || '/bin/sh',
          args: ['-l', '-c', fullCommand],
          env: stdioEnv,
          stderr: 'pipe',
        });
      }

      // ── Lifecycle logging — capture stderr + exit code ───────────────
      const stdioTransport = transport as StdioClientTransport & {
        _process?: { stderr?: NodeJS.ReadableStream; on?: (e: string, cb: (...a: any[]) => void) => void; kill?: (sig?: string) => void };
      };
      // stderr — surface server-side errors/diagnostics in Tide's log.
      if (stdioTransport._process?.stderr) {
        stdioTransport._process.stderr.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().trim();
          if (lines) log.warn('MCP stderr', { server: name, output: lines.slice(0, 500) });
        });
      }
      // exit — log exit code/signal for crash diagnostics + trigger recovery.
      stdioTransport._process?.on?.('exit', (code: number | null, signal: string | null) => {
        log.info('MCP process exit', { server: name, code, signal });
      });
    } else if (transportType === 'sse') {
      transport = new SSEClientTransport(new URL(config.url!), {
        authProvider: createAuthProvider(name) as any,
        requestInit: config.headers
          ? { headers: config.headers as Record<string, string> }
          : undefined,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url!), {
        authProvider: createAuthProvider(name) as any,
        requestInit: config.headers
          ? { headers: config.headers as Record<string, string> }
          : undefined,
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

    // ── Connect timeout — fail fast if the server doesn't respond ──────
    // stdio servers need more time: login shell startup (.zshrc → nvm/conda)
    // + npx download/cache + process spawn. Remote servers connect faster.
    const isStdio = transportType === 'stdio';
    const CONNECT_TIMEOUT_MS = isStdio ? 30_000 : 10_000;
    const timeoutId = setTimeout(() => {
      log.warn('MCP connect timeout', { name, timeout: CONNECT_TIMEOUT_MS });
      // Kill the subprocess if it's stdio — don't let it linger.
      const t = transport as any;
      t?._process?.kill?.('SIGTERM');
    }, CONNECT_TIMEOUT_MS);

    try {
      await client.connect(transport);
    } finally {
      clearTimeout(timeoutId);
    }
    log.info('transport connected', { name, scope, transport: config.type });

    const { tools } = await client.listTools();
    const toolNames = (tools ?? []).map((t: any) => t.name);
    log.info('tools discovered', { name, scope, count: toolNames.length, tools: toolNames });
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

    // ── Crash recovery — auto-restart on unexpected subprocess exit ────
    // Listen for the transport's onclose callback. If the server was
    // connected (not intentionally disconnected), auto-restart with
    // exponential backoff (2s → 4s → 8s, max 3 attempts).
    const MAX_RESTARTS = 3;
    (transport as any).onclose = () => {
      const c = pool.get(name);
      if (!c || c.status !== 'connected') return; // intentional disconnect
      if (c.restartCount >= MAX_RESTARTS) {
        c.status = 'error';
        c.error = `Server crashed ${MAX_RESTARTS}× — check its configuration.`;
        log.warn('MCP crash recovery exhausted', { name, restarts: MAX_RESTARTS });
        notifyStatusChange();
        return;
      }
      c.restartCount++;
      c.status = 'connecting';
      const delay = Math.min(2000 * 2 ** (c.restartCount - 1), 8000);
      log.info('MCP crash recovery', { name, attempt: c.restartCount, delayMs: delay });
      notifyStatusChange();
      setTimeout(() => {
        connectServer(name, config, scope, workspaceId).catch((e) =>
          log.warn('MCP restart failed', { name, err: e?.message ?? String(e) }),
        );
      }, delay);
    };

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
  // Set status BEFORE closing so the transport's onclose callback sees
  // 'disconnected' and doesn't trigger crash recovery.
  conn.status = 'disconnected';
  conn.tools = [];
  try {
    if (conn.client) {
      await (conn.client as Client).close();
    }
  } catch {
    /* best-effort */
  }
}

/** Turn a connect/auth failure into an actionable message — rewording the SDK's opaque error strings (e.g. 403/no-DCR/PKCE cases) so the user understands the cause. */
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
  const builtinCount = builtinConnections.size;
  log.info('disconnect all', { userServers: userCount, workspaceServers: wsCount, builtinServers: builtinCount });
  for (const conn of userConnections.values()) await disconnectConnection(conn);
  userConnections.clear();
  for (const conn of builtinConnections.values()) await disconnectConnection(conn);
  builtinConnections.clear();
  for (const wsPool of workspaceConnections.values()) {
    for (const conn of wsPool.values()) await disconnectConnection(conn);
    wsPool.clear();
  }
}

/** Re-initialize ALL MCP servers from config files (the MCP panel "reload" action): picks up added/removed/edited servers and re-runs every connection, reusing initUserServers()/activateWorkspace() so the path matches startup. */
export async function reinitializeAll(
  activeWorkspace?: { id: string; root: string },
): Promise<void> {
  const userCount = userConnections.size;
  const wsCount = [...workspaceConnections.values()].reduce((n, m) => n + m.size, 0);
  log.info('reinitialize all', { userServers: userCount, workspaceServers: wsCount });
  // Disconnect + reconnect user and project servers only. Built-in servers
  // are not affected — they have no on-disk config to reload.
  for (const conn of userConnections.values()) await disconnectConnection(conn);
  userConnections.clear();
  for (const wsPool of workspaceConnections.values()) {
    for (const conn of wsPool.values()) await disconnectConnection(conn);
    wsPool.clear();
  }
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
  // Built-in servers — same iteration as user servers.
  for (const conn of builtinConnections.values()) {
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
  // Built-in servers.
  for (const conn of builtinConnections.values()) {
    statuses.push({
      name: conn.name,
      scope: 'builtin',
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
  scope: 'user' | 'project' | 'builtin',
  workspaceRoot?: string,
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
        : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (!conn) return;

  // Re-read the config from disk so external edits (changed args, env, etc.)
  // are picked up on retry — not the stale cached config from the old connection.
  let config = conn.config;
  if (scope === 'builtin') {
    const builtin = BUILTIN_MCP_SERVERS[name];
    if (builtin) config = builtin.config;
  } else if (scope === 'user') {
    const diskConfig = readMcpConfig(userConfigPath());
    if (diskConfig[name]) config = diskConfig[name];
  } else if (workspaceRoot) {
    const diskConfig = readMcpConfig(projectConfigPath(workspaceRoot));
    if (diskConfig[name]) config = diskConfig[name];
  }

  await connectServer(name, config, scope, workspaceId);
}

/** Re-fetch the tool list from a connected MCP server (some servers add/remove tools at runtime). Returns the updated tool count, or -1 if not connected. */
export async function refreshServerTools(
  serverName: string,
  workspaceId?: string,
): Promise<number> {
  // Search all pools for this server.
  const pools: Map<string, McpConnection>[] = [userConnections, builtinConnections];
  if (workspaceId) {
    const wsPool = workspaceConnections.get(workspaceId);
    if (wsPool) pools.push(wsPool);
  }
  for (const pool of pools) {
    const conn = pool.get(serverName);
    if (conn && conn.status === 'connected' && conn.client) {
      try {
        const client = conn.client as Client;
        const { tools } = await client.listTools();
        conn.tools = (tools ?? []).map((t: any) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        }));
        const newToolNames = conn.tools.map((t) => t.name);
        log.info('tools refreshed', { name: serverName, tools: conn.tools.length, toolNames: newToolNames });
        notifyStatusChange();
        return conn.tools.length;
      } catch (e: any) {
        log.warn('tool refresh failed', { name: serverName, err: e?.message ?? String(e) });
        return -1;
      }
    }
  }
  return -1;
}

/** User-initiated OAuth sign-in: opens the browser at the stashed authorization URL, then the `tide://oauth/callback` round-trip completes the exchange. MUST be triggered by the "Authenticate" button — never during init/reload. */
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
    // Mark connecting while the user completes sign-in. Do NOT re-run connectServer — the original transport is still alive waiting for the OAuth callback (finishAuth via completeOAuthCallback); a fresh transport would orphan the in-flight PKCE verifier.
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

/** Complete the OAuth flow from the `tide://oauth/callback` redirect: call finishAuth(code) on the ORIGINAL transport (kept on the connection — a fresh one lacks the PKCE verifier), then reconnect. */
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

/** Connect a server previously in needs_approval state. Approval gate is removed — now a direct connect, kept for IPC back-compat. */
export async function approveAndConnect(
  name: string,
  scope: 'user' | 'project' | 'builtin',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
        : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (conn) await connectServer(name, conn.config, scope, workspaceId);
}

/** Load a newly-added (or updated) server into the pool. Called by IPC add/update handlers after the config write; all servers auto-connect (no approval gate). */
export async function loadServer(
  name: string,
  config: McpServerConfig,
  scope: 'user' | 'project' | 'builtin',
  workspaceId?: string,
): Promise<void> {
  // Remove existing connection if updating (disconnect first)
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
        : (workspaceConnections.get(workspaceId!) ?? new Map());
  if (scope === 'project' && !workspaceConnections.has(workspaceId!)) {
    workspaceConnections.set(workspaceId!, pool);
  }
  const existing = pool.get(name);
  if (existing && existing.client) {
    try { await (existing.client as Client).close(); } catch { /* best-effort */ }
  }

  // All servers auto-connect when loaded — no approval gate.
  await connectServer(name, config, scope, workspaceId);
}

/**
 * Remove a server from the pool (disconnect + delete).
 * Called by the IPC remove handler after deleting from config file.
 */
export async function unloadServer(
  name: string,
  scope: 'user' | 'project' | 'builtin',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
        : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (conn) {
    await disconnectConnection(conn);
    pool.delete(name);
    log.info('server unloaded', { name, scope });
    notifyStatusChange();
  }
}

/** Disconnect a server but KEEP it in the pool (greyed out) so the user can toggle it back on — contrast with unloadServer which fully removes the entry. */
export async function disableServer(
  name: string,
  scope: 'user' | 'project' | 'builtin',
  workspaceId?: string,
): Promise<void> {
  const pool =
    scope === 'user'
      ? userConnections
      : scope === 'builtin'
        ? builtinConnections
        : (workspaceConnections.get(workspaceId!) ?? new Map());
  const conn = pool.get(name);
  if (conn) {
    await disconnectConnection(conn);
    conn.status = 'disconnected';
    conn.tools = [];
    conn.error = undefined;
    log.info('server disabled', { name, scope });
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
