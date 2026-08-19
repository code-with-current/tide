/** init tool — scans the workspace and generates a minimal AGENTS.md at the project root. The file is loaded into every future session, so only includes what the agent would get wrong without it. */

import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const INIT_INSTRUCTIONS = `Set up a minimal AGENTS.md file for the current repository. Because this file is loaded into every session, the guiding principle is strict conciseness: only include what the agent would get wrong without it.

Follow these steps:

1. Explore the codebase: read manifest files (package.json, Cargo.toml, pyproject.toml, etc.), config files (tsconfig, eslint, prettier, .editorconfig), CI configs, and check for existing AI rules (.cursorrules, CLAUDE.md, CONTRIBUTING.md).

2. Identify non-obvious project rules, build commands, testing quirks, and gotchas that can't be inferred from reading the code.

3. Write an AGENTS.md to the project root with ONLY high-signal content. Every line must pass the test: "Would removing this cause the agent to make mistakes?" If not, cut it.

Include:
- Non-standard build/test/lint commands (things not obvious from manifest files)
- Differing style rules (only if they differ from the framework defaults)
- Testing quirks (e.g. "tests must run with X flag")
- Repo etiquette (branch conventions, commit message format, PR process)
- Gotchas (e.g. "don't edit files in X directory", "the DB must be running for tests")

Handling existing rule files:
- If .cursorrules, CLAUDE.md, .github/copilot-instructions.md, or similar AI rule files exist, fold their still-relevant rules INTO AGENTS.md instead of leaving parallel instruction sources — one canonical file the agent actually reads. Note what you consolidated.
- When creating AGENTS.md fresh, incorporate the content of those existing rule files rather than starting from zero.
- If AGENTS.md already exists, improve it in place: verify each existing rule against the codebase, add what's missing from your exploration, and flag stale entries to the user — don't rewrite from scratch.

Grounding:
- Never invent rules. Every rule must trace to something observed: a manifest script, a config value, a CI step, a README statement, or an existing rule file. If you can't cite the origin, don't write the rule.
- Omit license, security-policy, and governance boilerplate unless the user asks for it.

Exclude:
- Generic advice ("write clean code", "handle errors properly")
- File-by-file structure listings (the agent can read the code)
- Standard commands visible in package.json/Makefile
- Long tutorials (reference a doc path instead)
- Obvious things inferable from the codebase`;

export async function runInit(workspaceRoot: string): Promise<ToolResult> {
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');

  // Check if AGENTS.md already exists.
  const exists = fs.existsSync(agentsPath);

  const display: ToolDisplay = {
    kind: 'text',
    text: exists
      ? `AGENTS.md already exists at ${agentsPath}. Review it and ask the user if they want to improve it or start fresh.`
      : `No AGENTS.md found. Explore the codebase and create one following the instructions below.`,
  };

  return {
    status: 'executed',
    output: `${exists ? 'AGENTS.md exists — review it.\n\n' : 'No AGENTS.md found — create one.\n\n'}${INIT_INSTRUCTIONS}`,
    meta: exists ? 'exists' : 'new',
    display,
  };
}

// ─── Legacy envelope ──────────────────────────────────────────────────

export const initTool: ToolRegistration = {
  name: 'init',
  definition: {
    name: 'init',
    description:
      'Initialize the project: scan the workspace and create a minimal AGENTS.md at the project root. ' +
      'The file captures non-obvious project rules, build commands, and gotchas. Call this when the user ' +
      'wants to set up project configuration for the agent.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (_args, ctx) => runInit(ctx.workspaceRoot),
};

// ─── SDK factory ──────────────────────────────────────────────────────

export function createInitTool(ctx: ToolContext) {
  return tool({
    description:
      'Initialize the project: scan the workspace and create a minimal AGENTS.md at the project root. ' +
      'The file captures non-obvious project rules, build commands, and gotchas. Call this when the user ' +
      'wants to set up project configuration for the agent.',
    inputSchema: z.object({}),
    execute: async () =>
      withPermission(ctx, 'init', {}, () => runInit(ctx.workspaceRoot)),
  });
}
