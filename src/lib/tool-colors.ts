/** Shared tool → Tailwind text-color map, single source of truth for the old
 *  chat chips (tool-chips.tsx) and the timeline's tool-tint rows.
 *  Colors are keyed by Tide tool name; renderer-style aliases (task, todowrite,
 *  webfetch…) resolve to the same color so both UIs tint identically. */

export const TOOL_TEXT_COLOR: Record<string, string> = {
  read_file: 'text-sky-400',
  read_media_file: 'text-sky-400',
  glob: 'text-sky-400',
  grep: 'text-sky-400',
  memory: 'text-muted-foreground',
  edit_file: 'text-amber-400',
  multi_edit: 'text-amber-400',
  write_file: 'text-amber-400',
  notebook_edit: 'text-amber-400',
  bash: 'text-green-400',
  bash_output: 'text-green-400',
  kill_shell: 'text-green-400',
  git: 'text-orange-400',
  dispatch_agent: 'text-purple-400',
  todo_write: 'text-blue-400',
  web_fetch: 'text-cyan-400',
  web_search: 'text-cyan-400',
  load_skill: 'text-violet-400',
  ask_followup_question: 'text-warning',
  exit_plan_mode: 'text-teal-400',
  compact: 'text-slate-400',
  mcp: 'text-indigo-400',
};

// timeline renderer keys (tool-renderers.tsx TIDE_TOOL_ALIASES + edit family)
const RENDERER_ALIASES: Record<string, string> = {
  task: 'dispatch_agent',
  todowrite: 'todo_write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  question: 'ask_followup_question',
  skill: 'load_skill',
  edit: 'edit_file',
  multiedit: 'multi_edit',
  write: 'write_file',
};

export function toolTextColor(toolName: string | undefined | null): string | undefined {
  if (typeof toolName !== 'string') return undefined;
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) return undefined;
  const lastSegment = trimmed.includes('.')
    ? trimmed.split('.').filter(Boolean).pop() ?? trimmed
    : trimmed;
  return TOOL_TEXT_COLOR[lastSegment] ?? TOOL_TEXT_COLOR[RENDERER_ALIASES[lastSegment] ?? ''];
}
