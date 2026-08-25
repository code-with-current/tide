/** Bounded per-terminal scrollback held in the MAIN process
 *  model): the renderer is a disposable projection that can re-attach with a
 *  snapshot after a reload while the PTY keeps running. Chunks keep their
 *  node-pty boundaries — trimming whole chunks is inherently UTF-8-safe. */

export interface ScrollbackSnapshot {
  data: string;
  seq: number;
}

export class ScrollbackBuffer {
  private chunks: string[] = [];
  private chars = 0;
  private nextSeq = 1;

  constructor(private readonly maxChars: number) {}

  /** Append a chunk; returns its sequence number (monotonic from 1). */
  append(data: string): number {
    if (!data) return this.nextSeq - 1;
    this.chunks.push(data);
    this.chars += data.length;
    while (this.chunks.length > 1 && this.chars > this.maxChars) {
      this.chars -= this.chunks[0].length;
      this.chunks.shift();
    }
    return this.nextSeq++;
  }

  snapshot(): ScrollbackSnapshot {
    return {
      data: this.chunks.join(''),
      seq: this.nextSeq - 1,
    };
  }
}
