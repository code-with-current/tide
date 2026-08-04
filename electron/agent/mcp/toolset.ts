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
import { getToolsForWorkspace, refreshServerTools } from './pool';

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
  // Capture workspaceId for the post-execution tool refresh.
  const wsId = workspaceId;
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
