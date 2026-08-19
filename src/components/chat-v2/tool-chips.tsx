/* v2 tool-run rendering: compact chip rows + file-diff chips with hover preview.
 * Mockup-derived layout, but driven by real ToolCall / FileChangeEntry data
 * and Tide's design tokens. Lives alongside (not replacing) the v1 tool-row. */

import { memo, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileSearch,
  FilePen,
  Terminal,
  Folder,
  FolderTree,
  GitBranch,
  Bot,
  ListChecks,
  Globe,
  Search,
  BookOpen,
  MessageCircleQuestionMark,
  ClipboardCheck,
  Minimize2,
  Plug,
  ChevronDown,
  Check,
  X,
  Loader2,
} from 'lucide-react';
import type { ToolCall, ToolName } from '@/types';
import type { FileChangeEntry } from '@/lib/stream/block-state';
import { cn } from '@/lib/utils';
import { toolLabel } from '@/lib/tool-labels';

const ICON: Partial<Record<ToolName, React.ReactNode>> = {
  read_file: <FileSearch className="size-3" />,
  read_media_file: <FileSearch className="size-3" />,
  edit_file: <FilePen className="size-3" />,
  multi_edit: <FilePen className="size-3" />,
  write_file: <FilePen className="size-3" />,
  list_dir: <Folder className="size-3" />,
  directory_tree: <FolderTree className="size-3" />,
  glob: <FileSearch className="size-3" />,
  bash: <Terminal className="size-3" />,
  bash_output: <Terminal className="size-3" />,
  kill_shell: <Terminal className="size-3" />,
  grep: <FileSearch className="size-3" />,
  git: <GitBranch className="size-3" />,
  dispatch_agent: <Bot className="size-3" />,
  todo_write: <ListChecks className="size-3" />,
  web_fetch: <Globe className="size-3" />,
  web_search: <Search className="size-3" />,
  load_skill: <BookOpen className="size-3" />,
  ask_followup_question: <MessageCircleQuestionMark className="size-3" />,
  exit_plan_mode: <ClipboardCheck className="size-3" />,
  compact: <Minimize2 className="size-3" />,
  mcp: <Plug className="size-3" />,
};

const ICON_COLOR: Partial<Record<ToolName, string>> = {
  read_file: 'text-sky-400',
  read_media_file: 'text-sky-400',
  glob: 'text-sky-400',
  grep: 'text-sky-400',
  edit_file: 'text-amber-400',
  multi_edit: 'text-amber-400',
  write_file: 'text-amber-400',
  notebook_edit: 'text-amber-400',
  bash: 'text-green-400',
  bash_output: 'text-green-400',
  kill_shell: 'text-green-400',
  git: 'text-orange-400',
  dispatch_agent: 'text-purple-400',
  todo_write: 'text-blue-400',
  web_fetch: 'text-cyan-400',
  web_search: 'text-cyan-400',
  load_skill: 'text-violet-400',
  ask_followup_question: 'text-warning',
  exit_plan_mode: 'text-teal-400',
  compact: 'text-slate-400',
  mcp: 'text-indigo-400',
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Short identifier for the chip: path, command, pattern, etc. */
function targetOf(call: ToolCall): string {
  const a = call.arguments ?? {};
  switch (call.toolName) {
    case 'read_file':
    case 'edit_file':
    case 'write_file':
    case 'list_dir':
    case 'notebook_edit':
      return String(a.path ?? a.file_path ?? '');
    case 'glob':
    case 'grep':
      return String(a.pattern ?? a.query ?? '');
    case 'bash':
    case 'bash_output':
    case 'kill_shell':
      return String(a.command ?? a.id ?? '');
    case 'git':
      return String(a.args ?? a.command ?? '');
    case 'web_fetch':
    case 'web_search':
      return String(a.url ?? a.query ?? '');
    case 'dispatch_agent':
      return String(a.title ?? a.name ?? '');
    default:
      return call.argPreview ?? '';
  }
}

const isAgentCall = (c: ToolCall) => c.toolName === 'dispatch_agent' || c.display?.kind === 'agent';

/** Truncated plain-text detail lines for the expanded row body. */
function detailLinesOf(call: ToolCall): { text: string; tone?: 'add' | 'del' }[] {
  if (call.display?.kind === 'diff') {
    const lines: { text: string; tone?: 'add' | 'del' }[] = [];
    for (const hunk of call.display.hunks) {
      for (const l of hunk.lines) {
        if (l.type === 'hunk') continue;
        lines.push({ text: l.text, tone: l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : undefined });
      }
    }
    return lines.slice(0, 200);
  }
  const src = call.display?.kind === 'text' ? call.display.text : call.output;
  if (!src) return [];
  return (src as string)
    .replace(ANSI_RE, '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 500)
    .map((text) => ({ text }));
}

function StatusGlyph({ call }: { call: ToolCall }) {
  switch (call.status) {
    case 'executed':
      return <Check className="size-3 text-success" />;
    case 'failed':
    case 'rejected':
      return <X className="size-3 text-destructive" />;
    case 'awaiting_input':
      return <MessageCircleQuestionMark className="size-3 text-primary animate-pulse" />;
    case 'pending':
    case 'running':
      return <Loader2 className="size-3 text-muted-foreground animate-spin" />;
    default:
      return <X className="size-3 text-warning" />;
  }
}

type Preview = { entry: FileChangeEntry; x: number; top?: number; bottom?: number };

function DiffPreview({ preview }: { preview: Preview }) {
  const { entry } = preview;
  const lines = useMemo(() => {
    const out: { text: string; tone: 'add' | 'del' | 'ctx' }[] = [];
    for (const hunk of entry.hunks ?? []) {
      for (const l of hunk.lines) {
        if (l.type === 'hunk') continue;
        out.push({ text: l.text, tone: l.type === 'add' || l.type === 'del' ? l.type : 'ctx' });
      }
    }
    return out.slice(0, 40);
  }, [entry]);
  const name = entry.path.split('/').pop() ?? entry.path;

  return createPortal(
    <div
      className="fixed z-50 w-72 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      style={{
        left: preview.x,
        top: preview.top,
        bottom: preview.bottom,
        animation: 'pop-in 160ms cubic-bezier(0.23,1,0.32,1) both',
        transformOrigin: preview.top === undefined ? 'bottom left' : 'top left',
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 font-mono text-[11px]">
        <span className="min-w-0 truncate text-muted-foreground">{name}</span>
        <span className="shrink-0 tabular-nums">
          {!!entry.additions && <span className="text-success">+{entry.additions}</span>}
          {!!entry.deletions && <span className="text-destructive"> −{entry.deletions}</span>}
        </span>
      </div>
      <div className="scroll max-h-72 overflow-y-auto py-1 font-mono text-[11px] leading-[1.7]">
        {lines.length === 0 && <div className="px-2.5 text-muted-foreground">no diff available</div>}
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2 whitespace-pre px-2.5',
              line.tone === 'add' && 'bg-success/10 text-success',
              line.tone === 'del' && 'bg-destructive/10 text-destructive',
              line.tone === 'ctx' && 'text-muted-foreground',
            )}
          >
            <span className="w-3 shrink-0 select-none">
              {line.tone === 'add' ? '+' : line.tone === 'del' ? '−' : ' '}
            </span>
            <span className="min-w-0 truncate">{line.text}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

const MAX_CHIPS = 3;

/** A single expandable tool chip row — shared by top-level calls and the
 *  sub-agent calls nested inside an expanded dispatch row. agentBody, when
 *  present, replaces the generic detail lines. */
function ChipRow({
  call,
  isChild = false,
  rowOpen,
  onToggle,
  onViewFile,
  agentBody,
}: {
  call: ToolCall;
  isChild?: boolean;
  rowOpen: boolean;
  onToggle: (id: string) => void;
  onViewFile?: (path: string) => void;
  agentBody?: React.ReactNode;
}) {
  const details = agentBody ? [] : detailLinesOf(call);
  const target = targetOf(call);
  const expandable = !!agentBody || details.length > 0;
  return (
    <>
      <button
        type="button"
        aria-expanded={rowOpen}
        aria-disabled={!expandable}
        onClick={() => expandable && onToggle(call.id)}
        className={cn(
          'flex h-7 w-full min-w-0 max-w-full items-center gap-2 rounded-md px-1 text-left transition-colors px-1.5',
          expandable ? 'cursor-pointer' : 'cursor-default',
          'hover:bg-secondary/60 hover:rounded-lg',
        )}
      >
        <span className={cn('relative flex size-4 shrink-0 items-center justify-center', ICON_COLOR[call.toolName] ?? 'text-muted-foreground')}>
          <span
            className={cn(
              'transition-opacity duration-100 group-hover/row:opacity-0',
              rowOpen && 'opacity-0',
            )}
          >
            {ICON[call.toolName] ?? <Terminal className="size-3.5" />}
          </span>
          <ChevronDown
            className={cn(
              'absolute size-3 transition-[opacity,transform] duration-150',
              rowOpen ? 'opacity-100' : 'opacity-0',
              'group-hover/row:opacity-100',
            )}
            style={{ transform: rowOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </span>
        {isChild && (
          <span
            title="run by sub-agent"
            className="shrink-0 text-[11px] leading-none text-primary/60 select-none"
          >
            ↳
          </span>
        )}
        <span className={cn('min-w-0 max-w-[45%] shrink-0 truncate text-[12.5px] font-medium', isChild ? 'text-foreground/60' : 'text-foreground/80')}>
          {toolLabel(call.toolName, call.status)}
        </span>
        {target && (
          <span className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 font-mono text-[11.5px] text-muted-foreground">
            {target}
          </span>
        )}
        <StatusGlyph call={call}/>
      </button>

      {/* expanded detail */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: rowOpen ? '1fr' : '0fr', opacity: rowOpen ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="scroll ml-[13px] mt-[5px] flex max-h-[368px] flex-col gap-0.5 overflow-y-auto border-l border-border py-0.5 pl-3">
            {call.display?.kind === 'diff' && onViewFile && (
              <button
                type="button"
                onClick={() => onViewFile(call.display!.kind === 'diff' ? call.display!.path : '')}
                className="w-fit text-[11px] text-primary hover:underline"
              >
                open diff →
              </button>
            )}
            {agentBody ?? details.map((line, i) => (
              <span
                key={i}
                className={cn(
                  'truncate font-mono text-[11.5px] leading-[1.6]',
                  line.tone === 'add' ? 'text-success' : line.tone === 'del' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {line.tone ? `${line.tone === 'add' ? '+' : '−'} ${line.text}` : line.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** Expanded dispatch_agent body: agent badge + usage, the task (scrollable),
 *  the sub-agent's child calls as fully expandable rows, and the report last. */
function AgentDetail({
  call,
  childCalls,
  openRows,
  toggleRow,
  onViewFile,
}: {
  call: ToolCall;
  childCalls: ToolCall[];
  openRows: Set<string>;
  toggleRow: (id: string) => void;
  onViewFile?: (path: string) => void;
}) {
  const d = call.display?.kind === 'agent' ? call.display : undefined;
  const agentName = d?.agentName ?? String(call.arguments?.name ?? 'agent');
  const task = d?.task ?? String(call.arguments?.task ?? '');
  const report = d?.report ?? call.report ?? call.output ?? '';
  return (
    <div className="flex flex-col gap-[5px] py-1">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
          {agentName}
        </span>
        {!!call.arguments?.resumeFrom && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px] text-muted-foreground">↻ resumed</span>
        )}
        {!!d?.background && (
          <span className="flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            {d.backgroundState === 'completed' ? (
              '✓ done'
            ) : d.backgroundState === 'error' ? (
              'failed'
            ) : d.backgroundState === 'interrupted' ? (
              'interrupted'
            ) : (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                running…
              </>
            )}
          </span>
        )}
        {childCalls.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            · {childCalls.length} tool {childCalls.length === 1 ? 'call' : 'calls'}
          </span>
        )}
        {!!d?.usage && (
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {(d.usage.inputTokens / 1000).toFixed(1)}k in · {(d.usage.outputTokens / 1000).toFixed(1)}k out
          </span>
        )}
      </div>
      {task && (
        <p className="whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-muted-foreground">{task}</p>
      )}
      {childCalls.map((c) => (
        <ChipRow key={c.id} call={c} isChild rowOpen={openRows.has(c.id)} onToggle={toggleRow} onViewFile={onViewFile} />
      ))}
      {report && (
        <p className="whitespace-pre-wrap rounded-md bg-secondary/40 px-2 py-1.5 text-[12px] leading-[1.65] text-foreground/85">
          {report}
        </p>
      )}
    </div>
  );
}

function ToolChipsImpl({
  calls,
  changes,
  streaming = false,
  onViewFile,
  bare = false,
}: {
  calls: ToolCall[];
  changes?: FileChangeEntry[];
  streaming?: boolean;
  onViewFile?: (path: string) => void;
  /** Headerless mode for inline (stream-view) rendering: rows only, always open. */
  bare?: boolean;
}) {
  const [openState, setOpenState] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const open = bare ? true : openState;

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openPreview = (entry: FileChangeEntry) => (event: React.SyntheticEvent) => {
    const el = (event.currentTarget as Element).closest('[data-diffchip]') as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const previewHeight = 38 + Math.min(entry.hunks?.reduce((n, h) => n + h.lines.length, 0) ?? 0, 40) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      entry,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };

  const closePreview = (path: string) => () =>
    setPreview((current) => (current?.entry.path === path ? null : current));

  const done = !streaming;
  // Agent parents absorb their children into the dispatch row's expanded
  // detail (AgentDetail), so agent children don't render as flat rows.
  const rows = calls.filter(
    (c) => !(c.parentToolCallId && calls.some((p) => p.id === c.parentToolCallId && isAgentCall(p))),
  );
  const visibleChanges = (changes ?? []).slice(0, MAX_CHIPS);
  const hiddenCount = (changes?.length ?? 0) - visibleChanges.length;

  return (
    <div className={cn('w-full', !bare && 'mt-[5px]')}>
      {/* collapsed run header (skipped in bare/inline mode) */}
      {!bare && (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenState((o) => !o)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-secondary/60"
      >
        <ChevronDown
          className="size-3 transition-transform duration-200"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
        <span className="tabular-nums">
          {rows.length} tool {rows.length === 1 ? 'call' : 'calls'}
        </span>
      </button>
      )}

      {/* tool call rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className={cn('mt-[5px] flex flex-col gap-[5px]', bare && '-ml-1.5')}>
            {rows.map((call, index) => {
              const isAgent = isAgentCall(call);
              const childCalls = isAgent ? calls.filter((c) => c.parentToolCallId === call.id) : [];
              return (
                <div key={call.id} style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both', animationDelay: done ? undefined : `${Math.min(index, 8) * 60}ms` }}>
                  <ChipRow
                    call={call}
                    rowOpen={openRows.has(call.id)}
                    onToggle={toggleRow}
                    onViewFile={onViewFile}
                    agentBody={isAgent ? (
                      <AgentDetail
                        call={call}
                        childCalls={childCalls}
                        openRows={openRows}
                        toggleRow={toggleRow}
                        onViewFile={onViewFile}
                      />
                    ) : undefined}
                  />
                </div>
              );
            })}
          </div>

          {/* file-diff chips */}
          {done && visibleChanges.length > 0 && (
            <div className="mt-[5px] flex max-w-full flex-wrap gap-[5px] border-t border-border pt-[5px]">
              {visibleChanges.map((c, i) => (
                <span
                  key={c.path}
                  data-diffchip
                  className="relative"
                  onMouseEnter={openPreview(c)}
                  onMouseLeave={closePreview(c.path)}
                >
                  <button
                    type="button"
                    aria-expanded={preview?.entry.path === c.path}
                    aria-label={`Show diff for ${c.path}`}
                    onFocus={openPreview(c)}
                    onBlur={closePreview(c.path)}
                    onClick={() => onViewFile?.(c.path)}
                    className="inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 font-mono text-[11.5px] text-foreground/85 shadow-sm transition-colors hover:bg-secondary"
                    style={{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
                  >
                    <span className="min-w-0 truncate">{c.path.split('/').pop()}</span>
                    {!!c.additions && <span className="shrink-0 text-success tabular-nums">+{c.additions}</span>}
                    {!!c.deletions && <span className="shrink-0 text-destructive tabular-nums">−{c.deletions}</span>}
                  </button>
                </span>
              ))}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => onViewFile?.(visibleChanges[0].path)}
                  className="inline-flex h-7 items-center rounded-md px-1.5 font-mono text-[11.5px] text-muted-foreground/70 underline decoration-transparent underline-offset-2 transition-colors hover:text-muted-foreground hover:decoration-current"
                  style={{ animation: `fade-in 300ms ease-out ${visibleChanges.length * 80}ms both` }}
                >
                  +{hiddenCount} more
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {preview && <DiffPreview preview={preview} />}
    </div>
  );
}

export const ToolChips = memo(ToolChipsImpl);
