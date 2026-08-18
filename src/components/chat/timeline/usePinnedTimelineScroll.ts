/**
 * Scroll logic for ChatTimeline with "pin on send" behavior:
 * - New user message → pinned to the top of the viewport, old history above
 *   it scrolled off-screen. ChatTimeline renders a viewport-tall spacer
 *   below the content while a turn is live — without that scroll room the
 *   browser clamps scrollTop to scrollHeight - clientHeight and the last
 *   message can never reach the top.
 * - While pinned, the view follows max(anchor, content bottom): it stays on
 *   the user message until the response overflows the viewport, then
 *   follows the tail. The [data-timeline-end] sentinel marks the real
 *   content bottom so following ignores the spacer.
 * - All programmatic scrolls run through one eased rAF chase (animateTo):
 *   re-targeting the moving tail each render glides instead of stepping,
 *   and the send-pin lands with a short sweep rather than a snap. Jumps
 *   longer than a few viewports (session switches) snap, and
 *   prefers-reduced-motion disables the easing entirely.
 * - The pin is cleared by genuine user input (wheel up, scrollbar drag,
 *   touch pan, scroll keys) or when the turn ends — never by interpreting
 *   scroll positions, since programmatic writes during streaming make
 *   position-based heuristics unreliable.
 *
 * Kept separate from useTimelineScroll so the two behaviors can be compared
 * and swapped without entangling the stable default.
 */

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const NEAR_BOTTOM = 60;
const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
const TOUCH_SLOP = 10;
// Exponential ease time constant: ~63% of the remaining distance per 90ms,
// so any target is effectively reached in ~450ms regardless of distance.
const EASE_TAU_MS = 90;
// Distances beyond this many viewports snap instead of gliding — sweeping
// through an entire session history on switch/load reads as lag, not polish.
const SNAP_VIEWPORTS = 3;
// Breathing room between the pinned user bubble and the viewport top edge.
const PIN_TOP_MARGIN = 16;

// Max scrollTop that puts the content end (sentinel, not the spacer) at the
// viewport bottom. Falls back to the scroll bottom without a sentinel.
function contentMaxScroll(el: HTMLElement) {
  const end = el.querySelector<HTMLElement>('[data-timeline-end]');
  if (!end) return el.scrollHeight - el.clientHeight;
  return end.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop - el.clientHeight;
}

export function usePinnedTimelineScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  isStreaming: boolean,
  messageCount: number,
  lastRole?: 'user' | 'assistant',
) {
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(false);
  const [pinned, setPinned] = useState(false);
  const prevMessageCount = useRef(messageCount);
  const pinEl = useRef<HTMLElement | null>(null);
  // True while the end-of-turn glide to the resting position is running —
  // the spacer must stay mounted until it finishes and the per-render
  // follow must not interrupt it.
  const settling = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const appendWait = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  const animTarget = useRef<number | null>(null);
  const onArrive = useRef<(() => void) | null>(null);
  const lastFrame = useRef(0);

  const cancelSettle = useCallback(() => {
    settling.current = false;
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);

  const cancelAppendWait = useCallback(() => {
    if (appendWait.current !== null) {
      clearTimeout(appendWait.current);
      appendWait.current = null;
    }
  }, []);

  const stopAnim = useCallback(() => {
    animTarget.current = null;
    onArrive.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  const step = useCallback(
    (now: number) => {
      rafId.current = null;
      const el = scrollRef.current;
      const target = animTarget.current;
      if (!el || target === null) return;
      const dt = Math.min(now - lastFrame.current, 100);
      lastFrame.current = now;
      const next = el.scrollTop + (target - el.scrollTop) * (1 - Math.exp(-dt / EASE_TAU_MS));
      if (Math.abs(target - next) < 0.5) {
        el.scrollTop = target;
        animTarget.current = null;
        const cb = onArrive.current;
        onArrive.current = null;
        cb?.();
        return;
      }
      el.scrollTop = next;
      rafId.current = requestAnimationFrame(step);
    },
    [scrollRef],
  );

  // Eased scroll toward `target`; while animating, later calls just
  // re-target, which is what turns per-render tail writes into a glide.
  const animateTo = useCallback(
    (target: number, onDone?: () => void) => {
      const el = scrollRef.current;
      if (!el) return;
      if (
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        Math.abs(target - el.scrollTop) > el.clientHeight * SNAP_VIEWPORTS
      ) {
        stopAnim();
        el.scrollTop = target;
        onDone?.();
        return;
      }
      animTarget.current = target;
      onArrive.current = onDone ?? null;
      if (rafId.current === null) {
        lastFrame.current = performance.now();
        rafId.current = requestAnimationFrame(step);
      }
    },
    [scrollRef, step, stopAnim],
  );

  // Collapse the pin + spacer once the turn's content is final. Unmounting
  // the spacer while scrollTop exceeds the post-collapse maximum would snap
  // the content down in one frame — glide to the resting position first,
  // with the spacer still mounted, and unmount on arrival (the timer is the
  // backstop if the glide is canceled). When the viewport already sits at
  // the content bottom the spacer drops instantly.
  const endTurn = useCallback(
    (el: HTMLElement) => {
      cancelAppendWait();
      if (pinEl.current === null) return;
      pinEl.current = null;
      const rest = contentMaxScroll(el);
      const settle = () => {
        settling.current = false;
        if (!pinEl.current) setPinned(false);
      };
      if (el.scrollTop > rest + 1) {
        settling.current = true;
        animateTo(rest, settle);
        settleTimer.current = window.setTimeout(settle, 500);
      } else {
        settling.current = false;
        setPinned(false);
      }
    },
    [cancelAppendWait, animateTo],
  );

  const scrollToBottom = useCallback(() => {
    cancelSettle();
    cancelAppendWait();
    pinEl.current = null;
    setPinned(false);
    setAtBottom(true);
    setUnread(false);
    const el = scrollRef.current;
    if (el) animateTo(contentMaxScroll(el));
  }, [scrollRef, cancelSettle, cancelAppendWait, animateTo]);

  // Track whether the viewport sits at the content bottom, and clear unread
  // when the user returns to the tail. Never clears the pin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (contentMaxScroll(el) - el.scrollTop <= NEAR_BOTTOM) {
        setAtBottom(true);
        setUnread(false);
      } else {
        setAtBottom(false);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // The pin ends only on deliberate user navigation away from the live
  // exchange: wheel up, scrollbar drag, touch pan, or scroll keys.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const userNavigates = () => {
      pinEl.current = null;
      // During the end-of-turn settle, the glide must run to completion —
      // it is what makes the spacer collapse clamp-free.
      if (!settling.current) {
        stopAnim();
        setPinned(false);
      }
      if (isStreaming) setUnread(true);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) userNavigates();
    };
    const onKey = (e: KeyboardEvent) => {
      if (NAV_KEYS.includes(e.key)) userNavigates();
    };
    // Scrollbar drags fire no wheel/key/touch events — recognize the press
    // by landing in the gutter strip beyond clientWidth instead.
    const onMouseDown = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.left + el.clientWidth) userNavigates();
    };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null) return;
      const y = e.touches[0]?.clientY;
      if (y !== undefined && Math.abs(y - touchY) > TOUCH_SLOP) {
        touchY = null;
        userNavigates();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [scrollRef, isStreaming, stopAnim]);

  // The stream-end flip removes the streaming message a commit or two before
  // the freeze effect appends the persisted one, so the content height at the
  // flip is NOT final. Arm a fallback and let the layout effect run endTurn
  // when the append lands (finalizeLanded); the timer only fires for turns
  // that append nothing (empty/error turns).
  useEffect(() => {
    if (!isStreaming) {
      const el = scrollRef.current;
      if (el) {
        appendWait.current = window.setTimeout(() => {
          appendWait.current = null;
          endTurn(el);
        }, 250);
      }
    } else {
      cancelAppendWait();
    }
  }, [isStreaming, scrollRef, endTurn, cancelAppendWait]);

  useEffect(
    () => () => {
      cancelSettle();
      cancelAppendWait();
      stopAnim();
    },
    [cancelSettle, cancelAppendWait, stopAnim],
  );

  // Pin establishment + follow. setPinned re-renders (mounting the spacer)
  // before the browser paints; the eased chase then sweeps the user message
  // to the viewport top.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setStates fire only on message growth or pin detach, both self-quenching
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinEl.current && !pinEl.current.isConnected) {
      pinEl.current = null;
      cancelAppendWait();
      if (pinned) setPinned(false);
    }
    const grewBy = messageCount - prevMessageCount.current;
    prevMessageCount.current = messageCount;
    // Exactly one new message ending in a user turn is a send; larger jumps
    // are session loads/switches and must not pin.
    if (grewBy === 1 && lastRole === 'user') {
      const userMessages = el.querySelectorAll<HTMLElement>('[data-user-message]');
      const last = userMessages[userMessages.length - 1];
      if (last) {
        cancelSettle();
        cancelAppendWait();
        pinEl.current = last;
        setPinned(true);
        setAtBottom(false);
        setUnread(false);
      }
    }
    // The persisted assistant message landing after the stream-end flip:
    // the turn's content is final now, so endTurn may collapse the pin.
    const finalizeLanded = grewBy === 1 && lastRole === 'assistant' && !isStreaming;
    // Hold position between the flip and the append — the streaming message
    // is gone and following the shrunken content would bounce the view up.
    if (!finalizeLanded && !isStreaming && pinEl.current) {
      stopAnim();
      return;
    }
    if (settling.current) return;
    // The chase lags the tail by design, so an in-flight animation keeps
    // the follow alive even when the lag pushes atBottom outside its band.
    const target = pinEl.current
      ? Math.max(
          pinEl.current.getBoundingClientRect().top -
            el.getBoundingClientRect().top +
            el.scrollTop -
            PIN_TOP_MARGIN,
          contentMaxScroll(el),
        )
      : atBottom || animTarget.current !== null
        ? contentMaxScroll(el)
        : null;
    if (target !== null) animateTo(target);
    // After the follow so the collapse decision reads the final tail
    // position, not the pre-append one.
    if (finalizeLanded) endTurn(el);
  });

  return { atBottom, unread, pinned, scrollToBottom };
}
