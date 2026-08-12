/**
 * FileViewerPanel — ScrollTabs strip of open files + body showing file content
 * or diffs. Uses the same ScrollTabs component as the right panel (chevrons,
 * drag-to-scroll, folder-tab curves). Rendered inside a Sheet below the topbar.
 */
import { useEffect, useState, useCallback } from 'react';
import { FileText, X, Loader2, GitCompareArrows, Copy, Check } from 'lucide-react';
import { useUi, type OpenFile } from '@/lib/stores/ui';
import * as api from '@/lib/api/client';
import { DiffView } from '@/components/chat/blocks/diff-view';
import { ScrollTabs, ScrollTabsList, ScrollTabsTrigger } from '@/components/ui/scroll-tabs';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';

// ── Helpers ──

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function isImageExt(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(path);
}

// ── Component ──

export function FileViewerPanel() {
  const sessionId = useUi((s) => s.activeSessionId);
  const workspaceId = useUi((s) => s.activeWorkspaceId);
  const files = useUi((s) => (sessionId ? s.openFiles[sessionId] : undefined));
  const activeId = useUi((s) => (sessionId ? s.activeOpenFile[sessionId] : undefined));
  const setActive = useUi((s) => s.setActiveOpenFile);
  const closeFile = useUi((s) => s.closeOpenFile);
  const closePanel = useUi((s) => s.toggleFileViewer);

  const active = files?.find((f) => f.id === activeId) ?? files?.[0];

  const closeOthers = useCallback((keepId: string) => {
    if (!sessionId) return;
    for (const f of [...(files ?? [])]) {
      if (f.id !== keepId) closeFile(sessionId, f.id);
    }
    setActive(sessionId, keepId);
  }, [sessionId, files, closeFile, setActive]);

  const closeAllTabs = useCallback(() => {
    if (!sessionId) return;
    for (const f of [...(files ?? [])]) closeFile(sessionId, f.id);
  }, [sessionId, files, closeFile]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-background">
      <ScrollTabs
        value={active?.id}
        onValueChange={(id) => sessionId && setActive(sessionId, id)}
        className="flex flex-col flex-1 min-h-0"
      >
        <ScrollTabsList
          className="bg-sidebar"
          trailing={
            <button
              type="button"
              onClick={closePanel}
              title="Close panel"
              className="flex items-center justify-center px-2.5 flex-shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-background/40 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          }
        >
          {(files ?? []).map((file) => (
            <FileTab
              key={file.id}
              file={file}
              fileCount={files?.length ?? 0}
              onClose={() => sessionId && closeFile(sessionId, file.id)}
              onCloseOthers={() => closeOthers(file.id)}
              onCloseAll={() => closeAllTabs()}
            />
          ))}
          {(!files || files.length === 0) && (
            <span className="text-[11px] text-muted-foreground/50 px-3 py-1.5 self-center">No file open</span>
          )}
        </ScrollTabsList>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-hidden bg-card">
          {active && sessionId && workspaceId ? (
            <FileBody key={active.id} file={active} workspaceId={workspaceId} />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground/50">
              Open a file from a tool card or the Explorer.
            </div>
          )}
        </div>
      </ScrollTabs>
    </div>
  );
}

// ── FileTab: one ScrollTabsTrigger with icon, name, close X, right-click menu ──

function FileTab({
  file, fileCount, onClose, onCloseOthers, onCloseAll,
}: {
  file: OpenFile;
  fileCount: number;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}) {
  const isDiff = !!(file.diffHunks && file.diffHunks.length > 0);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <ScrollTabsTrigger value={file.id} title={file.path}>
          {isDiff
            ? <GitCompareArrows className="size-3 text-primary" />
            : <FileText className="size-3 text-muted-foreground/60" />}
          <span className="truncate max-w-[10rem]">{basename(file.path)}</span>
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose(); }}
            className="ml-0.5 inline-flex items-center justify-center rounded size-3.5 text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
          >
            <X className="size-2.5" />
          </span>
        </ScrollTabsTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onClose} className="text-xs">
         Close
        </ContextMenuItem>
        <ContextMenuItem disabled={fileCount <= 1} onClick={onCloseOthers} className="text-xs">
          Close Others
        </ContextMenuItem>
        <ContextMenuItem disabled={fileCount <= 1} onClick={onCloseAll} className="text-xs">
          Close All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── FileBody ──

function FileBody({ file, workspaceId }: { file: OpenFile; workspaceId: string }) {
  const isDiff = !!(file.diffHunks && file.diffHunks.length > 0);

  if (isDiff) {
    return (
      <div className="flex flex-col h-full">
        <FileHeader path={file.path} badge={`diff · ${file.diffHunks!.length} hunks`} />
        <div className="flex-1 overflow-auto scroll">
          <DiffView hunks={file.diffHunks!} />
        </div>
      </div>
    );
  }

  if (file.isImage || isImageExt(file.path)) {
    return <ImageBody file={file} workspaceId={workspaceId} />;
  }

  return <TextBody file={file} workspaceId={workspaceId} />;
}

// ── ImageBody ──

function ImageBody({ file, workspaceId }: { file: OpenFile; workspaceId: string }) {
  const [state, setState] = useState<{ loading: true } | { loading: false; dataUrl: string } | { loading: false; error: string }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    const input = file.absPath ? { absPath: file.absPath } : { workspaceId, relPath: file.path };
    api.readImageFile(input).then((res) => {
      if (cancelled) return;
      if (!res) setState({ loading: false, error: 'Could not read image.' });
      else setState({ loading: false, dataUrl: res.dataUrl });
    });
    return () => { cancelled = true; };
  }, [file.absPath, file.path, workspaceId]);

  if (state.loading) return <CenteredSpinner />;
  if ('error' in state) return <CenteredMessage message={state.error} />;

  return (
    <div className="flex flex-col h-full">
      <FileHeader path={file.path} badge="image" />
      <div className="flex-1 overflow-auto scroll p-4 flex items-start justify-center">
        <img src={state.dataUrl} alt={file.path} className="max-w-full max-h-full h-auto" />
      </div>
    </div>
  );
}

// ── TextBody ──

function TextBody({ file, workspaceId }: { file: OpenFile; workspaceId: string }) {
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; content: string }
    | { loading: false; error: string }
  >(() => (file.inlineContent != null ? { loading: false, content: file.inlineContent } : { loading: true }));

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (file.inlineContent != null) { setState({ loading: false, content: file.inlineContent }); return; }
    let cancelled = false;
    setState({ loading: true });
    api.readFileInWorkspace(workspaceId, file.path).then((res) => {
      if (cancelled) return;
      if (!res || res.ok !== true) setState({ loading: false, error: 'Could not read file.' });
      else setState({ loading: false, content: res.content });
    });
    return () => { cancelled = true; };
  }, [workspaceId, file.path, file.inlineContent]);

  const copy = useCallback(() => {
    if ('content' in state) {
      navigator.clipboard.writeText(state.content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }
  }, [state]);

  if (state.loading) return <CenteredSpinner />;
  if ('error' in state) return <CenteredMessage message={state.error} />;

  const lines = state.content.split('\n');

  return (
    <div className="flex flex-col h-full">
      <FileHeader path={file.path} badge={`${lines.length} lines`} action={
        <button type="button" onClick={copy} title="Copy" className="text-muted-foreground/50 hover:text-foreground transition-colors">
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        </button>
      } />
      <div className="flex-1 overflow-auto scroll">
        <div className="flex font-mono text-[12px] leading-relaxed">
          {/* Line numbers */}
          <div className="select-none text-right text-muted-foreground/30 py-3 pl-3 pr-2 flex-shrink-0 sticky left-0 bg-background">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          {/* Code */}
          <pre className="py-3 px-2 whitespace-pre-wrap break-words text-foreground/90 flex-1 min-w-0">
            {state.content}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ── Shared bits ──

function FileHeader({ path, badge, action }: { path: string; badge?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0 text-[10px] text-muted-foreground/60">
      <code className="font-mono truncate flex-1" title={path}>{path}</code>
      {badge && <span className="uppercase flex-shrink-0">{badge}</span>}
      {action}
    </div>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground/50">
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

function CenteredMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full text-[12px] text-destructive/80 px-6 text-center">
      {message}
    </div>
  );
}
