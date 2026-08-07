/** GeneralSection: dual-column settings — General (left: Startup/Notifications/Git Attribution) + Appearance (right, reuses AppearanceContent). */
import { useEffect, useState } from 'react';
import { Check, ChevronRight, User } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { AppearanceContent } from './AppearanceSection';
import { cn } from '@/lib/utils';

type GeneralSettingsState = {
  startAtLogin: boolean;
  notifications: boolean;
  gitCoAuthored: boolean;
  gitCoAuthorName: string;
  gitCoAuthorEmail: string;
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
        gitCoAuthored: (raw.gitCoAuthored as boolean) ?? false,
        gitCoAuthorName: (raw.gitCoAuthorName as string) ?? 'Tide',
        gitCoAuthorEmail: (raw.gitCoAuthorEmail as string) ?? '314188112+tide-code@users.noreply.github.com',
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
        description="Startup, notifications, and appearance preferences."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left column: General settings ── */}
        <div className="space-y-5">
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
                last
              >
                <div className="flex items-center gap-2">
                  {savingKey === 'notifications' && <SavedDot />}
                  <Switch
                    checked={settings.notifications}
                    onCheckedChange={(v) => update('notifications', v)}
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

        {/* ── Right column: Appearance ── */}
        <div className="space-y-5">
          <AppearanceContent />
        </div>
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
