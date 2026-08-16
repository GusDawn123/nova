import { describe, expect, it, vi } from "vitest";

import { INVALID_BRIDGE_RESPONSE_MESSAGE } from "../main/ipc/contract";
import type { NovaBridge } from "./index";

/**
 * The preload's job is parse-or-fallback: every `invoke` answer crosses a zod
 * boundary, and an answer that fails it must degrade to the same typed failure
 * the renderer already handles — never a throw, never a guessed value. These
 * tests drive the live-session methods through that boundary.
 */
const h = vi.hoisted(() => {
  const exposed: { bridge?: unknown } = {};
  return { invoke: vi.fn(), exposed };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: unknown) => {
      h.exposed.bridge = bridge;
    },
  },
  ipcRenderer: {
    invoke: h.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));

await import("./index");
// Cast because the bridge crosses exposeInMainWorld as `unknown` — this file
// imports the NovaBridge type from the very module that built the object.
const bridge = h.exposed.bridge as NovaBridge;

describe("the live-session bridge methods", () => {
  it("startLiveSession passes a valid result through", async () => {
    h.invoke.mockResolvedValueOnce({ ok: true });
    await expect(bridge.startLiveSession("general")).resolves.toEqual({
      ok: true,
    });
  });

  it("startLiveSession falls back typed on an off-contract answer", async () => {
    h.invoke.mockResolvedValueOnce({ nonsense: true });
    await expect(bridge.startLiveSession("general")).resolves.toEqual({
      ok: false,
      message: INVALID_BRIDGE_RESPONSE_MESSAGE,
    });
  });

  it("stopLiveSession falls back typed on an off-contract answer", async () => {
    h.invoke.mockResolvedValueOnce(undefined);
    await expect(bridge.stopLiveSession()).resolves.toEqual({
      ok: false,
      message: INVALID_BRIDGE_RESPONSE_MESSAGE,
    });
  });

  it("a REJECTED invoke degrades to the same typed fallback (never a throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.invoke.mockRejectedValueOnce(new Error("main handler threw"));
    await expect(bridge.startLiveSession("general")).resolves.toEqual({
      ok: false,
      message: INVALID_BRIDGE_RESPONSE_MESSAGE,
    });
  });
});
