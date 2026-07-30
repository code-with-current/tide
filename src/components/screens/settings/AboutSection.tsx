import { useEffect, useState } from 'react';
import { Copy, Check, Heart, Code2, Globe, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';

interface Diagnostics {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
}

/** Open an external URL in the OS browser. Uses window.open so the main
 *  process's setWindowOpenHandler catches it and routes via shell.openExternal. */
const openExternal = (url: string) => window.open(url, '_blank', 'noopener');

export function AboutSection() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.tideIpc?.getDiagnostics().then(setDiag).catch(() => {});
  }, []);

  const handleCopy = () => {
    if (!diag) return;
    const text = [
      `Tide v${diag.appVersion}`,
      `Electron ${diag.electron}`,
      `Chromium ${diag.chrome}`,
      `Node ${diag.node}`,
      `Platform ${diag.platform}`,
      `Data ${diag.userDataPath}`,
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <SettingsHeader title="About" />

      {/* Summary */}
      <Card className="mb-5">
        <div className="p-6">
          <div className="text-xl font-semibold tracking-tight">Tide</div>
          <div className="text-[11px] text-muted-foreground/60 mt-0.5">Code with the current</div>
          <div className="text-[11px] text-muted-foreground/60 mt-1">
            Version <span className="font-mono">{diag?.appVersion ?? '—'}</span>
          </div>
        </div>
      </Card>

      {/* Links */}
      <SettingsGroup title="Links">
        <Card>
          <LinkRow
            icon={<Code2 className="size-3.5" />}
            label="GitHub"
            detail="github.com/code-with-current/tide"
            onClick={() => openExternal('https://github.com/code-with-current/tide')}
          />
          <LinkRow
            icon={<Globe className="size-3.5" />}
            label="Homepage"
            detail="tide.codes"
            onClick={() => openExternal('https://tide.codes')}
          />
          <LinkRow
            icon={<BookOpen className="size-3.5" />}
            label="Documentation"
            detail="docs.tide.codes"
            onClick={() => openExternal('https://docs.tide.codes')}
            last
          />
        </Card>
      </SettingsGroup>

      {/* Diagnostics — live values from the main process */}
      <SettingsGroup title="Diagnostics">
        <Card>
          <SettingsRow title="Version">
            <code className="font-mono text-[11px] text-muted-foreground">
              {diag?.appVersion ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Electron">
            <code className="font-mono text-[11px] text-muted-foreground">
              {diag?.electron ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Chromium">
            <code className="font-mono text-[11px] text-muted-foreground">
              {diag?.chrome ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Node">
            <code className="font-mono text-[11px] text-muted-foreground">
              {diag?.node ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Platform">
            <code className="font-mono text-[11px] text-muted-foreground">
              {diag?.platform ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Data location">
            <code className="font-mono text-[10px] text-muted-foreground/80 max-w-[16rem] truncate block">
              {diag?.userDataPath ?? '—'}
            </code>
          </SettingsRow>
          <SettingsRow title="Copy diagnostics" last>
            <Button
              variant="secondary"
              size="sm"
              className="text-xs h-7 gap-1.5"
              onClick={handleCopy}
              disabled={!diag}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      <div className="text-center text-[11px] text-muted-foreground/60 py-4 flex items-center justify-center gap-1.5">
        Made with <Heart className="size-3 text-primary fill-accent" /> for developers.
      </div>
    </>
  );
}

/** A clickable link row. Whole row is a button; opens the URL in the OS browser
 *  via window.open (caught by the main-process setWindowOpenHandler). */
function LinkRow({
  icon,
  label,
  detail,
  onClick,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'w-full flex items-center gap-3 px-4 py-2.5 hover:bg-secondary transition-colors text-left ' +
        (!last ? 'border-b border-input ' : '')
      }
    >
      <span className="text-muted-foreground">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground/60">{detail}</div>
      </div>
    </button>
  );
}
