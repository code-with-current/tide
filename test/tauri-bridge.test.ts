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
    const pending = bridge.request.terminalCreate({ shellId: "t_1" });
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

describe("session + workspace management routing (M4 T2)", () => {
  it("routes sessionGet / sessionListDispatches with their passthrough params", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const hydrated = {
      id: "s_1",
      workspaceId: "ws_1",
      title: "One",
      modelId: "glm-4.7",
      messages: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:01:00.000Z",
      autonomyMode: "ask",
      thinkingLevel: "medium",
      status: "idle",
      usage: {
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        reasoningTokens: 0, calls: 0, costUsd: 0,
      },
      costUsd: 0,
    };
    invoke.mockResolvedValueOnce(hydrated);
    expect(await bridge.request.sessionGet({ sessionId: "s_1" })).toEqual(hydrated);
    expect(invoke).toHaveBeenLastCalledWith("session_get", { sessionId: "s_1" });

    const dispatches = [{ id: "s_kid", workspaceId: "ws_1", title: "Kid", modelId: "", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:01.000Z", messageCount: 1, kind: "subagent", parentId: "s_1" }];
    invoke.mockResolvedValueOnce(dispatches);
    expect(await bridge.request.sessionListDispatches({ parentId: "s_1" })).toEqual(dispatches);
    expect(invoke).toHaveBeenLastCalledWith("session_list_dispatches", { parentId: "s_1" });

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.request.sessionGet({ sessionId: "s_ghost" })).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("session_get", { sessionId: "s_ghost" });
  });

  it("routes the session mutation family verbatim", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    await bridge.request.sessionRename({ sessionId: "s_1", title: "Renamed" });
    expect(invoke).toHaveBeenLastCalledWith("session_rename", { sessionId: "s_1", title: "Renamed" });

    await bridge.request.sessionArchive({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("session_archive", { sessionId: "s_1" });

    await bridge.request.sessionUnarchive({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("session_unarchive", { sessionId: "s_1" });

    await bridge.request.sessionDelete({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("session_delete", { sessionId: "s_1" });

    await bridge.request.sessionUpdateSettings({ sessionId: "s_1", patch: { autonomyMode: "edit" } });
    expect(invoke).toHaveBeenLastCalledWith("session_update_settings", {
      sessionId: "s_1",
      patch: { autonomyMode: "edit" },
    });

    await bridge.request.sessionAddMessage({ sessionId: "s_1", role: "user", content: "hi" });
    expect(invoke).toHaveBeenLastCalledWith("session_add_message", {
      sessionId: "s_1",
      role: "user",
      content: "hi",
    });

    const finalizeMessage = { content: "done", stopReason: "stop" };
    await bridge.request.sessionFinalizeAssistantMessage({
      sessionId: "s_1",
      messageId: "m_1",
      message: finalizeMessage,
    });
    expect(invoke).toHaveBeenLastCalledWith("session_finalize_assistant_message", {
      sessionId: "s_1",
      messageId: "m_1",
      message: finalizeMessage,
    });

    await bridge.request.sessionAddUsage({ sessionId: "s_1", delta: { inputTokens: 5 } });
    expect(invoke).toHaveBeenLastCalledWith("session_add_usage", {
      sessionId: "s_1",
      delta: { inputTokens: 5 },
    });

    invoke.mockResolvedValueOnce({ ok: true });
    expect(await bridge.request.sessionClearAll({})).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("session_clear_all", {});
  });

  it("routes sessionFork and the worktree pair", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const forked = {
      id: "s_fork", workspaceId: "ws_1", title: "Fork of One", modelId: "glm-4.7",
      messages: [], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
      autonomyMode: "ask", thinkingLevel: "medium", status: "idle",
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, calls: 0, costUsd: 0 },
      costUsd: 0,
    };
    invoke.mockResolvedValueOnce(forked);
    const forkParams = { sourceId: "s_1", newModelId: "glm-4.7", opts: { providerId: "p_1" } };
    expect(await bridge.request.sessionFork(forkParams)).toEqual(forked);
    expect(invoke).toHaveBeenLastCalledWith("session_fork", forkParams);

    const worktree = {
      branch: "wt-1", path: "/repo/.agent/worktrees/wt-1", baseCommit: "1cd734e",
      baseBranch: "main", ahead: 0, behind: 0,
    };
    invoke.mockResolvedValueOnce(worktree);
    const wtParams = { sessionId: "s_1", opts: { branchName: "wt-1", baseBranch: "main", configFiles: [".env"] } };
    expect(await bridge.request.sessionCreateWorktree(wtParams)).toEqual(worktree);
    expect(invoke).toHaveBeenLastCalledWith("session_create_worktree", wtParams);

    await bridge.request.sessionRemoveWorktree({ sessionId: "s_1" });
    expect(invoke).toHaveBeenLastCalledWith("session_remove_worktree", { sessionId: "s_1" });
  });

  it("routes workspaceAdd and the workspace family", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const added = {
      id: "ws_abcd1234", name: "tide", path: "/repo/tide", branch: "main",
      headCommit: "1cd734e", isDefault: false, fileCount: 448,
      worktreeLocation: ".agent/worktrees/", scripts: [],
    };
    invoke.mockResolvedValueOnce(added);
    const addParams = { input: { path: "/repo/tide", name: "tide", initGit: true } };
    expect(await bridge.request.workspaceAdd(addParams)).toEqual(added);
    expect(invoke).toHaveBeenLastCalledWith("workspace_add", addParams);

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.request.workspaceGet({ workspaceId: "ws_ghost" })).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("workspace_get", { workspaceId: "ws_ghost" });

    invoke.mockResolvedValueOnce(added);
    const updateParams = { workspaceId: "ws_1", patch: { name: "renamed" } };
    expect(await bridge.request.workspaceUpdate(updateParams)).toEqual(added);
    expect(invoke).toHaveBeenLastCalledWith("workspace_update", updateParams);

    await bridge.request.workspaceArchive({ workspaceId: "ws_1" });
    expect(invoke).toHaveBeenLastCalledWith("workspace_archive", { workspaceId: "ws_1" });

    await bridge.request.workspaceUnarchive({ workspaceId: "ws_1" });
    expect(invoke).toHaveBeenLastCalledWith("workspace_unarchive", { workspaceId: "ws_1" });

    invoke.mockResolvedValueOnce({ ok: false, error: "Workspace must be archived before deletion" });
    expect(await bridge.request.workspaceDelete({ workspaceId: "ws_1" })).toEqual({
      ok: false,
      error: "Workspace must be archived before deletion",
    });
    expect(invoke).toHaveBeenLastCalledWith("workspace_delete", { workspaceId: "ws_1" });

    invoke.mockResolvedValueOnce("/repo/other");
    expect(await bridge.request.workspaceContextGet({ workspaceId: "ws_2" })).toBe("/repo/other");
    expect(invoke).toHaveBeenLastCalledWith("workspace_context_get", { workspaceId: "ws_2" });

    invoke.mockResolvedValueOnce({ ok: false, reason: "binary file" });
    expect(await bridge.request.workspaceFileRead({ workspaceId: "ws_2", relPath: "pic.png" })).toEqual({
      ok: false,
      reason: "binary file",
    });
    expect(invoke).toHaveBeenLastCalledWith("workspace_file_read", {
      workspaceId: "ws_2",
      relPath: "pic.png",
    });

    invoke.mockResolvedValueOnce(["main", "dev"]);
    expect(await bridge.request.workspaceListBranches({ workspaceId: "ws_2" })).toEqual(["main", "dev"]);
    expect(invoke).toHaveBeenLastCalledWith("workspace_list_branches", { workspaceId: "ws_2" });

    invoke.mockResolvedValueOnce([".env"]);
    expect(await bridge.request.workspaceListConfigFiles({ workspaceId: "ws_2" })).toEqual([".env"]);
    expect(invoke).toHaveBeenLastCalledWith("workspace_list_config_files", { workspaceId: "ws_2" });

    invoke.mockResolvedValueOnce({ "/repo/tide": true });
    expect(await bridge.request.workspacesExist({ paths: ["/repo/tide"] })).toEqual({ "/repo/tide": true });
    expect(invoke).toHaveBeenLastCalledWith("workspaces_exist", { paths: ["/repo/tide"] });
  });

  it("routes sessionGenerateTitle with the title result shape", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ title: "Auth token refresh" });
    expect(await bridge.request.sessionGenerateTitle({ sessionId: "s_1" })).toEqual({
      title: "Auth token refresh",
    });
    expect(invoke).toHaveBeenLastCalledWith("session_generate_title", { sessionId: "s_1" });

    invoke.mockResolvedValueOnce({ title: null });
    expect(await bridge.request.sessionGenerateTitle({ sessionId: "s_ghost" })).toEqual({ title: null });
    expect(invoke).toHaveBeenLastCalledWith("session_generate_title", { sessionId: "s_ghost" });
  });
});

describe("OS/window glue routing (M4 T1)", () => {
  it("routes windowIsFullScreen to the fullscreen-query command", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ fullscreen: true });
    expect(await bridge.request.windowIsFullScreen({})).toEqual({ fullscreen: true });
    expect(invoke).toHaveBeenLastCalledWith("window_is_full_screen", {});

    invoke.mockResolvedValueOnce({ maximized: false });
    expect(await bridge.request.windowToggleMaximize({})).toEqual({ maximized: false });
    expect(invoke).toHaveBeenLastCalledWith("window_toggle_maximize", {});

    invoke.mockResolvedValueOnce(undefined);
    await bridge.request.windowClose({});
    expect(invoke).toHaveBeenLastCalledWith("window_close", {});
  });

  it("routes dialogPickFiles/dialogPickDirectory with their passthrough params", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ paths: ["/a/pic.png", "/b/notes.md"] });
    expect(await bridge.request.dialogPickFiles({})).toEqual({ paths: ["/a/pic.png", "/b/notes.md"] });
    expect(invoke).toHaveBeenLastCalledWith("dialog_pick_files", {});

    invoke.mockResolvedValueOnce({ path: "/repo/tide" });
    expect(await bridge.request.dialogPickDirectory({})).toEqual({ path: "/repo/tide" });
    expect(invoke).toHaveBeenLastCalledWith("dialog_pick_directory", {});
  });

  it("routes shellOpenPath with the ShellOpResult shape", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ ok: false, error: "Failed to open path" });
    expect(await bridge.request.shellOpenPath({ path: "/tmp/missing" })).toEqual({
      ok: false,
      error: "Failed to open path",
    });
    expect(invoke).toHaveBeenLastCalledWith("shell_open_path", { path: "/tmp/missing" });

    invoke.mockResolvedValueOnce({ ok: true });
    expect(await bridge.request.shellOpenExternal({ url: "https://tide.codes" })).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("shell_open_external", { url: "https://tide.codes" });

    invoke.mockResolvedValueOnce(undefined);
    await bridge.request.shellShowItemInFolder({ fullPath: "/repo/tide/src/main.rs" });
    expect(invoke).toHaveBeenLastCalledWith("shell_show_item_in_folder", { fullPath: "/repo/tide/src/main.rs" });
  });

  it("routes settingsGet with the overrides/defaults pair", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const wire = { overrides: { sendMessage: ["Ctrl", "Enter"] }, defaults: { commandPalette: ["⌘", "K"] } };
    invoke.mockResolvedValueOnce(wire);
    expect(await bridge.request.settingsGet({})).toEqual(wire);
    expect(invoke).toHaveBeenLastCalledWith("settings_get", {});

    invoke.mockResolvedValueOnce({ overrides: {} });
    expect(await bridge.request.settingsResetShortcuts({})).toEqual({ overrides: {} });
    expect(invoke).toHaveBeenLastCalledWith("settings_reset_shortcuts", {});
  });

  it("remaps permissionRequest's reserved-word type param onto permissionType", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ result: "opened" });
    expect(await bridge.request.permissionRequest({ type: "accessibility" })).toEqual({ result: "opened" });
    expect(invoke).toHaveBeenLastCalledWith("permission_request", { permissionType: "accessibility" });

    invoke.mockResolvedValueOnce({ result: "unavailable" });
    expect(await bridge.request.permissionRequest({ type: "folders" })).toEqual({ result: "unavailable" });
    expect(invoke).toHaveBeenLastCalledWith("permission_request", { permissionType: "folders" });
  });

  it("routes settingsSetShortcut and the file/clipboard read-save pair verbatim", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ overrides: { commandPalette: ["⌥", "P"] } });
    expect(await bridge.request.settingsSetShortcut({ id: "commandPalette", keys: ["⌥", "P"] })).toEqual({
      overrides: { commandPalette: ["⌥", "P"] },
    });
    expect(invoke).toHaveBeenLastCalledWith("settings_set_shortcut", {
      id: "commandPalette",
      keys: ["⌥", "P"],
    });

    invoke.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,AAA", bytes: 3 });
    expect(await bridge.request.imageFileRead({ workspaceId: "ws_1", relPath: "pic.png" })).toEqual({
      dataUrl: "data:image/png;base64,AAA",
      bytes: 3,
    });
    expect(invoke).toHaveBeenLastCalledWith("image_file_read", {
      workspaceId: "ws_1",
      relPath: "pic.png",
    });

    invoke.mockResolvedValueOnce({ path: "/data/attachments/1-pasted-file" });
    expect(await bridge.request.clipboardFileSave({ name: "pasted-file", dataBase64: "AAA" })).toEqual({
      path: "/data/attachments/1-pasted-file",
    });
    expect(invoke).toHaveBeenLastCalledWith("clipboard_file_save", {
      name: "pasted-file",
      dataBase64: "AAA",
    });
  });
});

describe("git panel routing (M4 T3)", () => {
  it("routes gitStatus with the session-scoped passthrough", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const changes = [
      {
        path: "src/main.rs",
        status: "modified" as const,
        staged: false,
        additions: 3,
        deletions: 1,
      },
    ];
    invoke.mockResolvedValueOnce(changes);
    const params = { workspaceId: "ws_1", sessionId: "s_wt" };
    expect(await bridge.request.gitStatus(params)).toEqual(changes);
    expect(invoke).toHaveBeenLastCalledWith("git_status", params);

    invoke.mockResolvedValueOnce([]);
    expect(await bridge.request.gitStatus({ workspaceId: "ws_ghost" })).toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith("git_status", { workspaceId: "ws_ghost" });
  });

  it("routes gitBulk with the op + opts shape", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ ok: true });
    expect(
      await bridge.request.gitBulk({ workspaceId: "ws_1", op: "stash", opts: { message: "wip" } }),
    ).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("git_bulk", {
      workspaceId: "ws_1",
      op: "stash",
      opts: { message: "wip" },
    });

    invoke.mockResolvedValueOnce({ ok: false, error: "no workspace" });
    expect(await bridge.request.gitBulk({ workspaceId: "ws_x", op: "stage-all" })).toEqual({
      ok: false,
      error: "no workspace",
    });
    expect(invoke).toHaveBeenLastCalledWith("git_bulk", {
      workspaceId: "ws_x",
      op: "stage-all",
    });
  });

  it("routes gitLog with the limit arg and gitDiff with contextLines", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    const commits = [
      {
        sha: "1cd734e",
        author: "Ann",
        date: "2026-08-27T09:41:00+02:00",
        subject: "feat: thing",
        parents: ["0da9f21"],
        isHead: true,
        branchHeads: ["main"],
      },
    ];
    invoke.mockResolvedValueOnce(commits);
    expect(await bridge.request.gitLog({ workspaceId: "ws_1", limit: 50 })).toEqual(commits);
    expect(invoke).toHaveBeenLastCalledWith("git_log", { workspaceId: "ws_1", limit: 50 });

    const hunks = [
      {
        header: "@@ -1,3 +1,4 @@ fn main",
        lines: [
          { type: "context" as const, oldNo: 1, newNo: 1, text: " fn main() {" },
          { type: "add" as const, newNo: 2, text: "+    todo();" },
        ],
      },
    ];
    invoke.mockResolvedValueOnce(hunks);
    const diffParams = {
      workspaceId: "ws_1",
      filePath: "src/main.rs",
      staged: false,
      contextLines: 24,
    };
    expect(await bridge.request.gitDiff(diffParams)).toEqual(hunks);
    expect(invoke).toHaveBeenLastCalledWith("git_diff", diffParams);
  });

  it("routes the op-result family and the diff/text readers", async () => {
    const bridge = await installBridge();
    invoke.mockReset();

    invoke.mockResolvedValueOnce({ ok: true, sha: "b31f0c9" });
    expect(
      await bridge.request.gitCommit({ workspaceId: "ws_1", message: "feat: x" }),
    ).toEqual({ ok: true, sha: "b31f0c9" });
    expect(invoke).toHaveBeenLastCalledWith("git_commit", {
      workspaceId: "ws_1",
      message: "feat: x",
    });

    invoke.mockResolvedValueOnce({ ok: false, error: "conflict" });
    expect(
      await bridge.request.gitMergeBranch({ workspaceId: "ws_1", name: "feature" }),
    ).toEqual({ ok: false, error: "conflict" });
    expect(invoke).toHaveBeenLastCalledWith("git_merge_branch", {
      workspaceId: "ws_1",
      name: "feature",
    });

    invoke.mockResolvedValueOnce({ ok: true, newSha: "aa19c22" });
    expect(await bridge.request.gitRevert({ workspaceId: "ws_1", sha: "1cd734e" })).toEqual({
      ok: true,
      newSha: "aa19c22",
    });
    expect(invoke).toHaveBeenLastCalledWith("git_revert", { workspaceId: "ws_1", sha: "1cd734e" });

    invoke.mockResolvedValueOnce({ text: "diff --git a/x b/x" });
    expect(await bridge.request.gitStagedDiff({ workspaceId: "ws_1" })).toEqual({
      text: "diff --git a/x b/x",
    });
    expect(invoke).toHaveBeenLastCalledWith("git_staged_diff", { workspaceId: "ws_1" });

    invoke.mockResolvedValueOnce([{ ref: "stash@{0}", message: "On main: wip" }]);
    expect(await bridge.request.gitStashList({ workspaceId: "ws_1" })).toEqual([
      { ref: "stash@{0}", message: "On main: wip" },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("git_stash_list", { workspaceId: "ws_1" });

    invoke.mockResolvedValueOnce({ ok: true });
    expect(
      await bridge.request.gitResolveFile({
        workspaceId: "ws_1",
        filePath: "src/both.rs",
        side: "theirs",
      }),
    ).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("git_resolve_file", {
      workspaceId: "ws_1",
      filePath: "src/both.rs",
      side: "theirs",
    });

    invoke.mockResolvedValueOnce({ branch: "main", headCommit: "1cd734e", fileCount: 12, isRepo: true });
    expect(await bridge.request.gitRepoDetect({ dirPath: "/repo/tide" })).toEqual({
      branch: "main",
      headCommit: "1cd734e",
      fileCount: 12,
      isRepo: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("git_repo_detect", { dirPath: "/repo/tide" });
  });
});
