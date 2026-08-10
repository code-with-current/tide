/**
 * ChatScroll — block-aware chat scroll controller (replaces StickyScroll).
 *
 * One instance owns bottom-pin detection (sentinel + IntersectionObserver,
 * immune to content-visibility height instability), an `unread` flag, and a
 * small set of event entry points called by the screen:
 *
 *   onStreamTick()                       each block/delta while streaming
 *   onTurnFinish(resultAnchor?)          snap the result to the top
 *   onUserSend()                         force to bottom
 *   onSessionReady()                     stick to bottom after a session switch
 *
 * Behaviours:
 *  • Streaming + at bottom      → follow the latest content.
 *  • Streaming + exploring      → set `unread`; UI shows a "New Message" button.
 *  • Turn finished (was following) → snap the result section to the viewport top
 *    so the user reads it top-down. If exploring, leave the button (no yank).
 *  • Session switch / user send → force to bottom.
 *
 * The `unread` flag is the single source of truth for the floating button and
 * is cleared whenever the user reaches the bottom or clicks the button.
 */

export interface ChatScrollOptions {
  /** Px within the bottom that counts as "at bottom". */
  threshold?: number;
  /** Force-follow window (ms) after an explicit snap, so the ResizeObserver
   *  keeps gluing while content-visibility heights settle. */
  settleMs?: number;
}

export class ChatScroll {
  private scrollEl: HTMLElement;
  private sentinelEl: HTMLElement;
  private contentEl: HTMLElement;
  private threshold: number;
  private settleMs: number;

  private atBottom = true;
  /** Authoritative "keep up with the stream" flag. Independent of the
   *  IntersectionObserver — set true by stream ticks and bottom snaps, cleared
   *  ONLY by a genuine user scroll-up (detected via the scroll listener). */
  private following = true;
  private unread = false;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private rafPending = false;
  private forceUntil = 0;
  private lastScrollTop = 0;
  /** True while WE are setting scrollTop programmatically (stick/forceToBottom).
   *  Scroll events fired by our own programmatic writes must NOT be treated as
   *  user scroll-up — this was the core bug where content growth → stick() →
   *  scroll event → false "user scrolled up" → following killed mid-stream. */
  private programmaticScroll = false;

  /** Fired whenever the `unread` flag changes — the screen uses it to show or
   *  hide the floating "New Message" button. */
  onUnreadChange: ((unread: boolean) => void) | null = null;

  constructor(
    scrollEl: HTMLElement,
    sentinelEl: HTMLElement,
    contentEl: HTMLElement,
    { threshold = 80, settleMs = 600 }: ChatScrollOptions = {},
  ) {
    this.scrollEl = scrollEl;
    this.sentinelEl = sentinelEl;
    this.contentEl = contentEl;
    this.threshold = threshold;
    this.settleMs = settleMs;
    this.lastScrollTop = scrollEl.scrollTop;
    this.attach();
  }

  private attach(): void {
    this.io = new IntersectionObserver(
      (entries) => this.onIntersect(entries[0].isIntersecting),
      {
        root: this.scrollEl,
        // Expand the effective root bottom by `threshold` so the sentinel
        // counts as "at bottom" slightly before it fully enters view.
        rootMargin: `0px 0px ${this.threshold}px 0px`,
      },
    );
    this.io.observe(this.sentinelEl);
    // The scroll listener is the SOLE path that stops following — it
    // distinguishes genuine user scroll-up (decreasing scrollTop) from
    // content-growth flicker (where the IO sentinel transiently leaves view).
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
    // Catch non-stream size changes (syntax highlight, images, mermaid) and
    // keep following when pinned (or within a force-settle window).
    this.ro = new ResizeObserver(() => this.scheduleFollow());
    this.ro.observe(this.contentEl);
  }

  detach(): void {
    this.io?.disconnect();
    this.ro?.disconnect();
    this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.io = null;
    this.ro = null;
  }

  // ── state ─────────────────────────────────────────────────────────────

  get isAtBottom(): boolean {
    return this.atBottom;
  }

  /** IntersectionObserver callback — narrowed to ONLY assert bottom (entering).
   *  Leaving the sentinel's view does NOT clear following/atBottom, because
   *  that's caused by content-visibility growth, not a user scroll-up. */
  private onIntersect(isIntersecting: boolean): void {
    if (isIntersecting) {
      // Sentinel is in view → we're at the bottom. Assert following so the
      // stream keeps tracking, and clear any unread state.
      this.atBottom = true;
      this.following = true;
      this.setUnread(false);
    }
    // isIntersecting === false: do nothing. The scroll listener handles
    // genuine scroll-up detection. Content-growth flicker that pushes the
    // sentinel out momentarily must NOT stop following.
  }

  /** Scroll-event listener — the ONLY path that stops following. Detects
   *  genuine user scroll-up (scrollTop decreased by >4px). When the user
   *  scrolls back to the bottom, re-asserts following.
   *
   *  CRITICAL: ignores scroll events caused by our own programmatic scrollTop
   *  writes (stick/forceToBottom). Without this, content growth → stick() →
   *  scroll event with a transiently lower scrollTop → false "user scrolled
   *  up" → following killed. The programmaticScroll flag breaks that loop. */
  private onScroll = (): void => {
    const top = this.scrollEl.scrollTop;
    if (this.programmaticScroll) {
      // Our own write — just track position, don't interpret as user action.
      this.lastScrollTop = top;
      return;
    }
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    if (top >= max - this.threshold) {
      this.atBottom = true;
      this.following = true;
      this.setUnread(false);
    } else if (top < this.lastScrollTop - 4) {
      this.atBottom = false;
      this.following = false;
    }
    this.lastScrollTop = top;
  };

  private setUnread(v: boolean): void {
    if (v === this.unread) return;
    this.unread = v;
    this.onUnreadChange?.(v);
  }

  // ── event entry points (called by the screen) ────────────────────────

  /** New streamed content arrived — a text delta OR a process/tool block.
   *  While `following` is true (user hasn't scrolled up), keep following the
   *  stream — extend the force window each tick so the ResizeObserver keeps
   *  gluing through content-visibility growth. If the user scrolled up
   *  (following = false), mark unread instead. */
  onStreamTick(): void {
    if (this.following) {
      this.forceUntil = Date.now() + 1200;
      this.stick();
    } else {
      this.setUnread(true);
    }
  }

  /** The turn finished. If the user was following, snap the result section to
   *  the viewport top. If exploring, leave the "New Message" button (no yank). */
  onTurnFinish(resultAnchor?: HTMLElement | null): void {
    if (this.atBottom && resultAnchor) this.scrollToResultTop(resultAnchor);
    // else: exploring (leave the unread button), or no result anchor — do nothing.
  }

  /** User just sent a message — force to the bottom immediately. */
  onUserSend(): void {
    this.forceToBottom();
  }

  /** A session's messages finished loading after a switch — stick to bottom. */
  onSessionReady(): void {
    // Assert at-bottom + following: we're about to jump there, so don't let a
    // transient sentinel "not intersecting" cancel the follow during settling.
    this.atBottom = true;
    this.following = true;
    this.forceToBottom();
  }

  // ── explicit actions (button click) ───────────────────────────────────

  /** Jump to the top of the result section if known, else to the bottom. */
  jumpToResult(resultAnchor?: HTMLElement | null): void {
    this.setUnread(false);
    if (resultAnchor) this.scrollToResultTop(resultAnchor);
    else this.jumpToBottom();
  }

  jumpToBottom(): void {
    this.setUnread(false);
    this.forceToBottom();
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Force to bottom + hold a settle window so the follow loop converges past
   *  content-visibility height corrections. For long sessions the off-screen
   *  messages sit at their 200px estimate, so the naive stick lands mid-list;
   *  we force every wrapper to render (accurate scrollHeight), stick, then
   *  restore virtualization. */
  private forceToBottom(): void {
    this.setUnread(false);
    this.atBottom = true;
    this.following = true;
    this.forceUntil = Date.now() + this.settleMs;
    const wrappers = Array.from(
      this.scrollEl.querySelectorAll<HTMLElement>('[style*="content-visibility"]'),
    );
    for (const w of wrappers) w.style.contentVisibility = 'visible';
    requestAnimationFrame(() => {
      this.settleStick();
        // Restore virtualization after layout + paint settle, then re-stick
        // (re-virtualizing the top shrinks scrollHeight; clamping keeps us at
        // the bottom, but the final stick guarantees it).
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const w of wrappers) w.style.contentVisibility = '';
            requestAnimationFrame(() => this.stick());
          }),
        );
    });
  }

  private scheduleFollow(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      // Follow when the user hasn't scrolled up (following) OR within a force
      // window (streaming tick or explicit snap). The force window keeps gluing
      // through content-visibility growth that transiently pushes the sentinel
      // out of view — that's content we want to follow, not a user scroll-up.
      const forcing = Date.now() < this.forceUntil;
      if (!this.following && !forcing) return;
      this.stick();
    });
  }

  private stick(): void {
    // Set the flag so the scroll listener ignores the event this write fires.
    // Without it, the browser fires a scroll event that can look like a user
    // scroll-up (if content settled and scrollTop adjusted), killing following.
    this.programmaticScroll = true;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    // Clear on the next frame — scroll events fire synchronously in most
    // browsers, but defer to be safe.
    requestAnimationFrame(() => { this.programmaticScroll = false; });
  }

  /** Re-apply the stick over a few frames: off-screen messages lift from their
   *  200px estimate to real heights, growing scrollHeight; repeated sticks
   *  converge to the real bottom. */
  private settleStick(): void {
    this.stick();
    let n = 0;
    const step = () => {
      this.stick();
      if (++n < 5 && Date.now() < this.forceUntil) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Scroll the result section to the viewport top so the user reads top-down.
   *  Uses a getBoundingClientRect delta against the scroll container — NOT
   *  scrollIntoView, which would also scroll every scrollable ancestor (the
   *  window included) and cause a whole-screen scrollbar flash. */
  private scrollToResultTop(anchor: HTMLElement): void {
    this.setUnread(false);
    const move = () => {
      const containerTop = this.scrollEl.getBoundingClientRect().top;
      const anchorTop = anchor.getBoundingClientRect().top;
      this.programmaticScroll = true;
      this.scrollEl.scrollTop += anchorTop - containerTop;
      requestAnimationFrame(() => { this.programmaticScroll = false; });
    };
    move();
    requestAnimationFrame(move);
  }
}
