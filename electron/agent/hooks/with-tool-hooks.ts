/** withToolHooks: higher-order wrapper (applied in buildToolset) that intercepts a tool's `execute` to run PreToolUse hooks, then the tool+permission, then PostToolUse hooks. Pass-through (zero overhead) when no hooks are configured. */
import type { CoreTool } from 'ai';
import { runPreToolUseHooks, runPostToolUseHooks } from './tool-hooks.js';
import type { HookConfig } from './hook-config.js';
import type { ToolResult } from '../tools/types.js';

/** Wrap an SDK tool's execute with hook support; pass through unchanged when config is null or empty. */
export function withToolHooks<T extends CoreTool>(
  toolName: string,
  sdkTool: T,
  config: HookConfig | null,
  workspaceRoot: string,
): T {
  // No hooks configured → zero-overhead pass-through.
  if (!config || (config.preToolUse.length === 0 && config.postToolUse.length === 0)) {
    return sdkTool;
  }

  const originalExecute = sdkTool.execute;
  if (!originalExecute) return sdkTool;

  return {
    ...sdkTool,
    execute: async (args: Record<string, unknown>, ctx?: unknown) => {
      // ── 1. PreToolUse hooks ──
      const preResults = await runPreToolUseHooks(
        toolName,
        args,
        config,
        workspaceRoot,
      );

      // Check for denial
      const denied = preResults.find((r) => r.decision === 'deny');
      if (denied) {
        const result: ToolResult = {
          status: 'rejected',
          output: `Tool "${toolName}" was blocked by a PreToolUse hook: ${denied.reason ?? 'no reason given'}`,
        };
        return result;
      }

      // Check for 'ask' — hook wants the user to approve before running.
      // (handled after input modifications, below)

      // Apply input modifications (merge all updatedInput from hooks)
      let finalArgs = args;
      for (const r of preResults) {
        if (r.updatedInput) {
          finalArgs = { ...finalArgs, ...r.updatedInput };
        }
      }

      // Now handle 'ask' — attach the hook reason so the permission UI can
      // display why approval is requested. Falls through to the normal
      // permission gate (autonomy system shows the approval card).
      const ask = preResults.find((r) => r.decision === 'ask');
      if (ask) {
        const hookReason = ask.reason ?? 'A PreToolUse hook requested approval.';
        finalArgs = { ...finalArgs, _hookReason: hookReason };
      }

      // ── 2+3. Execute the tool (permission + actual work) ──
      const result = (await originalExecute(finalArgs, ctx)) as ToolResult;

      // ── 4. PostToolUse hooks ──
      const postResults = await runPostToolUseHooks(
        toolName,
        finalArgs,
        result,
        config,
        workspaceRoot,
      );

      // Apply output modifications
      let finalResult = result;
      for (const r of postResults) {
        if (r.updatedOutput) {
          finalResult = { ...finalResult, output: r.updatedOutput };
        }
      }

      return finalResult;
    },
  };
}
