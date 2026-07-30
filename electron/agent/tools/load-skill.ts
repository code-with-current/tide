/**
 * load_skill tool — read and "execute" a skill by loading its SKILL.md.
 *
 * Purpose-built for skill invocation (vs. generic read_file). When the user
 * types `/skill-name`, the composer injects a directive telling the model to
 * call this tool with the skill's absolute path. The tool reads the file
 * (through read_file's logic + the skill-root allowlist), returns the full
 * body as instructions the model must follow, and surfaces a skill-specific
 * display card.
 *
 * "Execute" here = load the instructions so the model follows them. Skills in
 * Tide are prompt-based (SKILL.md), not executable code.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { runReadFile } from './read-file';

const DEFAULT_MAX_LINES = 2000;

/**
 * Shared body — reads the SKILL.md at the given path (absolute; may live
 * outside the workspace under ~/.claude/skills, which read_file's skill-root
 * exception allows). Extracts the skill name from the YAML frontmatter.
 */
export async function runLoadSkill(
  skillPath: string,
  workspaceRoot: string,
): Promise<ToolResult> {
  if (!skillPath) return { status: 'failed', output: 'Missing required arg: path' };

  const res = await runReadFile(skillPath, DEFAULT_MAX_LINES, workspaceRoot);
  if (res.status !== 'executed') {
    return { status: 'failed', output: `Failed to load skill at ${skillPath}: ${res.output}` };
  }

  const body = res.output;
  // Extract the skill name from frontmatter (name: xxx) for the card + meta.
  const nameMatch = body.match(/^---\s*\n[\s\S]*?^name:\s*(.+)/m);
  const name = nameMatch?.[1]?.trim().replace(/['"]/g, '') ?? skillPath.split('/').slice(-2, -1)[0] ?? 'skill';

  return {
    status: 'executed',
    output: `Skill "${name}" loaded (${body.length} chars). Read and follow its instructions before taking any other action on the task.`,
    meta: `${name} · ${body.length} chars`,
    display: { kind: 'file_loaded', path: skillPath, lines: body.split('\n').length, bytes: body.length, body },
  };
}

export const loadSkillTool: ToolRegistration = {
  name: 'load_skill',
  definition: {
    name: 'load_skill',
    description:
      'Load and activate a skill by reading its SKILL.md file. Call this when the user ' +
      'invokes a skill via /name, or when a skill matches the task. Returns the skill\'s ' +
      'full instructions — read and follow them before proceeding with any other action.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the skill\'s SKILL.md file.',
        },
      },
      required: ['path'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) => runLoadSkill(String(args.path ?? ''), ctx.workspaceRoot),
};

// ─── SDK factory (Phase 3+) ─────────────────────────────────────────────

export function createLoadSkillTool(ctx: ToolContext) {
  return tool({
    description:
      'Load and activate a skill by reading its SKILL.md file. Call this when the user ' +
      'invokes a skill via /name, or when a skill matches the task. Returns the skill\'s ' +
      'full instructions — read and follow them before proceeding with any other action.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path to the skill\'s SKILL.md file.'),
    }),
    execute: async ({ path }) =>
      withPermission(ctx, 'load_skill', { path }, () => runLoadSkill(path, ctx.workspaceRoot)),
  });
}
