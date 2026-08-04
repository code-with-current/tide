import { useEffect, useRef, useState } from 'react';
import { FileText, X, Loader2, GitCompareArrows, ChevronLeft, ChevronRight, Eye, Code2, Image as ImageIcon } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useUi, type OpenFile } from '@/lib/stores/ui';
import * as api from '@/lib/api/client';
import { DiffView } from '@/components/chat/DiffView';
import { MemoizedMarkdown } from '@/components/chat/MemoizedMarkdown';
import { Image } from '@/components/ui/image';
import { resolveLanguage } from '@/lib/highlight';
import { cn } from '@/lib/utils';

const MD_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

/**
 * Dedicated File Viewer panel — a second right panel separate from the tabbed
 * RightPanel. Its only job is viewing files.
 *
 *   - Tab strip: every open file for the active session; click to focus, × to
 *     close. Sourced from the ui store's per-session `openFiles`.
 *   - Body: reads the REAL file content via `readFileInWorkspace` (sandboxed
 *     on the main side) and renders as monospace text with line numbers.
 *     Markdown files get a preview/code toggle (rendered via MemoizedMarkdown).
 *
 * Opening a file anywhere (tool card, Explorer, Source Control) calls
 * `openFile`, which flips `fileViewerOpen` true and reveals this panel.
 */
export function FileViewerPanel() {
  const activeSessionId = useUi((s) => s.activeSessionId);
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const openFiles = useUi((s) => (activeSessionId ? s.openFiles[activeSessionId] : undefined));
  const activeId = useUi((s) => (activeSessionId ? s.activeOpenFile[activeSessionId] : undefined));
  const setActiveOpenFile = useUi((s) => s.setActiveOpenFile);
  const closeOpenFile = useUi((s) => s.closeOpenFile);
  const toggleFileViewer = useUi((s) => s.toggleFileViewer);
  const tabStripRef = useRef<HTMLDivElement>(null);

  const activeFile = openFiles?.find((f) => f.id === activeId);

  const items = (openFiles ?? []).map((f) => ({
    id: f.id,
    label: f.path.split('/').pop() ?? f.path,
    title: f.path,
    icon: f.diffHunks && f.diffHunks.length > 0
      ? <GitCompareArrows className="size-3 text-primary" />
      : <FileText className="size-3 text-muted-foreground/60" />,
    file: f,
  }));

  return (
    <div className="flex flex-col h-full min-h-0 bg-card overflow-hidden">
      {/* Tab strip — folder-tab style matching ScrollTabs/terminal tabs. */}
      <div className="flex items-stretch bg-secondary flex-shrink-0">
        <button
          type="button"
          onClick={() => tabStripRef.current?.scrollBy({ left: -200, behavior: 'smooth' })}
          className="flex items-center justify-center w-6 flex-shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-card/40 cursor-pointer"
        >
          <ChevronLeft className="size-3.5" />
        </button>

        <div
          ref={tabStripRef}
          className="flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto scroll px-1.5 pt-1.5 select-none"
          style={{ scrollbarWidth: 'none' }}
        >
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                title={item.title}
                onClick={() => activeSessionId && setActiveOpenFile(activeSessionId, item.id)}
                className={cn(
                  'scroll-tabs-trigger group relative flex items-center gap-1.5 px-3 py-1.5 mb-[-1px]',
                  'text-[11.5px] font-medium whitespace-nowrap flex-shrink-0',
                  'rounded-t-md transition-colors outline-none',
                  'focus-visible:ring-1 focus-visible:ring-ring',
                  isActive
                    ? 'text-foreground bg-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                data-state={isActive ? 'active' : 'inactive'}
              >
                {item.icon}
                <span className="truncate max-w-[12rem]">{item.label}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (activeSessionId) closeOpenFile(activeSessionId, item.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      if (activeSessionId) closeOpenFile(activeSessionId, item.id);
                    }
                  }}
                  className={cn(
                    'ml-0.5 inline-flex items-center justify-center rounded size-3.5 flex-none transition-colors',
                    'text-muted-foreground/60 hover:bg-accent hover:text-foreground',
                  )}
                  title="Close file"
                  aria-label={`Close ${item.label}`}
                >
                  <X className="size-2.5 pointer-events-none" />
                </span>
              </button>
            );
          })}
          {items.length === 0 && (
            <span className="text-[11px] text-muted-foreground/50 px-3 py-1.5 self-center">No file open</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => tabStripRef.current?.scrollBy({ left: 200, behavior: 'smooth' })}
          className="flex items-center justify-center w-6 flex-shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-card/40 cursor-pointer"
        >
          <ChevronRight className="size-3.5" />
        </button>

        <button
          type="button"
          onClick={toggleFileViewer}
          className="flex items-center justify-center px-2.5 flex-shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-card/40 cursor-pointer"
          title="Close panel"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Body */}
      {activeFile && activeSessionId && activeWorkspaceId ? (
        <FileBody key={activeFile.id} file={activeFile} workspaceId={activeWorkspaceId} />
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

type BodyState =
  | { loading: true }
  | { loading: false; content: string; truncated: boolean }
  | { loading: false; error: string };

function FileBody({ file, workspaceId }: { file: OpenFile; workspaceId: string }) {
  const isDiff = !!(file.diffHunks && file.diffHunks.length > 0);
  const isMarkdown = MD_EXTENSIONS.has(file.language);
  const [mdPreview, setMdPreview] = useState(isMarkdown);
  // Inline content (e.g. a pasted/browsed attachment) skips the disk read
  // entirely — the bytes are already in hand and the file may live outside
  // the workspace, so readFileInWorkspace would 404.
  const hasInline = file.inlineContent !== undefined;
  const isExternal = file.external === true;
  const [state, setState] = useState<BodyState>(() =>
    hasInline
      ? { loading: false, content: file.inlineContent!, truncated: false }
      : { loading: true },
  );

  useEffect(() => {
    // Skip the disk read when we already have inline content or it's a diff.
    if (isDiff || hasInline) return;
    let cancelled = false;
    setState({ loading: true });
    // External attachments (browsed/pasted from anywhere on disk) read via
    // readExternalFile — no workspace sandbox. absPath survives reload
    // because it's encoded in the content link target, so this works even
    // after attachments[] is gone from memory.
    if (isExternal && file.absPath) {
      api.readExternalFile(file.absPath).then((res) => {
        if (cancelled) return;
        if (res == null) {
          setState({ loading: false, error: 'Could not read file — it may have been moved or deleted.' });
        } else {
          setState({ loading: false, content: res.content, truncated: res.truncated });
        }
      });
      return () => { cancelled = true; };
    }
    // Images without absPath (or any external file with no absPath and no
    // inline content) can't be read — fall through to the isImage /
    // external-placeholder render paths below instead of attempting a
    // workspace read that would 404.
    if (isExternal) {
      setState({ loading: false, content: '', truncated: false });
      return;
    }
    // Workspace file — read via the sandboxed workspace API.
    api.readFileInWorkspace(workspaceId, file.path).then((res) => {
      if (cancelled) return;
      if (res == null || res.ok !== true) {
        setState({ loading: false, error: 'Could not read file — missing or outside the workspace.' });
      } else {
        setState({ loading: false, content: res.content, truncated: res.truncated });
      }
    });
    return () => { cancelled = true; };
  }, [workspaceId, file.path, file.absPath, isDiff, hasInline, isExternal]);

  // Diff mode — render DiffView (opened from Source Control).
  if (isDiff) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-input text-[10px] text-muted-foreground/60 flex-shrink-0">
          <GitCompareArrows className="size-3 text-primary" />
          <code className="font-mono truncate flex-1" title={file.path}>{file.path}</code>
          <span className="uppercase">diff · {file.diffHunks!.length} hunks</span>
        </div>
        <div className="flex-1 overflow-auto scroll">
          <DiffView hunks={file.diffHunks!} />
        </div>
      </div>
    );
  }

  // Image preview — short-circuits BEFORE the text disk-read/error checks.
  // Images attach by path and have no text content, so they get their own
  // loader (readImageFile → base64 data URL) rendered via the Image UI
  // component. Works for both external attachments (absPath) and workspace
  // @file mentions (relPath).
  if (file.isImage) {
    return <ImageBody file={file} workspaceId={workspaceId} />;
  }

  // External attachment with no absPath and no inline content — this
  // happens only for very old sessions saved before absPath was encoded
  // into the link target. Don't surface the workspace disk-read error;
  // explain the real reason.
  if (isExternal && !hasInline && !file.absPath) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-input text-[10px] text-muted-foreground/60 flex-shrink-0">
          <code className="font-mono truncate flex-1" title={file.path}>{file.path}</code>
          <span className="uppercase">external</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/50 p-6 text-center">
          <FileText className="size-6" />
          <span className="text-xs">Attached file content isn't available after reload.</span>
          <span className="text-[10px]">Re-attach the file to view its contents.</span>
        </div>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/50">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if ('error' in state) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-destructive/80 px-6 text-center">
        {state.error}
      </div>
    );
  }

  const lines = state.content.split('\n');
  const changedSet = new Set(file.changedLines ?? []);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header line */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-input text-[10px] text-muted-foreground/60 flex-shrink-0">
        <code className="font-mono truncate flex-1" title={file.path}>{file.path}</code>
        <span className="tabular-nums">{lines.length} lines</span>
        <span className="uppercase">{file.language}</span>
        {state.truncated && <span className="text-warning">truncated</span>}
        {isMarkdown && (
          <div className="flex items-center gap-0 ml-2 rounded-md border border-input overflow-hidden">
            <button
              type="button"
              onClick={() => setMdPreview(true)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] transition-colors',
                mdPreview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="size-2.5" /> Preview
            </button>
            <button
              type="button"
              onClick={() => setMdPreview(false)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] transition-colors',
                !mdPreview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Code2 className="size-2.5" /> Code
            </button>
          </div>
        )}
      </div>

      {/* Body — markdown preview or highlighted code with line numbers */}
      {isMarkdown && mdPreview ? (
        <div className="flex-1 overflow-auto scroll p-4">
          <div className="prose-chat max-w-none">
            <MemoizedMarkdown content={state.content} />
          </div>
        </div>
      ) : (
        <HighlightedCode content={state.content} language={file.language} changedSet={changedSet} />
      )}
    </div>
  );
}

/**
 * Image viewer — reads the image as a base64 data URL via the
 * `readImageFile` IPC (the renderer can't load file:// URLs under
 * contextIsolation) and renders it with the standard Image UI component.
 * Handles both external attachments (absPath) and workspace @file mentions
 * (relPath). Falls back to a friendly error if the file is gone.
 */
function ImageBody({ file, workspaceId }: { file: OpenFile; workspaceId: string }) {
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; dataUrl: string }
    | { loading: false; error: string }
  >({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    // External attachments carry absPath; workspace mentions carry relPath.
    const input = file.absPath
      ? { absPath: file.absPath }
      : { workspaceId, relPath: file.path };
    api.readImageFile(input).then((res) => {
      if (cancelled) return;
      if (res == null) {
        setState({ loading: false, error: 'Could not read image — it may have been moved or deleted.' });
      } else {
        setState({ loading: false, dataUrl: res.dataUrl });
      }
    });
    return () => { cancelled = true; };
  }, [file.absPath, file.path, workspaceId]);

  if (state.loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <ImageHeader path={file.path} bytes={file.bytes} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground/50">
          <Loader2 className="size-4 animate-spin" />
        </div>
      </div>
    );
  }
  if ('error' in state) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <ImageHeader path={file.path} bytes={file.bytes} />
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/50 p-6 text-center">
          <ImageIcon className="size-6" />
          <span className="text-xs">{state.error}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ImageHeader path={file.path} bytes={file.bytes} />
      <div className="flex-1 overflow-auto scroll p-4 flex items-start justify-center">
        <Image
          src={state.dataUrl}
          alt={file.path}
          className="max-w-full max-h-full h-auto shadow-sm"
        />
      </div>
    </div>
  );
}

/** Shared header bar for image previews — filename + size + "image" tag. */
function ImageHeader({ path, bytes }: { path: string; bytes?: number }) {
  const sz = formatBytesStatic(bytes);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-input text-[10px] text-muted-foreground/60 flex-shrink-0">
      <ImageIcon className="size-3" />
      <code className="font-mono truncate flex-1" title={path}>{path}</code>
      {sz && <span className="tabular-nums">{sz}</span>}
      <span className="uppercase">image</span>
    </div>
  );
}

function formatBytesStatic(b?: number): string | null {
  return b != null ? (b > 1024 ? `${Math.ceil(b / 1024)}KB` : `${b}B`) : null;
}

/**
 * Highlighted code viewer — react-syntax-highlighter (Prism engine, oneDark
 * theme). Pure JS, no WASM, no CSP issues. Renders synchronously — colors
 * appear on first paint, no async wait.
 *
 * Built-in line numbers + changed-line tint via wrapLongLines + custom styles.
 */
function HighlightedCode({
  content,
  language,
  changedSet,
}: {
  content: string;
  language: string;
  changedSet: Set<number>;
}) {
  const lang = resolveLanguage(language);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto scroll">
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        showLineNumbers
        wrapLongLines={false}
        customStyle={{
          margin: 0,
          background: 'transparent',
          fontSize: '12px',
          lineHeight: '1.6',
          padding: '8px 0',
        }}
        lineNumberStyle={{
          minWidth: '2.5em',
          paddingRight: '1em',
          color: 'var(--color-muted-foreground)',
          opacity: 0.35,
          userSelect: 'none',
        }}
        wrapLines
        lineProps={(lineNumber) => ({
          style: changedSet.has(lineNumber)
            ? { background: 'rgba(34, 197, 94, 0.08)', display: 'block' }
            : { display: 'block' },
        })}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/45 p-6 text-center">
      <FileText className="size-5" />
      <span className="text-xs">Open a file from a tool card or the Explorer to view it here.</span>
    </div>
  );
}
