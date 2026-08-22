import { memo, useState, type ReactNode } from 'react';
import { Copy, Check, FolderOpen } from 'lucide-react';
import { Switch } from '@/components/ui/switch';

export interface ExtensionRowProps {
  name: string;
  description: string;
  source: 'builtin' | 'project' | 'user';
  enabled: boolean;
  /** Extra badges (active indicator, collision warning, etc.) */
  badges?: ReactNode;
  /** Extra hover actions beyond copy + reveal */
  actions?: ReactNode;
  onToggle: (enabled: boolean) => void;
  onReveal?: () => void;
}

export const ExtensionRow = memo(function ExtensionRow({
  name,
  description,
  source,
  enabled,
  badges,
  actions,
  onToggle,
  onReveal,
}: ExtensionRowProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={`group flex items-center gap-3 py-2.5 px-4 transition-opacity ${
        enabled ? '' : 'opacity-50'
      }`}
    >
      {/* Name + description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{name}</span>
          <SourceBadge source={source} />
          {badges}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{description}</p>
        )}
      </div>

      {/* Hover actions (between name and switch) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {actions}
        <button
          type="button"
          onClick={handleCopy}
          title="Copy name"
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
        {onReveal && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReveal();
            }}
            title="Reveal in Finder"
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <FolderOpen className="size-3" />
          </button>
        )}
      </div>

      {/* Toggle — custom switch at the right, consistent with other Settings rows. */}
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={`Toggle ${name}`}
        size="sm"
      />
    </div>
  );
});

function SourceBadge({ source }: { source: 'builtin' | 'project' | 'user' }) {
  const styles: Record<string, string> = {
    builtin: 'bg-accent/10 text-accent border-accent/20',
    project: 'bg-info/10 text-info border-info/20',
    user: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span
      className={`text-[0.6429rem] uppercase tracking-wide px-1 py-0.5 rounded border font-mono ${styles[source]}`}
    >
      {source}
    </span>
  );
}
