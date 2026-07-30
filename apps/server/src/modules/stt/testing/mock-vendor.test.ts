import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SttAuthError,
  type SttSessionInfo,
  type SttVendorEvent,
} from "../ports.js";
import { MockVendor } from "./mock-vendor.js";

/**
 * The harness is the foundation the whole behavior suite stands on — if it can't
 * faithfully simulate each failure mode on fake timers, every RED test below is
 * meaningless. These unit tests prove it can: connect delay/failure, ordered event
 * emission, mid-stream death, silence, frame recording, and multi-connection /
 * multi-vendor independence.
 */

const INFO: SttSessionInfo = { sessionId: "session-a", sampleRateHz: 16000 };

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Wrap a promise so a test can ask whether it has settled after flushing timers. */
function track<T>(promise: Promise<T>): {
  settled: () => boolean;
  value: Promise<T>;
} {
  let done = false;
  const value = promise.then(
    (v) => {
      done = true;
      return v;
    },
    (e: unknown) => {
      done = true;
      throw e;
    },
  );
  return { settled: () => done, value };
}

/** Drain a connection whose stream is expected to COMPLETE (terminal close). */
async function drain(
  events: AsyncIterable<SttVendorEvent>,
): Promise<SttVendorEvent[]> {
  const out: SttVendorEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("MockVendor connect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a connection synchronously when no connect delay is scripted", async () => {
    const vendor = new MockVendor({ id: "v1", connections: [{}] });

    const conn = await vendor.connect(INFO, signal());

    expect(conn).toBeDefined();
    expect(vendor.connectAttempts).toBe(1);
    expect(vendor.connectCalls).toEqual([INFO]);
  });

  it("delays connect by connectDelayMs on the fake clock", async () => {
    const vendor = new MockVendor({
      id: "v1",
      connections: [{ connectDelayMs: 3000 }],
    });

    const pending = track(vendor.connect(INFO, signal()));
    await vi.advanceTimersByTimeAsync(2999);
    expect(pending.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled()).toBe(true);
    await pending.value;
  });

  it("rejects connect with the scripted typed error", async () => {
    const authError = new SttAuthError("bad key");
    const vendor = new MockVendor({
      id: "v1",
      connections: [{ connectError: authError }],
    });

    await expect(vendor.connect(INFO, signal())).rejects.toBe(authError);
  });

  it("throws no-script when connect is called more often than scripted", async () => {
    const vendor = new MockVendor({ id: "v1", connections: [{}] });
    await vendor.connect(INFO, signal());

    await expect(vendor.connect(INFO, signal())).rejects.toThrow(/no script/);
  });

  it("rejects connect when the abort signal is already aborted", async () => {
    const vendor = new MockVendor({
      id: "v1",
      connections: [{ connectDelayMs: 1000 }],
    });

    await expect(vendor.connect(INFO, AbortSignal.abort())).rejects.toThrow(
      /abort/,
    );
  });
});

describe("MockVendorConnection event playback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records every frame handed to sendAudio, in order", async () => {
    const vendor = new MockVendor({ id: "v1", connections: [{}] });
    const conn = await vendor.connect(INFO, signal());

    const a = Buffer.from([1]);
    const b = Buffer.from([2, 2]);
    conn.sendAudio(a);
    conn.sendAudio(b);

    expect(conn.framesReceived).toEqual([a, b]);
  });

  it("drops frames sent after the connection is aborted", async () => {
    const vendor = new MockVendor({ id: "v1", connections: [{}] });
    const conn = await vendor.connect(INFO, signal());

    conn.sendAudio(Buffer.from([1]));
    conn.abort();
    conn.sendAudio(Buffer.from([2]));

    expect(conn.framesReceived).toEqual([Buffer.from([1])]);
    expect(conn.isClosed).toBe(true);
  });

  it("emits scripted events in order, each after its fake-timer gap", async () => {
    const partial: SttVendorEvent = {
      type: "partial",
      text: "hel",
      speaker: null,
      ts_ms: 100,
    };
    const final: SttVendorEvent = {
      type: "final",
      text: "hello",
      speaker: "spk_0",
      ts_ms: 200,
      // note: extra fields not present; this is the vendor shape
    };
    const vendor = new MockVendor({
      id: "v1",
      connections: [
        {
          events: [
            { afterMs: 50, event: partial },
            { afterMs: 100, event: final },
          ],
          terminal: "close",
        },
      ],
    });
    const conn = await vendor.connect(INFO, signal());

    const collected = track(drain(conn.events));
    await vi.advanceTimersByTimeAsync(49);
    // nothing yet
    await vi.advanceTimersByTimeAsync(1 + 100);
    await vi.advanceTimersByTimeAsync(0);

    expect(collected.settled()).toBe(true);
    await expect(collected.value).resolves.toEqual([partial, final]);
  });

  it("models mid-stream death: an error event then the stream completes", async () => {
    const err: SttVendorEvent = {
      type: "error",
      error: new SttAuthError("socket died"),
    };
    const vendor = new MockVendor({
      id: "v1",
      connections: [
        { events: [{ afterMs: 10, event: err }], terminal: "close" },
      ],
    });
    const conn = await vendor.connect(INFO, signal());

    const collected = track(drain(conn.events));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);

    expect(collected.settled()).toBe(true);
    await expect(collected.value).resolves.toEqual([err]);
  });

  it("models silence: a hanging connection emits nothing until aborted", async () => {
    const vendor = new MockVendor({
      id: "v1",
      connections: [{ events: [], terminal: "hang" }],
    });
    const conn = await vendor.connect(INFO, signal());

    const iter = conn.events[Symbol.asyncIterator]();
    const first = track(iter.next());

    // Even far past any silence window, nothing is emitted.
    await vi.advanceTimersByTimeAsync(60000);
    expect(first.settled()).toBe(false);

    // Abort completes the iterable (done) so a consumer's loop can exit.
    conn.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.settled()).toBe(true);
    await expect(first.value).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("stops emitting further events once aborted mid-delay", async () => {
    const second: SttVendorEvent = {
      type: "final",
      text: "never",
      speaker: null,
      ts_ms: 0,
    };
    const vendor = new MockVendor({
      id: "v1",
      connections: [
        {
          events: [
            {
              afterMs: 10,
              event: { type: "partial", text: "a", speaker: null, ts_ms: 0 },
            },
            { afterMs: 1000, event: second },
          ],
          terminal: "close",
        },
      ],
    });
    const conn = await vendor.connect(INFO, signal());
    const collected = track(drain(conn.events));

    await vi.advanceTimersByTimeAsync(10); // first event emitted
    conn.abort(); // during the 1000ms gap before the second
    await vi.advanceTimersByTimeAsync(2000);

    const events = await collected.value;
    expect(events).toEqual([
      { type: "partial", text: "a", speaker: null, ts_ms: 0 },
    ]);
  });
});

describe("MockVendor multi-connection and multi-vendor independence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a distinct scripted connection per connect (reconnect scenarios)", async () => {
    const vendor = new MockVendor({
      id: "v1",
      connections: [
        { events: [], terminal: "close" },
        { events: [], terminal: "hang" },
      ],
    });

    const first = await vendor.connect(INFO, signal());
    const second = await vendor.connect(INFO, signal());

    expect(first).not.toBe(second);
    expect(vendor.connections).toEqual([first, second]);

    first.sendAudio(Buffer.from([1]));
    second.sendAudio(Buffer.from([2]));
    expect(first.framesReceived).toEqual([Buffer.from([1])]);
    expect(second.framesReceived).toEqual([Buffer.from([2])]);
  });

  it("keeps two vendors fully independent (failover scenarios)", async () => {
    const primary = new MockVendor({ id: "primary", connections: [{}] });
    const fallback = new MockVendor({ id: "fallback", connections: [{}] });

    const pc = await primary.connect(INFO, signal());
    const fc = await fallback.connect(INFO, signal());

    pc.sendAudio(Buffer.from([1]));
    expect(pc.framesReceived).toEqual([Buffer.from([1])]);
    expect(fc.framesReceived).toEqual([]);
    expect(primary.connectAttempts).toBe(1);
    expect(fallback.connectAttempts).toBe(1);
  });
});
