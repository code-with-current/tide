import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RightTab, RightTabKind } from '@/types';

interface TabsState {
  /** Per-session tabs. Keyed by sessionId; falls back to 'default'. */
  bySession: Record<string, RightTab[]>;
  active: Record<string, RightTabKind>;
  /** Git Panel view mode per session ('tree' or 'list'). */
  gpViewMode: Record<string, 'tree' | 'list'>;

  addTab: (sessionId: string, kind: RightTabKind) => void;
  removeTab: (sessionId: string, kind: RightTabKind) => void;
  setActive: (sessionId: string, kind: RightTabKind) => void;
  setGpViewMode: (sessionId: string, mode: 'tree' | 'list') => void;
  /** Purge all tab data for a session (called on session delete). */
  clearSessionTabs: (sessionId: string) => void;
}

const defaultTab: RightTab = { kind: 'files' };

const ensureList = (bySession: Record<string, RightTab[]>, sessionId: string): RightTab[] =>
  bySession[sessionId] ?? [defaultTab];

export const RIGHT_TAB_KINDS = ['git', 'files', 'agents', 'terminal', 'browser'] as const;

/** Persisted tab kinds from older builds remapped onto the live union.
 *  Unknown values fall back to 'files'. */
export function remapTabKind(kind: string): RightTabKind {
  if ((RIGHT_TAB_KINDS as readonly string[]).includes(kind)) return kind as RightTabKind;
  if (kind === 'review' || kind === 'changes') return 'git';
  return 'files';
}

const remapLists = (bySession: Record<string, RightTab[]>): Record<string, RightTab[]> =>
  Object.fromEntries(
    Object.entries(bySession).map(([sid, tabs]) => {
      const seen = new Set<RightTabKind>();
      const remapped: RightTab[] = [];
      for (const t of tabs ?? []) {
        const kind = remapTabKind(t.kind);
        if (seen.has(kind)) continue;
        seen.add(kind);
        remapped.push({ ...t, kind });
      }
      return [sid, remapped];
    }),
  );

const remapActive = (active: Record<string, RightTabKind>): Record<string, RightTabKind> =>
  Object.fromEntries(Object.entries(active).map(([sid, kind]) => [sid, remapTabKind(kind)]));

export const useTabs = create<TabsState>()(
  persist(
    (set) => ({
      bySession: {},
      active: {},
      gpViewMode: {},

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
          const list = ensureList(s.bySession, sessionId).filter((t) => t.kind !== kind);
          const currentActive = s.active[sessionId] ?? 'files';
          const newActive = currentActive === kind ? 'files' : currentActive;
          return {
            bySession: { ...s.bySession, [sessionId]: list.length ? list : [defaultTab] },
            active: { ...s.active, [sessionId]: newActive },
          };
        }),

      setActive: (sessionId, kind) =>
        set((s) => ({ active: { ...s.active, [sessionId]: kind } })),

      setGpViewMode: (sessionId, mode) =>
        set((s) => ({ gpViewMode: { ...s.gpViewMode, [sessionId]: mode } })),

      clearSessionTabs: (sessionId) =>
        set((s) => {
          const { [sessionId]: _b, ...restBySession } = s.bySession;
          const { [sessionId]: _a, ...restActive } = s.active;
          const { [sessionId]: _v, ...restGp } = s.gpViewMode;
          return { bySession: restBySession, active: restActive, gpViewMode: restGp };
        }),
    }),
    {
      name: 'tide-right-panel-state',
      // Only persist the data, not the actions.
      partialize: (s) => ({
        bySession: s.bySession,
        active: s.active,
        gpViewMode: s.gpViewMode,
      }),
      // Persisted kinds from older builds ('inspector'/'review'/'changes') are
      // remapped onto the live union at hydration — never at write time.
      merge: (persistedState, current) => {
        const p = persistedState as Partial<TabsState>;
        return {
          ...current,
          ...p,
          bySession: remapLists(p.bySession ?? {}),
          active: remapActive(p.active ?? {}),
        };
      },
    },
  ),
);
