/**
 * Build AI SDK tool() objects from the MCP connection pool's tool cache.
 * Each discovered MCP tool becomes an AI SDK tool keyed as
 * `mcp__<server>__<tool>`.
 *
 * Schema handling: built-in Tide tools define their inputs with Zod (the
 * AI SDK's preferred schema type). MCP tools arrive at runtime as raw JSON
 * Schema (the MCP spec's `inputSchema` field) — converting arbitrary JSON
 * Schema to Zod dynamically is impractical and lossy. Instead we wrap each
 * schema with the AI SDK's `jsonSchema()` helper, which the SDK accepts as
 * an alternative input format and serializes into the function-declaration
 * payload sent to the model verbatim. This is the canonical path for tools
 * whose schema is discovered rather than hand-authored.
 *
 * The toolset is rebuilt on every turn (cheap — `getToolsForWorkspace`
 * walks the pool's in-memory maps). Live reconnects surface new tools on
 * the next turn automatically; no invalidation signal is needed here.
 *
 * Execution: each tool's `execute` forwards the model's args to the MCP
 * client's `callTool`, joins the response's text content blocks, and
 * returns `{ result }` (or `{ error }` if the server flagged an error or
 * the transport threw). Non-text content (images, resources) is ignored
 * for now — the renderer renders text only.
 */
import { tool, jsonSchema } from 'ai';
import { createLogger } from '../../logger';
import { getToolsForWorkspace } from './pool';

const log = createLogger('mcp/toolset');

/**
 * Sanitize an MCP tool's JSON Schema for the AI SDK.
 *
 * Strips $schema, $defs, and other meta-keys that some MCP servers include
 * but the AI SDK's tool serializer doesn't handle. Also ensures the schema
 * has a "type": "object" root (the SDK requires this for tool input).
 */
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
): Record<string, ReturnType<typeof tool>> {
  const discovered = getToolsForWorkspace(workspaceId);
  const tools: Record<string, ReturnType<typeof tool>> = {};

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
        try {
          const result = await mcpClient.callTool({
            name: mcpTool.name,
            arguments: args,
          });
          const textParts = (result.content ?? [])
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!);
          const output = textParts.join('\n');
          if (result.isError) {
            log.warn('tool error', { server: serverName, tool: mcpTool.name });
            return { status: 'failed' as const, output: output || 'MCP tool returned an error' };
          }
          log.debug('tool called', { server: serverName, tool: mcpTool.name, outputLen: output.length });
          return { status: 'executed' as const, output };
        } catch (e: any) {
          log.error('tool call failed', { server: serverName, tool: mcpTool.name, error: e?.message ?? String(e) });
          return { status: 'failed' as const, output: `MCP call failed: ${e?.message ?? e}` };
        }
      },
    });
  }

  return tools;
}
