export interface TimelineMessage {
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

export interface TimelineToolState {
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

interface TimelinePartBase {
  id?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TimelineTextPart extends TimelinePartBase {
  type: 'text';
  text: string;
}

export interface TimelineReasoningPart extends TimelinePartBase {
  type: 'reasoning';
  text?: string;
}

export interface TimelineToolPart extends TimelinePartBase {
  type: 'tool';
  tool: string;
  toolCallId?: string;
  state: TimelineToolState;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface TimelineFollowupPart extends TimelinePartBase {
  type: 'followup';
  toolCallId: string;
  /** Tide FollowupMode union: { kind: 'options' | 'question' | 'blank', ... }. */
  mode: unknown;
}

export interface TimelineStepStartPart extends TimelinePartBase {
  type: 'step-start';
}

export interface TimelinePatchPart extends TimelinePartBase {
  type: 'patch';
  [key: string]: unknown;
}

export type TimelinePart =
  | TimelineTextPart
  | TimelineReasoningPart
  | TimelineToolPart
  | TimelineFollowupPart
  | TimelineStepStartPart
  | TimelinePatchPart;
