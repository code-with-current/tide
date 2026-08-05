/** Tide's system prompt: base content lives in src/lib/prompts/system/*.md (concatenated at build time into _system-prompt-bundle.ts by build/promptMarkdownUtils.mjs); this module wraps it with dynamic context (environment, workspace, skills, RAG). Edit the .md files then re-run the bundler. */

import { BASE_SYSTEM_PROMPT } from './_system-prompt-bundle';
import { TOOL_LIST_MD } from './_tool-descriptions-bundle';
import { AGENT_LIST_MD } from './_agent-prompts-bundle';

export interface SystemPromptContext {
  /** Absolute path of the active workspace, if any. */
  workspacePath?: string;
  /** Detected git branch, if any. */
  gitBranch?: string;
  /** Friendly model alias shown to the user, e.g. "GPT-5.2". */
  modelAlias?: string;
  /** Compact workspace summary from getWorkspaceContext (package.json, README, tree). */
  workspaceContext?: string;
  /** Files the user referenced in this turn — already fetched into context. */
  referencedFiles?: string;
  /** When set, the session is running inside an isolated git worktree. */
  worktree?: { branch: string; baseBranch: string };
}

/** Build the system prompt for a turn. Context fields are optional; when absent the relevant clause is dropped rather than rendered with empty values. */
export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const env: string[] = [];
  if (ctx.workspacePath) env.push(`- Working directory: ${ctx.workspacePath}`);
  if (ctx.gitBranch) env.push(`- Git branch: ${ctx.gitBranch}`);
  if (ctx.modelAlias) env.push(`- Driving model: ${ctx.modelAlias}`);
  if (ctx.worktree) {
    env.push(`- Worktree: isolated on branch "${ctx.worktree.branch}" (branched from ${ctx.worktree.baseBranch}). Your edits do NOT touch the user's main checkout.`);
  }
  const envBlock = env.length ? `\n# Environment\n${env.join('\n')}\n` : '';

  const workspaceBlock = ctx.workspaceContext
    ? `\n# Workspace\nThis is the user's active workspace. Use this context to answer questions about the project. Do not assume facts about files beyond what is shown here.\n\n${ctx.workspaceContext}\n`
    : '';

  const filesBlock = ctx.referencedFiles
    ? `\n${ctx.referencedFiles}\n`
    : '';

  return `${BASE_SYSTEM_PROMPT}\n\n# Available tools\n${TOOL_LIST_MD}\n\n${AGENT_LIST_MD}${envBlock}${workspaceBlock}${filesBlock}`;
}
