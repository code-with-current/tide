/** Adapter synthesizing a `ToolCall` from the new ToolBlock shape so existing ToolRow / ToolCallCard components don't need rewriting. */

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
    report: block.report,
    display: block.display,
    durationMs: block.durationMs,
    meta: block.meta,
    _partialInput: block.partialInput,
    parentToolCallId: block.parentToolCallId,
  };
}
