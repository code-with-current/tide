import { useTerminalLines } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { Button } from '@/components/ui/button';
import type { TerminalLine } from '@/lib/mock/data';
import { cn } from '@/lib/utils';

const lineClass: Record<TerminalLine['kind'], string> = {
  prompt: 'text-primary',
  cwd: 'text-info',
  cmd: 'text-[#e5e5e5]',
  ok: 'text-success',
  err: 'text-destructive',
  dim: 'text-muted-foreground/60',
  text: 'text-[#c7c7c9]',
};

export function TerminalTab() {
  const sessionId = useUi((s) => s.activeSessionId);
  const { data, isLoading } = useTerminalLines(sessionId);

  // Group consecutive prompt/cwd/cmd into a single prompt line.
  const rows: { prompt?: boolean; segments: TerminalLine[] }[] = [];
  let current: { prompt?: boolean; segments: TerminalLine[] } | null = null;
  for (const line of data ?? []) {
    if (line.kind === 'prompt') {
      if (current) rows.push(current);
      current = { prompt: true, segments: [line] };
    } else if (current && (line.kind === 'cwd' || line.kind === 'cmd')) {
      current.segments.push(line);
    } else {
      if (current) rows.push(current);
      current = { segments: [line] };
    }
  }
  if (current) rows.push(current);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary border-b border-input">
        <code className="font-mono text-[11px] px-1.5 py-0.5 bg-primary rounded text-muted-foreground">zsh</code>
        <code className="font-mono text-[11px] px-1.5 py-0.5 bg-primary rounded text-muted-foreground">
          .agent/worktrees/s_01J
        </code>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="text-[11px] h-6">
          Split
        </Button>
        <Button variant="ghost" size="sm" className="text-[11px] h-6">
          Clear
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto scroll py-2 min-h-0">
        {isLoading && <div className="px-3 text-xs text-muted-foreground/60">Loading…</div>}
        {rows.map((row, i) => (
          <div key={i} className="px-3 leading-[1.55] font-mono text-xs">
            {row.segments.map((seg, j) => (
              <span key={j} className={cn(lineClass[seg.kind], seg.kind === 'cmd' && j > 0 && 'ml-1')}>
                {seg.text}
              </span>
            ))}
            {i === rows.length - 1 && row.prompt && <span className="cursor-blink" />}
          </div>
        ))}
      </div>
    </div>
  );
}
