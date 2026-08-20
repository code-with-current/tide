/* TimelineSkeleton — session-switch placeholder mirroring the loaded turn
 *  anatomy exactly: right-aligned user bubble (chat-message.tsx), thinking
 *  header row (thinking-block.tsx h-7 icon + title + detail pill + timing),
 *  tool section ("N tool calls" header + h-7 rows: icon, label, target pill,
 *  status — tool-chips.tsx), and answer prose lines. Same paddings/gaps so
 *  swapping in real turns causes no layout shift. */

import { SkeletonBar, CircleSkeleton, ChipSkeleton } from '@/components/ui/loading-rows';

function UserBubbleSkeleton() {
  return (
    <div className="flex justify-end">
      <div className="w-[55%] rounded-xl rounded-br bg-primary/15 px-3.5 py-2.5">
        <div className="flex flex-col gap-1.5">
          <SkeletonBar className="h-3.5 w-full" />
          <SkeletonBar className="h-3.5 w-2/3" />
        </div>
      </div>
    </div>
  );
}

function ThinkingHeaderSkeleton() {
  return (
    <div className="mt-[5px] flex h-7 w-full items-center gap-2 px-1.5">
      <CircleSkeleton className="size-4 shrink-0" />
      <SkeletonBar className="h-2.5 w-14 shrink-0" />
      <ChipSkeleton className="w-28" />
      <SkeletonBar className="ml-auto h-2 w-8 shrink-0" />
    </div>
  );
}

function ToolRowSkeleton({ labelWidth = 'w-16' }: { labelWidth?: string }) {
  return (
    <div className="flex h-7 w-full items-center gap-2 px-1.5">
      <CircleSkeleton className="size-4 shrink-0" />
      <SkeletonBar className={`h-3 ${labelWidth} shrink-0`} />
      <ChipSkeleton className="min-w-0 flex-1" />
      <CircleSkeleton className="size-3 shrink-0" />
    </div>
  );
}

function ToolSectionSkeleton() {
  return (
    <div className="mt-[5px] w-full">
      <div className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1">
        <SkeletonBar className="size-3 rounded-[3px]" />
        <SkeletonBar className="h-2.5 w-[4.5rem]" />
      </div>
      <div className="mt-[5px] flex flex-col gap-[5px]">
        <ToolRowSkeleton labelWidth="w-[4.5rem]" />
        <ToolRowSkeleton labelWidth="w-14" />
        <ToolRowSkeleton labelWidth="w-[5.5rem]" />
      </div>
    </div>
  );
}

function AnswerSkeleton() {
  return (
    <div className="mt-3 flex flex-col gap-1.5 px-1">
      <SkeletonBar className="h-3 w-full" />
      <SkeletonBar className="h-3 w-full" />
      <SkeletonBar className="h-3 w-3/5" />
    </div>
  );
}

function TurnSkeleton() {
  return (
    <div className="mb-6 flex flex-col">
      <UserBubbleSkeleton />
      <ThinkingHeaderSkeleton />
      <ToolSectionSkeleton />
      <AnswerSkeleton />
    </div>
  );
}

export function TimelineSkeleton({ turns = 2 }: { turns?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {Array.from({ length: turns }).map((_, i) => (
        <TurnSkeleton key={i} />
      ))}
    </div>
  );
}
