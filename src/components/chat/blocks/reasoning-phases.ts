/**
 * Phase derivation for the "phased" reasoning view.
 *
 * Today the reasoning block is a single concatenated blob — the orchestrator
 * collapses every thinking segment across a turn into one string (see
 * electron/agent/orchestrator.ts reasoning-delta handler). That means there
 * are no real phase boundaries to read; we classify paragraphs by keyword.
 *
 * This is intentionally a pure, isolated seam: when the orchestrator is
 * taught to emit one reasoning block per thinking segment (so phases map to
 * real think→act boundaries with true per-phase tokens/timing), only this
 * module needs to change — the component consumes {@link Phase} unchanged.
 */

export type PhaseLabel = 'Planning' | 'Search' | 'Coding' | 'Verifying' | 'Reasoning';

export interface Phase {
  id: string;
  label: PhaseLabel;
  text: string;
  /** Proportional token estimate (~4 chars/token). Real per-phase token counts
   *  don't exist yet; this is an honest placeholder. */
  estTokens: number;
}

/** Ordered keyword → label rules. First match wins. The verbs mirror the tool
 *  names and the model's natural phrasing between actions. */
const RULES: { label: PhaseLabel; re: RegExp }[] = [
  { label: 'Verifying', re: /\b(verify|verifying|test|testing|confirm|re-?read|check|assert|ensure)\b/i },
  { label: 'Coding', re: /\b(edit|editing|write|writing|create|creating|apply|applying|update|updating|bash|run|running|implement|refactor|delete|remove|insert|replace)\b/i },
  { label: 'Search', re: /\b(read|reading|grep|glob|find|finding|search|searching|look|looking|scan|explore|inspect|list|locate)\b/i },
];

function classify(chunk: string, index: number): PhaseLabel {
  if (index === 0) return 'Planning';
  for (const r of RULES) if (r.re.test(chunk)) return r.label;
  return 'Reasoning';
}

/** Split on blank-line paragraph breaks, dropping empty paragraphs. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Derive ordered phases from a flat reasoning string. If the text has no
 *  paragraph breaks, returns a single Planning phase so the view degrades
 *  gracefully (one collapsible segment) instead of an empty list. */
export function derivePhases(text: string): Phase[] {
  const chunks = paragraphs(text);
  if (chunks.length === 0) {
    return chunks.length === 0 && text.trim()
      ? [{ id: 'p0', label: 'Reasoning', text, estTokens: Math.round(text.length / 4) }]
      : [];
  }
  return chunks.map((chunk, i) => ({
    id: `p${i}`,
    label: classify(chunk, i),
    text: chunk,
    estTokens: Math.round(chunk.length / 4),
  }));
}

/** Distinct labels in emission order, for the summary chips in the header. */
export function phaseChips(phases: Phase[]): PhaseLabel[] {
  const seen = new Set<PhaseLabel>();
  const out: PhaseLabel[] = [];
  for (const p of phases) if (!seen.has(p.label)) { seen.add(p.label); out.push(p.label); }
  return out;
}
