/** todo_write tool: multi-group per-session todo lists. Each prompt that starts fresh work creates a new group; status updates modify the current group. Broadcasts live updates for the floating panel. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDisplay } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

/** A named group of todos — one per "batch" of work the model plans. */
export interface TodoGroup {
  id: string;
  title: string;
  items: TodoItem[];
  createdAt: number;
}

/** Listener payload — the full set of groups for a session. */
type TodoListener = (payload: { sessionId: string; groups: TodoGroup[] }) => void;

/** In-memory store: sessionId → ordered groups (newest last). Backed by the session JSON for persistence. */
const sessionGroups = new Map<string, TodoGroup[]>();

/** Persist groups to the session JSON so they survive app restart. Best-effort — never blocks the tool. */
function persist(sessionId: string): void {
  try {
    const { createSessionStore } = require('../../ipc/sessionStore.js') as typeof import('../../ipc/sessionStore.js');
    const { appDataDir } = require('../../appPaths.js') as typeof import('../../appPaths.js');
    const store = createSessionStore(appDataDir());
    store.setTodoGroups(sessionId, sessionGroups.get(sessionId) ?? []);
  } catch { /* session store unavailable — in-memory only */ }
}

/** Load persisted groups from the session JSON on startup or first access. */
function loadFromStore(sessionId: string): void {
  if (sessionGroups.has(sessionId)) return; // already loaded
  try {
    const { createSessionStore } = require('../../ipc/sessionStore.js') as typeof import('../../ipc/sessionStore.js');
    const { appDataDir } = require('../../appPaths.js') as typeof import('../../appPaths.js');
    const store = createSessionStore(appDataDir());
    const s = store.getSession(sessionId);
    if (s?.todoGroups && Array.isArray(s.todoGroups)) {
      sessionGroups.set(sessionId, s.todoGroups as TodoGroup[]);
    }
  } catch { /* leave empty */ }
}

class TodoBus {
  private listeners = new Set<TodoListener>();
  on(fn: TodoListener): void { this.listeners.add(fn); }
  off(fn: TodoListener): void { this.listeners.delete(fn); }
  emit(payload: { sessionId: string; groups: TodoGroup[] }): void {
    for (const fn of this.listeners) {
      try { fn(payload); } catch { /* keep the bus alive */ }
    }
  }
}

export const todoEvents = new TodoBus();

/** Get ALL groups for a session (for the stacked panel + the todo gate). */
export function getSessionTodos(sessionId: string): TodoItem[] {
  loadFromStore(sessionId);
  const groups = sessionGroups.get(sessionId) ?? [];
  return groups.flatMap((g) => g.items);
}

export function getSessionGroups(sessionId: string): TodoGroup[] {
  loadFromStore(sessionId);
  return sessionGroups.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
  sessionGroups.delete(sessionId);
  persist(sessionId);
  todoEvents.emit({ sessionId, groups: [] });
}

/** Derive a short title from the first todo item (e.g. "Phase 4: Board Detail" → "Board Detail"). */
function deriveTitle(items: TodoItem[]): string {
  const first = items[0]?.content ?? 'Task';
  // Strip leading "Phase N:" or "N." prefixes if present.
  const stripped = first.replace(/^(phase\s+\d+[:.]?|step\s+\d+[:.]?|\d+[.)])\s*/i, '');
  const result = stripped || first;
  return result.length > 50 ? result.slice(0, 47) + '…' : result;
}

/** Check if the incoming items overlap with the current group (update) or are entirely new (new group). */
function isUpdateToCurrentGroup(current: TodoGroup | undefined, incoming: TodoItem[]): boolean {
  if (!current || current.items.length === 0) return false;
  // If any incoming item content matches an existing item, it's an update.
  const existingContent = new Set(current.items.map((t) => t.content));
  return incoming.some((t) => existingContent.has(t.content));
}

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
  const groups = sessionGroups.get(sid) ?? [];
  const currentGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;

  if (isUpdateToCurrentGroup(currentGroup, todos)) {
    // Update the current group in place — statuses changed, maybe items added/removed.
    currentGroup.items = todos;
    currentGroup.title = deriveTitle(todos);
  } else {
    // New group — append.
    groups.push({
      id: `tg_${Math.random().toString(36).slice(2, 8)}`,
      title: deriveTitle(todos),
      items: todos,
      createdAt: Date.now(),
    });
  }

  sessionGroups.set(sid, groups);
  persist(sid);
  todoEvents.emit({ sessionId: sid, groups });

  // Summary for the tool output (flattened view).
  const allItems = groups.flatMap((g) => g.items);
  const done = allItems.filter((t) => t.status === 'completed').length;
  const total = allItems.length;
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
    meta: `${summary}`,
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
      'multi-step work to plan, then update statuses as you progress. Replaces the current ' +
      'list on each call. Use sparingly — only for tasks with 3+ distinct steps. For simple ' +
      'one-shot answers, skip this tool. The UI shows progress as a floating checklist.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list. Replaces the current list.',
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
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 1_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runTodoWrite(Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [], ctx.sessionId ?? 'default'),
};

export function createTodoWriteTool(ctx: ToolContext) {
  return tool({
    description:
      'Maintain a structured todo list for the current task. Call this BEFORE starting ' +
      'multi-step work to plan, then update statuses as you progress. Replaces the current ' +
      'list on each call. Use sparingly — only for tasks with 3+ distinct steps. For simple ' +
      'one-shot answers, skip this tool. The UI shows progress as a floating checklist.',
    inputSchema: z.object({
      todos: z.array(todoItemSchema).describe('The complete todo list. Replaces the current list.'),
    }),
    execute: async ({ todos }) =>
      withPermission(ctx, 'todo_write', { todos }, () => runTodoWrite(todos as TodoItem[], ctx.sessionId)),
  });
}
