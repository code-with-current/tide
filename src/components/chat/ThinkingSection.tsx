import { useEffect, useState } from 'react';
import { Brain, ChevronRight, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ThinkingSection({
  text,
  tokens,
  ms,
  streaming,
}: {
  text: string;
  tokens?: number;
  ms?: number;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  return (
    <div className="py-0.5">
      <span
        role="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          ' flex justify-start font-mono text-[11px] h-auto py-1 px-1.5 -ml-1.5 items-center gap-1 text-reasoning',
        )}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Brain className="size-3" />
        <span>Thinking</span>
        {ms != null && <span className="text-muted-foreground/60">· {(ms / 1000).toFixed(1)}s</span>}
        {tokens != null && <span className="text-muted-foreground/60">· {tokens.toLocaleString()} tok</span>}
      </span>
      {open && (
        <div className="mt-1.5 ml-5 pl-3 border-l border-input animate-slide-up">
          <pre className="text-[11.5px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto scroll">
            {text}
          </pre>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setOpen(false)}
            className="mt-2 mb-1 text-[10px] uppercase tracking-wider gap-2"
          >
            <ChevronUp className='size-3'/>
            Collapse
          </Button>
        </div>
      )}
    </div>
  );
}
