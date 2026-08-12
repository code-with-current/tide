import { useEffect, useState } from 'react';
import { Dot } from '@/components/primitives';

export function StatusBar({
  children,
  right,
}: {
  children?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const [version, setVersion] = useState('—');
  useEffect(() => {
    window.tideIpc?.getDiagnostics().then((d) => setVersion(d.appVersion)).catch(() => {});
  }, []);
  return (
    <div className="h-[1.7rem] flex items-center px-3 bg-card border-t border-input text-[11px] text-muted-foreground/60 gap-4 font-mono flex-shrink-0">
      {children}
      <div className="flex-1" />
      {right}
      <span>v{version}</span>
    </div>
  );
}

export function StatusItem({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-1.5">{children}</span>;
}

export function StatusSep() {
  return <span className="w-px h-3 bg-line" />;
}

export function ReadyStatus() {
  return (
    <StatusItem>
      <Dot tone="ok" /> Ready
    </StatusItem>
  );
}
