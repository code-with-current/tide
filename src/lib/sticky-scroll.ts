/**
 * StickyScroll — keeps a chat container pinned to the bottom while content
 * streams in, without fighting the user if they scroll up to read history.
 */

export class StickyScroll {
  private scrollEl: HTMLElement;
  private threshold: number;
  isPinned = true;
  private _rafPending = false;
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

  private _handleScroll(): void {
    const distance = this._distanceFromBottom();
    const nowPinned = distance <= this.threshold;
    if (nowPinned !== this.isPinned) {
      this.isPinned = nowPinned;
      this.onPinChange?.(this.isPinned);
    }
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
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    });
  }

  /** Explicit scroll-to-bottom (jump button). */
  scrollToBottom({ smooth = false }: { smooth?: boolean } = {}): void {
    this.isPinned = true;
    this.onPinChange?.(true);
    if (smooth) {
      this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight, behavior: 'smooth' });
    } else {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
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
