import { afterEach, describe, expect, it, vi } from "vitest";

import { IpcChannel } from "../main/ipc/channels";
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
  const channelListeners = new Map<
    string,
    (event: unknown, raw: unknown) => void
  >();
  return { invoke: vi.fn(), exposed, channelListeners };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: unknown) => {
      h.exposed.bridge = bridge;
    },
  },
  ipcRenderer: {
    invoke: h.invoke,
    on: (channel: string, listener: (event: unknown, raw: unknown) => void) => {
      h.channelListeners.set(channel, listener);
    },
    // Reference-checked like the real ipcRenderer: unsubscribing with the
    // wrong function must leave the original listener attached.
    removeListener: (
      channel: string,
      listener: (event: unknown, raw: unknown) => void,
    ) => {
      if (h.channelListeners.get(channel) === listener) {
        h.channelListeners.delete(channel);
      }
    },
    send: vi.fn(),
  },
}));

await import("./index");
// Cast because the bridge crosses exposeInMainWorld as `unknown` — this file
// imports the NovaBridge type from the very module that built the object.
const bridge = h.exposed.bridge as NovaBridge;

afterEach(() => {
  // console.error spies must not outlive their test and eat diagnostics.
  vi.restoreAllMocks();
});

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

  it("askLive sends the payload and passes a valid result through", async () => {
    h.invoke.mockResolvedValueOnce({ ok: true });
    await expect(bridge.askLive("how do I price this?")).resolves.toEqual({
      ok: true,
    });
    expect(h.invoke).toHaveBeenLastCalledWith(IpcChannel.liveAsk, {
      text: "how do I price this?",
    });

    h.invoke.mockResolvedValueOnce({ ok: true });
    await expect(bridge.askLive(null)).resolves.toEqual({ ok: true });
    expect(h.invoke).toHaveBeenLastCalledWith(IpcChannel.liveAsk, {
      text: null,
    });
  });

  it("askLive falls back typed on an off-contract answer", async () => {
    h.invoke.mockResolvedValueOnce({ nonsense: true });
    await expect(bridge.askLive(null)).resolves.toEqual({
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

describe("onLiveEvent", () => {
  it("forwards valid events, logs + suppresses malformed ones, unsubscribes", () => {
    const received: unknown[] = [];
    const unsubscribe = bridge.onLiveEvent((event) => received.push(event));
    const forward = h.channelListeners.get(IpcChannel.liveEvent);
    if (forward === undefined) throw new Error("no live listener registered");

    forward({}, { kind: "status", state: "live" });
    expect(received).toEqual([{ kind: "status", state: "live" }]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    forward({}, { kind: "transcript", text: 7 });
    // Suppressed but never silent: an off-contract event here means the
    // preload and main bundles disagree about the schema.
    expect(received).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();

    unsubscribe();
    expect(h.channelListeners.has(IpcChannel.liveEvent)).toBe(false);
  });
});
