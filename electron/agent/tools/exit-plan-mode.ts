/**
 * exit_plan_mode tool — signal that planning is done and ready for review.
 *
 * When autonomyMode === 'plan', the model is restricted to read-only tools
 * and should produce a plan, not execute. It calls this tool to mark the
 * plan complete and present it for user approval. The renderer can render
 * an approval prompt; if approved, the user can switch to 'ask'/'edit' mode
 * and re-run with the plan as context.
 *
 * For now, this tool just returns the plan as text — the approval gate is
 * manual (user reads the plan, switches mode, sends "go"). Wire the IPC
 * approval flow later.
 */

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
