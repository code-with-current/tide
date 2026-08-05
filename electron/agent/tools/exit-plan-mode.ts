/** exit_plan_mode tool: in plan mode (read-only), the model calls this to mark the plan complete and present it for user approval. Currently returns the plan as text (the user manually switches mode + sends "go"); IPC approval flow to be wired later. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult } from './types';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

/** Shared body — parameterized so both envelopes call it without drift. */
export async function runExitPlanMode(plan: string): Promise<ToolResult> {
  if (!plan) return { status: 'failed', output: 'Missing required arg: plan' };
  return {
    status: 'executed',
    output: 'Plan submitted. Waiting for user approval — if approved, switch to a write-enabled mode and proceed.',
    meta: 'plan ready',
    display: { kind: 'text', text: plan },
  };
}

export const exitPlanModeTool: ToolRegistration = {
  name: 'exit_plan_mode',
  definition: {
    name: 'exit_plan_mode',
    description:
      'Signal that planning is complete. Use ONLY when autonomyMode is "plan" (read-only) ' +
      'and you have produced a concrete, actionable plan. Present the plan as the `plan` ' +
      'argument. The user reviews it and decides whether to proceed. Do not call this in ' +
      'other modes — it\'s a no-op there.',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan in markdown. Include the steps, files affected, and risks.',
        },
      },
      required: ['plan'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 1_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) => runExitPlanMode(String(args.plan ?? '')),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────
// read_only + auto in every mode → withPermission is a functional no-op here
// but kept for architectural uniformity (every tool owns its gate).

export function createExitPlanModeTool(ctx: ToolContext) {
  return tool({
    description:
      'Signal that planning is complete. Use ONLY when autonomyMode is "plan" (read-only) ' +
      'and you have produced a concrete, actionable plan. Present the plan as the `plan` ' +
      'argument. The user reviews it and decides whether to proceed. Do not call this in ' +
      'other modes — it\'s a no-op there.',
    inputSchema: z.object({
      plan: z.string().describe('The complete plan in markdown. Include the steps, files affected, and risks.'),
    }),
    execute: async ({ plan }) =>
      withPermission(ctx, 'exit_plan_mode', { plan }, () => runExitPlanMode(plan)),
  });
}
