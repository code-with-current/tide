/** ScrollTabs — horizontal scrolling tab strip with chevron buttons, the file-folder curved-bottom aesthetic on the active tab, drag-to-scroll, and leading/trailing slots. Wraps Radix Tabs. */

import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Root — owns value state. Passes through to Radix Tabs.Root. */
export const ScrollTabs = TabsPrimitive.Root;

type ScrollTabsListProps = React.ComponentProps<typeof TabsPrimitive.List> & {
  /** Optional node rendered before the scroll area + left chevron.
   *  Always visible — unaffected by overflow state. */
  leading?: React.ReactNode;
  /** Optional node rendered after the scroll area + right chevron.
   *  Typical use: "+ add tab" button, close-panel icon, action menu. */
  trailing?: React.ReactNode;
};

/**
 * The scroll container — tracks overflow via a scroll listener + ResizeObserver and fades chevrons in/out accordingly. Layout: `[leading]? [«] [scroll-area] [»] [trailing]?`. The scroll area is the Radix TabsPrimitive.List so a11y semantics (role="tablist") stay where they belong.
 */
export function ScrollTabsList({
  className,
  children,
  leading,
  trailing,
  ...props
}: ScrollTabsListProps) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  // ── Drag-to-scroll state ──
  // Tracked in a ref (not state) so pointermove doesn't trigger React re-renders per pixel (would make the drag janky). `moved` is set once the cursor passes the click-vs-drag threshold; onClickCapture uses it to swallow the synthetic click the browser fires after a drag (otherwise dragging the strip would select whatever tab was under the pointer at pointerdown).
  const dragState = React.useRef({
    isDown: false,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
  });
  const [dragging, setDragging] = React.useState(false);

  const update = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    update();
    const el = listRef.current;
    if (!el) return;

    // Map vertical wheel to horizontal scroll on the strip and block the vertical delta from bubbling to parent containers (which could scroll the panel behind the tabs). Pure-horizontal wheel (trackpad swipe, shift+wheel) is left to native behavior. Registered non-passive so preventDefault works — React's synthetic onWheel can be passive in some setups, silently breaking the intercept.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    // ResizeObserver catches both container resize (panel dragged) and
    // content resize (tabs added/removed). Without it, chevrons go stale
    // when the user adds a tab without scrolling.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, [update]);

  const scrollBy = (delta: number) => {
    listRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  // ── Drag-to-scroll handlers ──
  // Pointer events (not mouse events) handle mouse/touch/pen uniformly; capture the pointer so move events keep arriving after the cursor leaves the strip. Drag-vs-click threshold is 8px — high enough that click jitter on the close-X span doesn't trip it, low enough that any real drag registers within the first few pixels.
  const DRAG_THRESHOLD_PX = 8;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left button only
    // Don't initiate drag from the close button or any element marked role="button" — capturing the pointer here would let the drag's click-suppression swallow a normal close-click. Tabs themselves (role="tab") are NOT excluded: grabbing a tab and dragging horizontally to scroll the strip is legitimate.
    const target = e.target as HTMLElement | null;
    if (target?.closest('[role="button"]')) return;
    const el = listRef.current;
    if (!el) return;
    dragState.current = {
      isDown: true,
      startX: e.clientX,
      startScrollLeft: el.scrollLeft,
      moved: false,
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.isDown) return;
    const el = listRef.current;
    if (!el) return;
    const dx = e.clientX - dragState.current.startX;
    if (!dragState.current.moved && Math.abs(dx) > DRAG_THRESHOLD_PX) {
      dragState.current.moved = true;
      setDragging(true); // trigger cursor-grabbing + disable transition
    }
    el.scrollLeft = dragState.current.startScrollLeft - dx;
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.isDown) return;
    dragState.current.isDown = false;
    setDragging(false);
    try { listRef.current?.releasePointerCapture(e.pointerId); } catch { /* fine */ }
  };

  // After a drag, the browser fires a click on whatever element was under the pointer at pointerdown; swallow it during capture so the tab isn't accidentally selected. `moved` resets here so the next genuine click goes through.
  const handleClickCapture = (e: React.MouseEvent) => {
    if (dragState.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragState.current.moved = false;
    }
  };

  return (
    <div
      className={cn(
        'scroll-tabs-list flex items-stretch bg-background flex-shrink-0',
        className,
      )}
    >
      {leading}
      <ScrollButton
        direction="left"
        visible={canLeft}
        onClick={() => scrollBy(-200)}
      />
      <TabsPrimitive.List
        ref={listRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={handleClickCapture}
        className={cn(
          'flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto scroll',
          'px-1.5 pt-1.5',
          '[&::-webkit-scrollbar]:hidden',
          'cursor-grab select-none',
          dragging && 'cursor-grabbing',
          dragging && '[scroll-behavior:auto]',
        )}
        style={{ scrollbarWidth: 'none' }}
        {...props}
      >
        {children}
      </TabsPrimitive.List>
      <ScrollButton
        direction="right"
        visible={canRight}
        onClick={() => scrollBy(200)}
      />
      {trailing}
    </div>
  );
}

/** A chevron button. Always mounted (preserves layout); fades when not
 *  useable so the strip doesn't shift when scroll state changes. */
function ScrollButton({
  direction,
  visible,
  onClick,
}: {
  direction: 'left' | 'right';
  visible: boolean;
  onClick: () => void;
}) {
  const Icon = direction === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      aria-label={direction === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
      aria-hidden={!visible}
      className={cn(
        'flex items-center justify-center w-6 flex-shrink-0',
        'text-muted-foreground/60 transition-all duration-150',
        visible
          ? 'opacity-100 hover:bg-card/40 hover:text-foreground cursor-pointer'
          : 'opacity-0 pointer-events-none',
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** A single tab trigger. The curved-bottom folder-tab look comes from `.scroll-tabs-trigger::before`/`::after` in index.css (inverse curves at the bottom corners, filled via box-shadow with the active tab's bg color). Active state uses `bg-card text-foreground` so the trigger matches the content body and the curves blend them into one shape; inactive is transparent over the list's secondary surface. */
export function ScrollTabsTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'scroll-tabs-trigger',
        'group relative flex items-center gap-1.5 px-3 py-1.5 mb-[-1px]',
        'text-[11.5px] font-medium whitespace-nowrap flex-shrink-0',
        'rounded-t-md',
        'text-muted-foreground hover:text-foreground',
        'transition-colors outline-none',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0',
        // Active: bg matches content body so the curves flow into it.
        'data-[state=active]:text-foreground data-[state=active]:bg-card',
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}
