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
 * - Tail-follow writes are INSTANT and land pre-paint: from the layout
 *   effect on React commits, and from a ResizeObserver on every content
 *   growth between commits (markdown re-flow, image loads, virtualizer
 *   measure corrections). An eased chase lags the tail by design, and a
 *   second writer racing browser layout each commit is the up-down bob —
 *   so easing survives only as choreography: the send-pin anchor drift
 *   and the turn-end settle glide (animateTo; long jumps snap, and
 *   prefers-reduced-motion disables the easing entirely).
 * - Bottom pins overshoot when they target raw scrollHeight (integer-
 *   rounded) so the engine clamps to the exact fractional maximum;
 *   sentinel-based targets are already subpixel-exact and skip it.
 * - Bottom re-engage is direction-aware: downward motion into the bottom
 *   band resumes follow, upward motion releases it even when it lands
 *   inside the band — small scroll-ups must never be yanked back.
 * - Session switches pin to the bottom and STAY pinned while the
 *   switched-to history lands (entry-stick): growth re-pins continue for
 *   a bounded window (quiescence ends it early, upward user scroll
 *   cancels it) since post-switch growth is history arriving, not a live
 *   turn the streaming-only follow would cover. During the window a
 *   spacer below the content gives the pin a blank buffer: growth lands
 *   in blank space instead of visibly pushing the viewport down frame by
 *   frame, and re-pins move through blank. Quiescence glides to the
 *   exact content bottom before the spacer unmounts.
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
// Overshoot for raw scroll-bottom writes: scrollHeight rounds to integers
// while real layout is fractional, so an exact write can land 0–1px short
// and bottom-anchored rows jitter per streamed token; an over-large target
// clamps to the true fractional maximum instead.
const OVERSHOOT_PX = 4096;
// Session-entry re-pin window: after a switch the history lands over
// several commits (query load, virtualizer measure corrections, async
// blocks) so the bottom target keeps moving after the switch commit's own
// write. Entry-stick re-pins on every growth for a bounded window —
// quiescence (no growth write for 500ms) ends it early, a hard cap bounds
// it, and any upward user scroll cancels it immediately.
const ENTRY_STICK_QUIESCENT_MS = 500;
const ENTRY_STICK_MAX_MS = 3000;
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
  sessionKey?: string | null,
  /** Turn is paused at a permission gate — content is frozen. The follow
   *  chase must not re-target on re-renders (card countdown ticks, inline
   *  card mounts) or the viewport visibly fights the user. */
  paused = false,
) {
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Session-entry stick active — ChatTimeline mounts the entry spacer
  // (blank buffer below the content) while this is true.
  const [entrySticking, setEntrySticking] = useState(false);
  // Mirrors for the ResizeObserver callback, which fires outside React's
  // render cycle and must see the same gates the render path applies.
  const atBottomRef = useRef(true);
  const isStreamingRef = useRef(false);
  const pausedRef = useRef(false);
  const lastScrollTop = useRef(0);
  // Session-entry stick deadline (0 = inactive) + quiescence timer.
  const entryStickUntil = useRef(0);
  const entryQuietTimer = useRef<number | null>(null);
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
  // Set when a send establishes the pin: the first scroll to the pin
  // position must land before the browser paints — an eased sweep here
  // reads as a delay between send and the jump to the pinned view.
  const pinFresh = useRef(false);
  const onArrive = useRef<(() => void) | null>(null);
  const lastFrame = useRef(0);
  const prevSessionKey = useRef(sessionKey);

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

  /** Instant scroll write for bottom pins. Sentinel-based targets are
   *  subpixel-exact as-is; the raw scrollHeight fallback rounds to integers,
   *  so it overshoots and lets the engine clamp to the true fractional
   *  maximum (see OVERSHOOT_PX). */
  const writeScroll = useCallback((el: HTMLElement, target: number) => {
    el.scrollTop = el.querySelector('[data-timeline-end]') ? target : target + OVERSHOOT_PX;
  }, []);

  /** Follow geometry: the pinned anchor's viewport-top scroll position
   *  (null when no live pin) and the sentinel-based content bottom. Pure —
   *  the layout effect owns pinEl lifecycle, this only reads it. */
  const followTarget = useCallback((el: HTMLElement): { anchorTop: number | null; bottom: number } => {
    const bottom = contentMaxScroll(el);
    const anchorTop = pinEl.current
      ? pinEl.current.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - PIN_TOP_MARGIN
      : null;
    return { anchorTop, bottom };
  }, []);

  /** RO-side follow decision: tail-follow targets only, growth (downward)
   *  writes only, and only while the render path's gates hold — paused
   *  turns, the end-of-turn settle, in-flight eased writes, and the
   *  flip→append hold are all off-limits. During the session-entry window
   *  the target is the RAW bottom (spacer included): the buffer absorbs
   *  post-switch growth so the viewport does not chase the moving content
   *  end frame by frame. */
  const computeFollow = useCallback((el: HTMLElement): number | null => {
    if (pausedRef.current || settling.current || animTarget.current !== null) return null;
    if (performance.now() < entryStickUntil.current) {
      return el.scrollHeight - el.scrollTop - el.clientHeight > 1 ? el.scrollHeight - el.clientHeight : null;
    }
    const bottom = contentMaxScroll(el);
    if (pinEl.current) {
      if (!pinEl.current.isConnected || !isStreamingRef.current) return null;
      const anchorTop =
        pinEl.current.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - PIN_TOP_MARGIN;
      return bottom > anchorTop && bottom > el.scrollTop + 1 ? bottom : null;
    }
    return isStreamingRef.current && atBottomRef.current && bottom > el.scrollTop + 1 ? bottom : null;
  }, []);

  /** Arm the entry-stick window: hard cap from now, quiescence timer that
   *  ends it once growth writes stop for ENTRY_STICK_QUIESCENT_MS. */
  const armEntryStick = useCallback(() => {
    entryStickUntil.current = performance.now() + ENTRY_STICK_MAX_MS;
    setEntrySticking(true);
    if (entryQuietTimer.current !== null) clearTimeout(entryQuietTimer.current);
    entryQuietTimer.current = window.setTimeout(() => {
      entryQuietTimer.current = null;
      entryStickUntil.current = 0;
      const el = scrollRef.current;
      if (!el) {
        setEntrySticking(false);
        return;
      }
      // Glide from the blank entry buffer down to the exact content bottom
      // before dropping the spacer — unmounting it while scrollTop sits in
      // the buffer would clamp the viewport up in one frame. The timer is
      // the backstop if the glide is canceled (see scrollToBottom).
      settling.current = true;
      const finish = () => {
        settling.current = false;
        setEntrySticking(false);
      };
      animateTo(contentMaxScroll(el), finish);
      settleTimer.current = window.setTimeout(finish, 500);
    }, ENTRY_STICK_QUIESCENT_MS);
  }, [animateTo, scrollRef]);

  /** Cancel entry-stick (upward user scroll, explicit jump-to-bottom, or
   *  unmount takes the viewport). */
  const cancelEntryStick = useCallback(() => {
    entryStickUntil.current = 0;
    if (entryQuietTimer.current !== null) {
      clearTimeout(entryQuietTimer.current);
      entryQuietTimer.current = null;
    }
    setEntrySticking(false);
  }, []);

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
    cancelEntryStick();
    pinEl.current = null;
    setPinned(false);
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(false);
    stopAnim();
    const el = scrollRef.current;
    if (el) {
      writeScroll(el, contentMaxScroll(el));
      // Sync the direction tracker so the jump's own scroll event reads as
      // arrival, not upward motion that would release the follow we just set.
      lastScrollTop.current = el.scrollTop;
    }
  }, [scrollRef, cancelSettle, cancelAppendWait, cancelEntryStick, stopAnim, writeScroll]);

  // Track whether the viewport sits at the content bottom — direction-aware:
  // downward motion into the band re-engages follow and clears unread;
  // ANY upward motion releases, even when it lands inside the band, or a
  // small scroll-up mid-stream would be yanked straight back down (the
  // dead-zone fight). Never clears the pin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const dir = top > lastScrollTop.current ? 1 : top < lastScrollTop.current ? -1 : 0;
      lastScrollTop.current = top;
      const inBand = contentMaxScroll(el) - top <= NEAR_BOTTOM;
      if (inBand && dir >= 0) {
        atBottomRef.current = true;
        setAtBottom(true);
        setUnread(false);
      } else if (dir < 0 || !inBand) {
        atBottomRef.current = false;
        setAtBottom(false);
        // Upward motion cancels the session-entry stick — the user is
        // deliberately leaving the tail and must not be yanked back while
        // the switched-to history is still landing.
        if (dir < 0) cancelEntryStick();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, cancelEntryStick]);

  // Instant pre-paint re-pin on content growth. React commits batch at the
  // stream cadence, but layout keeps moving between them (markdown re-flow,
  // image loads, virtualizer measure corrections, mermaid mounts); the
  // ResizeObserver fires after layout and before paint, so the tail stays
  // glued every frame without a chasing animation. Growth-only writes —
  // the turn-end settle and send-pin drift stay owned by animateTo.
  // Entry-stick writes extend their own quiescence window here, since
  // post-switch growth (history landing) arrives between commits too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const entry = performance.now() < entryStickUntil.current;
      const target = computeFollow(el);
      if (target !== null) {
        // Raw bottom (spacer included) → the engine clamps into the blank
        // buffer, so per-frame growth never visibly moves the viewport.
        writeScroll(el, entry ? target + OVERSHOOT_PX : target);
        if (entry) armEntryStick();
      }
    });
    if (el.firstElementChild instanceof HTMLElement) ro.observe(el.firstElementChild);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, computeFollow, writeScroll, armEntryStick]);

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
      cancelEntryStick();
    },
    [cancelSettle, cancelAppendWait, stopAnim, cancelEntryStick],
  );

  // Pin establishment + follow. setPinned re-renders (mounting the spacer)
  // before the browser paints; the pin landing is itself instant (pinFresh)
  // and the anchor's residual drift glides via animateTo.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setStates fire only on message growth or pin detach, both self-quenching
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    isStreamingRef.current = isStreaming;
    pausedRef.current = paused;
    // Session switch: every piece of scroll state is stale — the pin points
    // at detached DOM, prevMessageCount belongs to the old chat (a count
    // that happens to grow by one user message would pin falsely), and the
    // viewport must land at the new chat's bottom before paint. Runs before
    // the grewBy bookkeeping so the switch commit is never read as a send.
    if (sessionKey !== prevSessionKey.current) {
      prevSessionKey.current = sessionKey;
      cancelSettle();
      cancelAppendWait();
      stopAnim();
      pinEl.current = null;
      pinFresh.current = false;
      prevMessageCount.current = messageCount;
      setPinned(false);
      atBottomRef.current = true;
      setAtBottom(true);
      setUnread(false);
      // History for the switched-to session lands over the next several
      // commits and measure corrections — arm entry-stick and let the NEXT
      // commit (spacer mounted, still pre-paint) land the viewport in the
      // blank buffer. Writing here would target the un-buffered bottom, and
      // the spacer mounting a commit later would visibly bounce the view.
      armEntryStick();
      lastScrollTop.current = el.scrollTop;
      return;
    }
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
        pinFresh.current = true;
        setPinned(true);
        atBottomRef.current = false;
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
    // Permission-gated pause: content is frozen and the permission UI is
    // up. Bail BEFORE the chase — re-renders during the pause (card mount,
    // countdown ticks) would otherwise re-target the bottom every commit
    // and visibly fight the user. Bookkeeping above still ran, so nothing
    // is misread as growth when the turn resumes.
    if (paused) return;
    if (settling.current) return;
    // Follow writes. Tail-follow (pinned with content past the anchor, or
    // atBottom while streaming) is instant and pre-paint; the ResizeObserver
    // repeats it on growth between commits. atBottom-follow stays
    // STREAMING-ONLY: after the turn ends it must not re-target the bottom
    // on every re-render, or expanding a collapsed container (which grows
    // the content) yanks the viewport away from the row the user just
    // clicked. Eased motion survives only as choreography: send-pin anchor
    // drift and the turn-end settle glide.
    const { anchorTop, bottom } = followTarget(el);
    const entryActive = performance.now() < entryStickUntil.current;
    if (anchorTop !== null) {
      if (pinFresh.current) {
        stopAnim();
        el.scrollTop = Math.max(anchorTop, bottom);
        pinFresh.current = false;
      } else if (anchorTop >= bottom) {
        // Convergence guard: skip no-op writes — repeated commits make even
        // those visible as jitter on some drivers.
        if (Math.abs(anchorTop - el.scrollTop) > 1) animateTo(anchorTop);
      } else if (Math.abs(bottom - el.scrollTop) > 1) {
        stopAnim();
        writeScroll(el, bottom);
      }
    } else if (entryActive && Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) > 1) {
      // Raw bottom, spacer included — same buffer rationale as the RO path.
      // Takes precedence over streaming-follow while the window is open, or
      // the sentinel-bottom write would land first and the buffered RO
      // write would visibly bounce the viewport a commit later.
      stopAnim();
      writeScroll(el, el.scrollHeight);
    } else if (isStreaming && atBottom && Math.abs(bottom - el.scrollTop) > 1) {
      stopAnim();
      writeScroll(el, bottom);
    }
    // After the follow so the collapse decision reads the final tail
    // position, not the pre-append one.
    if (finalizeLanded) endTurn(el);
  });

  return { atBottom, unread, pinned, entrySticking, scrollToBottom };
}
