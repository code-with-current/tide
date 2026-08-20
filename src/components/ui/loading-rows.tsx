/** LoadingRows: compact shimmer placeholder bars for query loads (not actions). count controls bar count; degrades to static fill under prefers-reduced-motion. */

import { cn } from '@/lib/utils';

export function LoadingRows({
  count = 3,
  className,
  rowClassName,
}: {
  count?: number;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2 py-1', className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'h-3.5 rounded-md bg-muted animate-pulse',
            // Stagger widths slightly so it reads as varied content, not bars.
            i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-full' : 'w-2/3',
            rowClassName,
          )}
        />
      ))}
    </div>
  );
}

/** SkeletonBar — single shimmer bar; the atom the layout-aware skeletons are
 *  built from. Width/height come from className; style covers the rare
 *  computed-width case (e.g. staggered `${60 + i * 10}%` rows). */
export function SkeletonBar({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('rounded bg-muted animate-pulse', className)} style={style} />;
}

/** CircleSkeleton — round shimmer for icon slots, status dots, avatars. */
export function CircleSkeleton({ className }: { className?: string }) {
  return <div className={cn('rounded-full bg-muted animate-pulse', className)} />;
}

/** ChipSkeleton — pill shimmer mirroring the app's bg-secondary/70 badge /
 *  target-pill surfaces (h-5 rounded-md). Width from className. */
export function ChipSkeleton({ className }: { className?: string }) {
  return <div className={cn('h-5 rounded-md bg-secondary/70 animate-pulse', className)} />;
}

/** RowSkeleton — label-left / value-right placeholder mirroring the panel's
 *  `flex justify-between gap-2` detail rows (Model, Permissions, Changed, …)
 *  so loading rows occupy the same shape as the real ones. */
export function RowSkeleton({
  labelWidth = 'w-14',
  valueWidth = 'w-16',
}: {
  labelWidth?: string;
  valueWidth?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <SkeletonBar className={cn('h-3', labelWidth)} />
      <SkeletonBar className={cn('h-3', valueWidth)} />
    </div>
  );
}

/** SectionHeaderSkeleton — mirrors PanelSection's header: chevron + uppercase
 *  title, plus an optional right-aligned action/badge pill. */
export function SectionHeaderSkeleton({
  titleWidth = 'w-20',
  action = false,
}: {
  titleWidth?: string;
  action?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 px-3 py-1.5">
      <SkeletonBar className="size-3 rounded-[3px]" />
      <SkeletonBar className={cn('h-2.5', titleWidth)} />
      {action && <SkeletonBar className="ml-auto h-5 w-16 rounded-full" />}
    </div>
  );
}
