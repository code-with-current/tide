import { useState, useEffect } from 'react';
import * as api from '@/lib/api/client';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface TodoGroup {
  id: string;
  title: string;
  items: TodoItem[];
  createdAt: number;
}

/** Normalize whatever the backend returns into TodoGroup[]. Handles both old (flat TodoItem[]) and new (TodoGroup[]) formats. */
function normalizeGroups(data: any): TodoGroup[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  // New format: array of { id, title, items, createdAt }.
  if (data[0] && typeof data[0] === 'object' && Array.isArray(data[0].items)) {
    return data as TodoGroup[];
  }
  // Old format: flat array of { content, status, priority }.
  if (data[0] && typeof data[0] === 'object' && 'content' in data[0] && 'status' in data[0]) {
    return [{
      id: 'legacy',
      title: 'Tasks',
      items: data as TodoItem[],
      createdAt: 0,
    }];
  }
  return [];
}

/** Subscribe to a session's todo groups: fetch on mount/sessionId change, then live-update via the todos:updated event. */
export function useTodoGroups(sessionId: string | null | undefined): TodoGroup[] {
  const [groups, setGroups] = useState<TodoGroup[]>([]);

  useEffect(() => {
    if (!sessionId) { setGroups([]); return; }
    let cancelled = false;
    api.listTodos(sessionId).then((list) => {
      if (!cancelled) setGroups(normalizeGroups(list));
    }).catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    api.subscribeTodos().catch(() => {});
    api.onTodosUpdated(({ sessionId: eventSessionId, groups: list }: any) => {
      if (eventSessionId !== sessionId) return;
      setGroups(normalizeGroups(list));
    });
    return () => {
      api.removeTodosListener();
    };
  }, [sessionId]);

  return groups;
}

/** Back-compat: flatten groups into a single item list (for callers that don't need grouping). */
export function useTodos(sessionId: string | null | undefined): TodoItem[] {
  const groups = useTodoGroups(sessionId);
  return groups.flatMap((g) => g.items);
}
