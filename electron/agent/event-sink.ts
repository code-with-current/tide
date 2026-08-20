/** Batches orchestrator stream events into the `event` table (one WAL
 * transaction per flush — one fsync per ~50ms, not per chunk) and forwards
 * flushed batches to the renderer. On DB failure it degrades to push-only:
 * streaming continues, reconnect/replay is simply unavailable. */

import type { Database } from 'better-sqlite3';

export interface SinkEvent {
  type: 'part.delta' | 'part.commit' | 'message.end' | 'turn.end';
  sessionId: string;
  messageId?: string;
  partId?: string;
  data?: Record<string, unknown>;
}

export interface FlushBatch {
  events: SinkEvent[];
  firstSeq: number;
  lastSeq: number;
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

  function flush(): void {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    let firstSeq = 0;
    let lastSeq = 0;
    try {
      const tx = db.transaction((evts: SinkEvent[]) => {
        for (const e of evts) {
          const info = insertEvent.run(e.sessionId, e.messageId ?? null, e.partId ?? null, e.type, JSON.stringify(e.data ?? {}), Date.now());
          const seq = Number(info.lastInsertRowid);
          if (!firstSeq) firstSeq = seq;
          lastSeq = seq;
          if (e.type === 'part.commit' && e.partId && e.messageId) {
            const body = (e.data ?? {}) as { kind: string; data: unknown; seq?: number };
            const existing = partExists.get(e.partId) as { c: number };
            if (existing.c === 0) {
              insertPart.run({ id: e.partId, messageId: e.messageId, sessionId: e.sessionId, seq: body.seq ?? 0, kind: body.kind, data: JSON.stringify(body.data ?? {}), now: Date.now() });
            }
          }
          if (e.type === 'message.end' && e.messageId) {
            bumpMessageCompleted.run(Date.now(), e.messageId);
            const usage = ((e.data ?? {}) as { usage?: Record<string, number> }).usage;
            if (usage) {
              addUsage.run({ id: e.sessionId, now: Date.now(), i: usage.inputTokens ?? 0, o: usage.outputTokens ?? 0, r: usage.reasoningTokens ?? 0, cr: usage.cacheRead ?? 0, c: usage.costUsd ?? 0 });
            }
          }
        }
      });
      tx(events);
      opts.onFlush?.({ events, firstSeq, lastSeq });
    } catch {
      // Push-only degradation: the DB write failed (disk full, closed handle,
      // corruption) — still deliver to the live renderer, skip persistence.
      opts.onFlush?.({ events, firstSeq: 0, lastSeq: 0 });
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
