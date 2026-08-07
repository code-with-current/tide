import {
  FileSearch,
  FilePen,
  Terminal,
  Folder,
  FolderTree,
  GitBranch,
  Plug,
  Bot,
  Brain,
  ListChecks,
  Globe,
  Search,
  BookOpen,
  HelpCircle,
  ClipboardCheck,
  Minimize2,
  Square,
  Check,
  X,
  AlertTriangle,
  Loader2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import type { ToolCall as ToolCallT, ToolName } from '@/types';
import { cn, formatNumber } from '@/lib/utils';
import { toolLabel } from '@/lib/tool-labels';
import { Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { DiffView } from './DiffView';

const toolIcon: Record<ToolName, React.ReactNode> = {
  read_file: <FileSearch className="size-3.5 text-info" />,
  edit_file: <FilePen className="size-3.5 text-primary" />,
  multi_edit: <FilePen className="size-3.5 text-primary" />,
  write_file: <FilePen className="size-3.5 text-primary" />,
  list_dir: <Folder className="size-3.5 text-info" />,
  directory_tree: <FolderTree className="size-3.5 text-info" />,
  glob: <FileSearch className="size-3.5 text-info" />,
  bash: <Terminal className="size-3.5 text-warning" />,
  bash_output: <Terminal className="size-3.5 text-warning" />,
  kill_shell: <Square className="size-3.5 text-destructive" />,
  grep: <FileSearch className="size-3.5 text-info" />,
  git: <GitBranch className="size-3.5 text-primary" />,
  dispatch_agent: <Bot className="size-3.5 text-reasoning" />,
  load_skill: <BookOpen className="size-3.5 text-info" />,
  memory: <Brain className="size-3.5 text-muted-foreground/60" />,
  init: <Brain className="size-3.5 text-muted-foreground/60" />,
  todo_write: <ListChecks className="size-3.5 text-info" />,
  web_fetch: <Globe className="size-3.5 text-info" />,
  web_search: <Search className="size-3.5 text-info" />,
  notebook_edit: <BookOpen className="size-3.5 text-info" />,
  ask_followup_question: <HelpCircle className="size-3.5 text-warning" />,
  exit_plan_mode: <ClipboardCheck className="size-3.5 text-success" />,
  compact: <Minimize2 className="size-3.5 text-muted-foreground/60" />,
  slash_command: <span className="text-primary" >/</span>,
  mcp: <Plug className="size-3.5 text-info" />,
};

/** Resolve the icon for a tool name: built-in Tide tools look up `toolIcon`; MCP namespaced tools (`mcp__<server>__<tool>`) fall back to the generic `Plug` icon, keeping the visual language consistent. Typed against `string` (not `ToolName`) because MCP names aren't part of the `ToolName` union — they arrive at runtime from the agent stream. */
function getToolIcon(toolName: string): React.ReactNode {
  if (toolName in toolIcon) {
    return toolIcon[toolName as ToolName];
  }
  // Any unknown tool name — MCP namespaced or otherwise — gets the Plug icon.
  return <Plug className="size-3.5 text-info" />;
}

function StatusBadge({ call }: { call: ToolCallT }) {
  switch (call.status) {
    case 'executed':
      return (
        <Chip tone="ok">
          <Check className="size-2.5" /> executed
        </Chip>
      );
    case 'failed':
      return (
        <Chip tone="bad">
          <X className="size-2.5" /> failed
        </Chip>
      );
    case 'pending':
    case 'running':
      return (
        <Chip tone="warn">
          <Loader2 className="size-2.5 animate-spin" /> running
        </Chip>
      );
    case 'rejected':
      return (
        <Chip tone="bad">
          <X className="size-2.5" /> rejected
        </Chip>
      );
    default:
      return null;
  }
}

export function ToolCallCard({
  call,
  onViewFile,
}: {
  call: ToolCallT;
  onViewFile?: (path: string) => void;
}) {
  return <ToolCallCardBase calls={[call]} onViewFile={onViewFile} />;
}

/** Renders one or more tool calls; multiple `calls` collapse into one card (used for grouped dispatch_agent calls — see ChatMessage's groupDispatchAgents). */
export function ToolCallCardGroup({
  calls,
  onViewFile,
}: {
  calls: ToolCallT[];
  onViewFile?: (path: string) => void;
}) {
  return <ToolCallCardBase calls={calls} onViewFile={onViewFile} />;
}

function ToolCallCardBase({
  calls,
  onViewFile,
}: {
  calls: ToolCallT[];
  onViewFile?: (path: string) => void;
}) {
  const call = calls[0];
  const isPermission = call.status === 'pending' && call.riskTier !== 'read_only';
  const warnBorder = isPermission;

  return (
    <div
      className={cn(
        'bg-card border rounded-lg overflow-hidden text-[13px]',
        warnBorder ? 'border-warning/35' : 'border-border',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 border-b border-input',
          isPermission ? 'bg-warning/[0.06]' : 'bg-secondary',
        )}
      >
        {isPermission ? (
          <AlertTriangle className="size-3.5 text-warning" />
        ) : (
          // <Dot tone={call.status === 'executed' ? 'ok' : call.status === 'failed' ? 'bad' : 'warn'} />
          <div/>
        )}
        {getToolIcon(call.toolName)}
        <span className="font-medium text-xs">{toolLabel(call.toolName, call.status)}</span>
        {/* Per-tool streaming strategy for the args preview while the model is still typing them out (pending + _partialInput): bash hides partials (a half-typed shell command is confusing and may contain sensitive fragments); edit/write/grep/dispatch_agent show the forming path/command/task with a shimmer so the user sees the tool call taking shape. */}
        {call.status === 'pending' && call._partialInput && call.toolName !== 'bash' && call.toolName !== 'bash_output' && call.toolName !== 'kill_shell' ? (
          <code className="font-mono text-[11px] px-1.5 py-0.5 bg-background rounded text-foreground/70 max-w-[400px] truncate">
            <TextShimmer>{tryExtractPreview(call.toolName, call._partialInput)}</TextShimmer>
          </code>
        ) : call.status === 'pending' && call._partialInput ? (
          // bash and shell tools — show a generic "typing…" shimmer without
          // echoing the partial command.
          <code className="font-mono text-[11px] px-1.5 py-0.5 bg-background rounded text-foreground/50">
            <TextShimmer>preparing…</TextShimmer>
          </code>
        ) : (
          <code className="font-mono text-[11px] px-1.5 py-0.5 bg-background rounded text-foreground/50">
            {call.argPreview}
          </code>
        )}
        {call.meta && <span className="text-muted-foreground/60 text-[11px] ml-1">{call.meta}</span>}
        <div className="flex-1" />
        <StatusBadge call={call} />
        {call.durationMs != null && (
          <span className="text-muted-foreground/60 text-[11px] font-mono">{call.durationMs}ms</span>
        )}
      </div>

      {call.display?.kind === 'diff' && (
        <>
          <CollapsibleBody
            label={`${call.display.path} · +${call.display.additions} −${call.display.deletions}`}
            defaultOpen={false}
          >
            <DiffView hunks={call.display.hunks} />
          </CollapsibleBody>
          <div className="px-3 py-2 flex items-center gap-3 text-[11px] text-muted-foreground/60 border-t border-input">
            <span>
              +{call.display.additions} −{call.display.deletions}
            </span>
            <span>·</span>
            <span>1 of 1 occurrence</span>
            <div className="flex-1" />
            <Button variant="ghost" size="xs" onClick={() => onViewFile?.(call.display!.kind === 'diff' ? call.display!.path : '')}>View file</Button>
            <Button variant="destructive" size="xs">Revert</Button>
          </div>
        </>
      )}

      {call.display?.kind === 'command' && (
        <CollapsibleBody
          label={`$ ${call.display.command}`.slice(0, 80) + (call.display.command.length > 80 ? '…' : '')}
          defaultOpen={false}
        >
          <div className="font-mono text-xs px-3 py-2 rounded-md bg-background border border-input text-foreground break-all whitespace-pre-wrap">
            <span className="text-muted-foreground/60">$</span> {call.display.command}
          </div>
        </CollapsibleBody>
      )}

      {call.display?.kind === 'file_list' && (
        <CollapsibleBody
          label={`${call.display.paths.length} ${call.display.paths.length === 1 ? 'entry' : 'entries'}`}
          defaultOpen={false}
        >
          {call.display.paths.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/60 px-2 py-1">(no entries)</div>
          ) : (
            <div className="max-h-48 overflow-y-auto scroll font-mono text-[11px] text-muted-foreground bg-background border border-input rounded-md px-2 py-1.5">
              {call.display.paths.map((p, i) => (
                <div key={i} className="truncate hover:text-foreground">
                  {p}
                </div>
              ))}
            </div>
          )}
        </CollapsibleBody>
      )}

      {call.display?.kind === 'text' && call.display.text && (
        <CollapsibleBody
          label={textPreviewLabel(call.display.text)}
          defaultOpen={false}
        >
          <pre className="max-h-80 overflow-auto scroll font-mono text-[11px] text-muted-foreground bg-background border border-input rounded-md px-3 py-2 whitespace-pre-wrap break-words">
            {call.display.text}
          </pre>
        </CollapsibleBody>
      )}

      {call.display?.kind === 'file_loaded' && (() => {
        const d = call.display;
        const bytes = d.bytes < 1024 ? `${d.bytes} B` : `${(d.bytes / 1024).toFixed(1)} KB`;
        return (
          <CollapsibleBody
            label={`${d.path} · ${d.lines}L · ${bytes}`}
            defaultOpen={false}
          >
            {d.description && (
              <div className="text-[11px] text-muted-foreground italic mb-1.5">{d.description}</div>
            )}
            <pre className="max-h-80 overflow-auto scroll font-mono text-[11px] text-foreground bg-background border border-input rounded-md px-3 py-2 whitespace-pre-wrap break-words">
              {d.body}
            </pre>
          </CollapsibleBody>
        );
      })()}

      {/* Agent dispatches — when multiple calls to the same agent are grouped,
          render them as one card with the latest report open and prior
          dispatches as collapsed history rows. */}
      {call.display?.kind === 'agent' && (
        <AgentDisplay
          agentName={call.display.agentName}
          dispatches={calls
            .filter((c) => c.display?.kind === 'agent')
            .map((c) => {
              const d = c.display as Extract<ToolCallT['display'], { kind: 'agent' }>;
              return {
                task: d.task,
                report: d.report,
                reasoning: d.reasoning,
                usage: d.usage,
                durationMs: c.durationMs,
                status: c.status,
              };
            })}
        />
      )}
    </div>
  );
}

/** Collapsed chip for a run of ≥3 consecutive exploring tools (read_file, grep, glob, list_dir). Shows a one-line summary like "Exploring · 5 files · 2 searches" with a chevron to expand. Auto-expanded while streaming (so the user sees what's happening live), auto-collapses when streaming ends. Mirrors 1code's EXPLORING_TOOLS grouping. */
export function ExploringGroup({
  calls,
  onViewFile,
  streaming = false,
}: {
  calls: ToolCallT[];
  onViewFile?: (path: string) => void;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(streaming);

  // Auto-expand while streaming, auto-collapse when done.
  useEffect(() => {
    if (streaming) setOpen(true);
    else setOpen(false);
  }, [streaming]);

  // Build the summary: count by tool type.
  const counts = new Map<string, number>();
  for (const c of calls) {
    counts.set(c.toolName, (counts.get(c.toolName) ?? 0) + 1);
  }
  const parts: string[] = [];
  const readFileCount = (counts.get('read_file') ?? 0) + (counts.get('list_dir') ?? 0);
  const searchCount = (counts.get('grep') ?? 0) + (counts.get('glob') ?? 0);
  if (readFileCount > 0) parts.push(`${readFileCount} ${readFileCount === 1 ? 'file' : 'files'}`);
  if (searchCount > 0) parts.push(`${searchCount} ${searchCount === 1 ? 'search' : 'searches'}`);
  const summary = parts.join(' · ') || `${calls.length} calls`;

  const verb = streaming ? 'Exploring' : 'Explored';
  const anyRunning = calls.some((c) => c.status === 'running' || c.status === 'pending');

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden text-[13px]">
      <Button variant="ghost" onClick={() => setOpen((o) => !o)} className="w-full h-auto justify-start rounded-none px-3 py-2 bg-secondary border-b border-input hover:bg-accent"
      >
        {anyRunning ? (
          <Loader2 className="size-3.5 text-info animate-spin" />
        ) : (
          <FileSearch className="size-3.5 text-info" />
        )}
        <span className="text-xs font-medium">{verb}</span>
        <span className="text-muted-foreground/60 text-[11px]">· {summary}</span>
        <div className="flex-1" />
        <ChevronDown className={cn('size-3.5 text-muted-foreground/60 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="max-h-[240px] overflow-y-auto scroll py-1">
          {calls.map((c) => (
            <ExploringRow key={c.id} call={c} onViewFile={onViewFile} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact one-line row for a tool inside an ExploringGroup: just icon, tool name, arg preview, and a status dot — no collapsible body, diff view, or output. Click to open the file (for read_file/glob/grep). */
function ExploringRow({
  call,
  onViewFile,
}: {
  call: ToolCallT;
  onViewFile?: (path: string) => void;
}) {
  const isRunning = call.status === 'running' || call.status === 'pending';
  const isFailed = call.status === 'failed' || call.status === 'rejected';
  // For read_file/list_dir/glob/grep, try to extract a clickable path.
  const pathArg = call.arguments?.path ?? call.arguments?.pattern ?? '';
  const pathStr = typeof pathArg === 'string' ? pathArg : '';
  const clickable = !!onViewFile && !!pathStr && (call.toolName === 'read_file' || call.toolName === 'glob' || call.toolName === 'grep');

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1 text-[11px] hover:bg-secondary transition-colors cursor-default',
        clickable && 'cursor-pointer',
      )}
      onClick={() => clickable && onViewFile?.(pathStr)}
    >
      {/* Status dot — tiny, just enough signal. */}
      <span className={cn(
        'size-1.5 rounded-full flex-shrink-0',
        isRunning ? 'bg-info animate-pulse' : isFailed ? 'bg-destructive' : 'bg-success/60',
      )} />
      {/* Tool icon (mini). */}
      <span className="text-muted-foreground/60 flex-shrink-0">{getToolIcon(call.toolName)}</span>
      <span className="text-muted-foreground/80 text-[11px] flex-shrink-0">{toolLabel(call.toolName)}</span>
      {/* Arg preview — the path/pattern/command. */}
      <code className="font-mono text-muted-foreground/60 truncate flex-1">{call.argPreview || pathStr}</code>
      {/* Meta — duration or line count. */}
      {call.meta && <span className="text-muted-foreground/60/60 text-[10px] flex-shrink-0">{call.meta}</span>}
    </div>
  );
}

/** Renders a sub-agent's process across one or more dispatches. Multiple dispatches to the same agent collapse into a single card: the latest dispatch's task + reasoning + report renders open at the top, prior dispatches appear as collapsed history rows below ("Dispatch #1", etc.) so the user can audit the evolution without losing focus on the newest answer. */
function AgentDisplay({
  agentName,
  dispatches,
}: {
  agentName: string;
  dispatches: {
    task: string;
    report: string;
    reasoning?: string;
    usage?: import('@/types').Usage;
    durationMs?: number;
    status: ToolCallT['status'];
  }[];
}) {
  // Newest first — the latest report is what the user cares about.
  const ordered = [...dispatches].reverse();
  const total = dispatches.length;
  const latest = ordered[0];

  // Aggregate usage across all dispatches for the footer.
  const totals = dispatches.reduce((acc, d) => {
    if (!d.usage) return acc;
    acc.in += d.usage.inputTokens;
    acc.out += d.usage.outputTokens;
    acc.cache += d.usage.cacheRead;
    acc.reasoning += d.usage.reasoningTokens;
    return acc;
  }, { in: 0, out: 0, cache: 0, reasoning: 0 });

  return (
    <div className="border-t border-input">
      {/* Latest dispatch — task + reasoning + report, all visible. */}
      <DispatchView
        dispatch={latest}
        index={total}
        agentName={agentName}
        defaultOpen={false}
      />

      {/* Prior dispatches — collapsed history rows. Each expandable to show
          its own task/reasoning/report so the user can audit the evolution. */}
      {ordered.length > 1 && (
        <div className="border-t border-input">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60/70 font-semibold bg-secondary/30">
            Prior dispatches ({ordered.length - 1})
          </div>
          {ordered.slice(1).map((d, i) => (
            <DispatchView
              key={total - 1 - i}
              dispatch={d}
              index={total - 1 - i}
              agentName={agentName}
              defaultOpen={false}
            />
          ))}
        </div>
      )}

      {/* Aggregate usage footer — totals across all dispatches. */}
      {(totals.in + totals.out + totals.cache + totals.reasoning) > 0 && (
        <div className="px-3 py-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/60 font-mono border-t border-input flex-wrap">
          {total > 1 && <span className="text-muted-foreground/60/70">{total} dispatches ·</span>}
          <span>{formatNumber(totals.in)} in</span>
          <span>·</span>
          <span>{formatNumber(totals.out)} out</span>
          {totals.cache > 0 && (
            <>
              <span>·</span>
              <span>{formatNumber(totals.cache)} cache</span>
            </>
          )}
          {totals.reasoning > 0 && (
            <>
              <span>·</span>
              <span className="text-reasoning">{formatNumber(totals.reasoning)} reasoning</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A single dispatch's task + reasoning + report. */
function DispatchView({
  dispatch,
  index,
  agentName,
  defaultOpen,
}: {
  dispatch: {
    task: string;
    report: string;
    reasoning?: string;
    usage?: import('@/types').Usage;
    durationMs?: number;
    status: ToolCallT['status'];
  };
  index: number;
  agentName: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showReasoning, setShowReasoning] = useState(false);
  const { task, report, reasoning, durationMs } = dispatch;
  const reportLineCount = report.split('\n').length;

  // For prior dispatches, the whole view collapses to a single header row
  // that expands to show task/reasoning/report. For the latest, it's open
  // by default — no outer collapse needed.
  if (!defaultOpen) {
    return (
      <div className="border-b border-input/50">
        <Button variant="ghost" size="xs" onClick={() => setOpen((o) => !o)} className="w-full justify-start h-auto px-3 py-1.5 hover:bg-secondary/40"
        >
          <ChevronRight className={cn('size-3 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
          <span className="text-[11px] font-medium text-muted-foreground">
            Dispatch #{index}
          </span>
          <span className="text-[11px] text-muted-foreground/60 truncate flex-1">
            {task.slice(0, 80)}{task.length > 80 ? '…' : ''}
          </span>
          {durationMs != null && (
            <span className="text-[10px] text-muted-foreground/60 font-mono">{durationMs}ms</span>
          )}
        </Button>
        {open && (
          <div className="animate-slide-up">
            <DispatchBody
              task={task}
              report={report}
              reasoning={reasoning}
              agentName={agentName}
              reportLineCount={reportLineCount}
              showReasoning={showReasoning}
              setShowReasoning={setShowReasoning}
            />
          </div>
        )}
      </div>
    );
  }

  // Latest dispatch — body always visible.
  return (
    <DispatchBody
      task={task}
      report={report}
      reasoning={reasoning}
      agentName={agentName}
      reportLineCount={reportLineCount}
      showReasoning={showReasoning}
      setShowReasoning={setShowReasoning}
    />
  );
}

/** Shared body content for both latest and prior dispatches. */
function DispatchBody({
  task,
  report,
  reasoning,
  agentName,
  reportLineCount,
  showReasoning,
  setShowReasoning,
}: {
  task: string;
  report: string;
  reasoning?: string;
  agentName: string;
  reportLineCount: number;
  showReasoning: boolean;
  setShowReasoning: (fn: (s: boolean) => boolean) => void;
}) {
  const [showTask, setShowTask] = useState(false);
  return (
    <>
      {/* Task brief — collapsible, default collapsed. The task text is often
          long and not what the user cares about; the report is the focus. */}
      <div className="border-b border-input">
        <Button variant="ghost" size="xs" onClick={() => setShowTask((s) => !s)} className="w-full justify-start h-auto px-3 py-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
        >
          <ChevronRight className={cn('size-3 transition-transform', showTask && 'rotate-90')} />
          <Bot className="size-2.5" />
          <span className="font-medium">{agentName}</span>
          <span className="text-muted-foreground/60/60">· task</span>
          {!showTask && (
            <span className="text-muted-foreground/60/50 truncate ml-1">{task.slice(0, 60)}{task.length > 60 ? '…' : ''}</span>
          )}
        </Button>
        {showTask && (
          <div className="px-3 py-2 bg-secondary/40 animate-slide-up">
            <div className="text-[12px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{task}</div>
          </div>
        )}
      </div>

      {/* Optional reasoning trace — collapsed by default. */}
      {reasoning && (
        <div className="border-b border-input">
          <Button variant="ghost" size="xs" onClick={() => setShowReasoning((s) => !s)} className="w-full justify-start h-auto px-3 py-1.5 text-[11px] text-reasoning"
          >
            <ChevronRight className={cn('size-3 transition-transform', showReasoning && 'rotate-90')} />
            <Brain className="size-3" />
            Reasoning
          </Button>
          {showReasoning && (
            <pre className="max-h-64 overflow-auto scroll font-mono text-[11px] text-muted-foreground/80 bg-background px-3 py-2 whitespace-pre-wrap animate-slide-up">
              {reasoning}
            </pre>
          )}
        </div>
      )}

      {/* The agent's report — the focal point. */}
      <CollapsibleBody
        label={`report · ${reportLineCount} ${reportLineCount === 1 ? 'line' : 'lines'}`}
        defaultOpen={false}
      >
        <div className="prose-chat max-h-96 overflow-y-auto scroll px-1 py-1 text-[12.5px]">
          <MarkdownLite text={report} />
        </div>
      </CollapsibleBody>
    </>
  );
}

/** Minimal markdown renderer for agent reports — keeps the card self-contained
 *  without pulling in the full ReactMarkdown pipeline. Handles the common
 *  cases: headers, bold, inline code, fenced code blocks, bullet lists. */
function MarkdownLite({ text }: { text: string }) {
  // Split on fenced code blocks first so their contents aren't mangled.
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const body = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
          return (
            <pre key={i} className="font-mono text-[11px] text-muted-foreground bg-background border border-input rounded-md px-3 py-2 whitespace-pre-wrap break-words">
              {body}
            </pre>
          );
        }
        // Inline formatting: bold, inline code, headers, bullets.
        const lines = part.split('\n');
        return (
          <div key={i} className="space-y-1">
            {lines.map((line, j) => {
              if (!line.trim()) return null;
              const isHeader = /^(#{1,4})\s/.test(line);
              const isBullet = /^\s*[-*]\s+/.test(line);
              const content = line
                .replace(/^#{1,4}\s+/, '')
                .replace(/^\s*[-*]\s+/, '• ');
              // Bold + inline code.
              const html = content
                .replace(/`([^`]+)`/g, '<code class="font-mono text-[11px] px-1 py-0.5 bg-primary rounded text-muted-foreground">$1</code>')
                .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-foreground font-semibold">$1</strong>');
              return (
                <div
                  key={j}
                  className={cn(
                    'leading-relaxed',
                    isHeader && 'font-semibold text-foreground text-[13px] mt-1',
                    isBullet && 'pl-2',
                  )}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Collapsible wrapper for tool result bodies (file contents, directory listings). Click the header row to toggle. Default state is open for short results, closed for long ones — see `defaultOpenFor`. When expanded, a "Collapse" button renders at the bottom of the body so the user doesn't have to scroll back up to close it after reading a long result. */
function CollapsibleBody({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="p-2">
      <span role="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-start text-[11px] text-muted-foreground/60 hover:text-muted-foreground/80 h-auto px-1 py-0.5"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="font-mono">{label}</span>
      </span>
      {open && (
        <div className="mt-1.5">
          {children}
          {/* Bottom collapse button — saves the user a scroll back up to the
              header after reading a long result. Mirrors the header's tone. */}
          <Button
            variant="outline" size="xs"
            onClick={() => setOpen(false)}
            className="mt-2 w-full text-[10px] uppercase tracking-wider h-auto py-1"
          >
            <ChevronUp className="size-3" />
            Collapse
          </Button>
        </div>
      )}
    </div>
  );
}

/** Build a label like "120 lines" or "12 lines · first: const foo = ..." for text bodies. */
function textPreviewLabel(text: string): string {
  const lines = text.split('\n');
  const lineCount = lines.length;
  const first = lines[0]?.trim().slice(0, 60) ?? '';
  return first ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} · ${first}${lines[0].length > 60 ? '…' : ''}` : `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;
}

/** Best-effort extract of a human-readable preview from a partial tool-input JSON string. The model streams args as JSON fragments (e.g. `{"path":"src/foo.ts","old`), so try to pull out the most useful field (path / command / pattern) for the live preview. Falls back to the raw fragment if nothing recognizable parses. */
function tryExtractPreview(_toolName: string, partialJson: string): string {
  // Try to extract known fields by pattern. Cheaper than a full JSON parse
  // (which would fail on incomplete input anyway).
  const pathMatch = partialJson.match(/"path"\s*:\s*"([^"]*)/);
  if (pathMatch) return pathMatch[1];
  const cmdMatch = partialJson.match(/"command"\s*:\s*"([^"]*)/);
  if (cmdMatch) return cmdMatch[1];
  const patternMatch = partialJson.match(/"pattern"\s*:\s*"([^"]*)/);
  if (patternMatch) return patternMatch[1];
  const queryMatch = partialJson.match(/"query"\s*:\s*"([^"]*)/);
  if (queryMatch) return queryMatch[1];
  const taskMatch = partialJson.match(/"task"\s*:\s*"([^"]*)/);
  if (taskMatch) return taskMatch[1].slice(0, 60);
  // Fallback: show the raw fragment, truncated.
  return partialJson.slice(-60);
}

/** A subtle shimmer animation for streaming text (in-progress tool args). */
function TextShimmer({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block bg-gradient-to-r from-muted via-ink to-muted bg-[length:200%_100%] bg-clip-text text-transparent animate-[shimmer_1.5s_linear_infinite]">
      {children}
    </span>
  );
}
