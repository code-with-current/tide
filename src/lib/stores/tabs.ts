import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RightTab, RightTabKind } from '@/types';

interface TabsState {
  /** Per-session tabs. Keyed by sessionId; falls back to 'default'. */
  bySession: Record<string, RightTab[]>;
  active: Record<string, RightTabKind>;
  /** Source control view mode per session ('tree' or 'list'). */
  scViewMode: Record<string, 'tree' | 'list'>;

  addTab: (sessionId: string, kind: RightTabKind) => void;
  removeTab: (sessionId: string, kind: RightTabKind) => void;
  setActive: (sessionId: string, kind: RightTabKind) => void;
  setScViewMode: (sessionId: string, mode: 'tree' | 'list') => void;
  /** Purge all tab data for a session (called on session delete). */
  clearSessionTabs: (sessionId: string) => void;
}

const inspector: RightTab = { kind: 'inspector', locked: true };

const ensureList = (bySession: Record<string, RightTab[]>, sessionId: string): RightTab[] =>
  bySession[sessionId] ?? [inspector];

export const useTabs = create<TabsState>()(
  persist(
    (set) => ({
      bySession: {},
      active: {},
      scViewMode: {},

      addTab: (sessionId, kind) =>
        set((s) => {
          const list = ensureList(s.bySession, sessionId);
          if (list.some((t) => t.kind === kind)) {
            return { active: { ...s.active, [sessionId]: kind } };
          }
          const newTab: RightTab = { kind };
          return {
            bySession: { ...s.bySession, [sessionId]: [...list, newTab] },
            active: { ...s.active, [sessionId]: kind },
          };
        }),

      removeTab: (sessionId, kind) =>
        set((s) => {
          if (kind === 'inspector') return s; // locked
          const list = ensureList(s.bySession, sessionId).filter((t) => t.kind !== kind);
          const currentActive = s.active[sessionId] ?? 'inspector';
          const newActive = currentActive === kind ? 'inspector' : currentActive;
          return {
            bySession: { ...s.bySession, [sessionId]: list.length ? list : [inspector] },
            active: { ...s.active, [sessionId]: newActive },
          };
        }),

      setActive: (sessionId, kind) =>
        set((s) => ({ active: { ...s.active, [sessionId]: kind } })),

      setScViewMode: (sessionId, mode) =>
        set((s) => ({ scViewMode: { ...s.scViewMode, [sessionId]: mode } })),

      clearSessionTabs: (sessionId) =>
        set((s) => {
          const { [sessionId]: _b, ...restBySession } = s.bySession;
          const { [sessionId]: _a, ...restActive } = s.active;
          const { [sessionId]: _v, ...restSc } = s.scViewMode;
          return { bySession: restBySession, active: restActive, scViewMode: restSc };
        }),
    }),
    {
      name: 'tide-right-panel-state',
      // Only persist the data, not the actions.
      partialize: (s) => ({
        bySession: s.bySession,
        active: s.active,
        scViewMode: s.scViewMode,
      }),
    },
  ),
);
