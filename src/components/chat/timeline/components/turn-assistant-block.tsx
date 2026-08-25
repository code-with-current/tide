/**
 * Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/components/TurnAssistantBlock.tsx.
 * Near-verbatim; only the import path is rewritten. Named export per project
 * convention instead of upstream's default export.
 */

import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
  assistantMessages: ChatMessageEntry[];
  renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage }) => {
  return (
    <div className="relative z-0">
      {assistantMessages.map((message) => renderMessage(message))}
    </div>
  );
};

export const TurnAssistantBlockMemoized = React.memo(TurnAssistantBlock);
