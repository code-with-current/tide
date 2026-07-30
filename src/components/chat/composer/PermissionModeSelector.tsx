import { Shield, ChevronDown, Check, Map, Pencil, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import type { AutonomyMode } from '@/types';

const MODES: {
  value: AutonomyMode;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  hint: string;
}[] = [
  { value: 'plan', label: 'Plan only', shortLabel: 'Plan', icon: <Map className="size-3.5" />, hint: 'Proposes changes, never executes' },
  { value: 'ask', label: 'Ask before changes', shortLabel: 'Ask', icon: <Shield className="size-3.5" />, hint: 'Prompts for every edit & shell call' },
  { value: 'edit', label: 'Edit automatically', shortLabel: 'Edit', icon: <Pencil className="size-3.5" />, hint: 'Auto-edits files, asks before shell' },
  { value: 'full', label: 'Full access', shortLabel: 'Full', icon: <Zap className="size-3.5" />, hint: 'Direct access to this machine' },
];

/** Permission mode picker. */
export function PermissionModeSelector({ compact = false }: { compact?: boolean }) {
  const mode = useUi((s) => s.autonomyMode);
  const setMode = useUi((s) => s.setAutonomyMode);
  const current = MODES.find((m) => m.value === mode) ?? MODES[1];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-7 gap-1.5 text-xs px-2 text-muted-foreground hover:text-foreground', compact && 'px-1.5')}
          title={`Permissions: ${current.label}`}
        >
          {current.icon}
          {!compact && <span>{current.shortLabel}</span>}
          <ChevronDown className="size-3 text-muted-foreground/60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px] p-0 overflow-hidden">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5 px-3 py-2">
          <Shield className="size-3" /> Permissions
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {MODES.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onClick={() => setMode(m.value)}
            className="gap-2 py-2 cursor-pointer items-start"
          >
            <span className="mt-0.5">{m.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium">{m.label}</div>
              <div className="text-[10px] text-muted-foreground/60">{m.hint}</div>
            </div>
            {m.value === mode && <Check className="size-3.5 text-primary mt-0.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
