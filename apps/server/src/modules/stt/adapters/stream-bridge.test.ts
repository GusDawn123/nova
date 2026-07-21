import { afterEach, describe, expect, it, vi } from "vitest";

import type { SttVendorEvent } from "../ports.js";
import {
  AsyncEventQueue,
  VendorStreamConnection,
  raceTimeout,
} from "./stream-bridge.js";

/** Drain an async iterable to an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("AsyncEventQueue", () => {
  it("delivers items pushed before iteration starts, then completes on close", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await collect(queue)).toEqual([1, 2]);
  });

  it("delivers items pushed while a consumer is awaiting", async () => {
    const queue = new AsyncEventQueue<number>();
    const collected = collect(queue);
    // Let the consumer register its waiter, then push + close.
    await Promise.resolve();
    queue.push(10);
    queue.push(20);
    queue.close();
    expect(await collected).toEqual([10, 20]);
  });

  it("drains items buffered before close even if close races them", async () => {
    const queue = new AsyncEventQueue<string>();
    queue.push("final-a");
    queue.push("final-b");
    queue.close();
    queue.push("after-close-ignored");
    expect(await collect(queue)).toEqual(["final-a", "final-b"]);
  });

  it("completes immediately when closed empty", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.close();
    expect(await collect(queue)).toEqual([]);
  });
});

describe("VendorStreamConnection", () => {
  it("exposes the queue as its events and relays audio through the hook", () => {
    const queue = new AsyncEventQueue<SttVendorEvent>();
    const frames: Buffer[] = [];
    const conn = new VendorStreamConnection(queue, {
      sendAudio: (frame) => {
        frames.push(frame);
      },
      end: () => Promise.resolve(),
      abort: () => undefined,
    });

    const frame = Buffer.from([1, 2, 3]);
    conn.sendAudio(frame);
    expect(frames).toEqual([frame]);
    expect(conn.events).toBe(queue);
  });

  it("never throws from sendAudio even if the hook throws (hot-relay contract)", () => {
    const queue = new AsyncEventQueue<SttVendorEvent>();
    const conn = new VendorStreamConnection(queue, {
      sendAudio: () => {
        throw new Error("socket dead");
      },
      end: () => Promise.resolve(),
      abort: () => undefined,
    });
    expect(() => {
      conn.sendAudio(Buffer.from([0]));
    }).not.toThrow();
  });

  it("forwards end/abort to the hooks", async () => {
    const queue = new AsyncEventQueue<SttVendorEvent>();
    const calls: string[] = [];
    const conn = new VendorStreamConnection(queue, {
      sendAudio: () => undefined,
      end: () => {
        calls.push("end");
        return Promise.resolve();
      },
      abort: () => calls.push("abort"),
    });
    await conn.end();
    conn.abort();
    expect(calls).toEqual(["end", "abort"]);
  });
});

describe("raceTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves false when the promise settles before the timeout", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const race = raceTimeout(pending, 2000);
    settle();
    await expect(race).resolves.toBe(false);
  });

  it("resolves true when the timeout fires first (the graceful-close bound)", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {
      /* a vendor that never acknowledges CloseStream */
    });
    const race = raceTimeout(never, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(race).resolves.toBe(true);
  });

  it("does not fire the timeout later once the promise has won", async () => {
    vi.useFakeTimers();
    const result = await raceTimeout(Promise.resolve(), 2000);
    expect(result).toBe(false);
    // The timer was cleared: advancing the clock finds no pending timers.
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
