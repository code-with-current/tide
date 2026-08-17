/** Tide's system prompt: base content lives in src/lib/prompts/system/*.md (concatenated at build time into _system-prompt-bundle.ts by build/promptMarkdownUtils.mjs); this module wraps it with dynamic context (environment, workspace, skills, RAG). Edit the .md files then re-run the bundler. */

import { BASE_SYSTEM_PROMPT } from './_system-prompt-bundle';
import { TOOL_LIST_MD } from './_tool-descriptions-bundle';
import { AGENT_LIST_MD } from './_agent-prompts-bundle';
import type { EnvInfo, GitCommit, GitFileChange } from '@/lib/api/client';

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
  /** Host platform/shell from getEnvInfo — without it the model guesses shell
   *  dialect (sed -i vs sed -i '', quoting rules) and OS-specific commands. */
  envInfo?: EnvInfo;
  /** Git state captured at turn start — saves the model a `git status` probe
   *  and gives it a baseline to diff its own changes against. */
  gitSnapshot?: {
    branch: string | null;
    headCommit: string | null;
    status: GitFileChange[];
    log: GitCommit[];
  };
}

const STATUS_LETTER: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '??',
  renamed: 'R',
};

/** Render the turn-start git snapshot; empty when there's nothing to show
 *  (not a repo, or every field came back empty). */
function formatGitSnapshot(s: SystemPromptContext['gitSnapshot']): string {
  if (!s) return '';
  if (!s.branch && !s.headCommit && s.status.length === 0 && s.log.length === 0) return '';
  const lines: string[] = ['# Git state (at turn start)'];
  if (s.branch || s.headCommit) {
    lines.push(`- Branch: ${s.branch ?? 'unknown'}${s.headCommit ? ` @ ${s.headCommit.slice(0, 7)}` : ''}`);
  }
  if (s.status.length === 0) {
    lines.push('- Working tree: clean');
  } else {
    const counts = new Map<string, number>();
    for (const f of s.status) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
    const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
    lines.push(`- Working tree: ${summary}`);
    for (const f of s.status.slice(0, 10)) {
      // git porcelain convention: staged changes are uppercase, unstaged lowercase
      const letter = f.staged ? STATUS_LETTER[f.status] : STATUS_LETTER[f.status].toLowerCase();
      const diff = f.additions || f.deletions ? ` (+${f.additions} −${f.deletions})` : '';
      lines.push(`  - ${letter} ${f.path}${diff}`);
    }
    if (s.status.length > 10) lines.push(`  - … and ${s.status.length - 10} more`);
  }
  if (s.log.length > 0) {
    lines.push('- Recent commits:');
    for (const c of s.log.slice(0, 5)) {
      lines.push(`  - ${c.sha.slice(0, 7)} ${c.subject} — ${c.author}, ${String(c.date).slice(0, 10)}`);
    }
  }
  return `\n${lines.join('\n')}\n`;
}

/** Build the system prompt for a turn. Context fields are optional; when absent the relevant clause is dropped rather than rendered with empty values. */
export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const env: string[] = [];
  if (ctx.workspacePath) env.push(`- Working directory: ${ctx.workspacePath}`);
  if (ctx.gitBranch) env.push(`- Git branch: ${ctx.gitBranch}`);
  if (ctx.modelAlias) env.push(`- Driving model: ${ctx.modelAlias}`);
  env.push(`- Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  if (ctx.envInfo) {
    const parts = [ctx.envInfo.platform, ctx.envInfo.arch, ctx.envInfo.release].filter(Boolean);
    if (parts.length) env.push(`- Platform: ${parts.join(' ')}`);
    if (ctx.envInfo.shell) env.push(`- Shell (used by the bash tool): ${ctx.envInfo.shell}`);
  }
  if (ctx.worktree) {
    env.push(`- Worktree: isolated on branch "${ctx.worktree.branch}" (branched from ${ctx.worktree.baseBranch}). Your edits do NOT touch the user's main checkout.`);
  }
  const envBlock = env.length ? `\n# Environment\n${env.join('\n')}\n` : '';
  const gitBlock = formatGitSnapshot(ctx.gitSnapshot);

  const workspaceBlock = ctx.workspaceContext
    ? `\n# Workspace\nThis is the user's active workspace. Use this context to answer questions about the project. Do not assume facts about files beyond what is shown here.\n\n${ctx.workspaceContext}\n`
    : '';

  const filesBlock = ctx.referencedFiles
    ? `\n${ctx.referencedFiles}\n`
    : '';

  return `${BASE_SYSTEM_PROMPT}\n\n# Available tools\n${TOOL_LIST_MD}\n\n${AGENT_LIST_MD}${envBlock}${gitBlock}${workspaceBlock}${filesBlock}`;
}
