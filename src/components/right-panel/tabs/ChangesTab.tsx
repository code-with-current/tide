import {
  GitCommitHorizontal,
  GitPullRequestArrow,
  RotateCcw,
  FilePen,
  FilePlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/primitives';
import { Segmented } from '@/components/ui/segmented';
import { useState } from 'react';

export function ChangesTab() {
  const [view, setView] = useState<'tree' | 'flat'>('tree');

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium flex items-center gap-1.5">
          Changes <Chip tone="accent">+21 −2</Chip>
        </div>
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'tree', label: 'Tree' },
            { value: 'flat', label: 'Flat' },
          ]}
        />
      </div>

      <div className="space-y-1 mb-4">
        <div className="rounded-md p-2.5 bg-secondary border border-border">
          <div className="flex items-center gap-2 mb-1">
            <FilePen className="size-3 text-primary" />
            <span className="font-mono text-xs flex-1 truncate">src/parser.ts</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">+3 −2</span>
          </div>
          <div className="text-[10px] text-muted-foreground/60 mb-2">Modified · 2:15 PM</div>
          <div className="font-mono text-[10.5px] leading-[1.6] bg-background border border-input rounded">
            <div className="px-3 py-0.5 bg-destructive/[0.08] text-[#fcbcaf]">- if (input.trim().length === 0) {'{'}</div>
            <div className="px-3 py-0.5 bg-success/[0.08] text-[#b6f5cb]">+ const trimmed = input?.trim() ?? "";</div>
          </div>
        </div>

        <div className="rounded-md p-2.5 bg-secondary border border-border">
          <div className="flex items-center gap-2 mb-1">
            <FilePlus className="size-3 text-success" />
            <span className="font-mono text-xs flex-1 truncate">src/parser.test.ts</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">+18</span>
          </div>
          <div className="text-[10px] text-muted-foreground/60">Added · 2:15 PM · 2 new tests</div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button variant="secondary" size="sm" className="w-full">
          <GitCommitHorizontal className="size-3.5" /> Commit changes
        </Button>
        <Button variant="default" size="sm" className="w-full">
          <GitPullRequestArrow className="size-3.5" /> Create pull request
        </Button>
        <Button variant="ghost" size="sm" className="w-full">
          <RotateCcw className="size-3.5" /> Discard all
        </Button>
      </div>
    </div>
  );
}
