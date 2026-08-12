import { GitPullRequestArrow, Terminal, FilePen, Check, Undo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/chat/blocks/diff-view';
import { Chip } from '@/components/primitives';
import type { DiffHunk } from '@/types';

const sampleHunks: DiffHunk[] = [
  {
    header: '@@ -12,4 +12,6 @@ parser.ts',
    lines: [
      { type: 'del', oldNo: 13, text: '  if (input.trim().length === 0) {' },
      { type: 'del', oldNo: 14, text: '    throw new Error("Empty input");' },
      { type: 'add', newNo: 13, text: '  const trimmed = input?.trim() ?? "";' },
      { type: 'add', newNo: 14, text: '  if (trimmed.length === 0) {' },
    ],
  },
];

export function ReviewTab() {
  return (
    <div className="p-3">
      <div className="rounded-md p-2.5 mb-3 flex items-center gap-2 bg-warning/[0.06] border border-warning/20">
        <GitPullRequestArrow className="size-4 text-warning" />
        <div className="flex-1">
          <div className="text-xs font-medium text-warning">Review queue</div>
          <div className="text-[11px] text-muted-foreground/60">2 files · 1 permission pending</div>
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-2">
        Pending permission
      </div>
      <div className="rounded-md p-2.5 mb-3 bg-secondary border border-border">
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="size-3 text-warning" />
          <span className="font-mono text-xs flex-1 truncate">npm test -- parser.test.ts</span>
        </div>
        <div className="flex gap-1">
          <Button variant="destructive" size="sm" className="flex-1 text-xs">
            Reject
          </Button>
          <Button variant="default" size="sm" className="flex-1 text-xs">
            Approve
          </Button>
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-2">
        Diffs to review
      </div>

      <div className="rounded-md p-2.5 mb-2 bg-secondary border border-border">
        <div className="flex items-center gap-2 mb-2">
          <FilePen className="size-3 text-primary" />
          <span className="font-mono text-xs flex-1 truncate">src/parser.ts</span>
          <Chip tone="accent" className="text-[9px] px-1">
            +3 −2
          </Chip>
        </div>
        <DiffView hunks={sampleHunks} />
        <div className="flex gap-1 mt-2">
          <Button variant="ghost" size="sm" className="flex-1 text-xs">
            <Undo className="size-2.5" /> Revert
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 text-xs">
            <Check className="size-2.5" /> Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
