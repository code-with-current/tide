/** Layout-mirroring skeletons for the Inspector panel. Each skeleton
 *  reproduces its real section's structure — header (chevron + title +
 *  action/badge), body shape (stat grids, label/value rows, meter bars) —
 *  so loading previews the actual layout instead of generic full-width bars.
 *  Shared between RightPanel (session still loading → whole panel) and
 *  InspectorTab (individual section queries still resolving). */

import type { ReactNode } from 'react';

import { RowSkeleton, SectionHeaderSkeleton, SkeletonBar } from '@/components/ui/loading-rows';

/** Session hero — title + meta line, status dot, 2-cell stat grid. */
export function HeroSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden>
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex-1 space-y-1.5">
          <SkeletonBar className="h-3.5 w-2/3" />
          <SkeletonBar className="h-2.5 w-1/2" />
        </div>
        <SkeletonBar className="size-6 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1.5">
            <SkeletonBar className="h-2 w-10" />
            <SkeletonBar className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Configuration — Model / Permissions / Iteration label-value rows. */
export function ConfigRowsSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      <RowSkeleton labelWidth="w-10" valueWidth="w-24" />
      <RowSkeleton labelWidth="w-20" valueWidth="w-28" />
      <RowSkeleton labelWidth="w-14" valueWidth="w-12" />
    </div>
  );
}

/** Memory & RAG — Memory / Indexed / Last-indexed rows + Re-Index button. */
export function MemoryRagRowsSkeleton() {
  return (
    <div className="space-y-1" aria-hidden>
      <RowSkeleton labelWidth="w-12" valueWidth="w-20" />
      <RowSkeleton labelWidth="w-12" valueWidth="w-10" />
      <RowSkeleton labelWidth="w-16" valueWidth="w-14" />
      <SkeletonBar className="h-7 w-full rounded-md" />
    </div>
  );
}

/** Git — branch row, base/head + changed rows, diffstat strip. */
export function GitRowsSkeleton() {
  return (
    <div className="space-y-1" aria-hidden>
      <div className="flex items-center gap-2">
        <SkeletonBar className="size-3 rounded-[3px]" />
        <SkeletonBar className="h-3 flex-1" />
      </div>
      <RowSkeleton labelWidth="w-8" valueWidth="w-28" />
      <RowSkeleton labelWidth="w-12" valueWidth="w-10" />
      <RowSkeleton labelWidth="w-14" valueWidth="w-20" />
      <div className="flex items-center justify-between gap-2 py-1">
        <SkeletonBar className="h-2.5 w-12" />
        <SkeletonBar className="h-1 w-20 rounded-full" />
        <SkeletonBar className="h-2.5 w-8" />
      </div>
    </div>
  );
}

/** Context Window — 3-stat strip, fill meter with header row, 2-col breakdown. */
export function ContextWindowSkeleton() {
  return (
    <div aria-hidden>
      <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5 bg-background px-2.5 py-2">
            <SkeletonBar className="h-2 w-12" />
            <SkeletonBar className="h-3.5 w-10" />
          </div>
        ))}
      </div>
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <SkeletonBar className="h-2 w-16" />
          <SkeletonBar className="h-2 w-28" />
        </div>
        <SkeletonBar className="h-1.5 w-full rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {[0, 1, 2, 3].map((i) => (
          <RowSkeleton key={i} labelWidth="w-20" valueWidth="w-10" />
        ))}
      </div>
    </div>
  );
}

/** Whole-panel skeleton — the full inspector stack while the session query
 *  resolves: one section shell per real section, in order, with matching
 *  header widths and the header action pills where the real headers have them. */
export function InspectorSkeleton() {
  return (
    <div className="flex-1 min-h-0" aria-hidden>
      <SectionShell titleWidth="w-14">
        <HeroSkeleton />
      </SectionShell>
      <SectionShell titleWidth="w-24">
        <ConfigRowsSkeleton />
      </SectionShell>
      <SectionShell titleWidth="w-20" action>
        <MemoryRagRowsSkeleton />
      </SectionShell>
      <SectionShell titleWidth="w-8" action>
        <GitRowsSkeleton />
      </SectionShell>
      <SectionShell titleWidth="w-24">
        <ContextWindowSkeleton />
      </SectionShell>
    </div>
  );
}

/** PanelSection-shaped shell: bordered row + header + padded body, so the
 *  skeleton sections land on the same rhythm as the real collapsed sections. */
function SectionShell({
  titleWidth,
  action = false,
  children,
}: {
  titleWidth?: string;
  action?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border">
      <SectionHeaderSkeleton titleWidth={titleWidth} action={action} />
      <div className="bg-background px-3 py-3">{children}</div>
    </div>
  );
}
