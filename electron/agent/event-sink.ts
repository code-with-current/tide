/** Batches orchestrator stream events into the `event` table (one WAL
 * transaction per flush — one fsync per ~50ms, not per chunk) and forwards
 * per-session batches to the renderer. On DB failure it degrades to push-only:
 * streaming continues, reconnect/replay is simply unavailable. */

import type { Database } from 'better-sqlite3';

export interface SinkEvent {
  type: 'part.delta' | 'part.commit' | 'message.end' | 'turn.end';
  sessionId: string;
  messageId?: string;
  partId?: string;
  data?: Record<string, unknown>;
  seq?: number;
}

/** One flushed partition of events, delivered per session. Event `seq` is
 * present iff the transaction committed (persisted rowid, ascending within
 * the batch); absent ⇒ degraded push-only delivery with firstSeq/lastSeq 0. */
export interface FlushBatch {
  events: SinkEvent[];
  firstSeq: number;
  lastSeq: number;
}

export interface SinkUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheRead?: number;
  costUsd: number;
}

export interface EventSink {
  emit(event: SinkEvent): void;
  flush(): void;
  dispose(): void;
}

export function createEventSink(
  db: Database,
  opts: { flushMs?: number; onFlush?: (batch: FlushBatch) => void } = {},
): EventSink {
  const flushMs = opts.flushMs ?? 50;
  let buffer: SinkEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const insertEvent = db.prepare(
    `INSERT INTO event (session_id, message_id, part_id, type, data, time_created)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated)
     VALUES (@id, @messageId, @sessionId, @seq, @kind, @data, @now, @now)`,
  );
  const partExists = db.prepare(`SELECT COUNT(*) c FROM part WHERE id = ?`);
  const bumpMessageCompleted = db.prepare(`UPDATE message SET time_completed = ? WHERE id = ?`);
  const addUsage = db.prepare(
    `UPDATE session SET tokens_input = tokens_input + @i, tokens_output = tokens_output + @o,
       tokens_reasoning = tokens_reasoning + @r, tokens_cache_read = tokens_cache_read + @cr,
       cost = cost + @c, time_updated = @now WHERE id = @id`,
  );

  function deliver(batch: FlushBatch): void {
    try {
      opts.onFlush?.(batch);
    } catch {
      // A throwing consumer (e.g. webContents.send on a destroyed window) must
      // not escape flush() — the interval tick would crash — and must not be
      // mistaken for a DB failure, which would re-deliver the batch.
    }
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    let stamped: Map<string, (SinkEvent & { seq: number })[]> | null = null;
    try {
      const tx = db.transaction((evts: SinkEvent[]) => {
        const out = new Map<string, (SinkEvent & { seq: number })[]>();
        for (const e of evts) {
          const info = insertEvent.run(e.sessionId, e.messageId ?? null, e.partId ?? null, e.type, JSON.stringify(e.data ?? {}), Date.now());
          const event: SinkEvent & { seq: number } = { ...e, seq: Number(info.lastInsertRowid) };
          const list = out.get(e.sessionId);
          if (list) list.push(event);
          else out.set(e.sessionId, [event]);
          if (e.type === 'part.commit' && e.partId && e.messageId) {
            const body = (e.data ?? {}) as { kind: string; data: unknown; seq?: number };
            const existing = partExists.get(e.partId) as { c: number };
            if (existing.c === 0) {
              insertPart.run({ id: e.partId, messageId: e.messageId, sessionId: e.sessionId, seq: body.seq ?? 0, kind: body.kind, data: JSON.stringify(body.data ?? {}), now: Date.now() });
            }
          }
          if (e.type === 'message.end' && e.messageId) {
            bumpMessageCompleted.run(Date.now(), e.messageId);
            const usage = ((e.data ?? {}) as { usage?: SinkUsage }).usage;
            if (usage) {
              addUsage.run({ id: e.sessionId, now: Date.now(), i: usage.inputTokens ?? 0, o: usage.outputTokens ?? 0, r: usage.reasoningTokens ?? 0, cr: usage.cacheRead ?? 0, c: usage.costUsd ?? 0 });
            }
          }
        }
        return out;
      });
      stamped = tx(events);
    } catch {
      // Push-only degradation: the DB write failed (disk full, closed handle,
      // corruption) — still deliver to the live renderer, skip persistence.
      stamped = null;
    }
    if (stamped) {
      for (const evts of stamped.values()) {
        deliver({ events: evts, firstSeq: evts[0].seq, lastSeq: evts[evts.length - 1].seq });
      }
    } else {
      const bySession = new Map<string, SinkEvent[]>();
      for (const e of events) {
        const list = bySession.get(e.sessionId);
        if (list) list.push(e);
        else bySession.set(e.sessionId, [e]);
      }
      for (const evts of bySession.values()) {
        deliver({ events: evts, firstSeq: 0, lastSeq: 0 });
      }
    }
  }

  function emit(event: SinkEvent): void {
    buffer.push(event);
    if (flushMs === 0) flush();
    else if (timer === null) timer = setInterval(flush, flushMs);
  }

  return {
    emit,
    flush,
    dispose: () => { if (timer !== null) clearInterval(timer); flush(); },
  };
}
