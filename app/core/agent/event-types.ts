/** Wire shapes of the orchestrator event stream. Leaf module (no imports) so
 *  shared/rpc.ts can reference FlushBatch without dragging the sink's
 *  runtime dependencies (bun:sqlite under Bun) into programs that only need
 *  the types — the renderer's tsconfig among them. The sink re-exports these;
 *  import from event-sink.js unless you cannot afford its import graph. */

export interface SinkEvent {
  type: 'part.delta' | 'part.commit' | 'message.end' | 'turn.end';
  sessionId: string;
  messageId?: string;
  partId?: string;
  data?: Record<string, unknown>;
  seq?: number;
}

/** One flushed partition of events, delivered per session. Event `seq` is
 *  present iff the transaction committed (persisted rowid, ascending within
 *  the batch); absent ⇒ degraded push-only delivery with firstSeq/lastSeq 0. */
export interface FlushBatch {
  events: SinkEvent[];
  firstSeq: number;
  lastSeq: number;
}
