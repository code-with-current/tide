import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({ version: "0.4.0", os: "macos", arch: "arm64" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

describe("getRuntimeInfo", () => {
  beforeEach(() => {
    invoke.mockClear();
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("returns null outside Tauri", async () => {
    const { getRuntimeInfo } = await import("@/lib/api/rpc");
    expect(await getRuntimeInfo()).toBeNull();
  });

  it("invokes tide_ping once inside Tauri and caches", async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { getRuntimeInfo } = await import("@/lib/api/rpc");
    expect(await getRuntimeInfo()).toMatchObject({ version: "0.4.0" });
    expect(await getRuntimeInfo()).toMatchObject({ version: "0.4.0" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
