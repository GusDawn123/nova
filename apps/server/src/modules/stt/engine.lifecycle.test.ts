import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerLiveEvent } from "@nova/shared";

import { sttConfigSchema, type SttConfigInput } from "./config.js";
import { createSttEngine } from "./engine.js";
import type { SttEmit, SttSessionInfo } from "./ports.js";
import { MockVendor } from "./testing/mock-vendor.js";

/**
 * RED behavior suite (lifecycle: isolation + stop). Fails on the engine stub;
 * Task 4 turns it green. Observable-only assertions.
 */

const cfg = (
  overrides: SttConfigInput = {},
): ReturnType<typeof sttConfigSchema.parse> => sttConfigSchema.parse(overrides);

function capture(): { emit: SttEmit; events: ServerLiveEvent[] } {
  const events: ServerLiveEvent[] = [];
  const emit: SttEmit = (event) => {
    events.push(event);
  };
  return { emit, events };
}

const infoFor = (sessionId: string): SttSessionInfo => ({
  sessionId,
  sampleRateHz: 16000,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("STT engine — session isolation", () => {
  it("[isolation] keeps two concurrent sessions' frames and transcripts fully separate", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 10,
              event: { type: "final", text: "from-A", speaker: null, ts_ms: 1 },
            },
          ],
          terminal: "hang",
        },
        {
          events: [
            {
              afterMs: 10,
              event: { type: "final", text: "from-B", speaker: null, ts_ms: 2 },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    const engine = createSttEngine(cfg(), [vendor]);
    const a = capture();
    const b = capture();

    const handleA = engine.startSession(infoFor("sess-A"), a.emit);
    const handleB = engine.startSession(infoFor("sess-B"), b.emit);
    await vi.advanceTimersByTimeAsync(0);

    const frameA = Buffer.from([0xaa]);
    const frameB = Buffer.from([0xbb]);
    handleA.onAudioFrame(frameA);
    handleB.onAudioFrame(frameB);
    await vi.advanceTimersByTimeAsync(20);

    // Each of the two vendor connections received exactly ONE frame, and the two
    // frames are split across them with zero cross-contamination.
    const c0 = vendor.connections[0]?.framesReceived ?? [];
    const c1 = vendor.connections[1]?.framesReceived ?? [];
    expect(c0).toHaveLength(1);
    expect(c1).toHaveLength(1);
    expect(new Set([...c0, ...c1])).toEqual(new Set([frameA, frameB]));

    // Each emit saw only its own session's transcript.
    expect(
      a.events.some(
        (e) => e.type === "transcript.final" && e.text === "from-A",
      ),
    ).toBe(true);
    expect(
      a.events.some(
        (e) => e.type === "transcript.final" && e.text === "from-B",
      ),
    ).toBe(false);
    expect(
      b.events.some(
        (e) => e.type === "transcript.final" && e.text === "from-B",
      ),
    ).toBe(true);
    expect(
      b.events.some(
        (e) => e.type === "transcript.final" && e.text === "from-A",
      ),
    ).toBe(false);

    handleA.stop();
    handleB.stop();
  });
});

describe("STT engine — stop", () => {
  it("[stop] ends the vendor connection, emits nothing afterward, and is idempotent", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 100,
              event: { type: "final", text: "late", speaker: null, ts_ms: 1 },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    const engine = createSttEngine(cfg(), [primary]);
    const { emit, events } = capture();

    const handle = engine.startSession(infoFor("sess-A"), emit);
    await vi.advanceTimersByTimeAsync(0);

    handle.stop();
    expect(primary.connections[0]?.isClosed).toBe(true);

    const countAtStop = events.length;
    // The scripted "late" final would have fired at 100ms — it must not, since the
    // session stopped first (no emits after stop).
    await vi.advanceTimersByTimeAsync(500);
    expect(events.length).toBe(countAtStop);

    expect(() => {
      handle.stop();
    }).not.toThrow();
  });
});

describe("STT engine — channel capability filter", () => {
  it("[channels] refuses a stereo session when no vendor can attribute both channels", async () => {
    // A vendor with no declared maxChannels is mono-only. Feeding it stereo
    // would transcribe garbled audio, so the engine must exclude it and take
    // the exhaustion path instead: one typed error, no vendor connect.
    const monoOnly = new MockVendor({
      id: "assemblyai",
      connections: [{ events: [], terminal: "hang" }],
    });
    const engine = createSttEngine(cfg(), [monoOnly]);
    const { emit, events } = capture();

    engine.startSession(
      { sessionId: "sess-2ch", sampleRateHz: 16000, channels: 2 },
      emit,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "internal" }),
    ]);
    expect(monoOnly.connectCalls).toHaveLength(0);
  });

  it("[channels] admits a vendor that declares stereo support", async () => {
    const inner = new MockVendor({
      id: "deepgram",
      connections: [
        {
          events: [
            {
              afterMs: 10,
              event: {
                type: "final",
                text: "stereo hello",
                speaker: "me",
                ts_ms: 1,
              },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    const stereoCapable = {
      id: inner.id,
      maxChannels: 2,
      connect: inner.connect.bind(inner),
    };
    const engine = createSttEngine(cfg(), [stereoCapable]);
    const { emit, events } = capture();

    const handle = engine.startSession(
      { sessionId: "sess-2ch", sampleRateHz: 16000, channels: 2 },
      emit,
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.final",
        text: "stereo hello",
        speaker: "me",
      }),
    );
    handle.stop();
  });
});
