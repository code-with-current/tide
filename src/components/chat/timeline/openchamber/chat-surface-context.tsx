/**
 * Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/ChatSurfaceContext.tsx
 * + chatSurfaceContextValue.ts + useChatSurfaceMode.ts (3 files merged into one shim).
 * OpenChamber port seam: Tide is a desktop app with a single chat surface, so the
 * context is a constant `'default'` — the mobile ('mini-chat') and /btw ('peek')
 * provider branches are not ported; the mode union is kept so consumer code
 * ports unchanged.
 */

import React from 'react';

/**
 * 'mini-chat' is the browser-panel side chat (compact, no fork/plan actions).
 * 'peek' is a read-only glance surface (the /btw panel): messages render with
 * no per-message controls at all — no user action row, no assistant action
 * buttons, no turn footer.
 */
export type ChatSurfaceMode = 'default' | 'mini-chat' | 'peek';

// oxlint-disable-next-line react/only-export-components -- context object beside its provider (leaf shim, matches agent-nesting-context precedent)
export const ChatSurfaceContext = React.createContext<ChatSurfaceMode>('default');

// oxlint-disable-next-line react/only-export-components -- hook export beside the context object (leaf shim module)
export const useChatSurfaceMode = (): ChatSurfaceMode => React.useContext(ChatSurfaceContext);

// OpenChamber port seam: upstream takes `mode` from the app shell; Tide always mounts desktop.
export const ChatSurfaceProvider: React.FC<{ mode?: ChatSurfaceMode; children: React.ReactNode }> = ({
  mode = 'default',
  children,
}) => <ChatSurfaceContext.Provider value={mode}>{children}</ChatSurfaceContext.Provider>;
