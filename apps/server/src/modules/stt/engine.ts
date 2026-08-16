import { LIVE_PROTOCOL_VERSION, type ServerLiveEvent } from "@nova/shared";

import type { SttConfig } from "./config.js";
import {
  SttError,
  SttTransientError,
  type CreateSttEngine,
  type SttEmit,
  type SttEngine,
  type SttSessionHandle,
  type SttSessionInfo,
  type SttVendor,
  type SttVendorConnection,
} from "./ports.js";

/**
 * STT engine (Phase 3.4). Relays audio to a priority-ordered vendor lineup,
 * emits zod-valid `ServerLiveEvent`s, and hides vendor churn from the client:
 * a dropped/silent socket reconnects the SAME vendor invisibly; a vendor that
 * won't stay up fails over to the next with a single `provider_switched`; only
 * when EVERY vendor is exhausted does the client see one typed `error`.
 *
 * Establishment boundary (the load-bearing distinction — see `config.ts`):
 *   - Before a vendor's connect ever succeeds, consecutive connect failures count
 *     toward {@link SttConfig.failoverThreshold}; hit it → fail over.
 *   - After a vendor has connected at least once ("established"), every subsequent
 *     reconnect attempt (whether it dies mid-stream, goes silent, or the reconnect
 *     itself fails to connect) counts toward {@link SttConfig.maxReconnects}; exceed
 *     it → fail over.
 *
 * Style precedent: sequential attempt loop with a per-attempt AbortController and
 * active abort on teardown/failover (adr-0004; the llm router's shape). Timers are
 * plain setTimeout/clearTimeout so fake-timer tests drive the ladders. No disk, no
 * network, no vendor SDKs live here (RULES §3/§5).
 */

/** Why a `consume` loop over a live connection ended. */
type ConsumeReason = "died" | "auth" | "stopped";

class SttSession implements SttSessionHandle {
  private stopped = false;

  /** The connection currently receiving audio; null during connect/backoff. */
  private activeConnection: SttVendorConnection | null = null;
  /** AbortController for an in-flight connect, so `stop` can cancel it. */
  private activeConnectController: AbortController | null = null;

  /** Bounded drop-oldest ring of frames held while reconnecting. */
  private buffer: Buffer[] = [];

  /** Every live timer id, so teardown clears them (no open handles). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Resolvers that unblock any pending `delay` on teardown. */
  private readonly wakers: Array<() => void> = [];
  /** The armed silence timer, if any. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: SttConfig,
    private readonly vendors: readonly SttVendor[],
    private readonly info: SttSessionInfo,
    private readonly emit: SttEmit,
  ) {
    // Pre-warm: kick the control loop off at session start (design doc). It never
    // rejects, but a defensive catch keeps a stray failure from going unhandled.
    void this.run().catch(() => {
      /* control-loop failures surface as emitted `error` events, not throws */
    });
  }

  // -- Hot relay seam (synchronous, throwing-free) ---------------------------

  onAudioFrame(frame: Buffer): void {
    if (this.stopped) return;
    if (this.activeConnection) {
      this.activeConnection.sendAudio(frame);
      this.armSilence();
    } else {
      this.pushBuffer(frame);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.silenceTimer = null;
    for (const wake of this.wakers.splice(0)) wake();
    this.activeConnectController?.abort(new Error("stt session stopped"));
    this.activeConnectController = null;
    const conn = this.activeConnection;
    this.activeConnection = null;
    conn?.abort();
    this.buffer = [];
  }

  // -- Control loop ----------------------------------------------------------

  private async run(): Promise<void> {
    let pendingFrom: string | null = null;

    for (
      let vendorIndex = 0;
      vendorIndex < this.vendors.length;
      vendorIndex++
    ) {
      const vendor = this.vendors[vendorIndex];
      if (this.stopped || vendor === undefined) return;

      let preFailures = 0;
      let reconnects = 0;
      let everEstablished = false;

      // Inner loop: connect → consume → reconnect for THIS vendor, until we
      // either stop, or decide to fail over (break).
      vendorLoop: for (;;) {
        if (this.isStopped()) return;

        let conn: SttVendorConnection;
        try {
          conn = await this.connect(vendor);
        } catch (err) {
          if (this.isStopped()) return;
          if (kindOf(err) === "auth") break vendorLoop; // bench → fail over now
          if (!everEstablished) {
            preFailures += 1;
            if (preFailures >= this.config.failoverThreshold) break vendorLoop;
            await this.delay(this.backoff(preFailures));
            continue vendorLoop;
          }
          reconnects += 1;
          if (reconnects > this.config.maxReconnects) break vendorLoop;
          await this.delay(this.backoff(reconnects));
          continue vendorLoop;
        }
        if (this.isStopped()) {
          conn.abort();
          return;
        }

        everEstablished = true;
        if (pendingFrom !== null) {
          this.emitEvent({
            v: LIVE_PROTOCOL_VERSION,
            type: "provider_switched",
            from: pendingFrom,
            to: vendor.id,
          });
          pendingFrom = null;
        }
        this.activate(conn);

        const reason = await this.consume(conn);
        this.deactivate();
        if (reason === "stopped") return;
        if (reason === "auth") break vendorLoop; // bench → fail over

        reconnects += 1;
        if (reconnects > this.config.maxReconnects) break vendorLoop;
        await this.delay(this.backoff(reconnects));
      }

      // Fell out of the vendor loop → fail over to the next vendor. The switch
      // only becomes visible once that vendor actually establishes.
      pendingFrom = vendor.id;
    }

    // Every vendor exhausted: one typed error, then tear down (never hang).
    if (this.isStopped()) return;
    this.emitEvent({
      v: LIVE_PROTOCOL_VERSION,
      type: "error",
      code: "internal",
      message: "all STT vendors exhausted",
    });
    this.stop();
  }

  /** Consume a live connection's events until it dies, errors, or we stop. */
  private async consume(conn: SttVendorConnection): Promise<ConsumeReason> {
    let sawAuthError = false;
    for await (const ev of conn.events) {
      if (this.stopped) return "stopped";
      switch (ev.type) {
        case "partial":
          this.clearSilence();
          this.emitEvent({
            v: LIVE_PROTOCOL_VERSION,
            type: "transcript.partial",
            text: ev.text,
            speaker: ev.speaker,
            ts_ms: ev.ts_ms,
          });
          break;
        case "final":
          this.clearSilence();
          this.emitEvent({
            v: LIVE_PROTOCOL_VERSION,
            type: "transcript.final",
            text: ev.text,
            speaker: ev.speaker,
            ts_ms: ev.ts_ms,
            is_final: true,
          });
          break;
        case "error":
          this.clearSilence();
          // Auth is pointless to retry on the same vendor — bench + fail over.
          if (ev.error.kind === "auth") sawAuthError = true;
          break;
        case "closed":
          this.clearSilence();
          break;
      }
    }
    if (this.stopped) return "stopped";
    return sawAuthError ? "auth" : "died";
  }

  /** Connect with a bounded timeout and an abortable per-attempt controller. */
  private async connect(vendor: SttVendor): Promise<SttVendorConnection> {
    const controller = new AbortController();
    this.activeConnectController = controller;

    const connectPromise = vendor.connect(this.info, controller.signal);
    // If the timeout wins the race, connect() rejects later (via the abort) —
    // attach a no-op catch so that loss never becomes an unhandled rejection.
    connectPromise.catch(() => {
      /* handled by the race below (or swallowed if it lost to the timeout) */
    });

    const timeout = this.connectTimeout(controller);
    try {
      return timeout === null
        ? await connectPromise
        : await Promise.race([connectPromise, timeout.guard]);
    } finally {
      timeout?.cancel();
      this.activeConnectController = null;
    }
  }

  /**
   * A connect-timeout guard: a promise that rejects (and aborts the connect)
   * once {@link SttConfig.connectTimeoutMs} elapses, plus a `cancel` to disarm
   * it. Returns null when timeouts are disabled. Kept separate so the timer id
   * lives in this closure, not a re-narrowed outer `let`.
   */
  private connectTimeout(
    controller: AbortController,
  ): { guard: Promise<never>; cancel: () => void } | null {
    if (this.config.connectTimeoutMs <= 0) return null;
    let id!: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_resolve, reject) => {
      id = setTimeout(() => {
        this.timers.delete(id);
        controller.abort(new Error("connect timeout"));
        reject(new SttTransientError("connect timeout"));
      }, this.config.connectTimeoutMs);
      this.timers.add(id);
    });
    return {
      guard,
      cancel: () => {
        clearTimeout(id);
        this.timers.delete(id);
      },
    };
  }

  // -- Connection activation + reconnect buffer ------------------------------

  private activate(conn: SttVendorConnection): void {
    for (const frame of this.buffer) conn.sendAudio(frame);
    this.buffer = [];
    this.activeConnection = conn;
  }

  private deactivate(): void {
    this.activeConnection = null;
    this.clearSilence();
  }

  private pushBuffer(frame: Buffer): void {
    const max = this.config.reconnectBufferFrames;
    if (max <= 0) return;
    this.buffer.push(frame);
    while (this.buffer.length > max) this.buffer.shift(); // drop oldest
  }

  // -- Silence detection -----------------------------------------------------

  private armSilence(): void {
    if (this.stopped || this.silenceTimer !== null) return;
    if (this.config.vendorSilenceTimeoutMs <= 0) return;
    const id = setTimeout(() => {
      this.timers.delete(id);
      this.silenceTimer = null;
      // A silent-but-open socket is worse than a dropped one: abort it so the
      // consume loop completes and takes the reconnect path.
      this.activeConnection?.abort();
    }, this.config.vendorSilenceTimeoutMs);
    this.silenceTimer = id;
    this.timers.add(id);
  }

  private clearSilence(): void {
    if (this.silenceTimer === null) return;
    clearTimeout(this.silenceTimer);
    this.timers.delete(this.silenceTimer);
    this.silenceTimer = null;
  }

  // -- Timing + emit helpers -------------------------------------------------

  /** Backoff for a 1-based attempt number; the last ladder rung repeats. */
  private backoff(attempt: number): number {
    const ladder = this.config.reconnectBackoffMs;
    if (ladder.length === 0) return 0;
    return ladder[Math.min(attempt - 1, ladder.length - 1)] ?? 0;
  }

  /** Fake-timer-friendly delay; resolves immediately for <=0 or after stop. */
  private delay(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.timers.delete(id);
        resolve();
      }, ms);
      this.timers.add(id);
      this.wakers.push(() => {
        clearTimeout(id);
        this.timers.delete(id);
        resolve();
      });
    });
  }

  private emitEvent(event: ServerLiveEvent): void {
    if (this.stopped) return;
    this.emit(event);
  }

  /**
   * Read the stop flag through a call. `stop()` can flip `this.stopped` while the
   * control loop is suspended at an `await`; a bare field read would be
   * stale-narrowed by control-flow analysis across that await, so the reentrant
   * checkpoints go through this method (call results are never narrowed).
   */
  private isStopped(): boolean {
    return this.stopped;
  }
}

/** Narrow an unknown thrown value to a retry kind; default to transient. */
function kindOf(err: unknown): "transient" | "auth" | "protocol" {
  return err instanceof SttError ? err.kind : "transient";
}

export const createSttEngine: CreateSttEngine = (
  config: SttConfig,
  vendors: readonly SttVendor[],
): SttEngine => ({
  startSession(info: SttSessionInfo, emit: SttEmit): SttSessionHandle {
    // Only vendors that can attribute every channel the session sends. An
    // empty result reuses the exhaustion path (one typed error) — never a
    // mono-only vendor silently transcribing garbled interleaved stereo.
    const capable = vendors.filter(
      (vendor) => (vendor.maxChannels ?? 1) >= (info.channels ?? 1),
    );
    return new SttSession(config, capable, info, emit);
  },
});
