import { memo, useState } from 'react';
import {
  FileSearch,
  FilePen,
  Terminal,
  Folder,
  GitBranch,
  Bot,
  ListChecks,
  Globe,
  Search,
  BookOpen,
  HelpCircle,
  ClipboardCheck,
  Minimize2,
  Plug,
  ChevronRight,
  ChevronUp,
  Check,
  X,
  Loader2,
  Coins,
  FileText,
} from 'lucide-react';
import type { ToolCall, ToolDisplay, ToolName } from '@/types';
import { cn } from '@/lib/utils';
import { toolLabel } from '@/lib/tool-labels';
import { DiffView } from './DiffView';
import { PermissionCard } from './PermissionCard';
import { usePermissionSurface } from './permission-context';
import { Button } from '@/components/ui/button';

// 1code-style tool row: borderless single-line status with a colored left accent; click to expand inline content (diff, output, agent report).

const ICON: Record<ToolName, React.ReactNode> = {
  read_file: <FileSearch className="size-3 text-muted-foreground/60" />,
  edit_file: <FilePen className="size-3 text-muted-foreground/60" />,
  multi_edit: <FilePen className="size-3 text-muted-foreground/60" />,
  write_file: <FilePen className="size-3 text-muted-foreground/60" />,
  list_dir: <Folder className="size-3 text-muted-foreground/60" />,
  glob: <FileSearch className="size-3 text-muted-foreground/60" />,
  bash: <Terminal className="size-3 text-muted-foreground/60" />,
  bash_output: <Terminal className="size-3 text-muted-foreground/60" />,
  kill_shell: <Terminal className="size-3 text-muted-foreground/60" />,
  grep: <FileSearch className="size-3 text-muted-foreground/60" />,
  git: <GitBranch className="size-3 text-muted-foreground/60" />,
  dispatch_agent: <Bot className="size-3 text-muted-foreground/60" />,
  load_skill: <BookOpen className="size-3 text-muted-foreground/60" />,
  memory: <BookOpen className="size-3 text-muted-foreground/60" />,
  todo_write: <ListChecks className="size-3 text-muted-foreground/60" />,
  web_fetch: <Globe className="size-3 text-muted-foreground/60" />,
  web_search: <Search className="size-3 text-muted-foreground/60" />,
  notebook_edit: <BookOpen className="size-3 text-muted-foreground/60" />,
  ask_followup_question: <HelpCircle className="size-3 text-muted-foreground/60" />,
  exit_plan_mode: <ClipboardCheck className="size-3 text-muted-foreground/60" />,
  compact: <Minimize2 className="size-3 text-muted-foreground/60" />,
  slash_command: <span className="text-primary" >/</span>,
  mcp: <Plug className="size-3 text-muted-foreground/60" />,
};

/** Status glyph — 1code uses a single char + tone, no chip. */
function StatusGlyph({ call }: { call: ToolCall }) {
  switch (call.status) {
    case 'executed':
      return <Check className="size-3 text-success" />;
    case 'failed':
      return <X className="size-3 text-destructive" />;
    case 'rejected':
      return <X className="size-3 text-muted-foreground/60" />;
    case 'awaiting_input':
      return <HelpCircle className="size-3 text-primary animate-pulse" />;
    case 'pending':
    case 'running':
      return <Loader2 className="size-3 text-muted-foreground animate-spin" />;
    case 'aborted':
    case 'timeout':
      return <X className="size-3 text-warning" />;
    default:
      return <span className="size-3 text-muted-foreground/60">·</span>;
  }
}

/** Left accent — colors by outcome, otherwise muted. */
function accentClass(call: ToolCall): string {
  switch (call.status) {
    case 'executed': return 'bg-success/40';
    case 'failed':   return 'bg-destructive/40';
    case 'rejected': return 'bg-muted-foreground/40/30';
    case 'awaiting_input': return 'bg-primary/60';
    case 'pending':
    case 'running':  return 'bg-primary/50';
    default:         return 'bg-line';
  }
}

function formatMs(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Pull a short identifier out of the args — path, command, pattern, etc. */
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
      return String(a.pattern ?? '');
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
      return String(a.agentName ?? a.agent ?? '');
    case 'todo_write':
      return Array.isArray(a.todos) ? `${a.todos.length} items` : '';
    default:
      return call.argPreview ?? '';
  }
}

function hasBody(call: ToolCall): boolean {
  if (call.display?.kind === 'diff') return true;
  if (call.display?.kind === 'agent') return true;
  if (call.display?.kind === 'text') return true;
  if (call.display?.kind === 'command') return true;
  if (call.display?.kind === 'file_list') return true;
  if (call.display?.kind === 'file_loaded') return true;
  if (call.output && call.toolName === 'bash') return true;
  // ask_followup_question always has a body — the question, the options,
  // and (once resolved) the user's answer. Without this, the row's expand
  // button stays disabled and FollowupToolBody never renders, so the
  // answer is invisible even though it's stored on call.output.
  if (call.toolName === 'ask_followup_question') return true;
  return false;
}

/** Initial open state for the row body. ask_followup_question defaults to
 *  expanded — the question + answer are the whole point of the row and
 *  shouldn't require a click to reveal. Other tools start collapsed. */
function initialOpenFor(call: ToolCall): boolean {
  return call.toolName === 'ask_followup_question';
}

/** Inline expandable body — shown below the row when expanded. */
function RowBody({ call, onViewFile }: { call: ToolCall; onViewFile?: (p: string) => void }) {
  const d = call.display;
  if (d?.kind === 'diff') {
    return (
      <div className="py-2">
        <div className="text-[11px] text-muted-foreground/60 mb-1.5 font-mono">
          {d.path} · +{d.additions} −{d.deletions}
        </div>
        <DiffView hunks={d.hunks} />
        {onViewFile && (
          <button
            role="button"
            onClick={() => onViewFile(d.path)}
            className="mt-2 text-[11px] text-muted-foreground hover:text-primary"
          >
            open file →
          </button>
        )}
      </div>
    );
  }
  if (d?.kind === 'agent') {
    return <AgentBody d={d} />;
  }
  // ask_followup_question — structured body showing the question, the
  // options (with the user's pick highlighted), and the answer line.
  if (call.toolName === 'ask_followup_question') {
    return <FollowupToolBody call={call} />;
  }
  if (d?.kind === 'text') {
    return (
      <pre className="py-2 text-[12px] text-muted-foreground whitespace-pre-wrap font-mono">
        {d.text}
      </pre>
    );
  }
  if (d?.kind === 'file_list') {
    return (
      <div className="py-2 space-y-0.5">
        {d.paths.slice(0, 50).map((p, i) => (
          <button
            role="button"
            key={i}
            onClick={() => onViewFile?.(p)}
            className="block text-[12px] font-mono text-muted-foreground hover:text-primary text-left truncate w-full"
          >
            {p}
          </button>
        ))}
        {d.paths.length > 50 && (
          <div className="text-[11px] text-muted-foreground/60 pt-1">+{d.paths.length - 50} more</div>
        )}
      </div>
    );
  }
  if (d?.kind === 'file_loaded') {
    return <FileLoadedBody d={d} />;
  }
  // Default: bash output or generic output text.
  if (call.output) {
    return (
      <pre className="py-2 text-[12px] text-muted-foreground whitespace-pre-wrap font-mono max-h-[300px] overflow-y-auto scroll">
        {call.output}
      </pre>
    );
  }
  return null;
}

/** Expandable body for dispatch_agent. Shows the task, sub-agent reasoning
 *  (collapsible), final report, and token usage. Sub-agent reasoning is
 *  hidden by default — it's verbose and the user usually wants the report.
 *  Usage renders as a compact chip line. */
function AgentBody({ d }: { d: Extract<ToolDisplay, { kind: 'agent' }> }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showReport, setShowReport] = useState(true);
  const u = d.usage;
  const totalTokens = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;

  return (
    <div className="py-2 space-y-2">
      {/* Task line — always visible. */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">task</div>
        <div className="text-[12px] text-muted-foreground whitespace-pre-wrap">{d.task}</div>
      </div>

      {/* Reasoning — collapsible, hidden by default. */}
      {d.reasoning && d.reasoning.trim() && (
        <div>
          <Button

            onClick={() => setShowReasoning(s => !s)}
            className="text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-muted inline-flex items-center gap-1"
          >
            <ChevronRight className={cn('size-2.5 transition-transform', showReasoning && 'rotate-90')} />
            reasoning · {d.reasoning.length.toLocaleString()} chars
          </Button>
          {showReasoning && (
            <pre className="mt-1 text-[11.5px] text-muted-foreground/60 whitespace-pre-wrap font-mono leading-relaxed max-h-[300px] overflow-y-auto scroll border-l border-input pl-2.5">
              {d.reasoning}
            </pre>
          )}
        </div>
      )}

      {/* Report — collapsible, shown by default. */}
      {d.report && d.report.trim() && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReport(s => !s)}
            className="text-[10px] uppercase tracking-wider inline-flex items-center gap-1"
          >
            <ChevronRight className={cn('size-2.5 transition-transform', showReport && 'rotate-90')} />
            report · {d.report.length.toLocaleString()} chars
          </Button>
          {showReport && (
            <pre className="mt-1 text-[12px] text-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto scroll">
              {d.report}
            </pre>
          )}
        </div>
      )}

      {/* Usage chip — compact, only if there were tokens. */}
      {u && totalTokens > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono text-muted-foreground/60 pt-0.5">
          <span className="inline-flex items-center gap-1 rounded border border-input px-1.5 py-0.5">
            <Coins className="size-2.5" />
            {(u.inputTokens ?? 0).toLocaleString()} in
            <span className="text-muted-foreground/60/50">·</span>
            {(u.outputTokens ?? 0).toLocaleString()} out
            {(u.cacheRead ?? 0) > 0 && (<><span className="text-muted-foreground/60/50">·</span>{(u.cacheRead ?? 0).toLocaleString()} cache</>)}
          </span>
          {(u.calls ?? 0) > 1 && (
            <span className="inline-flex items-center gap-1 rounded border border-input px-1.5 py-0.5">
              {u.calls} calls
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** file_loaded body: header (size + line count), one-line description, and full content; used by slash_command / load_skill. */
function FileLoadedBody({ d }: { d: Extract<ToolDisplay, { kind: 'file_loaded' }> }) {
  const bytes = d.bytes < 1024 ? `${d.bytes} B` : `${(d.bytes / 1024).toFixed(1)} KB`;
  return (
    <div className="py-2 space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <FileText className="size-3.5 text-primary flex-shrink-0" />
        <span className="font-mono text-foreground truncate flex-1">{d.path}</span>
        <span className="text-muted-foreground/55 font-mono flex-shrink-0">{d.lines}L · {bytes}</span>
      </div>
      {d.description && (
        <div className="text-[12px] text-muted-foreground italic truncate pl-6">{d.description}</div>
      )}
      <pre className="text-[12px] text-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto scroll border-l border-input pl-2.5">
        {d.body}
      </pre>
    </div>
  );
}

/** Extract the user's pick from the tool_result output. The orchestrator
 *  sets output to "User picked: X" or "User answered: X" on resolution,
 *  or "User did not answer the question." on rejection/abort. Returns
 *  null for outputs that don't match the expected shape. */
function extractAnswer(output?: string): string | null {
  if (!output) return null;
  const picked = output.match(/^User picked:\s*(.+)$/);
  if (picked) return picked[1].trim();
  const answered = output.match(/^User answered:\s*(.+)$/);
  if (answered) return answered[1].trim();
  return null;
}

/** Expandable body for ask_followup_question. Renders the question as a
 *  header, the options as a list with the picked one highlighted, and the
 *  user's answer as a footer. Replaces the generic text-render path so the
 *  user can see exactly what they picked from the tool row itself. */
function FollowupToolBody({ call }: { call: ToolCall }) {
  const args = call.arguments ?? {};
  const question = typeof args.question === 'string' ? args.question : '';
  const multiple = Boolean(args.multiple);
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options: { label: string; description?: string }[] = rawOptions.map((o: unknown) => {
    if (typeof o === 'string') return { label: o };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label
        : typeof obj.value === 'string' ? obj.value
        : String(o);
      const description = typeof obj.description === 'string' ? obj.description : undefined;
      return { label, description };
    }
    return { label: String(o) };
  });

  // The answer is in call.output. Split on comma for multi-pick (the
  // orchestrator joins with ", " — best-effort split, since labels may
  // theoretically contain commas).
  const answerText = extractAnswer(call.output);
  const pickedSet = new Set<string>(
    answerText ? answerText.split(',').map(s => s.trim()) : [],
  );
  const wasAnswered = answerText != null;
  const wasRejected = call.status === 'rejected' || call.status === 'aborted';

  return (
    <div className="py-2 space-y-2.5">
      {/* Question */}
      {question && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">question</div>
          <div className="text-[12.5px] text-foreground leading-snug whitespace-pre-wrap">{question}</div>
        </div>
      )}

      {/* Options — highlight the picked one(s) */}
      {options.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
            options{multiple ? ' (pick any)' : ' (pick one)'}
          </div>
          <div className="space-y-0.5">
            {options.map((opt, i) => {
              const picked = pickedSet.has(opt.label);
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2 px-2 py-1 rounded text-[12px]',
                    picked ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex-shrink-0 size-3.5 border-2 flex items-center justify-center transition-colors mt-0.5',
                      multiple ? 'rounded-[3px]' : 'rounded-full',
                      picked ? 'bg-primary border-accent text-white' : 'border-border bg-transparent',
                    )}
                  >
                    {picked && (multiple
                      ? <Check className="size-2.5" />
                      : <span className="size-1 rounded-full bg-white" />)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="leading-snug">{opt.label}</div>
                    {opt.description && (
                      <div className="text-[11px] text-muted-foreground/60 leading-snug mt-0.5">{opt.description}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Answer footer */}
      {wasAnswered && (
        <div className="flex items-center gap-2 pt-1 text-[11.5px]">
          <Check className="size-3 text-success flex-shrink-0" />
          <span className="text-muted-foreground/60">answered:</span>
          <span className="text-foreground font-medium truncate">{answerText}</span>
        </div>
      )}
      {wasRejected && (
        <div className="flex items-center gap-2 pt-1 text-[11.5px]">
          <X className="size-3 text-muted-foreground/60 flex-shrink-0" />
          <span className="text-muted-foreground/60 italic">
            {call.status === 'aborted' ? 'aborted — user stopped the turn' : 'unanswered — dismissed or timed out'}
          </span>
        </div>
      )}
      {call.status === 'awaiting_input' && (
        <div className="flex items-center gap-2 pt-1 text-[11.5px]">
          <Loader2 className="size-3 text-primary animate-spin flex-shrink-0" />
          <span className="text-primary">awaiting your choice…</span>
        </div>
      )}
    </div>
  );
}

export const OneCodeToolRow = memo(function OneCodeToolRow({
  call,
  onViewFile,
  streaming: _streaming = false,
}: {
  call: ToolCall;
  onViewFile?: (p: string) => void;
  streaming?: boolean;
}) {
  // Default to expanded for ask_followup_question once it has a result —
  // the answer is the whole point of the row and shouldn't require a click
  // to reveal. While awaiting_input the live FollowupPrompt handles the
  // interactive picker, so the inline body stays collapsed until answered.
  const [open, setOpen] = useState(() => initialOpenFor(call));
  // Allow expansion during streaming — useful for watching a dispatch_agent's
  // report stream in, or seeing bash output as it lands. The body just renders
  // whatever data is present; partial during streaming, full after completion.
  const expandable = hasBody(call);
  const target = targetOf(call);
  const ms = formatMs(call.durationMs);
  const partial = call.status === 'pending' && call._partialInput;

  // Inline permission card: if this tool is awaiting approval (its id is in the
  // TurnBlock-provided permission surface), render the card beneath the row.
  const permSurface = usePermissionSurface();
  const pendingEntry = permSurface?.byId.get(call.id);
  const approveOne = permSurface?.onApprove;
  const rejectOne = permSurface?.onReject;
  const handleApprove = approveOne
    ? (newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) =>
        approveOne(call.id, newMode, remember)
    : undefined;
  const handleReject = rejectOne ? (reason?: string) => rejectOne(call.id, reason) : undefined;

  // Per-status suffix shown in the row's right-side meta area. Gives
  // the user a one-glance read on what happened without expanding.
  const statusLabel = statusLabelOf(call);

  return (
    <div className="group relative pl-3">
      {/* Left accent line */}
      <div className={cn('absolute left-0 top-1 bottom-1 w-[2px] rounded-full', accentClass(call))} />

      {/* Status row — one line, dense */}
      <button
        role="button"
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-2 py-1 text-[12.5px] font-mono',
          expandable && 'hover:bg-secondary/40 -mx-1 px-1 rounded cursor-pointer',
        )}
      >
        <span className="inline-flex w-3 justify-center flex-shrink-0">
          <StatusGlyph call={call} />
        </span>
        {ICON[call.toolName]}
        <span className="text-muted-foreground">{toolLabel(call.toolName, call.status)}</span>
        {target && (
          <span className="text-muted-foreground/60 truncate flex-1 text-left">
            {partial && call.toolName !== 'bash' && call.toolName !== 'bash_output'
              ? <span className="opacity-60">{target}</span>
              : target}
          </span>
        )}
        {!target && <span className="flex-1" />}
        {/* Meta (orchestrator-supplied): "25 entries", "12 hits", etc. */}
        {call.meta && <span className="text-muted-foreground/60 text-[11px]">{call.meta}</span>}
        {/* Status label: "exit 0", "end_turn", "12 hits", "failed", etc. */}
        {statusLabel && (
          <span className={cn(
            'text-[11px] tabular-nums',
            call.status === 'failed' || call.status === 'rejected' || call.status === 'timeout' || call.status === 'aborted'
              ? 'text-destructive/80'
              : call.status === 'executed'
                ? 'text-success/70'
                : 'text-muted-foreground/60',
          )}>
            {statusLabel}
          </span>
        )}
        {ms && <span className="text-muted-foreground/60 text-[11px] tabular-nums">{ms}</span>}
        {expandable && (
          <ChevronRight className={cn('size-3 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        )}
      </button>

      {/* Expandable body */}
      {open && (
        <div className="pl-5 border-l border-input ml-[3px] animate-slide-up">
          <RowBody call={call} onViewFile={onViewFile} />
          <Button
            variant="outline"
            size="xs"
            onClick={() => setOpen(false)}
            className="mt-1 mb-2 text-[10px] uppercase tracking-wider gap-1"
          >
            <ChevronUp  className="size-3"/>
            collapse
          </Button>
        </div>
      )}

      {/* Inline permission card when this tool is awaiting approval. Sourced
          from PermissionSurfaceContext (provided by TurnBlock) — no prop
          drilling through BlockList → ProcessSection. */}
      {pendingEntry && (
        <div className="mt-1.5 mb-1">
          <PermissionCard
            call={pendingEntry}
            variant="split"
            timeoutAt={permSurface?.timeoutAt}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        </div>
      )}
    </div>
  );
});

/** Build a human-friendly status label for the row meta (e.g. "exit 0", "12 hits", "failed"); empty when nothing applies. */
function statusLabelOf(call: ToolCall): string {
  // Sub-agent: surface the stop reason from the display.
  if (call.toolName === 'dispatch_agent' && call.display?.kind === 'agent') {
    // The agent display doesn't carry the stop reason directly; use output
    // if it looks like a stop reason, otherwise the status.
    const out = call.output?.trim() ?? '';
    if (out === 'end_turn' || out === 'max_tokens' || out === 'tool_use') return out;
    return '';
  }
  // Bash / git: prefer exit code from meta ("exit 0", "exit 1").
  if (call.toolName === 'bash' || call.toolName === 'git' || call.toolName === 'bash_output') {
    const meta = call.meta ?? '';
    if (meta.startsWith('exit ')) return meta;
    // Output often starts with "exit N · …"; surface that.
    const m = (call.output ?? '').match(/^exit (\d+)/);
    if (m) return `exit ${m[1]}`;
    return '';
  }
  // Grep / glob: hit count.
  if (call.toolName === 'grep' || call.toolName === 'glob') {
    const m = (call.meta ?? '').match(/(\d+)\s*(hits?|files?|matches?)/i);
    if (m) return `${m[1]} ${m[2].toLowerCase()}`;
    return '';
  }
  // Failure states always surface.
  if (call.status === 'failed') return call.meta ? `failed · ${call.meta}` : 'failed';
  if (call.status === 'rejected') return 'rejected';
  if (call.status === 'timeout') return 'timeout';
  if (call.status === 'aborted') return 'aborted';
  return '';
}

/** Exploring group: collapses consecutive read-only investigation (read_file/grep/glob/list_dir) into one expandable line. */
export const OneCodeExploringGroup = memo(function OneCodeExploringGroup({
  calls,
  onViewFile,
  streaming = false,
}: {
  calls: ToolCall[];
  onViewFile?: (p: string) => void;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const okCount = calls.filter((c) => c.status === 'executed').length;
  const failCount = calls.filter((c) => c.status === 'failed').length;
  const done = okCount + failCount;
  const allDone = done === calls.length && !streaming;

  return (
    <div className="relative pl-3">
      <div className={cn('absolute left-0 top-1 bottom-1 w-[2px] rounded-full',
        allDone ? (failCount > 0 ? 'bg-warning/40' : 'bg-success/40') : 'bg-primary/50')} />

      <button
        role="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 py-1 text-[12.5px] font-mono hover:bg-secondary/40 -mx-1 px-1 rounded"
      >
        <ChevronRight className={cn('size-3 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <FileSearch className="size-3 text-muted-foreground/60" />
        <span className="text-muted-foreground">exploring</span>
        <span className="text-muted-foreground/60">
          ({done}/{calls.length})
        </span>
        {failCount > 0 && <span className="text-destructive/70 text-[11px]">{failCount} failed</span>}
        <span className="flex-1" />
        {streaming && !allDone && <Loader2 className="size-3 text-muted-foreground animate-spin" />}
      </button>

      {open && (
        <div className="ml-[3px] pl-3 border-l border-input space-y-0.5 animate-slide-up">
          {calls.map((c) => (
            <OneCodeToolRow key={c.id} call={c} onViewFile={onViewFile} streaming={streaming} />
          ))}
        </div>
      )}
    </div>
  );
});
