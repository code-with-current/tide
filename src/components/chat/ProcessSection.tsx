import { useEffect, useState } from 'react';
import { ChevronRight, ChevronUp, Wrench } from 'lucide-react';
import type { TextBlock, ToolBlock } from '@/types';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { OneCodeToolRow, OneCodeExploringGroup } from './OneCodeToolRow';
import { buildProcessSummary } from '@/lib/stream/blockState';
import { toolBlockToToolCall } from '@/components/chat/blockstream/blockAdapter';
import { Button } from '@/components/ui/button';

const EXPLORING = new Set(['read_file', 'grep', 'glob', 'list_dir']);

type RenderItem =
  | { kind: 'text'; block: TextBlock }
  | { kind: 'tool'; block: ToolBlock }
  | { kind: 'exploring'; blocks: ToolBlock[] };

/** Group consecutive exploring tools into a single group item.
 *  Mirrors the existing emission-order grouping behavior. */
function groupExploring(items: RenderItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (const item of items) {
    if (item.kind === 'tool' && EXPLORING.has(item.block.toolName)) {
      const last = out[out.length - 1];
      if (last && last.kind === 'exploring') {
        last.blocks.push(item.block);
      } else {
        out.push({ kind: 'exploring', blocks: [item.block] });
      }
    } else {
      out.push(item);
    }
  }
  // Exploring groups with <3 calls stay inline as individual rows.
  return out.flatMap(item =>
    item.kind === 'exploring' && item.blocks.length < 3
      ? item.blocks.map(b => ({ kind: 'tool' as const, block: b }))
      : [item],
  );
}

export function ProcessSection({
  blocks, totals, streaming, onViewFile,
}: {
  blocks: Array<ToolBlock | TextBlock>;
  totals: { commands: number; edits: number; exploration: number; other: number; failedCount: number; totalMs: number };
  streaming: boolean;
  onViewFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  const summary = buildProcessSummary(totals);

  // Build the emission-order render items.
  const items = groupExploring(
    blocks.map(b => b.kind === 'text' ? { kind: 'text' as const, block: b } : { kind: 'tool' as const, block: b }),
  );

  return (
    <div className="py-0.5">
      <span
        role="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center text-[11px] text-muted-foreground/80 hover:text-muted-foreground/60 font-mono gap-1"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Wrench className="size-3" />
        <span>{summary}</span>
      </span>
      {open && (
        <div className="mt-1.5 ml-5 pl-3 border-l border-input animate-slide-up">
          {/* Emission-order view — always. Same narrative during streaming
              and after completion: narration paragraphs interleave with
              tool rows in the exact order the model emitted them. The
              summary line above shows the category counts for at-a-glance
              indexing; the expanded view shows the story. */}
          <div className="space-y-0.5">
            {items.map((item, i) => {
              if (item.kind === 'text') {
                if (!item.block.text.trim()) return null;
                return (
                  <div key={`t_${i}`} className="text-[12px] text-muted-foreground/80 leading-relaxed py-0.5 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px] [&_table]:text-[11px] [&_th]:text-[10px] [&_td]:text-[11px]">
                    <Streamdown
                      mode="static"
                      remarkPlugins={[remarkGfm]}
                      controls={false}
                      animated={false}
                    >
                      {item.block.text.trim()}
                    </Streamdown>
                  </div>
                );
              }
              if (item.kind === 'exploring') {
                return (
                  <OneCodeExploringGroup
                    key={`g_${i}`}
                    calls={item.blocks.map(toolBlockToToolCall)}
                    streaming={streaming}
                  />
                );
              }
              return (
                <OneCodeToolRow
                  key={item.block.toolCallId}
                  call={toolBlockToToolCall(item.block)}
                  streaming={streaming}
                  onViewFile={onViewFile}
                />
              );
            })}
          </div>
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
