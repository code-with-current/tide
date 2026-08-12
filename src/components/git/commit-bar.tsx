import { useState } from 'react';
import { GitCommitHorizontal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CommitBar({
  stagedCount,
  onCommit,
  disabled,
}: {
  stagedCount: number;
  onCommit: (message: string) => void;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState('');
  const canCommit = message.trim().length > 0 && stagedCount > 0 && !disabled;

  const handleCommit = () => {
    if (!canCommit) return;
    onCommit(message.trim());
    setMessage('');
  };

  return (
    <div className="space-y-2 min-w-0 my-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleCommit();
          }
        }}
        placeholder={stagedCount > 0 ? 'Commit message… (⌘+Enter)' : 'Stage files first…'}
        rows={2}
        className="w-full bg-input border border-input rounded-md px-2 @sm:px-2.5 py-1.5 @sm:py-2 text-[0.85rem] text-foreground placeholder:text-muted-foreground/60/70 outline-none focus:border-accent/40 focus:ring-1 focus:ring-ring/20 resize-none transition-colors duration-150 scroll"
      />
      <Button
        size="sm"
        className={cn('w-full transition-opacity', !canCommit && 'opacity-50')}
        disabled={!canCommit}
        onClick={handleCommit}
      >
        {disabled ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <GitCommitHorizontal className="size-3.5" />
        )}
        {disabled ? 'Committing…' : `Commit${stagedCount > 0 ? ` (${stagedCount} staged)` : ''}`}
      </Button>
    </div>
  );
}
