/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/types.ts + @opencode-ai/sdk/v2 `Message`/`Part` shapes, vendored so the projection port has no runtime SDK dependency. Adds a Tide-specific 'followup' part type and permissive extras (mentions/attachments stash, clientRole/finish passthrough) consumed by the tide-adapter. */

export interface OcMessage {
  id: string;
  role: string;
  time: { created: number; completed?: number };
  /** OpenCode session coupling kept for projection passthrough; the Tide adapter never sets it. */
  sessionID?: string;
  parentID?: string;
  clientRole?: string | null;
  /** OpenCode finish reason ('stop' on completed assistant messages); the adapter maps Tide's stopReason into it. */
  finish?: string | null;
  /** OpenCode compaction-summary payload ({ body, diffs } or `true`); the Tide adapter never sets it. */
  summary?: unknown;
  error?: unknown;
  /** Tide stash fields: the adapter copies Message.mentions/attachments through for downstream renderers. */
  mentions?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
}

export interface OcToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  time?: { start?: number; end?: number };
  attachments?: unknown[];
  [key: string]: unknown;
}

interface OcPartBase {
  id?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OcTextPart extends OcPartBase {
  type: 'text';
  text: string;
}

export interface OcReasoningPart extends OcPartBase {
  type: 'reasoning';
  text?: string;
}

export interface OcToolPart extends OcPartBase {
  type: 'tool';
  tool: string;
  toolCallId?: string;
  state: OcToolState;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface OcFollowupPart extends OcPartBase {
  type: 'followup';
  toolCallId: string;
  /** Tide FollowupMode union: { kind: 'options' | 'question' | 'blank', ... }. */
  mode: unknown;
}

export interface OcStepStartPart extends OcPartBase {
  type: 'step-start';
}

export interface OcPatchPart extends OcPartBase {
  type: 'patch';
  [key: string]: unknown;
}

export type OcPart =
  | OcTextPart
  | OcReasoningPart
  | OcToolPart
  | OcFollowupPart
  | OcStepStartPart
  | OcPatchPart;
