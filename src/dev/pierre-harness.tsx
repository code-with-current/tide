/** Debug harness (temporary): mounts the REAL FileViewerPanel inside the real
 *  Sheet chrome with a mocked IPC bridge, to reproduce the file viewer
 *  "content disappears" bug end-to-end. Mounted by harness-pierre.html. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useUi } from '@/lib/stores/ui';
import { FileViewerPanel } from '@/components/right-panel/file-viewer-panel';

const SAMPLE = Array.from({ length: 60 }, (_, i) => {
  const n = i + 1;
  if (n % 10 === 0) return `// line ${n} — comment`;
  if (n % 7 === 0) return `const greeting${n} = "hello ${n}";`;
  if (n % 5 === 0) return `export function fn${n}(a: number): number {`;
  return `  const value${n} = a * ${n}; // compute`;
}).join('\n');

// Mock IPC before any component touches window.tide.
(window as any).tide = {
  ...(window as any).tide,
  readFileInWorkspace: async (_ws: string, relPath: string) =>
    ({ ok: true, content: `${SAMPLE}\n// from ${relPath}` }),
};

function App() {
  // Force full-tree re-render at 20Hz — mimics streaming parents re-rendering
  // around the mounted panel.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 50);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    useUi.setState({
      fileViewerOpen: true,
      activeSessionId: 's1',
      activeWorkspaceId: 'w1',
      openFiles: { s1: [{ id: '/proj/sample.ts', path: '/proj/sample.ts', language: 'typescript' }] },
      activeOpenFile: { s1: '/proj/sample.ts' },
    });
    // Simulate streaming: high-frequency store updates re-rendering the panel.
    const timer = setInterval(() => {
      useUi.setState({ sheetWidth: 42 });
    }, 50);
    // eslint-disable-next-line no-console
    console.log('[harness] store seeded + pressure on');
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{ height: '100vh', position: 'relative' }}>
      <Sheet open onOpenChange={() => {}}>
        <SheetContent side="right" showCloseButton={false} className="gap-0 p-0" style={{ top: '40px', height: 'auto', width: '42vw' }}>
          <FileViewerPanel />
        </SheetContent>
      </Sheet>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
