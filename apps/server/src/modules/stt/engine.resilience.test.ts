import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerLiveEvent } from "@nova/shared";

import { sttConfigSchema, type SttConfigInput } from "./config.js";
import { createSttEngine } from "./engine.js";
import {
  SttAuthError,
  SttTransientError,
  type SttEmit,
  type SttLogger,
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
    const primary = new MockVendor({
      id: "assemblyai",
      connections: failing(3),
    });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: [{ events: [], terminal: "hang" }],
    });
    const engine = createSttEngine(
      cfg({
        failoverThreshold: 2,
        reconnectBackoffMs: [0],
        connectTimeoutMs: 1000,
      }),
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
        {
          events: [{ afterMs: 10, event: { type: "closed" } }],
          terminal: "close",
        },
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
        {
          events: [{ afterMs: 10, event: { type: "closed" } }],
          terminal: "close",
        },
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
    const primary = new MockVendor({
      id: "assemblyai",
      connections: failing(8),
    });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: failing(8),
    });
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

describe("STT engine — failure logging", () => {
  // The 2026-08-16 live repro: "all STT vendors exhausted" reached the client
  // while the server log stayed blank on why. Every failure seam must now say
  // what happened — with ids, kinds, and error messages ONLY (RULES §6).
  function fakeLogger(): {
    logger: SttLogger;
    lines: Array<{ msg: string; fields: Record<string, unknown> }>;
  } {
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    return {
      logger: {
        warn: (fields, msg) => {
          lines.push({ msg, fields });
        },
      },
      lines,
    };
  }

  it("[logging] connect failures, benching, and exhaustion land in the log with vendor + reason", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: failing(8),
    });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: failing(8),
    });
    const { logger, lines } = fakeLogger();
    const engine = createSttEngine(
      cfg({
        maxReconnects: 2,
        failoverThreshold: 2,
        reconnectBackoffMs: [0],
        connectTimeoutMs: 200,
      }),
      [primary, fallback],
      logger,
    );
    const { emit } = capture();

    engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(20000);

    const connectFails = lines.filter((l) => l.msg === "stt.connect_failed");
    expect(connectFails.length).toBeGreaterThanOrEqual(4); // both vendors' attempts
    expect(connectFails[0]?.fields).toMatchObject({
      session_id: "sess-A",
      vendor: "assemblyai",
      kind: "transient",
      error: "vendor unreachable",
    });
    expect(
      lines
        .filter((l) => l.msg === "stt.vendor_benched")
        .map((l) => l.fields["vendor"]),
    ).toEqual(["assemblyai", "deepgram"]);
    const exhausted = lines.filter((l) => l.msg === "stt.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.fields["vendors"]).toEqual(["assemblyai", "deepgram"]);
  });

  it("[logging] a mid-stream vendor error logs its kind and message; the stream's death logs its reason", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 10,
              event: {
                type: "error",
                error: new SttAuthError("credentials rejected"),
              },
            },
          ],
          terminal: "close",
        },
      ],
    });
    const fallback = new MockVendor({
      id: "deepgram",
      connections: [{ events: [], terminal: "hang" }],
    });
    const { logger, lines } = fakeLogger();
    const engine = createSttEngine(
      cfg({ reconnectBackoffMs: [0] }),
      [primary, fallback],
      logger,
    );
    const { emit } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(1000);

    expect(
      lines.find((l) => l.msg === "stt.vendor_error")?.fields,
    ).toMatchObject({
      vendor: "assemblyai",
      kind: "auth",
      error: "credentials rejected",
    });
    expect(
      lines.find((l) => l.msg === "stt.stream_ended")?.fields,
    ).toMatchObject({ vendor: "assemblyai", reason: "auth" });
    handle.stop();
  });

  it("[logging] a silence abort says so before the reconnect", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        { events: [], terminal: "hang" },
        { events: [], terminal: "hang" },
      ],
    });
    const { logger, lines } = fakeLogger();
    const engine = createSttEngine(
      cfg({ vendorSilenceTimeoutMs: 30000, reconnectBackoffMs: [0] }),
      [primary],
      logger,
    );
    const { emit } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 7; i += 1) {
      handle.onAudioFrame(Buffer.from([i]));
      await vi.advanceTimersByTimeAsync(5000);
    }

    const silenceAbortIndex = lines.findIndex(
      (l) => l.msg === "stt.silence_abort",
    );
    const streamEndedIndex = lines.findIndex(
      (l) => l.msg === "stt.stream_ended",
    );
    expect(lines[silenceAbortIndex]?.fields).toMatchObject({
      session_id: "sess-A",
      timeout_ms: 30000,
    });
    // The abort log is the CAUSE line; it must precede the death it triggers.
    expect(silenceAbortIndex).toBeLessThan(streamEndedIndex);
    expect(lines[streamEndedIndex]?.fields).toMatchObject({
      vendor: "assemblyai",
      reason: "died",
    });
    handle.stop();
  });

  it("[logging] an unbounded vendor error message is capped, never dumped whole", async () => {
    const blob = "x".repeat(5000);
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 5,
              event: { type: "error", error: new SttTransientError(blob) },
            },
          ],
          terminal: "close",
        },
        { events: [], terminal: "hang" },
      ],
    });
    const { logger, lines } = fakeLogger();
    const engine = createSttEngine(
      cfg({ reconnectBackoffMs: [0] }),
      [primary],
      logger,
    );
    const { emit } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(1000);

    const logged = lines.find((l) => l.msg === "stt.vendor_error")?.fields[
      "error"
    ];
    expect(logged).toBe(`${"x".repeat(199)}…`); // exactly the cap, prefix kept
    handle.stop();
  });

  it("[logging] transcript content never reaches the log", async () => {
    const primary = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            {
              afterMs: 5,
              event: {
                type: "partial",
                text: "the confidential words",
                speaker: "them",
                ts_ms: 1,
              },
            },
            { afterMs: 5, event: { type: "closed" } },
          ],
          terminal: "close",
        },
        { events: [], terminal: "hang" },
      ],
    });
    const { logger, lines } = fakeLogger();
    const engine = createSttEngine(
      cfg({ reconnectBackoffMs: [0] }),
      [primary],
      logger,
    );
    const { emit } = capture();

    const handle = engine.startSession(INFO, emit);
    await vi.advanceTimersByTimeAsync(1000);

    expect(lines.length).toBeGreaterThan(0); // the death itself was logged
    expect(JSON.stringify(lines)).not.toContain("the confidential words");
    handle.stop();
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
