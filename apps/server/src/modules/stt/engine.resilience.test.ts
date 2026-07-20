import type { ServerLiveEvent } from "@nova/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sttConfigSchema, type SttConfigInput } from "./config.js";
import { createSttEngine } from "./engine.js";
import {
  SttTransientError,
  type SttEmit,
  type SttSessionInfo,
} from "./ports.js";
import {
  MockVendor,
  type MockConnectionScript,
} from "./testing/mock-vendor.js";

/**
 * RED behavior suite (resilience: failover / reconnect / silence). Fails on the
 * engine stub today; Task 4 turns it green. Observable-only assertions: which
 * vendor connections got frames, what `emit` saw. The client socket must NEVER
 * see an error or gap for a transparent reconnect/failover — only a single
 * `provider_switched` on an actual vendor switch (design doc §modules/stt).
 */

const INFO: SttSessionInfo = { sessionId: "sess-A", sampleRateHz: 16000 };

const cfg = (overrides: SttConfigInput = {}): ReturnType<typeof sttConfigSchema.parse> =>
  sttConfigSchema.parse(overrides);

function capture(): { emit: SttEmit; events: ServerLiveEvent[] } {
  const events: ServerLiveEvent[] = [];
  const emit: SttEmit = (event) => {
    events.push(event);
  };
  return { emit, events };
}

/** N failing connect scripts (transient) for a vendor's reconnect ladder. */
function failing(n: number): MockConnectionScript[] {
  return Array.from({ length: n }, () => ({
    connectError: new SttTransientError("vendor unreachable"),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("STT engine — failover", () => {
  it("[failover] switches to fallback after failoverThreshold primary failures: exactly one provider_switched, no client error, frames keep relaying", async () => {
    // One spare script beyond the threshold so an over-eager retry surfaces as a
    // clean connectAttempts assertion failure, not a "no script" crash.
    const primary = new MockVendor({ id: "assemblyai", connections: failing(3) });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: [{ events: [], terminal: "hang" }],
    });
    const engine = createSttEngine(
      cfg({ failoverThreshold: 2, reconnectBackoffMs: [0], connectTimeoutMs: 1000 }),
      [primary, fallback],
    );
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(5000);

    expect(primary.connectAttempts).toBe(2); // exactly failoverThreshold, then switch
    expect(events.filter((e) => e.type === "provider_switched")).toEqual([
      { v: 1, type: "provider_switched", from: "assemblyai", to: "deepgram" },
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);

    const frame = Buffer.from([7, 7]);
    handle.onAudioFrame(frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback.connections[0]?.framesReceived).toContainEqual(frame);
    handle.stop();
  });
});

describe("STT engine — reconnect", () => {
  it("[reconnect] reconnects the SAME vendor on mid-stream death with backoff; client sees no error/switch; buffered frames delivered", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        // conn 1 dies 10ms in (socket close mid-stream)
        { events: [{ afterMs: 10, event: { type: "closed" } }], terminal: "close" },
        // conn 2 after the backoff-delayed reconnect
        { events: [], terminal: "hang" },
      ],
    });
    const engine = createSttEngine(
      cfg({ reconnectBackoffMs: [250], maxReconnects: 5 }),
      [primary],
    );
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10); // conn 1 dies

    // A frame arriving during the reconnect backoff is held in the bounded buffer
    // and flushed to the new connection once it opens (documented policy: config
    // `reconnectBufferFrames`, drop-oldest on overflow).
    const buffered = Buffer.from([9]);
    handle.onAudioFrame(buffered);
    await vi.advanceTimersByTimeAsync(250); // backoff elapses, conn 2 opens

    expect(primary.connectAttempts).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "provider_switched")).toBe(false);
    expect(primary.connections[1]?.framesReceived).toContainEqual(buffered);
    handle.stop();
  });

  it("[reconnect-exhaust] fails over to the fallback vendor once a vendor's maxReconnects is exhausted", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        // established, then dies; every subsequent reconnect fails
        { events: [{ afterMs: 10, event: { type: "closed" } }], terminal: "close" },
        ...failing(6),
      ],
    });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: [{ events: [], terminal: "hang" }],
    });
    const engine = createSttEngine(
      cfg({ maxReconnects: 2, reconnectBackoffMs: [0], connectTimeoutMs: 500 }),
      [primary, fallback],
    );
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(10000);

    expect(events.filter((e) => e.type === "provider_switched")).toEqual([
      { v: 1, type: "provider_switched", from: "assemblyai", to: "deepgram" },
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(fallback.connectAttempts).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it("[reconnect-exhaust] emits a single typed error and stops when EVERY vendor is exhausted (never hangs)", async () => {
    const primary = new MockVendor({ id: "assemblyai", connections: failing(8) });
    const fallback = new MockVendor({ id: "deepgram", connections: failing(8) });
    const engine = createSttEngine(
      cfg({
        maxReconnects: 2,
        failoverThreshold: 2,
        reconnectBackoffMs: [0],
        connectTimeoutMs: 200,
      }),
      [primary, fallback],
    );
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(20000);

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ v: 1, type: "error", code: "internal" });
    // Engine already stopped itself; an explicit stop must remain a safe no-op.
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });
});

describe("STT engine — silence", () => {
  it("[silence] treats a connection silent past vendorSilenceTimeoutMs (while audio flows) as dead and reconnects", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        { events: [], terminal: "hang" }, // conn 1: connects then stays silent
        { events: [], terminal: "hang" }, // conn 2: after silence-triggered reconnect
      ],
    });
    const engine = createSttEngine(
      cfg({ vendorSilenceTimeoutMs: 30000, reconnectBackoffMs: [0] }),
      [primary],
    );
    const { emit, events } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(0);

    // Keep audio flowing while the vendor emits nothing; cross the silence window.
    for (let i = 0; i < 7; i += 1) {
      handle.onAudioFrame(Buffer.from([i]));
      await vi.advanceTimersByTimeAsync(5000);
    }

    expect(primary.connectAttempts).toBe(2); // silence detected → reconnect
    expect(events.some((e) => e.type === "error")).toBe(false);
    handle.stop();
  });
});
