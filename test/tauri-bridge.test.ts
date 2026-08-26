import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

type BridgeGlobal = { request: Record<string, (params?: unknown) => Promise<unknown>> };

function globals(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function installedBridge(): BridgeGlobal {
  const bridge = globals().__TIDE_BRIDGE__;
  if (!bridge) throw new Error("bridge not installed");
  return bridge as BridgeGlobal;
}

/** The suite runs in node — rpc.ts and the installer address `window`, so
 *  point it at globalThis and give every test a fresh module registry (the
 *  `rpc`/`hasRpc` live bindings re-bind to null on re-eval). */
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal("window", globalThis);
  delete globals().__TAURI_INTERNALS__;
  delete globals().__TIDE_BRIDGE__;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globals().__TAURI_INTERNALS__;
  delete globals().__TIDE_BRIDGE__;
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
    globals().__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce({ version: "0.4.0", protocol: 1 });

    const { installTauriBridge } = await import("@/lib/api/tauri-bridge");
    expect(await installTauriBridge()).toBe(true);

    const bridge = installedBridge();
    const pending = bridge.request.gitStatus({ workspaceId: "ws_1" });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(/not ported/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("flips the live rpc binding when the bridge installs after import (ordering regression)", async () => {
    globals().__TAURI_INTERNALS__ = {};
    invoke
      .mockResolvedValueOnce({ version: "0.4.0", protocol: 1 })
      .mockResolvedValueOnce([]);

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
