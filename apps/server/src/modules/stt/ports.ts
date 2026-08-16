import type { ServerLiveEvent } from "@nova/shared";

import type { SttConfig } from "./config.js";

/**
 * modules/stt contracts (Phase 3). This file defines the SEAMS only — the vendor
 * adapter port, the per-session vendor connection, the typed error taxonomy, and
 * the engine's public port. Task 4 implements the engine against these; Task 5
 * builds real AssemblyAI / Deepgram adapters behind `adapters/` (RULES §5). No
 * vendor SDKs and no network live in this module yet.
 *
 * Design source: `docs/DESIGN/live-pipeline.md` §modules/stt — relay audio to a
 * pre-warmed vendor socket, emit zod-validated transcript events, failover via
 * active abort + `provider_switched`, reconnect invisibly, never touch disk.
 */

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * How the engine reacts to a vendor failure. Independent of any other module's
 * taxonomy on purpose (the llm module is not on this branch — do not import it):
 * - `transient` — a blip; retry the SAME vendor on the backoff ladder.
 * - `auth` — bad/expired credentials; retrying the same vendor is pointless, so
 *   the engine benches it and fails over immediately.
 * - `protocol` — the vendor spoke nonsense (unparseable frame, contract break);
 *   treated like `transient` for retry but surfaced distinctly for diagnostics.
 */
export type SttErrorKind = "transient" | "auth" | "protocol";

/** Base for every typed STT failure. `kind` drives the engine's retry policy. */
export abstract class SttError extends Error {
  abstract readonly kind: SttErrorKind;
}

/** A recoverable blip (dropped socket, timeout). Retry the same vendor. */
export class SttTransientError extends SttError {
  readonly kind = "transient" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SttTransientError";
  }
}

/** Credentials rejected. Do not retry the same vendor — bench it, fail over. */
export class SttAuthError extends SttError {
  readonly kind = "auth" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SttAuthError";
  }
}

/** The vendor broke the streaming contract (bad frame, unexpected shape). */
export class SttProtocolError extends SttError {
  readonly kind = "protocol" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SttProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Vendor connection port
// ---------------------------------------------------------------------------

/**
 * One event off a vendor's streaming socket. Discriminated union on `type`:
 * - `partial` / `final` — a transcript hypothesis (`final` is committed). Carries
 *   raw vendor fields; the engine maps these to `ServerLiveEvent`s.
 * - `error` — a typed vendor failure mid-stream (engine decides retry vs failover).
 * - `closed` — the socket ended cleanly. The `events` iterable ALSO completes when
 *   a connection dies; this in-band variant exists for vendors that report a clean
 *   close before the stream ends.
 */
export type SttVendorEvent =
  | {
      readonly type: "partial" | "final";
      readonly text: string;
      readonly speaker: string | null;
      readonly ts_ms: number;
    }
  | { readonly type: "error"; readonly error: SttError }
  | { readonly type: "closed" };

/**
 * A per-session streaming session with one vendor. The engine `sendAudio`s frames
 * up and consumes `events` down; `end` drains gracefully, `abort` tears down NOW
 * (the failover path uses active abort — design doc). Consuming code iterates
 * `events` exactly once; the iterable completes (done) when the connection dies
 * or is aborted, so a `for await` loop always terminates.
 */
export interface SttVendorConnection {
  /** Relay one raw audio frame to the vendor. Synchronous, never throws. */
  sendAudio(frame: Buffer): void;
  /** Graceful close: stop sending, let the vendor flush finals, then complete. */
  end(): Promise<void>;
  /** Immediate teardown (failover / stop). Completes `events` without flushing. */
  abort(): void;
  /** The down-stream of vendor events; iterate once. */
  readonly events: AsyncIterable<SttVendorEvent>;
}

/** What a vendor needs to open a session. Also the audio format contract. */
export interface SttSessionInfo {
  /** Server session id (survives resume); ties frames + transcripts to a call. */
  readonly sessionId: string;
  /** PCM sample rate of the mic feed (design doc: 16 kHz). */
  readonly sampleRateHz: number;
  /**
   * PCM channels in the binary frames. Omitted = 1 (the phone's mono feed).
   * 2 = the desktop's interleaved stereo where channel 0 is "me" and channel 1
   * is "them" — the channels carry the speaker labels, so a 2-channel session
   * runs without diarization. Only vendors whose {@link SttVendor.maxChannels}
   * covers this count are eligible (the engine filters its lineup).
   */
  readonly channels?: 1 | 2;
}

/**
 * A vendor adapter (the port Task 5's AssemblyAI/Deepgram implementations satisfy).
 * `connect` is where pre-warming happens: it resolves a live, ready streaming
 * connection. `signal` lets the engine abort a slow connect (connect-timeout /
 * failover / stop). A rejected `connect` throws an {@link SttError}.
 */
export interface SttVendor {
  readonly id: string;
  /**
   * The most PCM channels this vendor can transcribe with per-channel
   * attribution. Omitted = 1. The engine excludes a vendor from any session
   * asking for more than it supports — feeding interleaved stereo to a
   * mono-only vendor would transcribe garbled half-speed audio, which is
   * strictly worse than failing over.
   */
  readonly maxChannels?: number;
  connect(
    opts: SttSessionInfo,
    signal: AbortSignal,
  ): Promise<SttVendorConnection>;
}

// ---------------------------------------------------------------------------
// Engine port
// ---------------------------------------------------------------------------

/** Emit a zod-valid `ServerLiveEvent` down the client socket. */
export type SttEmit = (event: ServerLiveEvent) => void;

/**
 * The live, per-session handle the transport drives. `onAudioFrame` is the hot
 * relay seam (synchronous, throwing-free — plugs into Task 2's seam in Task 4);
 * `stop` tears the session down and is idempotent (no emits after stop).
 */
export interface SttSessionHandle {
  onAudioFrame(frame: Buffer): void;
  stop(): void;
}

/** The engine: a factory of per-session handles over a fixed vendor lineup. */
export interface SttEngine {
  /**
   * Start relaying one call. `emit` receives every transcript / provider_switched
   * / error event for THIS session and no other (strict isolation). Returns the
   * handle the transport feeds frames into.
   */
  startSession(info: SttSessionInfo, emit: SttEmit): SttSessionHandle;
}

/**
 * Build an STT engine over a priority-ordered vendor lineup: `vendors[0]` is
 * primary, `vendors[1]` the fallback, and so on. `config` tunes connect timeouts,
 * the reconnect backoff ladder, failover threshold, and the reconnect buffer.
 */
export type CreateSttEngine = (
  config: SttConfig,
  vendors: readonly SttVendor[],
) => SttEngine;
