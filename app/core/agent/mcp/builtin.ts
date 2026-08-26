/** Built-in MCP servers (always present; mirror the BUILTIN_AGENTS pattern). Unlike user/project servers: code-not-JSON, skip the approval gate, only toggleable (not removable), disabled by default. Add an entry here and the pool's initBuiltinServers picks it up. */
import type { McpServerConfig } from './types';

export interface BuiltinMcpServer {
  /** Human-readable label for the settings UI. */
  label: string;
  /** Short description shown under the server name. */
  description: string;
  /** The MCP server config (transport + command/args/url). */
  config: McpServerConfig;
}

export const BUILTIN_MCP_SERVERS: Record<string, BuiltinMcpServer> = {
  // tide-filesystem removed — replaced by native built-in tools:
  // directory_tree, read_media_file (plus existing read_file, write_file,
  // edit_file, list_dir, glob, grep). No MCP overhead, no npx spawn.
};
