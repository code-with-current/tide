import { Globe } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Workspace-availability picker for a knowledge source. `['*']` means
 *  global (every workspace, including future ones); otherwise the exact id
 *  list. Unchecking Global seeds the list with every registered workspace so
 *  nothing silently disappears — narrowing is an explicit next step. */

export interface WorkspaceOption {
  id: string;
  name: string;
}

function isGlobalScope(value: string[]): boolean {
  return value.includes('*');
}

function scopeLabel(value: string[], workspaces: WorkspaceOption[]): string {
  if (isGlobalScope(value)) return 'Global';
  const names = value
    .map((id) => workspaces.find((w) => w.id === id)?.name ?? 'Unknown')
    .slice(0, 2);
  const rest = value.length - names.length;
  if (rest > 0) names.push(`+${rest}`);
  return names.length > 0 ? names.join(', ') : 'Global';
}

export function WorkspaceScopeSelect({
  value,
  workspaces,
  onChange,
  disabled,
  className,
}: {
  value: string[];
  workspaces: WorkspaceOption[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const global = isGlobalScope(value);

  const toggleWorkspace = (id: string, checked: boolean) => {
    if (global) {
      // Picking a specific workspace from Global narrows to just that one.
      onChange(checked ? [id] : ['*']);
      return;
    }
    const next = checked ? [...value, id] : value.filter((w) => w !== id);
    // Empty selection isn't representable in the store (empty falls back to '*').
    onChange(next.length > 0 ? next : ['*']);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn('h-6 gap-1 px-1.5 text-[0.7143rem] text-muted-foreground/70', className)}
        >
          <Globe className="size-3 shrink-0" />
          <span className="truncate max-w-[10rem]">{scopeLabel(value, workspaces)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Available in</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={global}
          onCheckedChange={(checked) => onChange(checked ? ['*'] : workspaces.map((w) => w.id))}
        >
          Global — all workspaces
        </DropdownMenuCheckboxItem>
        {workspaces.map((w) => (
          <DropdownMenuCheckboxItem
            key={w.id}
            checked={!global && value.includes(w.id)}
            onCheckedChange={(checked) => toggleWorkspace(w.id, checked === true)}
          >
            {w.name}
          </DropdownMenuCheckboxItem>
        ))}
        {workspaces.length === 0 && (
          <div className="px-2 py-1.5 text-[0.7143rem] text-muted-foreground/50">
            No other workspaces registered.
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
