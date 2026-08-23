/**
 * Tide-native panel navigation for ported tool rows. Upstream ToolPart routed
 * file/diff/agent navigation through `RuntimeAPIContext` (the OpenCode editor
 * bridge), which the port dropped — clicking a row always toggles. This
 * context restores that affordance against Tide's own surfaces: the right
 * panel's file viewer (openFile), its diff mode (diffHunks), and the agents
 * tab (focused dispatch). The actions mirror tool-chips.tsx's openDispatch
 * contract (setFocusedDispatch + addTab/setActive + setRightPanel).
 */

import React from 'react';
import type { DiffHunk } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';

export interface PanelActions {
  /** Open a file in the right panel's viewer. */
  viewFile: (path: string) => void;
  /** Open a file in the right panel's viewer in diff mode. */
  viewDiff: (entry: { path: string; hunks?: DiffHunk[] }) => void;
  /** Focus a dispatch_agent call in the agents tab. */
  openDispatch: (toolCallId: string) => void;
}

const PanelActionsContext = React.createContext<PanelActions | null>(null);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
};

const languageForPath = (path: string): string => {
  const extension = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? (extension || 'text');
};

export const PanelActionsProvider: React.FC<{
  sessionId?: string | null;
  children: React.ReactNode;
}> = ({ sessionId, children }) => {
  const actions = React.useMemo<PanelActions>(() => {
    const openInFilesTab = (file: { id: string; path: string; language: string; diffHunks?: DiffHunk[] }) => {
      if (!sessionId) return;
      const ui = useUi.getState();
      ui.openFile(sessionId, file);
      const tabs = useTabs.getState();
      tabs.addTab(sessionId, 'files');
      tabs.setActive(sessionId, 'files');
      ui.setRightPanel(true);
    };

    return {
      viewFile: (path) => {
        const resolved = path.trim();
        if (!resolved) return;
        openInFilesTab({ id: resolved, path: resolved, language: languageForPath(resolved) });
      },
      viewDiff: ({ path, hunks }) => {
        const resolved = path.trim();
        if (!resolved) return;
        openInFilesTab({
          id: resolved,
          path: resolved,
          language: languageForPath(resolved),
          ...(hunks && hunks.length > 0 ? { diffHunks: hunks } : {}),
        });
      },
      openDispatch: (toolCallId) => {
        if (!sessionId || !toolCallId) return;
        const ui = useUi.getState();
        ui.setFocusedDispatch(sessionId, toolCallId);
        const tabs = useTabs.getState();
        tabs.addTab(sessionId, 'agents');
        tabs.setActive(sessionId, 'agents');
        ui.setRightPanel(true);
      },
    };
  }, [sessionId]);

  return <PanelActionsContext.Provider value={actions}>{children}</PanelActionsContext.Provider>;
};

// oxlint-disable-next-line react/only-export-components -- context+hook co-location follows the agent-nesting-context.tsx precedent (T4).
export const usePanelActions = (): PanelActions | null => React.useContext(PanelActionsContext);
