import { describe, expect, it, vi } from "vitest";

import type { AudioEngine } from "./audio-engine";

/**
 * The module-level cache is the point of half these tests, so each one imports
 * a FRESH copy of the module (vi.resetModules) instead of sharing the suite's.
 */
async function freshModule(): Promise<typeof import("./audio-engine")> {
  vi.resetModules();
  return import("./audio-engine");
}

function fakeEngine(): AudioEngine {
  return {
    start() {
      /* never driven here */
    },
    stop: () => ({ droppedBatches: 0 }),
  };
}

describe("loadAudioEngine", () => {
  it("caches the first result and hands every caller the SAME instance", async () => {
    const { loadAudioEngine } = await freshModule();
    const engine = fakeEngine();
    let calls = 0;
    const first = loadAudioEngine(() => {
      calls += 1;
      return engine;
    });
    // finish() in session.ts loads a second time to STOP the engine — that
    // teardown is only correct because the same instance comes back.
    const second = loadAudioEngine(() => {
      calls += 1;
      return {};
    });
    expect(calls).toBe(1);
    expect(first).toEqual({ ok: true, engine });
    expect(second).toBe(first);
  });

  it("rejects an addon that loads but has the wrong shape", async () => {
    const { loadAudioEngine } = await freshModule();
    const result = loadAudioEngine(() => ({ start: "not a function" }));
    expect(result).toEqual({
      ok: false,
      message: "The audio addon loaded but has the wrong shape.",
    });
  });

  it("maps a loader throw to a typed failure carrying build instructions", async () => {
    const { loadAudioEngine } = await freshModule();
    const result = loadAudioEngine(() => {
      throw new Error("Cannot find module");
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("Cannot find module");
    expect(result.message).toContain("npm run build:native");
  });
});
