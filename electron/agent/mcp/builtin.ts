/**
 * Built-in MCP servers — bundled with Tide, always present in every install.
 *
 * Mirrors the BUILTIN_AGENTS pattern (electron/agent/agents/registry.ts):
 * a hardcoded constant that's consumed by the pool at boot, surfaced in the
 * MCP settings UI, and gated by the extensions store's disabled-allowlist.
 *
 * Unlike user/project servers, built-ins:
 *   - Have no on-disk config file (they're code, not JSON)
 *   - Skip the approval gate (they're trusted)
 *   - Can't be removed or edited (only toggled on/off)
 *   - Are disabled by default (seeded into extensions.json on first run)
 *
 * To add a new built-in server, add an entry here. The pool's initBuiltinServers()
 * will pick it up automatically.
 */
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
  'tide-filesystem': {
    label: 'Filesystem',
    description: 'Read/write files anywhere on your system via the MCP filesystem server.',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/'],
    },
  },
};
