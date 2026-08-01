/**
 * LoadingRows — a compact stack of shimmer placeholder bars for query loads.
 *
 * Use for *queries* (data loading), never for actions (those get a spinner).
 * The user didn't initiate a query load, so a quiet placeholder is right.
 *
 * Three consumers: Inspector skeleton, chat-restore skeleton, and replaces
 * the hand-rolled shimmer in SourceControlPanel. `count` controls how many
 * bars; `className` lets a caller size the row container. Each bar uses
 * `animate-pulse` (the same primitive motion already in SourceControlPanel)
 * and degrades to a static fill under prefers-reduced-motion automatically
 * (Tailwind's animate-pulse respects that media query).
 */

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
