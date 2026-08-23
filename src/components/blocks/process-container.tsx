/* Compact-mode process container: one "Agent" header row wrapping the turn's
 * Thinking + ToolChips sections in an answer-gated collapsible. Open-state is
 * derived (process-state.ts) — the user's click pins, the pin resets when a
 * new turn starts streaming. Same header-row + grid-collapse anatomy as
 * ThinkingBlock/ToolChips. Steps/duration live in TurnHeader, not here. */

import { memo, useEffect, useState } from 'react';
import { Zap, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Block } from '@/types';
import { deriveProcessOpen, stepsCount } from './process-state';

export const ProcessContainer = memo(function ProcessContainer({
  streaming, blocks, answerActive, phaseHint, children,
}: {
  streaming: boolean;
  blocks: Block[] | undefined;
  answerActive: boolean;
  phaseHint?: string | null;
  children: React.ReactNode;
}) {
  const hasProcess = stepsCount(blocks) > 0;
  const [pinned, setPinned] = useState<boolean | null>(null);
  // `streaming` is stable for a whole turn (set at turn start, cleared only by
  // turn_end/error — retry and compaction preserve it), so this fires on the
  // rising edge of each new turn, not mid-turn. The streaming row also
  // unmounts between turns, so pin state never leaks across turns.
  useEffect(() => { if (streaming) setPinned(null); }, [streaming]);

  const open = deriveProcessOpen({ streaming, hasProcess, answerActive, userPinned: pinned });

  return (
    <div className="mt-[5px] w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
        className="group/agent -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-secondary/60"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-primary">
          <span className="flex size-4 items-center justify-center transition-opacity duration-100 group-hover/agent:opacity-0">
            <Zap className={cn('size-4', streaming && open && 'animate-pulse')} />
          </span>
          <ChevronDown className="absolute size-3 opacity-0 text-muted-foreground transition-[opacity,transform] duration-150 group-hover/agent:opacity-100" style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        </span>
        <span className="shrink-0 text-[0.85rem] font-medium text-foreground/80">Agent</span>
        {streaming && open && phaseHint ? (
          <span className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 text-[0.8214rem] text-muted-foreground">{phaseHint}…</span>
        ) : null}
        {streaming ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }}
      >
        <div className="min-h-0 overflow-hidden pl-5">{children}</div>
      </div>
    </div>
  );
});
