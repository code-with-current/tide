/** PanelLanding — the right panel's landing view. Shown when the panel is
 *  opened via the toggle (tab kind 'home'): a simple grid of the available
 *  panel tools. Clicking a tile switches the session's tab directly. */
import { FolderTree, GitBranch, Globe, Terminal as TerminalIcon, Users } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { openTerminalTab } from '@/lib/terminal-tab';
import { cn } from '@/lib/utils';
import type { RightTabKind } from '@/types';

function LandingTile({
  icon,
  title,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${title} needs an active session` : title}
      className={cn(
        'group flex flex-col items-center gap-2.5 rounded-xl border border-transparent p-4 transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:border-border hover:bg-secondary/50 cursor-pointer',
      )}
    >
      <span
        className={cn(
          'size-9 rounded-lg flex items-center justify-center transition-colors',
          'bg-secondary/70 text-muted-foreground',
          !disabled && 'group-hover:bg-primary/10 group-hover:text-foreground',
        )}
      >
        {icon}
      </span>
      <span className="text-[0.8214rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        {title}
      </span>
    </button>
  );
}

export function PanelLanding() {
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setActive = useTabs((s) => s.setActive);

  const switchTo = (kind: RightTabKind) => {
    setActive(activeSessionId ?? 'default', kind);
  };

  return (
    <div className="h-full w-full flex items-center justify-center overflow-y-auto scroll">
      <div className="grid grid-cols-2 gap-2 w-full max-w-[240px] py-6">
        <LandingTile
          icon={<TerminalIcon className="size-4" />}
          title="Terminal"
          onClick={() => openTerminalTab()}
        />
        <LandingTile
          icon={<FolderTree className="size-4" />}
          title="Files"
          onClick={() => switchTo('files')}
        />
        <LandingTile
          icon={<GitBranch className="size-4" />}
          title="Git"
          onClick={() => switchTo('git')}
        />
        <LandingTile
          icon={<Users className="size-4" />}
          title="Agents"
          disabled={!activeSessionId}
          onClick={() => switchTo('agents')}
        />
        <LandingTile
          icon={<Globe className="size-4" />}
          title="Browser"
          onClick={() => switchTo('browser')}
        />
      </div>
    </div>
  );
}
