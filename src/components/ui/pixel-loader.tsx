import { cn } from '@/lib/utils';

/* Pixel-grid loader — 3×3 cells pulsing on staggered delays to form a moving
 * wavefront. Variants:
 *   drive   — square cells, chevron wavefront driving right
 *   dots    — same wavefront, circular cells
 *   wave    — column-by-column wipe, left to right
 *   ripple  — dots pulse outward from the center
 *   pulse   — all cells flash in sync, a simple heartbeat
 *   sparkle — cells twinkle in a scattered, non-linear order
 *   orbit   — a comet lapping the grid perimeter
 *   globe   — two crossed pixel rings spinning opposite ways (armillary)
 *
 * `size` accepts a preset ('xs' | 'sm' | 'md' | 'lg' | 'xl') or an exact
 * pixel number; default is 'sm' (16px), matching the old fixed default.
 * The label, elapsed timer, and icon-to-text gap scale with it.
 *
 * Pair with an optional shimmering label and elapsed timer via `label` /
 * `elapsed`. Reduced motion is handled by the `pixel-on` / `pixel-spin`
 * keyframes' CSS media query in index.css. */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const wave = Array.from({ length: 9 }, (_, i) => (i % 3) * 120);

const ripple = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return Math.round(Math.hypot(r - 1, c - 1) * 100);
});

const pulse = Array.from({ length: 9 }, () => 0);

const SPARKLE_ORDER = [4, 0, 6, 2, 8, 1, 7, 3, 5];
const sparkle = Array.from({ length: 9 }, (_, i) => SPARKLE_ORDER.indexOf(i) * 80);

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  drive: { delays: chevron, dur: 800, round: false },
  dots: { delays: chevron, dur: 900, round: true },
  wave: { delays: wave, dur: 900, round: true },
  ripple: { delays: ripple, dur: 900, round: true },
  pulse: { delays: pulse, dur: 900, round: true },
  sparkle: { delays: sparkle, dur: 550, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
  globe: { delays: [], dur: 0, round: false },
} as const;

export type PixelLoaderVariant = keyof typeof PATTERNS;

const SIZE_PRESETS = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 28,
  xl: 36,
} as const;

export type PixelLoaderSize = keyof typeof SIZE_PRESETS | number;

function LoaderGlobe({ size }: { size: number }) {
  const dot = Math.max(2, Math.round(size * 0.19));
  const radius = size / 2 - dot / 2;
  const ringContent = Array.from({ length: 8 }, (_, i) => {
    const deg = i * 45;
    return [deg, 0.2 + 0.5 * Math.cos((((deg + 90) % 360) * Math.PI) / 180)] as const;
  });
  // squash < 1 tilts a ring into an ellipse so the two rings visibly cross
  // rather than sit exactly on top of one another.
  const ring = (reverse: boolean, squash = 1) => (
    <span
      aria-hidden
      className="absolute inset-0"
      style={{
        width: size,
        height: size,
        transform: squash !== 1 ? `scaleY(${squash})` : undefined,
        animation: `pixel-spin ${reverse ? 1600 : 1100}ms linear infinite ${reverse ? 'reverse' : ''}`,
      }}
    >
      {ringContent.map(([deg, opacity]) => (
        <span
          key={deg}
          className="absolute left-1/2 top-1/2 rounded-[1px] bg-current"
          style={{
            width: dot,
            height: dot,
            transform: `translate(-50%,-50%) rotate(${deg}deg) translateY(${-radius}px)`,
            opacity,
          }}
        />
      ))}
    </span>
  );
  return (
    <span aria-hidden className="relative block shrink-0" style={{ width: size, height: size }}>
      {ring(false)}
      {ring(true, 0.45)}
    </span>
  );
}

function LoaderGrid({
  delays,
  dur,
  round,
  size,
}: {
  delays: readonly (number | null)[];
  dur: number;
  round: boolean;
  size: number;
}) {
  const cell = Math.max(2, Math.round(size / 4.2));
  const gap = Math.max(1, Math.round(cell * 0.375));
  return (
    <span
      aria-hidden
      className="grid shrink-0"
      style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gap }}
    >
      {delays.map((delay, index) => (
        <span
          key={index}
          className={cn('bg-current', round ? 'rounded-full' : 'rounded-[1px]')}
          style={{
            width: cell,
            height: cell,
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? 'none' : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

export function PixelLoader({
  variant = 'drive',
  label,
  elapsed,
  size = 'sm',
  className,
  color,
}: {
  variant?: PixelLoaderVariant;
  label?: string;
  elapsed?: string;
  /** Preset ('xs' | 'sm' | 'md' | 'lg' | 'xl') or an exact pixel value. Default 'sm' (16px). */
  size?: PixelLoaderSize;
  className?: string;
  /** Any CSS color (hex, rgb, named). Overrides the theme's muted foreground. */
  color?: string;
}) {
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.drive;
  const px = typeof size === 'number' ? size : SIZE_PRESETS[size];
  const labelSize = Math.max(10, Math.round(px * 0.8125));
  const elapsedSize = Math.max(9, Math.round(px * 0.75));
  const gap = Math.max(6, Math.round(px * 0.625));

  return (
    <div
      role="status"
      className={cn('flex w-fit items-center text-muted-foreground', className)}
      style={{ gap, color }}
    >
      {variant === 'globe' ? (
        <LoaderGlobe size={px} />
      ) : (
        <LoaderGrid delays={delays} dur={dur} round={round} size={px} />
      )}
      {label != null && (
        <span className="animate-shimmer-title font-medium" style={{ fontSize: labelSize }}>
          {label}
        </span>
      )}
      {elapsed != null && (
        <span
          className="font-mono text-muted-foreground/50 tabular-nums"
          style={{ fontSize: elapsedSize }}
        >
          {elapsed}
        </span>
      )}
    </div>
  );
}
