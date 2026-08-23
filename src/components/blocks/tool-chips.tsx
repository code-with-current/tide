/* v2 tool-run rendering: compact chip rows per tool call.
 * Mockup-derived layout, but driven by real ToolCall data and Tide's design
 * tokens. Lives alongside (not replacing) the v1 tool-row. */

import { memo, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOOL_TEXT_COLOR } from '@/lib/tool-colors';
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
  MessageCircleReply,
  ClipboardCheck,
  GitCompareArrows,
  Minimize2,
  Plug,
  ChevronDown,
  Check,
  Copy,
  X,
  Loader2,
  ExternalLink,
  Image as ImageIcon,
  Database,
  FileWarning,
} from 'lucide-react';
import type { DiffHunk, DiffLine, ToolCall, ToolName } from '@/types';
import { cn } from '@/lib/utils';
import { toolLabel } from '@/lib/tool-labels';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { agentStatusOf, type AgentStatus } from './agent-status';

const ICON: Partial<Record<ToolName, React.ReactNode>> = {
  read_file: <FileSearch className="size-3" />,
  read_media_file: <ImageIcon className="size-3" />,
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
  memory: <Database className="size-3" />,
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
  read_file: 'bg-sky-300',
  read_media_file: 'bg-sky-300',
  glob: 'bg-sky-300',
  grep: 'bg-sky-300',
  memory: 'bg-muted-foreground',
  edit_file: 'bg-amber-300',
  multi_edit: 'bg-amber-300',
  write_file: 'bg-amber-300',
  notebook_edit: 'bg-amber-300',
  bash: 'bg-green-300',
  bash_output: 'bg-green-300',
  kill_shell: 'bg-green-300',
  git: 'bg-orange-300',
  dispatch_agent: 'bg-purple-300',
  todo_write: 'bg-blue-300',
  web_fetch: 'bg-cyan-300',
  web_search: 'bg-cyan-300',
  load_skill: 'bg-violet-300',
  ask_followup_question: 'bg-warning',
  exit_plan_mode: 'bg-teal-300',
  compact: 'bg-slate-300',
  mcp: 'bg-indigo-300',
};

const TEXT_COLOR = TOOL_TEXT_COLOR as Partial<Record<ToolName, string>>;

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
    case 'memory':
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
    case 'ask_followup_question':
      return String(a.question ?? '');
    default:
      return call.argPreview ?? '';
  }
}

const isAgentCall = (c: ToolCall) => c.toolName === 'dispatch_agent' || c.display?.kind === 'agent';

export function AgentStatusChip({ status }: { status: AgentStatus }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[0.75rem] text-muted-foreground',
        status === 'done' && 'text-success',
        status === 'error' && 'text-destructive',
      )}
    >
      {status === 'running' ? (
        <>
          <Loader2 className="size-2.5 animate-spin" />
          running…
        </>
      ) : status === 'done' ? (
        <>
          <Check className="size-2.5" />
          done
        </>
      ) : status === 'error' ? (
        <>
          <X className="size-2.5" />
          failed
        </>
      ) : (
        'interrupted'
      )}
    </span>
  );
}

/** Plain-text detail lines for the expanded row body — wrapping mono rows,
 *  never `truncate` (that ellipsized the ends of long lines away). */
function detailLinesOf(call: ToolCall): string[] {
  const src = call.display?.kind === 'text' ? call.display.text : call.output;
  if (!src) return [];
  return (src as string)
    .replace(ANSI_RE, '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 500);
}

/** directory_tree output rendered as one pre block. Per-line truncation
 *  destroys trees: the filename sits at the END of each line, behind the
 *  `│   ├── ` prefixes, so `truncate` shows only the prefixes and ellipsizes
 *  the names away. */
function treeSourceOf(call: ToolCall): string | undefined {
  if (call.toolName !== 'directory_tree') return undefined;
  const src = (call.display?.kind === 'text' ? call.display.text : call.output) as string | undefined;
  if (!src) return undefined;
  const clean = src.replace(ANSI_RE, '');
  const lines = clean.split('\n');
  if (lines.length <= 500) return clean;
  return lines.slice(0, 500).join('\n') + `\n… ${lines.length - 500} more lines`;
}

/** ask_followup_question payload for the expanded row: question + offered
 *  options from the args, answer parsed from the tool output ('User picked: …'
 *  — multi-picks are ", "-joined). This is the persisted Q&A trace — it lives
 *  in the tool row so the turn reads as one comprehensive tooling step. */
function followupBodyOf(call: ToolCall):
  | {
      question: string;
      options: { label: string; description?: string }[];
      answer: string | null;
      finished: boolean;
    }
  | undefined {
  if (call.toolName !== 'ask_followup_question') return undefined;
  const a = call.arguments ?? {};
  const question = typeof a.question === 'string' ? a.question : '';
  if (!question) return undefined;
  const options = Array.isArray(a.options)
    ? a.options
        .map((o) => {
          if (typeof o === 'string') return { label: o };
          if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string') {
            const rec = o as { label: string; description?: unknown };
            return {
              label: rec.label,
              description: typeof rec.description === 'string' ? rec.description : undefined,
            };
          }
          return undefined;
        })
        .filter((o): o is { label: string; description?: string } => o !== undefined)
    : [];
  const out = typeof call.output === 'string' ? call.output : '';
  const m = out.match(/^User picked: ([\s\S]*)$/);
  return { question, options, answer: m ? (m[1] ?? '') : null, finished: out.length > 0 };
}

/** Expanded ask_followup_question body — the persisted Q&A trace, styled to
 *  echo the live picker: the question in full, the offered options as cards
 *  (picked one(s) highlighted with a check), and the typed reply when it was
 *  free-text or a custom answer (or a muted note while awaiting / unanswered). */
function FollowupBody({ q }: { q: NonNullable<ReturnType<typeof followupBodyOf>> }) {
  const picked = q.answer != null ? q.answer.split(', ').map((p) => p.trim()) : [];
  const matchedAnOption = q.options.some((o) => picked.includes(o.label));
  return (
    <div className="flex flex-col gap-2 py-0.5 pr-1">
      <p className="break-words text-[0.8929rem] font-medium leading-snug text-foreground">
        {q.question}
      </p>
      {q.options.length > 0 && (
        <div className="flex flex-col gap-1">
          {q.options.map((o) => {
            const isPicked = picked.includes(o.label);
            return (
              <div
                key={o.label}
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[0.8571rem] leading-snug',
                  isPicked
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border bg-background/60 text-muted-foreground/70',
                )}
              >
                <span
                  className={cn(
                    'mt-[1px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px]',
                    isPicked ? 'bg-primary' : 'border border-muted-foreground/30',
                  )}
                >
                  {isPicked && <Check className="size-2.5 text-primary-foreground" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words font-medium">{o.label}</span>
                  {o.description && (
                    <span className="break-words text-[0.7857rem] leading-snug text-muted-foreground/70">
                      {o.description}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {q.answer != null && !matchedAnOption && (
        <div className="flex items-start gap-2 rounded-lg bg-secondary/70 px-2 py-1.5">
          <MessageCircleReply className="mt-[3px] size-3.5 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[0.6786rem] font-semibold uppercase tracking-wider text-muted-foreground/60">
              your answer
            </span>
            <span className="break-words text-[0.8571rem] font-medium leading-snug text-foreground">
              {q.answer}
            </span>
          </div>
        </div>
      )}
      {q.finished && q.answer == null && (
        <p className="text-[0.7857rem] italic text-muted-foreground/60">no answer</p>
      )}
      {!q.finished && (
        <p className="flex items-center gap-1.5 text-[0.7857rem] text-muted-foreground/70">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          waiting for your reply…
        </p>
      )}
    </div>
  );
}

/** todo_write payload from the call arguments — the full-replacement list
 *  is authoritative (the text display is just a flattened mirror of it). */
type TodoEntry = { content: string; status: string; priority?: string };

function todoBodyOf(call: ToolCall): { todos: TodoEntry[] } | undefined {
  if (call.toolName !== 'todo_write') return undefined;
  const a = call.arguments ?? {};
  const todos = Array.isArray(a.todos)
    ? a.todos
        .map((t): TodoEntry | undefined =>
          t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string'
            ? {
                content: (t as { content: string }).content,
                status: typeof (t as { status?: unknown }).status === 'string' ? (t as { status: string }).status : 'pending',
                priority: typeof (t as { priority?: unknown }).priority === 'string' ? (t as { priority: string }).priority : undefined,
              }
            : undefined,
        )
        .filter((t): t is TodoEntry => t !== undefined)
    : [];
  return todos.length > 0 ? { todos } : undefined;
}

const TODO_PRIORITY_COLOR: Record<string, string> = {
  high: 'bg-destructive/70',
  medium: 'bg-warning/80',
  low: 'bg-muted-foreground/40',
};

function TodoBody({ todos }: { todos: NonNullable<ReturnType<typeof todoBodyOf>>['todos'] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const cancelled = todos.filter((t) => t.status === 'cancelled').length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  return (
    <div className="flex flex-col gap-2 py-0.5 pr-1">
      <div className="flex items-center gap-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">
          {done}/{todos.length} done{cancelled ? ` · ${cancelled} cancelled` : ''}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {todos.map((t, i) => {
          const isDone = t.status === 'completed';
          const isActive = t.status === 'in_progress';
          const isCancelled = t.status === 'cancelled';
          return (
            <div key={i} className="flex items-start gap-2 text-[0.8571rem] leading-snug">
              <span
                className={cn(
                  'mt-[1px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px]',
                  isDone && 'bg-primary',
                  isActive && 'border border-primary/60',
                  !isDone && !isActive && !isCancelled && 'border border-muted-foreground/30',
                  isCancelled && 'border border-muted-foreground/20 text-muted-foreground/50',
                )}
              >
                {isDone && <Check className="size-2.5 text-primary-foreground" />}
                {isActive && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
                {isCancelled && <X className="size-2.5" />}
              </span>
              {t.priority && (
                <span
                  title={`${t.priority} priority`}
                  className={cn('mt-[6px] size-1.5 shrink-0 rounded-full', TODO_PRIORITY_COLOR[t.priority] ?? 'bg-muted-foreground/40')}
                />
              )}
              <span
                className={cn(
                  'min-w-0 break-words',
                  isDone && 'text-muted-foreground/70 line-through',
                  isActive && 'font-medium text-foreground',
                  !isDone && !isActive && !isCancelled && 'text-muted-foreground',
                  isCancelled && 'text-muted-foreground/40 line-through',
                )}
              >
                {t.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** read_media_file preview — the tool already emits the payload as a media
 *  display; render it instead of the "Read x (12.3KB)" summary. */
function mediaBodyOf(call: ToolCall): { dataUrl: string; mimeType: string } | undefined {
  return call.display?.kind === 'media' ? { dataUrl: call.display.dataUrl, mimeType: call.display.mimeType } : undefined;
}

/** Copyable source path: prefer the argument, fall back to the output summary
 *  (`Read <path> (…)`) so reloaded/legacy calls still show it. */
function mediaPathOf(call: ToolCall): string | undefined {
  const a = call.arguments;
  if (a && typeof a.path === 'string' && a.path) return a.path;
  const m = (call.output ?? '').match(/^Read (.+?) \(/);
  return m ? m[1] : undefined;
}

/** SVGs whose root <svg> lacks width/height have no intrinsic size — inside the
 * shrink-to-fit chip they collapse to nothing. Inject explicit dimensions (scaled
 * from the viewBox ratio) and re-encode so <img> always has something to render. */
function normalizeSvgSrc(dataUrl: string, isDark: boolean): string {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const svgText = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const vb = svgText.match(/viewBox=["']\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    const w = 480;
    const h = vb ? Math.round((Number(vb[4]) / Math.max(Number(vb[3]), 0.001)) * w) || w : w;
    let sized = svgText.replace(/(<svg\b[^>]*?)\swidth=["'][^"']*["']/i, '$1');
    sized = sized.replace(/(<svg\b[^>]*?)\sheight=["'][^"']*["']/i, '$1');
    sized = sized.replace(/<svg\b/i, `<svg width="${w}" height="${h}"`);
    if (/currentColor/i.test(sized)) {
      sized = sized.replace(/<svg\b/i, `<svg color="${isDark ? '#e4e4e7' : '#27272a'}" `);
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  } catch {
    return dataUrl;
  }
}

function MediaBody({ dataUrl, mimeType, path }: { dataUrl: string; mimeType: string; path?: string }) {
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [broken, setBroken] = useState(false);
  const isImage = mimeType.startsWith('image/');
  const isAudio = mimeType.startsWith('audio/');
  const isVideo = mimeType.startsWith('video/');
  const isDark = document.documentElement.classList.contains('dark');
  const src = useMemo(
    () => (mimeType === 'image/svg+xml' ? normalizeSvgSrc(dataUrl, isDark) : dataUrl),
    [dataUrl, mimeType, isDark],
  );

  const copyPath = () => {
    if (!path) return;
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col gap-1.5 py-0.5 pr-1">
      {isImage && !broken && (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="w-fit cursor-zoom-in overflow-hidden rounded-lg border border-border"
        >
          <img
            src={src}
            alt=""
            className="max-h-56 max-w-full object-contain"
            onError={() => setBroken(true)}
          />
        </button>
      )}
      {isAudio && <audio controls src={dataUrl} className="w-full max-w-md" />}
      {isVideo && <video controls src={dataUrl} className="max-h-72 max-w-full rounded-lg border border-border" />}
      {((!isImage && !isAudio && !isVideo) || broken) && (
        <div className="flex w-fit items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-[0.7857rem] text-muted-foreground">
          <FileWarning className="size-3.5 shrink-0" />
          {mimeType}
          {broken ? ' — could not be displayed' : ' — no inline preview'}
        </div>
      )}
      {path && (
        <button
          type="button"
          onClick={copyPath}
          title={path}
          className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-[0.7857rem] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <span className="truncate font-mono">{path}</span>
          {copied ? (
            <Check className="size-3 shrink-0 text-success" />
          ) : (
            <Copy className="size-3 shrink-0" />
          )}
        </button>
      )}
      {zoomed &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-8 backdrop-blur-sm"
            onClick={() => setZoomed(false)}
          >
            <img
              src={src}
              alt=""
              className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** read_file body — numbered, wrapping code lines. The generic renderer
 *  truncated each line (nowrap + ellipsis) in muted grey and dropped blank
 *  lines, ellipsizing the ends of long code lines away. */
function readBodyOf(call: ToolCall): string | undefined {
  if (call.toolName !== 'read_file') return undefined;
  const src = call.display?.kind === 'text' ? call.display.text : call.output;
  if (typeof src !== 'string' || !src.trim()) return undefined;
  const lines = src.split('\n');
  if (lines.length <= 500) return src;
  return `${lines.slice(0, 500).join('\n')}\n… ${lines.length - 500} more lines`;
}

function ReadBody({ src }: { src: string }) {
  const lines = src.split('\n');
  const w = String(lines.length).length;
  return (
    <div className="flex min-w-0 flex-col font-mono text-[0.8214rem] leading-[1.6] text-foreground/80">
      {lines.map((l, i) => (
        <div key={i} className="flex items-start">
          <span
            className="shrink-0 select-none pr-2.5 text-right tabular-nums text-muted-foreground/40"
            style={{ width: `${w + 1}ch` }}
          >
            {i + 1}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{l || '\u00a0'}</span>
        </div>
      ))}
    </div>
  );
}

/** edit/multi_edit/write body — the real diff viewer (unified or split with
 *  word-level highlights), replacing stacked truncated diff lines. write_file
 *  only has the resulting content (display text), so its hunks are synthesized
 *  as an all-add diff of what the tool put on disk. */
const MAX_SYNTH_LINES = 400;

function diffBodyOf(call: ToolCall): DiffHunk[] | undefined {
  if (call.display?.kind === 'diff') return call.display.hunks;
  if (call.toolName !== 'write_file') return undefined;
  const src = call.display?.kind === 'text' ? call.display.text : undefined;
  if (typeof src !== 'string' || !src.trim()) return undefined;
  const lines = src.split('\n');
  const capped = lines.length > MAX_SYNTH_LINES;
  const rows: DiffLine[] = (capped ? lines.slice(0, MAX_SYNTH_LINES) : lines).map((text, i) => ({
    type: 'add' as const,
    newNo: i + 1,
    text,
  }));
  if (capped) rows.push({ type: 'context' as const, text: `… ${lines.length - MAX_SYNTH_LINES} more lines` });
  return [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: rows }];
}

function filePathOf(call: ToolCall): string {
  if (call.display?.kind === 'diff') return call.display.path;
  return String(call.arguments?.path ?? call.arguments?.file_path ?? '');
}

function BodyActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 w-fit items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 text-[0.7857rem] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {icon}
      {label}
    </button>
  );
}

/** bash / bash_output body — terminal output as a wrapping mono block. The
 *  generic renderer drew each line as a truncated muted span: the end of long
 *  build errors got ellipsized away and the low-contrast grey was easy to miss. */
function bashBodyOf(call: ToolCall): { output: string; durationMs?: number } | undefined {
  if (call.toolName !== 'bash' && call.toolName !== 'bash_output') return undefined;
  const src = ((call.display?.kind === 'text' ? call.display.text : call.output) ?? '').replace(ANSI_RE, '');
  if (!src.trim()) return undefined;
  const lines = src.split('\n');
  const output = lines.length > 500 ? `${lines.slice(0, 500).join('\n')}\n… ${lines.length - 500} more lines` : src;
  return { output, durationMs: call.durationMs };
}

function BashBody({ b }: { b: { output: string; durationMs?: number } }) {
  return (
    <div className="flex flex-col gap-1 py-0.5">
      {b.durationMs != null && (
        <span className="text-[0.75rem] tabular-nums text-muted-foreground">
          {(b.durationMs / 1000).toFixed(b.durationMs < 10_000 ? 2 : 1)}s
        </span>
      )}
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.8214rem] leading-[1.6] text-foreground/80">
        {b.output}
      </pre>
    </div>
  );
}

/** web_search results parsed from the output text — the tool formats each
 *  result as `N. title\n   url\n   snippet` blocks joined by blank lines. */
function searchBodyOf(call: ToolCall): { title: string; url: string; snippet: string }[] | undefined {
  if (call.toolName !== 'web_search') return undefined;
  const src = (call.display?.kind === 'text' ? call.display.text : call.output) as string | undefined;
  if (!src) return undefined;
  const results: { title: string; url: string; snippet: string }[] = [];
  for (const m of src.matchAll(/\d+\.\s+(.+)\n\s+(https?:\/\/\S+)\n\s+([^\n]+)/g)) {
    results.push({ title: m[1]!.trim(), url: m[2]!.trim(), snippet: m[3]!.trim() });
  }
  return results.length > 0 ? results : undefined;
}

function SearchBody({ results }: { results: NonNullable<ReturnType<typeof searchBodyOf>> }) {
  return (
    <div className="flex flex-col gap-1.5 py-0.5 pr-1">
      {results.map((r, i) => {
        let host = '';
        try { host = new URL(r.url).hostname; } catch { /* keep empty */ }
        return (
          <div key={i} className="flex flex-col gap-1 rounded-lg border border-border bg-background/60 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {host && (
                <span className="shrink-0 rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[0.7143rem] text-muted-foreground">
                  {host}
                </span>
              )}
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 break-words text-[0.8929rem] font-medium leading-snug text-primary hover:underline"
              >
                {r.title}
              </a>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground/50" />
            </div>
            <p className="break-words text-[0.8214rem] leading-snug text-muted-foreground">{r.snippet}</p>
          </div>
        );
      })}
    </div>
  );
}

/** grep output grouped by file. Raw `path:line:match` lines end-truncate
 *  badly (long paths ellipsize the match away) and bury the structure. */
function grepBodyOf(call: ToolCall):
  | { groups: { path: string; matches: { line: string; text: string }[] }[]; total: number; re?: RegExp }
  | undefined {
  if (call.toolName !== 'grep') return undefined;
  const src = (call.display?.kind === 'text' ? call.display.text : call.output) as string | undefined;
  if (!src || src.trim() === '(no matches)') return undefined;
  const groups: { path: string; matches: { line: string; text: string }[] }[] = [];
  const byPath = new Map<string, { path: string; matches: { line: string; text: string }[] }>();
  let total = 0;
  for (const l of src.split('\n')) {
    if (!l.trim()) continue;
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, path, line, text] = m as unknown as [string, string, string, string];
    let g = byPath.get(path);
    if (!g) {
      g = { path, matches: [] };
      byPath.set(path, g);
      groups.push(g);
    }
    g.matches.push({ line, text });
    total++;
    if (total >= 500) break;
  }
  if (total === 0) return undefined;
  const pattern = typeof (call.arguments ?? {}).pattern === 'string' ? (call.arguments!).pattern as string : undefined;
  let re: RegExp | undefined;
  if (pattern && pattern.length < 500) {
    try { re = new RegExp(pattern, 'g'); } catch { /* rg syntax ≠ JS regex — skip highlighting */ }
  }
  return { groups, total, re };
}

function GrepBody({ groups, total, re }: { groups: NonNullable<ReturnType<typeof grepBodyOf>>['groups']; total: number; re?: RegExp }) {
  return (
    <div className="flex flex-col gap-2 py-0.5 pr-1">
      <p className="text-[0.7857rem] text-muted-foreground">
        {total} match{total === 1 ? '' : 'es'} · {groups.length} file{groups.length === 1 ? '' : 's'}
      </p>
      {groups.map((g) => (
        <div key={g.path} className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[0.8214rem] font-medium text-foreground/80">
              {g.path}
            </span>
            <span className="shrink-0 rounded-full bg-secondary/70 px-1.5 text-[0.7143rem] tabular-nums text-muted-foreground">
              {g.matches.length}
            </span>
          </div>
          {g.matches.map((m, i) => (
            <div key={i} className="flex items-start gap-2 font-mono text-[0.8214rem] leading-[1.6]">
              <span className="w-9 shrink-0 select-none text-right tabular-nums text-muted-foreground/50">
                {m.line}
              </span>
              <span className="min-w-0 break-all whitespace-pre-wrap text-muted-foreground">
                {re ? highlight(m.text, re) : m.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function highlight(text: string, re: RegExp): React.ReactNode {
  re.lastIndex = 0;
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-warning/25 px-0.5 font-semibold text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/** memory (RAG) hits parsed from the display text — the tool formats results
 *  as a `Found N …` header plus `[i] path:line (symbol) · NN%` entries each
 *  followed by the chunk body. Per-line truncation makes those 1500-char
 *  code bodies unreadable one-liners, so they get their own card layout. */
function memoryBodyOf(call: ToolCall):
  | { query: string; total: number; hits: { path: string; line: string; symbol?: string; sim?: number; body: string }[] }
  | undefined {
  if (call.toolName !== 'memory') return undefined;
  const src = (call.display?.kind === 'text' ? call.display.text : call.output) as string | undefined;
  if (!src) return undefined;
  const head = src.match(/^Found (\d+) relevant chunks? for "([\s\S]*?)" \(out of ([\d,]+)\):/);
  if (!head) return undefined;
  const hits: { path: string; line: string; symbol?: string; sim?: number; body: string }[] = [];
  let cur: (typeof hits)[number] | undefined;
  for (const l of src.split('\n').slice(1)) {
    const m = l.match(/^\[\d+\] (\S+):(\d+)(?: \(([^)]*)\))?(?: · (\d+)%)?$/);
    if (m) {
      const [, path, line, symbol, sim] = m as unknown as [string, string, string, string | undefined, string | undefined];
      cur = { path, line, symbol: symbol || undefined, sim: sim ? Number(sim) : undefined, body: '' };
      hits.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.body = cur.body ? `${cur.body}\n${l}` : l;
  }
  if (hits.length === 0) return undefined;
  return { query: head[2]!, total: Number(head[3]!.replace(/,/g, '')), hits };
}

function MemoryBody({ mem }: { mem: NonNullable<ReturnType<typeof memoryBodyOf>> }) {
  return (
    <div className="flex flex-col gap-1.5 py-0.5 pr-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-[0.8929rem] font-medium leading-snug text-foreground/90">
          “{mem.query}”
        </span>
        <span className="shrink-0 rounded-full bg-secondary/70 px-1.5 text-[0.7143rem] tabular-nums text-muted-foreground">
          {mem.hits.length} of {mem.total.toLocaleString()} chunks
        </span>
      </div>
      {mem.hits.map((h, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg border border-border bg-background/60 px-2.5 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[0.8214rem] font-medium text-foreground/80">
              {h.path}:{h.line}
            </span>
            {h.symbol && (
              <span className="shrink-0 rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[0.7143rem] text-muted-foreground">
                {h.symbol}
              </span>
            )}
            {h.sim != null && (
              <span
                title="similarity"
                className={cn(
                  'shrink-0 rounded-full px-1.5 text-[0.7143rem] tabular-nums',
                  h.sim >= 80 ? 'bg-success/15 text-success' : h.sim >= 60 ? 'bg-warning/15 text-warning' : 'bg-secondary/70 text-muted-foreground',
                )}
              >
                {h.sim}%
              </span>
            )}
          </div>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[0.7857rem] leading-[1.6] text-muted-foreground">
            {h.body.trim()}
          </pre>
        </div>
      ))}
    </div>
  );
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

/** A single tool chip row. Expandable rows toggle an inline detail body;
 *  dispatch_agent rows are NON-expanding single lines — click opens the
 *  sub-agent's stream in the Agents right-panel tab (onOpenDispatch). */
function ChipRow({
  call,
  rowOpen,
  onToggle,
  onViewFile,
  onViewDiff,
  onOpenDispatch,
}: {
  call: ToolCall;
  rowOpen: boolean;
  onToggle: (id: string) => void;
  onViewFile?: (path: string) => void;
  onViewDiff?: (entry: { path: string; hunks?: DiffHunk[] }) => void;
  onOpenDispatch?: () => void;
}) {
  if (onOpenDispatch) {
    const d = call.display?.kind === 'agent' ? call.display : undefined;
    const task = (d?.task ?? call.argPreview ?? '').replace(/\s+/g, ' ').trim();
    const summary = task.length > 60 ? `${task.slice(0, 60)}…` : task;
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpenDispatch}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpenDispatch();
        }}
        title="Stream in the Agents Panel"
        className="group/row flex h-7 w-full min-w-0 max-w-full items-center gap-2 rounded-md text-left transition-colors cursor-pointer hover:bg-secondary/60 hover:rounded-lg"
      >
        <span className="relative flex h-7 shrink-0 items-center justify-center">
          <span className={cn(
            'flex h-7 items-center rounded-l-md px-2 text-black tool-bg',
            'transition-opacity duration-100 group-hover/row:opacity-0',
            ICON_COLOR[call.toolName] ?? 'bg-muted-foreground',
          )}>
            {ICON[call.toolName] ?? <Terminal className="size-3.5" />}
          </span>
          <ChevronDown className="absolute size-3 opacity-0 text-muted-foreground transition-[opacity,transform] duration-150 group-hover/row:opacity-100" style={{ transform: 'rotate(-90deg)' }} />
        </span>
        <span className={cn('tool-tint min-w-0 max-w-[45%] shrink-0 truncate text-[0.8929rem] font-medium', TEXT_COLOR[call.toolName] ?? 'text-foreground/80')}>
          {d?.agentName ?? toolLabel(call.toolName, call.status)}
        </span>
        {summary && (
          <span
            title={d?.task ?? call.argPreview}
            className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 font-mono text-[0.8214rem] text-muted-foreground"
          >
            {summary}
          </span>
        )}
        <AgentStatusChip status={agentStatusOf(call)} />
        {call.durationMs != null && (
          <span className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">
            {(call.durationMs / 1000).toFixed(call.durationMs < 10_000 ? 2 : 1)}s
          </span>
        )}
        {!!d?.usage && (
          <span className="shrink-0 font-mono text-[0.75rem] text-muted-foreground">
            {(d.usage.inputTokens / 1000).toFixed(1)}k in · {(d.usage.outputTokens / 1000).toFixed(1)}k out
          </span>
        )}
      </div>
    );
  }
  const treeSrc = treeSourceOf(call);
  const followup = followupBodyOf(call);
  const todo = todoBodyOf(call);
  const media = mediaBodyOf(call);
  const search = searchBodyOf(call);
  const grep = grepBodyOf(call);
  const mem = memoryBodyOf(call);
  const bash = bashBodyOf(call);
  const read = readBodyOf(call);
  const diff = diffBodyOf(call);
  const details =
    diff != null || treeSrc != null || followup != null || todo != null || media != null || search != null || grep != null || mem != null || bash != null || read != null
      ? []
      : detailLinesOf(call);
  const target = targetOf(call);
  const expandable = details.length > 0 || treeSrc != null || followup != null || todo != null || media != null || search != null || grep != null || mem != null || bash != null || read != null;
  return (
    <>
      <div
        role="button"
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? rowOpen : undefined}
        aria-disabled={!expandable}
        onClick={() => expandable && onToggle(call.id)}
        onKeyDown={(e) => {
          if (!expandable || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onToggle(call.id);
        }}
        className={cn(
          'group/row flex h-7 w-full min-w-0 max-w-full items-center gap-2 rounded-md text-left transition-colors',
          expandable ? 'cursor-pointer' : 'cursor-default',
          'hover:bg-secondary/60 hover:rounded-lg',
        )}
      >
        <span className="relative flex shrink-0 items-center justify-center">
          <span
            className={cn(
              'flex h-7 items-center rounded-l-md px-2 text-black tool-bg',
              'transition-opacity duration-100 group-hover/row:opacity-0',
              rowOpen && 'opacity-0',
              ICON_COLOR[call.toolName] ?? 'bg-muted-foreground',
            )}
          >
            {ICON[call.toolName] ?? <Terminal className="size-3.5" />}
          </span>
          <ChevronDown
            className={cn(
              'absolute size-3 text-muted-foreground transition-[opacity,transform] duration-150',
              rowOpen ? 'opacity-100' : 'opacity-0',
              'group-hover/row:opacity-100',
            )}
            style={{ transform: rowOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </span>
        <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[0.8929rem] font-medium text-foreground/80">
          {toolLabel(call.toolName, call.status)}
        </span>
        {target && (
          <span className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 font-mono text-[0.8214rem] text-muted-foreground">
            {target}
          </span>
        )}
        {diff != null && onViewDiff != null && (
          <button
            type="button"
            title="Review diff"
            onClick={(e) => {
              e.stopPropagation();
              onViewDiff({ path: filePathOf(call), hunks: diff });
            }}
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.7857rem] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
          >
            <GitCompareArrows className="size-3" />
            Review
          </button>
        )}
        <StatusGlyph call={call}/>
      </div>

      {/* expanded detail */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: rowOpen ? '1fr' : '0fr', opacity: rowOpen ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="scroll ml-[13px] mt-[5px] flex max-h-[368px] flex-col gap-0.5 overflow-y-auto border-l border-border py-0.5 pl-3">
            {followup != null ? (
              <FollowupBody q={followup} />
            ) : todo != null ? (
              <TodoBody todos={todo.todos} />
            ) : media != null ? (
              <MediaBody
                dataUrl={media.dataUrl}
                mimeType={media.mimeType}
                path={mediaPathOf(call)}
              />
            ) : search != null ? (
              <SearchBody results={search} />
            ) : grep != null ? (
              <GrepBody groups={grep.groups} total={grep.total} re={grep.re} />
            ) : mem != null ? (
              <MemoryBody mem={mem} />
            ) : bash != null ? (
              <BashBody b={bash} />
            ) : read != null ? (
              <div className="flex flex-col gap-1">
                {onViewFile && filePathOf(call) && (
                  <BodyActionButton
                    icon={<FileSearch className="size-3" />}
                    label="Open File"
                    onClick={() => onViewFile(filePathOf(call))}
                  />
                )}
                <ReadBody src={read} />
              </div>
            ) : treeSrc != null ? (
              <pre className="whitespace-pre font-mono text-[0.8214rem] leading-[1.6] text-muted-foreground">
                {treeSrc}
              </pre>
            ) : details.map((line, i) => (
              <span key={i} className="whitespace-pre-wrap break-all font-mono text-[0.8214rem] leading-[1.6] text-muted-foreground">
                {line}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ToolChipsImpl({
  calls,
  streaming = false,
  variant = 'header',
  sessionId,
  onViewFile,
  onViewDiff,
}: {
  calls: ToolCall[];
  streaming?: boolean;
  variant?: 'header' | 'stream';
  /** Owning session — wires dispatch rows to the Agents tab. Without it,
   *  dispatch rows render but don't navigate. */
  sessionId?: string | null;
  onViewFile?: (path: string) => void;
  onViewDiff?: (entry: { path: string; hunks?: DiffHunk[] }) => void;
}) {
  const [openState, setOpenState] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const open = openState;

  // Follow lives on the stream variant's rows container only — compact keeps
  // its uncapped layout inside ProcessContainer.
  const rowsRef = useRef<HTMLDivElement>(null);
  useFollowScroll(rowsRef, streaming);

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const done = !streaming;
  // Agent children don't render as top-level rows — they live in the
  // dispatch's Agents-tab stream instead.
  const rows = calls.filter(
    (c) => !(c.parentToolCallId && calls.some((p) => p.id === c.parentToolCallId && isAgentCall(p))),
  );

  const openDispatch = (call: ToolCall) => {
    if (!sessionId) return;
    useUi.getState().setFocusedDispatch(sessionId, call.id);
    useTabs.getState().addTab(sessionId, 'agents');
    useTabs.getState().setActive(sessionId, 'agents');
    useUi.getState().setRightPanel(true);
  };

  const rowEls = rows.map((call, index) => {
    const isAgent = isAgentCall(call);
    return (
      <div key={call.id} style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both', animationDelay: done ? undefined : `${Math.min(index, 8) * 60}ms` }}>
        <ChipRow
          call={call}
          rowOpen={openRows.has(call.id)}
          onToggle={toggleRow}
          onViewFile={onViewFile}
          onViewDiff={onViewDiff}
          onOpenDispatch={isAgent && sessionId ? () => openDispatch(call) : undefined}
        />
      </div>
    );
  });

  if (variant === 'stream') {
    return (
      <div className="w-full">
        <div ref={rowsRef} className={cn('mt-[5px] flex flex-col gap-[5px]', streaming && 'max-h-[420px] overflow-y-auto')}>
          {rowEls}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full mt-[5px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenState((o) => !o)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.8929rem] text-muted-foreground transition-colors hover:bg-secondary/60"
      >
        <ChevronDown
          className="size-3 transition-transform duration-200"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
        <span className="tabular-nums">
          {rows.length} tool {rows.length === 1 ? 'call' : 'calls'}
        </span>
      </button>

      {/* tool call rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="mt-[5px] flex flex-col gap-[5px]">
            {rowEls}
          </div>
        </div>
      </div>
    </div>
  );
}

export const ToolChips = memo(ToolChipsImpl);
