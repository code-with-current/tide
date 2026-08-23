/** Mermaid auto-repair: when the renderer's local sanitize chain exhausts all
 *  candidates, ask a model to rewrite the diagram. Runs on the system model
 *  (same lightweight path as title generation) so repair never bills the
 *  user's chat provider and never blocks on a missing one. */

import { isSystemModelConfigured, runSystemTask } from './system-model.js';

const REPAIR_SYSTEM =
  'You fix broken Mermaid diagram sources. You will get the diagram source and the parser error. ' +
  'Return ONLY the corrected diagram inside a single ```mermaid fenced code block — no prose, no explanation. ' +
  'Keep the same diagram type, nodes, and meaning; only fix the syntax.\n' +
  'Rules: quote labels containing spaces or special characters; never use `end` as a node id; ' +
  'quote subgraph titles containing spaces; no inline %% comments; no HTML entities; ' +
  'no style/classDef/class/linkStyle/click lines; every subgraph/alt/opt/loop block needs its `end`; ' +
  'no braces {} in sequenceDiagram message text; balanced brackets on every line.';

/** Pull the mermaid code out of a model reply. Tolerates: fenced block with
 *  or without the `mermaid` tag, bare fenced block, or raw diagram source
 *  with no fence at all. Returns null when nothing diagram-shaped is found. */
export function extractMermaidFromReply(reply: string): string | null {
  const text = reply.trim();
  const fenced = text.match(/```(?:mermaid|mmd)?\s*\n([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  // No fence — accept the whole reply only when it starts like a diagram
  // directive, so prose preambles ("Here is the fixed version:") reject.
  if (/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|journey)\b/m.test(text)) {
    return text;
  }
  return null;
}

export async function repairMermaidDiagram(
  source: string,
  parseError: string,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  if (!isSystemModelConfigured()) {
    return { ok: false, error: 'System model not configured' };
  }
  try {
    const reply = await runSystemTask({
      system: REPAIR_SYSTEM,
      prompt: `Parser error:\n${parseError}\n\nBroken diagram source:\n${source}`,
      maxOutputTokens: 2048,
      abortSignal: AbortSignal.timeout(45_000),
    });
    const code = extractMermaidFromReply(reply);
    if (!code) return { ok: false, error: 'Repair reply contained no diagram' };
    return { ok: true, code };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
