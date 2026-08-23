/** Label for the permission card's "Allow (…)" session-rule action — derives
 *  the rule spec main will register (mirrors deriveRuleSpec in
 *  electron/agent/permissions/rules.ts) and renders it as a short glob the
 *  user can read at a glance. Falls back to deriving client-side from the
 *  call's own args when the event carried no allowRule (sub-agent asks,
 *  older events). */

import type { ToolCall } from '@/types';

type CallLike = Pick<ToolCall, 'toolName' | 'argPreview' | 'arguments'> & {
  allowRule?: string;
};

function headToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? '';
}

/** Client-side mirror of main's deriveRuleSpec for the display path. */
export function deriveAllowRule(call: CallLike): string {
  if (call.allowRule) return call.allowRule;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const preview = call.argPreview?.trim() ?? '';
  switch (call.toolName) {
    case 'bash': {
      const cmd = typeof args.command === 'string' ? args.command : preview;
      const head = headToken(cmd);
      return head ? `bash(${head})` : 'bash';
    }
    case 'git': {
      const sub = Array.isArray(args.args) ? String(args.args[0] ?? '') : headToken(preview);
      return sub ? `git(${sub})` : 'git';
    }
    default: {
      if (preview.includes('/')) {
        const dir = preview.substring(0, preview.lastIndexOf('/'));
        return `${call.toolName}(${dir}/*)`;
      }
      return preview ? `${call.toolName}(${headToken(preview)})` : call.toolName;
    }
  }
}

/** Render a rule spec as the compact menu label: `bash(cat)` → "cat *",
 *  `bash(npx cowsay:*)` → "npx cowsay:*", `git(push)` → "git push *". */
export function allowRuleLabel(call: CallLike): string {
  const rule = deriveAllowRule(call);
  const m = rule.match(/^([a-z_]+)\((.*)\)$/i);
  if (!m) {
    // Bare tool rule ("bash", "git") — any invocation of the tool.
    return `${rule} *`;
  }
  const [, tool, spec] = m;
  if (tool === 'git') {
    // Keep the tool verb: "git push *" reads as the command it is.
    return spec ? `git ${headToken(spec)} *` : 'git *';
  }
  // Already a glob (":*" suffix or "*" inside) — verbatim; else append " *".
  return /[*:]/.test(spec) ? spec : `${spec} *`;
}
