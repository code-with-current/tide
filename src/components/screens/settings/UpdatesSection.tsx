import { DownloadCloud, CheckCircle2, ShieldCheck, RefreshCw, History, ArrowDownToLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/primitives';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';

const HISTORY = [
  { version: '0.4.2', date: 'Today', current: true, notes: 'Inspector tab, provider grid, two-section Add Provider' },
  { version: '0.4.1', date: '3 days ago', current: false, notes: 'Reasoning-token accounting in usage events' },
  { version: '0.4.0', date: '1 week ago', current: false, notes: 'Multi-tier model routing, MCP first-class' },
  { version: '0.3.8', date: '2 weeks ago', current: false, notes: 'sqlite-vec replaces LanceDB' },
  { version: '0.3.7', date: '3 weeks ago', current: false, notes: 'Permission-prompt timeout, crash-recovery markers' },
];

export function UpdatesSection() {
  return (
    <>
      <SettingsHeader
        title="Updates"
        description="Auto-update is on. Updates are code-signed and hash-pinned before they apply."
        action={
          <Button variant="default" size="sm" className="text-xs h-7">
            <RefreshCw className="size-3" /> Check now
          </Button>
        }
      />

      {/* Status banner */}
      <Card className="mb-5">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-success/10 border border-success/25 flex items-center justify-center">
            <CheckCircle2 className="size-4 text-success" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium flex items-center gap-2">
              You're up to date <Chip tone="ok">v0.4.2</Chip>
            </div>
            <div className="text-[11px] text-muted-foreground/60">Last checked 2 minutes ago · signature verified</div>
          </div>
          <Button variant="secondary" size="sm" className="text-xs h-7">
            <ArrowDownToLine className="size-3" /> Reinstall
          </Button>
        </div>
      </Card>

      {/* Channel */}
      <SettingsGroup title="Channel">
        <Card>
          <SettingsRow title="Release channel" description="Stable is recommended. Beta gets features earlier.">
            <Segmented
              value="stable"
              onChange={() => {}}
              options={[
                { value: 'stable', label: 'Stable' },
                { value: 'beta', label: 'Beta' },
                { value: 'internal', label: 'Internal' },
              ]}
            />
          </SettingsRow>
          <SettingsRow title="Auto-download updates" description="Download in background, prompt to install.">
            <Switch defaultChecked />
          </SettingsRow>
          <SettingsRow title="Auto-install on quit" description="Apply pending updates when you close the app.">
            <Switch defaultChecked />
          </SettingsRow>
          <SettingsRow title="Differential updates" description="Smaller payloads via binary diffs.">
            <Switch defaultChecked />
          </SettingsRow>
          <SettingsRow
            title="Rollback on crash loop"
            description="Auto-revert to previous version if launch fails 3× in a row."
            last
          >
            <Switch defaultChecked />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Security */}
      <SettingsGroup
        title="Security"
        hint={
          <span className="flex items-center gap-1 text-success">
            <ShieldCheck className="size-3" /> verified
          </span>
        }
      >
        <Card>
          <SettingsRow title="Signature verification" description="Reject updates signed by anything other than the pinned key.">
            <Chip tone="ok">on · non-disablable</Chip>
          </SettingsRow>
          <SettingsRow title="Manifest hash pinning" description="Verify SHA512 in latest.yml before applying.">
            <Chip tone="ok">on</Chip>
          </SettingsRow>
          <SettingsRow
            title="Update server"
            description="Where manifests and binaries are fetched from. HTTPS only."
            last
          >
            <code className="font-mono text-[11px] px-2 py-0.5 bg-primary rounded text-muted-foreground">
              updates.tide.codes
            </code>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* History */}
      <SettingsGroup
        title="Update history"
        hint={<History className="size-3.5 text-muted-foreground/60" />}
      >
        <Card>
          {HISTORY.map((h, i) => (
            <div
              key={h.version}
              className={
                'flex items-center gap-3 px-4 py-2.5 ' +
                (i < HISTORY.length - 1 ? 'border-b border-input ' : '')
              }
            >
              <DownloadCloud className={'size-3.5 ' + (h.current ? 'text-primary' : 'text-muted-foreground/60')} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium flex items-center gap-2">
                  v{h.version}
                  {h.current && <Chip tone="accent" className="text-[9px] px-1">current</Chip>}
                </div>
                <div className="text-[11px] text-muted-foreground/60 truncate">{h.notes}</div>
              </div>
              <span className="text-[11px] text-muted-foreground/60 flex-shrink-0">{h.date}</span>
            </div>
          ))}
        </Card>
      </SettingsGroup>
    </>
  );
}
