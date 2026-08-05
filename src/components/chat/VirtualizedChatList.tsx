import { useState, useEffect, useRef } from 'react';
import type { Message } from '@/types';
import { ChatMessage } from './ChatMessage';

/** Windowed chat list: unmounts off-screen messages (replaced with height spacers) via IntersectionObserver, preserving the existing flex/scroll layout. */
const VISIBLE_BUFFER = 600; // px above/below viewport kept rendered

interface WindowedMessageProps {
  message: Message;
  scrollRoot: React.RefObject<HTMLElement | null>;
  cachedHeight: React.MutableRefObject<Record<string, number>>;
}

function WindowedMessage({ message, scrollRoot, cachedHeight }: WindowedMessageProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Start visible — far safer than guessing; IntersectionObserver will hide it
  // on the first pass if it's off-screen. Avoids a flash of empty spacers.
  const [visible, setVisible] = useState(true);

  // Observe visibility against the scroll root. When a message scrolls far
  // out of view, swap to a spacer; when it returns, re-render the content.
  useEffect(() => {
    const el = ref.current;
    const root = scrollRoot.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Cache the real height while visible so the spacer matches.
          if (entry.isIntersecting) {
            cachedHeight.current[message.id] = entry.target.getBoundingClientRect().height;
            setVisible(true);
          } else {
            // Only hide if it's well outside the buffer — IntersectionObserver
            // fires at the root edge, so add margin via rootMargin.
            setVisible(false);
          }
        }
      },
      { root, rootMargin: `${VISIBLE_BUFFER}px 0px ${VISIBLE_BUFFER}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [message.id, scrollRoot, cachedHeight]);

  const h = cachedHeight.current[message.id];

  if (visible) {
    return (
      <div ref={ref}>
        <ChatMessage message={message} stopReason={message.stopReason} />
      </div>
    );
  }
  // Spacer — keeps scrollbar position stable while the content is unmounted.
  return <div ref={ref} style={{ height: h ?? 100 }} aria-hidden />;
}

export function VirtualizedChatList({
  messages,
  scrollRef,
}: {
  messages: Message[];
  /** The parent's scroll container ref — IntersectionObserver roots here. */
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  // Per-message height cache, stable across renders.
  const cachedHeight = useRef<Record<string, number>>({});

  return (
    <>
      {messages.map((msg) => (
        <WindowedMessage
          key={msg.id}
          message={msg}
          scrollRoot={scrollRef}
          cachedHeight={cachedHeight}
        />
      ))}
    </>
  );
}
