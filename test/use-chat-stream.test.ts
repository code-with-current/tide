import { describe, expect, it, vi } from "vitest";

// The hook module pulls in renderer-only seams at import time (the IPC
// client, notification sounds with .mp3 assets, the persisted Zustand
// store). applyLegacyEvent itself is pure over its arguments — mock the
// seams, drive the function directly.
vi.mock("@/lib/api/client", () => ({
  chatAbort: () => {},
  chatApproveTools: () => {},
  chatRejectTools: () => {},
  chatSend: async () => ({ accepted: true }),
  chatSubmitFollowup: async () => true,
  sendLog: () => {},
}));
vi.mock("@/lib/api/rpc", () => ({
  hasRpc: false,
  onAgentEvent: () => () => {},
}));
vi.mock("@/lib/sounds", () => ({
  notifyPermissionRequired: () => {},
  notifyTurnEnd: () => {},
}));
vi.mock("@/lib/stores/ui", () => ({
  useUi: Object.assign(() => {}, {
    getState: () => ({ enqueueMessage: () => {}, showOptionsPopup: () => {} }),
    setState: () => {},
  }),
  freshStream: () => ({
    text: "", reasoning: "", toolCalls: [], timeline: [], blocks: [],
    toolBlockIndex: {}, turn: undefined, usage: null, sessionCostUsd: 0,
    iteration: 0, permissionRequest: null, isStreaming: false, error: null,
    retry: null, compacting: false, compactedTokens: null, stopReason: null,
    finalMessage: null,
  }),
}));

import type { AgentEvent } from "@/lib/agent/events";
import type { SessionStream } from "@/types";
import { applyLegacyEvent } from "@/hooks/use-chat-stream";
import { reduceStream } from "@/lib/stream/stream-reducer";

function baseState(): SessionStream {
  return {
    text: "", reasoning: "", toolCalls: [], timeline: [], blocks: [],
    toolBlockIndex: {}, turn: undefined, usage: null, sessionCostUsd: 0,
    iteration: 0, permissionRequest: null, isStreaming: false, error: null,
    retry: null, compacting: false, compactedTokens: null, stopReason: null,
    finalMessage: null,
  };
}

const deltaEvent = (seq: number, text: string, blockId: string): AgentEvent => ({
  type: "delta", sessionId: "s_1", seq, messageId: "m_1", text, blockId,
});

/** The flushNow pipeline: reducer pass first, then the legacy mirror over
 *  the already-reduced state — the order the live hook commits. */
function flush(state: SessionStream, batch: AgentEvent[]): SessionStream {
  let next = state;
  for (const event of batch) next = reduceStream(next, event);
  let legacy = next;
  for (const event of batch) legacy = applyLegacyEvent(legacy, event);
  return legacy;
}

describe("applyLegacyEvent turn_end", () => {
  it("falls back to the reducer's live blocks when the event omits them", () => {
    const turnEnd: AgentEvent = {
      type: "turn_end", sessionId: "s_1", seq: 3, messageId: "m_1",
      stopReason: "end_turn", content: "Hello world",
      timeline: [{ type: "text", text: "Hello world" }],
    };

    const state = flush(baseState(), [
      deltaEvent(1, "Hello ", "b_1"),
      deltaEvent(2, "world", "b_1"),
      turnEnd,
    ]);

    // The frozen message must carry the canonical block list the reducer
    // built (the Rust turn_end has no `blocks` field — its absence must
    // not freeze an undefined list) ...
    expect(state.finalMessage).not.toBeNull();
    expect(state.finalMessage!.blocks).toEqual(state.blocks);
    // ... with the trailing text flagged as the turn's answer.
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "text", text: "Hello world", isAnswer: true });
    expect(state.isStreaming).toBe(false);
    expect(state.finalMessage!.content).toBe("Hello world");
  });

  it("prefers the event's blocks when the backend sends them (TS parity)", () => {
    const backendBlocks = [
      { id: "b_1", kind: "text", text: "server truth", createdAtSeq: 1, modifiedAtSeq: 2, isAnswer: true },
    ] as SessionStream["blocks"];
    const turnEnd: AgentEvent = {
      type: "turn_end", sessionId: "s_1", seq: 2, messageId: "m_1",
      stopReason: "end_turn", content: "server truth",
      blocks: backendBlocks,
    };

    const state = flush(baseState(), [deltaEvent(1, "streamed", "b_1"), turnEnd]);

    expect(state.finalMessage!.blocks).toBe(backendBlocks);
  });

  it("keeps an empty live block list undefined-free for the freeze effect's isEmpty guard", () => {
    const turnEnd: AgentEvent = {
      type: "turn_end", sessionId: "s_1", seq: 1, messageId: "m_1",
      stopReason: "end_turn", content: "",
      timeline: [],
    };
    const state = flush(baseState(), [turnEnd]);
    expect(state.finalMessage!.blocks).toEqual([]);
    expect(state.finalMessage!.content).toBe("");
  });
});
