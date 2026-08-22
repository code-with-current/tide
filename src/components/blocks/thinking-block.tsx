/* v2 thinking rendering: same row anatomy as ToolChips. Header mode shares
 * one main "Thinking" header row; phased mode nests the phase rows inside its
 * panel, and the streaming phase stays open. Stream mode drops the wrapper
 * chrome — phase rows / flat rail render directly. */

import { memo, useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, Code2, Compass, Loader2, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { derivePhases, type Phase, type PhaseLabel } from '@/components/chat/blocks/reasoning-phases';

const PHASE_ICON: Record<PhaseLabel, typeof Brain> = {
  Planning: Compass,
  Search: Search,
  Coding: Code2,
  Verifying: ShieldCheck,
  Reasoning: Sparkles,
};

const PHASE_COLOR: Record<PhaseLabel, string> = {
  Planning: 'text-green-400',
  Search: 'text-blue-400',
  Coding: 'text-emerald-400',
  Verifying: 'text-amber-400',
  Reasoning: 'text-purple-400',
};

const SIGNATURE_RE = /思考中|Signature|redacted/i;

function formatMs(ms?: number): string {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

/** One phase row — a component so each phase owns its follow-scroll hook
 *  instance (phases append while streaming, so hooks can't live in the
 *  parent's map). */
function PhaseRow({
  phase,
  phaseOpen,
  phaseStreaming,
  streaming,
  onToggle,
}: {
  phase: Phase;
  phaseOpen: boolean;
  phaseStreaming: boolean;
  streaming: boolean;
  onToggle: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useFollowScroll(preRef, streaming && phaseStreaming);
  const Icon = PHASE_ICON[phase.label];
  return (
    <div style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <button
        type="button"
        aria-expanded={phaseOpen}
        onClick={onToggle}
        className="flex h-7 min-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-secondary/60"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <span className="flex size-4 items-center justify-center transition-opacity duration-100 group-hover/phase:opacity-0">
            <Icon className={cn('tool-tint size-3', PHASE_COLOR[phase.label], phaseStreaming && 'animate-pulse')} />
          </span>
          <ChevronDown
            className="absolute size-3 opacity-0 text-muted-foreground transition-[opacity,transform] duration-150 group-hover/phase:opacity-100"
            style={{ transform: phaseOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </span>
        <span className={cn('tool-tint shrink-0 text-[12px] font-medium', PHASE_COLOR[phase.label])}>
          {phase.label}
        </span>
        <span className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 text-[11px] text-muted-foreground">
          {phaseStreaming ? '…' : phase.text.trim().split('\n')[0]?.slice(0, 80)}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/60">
          ~{phase.estTokens.toLocaleString()} tok
        </span>
        {phaseStreaming ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: phaseOpen ? '1fr' : '0fr', opacity: phaseOpen ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-[5px] ml-[13px] border-l border-border py-0.5 pl-3">
            <pre ref={preRef} className="scroll max-h-[352px] overflow-y-auto whitespace-pre-wrap py-1 pl-1 pr-2 font-mono text-[11px] leading-[1.6] text-muted-foreground">
              {phase.text}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThinkingBlockImpl({
  text,
  tokens,
  ms,
  streaming = false,
  variant = 'header',
}: {
  text: string;
  tokens?: number;
  ms?: number;
  streaming?: boolean;
  variant?: 'header' | 'stream';
}) {
  const reasoningView = useUi((s) => s.reasoningView);
  const [open, setOpen] = useState(streaming);
  const [openPhases, setOpenPhases] = useState<Set<string>>(() => new Set());
  const flatRef = useRef<HTMLDivElement>(null);
  useFollowScroll(flatRef, streaming);

  const phases = reasoningView === 'phased' ? derivePhases(text) : null;
  const activePhaseId = streaming && phases && phases.length > 0 ? phases[phases.length - 1].id : null;

  const isPhaseOpen = (p: Phase) =>
    streaming ? p.id === activePhaseId : openPhases.has(p.id);

  // Collapse when the turn ends, mirroring the tool-run collapse.
  useEffect(() => {
    if (!streaming) {
      setOpen(false);
      setOpenPhases(new Set());
    }
  }, [streaming]);

  const lines = text
    .split('\n')
    .filter((l) => l.trim().length > 0 && !SIGNATURE_RE.test(l.trim()));
  const snippet = lines[0]?.trim().replace(/^[#>\-*\s]+/, '').slice(0, 80);
  const meta = [formatMs(ms), tokens != null ? `${tokens} tok` : null]
    .filter(Boolean)
    .join(' · ');

  const headerSnippet = streaming && phases && phases.length > 0
    ? `${phases[phases.length - 1].label}…`
    : snippet;

  const content = phases ? (
    <div className="mt-[5px] flex flex-col gap-[5px]">
      {phases.map((p) => (
        <PhaseRow
          key={p.id}
          phase={p}
          phaseOpen={isPhaseOpen(p)}
          phaseStreaming={streaming && p.id === activePhaseId}
          streaming={streaming}
          onToggle={() =>
            setOpenPhases((prev) => {
              const next = new Set(prev);
              if (next.has(p.id)) next.delete(p.id);
              else next.add(p.id);
              return next;
            })
          }
        />
      ))}
    </div>
  ) : (
    <div className="mt-[5px] ml-[13px] border-l border-border py-0.5 pl-3">
      <div ref={flatRef} className="scroll max-h-[368px] overflow-y-auto text-[11.5px] leading-[1.6] text-muted-foreground [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px]">
        {lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );

  if (variant === 'stream') {
    return <div className="mt-[5px] w-full">{content}</div>;
  }

  return (
    <div className="mt-[5px] w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-secondary/60"
      >
        <span className="tool-tint relative flex size-4 shrink-0 items-center justify-center text-purple-400">
          <span className="flex size-4 items-center justify-center transition-opacity duration-100 group-hover/row:opacity-0">
            <Brain className={cn('size-3.5', streaming && 'animate-pulse')} />
          </span>
          <ChevronDown
            className="absolute size-3 opacity-0 text-muted-foreground transition-[opacity,transform] duration-150 group-hover/row:opacity-100"
            style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-foreground/80">
          Thinking
        </span>
        {headerSnippet || streaming ? (
          <span className="inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-secondary/70 px-1.5 text-[11.5px] text-muted-foreground">
            {headerSnippet ?? '…'}
          </span>
        ) : null}
        {meta && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {meta}
          </span>
        )}
        {streaming ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }}
      >
        <div className="min-h-0 overflow-hidden">{content}</div>
      </div>
    </div>
  );
}

export const ThinkingBlock = memo(ThinkingBlockImpl);
