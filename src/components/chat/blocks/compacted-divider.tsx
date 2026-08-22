import { memo } from 'react';
import { Minimize2 } from 'lucide-react';

export const CompactedDivider = memo(function CompactedDivider({
  tokensBefore,
  tokensAfter,
}: {
  tokensBefore: number;
  tokensAfter: number;
}) {
  const formatK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n));

  return (
    <div className="flex items-center gap-3 py-3 select-none">
      <div className="flex-1 h-px bg-border" />
      <div className="flex items-center gap-1.5 text-[0.7143rem] uppercase tracking-wider text-muted-foreground/60 font-mono">
        <Minimize2 className="size-3" />
        <span>Compacted</span>
        <span className="text-muted-foreground/40">
          {formatK(tokensBefore)} → {formatK(tokensAfter)}
        </span>
      </div>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
});
