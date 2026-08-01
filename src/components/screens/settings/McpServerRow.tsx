import { memo, type ReactNode } from 'react';
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  XCircle,
  Pencil,
  Trash2,
  RotateCw,
  ShieldCheck,
  KeyRound,
  LogIn,
  Wrench,
  ChevronRight,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

/**
 * Status row for a single MCP server. Mirrors the ExtensionRow pattern:
 * a hover-revealed action cluster on the right, a status-led + name + status
 * text in the body, and a transport badge.
 *
 * Owned by McpSection; onApprove / onRetry are optional because they only
 * make sense for `needs_approval` / `error` (or `needs_credentials`) states.
 */

export type McpStatusValue =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'
  | 'needs_approval'
  | 'needs_credentials'
  | 'needs_oauth';

export interface McpServerRowProps {
  name: string;
  status: McpStatusValue;
  toolCount: number;
  /** Names of the tools the server exposes (connected only). Drives the
   *  clickable tool-count chip → popover listing them. */
  toolNames?: string[];
  transport: 'stdio' | 'sse' | 'http';
  error?: string;
  /** Where this server lives. Shown as a source-style badge. */
  scope: 'user' | 'project';
  /** Whether the server is enabled (toggle state). */
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  /** Present on needs_approval rows. */
  onApprove?: () => void;
  /** Present on error / needs_credentials rows. */
  onRetry?: () => void;
  /** Present on OAuth rows — clears tokens + reconnects to re-trigger browser auth. */
  onReauthorize?: () => void;
  /** Present on needs_oauth rows — opens the browser for OAuth sign-in. */
  onAuthenticate?: () => void;
}

export const McpServerRow = memo(function McpServerRow({
  name,
  status,
  toolCount,
  toolNames,
  transport,
  error,
  scope,
  enabled,
  onToggleEnabled,
  onEdit,
  onRemove,
  onApprove,
  onRetry,
  onReauthorize,
  onAuthenticate,
}: McpServerRowProps) {
  const led = statusLed(status);
  const statusText = statusLabel(status, error);
  // Connected servers with tools get a clickable chip that opens a popover
  // listing every tool name. Empty/disconnected/error states show no chip.
  const hasTools = status === 'connected' && toolCount > 0;

  const canApprove = status === 'needs_approval' && onApprove;
  const canRetry = (status === 'error' || status === 'needs_credentials') && onRetry;
  const canReauthorize = status === 'needs_oauth' && onReauthorize;
  const canAuthenticate = status === 'needs_oauth' && onAuthenticate;

  return (
    <div
      className={`group flex items-center gap-3 py-2.5 px-4 transition-opacity ${
        enabled ? '' : 'opacity-50'
      }`}
    >
      {/* Name + meta — mirrors ExtensionRow: name + badges on line 1,
          status text (+ tool chip) on line 2. The MCP-specific richness
          (status dot, transport, scope, tool count) lives as badges/inline
          so the row's SHAPE matches Skills exactly. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* Status LED inline before the name — replaces ExtensionRow's
              plain name with a name+state read. Fixed width for alignment. */}
          <span className="shrink-0 size-3.5 flex items-center justify-center" title={led.title}>
            {led.icon}
          </span>
          <span className="text-sm font-medium truncate">{name}</span>
          <TransportBadge transport={transport} />
          <ScopeBadge scope={scope} />
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 pl-[22px] min-w-0">
          <p className={`text-xs truncate ${led.textClass}`}>{statusText}</p>
          {/* Clickable tool-count chip → popover with the full tool list.
              Sits on the status line like a badge. */}
          {hasTools && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md border border-border/60 bg-secondary/60 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-secondary transition-colors cursor-pointer shrink-0"
                  title="View available tools"
                >
                  <Wrench className="size-2.5" />
                  <span className="font-mono tabular-nums">{toolCount}</span>
                  <span>{toolCount === 1 ? 'tool' : 'tools'}</span>
                  <ChevronRight className="size-2.5 -mr-0.5 opacity-50" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="p-0 max-h-[320px] overflow-hidden flex flex-col w-64"
                align="start"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-3 py-2 border-b border-border flex items-center gap-1.5 shrink-0">
                  <Wrench className="size-3 text-muted-foreground" />
                  <span className="text-[11px] font-medium">{toolCount} {toolCount === 1 ? 'tool' : 'tools'}</span>
                  <span className="text-[10px] text-muted-foreground/50 truncate">· {name}</span>
                </div>
                <div className="overflow-y-auto scroll py-1">
                  {(toolNames ?? []).map((t) => (
                    <div
                      key={t}
                      className="px-3 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                    >
                      {t}
                    </div>
                  ))}
                  {(!toolNames || toolNames.length === 0) && (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground/50">
                      {toolCount} tools available.
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {/* Hover actions (between name and switch) — same slot pattern as
          ExtensionRow's actions. Actionable states surface their CTA here. */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {canAuthenticate && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAuthenticate!(); }}
            title="Authenticate"
            className="p-1 rounded hover:bg-muted transition-colors text-amber-500"
          >
            <LogIn className="size-3" />
          </button>
        )}
        {canApprove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApprove!(); }}
            title="Approve"
            className="p-1 rounded hover:bg-muted transition-colors text-accent"
          >
            <ShieldCheck className="size-3" />
          </button>
        )}
        {canReauthorize && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onReauthorize!(); }}
            title="Re-authorize (clear tokens + reconnect)"
            className="p-1 rounded hover:bg-muted transition-colors text-amber-500"
          >
            <KeyRound className="size-3" />
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry!(); }}
            title="Retry"
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <RotateCw className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit"
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove"
          className="p-1 rounded hover:bg-muted transition-colors text-destructive"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      {/* Toggle — Switch (sm) at the far right, identical to ExtensionRow. */}
      <Switch
        checked={enabled}
        onCheckedChange={(v) => onToggleEnabled(v)}
        aria-label={`Toggle ${name}`}
        size="sm"
      />
    </div>
  );
});

function statusLed(status: McpStatusValue): { icon: ReactNode; title: string; textClass: string } {
  switch (status) {
    case 'connected':
      return {
        icon: <CheckCircle2 className="size-4 text-emerald-500" />,
        title: 'Connected',
        textClass: 'text-muted-foreground/70',
      };
    case 'connecting':
      return {
        icon: <Loader2 className="size-4 text-muted-foreground animate-spin" />,
        title: 'Connecting',
        textClass: 'text-muted-foreground/70',
      };
    case 'needs_approval':
    case 'needs_credentials':
    case 'needs_oauth':
      return {
        icon: <AlertCircle className="size-4 text-amber-500" />,
        title: 'Action needed',
        textClass: 'text-amber-600 dark:text-amber-400',
      };
    case 'error':
      return {
        icon: <AlertCircle className="size-4 text-destructive" />,
        title: 'Error',
        textClass: 'text-destructive',
      };
    case 'disconnected':
    default:
      return {
        icon: <XCircle className="size-4 text-muted-foreground/40" />,
        title: 'Disconnected',
        textClass: 'text-muted-foreground/60',
      };
  }
}

function statusLabel(
  status: McpStatusValue,
  error?: string,
): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting…';
    case 'needs_approval':
      return 'needs approval';
    case 'needs_credentials':
      return 'needs credentials';
    case 'needs_oauth':
      return 'needs OAuth sign-in';
    case 'error':
      return error ? `error: ${error}` : 'error';
    case 'disconnected':
    default:
      return 'disconnected';
  }
}

function TransportBadge({ transport }: { transport: 'stdio' | 'sse' | 'http' }) {
  const styles: Record<string, string> = {
    stdio: 'bg-muted text-muted-foreground border-border',
    sse: 'bg-info/10 text-info border-info/20',
    http: 'bg-accent/10 text-accent border-accent/20',
  };
  return (
    <span
      className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border font-mono ${styles[transport]}`}
    >
      {transport}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: 'user' | 'project' }) {
  const styles: Record<string, string> = {
    user: 'bg-muted/60 text-muted-foreground/80 border-border/60',
    project: 'bg-info/10 text-info border-info/20',
  };
  return (
    <span
      className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border font-mono ${styles[scope]}`}
    >
      {scope === 'user' ? 'global' : 'workspace'}
    </span>
  );
}
