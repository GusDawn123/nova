import { randomUUID } from "node:crypto";

import {
  LIVE_PROTOCOL_VERSION,
  parseClientEvent,
  type ClientLiveEvent,
  type LiveErrorCode,
  type ServerLiveEvent,
} from "@nova/shared";

import type {
  SttEngine,
  SttSessionHandle,
} from "../stt/ports.js";

import {
  createDisposer,
  noopAudioFrameHandler,
  type AudioFrameHandler,
  type Disposer,
} from "./ports.js";

/** PCM sample rate of the mic feed handed to the STT vendor (design doc: 16 kHz). */
const STT_SAMPLE_RATE_HZ = 16000;

/**
 * One live session per socket (per-user concurrency caps are Phase 6 — not
 * here). Transport-agnostic on purpose: it takes a `send` callback and is fed
 * decoded text / binary messages, so the whole lifecycle is unit-testable
 * without a real WebSocket. `routes.ts` is the only thing that knows about `ws`.
 */

export interface LiveSessionDeps {
  /** Emit a typed event down the socket (serialization lives in the transport). */
  send: (event: ServerLiveEvent) => void;
  /** Binary-audio seam; defaults to a no-op (Task 4 wires the STT relay). */
  onAudioFrame?: AudioFrameHandler;
  /** Session id factory; overridable for deterministic tests. */
  generateSessionId?: () => string;
  /**
   * Whether the TEST-ONLY `echo` mode may be honored. The transport passes
   * `NODE_ENV !== "production"` so echo can never be triggered in production
   * even if a client sends `echo: true`.
   */
  allowEcho?: boolean;
  /**
   * The STT engine over the configured vendor lineup. On `session.start` a
   * per-call engine session is started; audio frames relay into it and its
   * transcript / `provider_switched` / `error` events go straight down the
   * socket via {@link send}. Omitted in pure protocol unit tests; the transport
   * always supplies one (built from the env vendor registry).
   */
  sttEngine?: SttEngine;
}

export class LiveSession {
  /** Run-exactly-once teardown latch; vendor resources register here (Task 4+). */
  readonly disposer: Disposer = createDisposer();

  private readonly send: (event: ServerLiveEvent) => void;
  private readonly onAudioFrame: AudioFrameHandler;
  private readonly generateSessionId: () => string;
  private readonly allowEcho: boolean;
  private readonly sttEngine: SttEngine | null;

  private started = false;
  private sessionId: string | null = null;
  private echo = false;
  /** The live STT relay handle for this call; null until start (or in echo mode). */
  private stt: SttSessionHandle | null = null;

  constructor(deps: LiveSessionDeps) {
    this.send = deps.send;
    this.onAudioFrame = deps.onAudioFrame ?? noopAudioFrameHandler;
    this.generateSessionId = deps.generateSessionId ?? randomUUID;
    this.allowEcho = deps.allowEcho ?? false;
    this.sttEngine = deps.sttEngine ?? null;
  }

  /** The generated session id once `session.start` has been accepted. */
  get id(): string | null {
    return this.sessionId;
  }

  /**
   * Handle one inbound TEXT frame (a JSON control event). A malformed frame is
   * answered with an `error` event and DROPPED — a single bad frame never tears
   * down the session (that is what WS close codes are for).
   */
  handleTextMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.sendError("invalid_json", "message was not valid JSON");
      return;
    }

    const parsed = parseClientEvent(json);
    if (!parsed.success) {
      this.sendError("invalid_event", "unrecognized or malformed live event");
      return;
    }
    this.dispatch(parsed.data);
  }

  /**
   * Handle one inbound BINARY frame — the audio path. Before `session.start` it
   * is an error (and dropped); after, it goes to the audio seam, and in echo
   * mode its byte length is reported back for transit tests.
   */
  handleBinaryMessage(frame: Buffer): void {
    if (!this.started) {
      this.sendError("audio_before_start", "audio frame before session.start");
      return;
    }
    this.onAudioFrame(this, frame);
    // Hot relay into the STT engine (synchronous, throwing-free by contract).
    this.stt?.onAudioFrame(frame);
    if (this.echo) {
      this.send({
        v: LIVE_PROTOCOL_VERSION,
        type: "audio.echo",
        bytes: frame.byteLength,
      });
    }
  }

  /** Idempotent teardown — the single entry point the transport calls on end. */
  close(): void {
    this.disposer.dispose();
  }

  private dispatch(event: ClientLiveEvent): void {
    switch (event.type) {
      case "session.start":
        this.onSessionStart(event.meeting_id, event.echo ?? false);
        return;
      case "session.end":
        this.close();
        return;
      case "ping":
        this.send({ v: LIVE_PROTOCOL_VERSION, type: "pong" });
        return;
      case "audio.frame":
        // The JSON marker is documentation-only; real audio is binary.
        this.sendError("invalid_event", "audio must be sent as binary frames");
        return;
    }
  }

  private onSessionStart(_meetingId: string, echo: boolean): void {
    if (this.started) {
      // One live session per socket; a second start is a client protocol bug.
      this.sendError("already_started", "session already started");
      return;
    }
    this.started = true;
    this.echo = this.allowEcho && echo;
    this.sessionId = this.generateSessionId();
    this.send({
      v: LIVE_PROTOCOL_VERSION,
      type: "session.ready",
      session_id: this.sessionId,
    });

    // Start the STT relay for this call. Echo mode is the pre-vendor transit
    // diagnostic, so it deliberately bypasses the engine; otherwise a per-call
    // engine session streams transcript/provider_switched/error events straight
    // to the socket, and its teardown rides the exactly-once disposer (a dropped
    // phone must abort the vendor socket — the money-leak rule, design doc).
    if (this.sttEngine !== null && !this.echo) {
      const stt = this.sttEngine.startSession(
        { sessionId: this.sessionId, sampleRateHz: STT_SAMPLE_RATE_HZ },
        this.send,
      );
      this.stt = stt;
      this.disposer.add(() => {
        stt.stop();
      });
    }
  }

  private sendError(code: LiveErrorCode, message: string): void {
    this.send({ v: LIVE_PROTOCOL_VERSION, type: "error", code, message });
  }
}
