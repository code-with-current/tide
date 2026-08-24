/** load_skill tool: reads a skill's SKILL.md (via read_file + skill-root allowlist) and returns the body as instructions to follow; "execute" = load the prompt-based skill, not run code. Triggered by `/skill-name`. */
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext, SkillSummary } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { runReadFile } from './read-file';
import { getBuiltinSkill } from '../skills/builtin';

const DEFAULT_MAX_LINES = 2000;

/** Shared body — reads the SKILL.md at the given absolute path (may live outside the workspace under ~/.claude/skills, which read_file's skill-root exception allows) and extracts the skill name from YAML frontmatter. */
export async function runLoadSkill(
  skillPath: string,
  workspaceRoot: string,
): Promise<ToolResult> {
  if (!skillPath) return { status: 'failed', output: 'Missing required arg: path' };

  // Builtin skills resolve in memory via virtual ids — never touch disk.
  if (skillPath.startsWith('builtin:')) {
    const name = skillPath.slice('builtin:'.length);
    const skill = getBuiltinSkill(name);
    if (!skill) return { status: 'failed', output: `'${name}' is not a builtin skill` };
    return {
      status: 'executed',
      output: `Skill "${name}" loaded (${skill.body.length} chars). Read and follow its instructions before taking any other action on the task.`,
      meta: `${name} · ${skill.body.length} chars`,
      display: { kind: 'file_loaded', path: skillPath, lines: skill.body.split('\n').length, bytes: skill.body.length, body: skill.body },
    };
  }

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
          description: 'Absolute path to the skill\'s SKILL.md file, or a `builtin:<name>` id from the Available skills list.',
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

/** Char budget for full (name + path + description) catalog lines. Past it,
 *  entries degrade to name + path only — matching Claude Code's policy of
 *  dropping descriptions first rather than omitting skills outright. */
const CATALOG_FULL_BUDGET = 4_000;
/** Hard entry cap. Beyond this the catalog ends with an omission count — the
 *  model can't load what it can't name, so names are kept as far as possible. */
const CATALOG_MAX_ENTRIES = 120;
/** Per-description clamp. Descriptions are the file's first line and usually
 *  short, but a stray heading-less paragraph must not eat the whole budget. */
const CATALOG_DESC_CLAMP = 160;

/** Render the skill catalog for the load_skill tool description, budgeted:
 *  full lines while under CATALOG_FULL_BUDGET, name+path lines after, and an
 *  omission note past CATALOG_MAX_ENTRIES. Pure and deterministic. */
export function buildSkillCatalogMd(skills: SkillSummary[]): string {
  const lines: string[] = [];
  let used = 0;
  let full = true;
  for (let i = 0; i < skills.length; i++) {
    if (i >= CATALOG_MAX_ENTRIES) {
      lines.push(`(+${skills.length - CATALOG_MAX_ENTRIES} more skills not listed)`);
      break;
    }
    const s = skills[i];
    const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, CATALOG_DESC_CLAMP);
    const fullLine = desc ? `- **${s.name}** (${s.absPath}): ${desc}` : `- **${s.name}** (${s.absPath})`;
    if (full && used + fullLine.length > CATALOG_FULL_BUDGET) full = false;
    const line = full ? fullLine : `- **${s.name}** (${s.absPath})`;
    used += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}

export function createLoadSkillTool(ctx: ToolContext) {
  const base =
    'Load and activate a skill by reading its SKILL.md file. Call this when the user ' +
    'invokes a skill via /name, or when a skill listed below matches the task — BEFORE ' +
    'falling back to your default approach. Returns the skill\'s full instructions — ' +
    'read and follow them before proceeding with any other action.';
  const catalog = ctx.skills?.length ? buildSkillCatalogMd(ctx.skills) : '';
  const description =
    base +
    (catalog
      ? '\n\n# Available skills\n' + catalog +
        '\n\nOnly use skills from this list — never invent or guess skill names or paths. ' +
        'If a skill\'s instructions already appear under "# Active Skills" in the system ' +
        'prompt, it is loaded: do NOT call this tool for it again.'
      : ' No skills are installed for this workspace.');
  return tool({
    description,
    inputSchema: z.object({
      path: z.string().describe('Absolute path to the skill\'s SKILL.md file, or a `builtin:<name>` id from the Available skills list.'),
    }),
    execute: async ({ path }) =>
      withPermission(ctx, 'load_skill', { path }, () => runLoadSkill(path, ctx.workspaceRoot)),
  });
}
