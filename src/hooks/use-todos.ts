import { useState, useEffect } from 'react';
import * as api from '@/lib/api/client';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority?: 'high' | 'medium' | 'low';
}

/** Subscribe to a session's todo list: fetch on mount/sessionId change, then
 *  live-update via the `todos:updated` event. The list is flat (single source
 *  of truth for the floating panel); the model replaces it in full on every
 *  todo_write call. */
export function useSessionTodos(sessionId: string | null | undefined): TodoItem[] {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  useEffect(() => {
    if (!sessionId) { setTodos([]); return; }
    let cancelled = false;
    api.listTodos(sessionId).then((list) => {
      if (!cancelled) setTodos(list as TodoItem[]);
    }).catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    api.subscribeTodos().catch(() => {});
    api.onTodosUpdated(({ sessionId: eventSessionId, todos: list }: any) => {
      if (eventSessionId !== sessionId) return;
      setTodos((list ?? []) as TodoItem[]);
    });
    return () => {
      api.removeTodosListener();
    };
  }, [sessionId]);

  return todos;
}
