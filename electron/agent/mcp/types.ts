/**
 * MCP server configuration types.
 *
 * The config shape matches what users paste from MCP server docs — a flat
 * map of server name → config object. The file IS the map (no mcpServers
 * wrapper). See the design doc for examples.
 */

/** Transport type discriminator. Always present in config. */
export type McpTransportType = 'stdio' | 'sse' | 'http';

/** A single server's configuration (one entry in the config map). */
export interface McpServerConfig {
  type: McpTransportType;

  // ── stdio fields (type === 'stdio') ──
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // ── remote fields (type === 'sse' | 'http') ──
  url?: string;

  // ── auth ──
  /** Set to 'oauth' for OAuth-protected remote servers. */
  auth?: 'oauth';
}

/** The full config file shape: server name → config. */
export type McpConfigFile = Record<string, McpServerConfig>;

/** Where a server config lives — determines connection lifecycle. */
export type McpScope = 'user' | 'project';

/** A discovered MCP tool from a connected server. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Connection state for a single server. */
export type McpConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'
  | 'needs_approval'
  | 'needs_credentials'
  | 'needs_oauth';

/** A live connection wrapper around an SDK Client. */
export interface McpConnection {
  name: string;
  config: McpServerConfig;
  scope: McpScope;
  workspaceId?: string;
  status: McpConnectionStatus;
  tools: McpTool[];
  error?: string;
  restartCount: number;
  /** The SDK client (typed loosely — imported lazily). */
  client?: unknown;
}

/** Status row for the management UI. */
export interface McpServerStatus {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
  transport: McpTransportType;
  /** Whether the user has enabled this server (toggled on). */
  enabled: boolean;
}
