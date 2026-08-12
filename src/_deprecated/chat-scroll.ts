/**
 * ChatScroll — pixel-band + direction-based scroll controller.
 *
 * Adapted from t3code's patterns: no IntersectionObserver, no programmaticScroll
 * flag, no forceUntil timer. Uses a 40px pixel-band for at-bottom detection and
 * scroll direction (decreasing scrollTop) for user-scroll-up detection.
 *
 * Programmatic sticks (scrollTop = scrollHeight) never look like user scroll-ups
 * because they always set scrollTop to the maximum — scrollTop never decreases.
 */

export interface ChatScrollOptions {
  /** Px within the bottom that counts as "at bottom". Default 40 (t3code pattern). */
  threshold?: number;
}

type ScrollMode = 'following' | 'free';

export class ChatScroll {
  private scrollEl: HTMLElement;
  private contentEl: HTMLElement;
  private threshold: number;

  private mode: ScrollMode = 'following';
  private unread = false;
  private ro: ResizeObserver | null = null;
  private lastScrollTop = 0;

  onUnreadChange: ((unread: boolean) => void) | null = null;

  constructor(
    scrollEl: HTMLElement,
    contentEl: HTMLElement,
    { threshold = 40 }: ChatScrollOptions = {},
  ) {
    this.scrollEl = scrollEl;
    this.contentEl = contentEl;
    this.threshold = threshold;
    this.lastScrollTop = scrollEl.scrollTop;
    this.attach();
  }

  private attach(): void {
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => {
      if (this.mode === 'following') this.stick();
    });
    this.ro.observe(this.contentEl);
  }

  detach(): void {
    this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.ro?.disconnect();
    this.ro = null;
  }

  // ── at-bottom detection ──────────────────────────────────────────────

  /** True when the viewport is within `threshold` px of the bottom. */
  private isNearBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    return scrollHeight - scrollTop - clientHeight <= this.threshold;
  }

  // ── scroll listener: the sole path that changes mode ─────────────────

  private onScroll = (): void => {
    const top = this.scrollEl.scrollTop;
    // Only a DECREASE in scrollTop breaks follow — genuine user scroll-up.
    // Content growth increases scrollHeight; the browser keeps scrollTop the
    // same or increases it. Programmatic sticks set scrollTop to the max.
    // Neither ever decreases scrollTop, so this never false-triggers.
    if (top < this.lastScrollTop - 4) {
      this.mode = 'free';
      this.setUnread(true);
    }
    // Re-arm: user scrolled back near the bottom.
    if (this.isNearBottom()) {
      this.mode = 'following';
      this.setUnread(false);
    }
    this.lastScrollTop = top;
  };

  private setUnread(v: boolean): void {
    if (v === this.unread) return;
    this.unread = v;
    this.onUnreadChange?.(v);
  }

  // ── event entry points (same signatures as before) ───────────────────

  onStreamTick(): void {
    if (this.mode === 'following') {
      this.stick();
    } else {
      this.setUnread(true);
    }
  }

  onTurnFinish(resultAnchor?: HTMLElement | null): void {
    if (this.mode === 'following' && resultAnchor) this.scrollToResultTop(resultAnchor);
  }

  onUserSend(): void {
    this.forceToBottom();
  }

  onSessionReady(): void {
    this.mode = 'following';
    this.forceToBottom();
  }

  // ── explicit actions ─────────────────────────────────────────────────

  jumpToResult(resultAnchor?: HTMLElement | null): void {
    this.setUnread(false);
    if (resultAnchor) this.scrollToResultTop(resultAnchor);
    else this.jumpToBottom();
  }

  jumpToBottom(): void {
    this.setUnread(false);
    this.mode = 'following';
    this.forceToBottom();
  }

  // ── internals ────────────────────────────────────────────────────────

  private stick(): void {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  /** Force to bottom, handling content-visibility height convergence.
   *  Temporarily renders all wrappers to get accurate scrollHeight. */
  private forceToBottom(): void {
    this.setUnread(false);
    this.mode = 'following';
    const wrappers = Array.from(
      this.scrollEl.querySelectorAll<HTMLElement>('[style*="content-visibility"]'),
    );
    for (const w of wrappers) w.style.contentVisibility = 'visible';
    requestAnimationFrame(() => {
      this.settleStick();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const w of wrappers) w.style.contentVisibility = '';
          requestAnimationFrame(() => this.stick());
        }),
      );
    });
  }

  private settleStick(): void {
    this.stick();
    let n = 0;
    const step = () => {
      this.stick();
      if (++n < 5) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private scrollToResultTop(anchor: HTMLElement): void {
    this.setUnread(false);
    const move = () => {
      const containerTop = this.scrollEl.getBoundingClientRect().top;
      const anchorTop = anchor.getBoundingClientRect().top;
      this.scrollEl.scrollTop += anchorTop - containerTop;
    };
    move();
    requestAnimationFrame(move);
  }
}
