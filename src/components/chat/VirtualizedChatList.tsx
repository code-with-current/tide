import { useState, useEffect, useRef } from 'react';
import type { Message } from '@/types';
import { ChatMessage } from './ChatMessage';

/**
 * Windowed chat message list — unmounts messages far outside the viewport and
 * replaces them with a spacer of their last-measured height.
 *
 * Unlike full virtualization (absolute positioning + translateY), this keeps
 * the existing flex layout + scroll container intact: messages still flow
 * normally, just off-screen ones become cheap spacers. This avoids the
 * regression risk to streaming/auto-scroll that a rewrite would carry, while
 * still removing the DOM cost of hundreds of heavy ChatMessage trees (each
 * with markdown + code blocks) in long sessions.
 *
 * Uses IntersectionObserver per message to detect visibility. When a message
 * leaves the viewport (with a buffer), its rendered content is swapped for a
 * spacer div of the recorded height; scrolling back re-renders it. Heights
 * are cached so the scrollbar stays stable across windowing cycles.
 *
 * NOT virtualized: the streaming message (always at the bottom, always
 * visible) and the error banner. The parent passes them as children.
 */
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
        <ChatMessage message={message} />
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
