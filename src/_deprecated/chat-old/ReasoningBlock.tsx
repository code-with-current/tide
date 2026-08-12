import { useState, type ReactNode } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/primitives';
import { cn } from '@/lib/utils';

export function ReasoningBlock({
  reasoning,
  reasoningTokens,
  reasoningMs,
  children,
}: {
  reasoning: string;
  reasoningTokens?: number;
  reasoningMs?: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-reasoning/[0.04] border border-reasoning/20 rounded-lg text-[12.5px] text-muted-foreground overflow-hidden mb-2">
      <span
        role='button'
        onClick={() => setOpen((o) => !o)}
        className="w-full h-auto justify-start rounded-none px-3 py-2 text-reasoning font-medium text-xs hover:bg-reasoning/5"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Brain className="size-3.5" />
        Reasoning
        <div className="flex-1" />
        <Chip tone="reason">
          thinking
          {reasoningMs ? ` · ${(reasoningMs / 1000).toFixed(1)}s` : ''}
          {reasoningTokens ? ` · ${reasoningTokens} tok` : ''}
        </Chip>
      </span>
      {open && (
        <>
          <div className="px-3 py-2.5 font-mono leading-[1.6] text-[11.5px] text-muted-foreground border-t border-reasoning/20 animate-slide-up">
            {reasoning}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setOpen(false)}
              className="mt-3 w-full text-[10px] uppercase tracking-wider text-reasoning/60 hover:text-reasoning h-auto py-1"
            >
              <ChevronRight className="size-3 rotate-90" />
              Collapse
            </Button>
          </div>
          {children}
        </>
      )}
    </div>
  );
}
