/**
 * NEW Tide module (no upstream equivalent) — pre-flight Ruling 4 / task-4 R4.
 * Replaces the upstream's child-session model (`taskToolModel.ts` +
 * `useSessionMessageRecords`, both excluded from the port): Tide keeps agent
 * nesting inside the message stream itself — every part produced by a
 * dispatched sub-agent carries `metadata.parentToolCallId` (see
 * `lib/tide-adapter.ts` and the invariant documented at `src/types/block.ts`).
 * The provider (Task 6, `chat-message.tsx`) indexes those parts into
 * `childPartsByToolCallId`; the `dispatch_agent` renderer then renders a
 * nested, indented ToolPart list from the same map. Depth beyond one level
 * works for free because each nested ToolPart reads the same map.
 *
 * The default value is an empty map so every consumer works without a
 * Provider (T4 ships before the T6 provider).
 */

import React from 'react';

import type { TimelinePart } from '../types/message-parts';

export interface AgentNestingContextValue {
  childPartsByToolCallId: Map<string, TimelinePart[]>;
}

const EMPTY_CHILD_PARTS = new Map<string, TimelinePart[]>();

// oxlint-disable-next-line react/only-export-components -- context object + hooks + provider are one leaf module by design (T4 owns it; T6 mounts the provider)
export const AgentNestingContext = React.createContext<AgentNestingContextValue>({
  childPartsByToolCallId: EMPTY_CHILD_PARTS,
});

// oxlint-disable-next-line react/only-export-components -- hook export beside the context object (leaf module, no fast-refresh concern)
export const useAgentNesting = (): AgentNestingContextValue => {
  return React.useContext(AgentNestingContext);
};

// oxlint-disable-next-line react/only-export-components -- hook export beside the context object (leaf module, no fast-refresh concern)
export const useChildToolParts = (toolCallId: string | undefined): TimelinePart[] => {
  const { childPartsByToolCallId } = useAgentNesting();
  return React.useMemo(
    () => (toolCallId ? childPartsByToolCallId.get(toolCallId) ?? [] : []),
    [childPartsByToolCallId, toolCallId],
  );
};

// oxlint-disable-next-line react/only-export-components -- provider component sits beside the context/hooks it wraps (leaf module)
export const AgentNestingProvider: React.FC<{
  value: AgentNestingContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => {
  const { childPartsByToolCallId } = value;
  const contextValue = React.useMemo(() => ({ childPartsByToolCallId }), [childPartsByToolCallId]);
  return <AgentNestingContext.Provider value={contextValue}>{children}</AgentNestingContext.Provider>;
};
