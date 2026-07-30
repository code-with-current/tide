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
} from 'lucide-react';

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
}

export const McpServerRow = memo(function McpServerRow({
  name,
  status,
  toolCount,
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
}: McpServerRowProps) {
  const led = statusLed(status);
  const statusText = statusLabel(status, toolCount, error);

  const canApprove = status === 'needs_approval' && onApprove;
  const canRetry = (status === 'error' || status === 'needs_credentials') && onRetry;
  const canReauthorize = status === 'needs_oauth' && onReauthorize;

  return (
    <div className={`group flex items-center gap-3 py-2.5 px-4 ${enabled ? '' : 'opacity-50'}`}>
      {/* Status icon */}
      <div className="shrink-0" title={led.title}>
        {led.icon}
      </div>

      {/* Name + status text */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{name}</span>
          <TransportBadge transport={transport} />
          <ScopeBadge scope={scope} />
        </div>
        <p className={`text-xs truncate mt-0.5 ${led.textClass}`}>{statusText}</p>
      </div>

      {/* On/Off toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleEnabled(!enabled);
        }}
        className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${
          enabled ? 'bg-accent' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform mt-0.5 ${
            enabled ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>

      {/* Hover actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {canApprove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onApprove!();
            }}
            title="Approve"
            className="p-1 rounded hover:bg-muted transition-colors text-accent"
          >
            <ShieldCheck className="size-3" />
          </button>
        )}
        {canReauthorize && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReauthorize!();
            }}
            title="Re-authorize (clear tokens + reconnect)"
            className="p-1 rounded hover:bg-muted transition-colors text-amber-500"
          >
            <KeyRound className="size-3" />
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry!();
            }}
            title="Retry"
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <RotateCw className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Edit"
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove"
          className="p-1 rounded hover:bg-muted transition-colors text-destructive"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
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
  toolCount: number,
  error?: string,
): string {
  switch (status) {
    case 'connected':
      return `connected · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`;
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
