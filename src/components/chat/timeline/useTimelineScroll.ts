/** Scroll logic for ChatTimeline: pixel-band at-bottom detection + layout-effect follow. */

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const NEAR_BOTTOM = 60;
const SCROLL_UP_SENSITIVITY = 4;

export function useTimelineScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  isStreaming: boolean,
  messageCount: number,
) {
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(false);
  const lastScrollTop = useRef(0);
  const prevMessageCount = useRef(messageCount);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      if (top < lastScrollTop.current - SCROLL_UP_SENSITIVITY) {
        setAtBottom(false);
        if (isStreaming) setUnread(true);
      }
      if (max - top <= NEAR_BOTTOM) {
        setAtBottom(true);
        setUnread(false);
      }
      lastScrollTop.current = top;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, isStreaming]);

  // Stick to bottom on every render — runs before paint, no flicker.
  useLayoutEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  useEffect(() => {
    if (messageCount > prevMessageCount.current && atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevMessageCount.current = messageCount;
  }, [messageCount, atBottom, scrollRef]);

  const scrollToBottom = useCallback(() => {
    setAtBottom(true);
    setUnread(false);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [scrollRef]);

  return { atBottom, unread, scrollToBottom };
}
