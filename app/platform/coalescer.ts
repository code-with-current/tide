export interface Coalescer<T> {
  push(item: T): void;
  flush(): void;
}

export function createCoalescer<T>(
  flush: (items: T[]) => void,
  { intervalMs = 16, maxItems = 512 }: { intervalMs?: number; maxItems?: number } = {},
): Coalescer<T> {
  let buf: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (buf.length === 0) return;
    const out = buf;
    buf = [];
    flush(out);
  };

  return {
    push(item) {
      buf.push(item);
      if (buf.length >= maxItems) { doFlush(); return; }
      if (timer === null) timer = setTimeout(doFlush, intervalMs);
    },
    flush: doFlush,
  };
}
