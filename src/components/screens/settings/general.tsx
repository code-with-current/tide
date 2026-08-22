/** GeneralSection: startup, notifications, git attribution, and background
 *  task model. */
import { useEffect, useState } from 'react';
import { Check, ChevronRight, User } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';

type UtilityModel = { providerId: string; modelId: string } | null;

type GeneralSettingsState = {
  startAtLogin: boolean;
  notifications: boolean;
  notificationSound: boolean;
  gitCoAuthored: boolean;
  gitCoAuthorName: string;
  gitCoAuthorEmail: string;
  utilityModel: UtilityModel;
};

export function GeneralSection() {
  const [settings, setSettings] = useState<GeneralSettingsState | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [gitExpanded, setGitExpanded] = useState(false);

  useEffect(() => {
    window.tideIpc?.getGeneralSettings().then((s) => {
      const raw = s as Record<string, unknown>;
      setSettings({
        startAtLogin: (raw.startAtLogin as boolean) ?? false,
        notifications: (raw.notifications as boolean) ?? true,
        notificationSound: (raw.notificationSound as boolean) ?? true,
        gitCoAuthored: (raw.gitCoAuthored as boolean) ?? false,
        gitCoAuthorName: (raw.gitCoAuthorName as string) ?? 'Tide',
        gitCoAuthorEmail: (raw.gitCoAuthorEmail as string) ?? '314188112+tide-codes@users.noreply.github.com',
        utilityModel: (raw.utilityModel as UtilityModel) ?? null,
      });
    });
  }, []);

  const update = <K extends keyof GeneralSettingsState>(key: K, value: GeneralSettingsState[K]) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    setSavingKey(key);
    window.tideIpc?.updateGeneralSettings({ [key]: value }).then(() => {
      setTimeout(() => setSavingKey(null), 900);
    });
  };

  if (!settings) {
    return <SettingsHeader title="General" description="Loading…" />;
  }

  return (
    <>
      <SettingsHeader
        title="General"
        description="Startup, notifications, git attribution, and background tasks."
      />

      <div className="max-w-xl space-y-5">
          <SettingsGroup title="Startup">
            <Card>
              <SettingsRow
                title="Start at login"
                description="Launch Tide automatically when you log in."
                last
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'startAtLogin' && <SavedDot />}
                  <Switch
                    checked={settings.startAtLogin}
                    onCheckedChange={(v) => update('startAtLogin', v)}
                  />
                </div>
              </SettingsRow>
            </Card>
          </SettingsGroup>

          <SettingsGroup title="Notifications">
            <Card>
              <SettingsRow
                title="Enable notifications"
                description="OS notifications for turn completion and errors."
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'notifications' && <SavedDot />}
                  <Switch
                    checked={settings.notifications}
                    onCheckedChange={(v) => update('notifications', v)}
                  />
                </div>
              </SettingsRow>
              <SettingsRow
                title="Notification sounds"
                description="Play a sound when a turn finishes or needs your input."
                last
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'notificationSound' && <SavedDot />}
                  <Switch
                    checked={settings.notificationSound}
                    onCheckedChange={(v) => update('notificationSound', v)}
                  />
                </div>
              </SettingsRow>
            </Card>
          </SettingsGroup>

          <SettingsGroup title="Background tasks">
            <Card>
              <SettingsRow
                title="Title & commit-message model"
                description="Model used for session-title and commit-message generation."
                last
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'utilityModel' && <SavedDot />}
                  <UtilityModelSelect
                    value={settings.utilityModel}
                    onChange={(v) => update('utilityModel', v)}
                  />
                </div>
              </SettingsRow>
            </Card>
          </SettingsGroup>

          <SettingsGroup title="Git Attribution">
            <Card>
              <SettingsRow
                title="Co-author commits"
                description="Install a git hook that appends a Co-authored-by trailer to every commit in all workspaces."
                last={!gitExpanded}
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'gitCoAuthored' && <SavedDot />}
                  <Switch
                    checked={settings.gitCoAuthored}
                    onCheckedChange={(v) => update('gitCoAuthored', v)}
                  />
                  {settings.gitCoAuthored && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setGitExpanded((v) => !v)}
                      title="Edit co-author details"
                    >
                      <ChevronRight className={cn('size-3.5 transition-transform', gitExpanded && 'rotate-90')} />
                    </Button>
                  )}
                </div>
              </SettingsRow>
              {gitExpanded && settings.gitCoAuthored && (
                <div className="border-t border-input">
                  <SettingsRow title="Name" description="Display name in the commit trailer.">
                    <div className="flex items-center gap-1.5">
                      {savingKey === 'gitCoAuthorName' && <SavedDot />}
                      <div className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 h-8 px-2 transition-colors focus-within:border-primary/50">
                        <User className="size-3 text-muted-foreground/60" />
                        <Input
                          type="text"
                          value={settings.gitCoAuthorName}
                          onChange={(e) => update('gitCoAuthorName', e.target.value)}
                          className="h-6 w-32 text-xs border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                        />
                      </div>
                    </div>
                  </SettingsRow>
                  <SettingsRow title="Email" description="GitHub no-reply email for attribution." last>
                    <div className="flex items-center gap-1.5">
                      {savingKey === 'gitCoAuthorEmail' && <SavedDot />}
                      <Input
                        type="text"
                        value={settings.gitCoAuthorEmail}
                        onChange={(e) => update('gitCoAuthorEmail', e.target.value)}
                        className="h-8 w-56 text-xs rounded-md border border-border bg-secondary/40 px-2 shadow-none focus-visible:border-primary/50"
                      />
                    </div>
                  </SettingsRow>
                </div>
              )}
            </Card>
          </SettingsGroup>
      </div>
    </>
  );
}

function SavedDot() {
  return (
    <span className="flex items-center gap-0.5 text-[9px] text-[var(--success)] animate-in fade-in duration-200">
      <Check className="size-2.5" /> saved
    </span>
  );
}

/** Model picker for background utility tasks (titles, commit messages).
 *  "Session model" = the session's current model (default); otherwise a
 *  pinned provider+model from every enabled provider's catalog. */
function UtilityModelSelect({
  value,
  onChange,
}: {
  value: UtilityModel;
  onChange: (v: UtilityModel) => void;
}) {
  const { data: providers } = useProviders();
  const enabled = (providers ?? []).filter((p) => p.enabled && p.models.length > 0);
  const DEFAULT = '__session_model__';
  const current = value ? `${value.providerId}:${value.modelId}` : DEFAULT;
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        if (v === DEFAULT) return onChange(null);
        const [providerId, ...rest] = v.split(':');
        onChange({ providerId, modelId: rest.join(':') });
      }}
    >
      <SelectTrigger size="sm" className="w-[240px] text-xs">
        <SelectValue placeholder="Session model" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT} className="text-xs">
          Session model (default)
        </SelectItem>
        {enabled.map((p) => (
          <SelectGroup key={p.id}>
            <SelectLabel className="text-[10px] uppercase tracking-wide">{p.name}</SelectLabel>
            {p.models.map((m) => (
              <SelectItem key={m.id} value={`${p.id}:${m.modelId}`} className="text-xs font-mono">
                {m.alias || m.modelId}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
