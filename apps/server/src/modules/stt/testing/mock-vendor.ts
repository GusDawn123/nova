import {
  SttProtocolError,
  type SttError,
  type SttSessionInfo,
  type SttVendor,
  type SttVendorConnection,
  type SttVendorEvent,
} from "../ports.js";

/**
 * Scriptable in-memory STT vendor for the behavior suite. Zero network, zero real
 * time — everything is driven by vitest fake timers, so tests advance the clock
 * instead of waiting. It can express, PER connection attempt:
 *   - a connect delay and/or a typed connect failure,
 *   - a sequence of emitted events, each after a fake-timer gap,
 *   - mid-stream death (an `error`/`closed` event followed by `terminal: "close"`),
 *   - silence (`terminal: "hang"` — the connection stays open, emitting nothing),
 * and it RECORDS every frame each connection received. A single vendor holds a
 * list of scripts (one consumed per `connect`, for reconnect scenarios); two
 * distinct `MockVendor`s cover failover scenarios.
 *
 * TEST-ONLY. Never imported by production code.
 */

/** One scripted event and the fake-timer gap (ms) before it, measured from the previous step. */
export interface ScriptedEvent {
  readonly afterMs: number;
  readonly event: SttVendorEvent;
}

/** What happens once a connection has emitted all its scripted events. */
export type TerminalBehavior =
  /** Complete the `events` iterable (clean end / socket death). */
  | "close"
  /** Stay open, emitting nothing, until aborted/ended (models silence). */
  | "hang";

/** Script for a SINGLE connection attempt against a vendor. */
export interface MockConnectionScript {
  /** Fake-timer delay before `connect` settles. Omitted/0 → settles synchronously. */
  readonly connectDelayMs?: number;
  /** If set, `connect` REJECTS with this typed error (after `connectDelayMs`). */
  readonly connectError?: SttError;
  /** Events emitted after a successful connect, in order, each after its `afterMs` gap. */
  readonly events?: readonly ScriptedEvent[];
  /** Post-events behavior. Default `"hang"` (open + silent). */
  readonly terminal?: TerminalBehavior;
}

export interface MockVendorOptions {
  readonly id: string;
  /** One script per connect attempt (index 0 = first connect, 1 = first reconnect, …). */
  readonly connections: readonly MockConnectionScript[];
}

/** Resolve after `ms` on the (fake) clock. `ms <= 0` resolves on the microtask queue. */
function timerDelay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One scripted connection. Records frames, plays scripted events on the fake
 * clock, and completes its `events` iterable on death/abort/end.
 */
export class MockVendorConnection implements SttVendorConnection {
  /** Every frame handed to {@link sendAudio}, in order — the relay assertion target. */
  readonly framesReceived: Buffer[] = [];

  private closed = false;
  private readonly closeWaiters: (() => void)[] = [];
  private streamCache: AsyncIterable<SttVendorEvent> | undefined;

  constructor(private readonly script: MockConnectionScript) {}

  sendAudio(frame: Buffer): void {
    if (this.closed) return;
    this.framesReceived.push(frame);
  }

  async end(): Promise<void> {
    this.signalClose();
    await Promise.resolve();
  }

  abort(): void {
    this.signalClose();
  }

  /** True once the connection has been ended/aborted. */
  get isClosed(): boolean {
    return this.closed;
  }

  get events(): AsyncIterable<SttVendorEvent> {
    this.streamCache ??= this.iterate();
    return this.streamCache;
  }

  private signalClose(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.closeWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Resolve when the connection closes; used to interrupt scripted delays/hangs. */
  private waitClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  /** Race a scripted delay against close; resolves `true` if closed first. */
  private async delayOrClose(ms: number): Promise<boolean> {
    const closedFirst = Symbol("closed");
    const result = await Promise.race([
      timerDelay(ms).then(() => null),
      this.waitClose().then(() => closedFirst),
    ]);
    return result === closedFirst;
  }

  private async *iterate(): AsyncGenerator<SttVendorEvent> {
    for (const scripted of this.script.events ?? []) {
      const interrupted = await this.delayOrClose(scripted.afterMs);
      if (interrupted || this.closed) return;
      yield scripted.event;
    }
    if ((this.script.terminal ?? "hang") === "close") return;
    // hang: model an open, silent socket — complete only when closed/aborted.
    await this.waitClose();
  }
}

/** A scriptable STT vendor. Hands out one {@link MockVendorConnection} per `connect`. */
export class MockVendor implements SttVendor {
  readonly id: string;
  /** Every connection this vendor created, in order — inspect for per-connection frames. */
  readonly connections: MockVendorConnection[] = [];
  /** Every `connect` opts, in order — inspect to prove session isolation. */
  readonly connectCalls: SttSessionInfo[] = [];

  private readonly scripts: readonly MockConnectionScript[];
  private cursor = 0;

  constructor(options: MockVendorOptions) {
    this.id = options.id;
    this.scripts = options.connections;
  }

  /** How many times `connect` has been called (connect + reconnect attempts). */
  get connectAttempts(): number {
    return this.cursor;
  }

  async connect(
    opts: SttSessionInfo,
    signal: AbortSignal,
  ): Promise<SttVendorConnection> {
    const script = this.scripts[this.cursor];
    this.cursor += 1;
    this.connectCalls.push(opts);

    if (!script) {
      throw new SttProtocolError(
        `mock vendor "${this.id}": no script for connect attempt ${String(this.cursor)}`,
      );
    }

    if (signal.aborted) {
      throw abortError(signal);
    }

    const delayMs = script.connectDelayMs ?? 0;
    if (delayMs > 0) {
      const aborted = await raceAbort(timerDelay(delayMs), signal);
      if (aborted) throw abortError(signal);
    }

    if (script.connectError) {
      throw script.connectError;
    }

    const connection = new MockVendorConnection(script);
    this.connections.push(connection);
    return connection;
  }
}

/** Resolve when `promise` settles OR `signal` aborts; `true` if the signal won. */
function raceAbort(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
  const abortedFirst = Symbol("aborted");
  return new Promise<typeof abortedFirst | null>((resolve) => {
    const onAbort = (): void => {
      resolve(abortedFirst);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    });
  }).then((winner) => winner === abortedFirst);
}

/** The typed error a connect throws when aborted, preserving the abort reason. */
function abortError(signal: AbortSignal): SttError {
  const reason: unknown = signal.reason;
  const message =
    reason instanceof Error ? reason.message : "connect aborted before ready";
  return new SttProtocolError(message);
}
