/** todo_write tool: single flat per-session todo list. Full-replacement model
 *  (the COMPLETE list replaces the previous on every call). Broadcasts live
 *  updates via todoEvents. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDisplay } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority?: 'high' | 'medium' | 'low';
}

type TodoListener = (payload: { sessionId: string; todos: TodoItem[] }) => void;

const sessionTodos = new Map<string, TodoItem[]>();

/** Acquire the shared session store singleton. Must NOT call createSessionStore
 *  directly — that creates a separate cache whose writes get clobbered by the
 *  IPC layer's singleton (the persistence bug that lost todos). */
function sharedStore(): import('../../ipc/sessionStore.js').SessionStore | null {
  try {
    const { getSessionStore } = require('../../ipc/sessions.js') as typeof import('../../ipc/sessions.js');
    return getSessionStore();
  } catch { return null; }
}

function persist(sessionId: string): void {
  try {
    sharedStore()?.setTodos(sessionId, sessionTodos.get(sessionId) ?? []);
  } catch { /* best-effort */ }
}

function loadFromStore(sessionId: string): void {
  if (sessionTodos.has(sessionId)) return;
  try {
    const store = sharedStore();
    if (!store) return;
    const s = store.getSession(sessionId);
    if (Array.isArray((s as any)?.todos)) {
      sessionTodos.set(sessionId, (s as any).todos as TodoItem[]);
    } else if (Array.isArray((s as any)?.todoGroups)) {
      const flat = ((s as any).todoGroups as Array<{ items: TodoItem[] }>)
        .flatMap((g) => g.items ?? []);
      sessionTodos.set(sessionId, flat);
    }
  } catch { /* leave empty */ }
}

class TodoBus {
  private listeners = new Set<TodoListener>();
  on(fn: TodoListener): void { this.listeners.add(fn); }
  off(fn: TodoListener): void { this.listeners.delete(fn); }
  emit(payload: { sessionId: string; todos: TodoItem[] }): void {
    for (const fn of this.listeners) {
      try { fn(payload); } catch { /* keep the bus alive */ }
    }
  }
}

export const todoEvents = new TodoBus();

export function getSessionTodos(sessionId: string): TodoItem[] {
  loadFromStore(sessionId);
  return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
  sessionTodos.delete(sessionId);
  persist(sessionId);
  todoEvents.emit({ sessionId, todos: [] });
}

const DESCRIPTION =
  'Maintain a structured todo list for the current task. Call this BEFORE starting ' +
  'multi-step work to plan, then UPDATE statuses as you progress. ' +
  'Send the COMPLETE list on every call — it REPLACES the previous list (do not send ' +
  'deltas). Mark completed items "completed", the one you are working on "in_progress", ' +
  'pending ones "pending", and items you are dropping as "cancelled". Exactly one item ' +
  'may be in_progress at a time. The user sees this list live, so keep it accurate in ' +
  'real time — mark an item completed as soon as its work is done and verified. ' +
  'Use for tasks with 3+ distinct steps; skip for simple one-shot answers.';

export async function runTodoWrite(todos: TodoItem[], sessionId: string): Promise<ToolResult> {
  if (todos.length === 0) {
    return { status: 'failed', output: 'Missing or empty required arg: todos' };
  }

  const inProgress = todos.filter((t) => t.status === 'in_progress');
  if (inProgress.length > 1) {
    return {
      status: 'failed',
      output: `At most one todo can be in_progress at a time; got ${inProgress.length}. Fix and retry.`,
    };
  }

  const sid = sessionId || 'default';
  loadFromStore(sid);

  sessionTodos.set(sid, todos);
  persist(sid);
  todoEvents.emit({ sessionId: sid, todos });

  const done = todos.filter((t) => t.status === 'completed').length;
  const cancelled = todos.filter((t) => t.status === 'cancelled').length;
  const open = todos.length - done - cancelled;
  const next = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  const summary = `${done}/${todos.length} done${cancelled ? ` · ${cancelled} cancelled` : ''}${next ? ` · next: ${next.content}` : ''}`;

  const display: ToolDisplay = {
    kind: 'text',
    text: todos.map((t, i) => {
      const mark =
        t.status === 'completed' ? '[x]' :
        t.status === 'in_progress' ? '[~]' :
        t.status === 'cancelled' ? '[-]' : '[ ]';
      return `${mark} ${i + 1}. ${t.content}`;
    }).join('\n'),
  };

  return {
    status: 'executed',
    output: `Todo list updated (${summary}).`,
    meta: summary,
    display,
  };
}

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

export const todoWriteTool: ToolRegistration = {
  name: 'todo_write',
  definition: {
    name: 'todo_write',
    description: DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list. Sent in full on every call — replaces the previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short description of the task.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: 'pending = not started, in_progress = actively working (at most one), completed = done + verified, cancelled = dropped.',
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
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 1_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runTodoWrite(Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [], ctx.sessionId ?? 'default'),
};

export function createTodoWriteTool(ctx: ToolContext) {
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      todos: z.array(todoItemSchema).describe('The complete todo list. Sent in full on every call — replaces the previous list.'),
    }),
    execute: async ({ todos }) =>
      withPermission(ctx, 'todo_write', { todos }, () => runTodoWrite(todos as TodoItem[], ctx.sessionId)),
  });
}
