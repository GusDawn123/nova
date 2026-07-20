import type { ServerLiveEvent } from "@nova/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sttConfigSchema, type SttConfigInput } from "./config.js";
import { createSttEngine } from "./engine.js";
import type { SttEmit, SttSessionInfo } from "./ports.js";
import { MockVendor } from "./testing/mock-vendor.js";

/**
 * RED behavior suite (transcript relay) — written against the engine PORT while
 * the engine itself is a not-implemented stub. Each test fails on the stub's
 * thrown "not implemented"; Task 4 turns them green. Assertions are on OBSERVABLE
 * behavior only (frames the mock vendor recorded, events `emit` received) — never
 * on engine internals. Fake timers throughout; zero real waiting.
 */

const INFO: SttSessionInfo = { sessionId: "sess-A", sampleRateHz: 16000 };

const cfg = (overrides: SttConfigInput = {}): ReturnType<typeof sttConfigSchema.parse> =>
  sttConfigSchema.parse(overrides);

/** A capturing emit whose received events the test asserts against. */
function capture(): { emit: SttEmit; events: ServerLiveEvent[] } {
  const events: ServerLiveEvent[] = [];
  const emit: SttEmit = (event) => {
    events.push(event);
  };
  return { emit, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("STT engine — transcript relay", () => {
  it("[relay] relays frames from onAudioFrame to the active vendor connection's sendAudio", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [{ events: [], terminal: "hang" }],
    });
    const engine = createSttEngine(cfg(), [vendor]);
    const { emit } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(0); // let the pre-warmed connect settle

    const f1 = Buffer.from([1, 2]);
    const f2 = Buffer.from([3, 4]);
    handle.onAudioFrame(f1);
    handle.onAudioFrame(f2);
    await vi.advanceTimersByTimeAsync(0);

    expect(vendor.connections).toHaveLength(1);
    expect(vendor.connections[0]?.framesReceived).toEqual([f1, f2]);
    handle.stop();
  });

  it("[interim] emits transcript.partial DURING the stream, before any final", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 50,
              event: { type: "partial", text: "hel", speaker: null, ts_ms: 100 },
            },
            {
              afterMs: 50,
              event: {
                type: "partial",
                text: "hello",
                speaker: null,
                ts_ms: 150,
              },
            },
            {
              afterMs: 50,
              event: {
                type: "final",
                text: "hello there",
                speaker: "spk_0",
                ts_ms: 200,
              },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    const engine = createSttEngine(cfg(), [vendor]);
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(0);

    // Advance only far enough for the first partial: a partial is visible and no
    // final has been emitted yet (interims stream ahead of the committed result).
    await vi.advanceTimersByTimeAsync(50);
    expect(events.filter((e) => e.type === "transcript.partial").length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "transcript.final")).toBe(false);
    handle.stop();
  });

  it("[final] emits transcript.final preserving speaker and ts_ms", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 10,
              event: {
                type: "final",
                text: "the deal closes friday",
                speaker: "spk_1",
                ts_ms: 4321,
              },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    const engine = createSttEngine(cfg(), [vendor]);
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(20);

    expect(events).toContainEqual({
      v: 1,
      type: "transcript.final",
      text: "the deal closes friday",
      speaker: "spk_1",
      ts_ms: 4321,
      is_final: true,
    });
    handle.stop();
  });
});
