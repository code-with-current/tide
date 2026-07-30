import type { ToolBlock } from '@/types';
import { ToolCallCard } from './ToolCallCard';
import { toolBlockToToolCall } from './blockstream/blockAdapter';

export function EditsSection({
  edits,
  onViewFile,
}: {
  edits: ToolBlock[];
  onViewFile?: (path: string) => void;
}) {
  if (edits.length === 0) return null;
  return (
    <div className="py-0.5 space-y-1">
      {edits.map((b) => (
        <ToolCallCard
          key={b.toolCallId}
          call={toolBlockToToolCall(b)}
          onViewFile={onViewFile}
        />
      ))}
    </div>
  );
}
