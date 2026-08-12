import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

/** Compact icon button used by Extensions settings (Agents/Skills/MCP) to re-scan source folders and refresh the list. Shows a spinner while loading. */
export function ReloadButton({
  loading,
  onClick,
  title = 'Reload from folders',
}: {
  loading: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-accent hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
    </Button>
  );
}
