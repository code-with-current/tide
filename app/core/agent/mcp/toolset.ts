/** Build AI SDK `tool()` objects from the MCP pool's cache, keyed `mcp__<server>__<tool>`; MCP JSON Schemas are wrapped via `jsonSchema()` (the canonical path for discovered schemas), and execute forwards to the client's callTool, joining text blocks. */
import { tool, jsonSchema, type Tool } from 'ai';
import { createLogger } from '../../logger';
import { getToolsForWorkspace, refreshServerTools } from './pool';

const log = createLogger('mcp/toolset');

/** Sanitize an MCP tool's JSON Schema for the AI SDK: strip $schema/$defs/$comment meta-keys and ensure a `type: "object"` root. */
function sanitizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip JSON Schema meta-keys
    if (key === '$schema' || key === '$defs' || key === '$comment') continue;
    cleaned[key] = value;
  }
  // Ensure root type is object (AI SDK requirement for tool input schemas)
  if (!cleaned.type) cleaned.type = 'object';
  return cleaned;
}

export function mcpToolsetForWorkspace(
  workspaceId: string | undefined,
): Record<string, Tool<any, any>> {
  // Capture workspaceId for the post-execution tool refresh.
  const wsId = workspaceId;
  const discovered = getToolsForWorkspace(workspaceId);
  const tools: Record<string, Tool<any, any>> = {};

  if (discovered.length > 0) {
    log.info('toolset built', { count: discovered.length, workspaceId });
  }

  for (const entry of discovered) {
    const { namespacedName, serverName, tool: mcpTool, client } = entry;
    const mcpClient = client as {
      callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<{
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      }>;
    };

    // Sanitize the input schema — strip $schema/$defs, ensure type:object.
    const cleanSchema = sanitizeInputSchema(mcpTool.inputSchema);

    tools[namespacedName] = tool({
      description: `${serverName}: ${mcpTool.description}`,
      inputSchema: jsonSchema(cleanSchema),
      execute: async (args: Record<string, unknown>) => {
        const t0 = Date.now();
        log.info('▶ MCP call', {
          server: serverName,
          tool: mcpTool.name,
          namespaced: namespacedName,
          args,
        });
        try {
          const result = await mcpClient.callTool({
            name: mcpTool.name,
            arguments: args,
          });

          // Log the full raw response for debugging.
          const contentTypes = (result.content ?? []).map((c) => c.type);
          const textParts = (result.content ?? [])
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!);
          const output = textParts.join('\n');
          const durationMs = Date.now() - t0;

          log.info('◀ MCP result', {
            server: serverName,
            tool: mcpTool.name,
            durationMs,
            isError: result.isError ?? false,
            contentTypes,
            contentCount: result.content?.length ?? 0,
            outputLen: output.length,
            outputPreview: output.slice(0, 500),
          });

          if (result.isError) {
            log.warn('MCP tool error', { server: serverName, tool: mcpTool.name, output });
            return { status: 'failed' as const, output: output || 'MCP tool returned an error' };
          }

          // After execution, re-fetch the server's tool list. Some MCP servers
          // (e.g. vue-mcp's set_framework_preferences) dynamically add tools.
          refreshServerTools(serverName, wsId).catch(() => { /* best-effort */ });
          return { status: 'executed' as const, output };
        } catch (e: any) {
          const durationMs = Date.now() - t0;
          log.error('✕ MCP failed', {
            server: serverName,
            tool: mcpTool.name,
            durationMs,
            error: e?.message ?? String(e),
            stack: e?.stack,
          });
          return { status: 'failed' as const, output: `MCP call failed: ${e?.message ?? e}` };
        }
      },
    });
  }

  return tools;
}
