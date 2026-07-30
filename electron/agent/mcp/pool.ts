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
      transport = new SSEClientTransport(new URL(config.url!));
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url!));
    }

    const client = new Client(
      { name: 'tide', version: app.getVersion() },
      // Tools are a core capability the Client always supports; no need to
      // declare them explicitly. (The SDK's ClientCapabilities type has no
      // top-level `tools` field — tool listing is built-in.)
      { capabilities: {} },
    );

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
    if (conn) {
      conn.status = 'error';
      conn.error = e?.message ?? String(e);
    }
    log.warn('connect failed', { name, error: e?.message ?? String(e) });
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
