import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

/**
 * Compact icon button used by the Extensions settings sections (Agents,
 * Skills, MCP) to re-scan their source folders and refresh the list.
 *
 * Re-scan = re-invoke the section's list IPC, which reads fresh from disk:
 *   - Agents/Skills: <workspace>/.claude | .agent | .zcode + ~/.claude | .agent | .zcode
 *   - MCP: ~/.tide/mcp.json (global) + <workspace>/.mcp.json (project)
 *
 * Shows a spinner while loading and is disabled then. The `title` tooltip
 * tells the user exactly what gets reloaded.
 */
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
