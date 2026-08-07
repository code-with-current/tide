/**
 * StickyScroll — keeps a chat container pinned to the bottom while content
 * streams in, without fighting the user if they scroll up to read history.
 */

export class StickyScroll {
  private scrollEl: HTMLElement;
  private threshold: number;
  isPinned = true;
  private _rafPending = false;
  private _programmatic = false;
  private _resizeObserver: ResizeObserver | null = null;
  onPinChange: ((isPinned: boolean) => void) | null = null;

  constructor(scrollEl: HTMLElement, { threshold = 100 }: { threshold?: number } = {}) {
    this.scrollEl = scrollEl;
    this.threshold = threshold;
    this.scrollEl.addEventListener('scroll', () => this._handleScroll(), { passive: true });
  }

  private _distanceFromBottom(): number {
    const { scrollHeight, scrollTop, clientHeight } = this.scrollEl;
    return scrollHeight - scrollTop - clientHeight;
  }

  private _setPinned(pinned: boolean): void {
    if (pinned === this.isPinned) return;
    this.isPinned = pinned;
    this.onPinChange?.(this.isPinned);
  }

  private _handleScroll(): void {
    // Ignore scroll events we triggered ourselves (auto-follow / jump button)
    // so pin state only reflects genuine user scrolling. Without this, a
    // programmatic snap-to-bottom re-pins the view and hides the jump button
    // right after the user scrolled up — and a content-visibility resize that
    // momentarily pushes us off the bottom can false-unpin.
    if (this._programmatic) return;
    this._setPinned(this._distanceFromBottom() <= this.threshold);
  }

  /** Watch a content element for size changes and auto-scroll if pinned. */
  observe(contentEl: HTMLElement): void {
    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      if (this.isPinned) this._scheduleScroll();
    });
    this._resizeObserver.observe(contentEl);
  }

  disconnect(): void {
    this._resizeObserver?.disconnect();
  }

  private _scheduleScroll(): void {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      // Re-check at flush time: the user may have scrolled up between the
      // ResizeObserver tick (which scheduled this) and now. Aborting here is
      // what stops streaming from yanking a reader back to the bottom.
      if (!this.isPinned) return;
      this._stickToBottom();
    });
  }

  private _stickToBottom(): void {
    this._programmatic = true;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    // The scroll event fired by the line above lands before the next paint,
    // so reset the guard on the following RAF — after that event is ignored.
    requestAnimationFrame(() => { this._programmatic = false; });
  }

  /** Reset to pinned without scrolling (used on session switch; the
   *  ResizeObserver re-sticks once new content renders). */
  resetPin(): void {
    this._setPinned(true);
  }

  /** Explicit scroll-to-bottom (jump button or session switch). Temporarily
   *  removes content-visibility so scrollHeight reflects real layout, then
   *  restores it after scrolling. */
  scrollToBottom({ smooth = false }: { smooth?: boolean } = {}): void {
    this._setPinned(true);
    // Force layout of all content-visibility:auto elements so scrollHeight
    // is accurate. Without this, off-screen messages use their
    // contain-intrinsic-size estimate and we scroll to the wrong position.
    const content = this.scrollEl.firstElementChild as HTMLElement | null;
    const wrappers = content?.querySelectorAll('[style*="content-visibility"]') ?? [];
    wrappers.forEach((el) => { (el as HTMLElement).style.contentVisibility = 'visible'; });

    const doScroll = () => {
      if (smooth) {
        this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight, behavior: 'smooth' });
      } else {
        this._stickToBottom();
      }
      // Restore content-visibility after the browser has computed the real
      // scrollHeight and we've scrolled to it. Two RAFs: one for layout,
      // one for paint settle.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          wrappers.forEach((el) => { (el as HTMLElement).style.contentVisibility = ''; });
        });
      });
    };

    // One RAF to let the forced layout settle before scrolling.
    requestAnimationFrame(doScroll);
  }

  /** Preserve scroll position when prepending older history above. */
  preserveOnPrepend(mutateFn: () => void): void {
    const prevHeight = this.scrollEl.scrollHeight;
    const prevTop = this.scrollEl.scrollTop;
    mutateFn();
    const heightDelta = this.scrollEl.scrollHeight - prevHeight;
    this.scrollEl.scrollTop = prevTop + heightDelta;
  }
}
