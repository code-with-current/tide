/** todo_write tool: let the model maintain a per-session todo list (replaces wholesale on each call, like Claude Code's TodoWrite); broadcasts a live-update event so the renderer's floating panel re-renders. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDisplay } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Optional priority hint. */
  priority?: 'high' | 'medium' | 'low';
}

/** Listener type for the todo update bus. */
type TodoListener = (payload: { sessionId: string; todos: TodoItem[] }) => void;

/** In-memory store keyed by session id — the current todo list per session. */
const sessionTodos = new Map<string, TodoItem[]>();

/** Minimal event bus — replaces Node's EventEmitter to avoid Vite's browser-external mangling of the 'events' module in the electron bundle. subscribe/unsubscribe/emit only. */
class TodoBus {
  private listeners = new Set<TodoListener>();
  on(fn: TodoListener): void {
    this.listeners.add(fn);
  }
  off(fn: TodoListener): void {
    this.listeners.delete(fn);
  }
  emit(payload: { sessionId: string; todos: TodoItem[] }): void {
    for (const fn of this.listeners) {
      try { fn(payload); } catch { /* listener threw — keep the bus alive */ }
    }
  }
}

export const todoEvents = new TodoBus();

export function getSessionTodos(sessionId: string): TodoItem[] {
  return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
  sessionTodos.delete(sessionId);
  todoEvents.emit({ sessionId, todos: [] });
}

/** Shared body — takes the parsed todos + the session id (for the per-session
 *  store + the live-update broadcast). No other ctx dependency. */
export async function runTodoWrite(todos: TodoItem[], sessionId: string): Promise<ToolResult> {
  if (todos.length === 0) {
    return { status: 'failed', output: 'Missing or empty required arg: todos' };
  }

  // Validate: at most one in_progress.
  const inProgress = todos.filter((t) => t.status === 'in_progress');
  if (inProgress.length > 1) {
    return {
      status: 'failed',
      output: `At most one todo can be in_progress at a time; got ${inProgress.length}. Fix and retry.`,
    };
  }

  const sid = sessionId || 'default';
  sessionTodos.set(sid, todos);
  // Broadcast the update so the renderer's floating panel re-renders live.
  todoEvents.emit({ sessionId: sid, todos });

  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = Math.round((done / total) * 100);
  const next = todos.find((t) => t.status === 'in_progress');
  const summary = `${done}/${total} done${next ? ` · next: ${next.content}` : ''}`;

  const display: ToolDisplay = {
    kind: 'text',
    text: todos.map((t, i) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `${mark} ${i + 1}. ${t.content}`;
    }).join('\n'),
  };

  return {
    status: 'executed',
    output: `Todo list updated (${summary}).`,
    meta: `${pct}% · ${summary}`,
    display,
  };
}

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

export const todoWriteTool: ToolRegistration = {
  name: 'todo_write',
  definition: {
    name: 'todo_write',
    description:
      'Maintain a structured todo list for the current task. Call this BEFORE starting ' +
      'multi-step work to plan, then update statuses as you progress. Replaces the entire ' +
      'list on each call. Use sparingly — only for tasks with 3+ distinct steps. For simple ' +
      'one-shot answers, skip this tool. The UI shows progress as a floating checklist.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list. Replaces any prior list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short description of the task.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current state. Exactly one should be in_progress at a time.',
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'Optional priority.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  // Pure state update — no file mutations. Risk is just UX noise if abused.
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 1_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runTodoWrite(Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [], ctx.sessionId ?? 'default'),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createTodoWriteTool(ctx: ToolContext) {
  return tool({
    description:
      'Maintain a structured todo list for the current task. Call this BEFORE starting ' +
      'multi-step work to plan, then update statuses as you progress. Replaces the entire ' +
      'list on each call. Use sparingly — only for tasks with 3+ distinct steps. For simple ' +
      'one-shot answers, skip this tool. The UI shows progress as a floating checklist.',
    inputSchema: z.object({
      todos: z.array(todoItemSchema).describe('The complete todo list. Replaces any prior list.'),
    }),
    execute: async ({ todos }) =>
      withPermission(ctx, 'todo_write', { todos }, () => runTodoWrite(todos as TodoItem[], ctx.sessionId)),
  });
}
