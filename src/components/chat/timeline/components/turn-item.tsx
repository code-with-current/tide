import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import { TurnAssistantBlockMemoized as TurnAssistantBlock } from './turn-assistant-block';

interface TurnItemProps {
  turn: Turn;
  stickyUserHeader?: boolean;
  renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage }) => {
  return (
    <section
      className="relative w-full"
      id={`turn-${turn.turnId}`}
      data-turn-id={turn.turnId}
      data-scroll-spy-id={turn.turnId}
    >
      {stickyUserHeader ? (
        <div className="tide-sticky-user-header sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
          <div className="relative z-10">
            {renderMessage(turn.userMessage)}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-full z-0 h-4 bg-gradient-to-b from-[var(--surface-background)] to-transparent sm:h-8"
          />
        </div>
      ) : (
        renderMessage(turn.userMessage)
      )}

      <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />
    </section>
  );
};

export const TurnItemMemoized = React.memo(TurnItem);
