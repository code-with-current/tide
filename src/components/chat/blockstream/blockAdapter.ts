/**
 * Adapter between the new ToolBlock shape and the existing OneCodeToolRow /
 * ToolCallCard components. Those components expect a `ToolCall` — this
 * synthesizes one from the block so we don't have to rewrite them.
 */

import type { ToolBlock, ToolCall } from '@/types';

export function toolBlockToToolCall(block: ToolBlock): ToolCall {
  return {
    id: block.toolCallId,
    messageId: '',    // not used by the renderer
    toolName: block.toolName,
    arguments: block.arguments,
    argPreview: block.argPreview,
    status: block.status,
    riskTier: block.riskTier,
    output: block.output,
    display: block.display,
    durationMs: block.durationMs,
    meta: block.meta,
    _partialInput: block.partialInput,
  };
}
