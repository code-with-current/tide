/** Renderer-side mirrors of the v2 session store + event sink wire shapes.
 *  Must stay structurally identical to electron/ipc/session-store-v2.ts and
 *  electron/agent/event-sink.ts — renderer code cannot import from electron/. */

export interface SessionMetaV2 {
  id: string;
  workspacePath: string;
  parentId: string | null;
  title: string;
  modelId: string | null;
  providerId: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  cost: number;
  summaryAdditions: number | null;
  summaryDeletions: number | null;
  summaryFiles: number | null;
  archivedAt: number | null;
  timeCreated: number;
  timeUpdated: number;
}

export interface PartV2 {
  id: string;
  seq: number;
  kind: string;
  data: unknown;
}

export interface MessageWithPartsV2 {
  id: string;
  role: string;
  model: string | null;
  timeCreated: number;
  timeCompleted: number | null;
  parts: PartV2[];
}

export interface SinkEventV2 {
  type: 'part.delta' | 'part.commit' | 'message.end' | 'turn.end';
  sessionId: string;
  messageId?: string;
  partId?: string;
  data?: Record<string, unknown>;
  /** Present iff the flush transaction committed (persisted rowid); absent in
   *  degraded push-only delivery, where firstSeq/lastSeq are 0. */
  seq?: number;
}

export interface FlushBatchV2 {
  events: SinkEventV2[];
  firstSeq: number;
  lastSeq: number;
}
