import type { SttVendorConnection, SttVendorEvent } from "../ports.js";

/**
 * Callback → pull bridge for the vendor adapters (Phase 3.5). Both SDKs surface
 * their streaming socket as an event emitter (`on("turn"|"message"|"error"|
 * "close", …)`); the engine, however, consumes a single-pass
 * `AsyncIterable<SttVendorEvent>`. This file owns that translation seam and holds
 * NO vendor SDK imports — it is pure plumbing, so it stays testable without a
 * network and safe to import from anywhere.
 */

/**
 * A single-consumer push queue exposed as an `AsyncIterable`. Producers call
 * {@link push} from event callbacks; the sole consumer `for await`s it. The
 * iterable completes (its `for await` returns) exactly once {@link close} is
 * called AND every already-queued item has been drained — so finals pushed just
 * before a socket close are never dropped. `push` after `close` is ignored.
 *
 * Single-consumer by contract (the engine iterates each connection once); a
 * second iterator would race the first for items. No backpressure: STT event
 * rates are tiny (a few messages/sec), so an unbounded in-memory queue is not a
 * leak the way buffering raw audio would be.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  /** Enqueue an item (or hand it straight to a waiting consumer). No-op after close. */
  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Complete the stream once buffered items drain. Idempotent. */
  close(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        const [next] = this.items.splice(0, 1);
        // `length > 0` guarantees a value; the guard satisfies noUncheckedIndexedAccess.
        if (next !== undefined) yield next;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

/** The vendor-specific teardown/relay hooks a {@link VendorStreamConnection} drives. */
export interface VendorStreamHooks {
  /** Relay one raw PCM frame to the vendor socket. May throw; the wrapper swallows. */
  sendAudio(frame: Buffer): void;
  /** Graceful close: tell the vendor no more audio, let it flush finals, resolve. */
  end(): Promise<void>;
  /** Immediate teardown: drop the socket now, do not wait for finals. */
  abort(): void;
}

/**
 * The {@link SttVendorConnection} both adapters return: a thin wrapper pairing an
 * {@link AsyncEventQueue} of translated events with the vendor's relay/teardown
 * hooks. `sendAudio` is guaranteed throwing-free (the port's contract — the hot
 * relay seam must never throw); a failed send surfaces instead as the socket's
 * own `error`/`close`, which the hooks route into the queue.
 */
export class VendorStreamConnection implements SttVendorConnection {
  constructor(
    private readonly queue: AsyncEventQueue<SttVendorEvent>,
    private readonly hooks: VendorStreamHooks,
  ) {}

  sendAudio(frame: Buffer): void {
    try {
      this.hooks.sendAudio(frame);
    } catch {
      // Contract: never throw from the hot relay. A dead socket surfaces via the
      // vendor's error/close event, which the adapter has already wired to the queue.
    }
  }

  end(): Promise<void> {
    return this.hooks.end();
  }

  abort(): void {
    this.hooks.abort();
  }

  get events(): AsyncIterable<SttVendorEvent> {
    return this.queue;
  }
}
