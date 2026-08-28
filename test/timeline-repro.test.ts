/**
 * Offline repro for the "switch back → turn content missing" bug: drive the
 * REAL renderer pipeline (migrate → adapter → timeline rows) with the exact
 * wire our Rust sessionGet returns (StoredMessageWire: id/role/content/
 * createdAt/reasoning only — no blocks/timeline/toolCalls).
 */
import { describe, expect, it } from "vitest";
import { migrateMessagesToBlocks } from "@/lib/stream/block-migration";
import { buildChatMessageEntries } from "@/components/chat/timeline/lib/tide-adapter";

// Exact wire shape from src-tauri/src/commands/sessions.rs StoredMessageWire,
// populated like s_qgndwujm (user 41ch, assistant with 9 concatenated text
// parts incl. large ones).
const wire = [
  { id: "m_user", role: "user", content: "Analyze the code and summarize it", createdAt: "2026-08-27T20:29:00.000Z" },
  {
    id: "m_asst",
    role: "assistant",
    content: "Continuing with step 2. First result here. Second paragraph of the answer. Final summary of everything found across the workspace scan.",
    createdAt: "2026-08-27T20:29:05.000Z",
    reasoning: "thinking about the task",
  },
];

const asMessage = (m: any) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  reasoning: m.reasoning,
  reasoningTokens: m.reasoningTokens,
  reasoningMs: m.reasoningMs,
  totalMs: m.totalMs,
  createdAt: m.createdAt,
  toolCalls: m.toolCalls,
  timeline: m.timeline,
  turn: m.turn,
  blocks: m.blocks,
  attachments: m.attachments,
  compactionInfo: m.compactionInfo,
});

describe("timeline read-path repro (Rust StoredMessageWire)", () => {
  it("migrate keeps both messages with non-empty content", () => {
    const messages = migrateMessagesToBlocks(wire.map(asMessage));
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("Analyze");
    expect(messages[1].content ?? "").toContain("Final summary");
  });

  it("adapter produces visible entries for user AND assistant", () => {
    const messages = migrateMessagesToBlocks(wire.map(asMessage));
    const entries = buildChatMessageEntries(messages as any, {
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: new Set(),
    } as any);
    const roles = entries.map((e: any) => e.record?.role ?? e.role ?? e.kind).filter(Boolean);
    console.log("entries:", JSON.stringify(entries.map((e: any) => ({ kind: e.kind, role: e.record?.role, id: e.record?.id, hasBlocks: !!e.record?.blocks?.length })), null, 2));
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).toContain("Final summary");
  });
});
