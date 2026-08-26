import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Platform detection for the renderer (mac/win/linux). Source:
 *  navigator.platform/userAgent. */
const _platform: 'macos' | 'windows' | 'linux' =
  typeof navigator !== 'undefined'
    ? /Mac/i.test(navigator.platform || navigator.userAgent)
      ? 'macos'
      : /Win/i.test(navigator.platform || navigator.userAgent)
        ? 'windows'
        : 'linux'
    : 'macos';

/** True on macOS. */
export const isMac = _platform === 'macos';
/** True on Windows. */
export const isWindows = _platform === 'windows';
/** True on Linux (and other Unix that aren't Mac). */
export const isLinux = _platform === 'linux';

/** Format USD cost: 0.0431 → "$0.04". Never throws on undefined/null. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Format token counts: 12450 → "12.4K", 1500000 → "1.5M". Never throws. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format context-window size: 200000 → "200,000". Never throws. */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

/** Compact context-window size, 2 significant figures: 131072 → "130K",
 *  1048576 → "1M", 65536 → "66K". Sub-1K values shown raw. Never throws. */
export function formatContext(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '0';
  if (n >= 950_000) {
    const m = Math.round(n / 100_000) / 10;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const step = n >= 100_000 ? 10_000 : 1_000;
    return `${Math.round(n / step) * (step / 1_000)}K`;
  }
  return String(n);
}

/** Format an ISO timestamp as e.g. "2:14 PM". */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Relative time: "2m", "1h", "5h", "Yesterday", "3d". */
export function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Bucket sessions into Today / Yesterday / Older groups, sorted by updatedAt desc. */
export function bucketByRecency<T extends { updatedAt: string }>(
  items: T[],
): { label: string; items: T[] }[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);

  // Sort the full list by updatedAt descending first — so each bucket
  // inherits the right order without a second pass.
  const sorted = [...items].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const today: T[] = [];
  const yesterday: T[] = [];
  const older: T[] = [];
  for (const item of sorted) {
    const t = new Date(item.updatedAt).getTime();
    if (t >= startOfToday.getTime()) today.push(item);
    else if (t >= startOfYesterday.getTime()) yesterday.push(item);
    else older.push(item);
  }
  const buckets: { label: string; items: T[] }[] = [];
  if (today.length) buckets.push({ label: 'Today', items: today });
  if (yesterday.length) buckets.push({ label: 'Yesterday', items: yesterday });
  if (older.length) buckets.push({ label: 'Older', items: older });
  return buckets;
}
