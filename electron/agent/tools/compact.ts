/** compact tool — DEPRECATED stub (Phase 2 Task 2.21): placeholder keeping the SDK toolset complete during migration; compaction becomes orchestrator-driven (not model-invoked) and Phase 3 Task 3.6 deletes this + its registry entries entirely. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

export async function runCompact(keepLast: number): Promise<ToolResult> {
  return {
    status: 'executed',
    output:
      `Compaction requested. Keep the last ${keepLast} messages verbatim; summarize earlier ` +
      `history into a concise "Prior context:" block at the top of your next response. Focus ` +
      `the summary on decisions made, files touched, and outstanding todos — not on prose. ` +
      `Do NOT re-explain what is still in the visible window.`,
    meta: `keep last ${keepLast}`,
  };
}

export const compactTool: ToolRegistration = {
  name: 'compact',
  definition: {
    name: 'compact',
    description:
      'Signal that the conversation should be compacted (older messages summarized) to ' +
      'free context budget. Call this when you notice the context window is filling up ' +
      '(>70% used). Returns guidance for self-summarization. The orchestrator may apply ' +
      'automatic compaction; this tool is the manual escape hatch.',
    input_schema: {
      type: 'object',
      properties: {
        keep_last: {
          type: 'number',
          description: 'Number of most-recent messages to keep verbatim. Older ones get summarized. Default 6.',
        },
      },
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 1_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) => runCompact(typeof args.keep_last === 'number' ? args.keep_last : 6),
};

// ─── SDK factory (deprecation stub — deleted in Phase 3 Task 3.6) ──────

export function createCompactTool(ctx: ToolContext) {
  return tool({
    description:
      '[Deprecated — compaction is now automatic.] Signal that the conversation should be ' +
      'compacted to free context budget. Returns self-summarization guidance.',
    inputSchema: z.object({
      keep_last: z.number().optional().describe('Number of most-recent messages to keep verbatim. Default 6.'),
    }),
    execute: async ({ keep_last }) =>
      withPermission(ctx, 'compact', { keep_last }, () =>
        runCompact(typeof keep_last === 'number' ? keep_last : 6),
      ),
  });
}
