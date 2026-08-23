import { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  ChevronRight,
  ChevronUp,
  Code2,
  Compass,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { derivePhases, type Phase, type PhaseLabel } from './reasoning-phases';

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

export function ReasoningView({
  text,
  tokens,
  ms,
  streaming,
}: {
  text: string;
  tokens?: number;
  ms?: number;
  streaming: boolean;
}) {
  const reasoningView = useUi((s) => s.reasoningView);
  if (reasoningView === 'phased') {
    return <PhasedReasoning text={text} tokens={tokens} ms={ms} streaming={streaming} />;
  }
  return <FlatReasoning text={text} tokens={tokens} ms={ms} streaming={streaming} />;
}

/** The original single-block view, unchanged. */
function FlatReasoning({ text, tokens, ms, streaming }: { text: string; tokens?: number; ms?: number; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  return (
    <div className="py-0.5">
      <span
        role="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          ' flex justify-start font-mono text-[0.8rem] h-auto py-1 px-1.5 -ml-1.5 items-center gap-1 text-reasoning',
        )}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Brain className="size-[0.8rem]" />
        <span>Thinking</span>
        {ms != null && <span className="text-muted-foreground/60">· {(ms / 1000).toFixed(1)}s</span>}
        {tokens != null && <span className="text-muted-foreground/60">· {tokens.toLocaleString()} tok</span>}
      </span>
      {open && (
        <div className="mt-1.5 ml-5 border-l border-input animate-slide-up">
          <pre className="text-[0.85rem] p-3 text-card-foreground/80 bg-card whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto scroll">
            {text}
          </pre>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setOpen(false)}
            className="w-full rounded-none uppercase tracking-wider gap-2"
          >
            <ChevronUp className='size-3'/>
            Collapse
            <ChevronUp className='size-3'/>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Phase-grouped view: outer card with summary chips, each phase independently collapsible. */
function PhasedReasoning({ text, tokens, ms, streaming }: { text: string; tokens?: number; ms?: number; streaming: boolean }) {
  const phases = useMemo(() => derivePhases(text), [text]);
  // const chips = useMemo(() => phaseChips(phases), [phases]);

  const [outerOpen, setOuterOpen] = useState(streaming);
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set());

  // Mirror the flat view's stream behaviour: expand the outer card while
  // streaming, collapse once it ends. The in-progress (last) phase is pinned
  // open during streaming so live deltas stay visible.
  useEffect(() => {
    if (!streaming) {
      setOuterOpen(false);
      setOpenSet(new Set());
    }
  }, [streaming]);

  // Nothing to phase (no reasoning text yet) → render nothing.
  if (phases.length === 0) return null;

  const lastId = phases[phases.length - 1].id;
  const isPhaseOpen = (p: Phase) => openSet.has(p.id) || (streaming && p.id === lastId && outerOpen);
  const togglePhase = (id: string) =>
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="py-0.5">
      <span
        role="button"
        onClick={() => setOuterOpen((o) => !o)}
        className="flex justify-start font-mono text-[0.8rem] h-auto py-1 px-1.5 -ml-1.5 items-center gap-1.5 text-reasoning flex-wrap"
      >
        <ChevronRight className={cn('size-3 transition-transform', outerOpen && 'rotate-90')} />
        <Brain className="size-[0.8rem]" />
        <span>Thinking</span>
        {/* Too much information */}
        {/* {chips.length > 0 && (
          <span className="flex items-center gap-1.5 ml-0.5">
            {chips.map((c) => (
              <span key={c} className={cn('tool-tint flex items-center gap-0.5', PHASE_COLOR[c])}>
                <span className="size-1 rounded-full bg-current" />
                {c}
              </span>
            ))}
          </span>
        )}*/}
        {ms != null && <span className="text-muted-foreground/60">· {(ms / 1000).toFixed(1)}s</span>}
        {tokens != null && <span className="text-muted-foreground/60">· {tokens.toLocaleString()} tok</span>}
      </span>

      {outerOpen && (
        <div className="mt-1.5 ml-5 space-y-0.5 pt-3 border-input animate-slide-up text-card-foreground/80 bg-card rounded-lg">
          {phases.map((p, i) => {
            const Icon = PHASE_ICON[p.label];
            const open = isPhaseOpen(p);
            return (
              <div key={p.id} className={cn(i > 0 && 'mt-1')}>
                <span
                  role="button"
                  onClick={() => togglePhase(p.id)}
                  className="flex items-center gap-1 font-mono text-[0.78rem] h-auto py-1 px-2 -ml-px"
                >
                  <ChevronRight className={cn('size-2.5 transition-transform', open && 'rotate-90')} />
                  <Icon className={cn('tool-tint size-3', PHASE_COLOR[p.label])} />
                  <span className={cn('tool-tint', PHASE_COLOR[p.label])}>{p.label}</span>
                  <span className="text-muted-foreground/50">· ~{p.estTokens.toLocaleString()} tok</span>
                </span>
                {open && (
                  <pre className="text-[0.82rem] px-3 pb-2 pl-7 text-card-foreground/80 whitespace-pre-wrap font-mono leading-relaxed max-h-[300px] overflow-y-auto scroll py-0.5 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[0.7857rem] [&_table]:text-[0.7857rem] [&_th]:text-[0.7143rem] [&_td]:text-[0.7857rem]">
                    {p.text}
                  </pre>
                )}
              </div>
            );
          })}
          <Button
            variant="outline"
            size="xs"
            onClick={() => setOuterOpen(false)}
            className="w-full rounded-t-none rounded-b-lg uppercase tracking-wider mt-3 gap-2"
          >
            <ChevronUp className="size-3" />
            Collapse
            <ChevronUp className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
