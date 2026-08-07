import { memo } from 'react';
import type { Message } from '@/types';
import { ChatMessage } from './ChatMessage';

/** Content-visibility virtualized chat list: off-screen messages skip layout/paint (browser-native virtualization) but stay in the DOM (no mount/unmount flash). */
export const VirtualizedChatList = memo(function VirtualizedChatList({
  messages,
}: {
  messages: Message[];
}) {
  return (
    <>
      {messages.map((msg) => (
        <div
          key={msg.id}
          style={{
            contentVisibility: 'auto',
            containIntrinsicSize: 'auto 200px',
          }}
        >
          <ChatMessage message={msg} stopReason={msg.stopReason} />
        </div>
      ))}
    </>
  );
});
