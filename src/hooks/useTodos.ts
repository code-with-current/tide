import { useState, useEffect } from 'react';
import * as api from '@/lib/api/client';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Subscribe to a session's todo list. Fetches the current list on mount and
 * on sessionId change, then live-updates via the todos:updated event.
 *
 * Subscription is set up once per mount; subsequent sessionId changes just
 * refetch (the event stream isn't per-session — the listener filters by id).
 */
export function useTodos(sessionId: string | null | undefined): TodoItem[] {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Initial fetch whenever sessionId changes.
  useEffect(() => {
    if (!sessionId) { setTodos([]); return; }
    let cancelled = false;
    api.listTodos(sessionId).then((list) => {
      if (!cancelled) setTodos(list);
    }).catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Live subscription — registered once for the hook's lifetime.
  useEffect(() => {
    // Tell the main process we want todos:updated events. Cheap; the handler
    // cleans up via the closed event on the WebContents.
    api.subscribeTodos().catch(() => {});
    api.onTodosUpdated(({ sessionId: eventSessionId, todos: list }) => {
      // Filter to the active session — the event is broadcast to every
      // renderer (the floating panel only cares about its session).
      if (eventSessionId !== sessionId) return;
      setTodos(list as TodoItem[]);
    });
    return () => {
      api.removeTodosListener();
    };
  }, [sessionId]);

  return todos;
}
