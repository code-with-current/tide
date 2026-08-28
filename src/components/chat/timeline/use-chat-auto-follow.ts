/** Auto-follow scroll hook for the chat timeline.
 *
 *  - Auto-follow is on unless the user scrolled up (`released`), AND passive
 *    following only acts while the session is active (streaming, plus a short
 *    settle window). When idle, content-size changes are layout churn rather
 *    than live growth — re-pinning then would fight the virtualizer.
 *  - Following the bottom is INSTANT — `scrollTop` write inside the content
 *    ResizeObserver (after layout, before paint). No easing loop, no settle
 *    burst: never two writers racing for scrollTop.
 *  - A short-lived "auto" marker (position + TTL) lets the scroll handler
 *    distinguish our own programmatic writes from genuine user scrolling.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type AutoFollowState = 'following' | 'released';

const SETTLE_MS = 300;
const AUTO_MARK_TTL_MS = 1500;
const AUTO_MATCH_TOLERANCE_PX = 2;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;
// Permanent bottom spacer is 10vh — its height is how far above scrollHeight
// the user can be while still looking at "empty" space, so it doubles as the
// bottom-zone threshold for re-pinning and for the jump-to-bottom button.
const BOTTOM_SPACER_VH = 0.1;
const MIN_BOTTOM_ZONE_PX = 48;
// Entry-stick window. On a session switch the history lands over several
// commits (query load, virtualizer measure corrections, async blocks) and can
// strand the viewport mid-history after the first pin. A short window on
// entry forces the bottom on every growth; it ends QUIESCENCE_MS after growth
// stops (capped by MAX_MS) or instantly on a real user gesture.
const ENTRY_STICK_QUIESCENCE_MS = 600;
const ENTRY_STICK_MAX_MS = 8000;

const now = () => performance.now();

const distanceFromBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight;

const canScroll = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 1;

const bottomZoneThreshold = (el: HTMLElement) =>
  Math.max(MIN_BOTTOM_ZONE_PX, el.clientHeight * BOTTOM_SPACER_VH);

const isNearBottom = (el: HTMLElement) =>
  distanceFromBottom(el) <= bottomZoneThreshold(el);

const isReleaseKey = (event: KeyboardEvent) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';
};

interface UseChatAutoFollowOptions {
  sessionId?: string | null;
  isStreaming: boolean;
}

export function useChatAutoFollow({ sessionId, isStreaming }: UseChatAutoFollowOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const lastSeenContainerRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<AutoFollowState>('following');
  const [showScrollButton, setShowScrollButton] = useState(false);

  // stateRef is the single source of truth; React state mirrors it for rendering.
  const stateRef = useRef<AutoFollowState>('following');
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  // settling keeps passive follow alive briefly after the stream stops so the
  // final content lands at the bottom.
  const settlingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const lastSessionIdRef = useRef<string | null | undefined>(undefined);

  // Programmatic-scroll marker: the bottom position we last wrote and when.
  const autoRef = useRef<{ top: number; time: number } | null>(null);
  const autoTimerRef = useRef<number | null>(null);

  // Last observed scrollTop, to derive direction so the bottom-zone re-engage
  // only fires when arriving by scrolling down.
  const lastScrollTopRef = useRef(0);

  // Entry-stick window state.
  const entryStickRef = useRef(false);
  const entryStickQuietTimerRef = useRef<number | null>(null);
  const entryStickCapTimerRef = useRef<number | null>(null);
  const entryStickLastHeightRef = useRef(0);

  const setStateValue = useCallback((next: AutoFollowState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const isActive = useCallback(
    () => isStreamingRef.current || settlingRef.current,
    [],
  );

  // Detect when the scroll container DOM element changes (mount/remount) so
  // listener effects bind to the live element.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep-free effect: setState fires only when the DOM element changes
  useLayoutEffect(() => {
    if (scrollRef.current !== lastSeenContainerRef.current) {
      lastSeenContainerRef.current = scrollRef.current;
      setContainerEl(scrollRef.current);
    }
  });

  // ── auto marker ──────────────────────────────────────────────────────────
  const markAuto = useCallback((el: HTMLElement) => {
    autoRef.current = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: now(),
    };
    if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = window.setTimeout(() => {
      autoRef.current = null;
      autoTimerRef.current = null;
    }, AUTO_MARK_TTL_MS);
  }, []);

  const isAuto = useCallback((el: HTMLElement) => {
    const a = autoRef.current;
    if (!a) return false;
    if (now() - a.time > AUTO_MARK_TTL_MS) {
      autoRef.current = null;
      return false;
    }
    return Math.abs(el.scrollTop - a.top) < AUTO_MATCH_TOLERANCE_PX;
  }, []);

  // ── entry-stick window ───────────────────────────────────────────────────
  const endEntryStick = useCallback(() => {
    entryStickRef.current = false;
    if (entryStickQuietTimerRef.current !== null) {
      clearTimeout(entryStickQuietTimerRef.current);
      entryStickQuietTimerRef.current = null;
    }
    if (entryStickCapTimerRef.current !== null) {
      clearTimeout(entryStickCapTimerRef.current);
      entryStickCapTimerRef.current = null;
    }
  }, []);

  const armEntryStickQuiet = useCallback(() => {
    if (entryStickQuietTimerRef.current !== null) clearTimeout(entryStickQuietTimerRef.current);
    entryStickQuietTimerRef.current = window.setTimeout(() => {
      entryStickQuietTimerRef.current = null;
      endEntryStick();
    }, ENTRY_STICK_QUIESCENCE_MS);
  }, [endEntryStick]);

  const beginEntryStick = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    entryStickRef.current = true;
    entryStickLastHeightRef.current = el.scrollHeight;
    armEntryStickQuiet();
    if (entryStickCapTimerRef.current !== null) clearTimeout(entryStickCapTimerRef.current);
    entryStickCapTimerRef.current = window.setTimeout(() => {
      entryStickCapTimerRef.current = null;
      endEntryStick();
    }, ENTRY_STICK_MAX_MS);
  }, [armEntryStickQuiet, endEntryStick]);

  // ── scroll-to-bottom button ──────────────────────────────────────────────
  const updateButton = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !canScroll(el)) {
      setShowScrollButton(false);
      return;
    }
    setShowScrollButton(stateRef.current === 'released' && !isNearBottom(el));
  }, []);

  // ── core scroll primitive ────────────────────────────────────────────────
  const scrollToBottomNow = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    markAuto(el);
    // scrollHeight is integer-rounded while real content height is fractional,
    // so an exact write can land 0–1px short and oscillate per streamed token.
    // An over-large target clamps to the exact fractional maximum instead.
    const overshootTarget = el.scrollHeight + 4096;
    if (behavior === 'smooth') {
      el.scrollTo({ top: overshootTarget, behavior });
      return;
    }
    // Direct assignment bypasses any CSS scroll-behavior and lands same-frame.
    el.scrollTop = overshootTarget;
  }, [markAuto]);

  // force=true is a user-intent jump (clears released, always scrolls);
  // force=false is passive follow (only while following AND active).
  const scrollToBottom = useCallback((force: boolean, behavior: ScrollBehavior = 'auto') => {
    if (!force && !isActive()) return;
    if (!force && stateRef.current !== 'following') return;
    if (force && stateRef.current !== 'following') setStateValue('following');
    scrollToBottomNow(force ? behavior : 'auto');
  }, [isActive, scrollToBottomNow, setStateValue]);

  const stop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!canScroll(el)) {
      setStateValue('following');
      return;
    }
    if (stateRef.current === 'released') return;
    setStateValue('released');
    updateButton();
  }, [setStateValue, updateButton]);

  // ── public API ───────────────────────────────────────────────────────────
  const goToBottom = useCallback((mode: 'instant' | 'smooth' = 'instant') => {
    scrollToBottom(true, mode === 'smooth' ? 'smooth' : 'auto');
    updateButton();
  }, [scrollToBottom, updateButton]);

  const scrollToBottomOnSend = useCallback(() => {
    scrollToBottom(true);
  }, [scrollToBottom]);

  const releaseFromUserIntent = useCallback(() => {
    endEntryStick();
    stop();
  }, [endEntryStick, stop]);

  // ── session change ───────────────────────────────────────────────────────
  useEffect(() => {
    if (sessionId === lastSessionIdRef.current) return;
    lastSessionIdRef.current = sessionId;
    autoRef.current = null;
    if (!sessionId) return;
    setStateValue('following');
    scrollToBottom(true);
    beginEntryStick();
    updateButton();
  }, [sessionId, beginEntryStick, scrollToBottom, setStateValue, updateButton]);

  // When streaming starts while following, pin to the bottom. When it stops,
  // keep follow alive for a settle window so final content lands, then go
  // idle (passive follow disabled — see isActive).
  useEffect(() => {
    settlingRef.current = false;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (isStreaming) {
      scrollToBottom(true);
      return;
    }
    settlingRef.current = true;
    settleTimerRef.current = window.setTimeout(() => {
      settlingRef.current = false;
      settleTimerRef.current = null;
    }, SETTLE_MS);
  }, [isStreaming, scrollToBottom]);

  // ── scroll event handling ────────────────────────────────────────────────
  const handleScrollEvent = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const scrollingDown = el.scrollTop > previousTop + 0.5;

    updateButton();

    if (!canScroll(el)) {
      setStateValue('following');
      return;
    }

    // Within the bottom zone → (re-)pin to following — but only when arriving
    // by scrolling down (or already following / truly at bottom). A user
    // scrolling UP that merely lands in the spacer zone must not be yanked
    // back into follow (the dead-zone fight).
    if (isNearBottom(el)) {
      const atTrueBottom = distanceFromBottom(el) <= AUTO_MATCH_TOLERANCE_PX;
      if (scrollingDown || stateRef.current === 'following' || atTrueBottom) {
        setStateValue('following');
      }
      return;
    }

    // Our own geometry change (programmatic write whose scroll event landed
    // after newer content grew) — keep following, don't release.
    if (stateRef.current === 'following' && isAuto(el)) {
      scrollToBottom(false);
      return;
    }

    // A bare scroll event is ambiguous: layout churn (block collapse,
    // virtualizer re-measure, async renders) changes distanceFromBottom with
    // no gesture behind it, and releasing on those strands the user in
    // 'released' with a phantom "New Message" prompt. Every real gesture
    // path (wheel up, touch, release keys, scrollbar drag) already calls
    // releaseFromUserIntent explicitly — so here only an actual upward
    // movement of scrollTop counts as user release.
    if (el.scrollTop < previousTop - 0.5) stop();
  }, [isAuto, scrollToBottom, setStateValue, stop, updateButton]);

  useEffect(() => {
    const container = containerEl;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      releaseFromUserIntent();
    };

    let touchLastY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      touchLastY = event.touches.item(0)?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      if (!touch) {
        touchLastY = null;
        return;
      }
      const previousY = touchLastY;
      touchLastY = touch.clientY;
      if (previousY === null) return;
      if (touch.clientY - previousY <= TOUCH_FINGER_DOWN_THRESHOLD) return;
      releaseFromUserIntent();
    };
    const handleTouchEnd = () => {
      touchLastY = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isReleaseKey(event)) return;
      releaseFromUserIntent();
    };
    // Scrollbar drags fire no wheel/key/touch events — recognize the press in
    // the gutter strip beyond clientWidth.
    const handleMouseDown = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (event.clientX > rect.left + container.clientWidth) releaseFromUserIntent();
    };

    container.addEventListener('scroll', handleScrollEvent, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    container.addEventListener('keydown', handleKeyDown);
    container.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('scroll', handleScrollEvent);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      container.removeEventListener('keydown', handleKeyDown);
      container.removeEventListener('mousedown', handleMouseDown);
    };
  }, [containerEl, handleScrollEvent, releaseFromUserIntent]);

  // The heart of follow behaviour: the ResizeObserver fires after layout and
  // before paint, so re-pinning here is invisible — there is no "jump up then
  // catch up". Observe both the container and the inner content wrapper.
  useEffect(() => {
    const container = containerEl;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && !canScroll(el)) {
        setStateValue('following');
        updateButton();
        return;
      }
      updateButton();
      // Entry-stick window: force the bottom on every growth so late-landing
      // history can't strand the viewport mid-list. Only a real user gesture
      // clears the window.
      if (entryStickRef.current && el) {
        const grew = el.scrollHeight > entryStickLastHeightRef.current + 1;
        entryStickLastHeightRef.current = el.scrollHeight;
        scrollToBottom(true);
        if (grew) armEntryStickQuiet();
        return;
      }
      // Idle resize = layout churn (re-measurement, async renders), NOT live
      // growth. Never re-pin when idle, or tall items re-measuring as the
      // user scrolls cause an endless scroll-to-bottom/re-measure twitch.
      if (!isActive()) return;
      if (stateRef.current !== 'following') return;
      scrollToBottom(false);
    });
    observer.observe(container);
    const inner = container.firstElementChild;
    if (inner instanceof Element) observer.observe(inner);
    return () => observer.disconnect();
  }, [armEntryStickQuiet, containerEl, isActive, scrollToBottom, setStateValue, updateButton]);

  useEffect(
    () => () => {
      if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      endEntryStick();
    },
    [endEntryStick],
  );

  return { scrollRef, state, showScrollButton, goToBottom, scrollToBottomOnSend };
}
