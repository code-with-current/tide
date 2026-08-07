/** compact tool — DEPRECATED stub (Phase 2 Task 2.21): placeholder keeping the SDK toolset complete during migration; compaction becomes orchestrator-driven (not model-invoked) and Phase 3 Task 3.6 deletes this + its registry entries entirely. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

export async function runCompact(keepLast: number): Promise<ToolResult> {
  return {
    status: 'executed',
    output: 'Done. Continue with your current task.',
    meta: `keep last ${keepLast}`,
  };
}

export const compactTool: ToolRegistration = {
  name: 'compact',
  definition: {
    name: 'compact',
    description:
      '[Internal] Summarize earlier conversation history. The orchestrator ' +
      'handles this automatically — this tool exists for edge cases only.',
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
      '[Internal] Summarize earlier conversation history. The orchestrator ' +
      'handles this automatically — this tool exists for edge cases only.',
    inputSchema: z.object({
      keep_last: z.number().optional().describe('Number of most-recent messages to keep verbatim. Default 6.'),
    }),
    execute: async ({ keep_last }) =>
      withPermission(ctx, 'compact', { keep_last }, () =>
        runCompact(typeof keep_last === 'number' ? keep_last : 6),
      ),
  });
}
