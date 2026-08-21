/** Append-only per-session stream state. Deltas accumulate in per-part chunk
 * arrays (a Map push — no parent-array spreads per chunk, which was the
 * allocation storm). Committed parts move to an immutable list; turn end
 * clears the buffers. Reconstructed from the event log on reconnect.
 * Arrival is assumed in-order per session (single IPC channel; replay is
 * ORDER BY seq), so the watermark only guards duplicate replay, not
 * reordering. */

import type { SinkEventV2, PartV2 } from '@/types/session-v2';

interface SessionState {
  lastSeq: number;
  buffers: Map<string, string[]>;
  committed: PartV2[];
}

// ref-stable miss path — useSyncExternalStore loops on fresh [] per snapshot
const EMPTY_PARTS: PartV2[] = [];

export interface StreamStore {
  apply(e: SinkEventV2): PartV2 | undefined; // returns the part on part.commit
  applyBatch(events: SinkEventV2[]): void;
  textOf(sessionId: string, partId: string): string;
  turnParts(sessionId: string): PartV2[];
  bufferSize(sessionId: string): number;
  lastSeq(sessionId: string): number;
  clear(sessionId: string): void;
  subscribe(sessionId: string, fn: () => void): () => void;
}

interface ApplyResult {
  applied: boolean;
  committed?: PartV2;
}

export function createStreamStore(): StreamStore {
  const sessions = new Map<string, SessionState>();
  const listeners = new Map<string, Set<() => void>>();

  function stateOf(id: string): SessionState {
    let s = sessions.get(id);
    if (!s) {
      s = { lastSeq: 0, buffers: new Map(), committed: [] };
      sessions.set(id, s);
    }
    return s;
  }

  function notify(sessionId: string): void {
    listeners.get(sessionId)?.forEach((fn) => fn());
  }

  function applyCore(e: SinkEventV2): ApplyResult {
    const s = stateOf(e.sessionId);
    if (e.seq !== undefined) {
      if (e.seq <= s.lastSeq) return { applied: false }; // idempotent replay
      s.lastSeq = e.seq;
    }
    let committed: PartV2 | undefined;
    switch (e.type) {
      case 'part.delta': {
        if (!e.partId) break;
        let chunks = s.buffers.get(e.partId);
        if (!chunks) { chunks = []; s.buffers.set(e.partId, chunks); }
        chunks.push(String((e.data as { text?: string } | undefined)?.text ?? ''));
        break;
      }
      case 'part.commit': {
        if (!e.partId) break;
        const body = (e.data ?? {}) as { kind?: string; data?: unknown; seq?: number };
        committed = { id: e.partId, seq: body.seq ?? 0, kind: body.kind ?? 'text', data: body.data ?? null };
        s.buffers.delete(e.partId);
        s.committed = [...s.committed, committed]; // one spread per commit, not per chunk
        break;
      }
      case 'turn.end': {
        s.buffers.clear();
        break;
      }
      default:
        break;
    }
    return { applied: true, committed };
  }

  return {
    apply: (e) => {
      const r = applyCore(e);
      if (r.applied) notify(e.sessionId);
      return r.committed;
    },
    applyBatch: (events) => {
      const dirty = new Set<string>();
      for (const e of events) {
        if (applyCore(e).applied) dirty.add(e.sessionId);
      }
      dirty.forEach(notify);
    },
    // committed fallback keeps the selector valid after the buffer is frozen
    textOf: (sessionId, partId) => {
      const s = sessions.get(sessionId);
      const chunks = s?.buffers.get(partId);
      if (chunks) return chunks.join('');
      const part = s?.committed.find((p) => p.id === partId);
      return String((part?.data as { text?: string } | undefined)?.text ?? '');
    },
    turnParts: (sessionId) => sessions.get(sessionId)?.committed ?? EMPTY_PARTS,
    bufferSize: (sessionId) => sessions.get(sessionId)?.buffers.size ?? 0,
    lastSeq: (sessionId) => sessions.get(sessionId)?.lastSeq ?? 0,
    clear: (sessionId) => { sessions.delete(sessionId); notify(sessionId); },
    subscribe: (sessionId, fn) => {
      let set = listeners.get(sessionId);
      if (!set) { set = new Set(); listeners.set(sessionId, set); }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
  };
}

export const streamStore = createStreamStore();
