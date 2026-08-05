/** slash_command tool: dispatch to a user-defined slash command (a prompt-prefix macro in <userData>/commands/*.md, first line = description); returns the body as system-prompt injection or a helpful error if not found. */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import * as sessions from '../../ipc/sessions';
import { appDataDir } from '../../appPaths.js';

function commandsDir(): string {
  return path.join(appDataDir(), 'commands');
}

/** List available slash commands (name + description). */
export function listSlashCommands(): { name: string; description: string }[] {
  const dir = commandsDir();
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; description: string }[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
      const firstLine = content.split('\n')[0] ?? '';
      out.push({ name, description: firstLine.slice(0, 120) });
    } catch {
      out.push({ name, description: '' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Shared body — reads <userData>/commands/<name>.md; no ctx dependency. */
export async function runSlashCommand(command: string, args: string): Promise<ToolResult> {
  const name = command.replace(/^\/+/, '');
  if (!name) return { status: 'failed', output: 'Missing required arg: command' };

  const file = path.join(commandsDir(), `${name}.md`);
  if (!fs.existsSync(file)) {
    const available = listSlashCommands();
    const list = available.length > 0
      ? `Available: ${available.map((c) => c.name).join(', ')}.`
      : 'No commands are installed. Drop .md files in <userData>/commands/.';
    return {
      status: 'failed',
      output: `Unknown command: /${name}. ${list}`,
    };
  }

  let body: string;
  let bytes = 0;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    body = raw.trim();
    bytes = Buffer.byteLength(raw, 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read command file: ${e.message}` };
  }

  const lines = body.split('\n').length;
  // First non-empty line is the human description (commands/*.md convention).
  const description = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 120);
  const argSuffix = args ? `\n\nArguments: ${args}` : '';
  return {
    status: 'executed',
    output: `/${name} loaded. Apply its instructions to the task at hand.${argSuffix}\n\n---\n${body}`,
    meta: `/${name} · ${lines}L`,
    // file_loaded display → renders a compact "loaded <path> · N lines · N bytes"
    // card with the body collapsible, instead of dumping raw text.
    display: { kind: 'file_loaded', path: `commands/${name}.md`, lines, bytes, description, body },
  };
}

export const slashCommandTool: ToolRegistration = {
  name: 'slash_command',
  definition: {
    name: 'slash_command',
    description:
      'Invoke a user-defined slash command. Commands live in <userData>/commands/*.md ' +
      'and bundle a prompt prefix + instructions. Use when the user explicitly references ' +
      'one (e.g. "run /refactor on src/") or when a known command matches the task. ' +
      'Returns the command body so you can apply its instructions.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name without the leading slash (e.g. "refactor").' },
        args: { type: 'string', description: 'Optional arguments to pass to the command.' },
      },
      required: ['command'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 3_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) =>
    runSlashCommand(String(args.command ?? ''), args.args != null ? String(args.args) : ''),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createSlashCommandTool(ctx: ToolContext) {
  return tool({
    description:
      'Invoke a user-defined slash command. Commands live in <userData>/commands/*.md ' +
      'and bundle a prompt prefix + instructions. Use when the user explicitly references ' +
      'one (e.g. "run /refactor on src/") or when a known command matches the task. ' +
      'Returns the command body so you can apply its instructions.',
    inputSchema: z.object({
      command: z.string().describe('Command name without the leading slash (e.g. "refactor").'),
      args: z.string().optional().describe('Optional arguments to pass to the command.'),
    }),
    execute: async ({ command, args }) =>
      withPermission(ctx, 'slash_command', { command, args }, async () => {
        const result = await runSlashCommand(command, args ?? '');
        // Record the load in the session's activity feed (Inspector).
        // Best-effort: a store failure must not break the tool result.
        if (result.display?.kind === 'file_loaded') {
          try {
            sessions.addActivity(ctx.sessionId, {
              type: 'file_loaded',
              label: `/${command.replace(/^\/+/, '')}`,
              detail: result.display.path,
              tone: 'accent',
            });
          } catch {
            /* session store unavailable — ignore */
          }
        }
        return result;
      }),
  });
}
