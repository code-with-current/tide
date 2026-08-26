/** Turn controller: shared mutable state between the streamText `prepareStep` and `onStepEnd` hooks (onStepEnd writes flags/counters; prepareStep reads them to inject corrections and restrict tools), keeping the hook logic stateless and testable. */

/** A skill that's active for this turn. */
export interface ActiveSkill {
  /** Skill identifier (from frontmatter `name:` or directory name). */
  name: string;
  /** Raw SKILL.md body (frontmatter stripped). */
  body: string;
  /** Ordered checklist items parsed from the skill body. Empty = no gating. */
  checklist: string[];
  /** Indices (into `checklist`) the model has satisfied so far. */
  completedSteps: Set<number>;
  /** Tool names the skill restricts to. Undefined = all tools allowed. */
  activeToolSet?: string[];
}

/** Token budget tracking for progressive nudges. */
export interface BudgetState {
  inputTokens: number;
  outputTokens: number;
  /** The LAST step's actual inputTokens — what the model saw in its context
   *  window on its most recent request. This is the right number for
   *  autocompact threshold checks (not the cumulative sum). */
  lastInputTokens: number;
  /** Token count at which to warn (≈80% of context window). */
  warningThreshold: number;
  /** How many nudges injected so far (capped to avoid spam). */
  nudgeCount: number;
}

/** Per-turn state shared between `prepareStep` and `onStepEnd`. */
export interface TurnController {
  /** The active skill, or null if no skill was invoked. */
  skill: ActiveSkill | null;
  /** Token budget accumulator. */
  budget: BudgetState;
  /** Steps completed so far (0-based → 1-based on read). */
  stepCount: number;
  /** Hard step cap (matches MAX_STEPS in orchestrator-sdk). */
  maxSteps: number;
  /** Correction message set by `onStepEnd`, consumed by `prepareStep` — when non-null, prepareStep injects it as a user message before the next step and clears it. How deviations and budget nudges reach the model mid-loop. */
  needsCorrection: string | null;
  /** If true, the custom `stopWhen` predicate stops the loop. */
  shouldStop: boolean;
  /** Consecutive compaction failures — circuit breaker (max 3). */
  consecutiveCompactionFailures: number;
  /** Optional autocompact config override (context window, threshold, etc.). */
  compactionConfig?: import('./context/auto-compact.js').AutoCompactConfig;
  /** True when a stop hook forced this continuation (prevents infinite loops). */
  stopHookActive: boolean;
  /** Step number of the last todo_write this turn (0 = none yet). Drives the
   *  staleness nudge when work steps accumulate without a plan update. */
  lastTodoWriteStep: number;
}

/** Create a fresh controller for a new turn. */
export function createTurnController(maxSteps: number): TurnController {
  return {
    skill: null,
    budget: {
      inputTokens: 0,
      outputTokens: 0,
      lastInputTokens: 0,
      // 100K is a conservative default for the warning threshold; the
      // orchestrator can override after resolving the model's context window.
      warningThreshold: 100_000,
      nudgeCount: 0,
    },
    stepCount: 0,
    maxSteps,
    needsCorrection: null,
    shouldStop: false,
    consecutiveCompactionFailures: 0,
    stopHookActive: false,
    lastTodoWriteStep: 0,
  };
}

// ─── Skill checklist parsing ────────────────────────────────────────────

/** Parse a SKILL.md body for checklist items (heuristic: `## Checklist`/`## Steps`/`## Process` sections or `## Step N:` headings) and frontmatter `allowed-tools`/`tools`; both default to empty/undefined when absent (treated as no gating). */
export function parseSkillMetadata(
  body: string,
): { checklist: string[]; allowedTools?: string[] } {
  const checklist = parseChecklist(body);
  const allowedTools = parseAllowedTools(body);
  return { checklist, allowedTools };
}

function parseChecklist(body: string): string[] {
  const items: string[] = [];

  // Strategy 1: `## Checklist` section with `- [ ]` or `1.` items
  const checklistSection = body.match(
    /##\s*(?:Checklist|Steps?|Process)\s*\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  if (checklistSection) {
    const section = checklistSection[1];
    // Match `- [ ] item`, `1. item`, `1) item`, `- item`
    const lines = section.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*]\s*(?:\[\s*\])?|\d+[.)])\s+(.+)/);
      if (m) {
        const text = m[1].trim().replace(/\*\*/g, '');
        if (text.length > 5) items.push(text);
      }
    }
  }

  // Strategy 2: `## Step N:` / `### N. Title` headings
  if (items.length === 0) {
    const stepHeadings = body.matchAll(/^#{2,3}\s+(?:Step\s+)?\d+[.:)]?\s+(.+)/gim);
    for (const m of stepHeadings) {
      const text = m[1].trim().replace(/\*\*/g, '');
      if (text.length > 5) items.push(text);
    }
  }

  return items;
}

function parseAllowedTools(body: string): string[] | undefined {
  // Look in frontmatter for `allowed-tools:` or `tools:`
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const toolsLine =
    fm[1].match(/^allowed-tools:\s*(.+)/m) ?? fm[1].match(/^tools:\s*(.+)/m);
  if (!toolsLine) return undefined;
  const raw = toolsLine[1].trim().replace(/['"]/g, '');
  const names = raw
    .split(/[,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

// ─── Checklist progress tracking ────────────────────────────────────────

/** Mark checklist items completed by mapping the step's tool call to checklist items via keyword matching (write/edit→"write/save/doc/spec", ask→"ask/question", read/grep→"explore/check/read", git→"commit"). */
export function markChecklistProgress(
  ctrl: TurnController,
  toolCall: { toolName: string },
): void {
  if (!ctrl.skill || ctrl.skill.checklist.length === 0) return;

  const keywords = toolKeywords(toolCall.toolName);
  if (keywords.length === 0) return;

  for (let i = 0; i < ctrl.skill.checklist.length; i++) {
    if (ctrl.skill.completedSteps.has(i)) continue;
    const itemLower = ctrl.skill.checklist[i].toLowerCase();
    if (keywords.some((kw) => itemLower.includes(kw))) {
      ctrl.skill.completedSteps.add(i);
    }
  }
}

function toolKeywords(toolName: string): string[] {
  switch (toolName) {
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
      return ['write', 'save', 'doc', 'spec', 'design doc'];
    case 'git':
      return ['commit', 'git'];
    case 'ask_followup_question':
      return ['ask', 'question', 'clarif'];
    case 'read_file':
    case 'list_dir':
    case 'glob':
    case 'grep':
    case 'bash':
      return ['explore', 'check', 'read', 'understand', 'project', 'context'];
    default:
      return [];
  }
}

/** Are all checklist items completed? */
export function allChecklistDone(skill: ActiveSkill): boolean {
  return skill.checklist.length > 0 && skill.completedSteps.size >= skill.checklist.length;
}

/** List of uncompleted checklist items (human-readable). */
export function remainingSteps(skill: ActiveSkill): string {
  return skill.checklist
    .map((item, i) => ({ item, done: skill.completedSteps.has(i) }))
    .filter((x) => !x.done)
    .map((x) => x.item)
    .join('; ');
}

// ─── Deviation detection ────────────────────────────────────────────────

/** Did the model produce a text answer but stop without calling tools — and this isn't the final step of the skill? A `stop` finish reason with text but no tool calls often means the model decided it's "done" prematurely. */
export function looksLikePrematureStop(step: {
  finishReason: string;
  text?: string;
  toolCalls?: Array<unknown>;
}): boolean {
  // Only flag natural stops (not tool-calls, not errors)
  if (step.finishReason !== 'stop') return false;
  // Must have produced text (an actual answer)
  if (!step.text || step.text.trim().length === 0) return false;
  // Must NOT have called tools in this step (tool calls → still working)
  if (step.toolCalls && step.toolCalls.length > 0) return false;
  return true;
}

/** Build a resume correction for when the model stopped before completing the skill: lead with the imperative, name the remaining steps, and instruct execution over summary. */
export function buildCorrectionMessage(skill: ActiveSkill): string {
  const remaining = remainingSteps(skill);
  return (
    `You stopped before completing the "${skill.name}" skill. Resume directly ` +
    `— no apology, no recap of what you already did. Remaining step(s): ${remaining}. ` +
    `Execute the next remaining step now. Do not summarize or hand off.`
  );
}

// ─── Budget nudges ──────────────────────────────────────────────────────

/** Inject a budget nudge (capped at 2 total): a step nudge within 3 steps of the cap, or a token nudge over 85% of the warning threshold. */
export function checkBudgetNudge(ctrl: TurnController): void {
  if (ctrl.budget.nudgeCount >= 2) return;

  // Step nudge: approaching step cap
  if (ctrl.stepCount >= ctrl.maxSteps - 3) {
    ctrl.needsCorrection =
      `You are on step ${ctrl.stepCount} of ${ctrl.maxSteps}. ` +
      `If you're close to done, wrap up concisely. If not, prioritize the ` +
      `most important remaining work and skip non-essential exploration.`;
    ctrl.budget.nudgeCount++;
    return;
  }

  // Token nudge: approaching context limit
  const pct = ctrl.budget.inputTokens / ctrl.budget.warningThreshold;
  if (pct > 0.85) {
    ctrl.needsCorrection =
      `Context is ${Math.round(pct * 100)}% full. Summarize progress and ` +
      `focus on completing the task with minimal additional tool calls.`;
    ctrl.budget.nudgeCount++;
  }
}
