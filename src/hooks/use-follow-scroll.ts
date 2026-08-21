import { useEffect, useRef, useState, type RefObject } from 'react';

/** Pure engagement reducer — exported for tests. */
export function nextEngagement(s: { engaged: boolean; active: boolean; userScrolledUp: boolean; nearBottom: boolean }): boolean {
  if (!s.active) return false;
  if (s.userScrolledUp && !s.nearBottom) return false;
  return s.nearBottom ? true : s.engaged;
}

const NEAR_BOTTOM_PX = 24;

/** Sticky auto-follow for a scrollable streaming panel: pins scrollTop to the
 * bottom while content grows, disengages on user scroll-up, re-engages when
 * the user returns to (near) the bottom. Programmatic self-scrolls don't
 * disengage (flagged around our own writes). */
export function useFollowScroll(ref: RefObject<HTMLElement | null>, active: boolean) {
  const engagedRef = useRef(true);
  const selfScrollRef = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const userMovesUp = (e: WheelEvent | TouchEvent) => {
      const up = e instanceof WheelEvent ? e.deltaY < 0 : true;
      if (up && !selfScrollRef.current) {
        engagedRef.current = false;
        force((n) => n + 1);
      }
    };
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      const next = nextEngagement({ engaged: engagedRef.current, active, userScrolledUp: !near && !selfScrollRef.current, nearBottom: near });
      if (next !== engagedRef.current) {
        engagedRef.current = next;
        force((n) => n + 1);
      }
    };
    el.addEventListener('wheel', userMovesUp, { passive: true });
    el.addEventListener('touchmove', userMovesUp, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', userMovesUp);
      el.removeEventListener('touchmove', userMovesUp);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, active]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active || !engagedRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!engagedRef.current) return;
      selfScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        selfScrollRef.current = false;
      });
    });
    const observeChildren = () => {
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    // ResizeObserver reports box-size changes only — scrollHeight growth from
    // appended children never fires on el itself, so re-observe children as
    // the subtree mutates (ro.observe on an observed node is a spec no-op).
    const mo = new MutationObserver(observeChildren);
    ro.observe(el);
    observeChildren();
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, active]);

  useEffect(() => {
    if (!active) engagedRef.current = true;
  }, [active]);

  return { engaged: engagedRef.current };
}
