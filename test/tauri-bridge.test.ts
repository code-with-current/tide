import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => {
  // Minimal Channel stand-in: captures every constructed instance on
  // globalThis (which survives vi.resetModules) so tests can drive
  // `onmessage` exactly the way the Tauri runtime would.
  class Channel<T = unknown> {
    onmessage: ((message: T) => void) | null = null;
    constructor() {
      const g = globalThis as { __tideChannels?: Channel<unknown>[] };
      (g.__tideChannels ??= []).push(this as Channel<unknown>);
    }
  }
  return {
    invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    Channel,
  };
});

type BridgeGlobal = { request: Record<string, (params?: unknown) => Promise<unknown>> };
type FakeChannel = { onmessage: ((message: unknown) => void) | null };

function globals(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function installedBridge(): BridgeGlobal {
  const bridge = globals().__TIDE_BRIDGE__;
  if (!bridge) throw new Error("bridge not installed");
  return bridge as BridgeGlobal;
}

/** Queues the handshake + Channel attach resolves, installs the bridge on a
 *  fresh module registry, and returns the installed request surface. */
async function installBridge(): Promise<BridgeGlobal> {
  globals().__TAURI_INTERNALS__ = {};
  invoke
    .mockResolvedValueOnce({ version: "0.4.0", protocol: 1 })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue(undefined);
  const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
  expect(await installTauriBridge()).toBe(true);
  return installedBridge();
}

/** The Suite runs in node — rpc.ts and the installer address `window`, so
 *  point it at globalThis and give every test a fresh module registry (the
 *  `rpc`/`hasRpc` live bindings re-bind to null on re-eval). */
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal("window", globalThis);
  globals().__tideChannels = [];
  delete globals().__TAURI_INTERNALS__;
  delete globals().__TIDE_BRIDGE__;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globals().__TAURI_INTERNALS__;
  delete globals().__TIDE_BRIDGE__;
  delete globals().__tideChannels;
  vi.unstubAllGlobals();
});

describe("installTauriBridge", () => {
  it("stays dormant outside a Tauri webview", async () => {
    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(globals().__TIDE_BRIDGE__).toBeUndefined();
  });

  it("installs on a protocol-1 handshake and routes M1 domains to invoke", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke
      .mockResolvedValueOnce({ version: "0.4.0", protocol: 1 })
      .mockResolvedValueOnce(undefined) // chat_attach_channel
      .mockResolvedValueOnce([{ id: "ws_1", name: "tide", path: "/repo/tide" }])
      .mockResolvedValue(undefined);

    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, "bridge_version", undefined);

    const bridge = installedBridge();
    expect(await bridge.request.workspaceList({})).toEqual([
      { id: "ws_1", name: "tide", path: "/repo/tide" },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("workspace_list", {});

    const headers = [
      {
        id: "s_1",
        workspaceId: "ws_1",
        title: "One",
        modelId: "model-x",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:01:00.000Z",
        messageCount: 2,
        kind: "main",
      },
    ];
    invoke.mockResolvedValueOnce(headers);
    expect(await bridge.request.sessionList({ workspaceId: "ws_1" })).toEqual(headers);
    expect(invoke).toHaveBeenLastCalledWith("session_list", { workspaceId: "ws_1" });

    await bridge.request.sessionListArchived({ workspaceId: "ws_1" });
    expect(invoke).toHaveBeenLastCalledWith("session_list_archived", { workspaceId: "ws_1" });

    await bridge.request.sessionListV2({ workspacePath: "/repo/tide", opts: { limit: 5 } });
    expect(invoke).toHaveBeenLastCalledWith("session_list_v2", {
      workspacePath: "/repo/tide",
      opts: { limit: 5 },
    });

    await bridge.request.sessionMessagesV2({ sessionId: "s_1", opts: { before: "msg-02" } });
    expect(invoke).toHaveBeenLastCalledWith("session_messages_v2", {
      sessionId: "s_1",
      opts: { before: "msg-02" },
    });

    await bridge.request.settingsUpdateAgent({ patch: { maxSteps: 5 } });
    expect(invoke).toHaveBeenLastCalledWith("settings_update_agent", { patch: { maxSteps: 5 } });

    await bridge.request.providerList({});
    expect(invoke).toHaveBeenLastCalledWith("provider_list", {});
  });

  it("attaches exactly one chat Channel between handshake and client activation", async () => {
    await installBridge();

    const channels = globals().__tideChannels as FakeChannel[];
    expect(channels.length).toBe(1);
    expect(channels[0].onmessage).toBeInstanceOf(Function);
    expect(invoke).toHaveBeenNthCalledWith(1, "bridge_version", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "chat_attach_channel", { channel: channels[0] });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("stays on the mock store when the chat Channel attach fails", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke
      .mockResolvedValueOnce({ version: "0.4.0", protocol: 1 })
      .mockRejectedValueOnce(new Error("command chat_attach_channel not found"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rpcModule = await import("@/lib/api/rpc");
    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(false);
    expect(rpcModule.rpc).toBeNull();
    expect(rpcModule.hasRpc).toBe(false);
    expect(globals().__TIDE_BRIDGE__).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a protocol mismatch without installing", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce({ version: "9.9.9", protocol: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(globals().__TIDE_BRIDGE__).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("survives a rejected handshake and leaves the client.ts mock path intact", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke.mockRejectedValue(new Error("ipc not registered"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rpcModule = await import("@/lib/api/rpc");
    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(false);
    expect(rpcModule.rpc).toBeNull();
    expect(rpcModule.hasRpc).toBe(false);
    expect(globals().__TIDE_BRIDGE__).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects unported methods asynchronously, never with a sync throw", async () => {
    await installBridge();

    const bridge = installedBridge();
    const pending = bridge.request.gitStatus({ workspaceId: "ws_1" });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(/not ported/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("flips the live rpc binding when the bridge installs after import (ordering regression)", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke
      .mockResolvedValueOnce({ version: "0.4.0", protocol: 1 })
      .mockResolvedValueOnce(undefined) // chat_attach_channel
      .mockResolvedValueOnce([])
      .mockResolvedValue(undefined);

    const rpcModule = await import("@/lib/api/rpc");
    expect(rpcModule.rpc).toBeNull();

    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(true);

    expect(rpcModule.rpc).not.toBeNull();
    expect(rpcModule.hasRpc).toBe(true);
    expect(await rpcModule.rpc!.request.providerList({})).toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith("provider_list", {});
  });
});

describe("chat Channel push routing", () => {
  function channel(): FakeChannel {
    const channels = globals().__tideChannels as FakeChannel[];
    expect(channels.length).toBe(1);
    return channels[0];
  }

  it("delivers ChatPush agentEvents to the onAgentEvent seam", async () => {
    await installBridge();
    const rpcModule = await import("@/lib/api/rpc");

    const seen: unknown[] = [];
    rpcModule.onAgentEvent((event) => seen.push(event));

    const delta = {
      type: "delta",
      sessionId: "s_1",
      seq: 3,
      messageId: "m_1",
      text: "hi",
      blockId: "p_1",
    };
    channel().onmessage?.({ channel: "agentEvents", event: delta });
    expect(seen).toEqual([delta]);

    // Slot semantics: a replaced consumer owns the slot (single-slot registry).
    const second: unknown[] = [];
    rpcModule.onAgentEvent((event) => second.push(event));
    channel().onmessage?.({ channel: "agentEvents", event: delta });
    expect(seen).toEqual([delta]);
    expect(second).toEqual([delta]);
  });

  it("delivers ChatPush orchestratorEvents to the onOrchestratorEvents seam", async () => {
    await installBridge();
    const rpcModule = await import("@/lib/api/rpc");

    const seen: unknown[] = [];
    rpcModule.onOrchestratorEvents((batch) => seen.push(batch));

    const batch = {
      events: [
        {
          type: "part.commit",
          sessionId: "s_1",
          messageId: "m_1",
          partId: "p_1",
          data: { kind: "text", text: "hi" },
          seq: 4,
        },
      ],
      firstSeq: 4,
      lastSeq: 4,
    };
    channel().onmessage?.({ channel: "orchestratorEvents", batch });
    expect(seen).toEqual([batch]);
  });

  it("delivers ChatPush todosUpdated to the onTodosUpdated seam", async () => {
    await installBridge();
    const rpcModule = await import("@/lib/api/rpc");

    const seen: unknown[] = [];
    rpcModule.onTodosUpdated((event) => seen.push(event));

    const event = {
      sessionId: "s_1",
      todos: [
        { content: "Port the tool", status: "completed" },
        { content: "Wire the push", status: "in_progress", priority: "high" },
      ],
    };
    channel().onmessage?.({ channel: "todosUpdated", event });
    expect(seen).toEqual([event]);

    // Slot semantics like the other on* registries: a replaced consumer
    // owns the slot.
    const second: unknown[] = [];
    rpcModule.onTodosUpdated((e) => second.push(e));
    channel().onmessage?.({ channel: "todosUpdated", event });
    expect(seen).toEqual([event]);
    expect(second).toEqual([event]);
  });

  it("drops unknown channel tags without touching the seams", async () => {
    await installBridge();
    const rpcModule = await import("@/lib/api/rpc");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const seen: unknown[] = [];
    rpcModule.onAgentEvent((event) => seen.push(event));

    expect(() =>
      channel().onmessage?.({ channel: "terminalOutput", data: "x" }),
    ).not.toThrow();
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("chat request routing", () => {
  it("routes chatSend verbatim under the args key of chat_run_turn", async () => {
    const bridge = await installBridge();
    invoke.mockResolvedValueOnce({ accepted: true });

    const payload = {
      sessionId: "s_1",
      messages: [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: "hello" },
      ],
      modelId: "glm-4.7",
      providerId: "p_1",
      autonomyMode: "edit" as const,
      thinkingLevel: "high" as const,
    };
    expect(await bridge.request.chatSend(payload)).toEqual({ accepted: true });
    expect(invoke).toHaveBeenLastCalledWith("chat_run_turn", { args: payload });
  });

  it("routes chatAbort with the sessionId passthrough", async () => {
    const bridge = await installBridge();
    await bridge.request.chatAbort({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("chat_abort", { sessionId: "s_1" });
  });

  it("routes chatApproveTools onto permission_respond with approve: true", async () => {
    const bridge = await installBridge();
    await bridge.request.chatApproveTools({
      sessionId: "s_1",
      toolCallIds: ["t_1", "t_2"],
      newMode: "edit",
      remember: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("permission_respond", {
      args: {
        sessionId: "s_1",
        toolCallIds: ["t_1", "t_2"],
        approve: true,
        newMode: "edit",
        remember: true,
      },
    });
  });

  it("routes chatRejectTools onto permission_respond with approve: false", async () => {
    const bridge = await installBridge();
    await bridge.request.chatRejectTools({
      sessionId: "s_1",
      toolCallIds: ["t_1"],
      reason: "not that file",
    });
    expect(invoke).toHaveBeenLastCalledWith("permission_respond", {
      args: {
        sessionId: "s_1",
        toolCallIds: ["t_1"],
        approve: false,
        reason: "not that file",
      },
    });
  });

  it("routes chatSubmitFollowup verbatim under the args key", async () => {
    const bridge = await installBridge();
    invoke.mockResolvedValueOnce({ resolved: true });

    const params = { sessionId: "s_1", toolCallId: "t_f", answer: "Approach A" };
    expect(await bridge.request.chatSubmitFollowup(params)).toEqual({ resolved: true });
    expect(invoke).toHaveBeenLastCalledWith("chat_submit_followup", { args: params });
  });

  it("routes sessionCreate with the hydrated-session response", async () => {
    const bridge = await installBridge();
    const hydrated = {
      id: "s_new",
      workspaceId: "ws_1",
      title: "New session",
      modelId: "glm-4.7",
      providerId: "p_1",
      messages: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      autonomyMode: "ask",
      thinkingLevel: "medium",
      status: "idle",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        calls: 0,
        costUsd: 0,
      },
      costUsd: 0,
    };
    invoke.mockResolvedValueOnce(hydrated);

    const params = {
      workspaceId: "ws_1",
      title: "New session",
      modelId: "glm-4.7",
      opts: { autonomyMode: "ask" as const, thinkingLevel: "medium" as const },
    };
    expect(await bridge.request.sessionCreate(params)).toEqual(hydrated);
    expect(invoke).toHaveBeenLastCalledWith("session_create", params);
  });

  it("routes the events subscribe/unsubscribe replay pair", async () => {
    const bridge = await installBridge();
    const batches = [
      { events: [{ type: "part.commit", sessionId: "s_1", seq: 1 }], firstSeq: 1, lastSeq: 1 },
    ];
    invoke.mockResolvedValueOnce({ batches });

    expect(await bridge.request.eventsSubscribe({ sessionId: "s_1", lastSeq: null })).toEqual({
      batches,
    });
    expect(invoke).toHaveBeenLastCalledWith("events_subscribe", {
      sessionId: "s_1",
      lastSeq: null,
    });

    await bridge.request.eventsUnsubscribe({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("events_unsubscribe", { sessionId: "s_1" });
  });

  it("routes the splash boot gates: consentShouldShow + lastSession get/set", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ shouldShow: false });
    expect(await bridge.request.consentShouldShow({})).toEqual({ shouldShow: false });
    expect(invoke).toHaveBeenLastCalledWith("consent_should_show", {});

    invoke.mockResolvedValueOnce({ sessionId: "s_1", workspaceId: "ws_1" });
    expect(await bridge.request.lastSessionGet({})).toEqual({ sessionId: "s_1", workspaceId: "ws_1" });
    expect(invoke).toHaveBeenLastCalledWith("last_session_get", {});

    invoke.mockResolvedValueOnce(undefined);
    await bridge.request.lastSessionSet({ sessionId: null, workspaceId: "ws_1" });
    expect(invoke).toHaveBeenLastCalledWith("last_session_set", { sessionId: null, workspaceId: "ws_1" });
  });
});
