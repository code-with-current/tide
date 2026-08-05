/** withPermission: wraps a tool's execute body with the autonomy gate (checkPermission from permission.ts). On 'ask'/'blocked' it emits a permission request to the renderer and awaits the verdict; plan-mode escalation mutates the shared ctx.autonomyMode for the rest of the turn. */

import { checkPermission } from './permission.js';
import { getToolMeta } from './tools/tool-meta.js';
import { waitForPermissionResolve, storePendingAsk } from './permission-resolver.js';
import { evaluateRules, getSessionRules, loadPermissionRules, type RuleSet } from './permissions/rules.js';
import { currentToolCallId } from './tools/tool-call-context.js';
import { createLogger } from '../logger.js';
import type { ToolContext } from './tools/tool-context.js';
import type { AutonomyMode, ToolName } from '../../src/types';

const log = createLogger('permission');

export type PermissionResult<T> =
  | T
  | { status: 'rejected'; output: string };

export async function withPermission<T>(
  ctx: ToolContext,
  toolName: ToolName,
  args: unknown,
  run: () => Promise<T>,
): Promise<PermissionResult<T>> {
  const meta = getToolMeta(toolName);
  const argsObj = (args ?? {}) as Record<string, unknown>;

  // Rule-based gate: merge file rules (.agent/settings.json, re-read fresh)
  // with session rules (in-memory, added via "Always Allow" during this turn).
  // Deny wins; allow upgrades 'ask' to auto (does NOT bypass plan-mode 'blocked').
  const fileRules = loadPermissionRules(ctx.workspaceRoot);
  const sessionRls = getSessionRules(ctx.sessionId);
  // Merge: session rules + file rules. Session rules take precedence (added this turn).
  const mergedRules: RuleSet = {
    allow: [...sessionRls.allow, ...fileRules.allow],
    deny: [...sessionRls.deny, ...fileRules.deny],
  };
  const ruleDecision = evaluateRules(mergedRules, toolName, argsObj);
  if (ruleDecision === 'deny') {
    log.warn('denied by rule', { tool: toolName, mode: ctx.autonomyMode });
    return { status: 'rejected', output: 'Denied by permission rule (.agent/settings.json or session).' };
  }

  const decision = checkPermission(meta.riskTier, ctx.autonomyMode);

  if (decision === 'auto') {
    log.debug('auto-approved', { tool: toolName, mode: ctx.autonomyMode });
    return run();
  }
  // An allow rule turns an 'ask' into an auto-run. It does NOT touch 'blocked'
  // (plan mode) — that still surfaces the blocked card for explicit escalation.
  if (decision === 'ask' && ruleDecision === 'allow') {
    log.debug('auto-approved by rule', { tool: toolName, mode: ctx.autonomyMode });
    return run();
  }

  // Real toolCallId (threaded via AsyncLocalStorage in buildToolset) keys the card per-call and renders inline on its tool block; falls back to a synthesized id only if context isn't set. No serialization: parallel asks in the same step each await their own verdict independently.
  const toolCallId = currentToolCallId() ?? `perm_${toolName}_${Date.now().toString(36)}`;
  // Remember the ask so the approve handler can derive an "always allow" rule
  // when the user picks "Always allow — session/project" on the card.
  storePendingAsk(ctx.sessionId, toolCallId, toolName, argsObj, ctx.workspaceRoot);
  log.info('asking user', { tool: toolName, mode: ctx.autonomyMode, tier: meta.riskTier, toolCallId });
  ctx.emit({ type: 'permission', toolCallId, toolName, args, decision });
  const verdict = await waitForPermissionResolve(ctx.sessionId, toolCallId);

  // Escalation sticks for the rest of the turn.
  if (verdict.newMode) {
    (ctx.autonomyMode as AutonomyMode) = verdict.newMode;
    log.warn('escalated', { tool: toolName, from: ctx.autonomyMode, to: verdict.newMode });
  }

  if (!verdict.approved) {
    log.info('denied by user', { tool: toolName, reason: verdict.reason });
    return {
      status: 'rejected' as const,
      output: verdict.reason ? `User denied: ${verdict.reason}` : 'User denied.',
    };
  }

  log.info('approved by user', { tool: toolName });
  return run();
}
