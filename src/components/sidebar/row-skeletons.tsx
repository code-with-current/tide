/* Sidebar row skeletons — mirror SessionItem / WorkspaceItem exactly:
 *  same row wrapper (px-2.5 py-1.5 rounded-md flex flex-col gap-0.5), same
 *  title row (dot/icon + text-[0.9rem] title + trailing affordance), same
 *  meta line (pl-4 model · time, pl-5 mono path). */

import { SkeletonBar, CircleSkeleton } from '@/components/ui/loading-rows';

export function SessionRowSkeleton() {
  return (
    <div className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5" aria-hidden>
      <div className="flex items-center gap-2">
        <CircleSkeleton className="size-2 shrink-0" />
        <SkeletonBar className="h-3.5 min-w-0 flex-1" />
      </div>
      <div className="flex items-center gap-1.5 pl-4">
        <SkeletonBar className="h-2 w-10" />
        <SkeletonBar className="h-2 w-9" />
      </div>
    </div>
  );
}

export function SessionsListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div aria-hidden>
      <div className="mb-1 mt-3 px-1">
        <SkeletonBar className="h-2 w-12" />
      </div>
      <div className="space-y-0.5">
        {Array.from({ length: count }).map((_, i) => (
          <SessionRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function WorkspaceRowSkeleton() {
  return (
    <div className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5" aria-hidden>
      <div className="flex items-center gap-2">
        <SkeletonBar className="size-3.5 shrink-0 rounded-[4px]" />
        <SkeletonBar className="h-3.5 min-w-0 flex-1" />
        <CircleSkeleton className="size-2 shrink-0" />
      </div>
      <div className="pl-5">
        <SkeletonBar className="h-2 w-3/4" />
      </div>
    </div>
  );
}

export function WorkspacesListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <WorkspaceRowSkeleton key={i} />
      ))}
    </div>
  );
}
